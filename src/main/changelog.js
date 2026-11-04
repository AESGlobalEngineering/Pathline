// What changed in each release, newest first. Shown once after Pathline
// updates (the versions since the one last run) and from Help → What's new.
// Add an entry here with every version bump in package.json.
'use strict';

module.exports = [
  {
    version: '1.5.5', date: '4 Nov 2026',
    added: [],
    fixed: ['Closed cuts start 0.3 mm from the corner (was 1 mm).']
  },
  {
    version: '1.5.4', date: '4 Nov 2026',
    added: [],
    fixed: [
      'Corners of squares melted whatever the power correction: a closed cut always started and finished on one of its corners, so that corner was cut twice from a standstill. Closed cuts now start 1 mm along a straight edge from the nearest corner (or on a curve), still on the side nearest the travel path; only a shape too small for that starts on a corner.'
    ]
  },
  {
    version: '1.5.3', date: '4 Nov 2026',
    added: [],
    fixed: [
      'A job that started as a test grid with 2 or more passes kept running the whole job that many times after its contents were replaced, with nothing on screen to say so. A job set to run more than once now shows it in the checks (click to open Job settings) and in the summary under the time.'
    ]
  },
  {
    version: '1.5.2', date: '4 Nov 2026',
    added: [
      'A test grid job with more than one pass now runs the whole grid, then the whole grid again (it used to do each square\'s passes back to back). The labels are engraved once.',
      'Job settings → Run the whole job ×N: repeats the whole job, all of it once before any of it again. The Simulation shows which round it\'s on.'
    ],
    fixed: []
  },
  {
    version: '1.5.1', date: '4 Nov 2026',
    added: [
      'Test grid: choose what it tests. Power × speed as before; Power correction × speed (how much the laser turns the power down where the head slows: the start of a cut, corners, the end; too little melts the start point); Frequency × power (cuts). Each square is a process with those two settings, the rest as the process has them, and Send sets just those two.'
    ],
    fixed: []
  },
  {
    version: '1.5.0', date: '4 Nov 2026',
    added: [
      'Material settings are kept on the machine (needs Pathline Run with material storage). Saving the library sends each machine its settings; connecting to a machine brings in newer settings and materials made on another computer. Deleted materials stay deleted.',
      'Test grid: Create job (was Engrave grid). Send puts the chosen square\'s settings into the process you pick from the list.'
    ],
    fixed: []
  },
  {
    version: '1.4.0', date: '3 Nov 2026',
    added: [
      'Pathline is now Pathline Prepare. Your machines, materials and settings come across by themselves.',
      'Processes have a drag handle (⠿): drag a process up or down, in Materials and on the Job page. (Holding ⋮ in Materials still works.)',
      'Test grid: set how many passes. Apply sets the passes as well as power and speed.',
      'New material group: Foam.',
      'Thermal map: choose the material right in the Simulation (it doesn\'t change the job\'s processes).',
      'Adding a real machine just asks for its IP address: the type, name and controller come from the machine.'
    ],
    fixed: []
  },
  {
    version: '1.3.2', date: '2 Nov 2026',
    added: ['Fill copies can be nested: Layout → Nested packs the copies, turning them 90° where that fits more than a straight grid. Grid is still there.'],
    fixed: []
  },
  {
    version: '1.3.1', date: '2 Nov 2026',
    added: [
      'Nest and Fill are one tool: Nest & fill in the toolbar (and Arrange → Nest & fill). Choose Nest parts or Fill copies; both use the same area, spacing and margin.',
      'Adding a real machine asks it whether it is a laser or a plotter, and takes its name from it. If it can\'t be reached, you choose the type.'
    ],
    fixed: []
  },
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
