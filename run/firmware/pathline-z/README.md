# Pathline Z: head Z axis firmware (ESP32)

This firmware drives the head Z axis for Pathline Run, which moves the whole nozzle. The protocol is in `run/src/zaxis/PROTOCOL.md`.

**It has not been run on hardware yet.** Bench-test it with the motor not yet fitted to the nozzle; the checklist is below.

## Parts

| Part | Notes |
|---|---|
| ESP32 DevKitC (or any ESP32) | USB to the Pathline Run PC, as a serial port at 115200 baud |
| TMC2209 driver | UART mode; StealthChop. Wire 1 kΩ from TX to PDN_UART |
| NEMA 11 lead-screw motor | 1–2 mm lead, anti-backlash nut. Lighter than a NEMA 17, which adds ~300 g to the Trotec's head |
| Optical end stop at the **top** | Low when blocked. Home is up, so homing never moves towards the sheet |
| PONO 18GM40-150 ultrasonic | 40–150 mm, 4–20 mA output. Mount it so the sheet is 70–100 mm away |
| ADS1115 + 165 Ω shunt | 4–20 mA → 0.66–3.3 V. Keeps the ESP32's own noisy ADC out of it, and current stands up to noise on a moving cable |

## Pins (DevKitC; change at the top of the sketch)

| What | Pin |
|---|---|
| STEP / DIR / EN | 26 / 27 / 25 |
| TMC2209 UART (Serial2 RX / TX) | 16 / 17 |
| End stop | 34 |
| I²C to ADS1115 (SDA / SCL) | 21 / 22 |

## Set before building

- `LEAD_MM`, `MICROSTEPS`, `TRAVEL_MM`, `MOTOR_MA` for your motor.
- `DIR_DOWN_HIGH`: the DIR level that moves the nozzle **down**.
- **`POS_MAX`:** the deepest the nozzle may ever go, in mm down from the top. The firmware never passes it, whatever Pathline Run sends. Set it so that at `POS_MAX` the nozzle is still clear of the honeycomb with no sheet.
- `NEAR_MM` / `FAR_MM`: the range taught on the PONO, where 4 mA and 20 mA are read.

## Bench checklist, before fitting it to the head

1. `?` answers `PZ …`.
2. `HOME` moves up only, stops on the end stop, backs off 0.5 mm, and answers `HOMED`.
3. `GO 3 5` moves 3 mm down; `UP` comes back to 0.
4. `GO 20 5` stops at `POS_MAX`.
5. Send a trajectory, then stop sending. Within 1 s it says `E watchdog` and goes up.
6. `R 16` answers about the distance to a board held under the sensor, with a spread under about 0.5 mm.
7. Block the end stop by hand while the nozzle is down. It reports `E endstop hit…` and goes up.

Then, in Pathline Run, go to **Setup → Z axis**: switch it on, pick the port, and leave **Dry run** on for the first jobs. Run logs what it would have done in each job's record, without moving the nozzle.
