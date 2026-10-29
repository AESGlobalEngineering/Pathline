# Laser & Router Control — design app (UI prototype)

Open `index.html` in a browser to start on the job workspace.

| File | Page |
|---|---|
| `MainDetailed.dc.html` | Job workspace (main page) |
| `MaterialsDetailed.dc.html` | Material library |
| `MachineSetupDetailed.dc.html` | Machine connections (IP address; other settings come from the HMI) |
| `SimulationDetailed.dc.html` | Toolpath simulation |
| `support.js` | Runtime that renders the pages — keep it next to them |

"Send to machine" and "Open HMI" link to `../HMI/HMI.dc.html`, so keep this folder beside the `HMI` folder.

Fonts load from Google Fonts, so an internet connection gives the intended typography. This is a clickable UI prototype: no machine communication or real file handling beyond the "Save to computer" download.
