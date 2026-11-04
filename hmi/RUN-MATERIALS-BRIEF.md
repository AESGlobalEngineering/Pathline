# Brief for Pathline Run: keep material settings on the machine

**From:** the Pathline Prepare session, 4 Nov 2026. Prepare 1.5.0 already sends and reads these; this is the Run side.
**Spec:** `hmi/HMI-BRIEF.md` §5.3 (the protocol). This brief is what to build.

## Why

Material settings (cut and engrave processes per material) are made in Pathline Prepare, per machine. Today they live only on the computer that made them. With this change each machine keeps the settings made for it, so any computer running Pathline Prepare that connects to the machine gets them.

## What Pathline Run needs to do

1. **`GET /api/v1/materials`**
   - Return the stored document exactly as last received.
   - If nothing has been stored yet, return `{ "format": "pathline-materials", "version": 1, "materials": [] }` with status 200.
   - Answer quickly: Prepare calls it on every settings read (when it connects, when it opens, every 5 minutes).
2. **`PUT /api/v1/materials`**
   - The body is the whole list. **Replace** what's stored; don't merge.
   - Refuse a body whose `format` isn't `"pathline-materials"`, or whose `materials` isn't an array, with `400 { "error": "Not a materials list" }`.
   - Save it to disk next to Run's other data, writing a temp file and then renaming it, so a power cut can't leave half a file. Keep it across restarts and updates.
   - Answer `{ "ok": true, "count": <materials.length> }`.
   - Bodies are small (tens of kB). Accept at least 5 MB.
3. **Keep every field.** Store the JSON as received, including fields not listed below; Prepare may add some. Don't reorder, rename or drop anything, and don't compare timestamps: Prepare decides which copy is newer, using `updatedAt`.
4. **Optional, in the HMI:** a read-only Materials view showing name, thickness, group, and each process with power, speed and passes (plotters: tool, speed, passes). No editing in v1.

Run never has to use these settings to cut. Every job package still carries its own process settings, as before.

## The document

```json
{
  "format": "pathline-materials", "version": 1,
  "machine": { "id": "m-eth", "name": "Trotec Q500", "type": "laser" },
  "materials": [
    {
      "id": "mat-3k9x2", "name": "Cast acrylic", "t": 3, "g": "Acrylic", "sw": "#E1E4E8", "notes": "",
      "updatedAt": "2026-11-04T10:02:39.928Z",
      "processes": [
        { "name": "Cut contour", "proc": "Cut", "power": 90, "speed": 20, "f": 5000, "passes": 1, "out": true, "aci": [1], "adv": {} },
        { "name": "Engrave fill", "proc": "Engrave", "power": 60, "speed": 400, "f": 500, "passes": 1, "out": true, "aci": [7], "adv": {}, "dir": "down", "uni": false }
      ]
    }
  ]
}
```

- `t` is the thickness in mm; `g` is the group (Acrylic, Wood, Board & card, Film & sheet, Foam, Metal or the user's own); `sw` is the swatch colour.
- **Laser processes:**
  - `proc` is `Cut` or `Engrave`.
  - `power` is %, `speed` is mm/s, and `f` is Hz for cuts or DPI for engraves.
  - Also: `passes`, `dwell` (seconds between passes), `dash`/`dl`/`gl` (links), `air`, `source`, and `dir`/`uni` (engrave direction and one-way scan).
- **Plotter processes:** `tool` (e.g. `"T1 · Knife"`), `speed`, `passes`, `dash`/`dl`/`gl`.
- Text is UTF-8 and contains `·`, `×` and `°`.

## How Prepare uses it (so the behaviour makes sense)

- **Reading:** whenever Prepare reads `GET /machine`, it also reads `GET /materials`.
  - A material it doesn't have, or one that is newer on the machine, comes into its library.
  - A material the user deleted in Prepare is not brought back.
- **Writing:** if Prepare's list for this machine differs (ids or `updatedAt`), it sends the whole list with `PUT`. Saving the material library in Prepare also sends it to every connected machine.
- **Old HMIs:** a `404` on `GET /materials` means "this HMI doesn't keep materials". Prepare then sends nothing and carries on, so Run versions without this keep working.

## Check it

- `tools/device-emulator.js` in the Prepare repo implements both routes. It stores the list in `<out>/materials.json`, and you can compare Run's answers with it.
- With Run on a machine:
  1. In Prepare, edit a material's power for that machine and save.
  2. `GET /materials` on Run should show the new value and a new `updatedAt`.
  3. Restart Run: the list is still there.
  4. On a second Prepare install, add the same machine: the material appears in its library.
- Add a Run self-test: `PUT` a list, `GET` it back unchanged, `PUT` a non-list and get `400`, and check the list survives a restart.
