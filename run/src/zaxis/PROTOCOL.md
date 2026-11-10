# Pathline Z: Run ↔ head Z axis (ESP32 + TMC2209 + ultrasonic sensor)

The head carries its own Z axis, which moves the whole nozzle. It's driven by an ESP32 with a TMC2209 and a NEMA 11 lead-screw motor, and has an ultrasonic distance sensor: a PONO 18GM40-150, read through 4–20 mA into an ADS1115. Pathline Run drives it over USB serial (CDC, 115200 baud, any rate works) with one ASCII command per line, ending in `\n`.

## Positions

- `pos` is in mm, **down from the top end stop**. 0 is fully up, which is home. It grows towards the sheet.
- The firmware never goes below its own hard limit, `POS_MAX`, set when it's built, nor below the limit Run sends (`LIM`). Whichever is shallower wins.
- Run's planner works in the same `pos`. Focus is `ref`, the `pos` where the nozzle was focused over the reference point.

## Commands (Run → ESP32)

| Line | Reply | What |
|---|---|---|
| `?` | `PZ <fw> travel=<mm> spm=<steps/mm> homed=<0/1>` | who and what |
| `HOME` | `HOMED <ms>` or `E home <text>` | up to the end stop (optical), then back off 0.5 mm; pos = 0 there |
| `T` | `T <espMs>` | the ESP32's clock (ms, `millis()`), for Run's clock sync |
| `LIM <bottom> <vmax> <amax>` | `OK` | the deepest pos allowed now (mm), speed (mm/s), acceleration (mm/s²) |
| `P <ms> <pos> [<ms> <pos> …]` | none | trajectory points on the ESP32's clock. Points from the first new time on replace the ones queued. |
| `GO <pos> <v>` | `OK` | move straight there (clears the trajectory) |
| `UP` | `OK` | to pos 0 at full speed, trajectory cleared, then held |
| `R <n>` | `R <mm> <n> <spread>` | sensor distance: the median of n readings (n ≤ 64), and their spread (p90 − p10) |
| `S` | `S <espMs> pos=<> tgt=<> v=<> homed=<0/1> q=<points> err=<code>` | state |

## Following a trajectory

- Every 1 ms the firmware works out the target from the queued points: linear between points, held after the last.
- It moves towards the target at the target's own speed (feed-forward) plus 20/s × the error, limited by `vmax` and `amax`.
- With no point ahead, it holds where it is. It never goes deeper on its own.
- **Watchdog:** with a trajectory running and no line from Run for 1000 ms, it does `UP`.

## Faults (ESP32 → Run, at any time)

`E <code> <text>`, for example `E endstop hit while moving down`, `E driver otpw` or `E sensor no current`. After a fault the axis goes `UP` and refuses `P`/`GO` until `HOME`.

## Safety, both ends

- **Run:**
  - a job is only followed with a height map of the sheet;
  - the planned nozzle is never lower than the map allows over ±0.5 s of route time, so if the drawing is early or late the nozzle is high, not low;
  - Run lifts during travel, and goes `UP` when it isn't sure where the head is, or when the job pauses, stops, opens the lid or alarms.
- **Firmware:** `POS_MAX`, the end stop, the watchdog, and `UP` on any fault.
