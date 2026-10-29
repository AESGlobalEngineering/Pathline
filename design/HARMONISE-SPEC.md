# Pathline: harmonised design spec (rebrand + dark mode)

Decided 28 Oct 2026. Applies to the four app pages in `src/ui/` and to the Pathline Run HMI prototype (`hmi/project/HMI.dc.html`). Read `design/DESIGN-BRIEF.md` first: its rules on bindings, aria labels and the owner's decisions still hold. **One owner decision changes:** the accent is now **Path red** (brand), not blue `#2457D6`.

The tokens and shared components live in **`src/ui/theme.css`** (read it). Dialogs, toasts and the right-click menu are in `src/ui/fonts.css` and `src/ui/app.js` and are already done.

## 1. Brand

- Name: **Pathline** (design app) and **Pathline Run** (HMI), IBM Plex Sans 600 for the name, 400 for "Run".
- Logo: the "Kerf" tile. Pathline app icon (red tile, white + black halves) in the app bar of every page:
  `<svg viewBox="0 0 64 64" width="28" height="28" role="img" aria-label="Pathline" style="flex: none; display: block"><rect width="64" height="64" rx="15" fill="#D62828"></rect><g transform="translate(14 14) scale(0.5625)" stroke-width="6" stroke-linejoin="round"><polygon points="6,6 50,6 6,50" fill="#FFFFFF" stroke="#FFFFFF"></polygon><polygon points="58,14 58,58 14,58" fill="#111214" stroke="#111214"></polygon></g></svg>`
  Pathline Run uses the black tile: rect fill `#111214`, top-left half `#EF3B33`, bottom-right half `#FFFFFF`. In dark mode give the black tile a 1px ring (`box-shadow: 0 0 0 1px var(--line-strong)` on a wrapper, or a stroke on the rect) so it doesn't vanish.
- Colours: Path red `#D62828`, red on black `#EF3B33`, black `#111214`, surface `#F3F4F6`. In the UI always use the tokens below, never these hexes (the logo SVG is the exception).

## 2. Tokens (from theme.css)

Light is default; dark applies when `<html data-theme="dark">`. `LRC.theme` (app.js) sets it.

| Use | Token | Replaces (light hex) |
|---|---|---|
| App background | `--bg` | `#F3F4F6` |
| Panels, cards, popovers, inputs | `--surface` | `#FFFFFF` (as a background) |
| Subtle panel / alternate rows | `--surface-2` | `#FAFAFB`, `#F7F8FA`, `#FBFBFC` |
| Segmented-control track, read-only field bg, neutral pill bg | `--sunken` | `#F0F1F4`, `#F3F4F6` on fields |
| Hover background | `--hover` | `#EEF0F3` (as a background) |
| Canvas / scene viewport | `--canvas`, `--canvas-dot` (or class `.viewport`) | `#E9EBEE`, dots `#CDD2D9` |
| Selected segment | `--seg-on` | `#FFFFFF` on a segment |
| Switch knob | `--knob` (white in both) | `#FFFFFF` on a knob |
| Divider / card border | `--line` | `#E1E4E8`, `#DDE0E5` |
| Row separator | `--line-soft` | `#EEF0F3` (as a border) |
| Control border | `--line-strong` | `#D5D9DF`, `#CDD2D9` |
| Control border on hover, idle dot | `--line-hover`, `--idle-dot` | `#AEB5C0` |
| Switch off track | `--track` | `#C9CED6` |
| Text | `--text` | `#15181E`, `#111214` (as text) |
| Secondary text | `--text-2` | `#3A414C` |
| Muted text, labels, units | `--text-3` | `#5B6370` |
| Faint text, placeholders | `--text-4` | `#8A919C` |
| Accent fill (white text on it) | `--accent`, hover `--accent-hover` | `#2457D6`, `#1A43AB` |
| Accent text/icon/indicator on a surface | `--accent-fg` | `#2457D6` used as a text/icon colour |
| Accent tint (selected rows, tags) | `--accent-soft` | `#EEF2FC`, `soft(accent, 0.9)` |
| Focus ring | `--accent-ring` | `#DCE6FB` |
| Text on accent | `--on-accent` | `#FFFFFF` on an accent fill |
| OK | `--ok`, `--ok-soft`, `--ok-dot` | `#1B6B43`, `#EDF7F1`, `#30A46C` |
| Warning | `--warn`, `--warn-soft`, `--warn-dot` | `#8A4B00`, `#FFF1DB`, `#E5A000` |
| Error | `--err`, `--err-soft`, `--err-dot` | `#B42318`, `#FDECEC`, `#E5484D` |
| Machine badges | class `.badge` / `.badge.plotter` (`--badge-laser`, `--badge-plotter`) | `#15181E`, `#0B7F75` |
| Shadows | `--shadow-1` (segments), `--shadow-pop` (menus/popovers), `--shadow-dlg` | `rgba(21,24,30,…)` |
| ACI chip outline | `--chip-ring` | `inset 0 0 0 1px rgba(21,24,30,0.18)` |
| The bed and sheet (they stand for the material) | `--bed`, `--bed-line`, `--sheet` (stay light in dark mode) | |

**Data colours never change:** ACI swatches and their text colour (`CC.aciFg`, the `ACI` tables, `#FF0000`…), material swatches (`sw`), the thermal map scale, anything drawn *on* the bed. Leave those hexes alone.

**In JS:** styling values returned by `renderVals()` become token strings, e.g. `bg: on ? 'var(--accent-soft)' : 'transparent'`, `fg: on ? 'var(--text)' : 'var(--text-3)'`. Replace `const accent = this.props.accent ?? '#2457D6'` with `const accent = 'var(--accent)'`, and `accentSoft` with `'var(--accent-soft)'` (delete the `soft()` helper if nothing else uses it; remove the `accent` entry from `data-props`). Where `accent` colours text or an icon on a surface, use `'var(--accent-fg)'` instead. **SVG/React presentation attributes** (`fill:`, `stroke:` props on `h('rect', …)`) don't reliably resolve `var()`: pass theme colours as `style: { fill: 'var(--x)' }`; in templates, an SVG `fill="{{x}}"` attribute should become `style="fill: {{x}}"` when x is a token.

## 3. Components (classes in theme.css)

Use the classes; delete the page's own copies of `.ib`, `.tb`, `.fld`, `.cell`, `.mono`, `.lbl`, `svg.i`, `a`/`a:hover` from its `<helmet><style>`. Keep only genuinely page-specific CSS there, written with tokens.

- **Control height 36 px** (`--ctl-h`) for buttons, fields, table cells, dropdowns and dialog fields. Small variant `.tb.sm` (28) only inside dense popovers. Disabled = opacity 0.45 everywhere (theme.css does it for `button:disabled`; don't set other opacities for disabled).
- **Buttons:** `.tb` (secondary, bordered), `.btn-primary` (accent; `.btn-primary.lg` = 44 px, only for **Send to machine** in the Job bottom bar), `.btn-link` (accent text, e.g. "Advanced"), `.ib` (icon button: borderless, grey hover, **everywhere**, including Simulation), `.ctl-group` (bordered group: the zoom [− · % · +] on Job and Simulation, identical markup).
- **Fields:** `.fld` (with input inside, unit as `<span class="lbl">`), `.cell` (table input), `.dd` dropdown. Custom dropdown buttons → `<button class="dd">` + chevron icon, list → `.pop` with `.opt` items. Native `<select>` stays native (behaviour) but gets `class="dd"` (or `cell dd`) so it looks identical.
- **Choices:** `.seg` for page switches (Job | Simulation, Machines | Materials) and value choices (All/Laser/Plotter, cut order, fill modes…); the current item gets `aria-current="page"` (links) or `aria-checked="true"` / class `on`. `.tabs` (underline) for panels inside a page: the Job side panel (Processes / Objects / Move / Queue), Machines settings sections, the machine tabs on a material, HMI views. Counts in tabs use `<span class="count">`.
- **Switch:** `<button role="switch" class="sw" aria-checked="{{x.on}}" …>` — no inner knob span needed (theme.css draws it). Keep the aria-label/labelledby.
- **Sections:** `.card` containers. Card/section titles = `.h-sec` (sentence case, 14/600). Page title in the app bar = `.h-page`. Group headings inside lists (material groups, machine list) = `.eyebrow` (small caps). No other heading styles.
- **Lists:** selectable rows = `.list-item` (+ `on` / `aria-current`).
- **Status:** always a `.pill` with a dot: `.pill.ok` (Ready / Connected / check passed), `.pill.warn`, `.pill.err` (Offline / failed), plain `.pill` (Checking… / idle), `.pill.accent`. Check results (Job footer, Simulation checks) are `.pill.ok` with a check icon (`.pill.check` hides the dot). Tags like **Job override** / **Edited** = `.tag.accent` / `.tag.warn`; "Material preset" = `.tag`.
- **Numbers:** mono (`.mono` / `.num`) for numbers and units only; words (names, machine names, statuses) in sans.
- **Empty states:** `.empty` block inside a `.card`: `.em-icon` (an icon in a soft accent tile), `.em-title`, `.em-text`, `.em-actions` with the primary action as `.btn-primary`.
- **Viewport** behind the bed/scene: class `.viewport`.

## 4. App bar (identical structure on Job, Simulation, Machines, Materials)

```html
<header class="appbar">
  <div class="brand">[Pathline icon svg, 28 px]<span class="word">Pathline</span></div>
  <nav aria-label="Sections" class="seg">
    <a href="MainDetailed.dc.html" aria-current="page">Job</a>
    <a href="SimulationDetailed.dc.html">Simulation</a>
  </nav>
  <span class="divider"></span>
  <div class="ctx">…page context…</div>
  <span class="spacer"></span>
  …page actions…
  <button class="ib theme-btn" onClick="{{toggleTheme}}" aria-label="Light or dark theme" title="Light or dark theme">
    <svg class="i when-light" viewBox="0 0 24 24" aria-hidden="true"><path d="{{themeIcons.moon}}"></path></svg>
    <svg class="i when-dark" viewBox="0 0 24 24" aria-hidden="true"><path d="{{themeIcons.sun}}"></path></svg>
  </button>
</header>
```
- `renderVals()` returns `toggleTheme: () => LRC.theme.toggle()` and `themeIcons: LRC.theme.icons`.
- The **Job | Simulation** switch is always second, right after the brand, on every page (on the Setup pages neither item is current). Keep `aria-label="Sections"` and the existing hrefs.
- Page context (`.ctx`): **Job** = the job-name button (rename) + the menu bar (File / Edit / Arrange / Setup / Help). **Simulation** = title "Simulation" (`.h-page`) + job name as `.lbl`, machine chips. **Setup pages** = the **Machines | Materials** `.seg` (keep its aria-label and hrefs) + the page title/count.
- Page actions (right): **Job** = machine box (a bordered button: `.badge`, name + sub, status `.pill`, chevron). **Simulation** = **Send to machine** as `.btn-primary` (36 px). **Setup** = Unsaved `.tag.warn` + Discard (`.tb`) + Save (`.btn-primary`).
- The Job page keeps its toolbar row under the app bar, as `.subbar` with `.grp` groups.

## 5. Dark mode

- Everything uses tokens, so dark mode is automatic once no hard-coded UI colours remain. Check every screen, popover, dialog and empty state in both themes.
- The bed, the sheet and anything drawn on them stay light (`--bed`). The viewport around them goes dark.
- Preferences dialog (Job page, Edit → Preferences…) gets a **Theme** choice: `{ key: 'theme', label: 'Theme', type: 'seg', value: LRC.theme.pref, options: [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], onChange: (v) => LRC.theme.set(v) }`. The app-bar button flips light/dark directly.

## 6. Check your work

```
npx electron tools/shoot-ui.js --page MainDetailed --theme both [--scenario empty] [--name x] [--step "js"]...
```
Writes `.shots/ui/<name>-light.png` and `-dark.png` and prints page errors. Open the PNGs and look. Use `--step` to open menus/dialogs (see `tools/shoot-design.js` for the step expressions for each dialog, e.g. `window.__page.sendDialog(false)`). Then confirm every `{{binding}}`, `sc-for`, `sc-if`, event attribute, `aria-label`, `role` and `title` that existed before still exists (diff against `_backup-before-rebrand-2026-10-28/src/ui/`).
