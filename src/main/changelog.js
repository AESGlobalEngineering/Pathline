// What changed in each release, newest first. Shown once after Pathline
// updates (the versions since the one last run) and from Help → What's new.
// Add an entry here with every version bump in package.json.
'use strict';

module.exports = [
  {
    version: '1.3.0', date: '29 Oct 2026',
    added: [
      'Overlapping lines are merged automatically: where parts share an edge, or a line is drawn twice, it is cut once (within one process).',
      'Fastest follows "Cut inside shapes first": Per part finishes each part before the next, All insides cuts every hole before any outline, Off cuts in whatever order is quickest.'
    ],
    fixed: ['Fastest could treat a part as sitting inside its own centred hole.']
  },
  {
    version: '1.2.9', date: '29 Oct 2026',
    added: ['Fastest cut order can engrave before or after cutting, part by part, but never inside a part that has already been cut out.'],
    fixed: []
  },
  {
    version: '1.2.8', date: '29 Oct 2026',
    added: [
      'Cut order is now By process, Fastest or Ordered. By process runs the processes in the order they are listed; Fastest runs them in whichever order is quickest; Ordered reads registration marks, then engraves, then cuts, one whole pass at a time.',
      'Reorder a material\'s processes by pressing and holding the ⋮ button, then dragging the row up or down.',
      'A machine whose HMI answers but whose controller is off shows Connected · machine offline.',
      'Adding a machine: Real or Simulated, Laser or Plotter. Only a simulated machine is named here.',
      'Removed hints from the machine header, the Add machine window and the Simulation page.'
    ],
    fixed: []
  },
  {
    version: '1.2.7', date: '29 Oct 2026',
    added: [
      'A simulated machine\'s controller is picked from the real types (Trotec, Ruida, Other).',
      'Engrave resolution is picked from 100, 300, 500 or 1000 DPI, in Materials and in the job\'s process settings.',
      'A new material starts with one cut (Cut contour) and one engrave (Engrave fill); a plotter material starts with one knife cut.',
      'Tidier machine header: test connection and refresh are icons (hover for their names) beside the latency and the last sync time.',
      'Only a simulated machine can be renamed; a real machine takes its name from its HMI.',
      '"Simulated, for testing" is now just "Simulated".',
      'Removed the Open HMI button.'
    ],
    fixed: []
  },
  {
    version: '1.2.6', date: '29 Oct 2026',
    added: [
      'Machine settings refresh by themselves: on first contact with a machine, every time Pathline opens, and every 5 minutes. Refresh from machine still works any time.',
      'A machine\'s name comes from its HMI as well (the name box shows it and is set on the HMI).'
    ],
    fixed: ['Turning on the thermal map in Simulation broke the page when the job had no material. It now asks you to pick a material.']
  },
  {
    version: '1.2.5', date: '29 Oct 2026',
    added: [
      'Pathline also checks for updates every 5 minutes while it\'s open, not only when it starts. An update you\'ve said Later to isn\'t offered again until the next start.',
      'After an update, Pathline shows what\'s new and what\'s fixed (this window). Help → What\'s new shows it any time.'
    ],
    fixed: []
  },
  {
    version: '1.2.4', date: '29 Oct 2026',
    added: ['Arrays can be edited: select any part of an array (the original or a copy) and choose Array to change its columns, rows or gaps. 1 × 1 removes the copies.'],
    fixed: ['Changing an array added a second set of copies on top of the first instead of replacing it.']
  },
  {
    version: '1.2.3', date: '29 Oct 2026',
    added: ['The checks warn when objects belong to a process whose output is off, and the Objects list marks them "not sent".'],
    fixed: ['Imported objects couldn\'t be selected or moved when their colour belonged to a process with output off (for example ACI 7, the plotter Pen).']
  },
  {
    version: '1.2.2', date: '29 Oct 2026',
    added: ['Report a bug asks where to save the report (one .zip with a screenshot and the job), then offers Report on GitHub: a filled-in issue for the Pathline developers.'],
    fixed: ['Importing several drawings at once could place some on top of others. Each now goes in free space; one that doesn\'t fit goes on the next plotter bed or beside the laser bed.']
  },
  {
    version: '1.2.1', date: '29 Oct 2026',
    added: [
      'Updates ask first: nothing downloads until you choose Download and install, the download shows a progress bar, and it installs only when you choose Restart and install.',
      'Simulated machines have a controller type (Trotec, Ruida or Other).'
    ],
    fixed: []
  },
  {
    version: '1.2.0', date: '29 Oct 2026',
    added: ['Simulated machines, for testing: Setup → Machines → Add machine → Simulated. No connection (jobs are saved as files); set the bed, speeds and features yourself.'],
    fixed: ['A new job with no material started with five built-in processes. It now starts with none.']
  },
  {
    version: '1.1.0', date: '29 Oct 2026',
    added: [
      'Nesting for lasers and plotters (Arrange → Nest parts): packs parts to use as little material as possible, turning them 90° where that fits better.',
      'Test grid in Materials uses your own range: low and high power and speed, and the number of divisions.',
      'Engrave direction (top down, bottom up or fastest) and one-way scanning, per process.',
      'Bug and crash reports, and Help → Check for updates. Pathline checks GitHub for new versions when it opens.',
      'New look: Path red, light and dark themes (Preferences), a grey bed in dark mode, and black (ACI 7) shown as white on it.'
    ],
    fixed: [
      'Registration marks inside a part couldn\'t be selected after ungrouping.',
      'The Simulation page now has the same zoom controls as the Job page.',
      'Removed: preset machines and materials, Power ratio, and Go to / Set origin.'
    ]
  }
];
