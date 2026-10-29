// What changed in each release, newest first. Shown once after Pathline
// updates (the versions since the one last run) and from Help → What's new.
// Add an entry here with every version bump in package.json.
'use strict';

module.exports = [
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
