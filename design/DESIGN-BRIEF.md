# Pathline: design brief

**Goal: harmonise the whole design.** Pathline's four screens were designed and extended over many rounds. Each one works, but they no longer look like one app: headers, buttons, fields, tabs, dropdowns and labels differ from page to page. Make every screen, dialog and menu feel like the same product, without changing what the app does.

Open `START HERE.html` to see every screen running with sample data, plus screenshots of today's dialogs and menus.

---

## 1. What Pathline is

Pathline is a Windows desktop app (Electron, window 1440 × 900, minimum 1024 × 680) used in a workshop to **prepare** jobs for lasers and plotters/routers:

1. **Job**: import DXF/PDF/SVG/PLT drawings, arrange and edit them, and give each drawing colour (an AutoCAD Color Index, "ACI") a **process** (cut, engrave, registration marks, or a plotter tool) with power and speed settings.
2. **Simulation**: play back the toolpath in run order, with a time estimate and (on lasers) a thermal map.
3. **Setup → Machines**: the connection to each machine's controller, and settings read from it.
4. **Setup → Materials**: the material library, with power and speed presets per machine.

The users are machine operators, often on a shop-floor PC. They need clarity, legible numbers and big enough targets, not decoration.

## 2. What's in this folder

| Path | What it is |
|---|---|
| `START HERE.html` | Links to every screen, in two states: with sample data, and first run (empty) |
| `src/ui/MainDetailed.dc.html` | **Job** page |
| `src/ui/SimulationDetailed.dc.html` | **Simulation** page |
| `src/ui/MachineSetupDetailed.dc.html` | **Setup → Machines** |
| `src/ui/MaterialsDetailed.dc.html` | **Setup → Materials** |
| `src/ui/fonts.css` | The only stylesheet shared by all pages: fonts, plus the toasts and dialogs drawn by `app.js` |
| `src/ui/app.js` | Shared UI code: toasts, dialogs, the Send dialog, the right-click menu and the Job canvas. Its dialogs are styled by `fonts.css`. |
| `src/ui/support.js` | The page template runtime. **Don't edit.** |
| `src/shared/core.js` | Geometry, estimator and thermal model. **Don't edit.** |
| `design/mock-api.js` | Sample data and pretend machine actions, used only in this preview |
| `src/ui/brand/`, `build/brand/` | The Pathline logo and icon (keep them) |
| `screenshots/` | Every screen and dialog as it looks today |

The folder layout matches the app, so finished pages copy straight back into it.

## 3. How a page is built (the rules that keep it working)

Each page is a template inside `<x-dc>…</x-dc>`, followed by a `<script type="text/x-dc">` that holds the page's logic (`class Component extends DCLogic`). `renderVals()` returns the values the template shows.

- `{{name}}` inserts a value or a handler, e.g. `onClick="{{save}}"` or `style="background: {{accent}}"`.
- `<sc-for list="{{items}}" as="x">` repeats its content, and `<sc-if value="{{flag}}">` shows it conditionally. The `hint-placeholder-*` attributes are only design-time hints.
- Supported events: `onClick`, `onDoubleClick`, `onContextMenu`, `onMouseDown`, `onKeyDown`, `onBlur`, `onChange`. **There is no `onDrop`.**
- A `<sc-for>` inside a `<select>` is dropped by the HTML parser. Those selects are built in code and inserted as a value (e.g. `{{groupSelect}}`).
- Complex interactive parts (the job canvas, the simulation scene, inline rename boxes) are React elements built in `renderVals()` and inserted as a value (`{{canvasEl}}`, `{{scene}}`). Restyle around them; their insides are drawn by `app.js` and the page code.

**You may:**
- Restyle and restructure the markup and the page `<style>` blocks freely.
- Move elements, regroup them and change spacing, type, colour, radius, shadows and icons. The icon paths are in `renderVals()` under `icons`.
- Change the colour and size values that `renderVals()` returns for styling (e.g. `statusBg`, `tbg`, `bg`).
- Add a shared stylesheet, e.g. `src/ui/theme.css` with design tokens and the common classes. Link it from every page next to `fonts.css`. This is strongly encouraged: today every page repeats its own copy of `.tb`, `.ib`, `.fld` and `.cell` with small differences.
- Restyle the dialogs, toasts and menus in `fonts.css` (`.lrc-dlg`, `.lrc-toast` and so on). The right-click menu and the Send dialog markup are built in `src/ui/app.js` (`contextMenu`, `sendDialog`). Style changes there are fine; keep the behaviour.

**Please keep:**
- Every `{{binding}}`, `sc-for`, `sc-if` and event attribute, so the same data and actions stay wired. If you remove a binding, the feature it shows is lost.
- `aria-label`, `role` and `title` attributes. The app's automated checks find controls by them, for example `aria-label="Job canvas"`, "Zoom in", "Zoom out", the `title="Actual size"` zoom readout, and the "Machines" / "Setup" tab lists.
- The logic in the `<script type="text/x-dc">` blocks (state, handlers, calculations). Only styling values may change there.
- The extra line `<script src="../../design/mock-api.js">` in each page's `<head>`. It's only for this preview and is removed when the pages go back into the app.

## 4. The owner's decisions (don't undo these)

- The top bar has **Job · Simulation** only. Machines and Materials are reached from the **Setup** menu in the Job page's menu bar (Setup → Machines…, Materials…, Test grid…). The Setup pages show a **Machines | Materials** switch. The Simulation page has no link to Setup.
- There is no Machine menu. Frame, home, origin and jog are in the Job page's **Move** tab.
- **Features a machine doesn't have are hidden, not greyed out**: rotary, auto-focus, camera/registration marks, air assist, conveyor, vacuum and pointer.
- No save icon in the top-left corner. The bottom bar has **Send to machine** only (no Frame button).
- Process settings open as a **dropdown under each process row**, not as a separate panel. The eye icon on a process only fades its objects on the canvas.
- An edited process shows a **Job override** tag. "Save to material" and "Revert to material preset" go with it.
- Send dialog: connection check first, a red "Connection failed" box with **Try again**, blocking problems in red, warnings in amber, then a progress bar. **No blue explainer box.**
- Simulation: a single "Simulate" entry point, no "Export job sheet" or "Back to design" buttons. Thermal map on lasers only.
- **The Job canvas and the Simulation view share one set of zoom controls**: a bordered group [− · zoom % · +], where clicking the % gives actual size, then a **Fit** button. They also share the same keys: wheel to zoom, + / − / 0. Keep the two identical.
- The app ships with **no machines or materials**. The first-run screens (empty Setup pages, and the "No machine" stand-in on the Job page) matter; see the "First run" links in `START HERE.html`.
- Brand: **Pathline**, IBM Plex Sans and IBM Plex Mono (bundled, works offline). **Updated 28 Oct 2026:** the accent is now Path red (`#D62828`) with the Kerf logo, and the app has a dark mode; tokens and components are in `src/ui/theme.css`, decisions in `HARMONISE-SPEC.md`. Machine-type badges: laser (black), plotter `#0B7F75`. **ACI colours are data**: the colour swatches on objects and processes must show the real ACI colour (red 1, yellow 2, green 3, cyan 4, blue 5, magenta 6, black/white 7…). Don't restyle them.

## 5. What doesn't match today (a starting list)

Found by comparing the pages. It isn't complete: harmonise anything else you notice too.

1. **Headers differ on every page.**
   - **Job:** logo, job name, menu bar, the Job | Simulation switch in the **centre**, and a machine box on the right, with a second toolbar row underneath.
   - **Simulation:** the Job | Simulation switch on the **left**, a title, machine chips, and **Send to machine** on the right.
   - **Setup pages:** the switch on the left, a Machines | Materials switch, a title, and Save on the right.

   The logo only appears on Job. Pick one header structure and make the switch sit in the same place on every page.
2. **Icon buttons (`.ib`):** borderless with a grey hover on Job, Materials and Machines; bordered white boxes on Simulation.
3. **Field heights:** `.fld` is 34 px on Job and Machines but 36 px on Materials, `.cell` is 32 px, and the dialog fields are 34 px. Disabled opacity is 0.35, 0.45 or 0.5 depending on the page.
4. **Dropdowns:** Materials uses native `<select>` (Group, Process, Source, Test grid process), while Job and Machines use custom dropdown buttons with a chevron.
5. **Three kinds of tabs:** underline tabs (Job side panel; Machines settings), segmented controls (Machines | Materials, All/Laser/Plotter, Cut order) and the Job | Simulation pill. Decide which is used for what, and use it consistently.
6. **Section labels:** UPPERCASE small caps ("MACHINES", "ACRYLIC", "WOOD") on some pages, sentence-case bold ("Processes", "Display", "Checks") on others.
7. **Primary buttons:** Send to machine (large, icon), Save (disabled light blue), and the dialog primary button all differ in size and weight.
8. **Status:** "Checking…" / "Offline" / "Ready" appear as a pill on Machines and as a dot plus text in the Job header. Check results are green pills in the Job footer but green rows on Simulation.
9. **Monospace use:** the Send dialog sets every value in mono, including names like "Laser A". Elsewhere, mono is used only for numbers and units. Numbers in mono everywhere, words in sans, would be consistent.
10. **Process row header** (Job → Processes): a long name plus the "Job override" tag wraps awkwardly (see `screenshots/override-dialog.png`, "Cut contour").
11. **Colours are hard-coded hex values everywhere.** The same greys appear with small variations: `#5B6370`, `#3A414C`, `#8A919C`, `#AEB5C0`, and the borders `#D5D9DF`, `#E1E4E8`, `#DDE0E5`. Define tokens and use them.
12. **Empty states:** the new "No machines yet" and "No materials yet" cards are plain. Make them match the rest of the design.

## 6. Where every screen and dialog lives

| Screen / state | How to open it in the preview |
|---|---|
| Job, Simulation, Machines, Materials | `START HERE.html` |
| Menu bar menus | Job page: click File / Edit / Arrange / Setup / Help |
| Right-click menu | Job page: right-click an object |
| Processes / Objects / Move / Queue tabs | Job page, right-hand panel |
| Process settings dropdown | Job → Processes: click a process row |
| Registration marks menu | Job page toolbar: "Registration marks: Full linear" |
| Material picker | Job → Processes: the Material box at the top |
| Fill, Sheet, Array, Offset, Rotate, Nest dialogs | Job toolbar (Fill, Sheet). Arrange menu → Array…, Offset path…, Rotate → Custom angle…, Nest parts… (plotters only: pick Plotter B in the machine box) |
| Rename, text, ACI number dialogs | Right-click → Rename…; the T tool; right-click → colour "ACI #" |
| Keyboard shortcuts sheet | Help → Keyboard shortcuts |
| Send to machine (checks, progress, "Sent to") | Job: Send to machine. Click Send to see the progress state |
| Job overrides prompt | Change a process value, then Send to machine |
| Thermal map | Simulation: Display → Thermal map |
| Add machine dialog | Setup → Machines: Add machine |
| New material dialog | Setup → Materials: New material |
| Test grid | Setup → Materials: lower left card. Also Setup → Test grid… on the Job page |
| Toasts | Appear after most actions, for example recolouring an object |
| First run (empty) | `START HERE.html`, the "First run" row |

The preview doesn't save files or talk to machines. Actions such as Open, Import library and Open HMI show a short "(design preview)" message instead. Importing a drawing adds a sample outline. The Text tool needs the app (browsers block loading its font file from disk).

## 7. What to hand back

- The four `src/ui/*.dc.html` pages, `src/ui/fonts.css`, and any new shared stylesheet (e.g. `src/ui/theme.css`).
- Changes to the dialog or menu markup in `src/ui/app.js`, if you made any.
- A short note listing the tokens and components you settled on, and anything you couldn't harmonise without changing behaviour.

The pages then go back into the app: the mock line is removed, and the app's self-test and screenshot checks are run on the real data.
