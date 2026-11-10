// Pathline Z: the head Z axis for Pathline Run (run/src/zaxis/PROTOCOL.md).
// ESP32 + TMC2209 (UART) + NEMA 11 lead screw moving the whole nozzle, an optical end stop at
// the top, and a PONO 18GM40-150 ultrasonic sensor read as 4–20 mA across 165 Ω into an ADS1115.
//
// NOT YET RUN ON HARDWARE. Bench-test with the motor free of the nozzle first: HOME, GO, UP, the
// watchdog (stop sending while a trajectory runs), and that POS_MAX can't be passed.
//
// Libraries (Arduino Library Manager): FastAccelStepper, TMCStepper, Adafruit ADS1X15.
// Board: any ESP32 (DevKitC pins below); USB serial 115200.

#include <Arduino.h>
#include <Wire.h>
#include <FastAccelStepper.h>
#include <TMCStepper.h>
#include <Adafruit_ADS1X15.h>

// ---------------------------------------------------------------- the build: set these
#define FW "pz-0.1"
const int PIN_STEP = 26, PIN_DIR = 27, PIN_EN = 25;      // TMC2209 STEP/DIR/EN
const int PIN_TMC_RX = 16, PIN_TMC_TX = 17;              // TMC2209 PDN_UART (1 k between TX and the pin)
const int PIN_ENDSTOP = 34;                              // optical end stop at the TOP, LOW = blocked
const bool DIR_DOWN_HIGH = true;                         // DIR level that moves the nozzle DOWN
const float LEAD_MM = 2.0;                               // lead screw lead, mm per turn
const int MICROSTEPS = 16;
const float STEPS_PER_MM = 200.0 * MICROSTEPS / LEAD_MM; // 1600
const float TRAVEL_MM = 10.0;                            // the axis's whole travel
const float POS_MAX = 8.0;                               // never deeper than this (mm down from the top), whatever Run says
const int MOTOR_MA = 400;                                // NEMA 11: check its rating; 60–70 % of it
// the sensor: 4 mA at NEAR_MM, 20 mA at FAR_MM (as taught on the PONO), 165 Ω shunt
const float NEAR_MM = 40.0, FAR_MM = 150.0, SHUNT_OHM = 165.0;

// ---------------------------------------------------------------- state
FastAccelStepperEngine engine;
FastAccelStepper *stepper = nullptr;
HardwareSerial &TMCSerial = Serial2;
TMC2209Stepper driver(&TMCSerial, 0.11f, 0b00);
Adafruit_ADS1115 ads;

bool homed = false;
int err = 0;                      // 0 ok, else a fault: refuses P/GO until HOME
float limBottom = POS_MAX, vmax = 15, amax = 1000;
enum Mode { HOLD, TRAJ } mode = HOLD;
float holdPos = 0;
const int QMAX = 128;
struct Pt { uint32_t t; float pos; } q[QMAX];
int qn = 0;
uint32_t lastRx = 0;
String line;

float deepest() { return min(POS_MAX, limBottom); }
float clampPos(float p) { return max(0.0f, min(deepest(), p)); }
long toSteps(float mm) { return lround(mm * STEPS_PER_MM); }
float posMm() { return stepper ? stepper->getCurrentPosition() / STEPS_PER_MM : 0; }

void fault(int code, const char *text) {
  err = code;
  mode = HOLD; qn = 0; holdPos = 0;
  if (stepper && homed) { stepper->setSpeedInHz(vmax * STEPS_PER_MM); stepper->moveTo(0); }
  Serial.printf("E %s\n", text);
}

// the trajectory's target at time t: linear between points, held after the last
float target(uint32_t t) {
  if (mode != TRAJ || qn == 0) return mode == TRAJ ? posMm() : holdPos;
  if ((int32_t)(t - q[0].t) <= 0) return q[0].pos;
  for (int i = 1; i < qn; i++) {
    if ((int32_t)(q[i].t - t) >= 0) {
      float u = (float)(t - q[i - 1].t) / max(1u, q[i].t - q[i - 1].t);
      return q[i - 1].pos + (q[i].pos - q[i - 1].pos) * u;
    }
  }
  return q[qn - 1].pos;
}

// new points from the first new time on replace the queued ones
void addPoints(const String &s) {
  int i = 2, n = 0;
  Pt in[QMAX];
  while (i < (int)s.length() && n < QMAX) {
    int a = s.indexOf(' ', i); if (a < 0) break;
    int b = s.indexOf(' ', a + 1); if (b < 0) b = s.length();
    in[n].t = (uint32_t)strtoul(s.substring(i, a).c_str(), nullptr, 10);
    in[n].pos = clampPos(s.substring(a + 1, b).toFloat());
    n++; i = b + 1;
  }
  if (!n) return;
  int keep = 0;
  while (keep < qn && (int32_t)(in[0].t - q[keep].t) > 0) keep++;
  qn = keep;
  for (int k = 0; k < n && qn < QMAX; k++) q[qn++] = in[k];
  mode = TRAJ;
}

bool home() {
  if (!stepper) return false;
  stepper->setAcceleration(amax * STEPS_PER_MM);
  stepper->setSpeedInHz(5 * STEPS_PER_MM);
  // up until the end stop, at most the whole travel and a bit
  stepper->setCurrentPosition(toSteps(TRAVEL_MM + 2));
  stepper->moveTo(0);
  uint32_t t0 = millis();
  while (digitalRead(PIN_ENDSTOP) == HIGH) {
    if (!stepper->isRunning() || millis() - t0 > 8000) { stepper->forceStop(); return false; }
    delay(1);
  }
  stepper->forceStop();
  delay(50);
  // back off 0.5 mm: pos 0 there
  stepper->setCurrentPosition(0);
  stepper->setSpeedInHz(2 * STEPS_PER_MM);
  stepper->moveTo(toSteps(0.5));
  while (stepper->isRunning()) delay(1);
  stepper->setCurrentPosition(0);
  holdPos = 0; mode = HOLD; qn = 0; homed = true; err = 0;
  return digitalRead(PIN_ENDSTOP) == HIGH;  // clear of it again
}

// the sensor: median of n readings (mm), and their spread
void readSensor(int n) {
  n = constrain(n, 1, 64);
  float v[64];
  for (int k = 0; k < n; k++) {
    float volts = ads.computeVolts(ads.readADC_SingleEnded(0));
    float mA = volts / SHUNT_OHM * 1000.0;
    v[k] = NEAR_MM + (mA - 4.0) / 16.0 * (FAR_MM - NEAR_MM);
    if (mA < 3.5) { Serial.println("E sensor no current (wiring, or nothing in range)"); return; }
    delay(5);  // the sensor updates at ~200 Hz
  }
  for (int a = 1; a < n; a++) { float x = v[a]; int b = a - 1; while (b >= 0 && v[b] > x) { v[b + 1] = v[b]; b--; } v[b + 1] = x; }
  Serial.printf("R %.3f %d %.3f\n", v[n / 2], n, v[(int)(n * 0.9)] - v[(int)(n * 0.1)]);
}

void handle(const String &s) {
  lastRx = millis();
  if (s == "?") { Serial.printf("PZ %s travel=%.1f spm=%.0f homed=%d\n", FW, TRAVEL_MM, STEPS_PER_MM, homed ? 1 : 0); return; }
  if (s == "HOME") { if (home()) Serial.printf("HOMED %lu\n", (unsigned long)millis()); else fault(2, "home end stop not found"); return; }
  if (s == "T") { Serial.printf("T %lu\n", (unsigned long)millis()); return; }
  if (s.startsWith("LIM ")) {
    float b, v, a;
    if (sscanf(s.c_str() + 4, "%f %f %f", &b, &v, &a) == 3) { limBottom = b; vmax = max(0.5f, v); amax = max(10.0f, a); stepper->setAcceleration(amax * STEPS_PER_MM); }
    Serial.println("OK"); return;
  }
  if (s.startsWith("P ")) { if (homed && !err) addPoints(s); return; }
  if (s.startsWith("GO ")) {
    if (!homed || err) { Serial.println("E notready home first"); return; }
    float p, v; sscanf(s.c_str() + 3, "%f %f", &p, &v);
    mode = HOLD; qn = 0; holdPos = clampPos(p); Serial.println("OK"); return;
  }
  if (s == "UP") { mode = HOLD; qn = 0; holdPos = 0; Serial.println("OK"); return; }
  if (s.startsWith("R")) { readSensor(s.length() > 2 ? s.substring(2).toInt() : 8); return; }
  if (s == "S") {
    Serial.printf("S %lu pos=%.3f tgt=%.3f v=%.2f homed=%d q=%d err=%d\n", (unsigned long)millis(), posMm(), target(millis()),
      stepper ? stepper->getCurrentSpeedInMilliHz() / 1000.0 / STEPS_PER_MM : 0, homed ? 1 : 0, qn, err);
    return;
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_ENDSTOP, INPUT);
  TMCSerial.begin(115200, SERIAL_8N1, PIN_TMC_RX, PIN_TMC_TX);
  driver.begin();
  driver.toff(4);
  driver.rms_current(MOTOR_MA);
  driver.microsteps(MICROSTEPS);
  driver.pwm_autoscale(true);
  driver.en_spreadCycle(false);  // StealthChop: quiet
  engine.init();
  stepper = engine.stepperConnectToPin(PIN_STEP);
  if (stepper) {
    stepper->setDirectionPin(PIN_DIR, DIR_DOWN_HIGH);
    stepper->setEnablePin(PIN_EN);
    stepper->setAutoEnable(false);
    stepper->enableOutputs();
    stepper->setAcceleration(amax * STEPS_PER_MM);
  }
  Wire.begin();
  ads.setGain(GAIN_ONE);         // ±4.096 V: 4–20 mA × 165 Ω = 0.66–3.3 V
  ads.setDataRate(RATE_ADS1115_860SPS);
  if (!ads.begin()) Serial.println("E sensor ADS1115 not found");
}

uint32_t lastCtl = 0, lastDrv = 0;
void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') { if (line.length()) handle(line); line = ""; }
    else if (line.length() < 2000) line += c;
  }
  uint32_t now = millis();
  if (now == lastCtl || !stepper || !homed) return;
  lastCtl = now;
  // the watchdog: a trajectory running and nothing from Run for 1 s → up
  if (mode == TRAJ && now - lastRx > 1000) { mode = HOLD; qn = 0; holdPos = 0; Serial.println("E watchdog no line for 1 s"); }
  // points well past: dropped (the last one kept to hold)
  while (qn > 1 && (int32_t)(now - q[1].t) > 50) { for (int k = 1; k < qn; k++) q[k - 1] = q[k]; qn--; }
  // aim 20 ms ahead (the stepper's own acceleration ramps lag that much at the speeds used)
  float tgt = clampPos(target(now + 20));
  stepper->setSpeedInHz((uint32_t)(vmax * STEPS_PER_MM));
  stepper->moveTo(toSteps(tgt));
  // the end stop is at the top: blocked while well down means the nozzle was pushed up or slipped
  if (digitalRead(PIN_ENDSTOP) == LOW && posMm() > 1.0 && !err) fault(3, "endstop hit away from the top (crash or lost steps): HOME");
  if (now - lastDrv > 200) {
    lastDrv = now;
    if (driver.otpw() && !err) fault(4, "driver otpw (over temperature)");
  }
}
