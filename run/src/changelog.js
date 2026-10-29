// What changed in each release, newest first. Shown once after Pathline Run
// updates (the versions since the one last run) and from ☰ → What's new.
// Add an entry here with every version bump in package.json.
'use strict';

module.exports = [
  {
    version: '0.3.1', date: '29 Oct 2026',
    added: [
      'Anchor to toolhead moved under "Remove completed job from queue".',
      'The progress bar shows the percentage complete at its end.'
    ],
    fixed: []
  },
  {
    version: '0.3.0', date: '29 Oct 2026',
    added: [
      'Setup → Network shows the IP address Pathline connects to, and sets this computer\'s address: automatic (DHCP) or a static IP, subnet mask and gateway.',
      'Anchor to toolhead (Queue page): moves the selected job so its top-left corner starts where the head is now. Clear anchor puts it back where Pathline placed it.',
      'The Queue preview shows the toolhead live: its position on the bed, X and Y, and while a job runs, the path it has travelled.',
      'Light and dark mode moved into the ☰ menu.'
    ],
    fixed: []
  },
  {
    version: '0.2.0', date: '29 Oct 2026',
    added: [
      'Pathline Run installs like Pathline: Pathline-Run-Setup.exe on Windows (Start menu and desktop shortcut), or a portable exe. On a Raspberry Pi it\'s one AppImage, opened full screen at login.',
      'Updates work as in Pathline: a check when it opens and every 5 minutes, then it asks first. The download shows its progress, and Restart and install finishes it. It never restarts during a job.',
      'After an update, Pathline Run shows what\'s new (this window). ☰ → What\'s new shows it any time.'
    ],
    fixed: []
  },
  {
    version: '0.1.0', date: '29 Oct 2026',
    added: [
      'First release: receives jobs from Pathline, converts them for Trotec (USB) or Ruida (Ethernet) controllers, and runs them.',
      'Queue, Jog, History and Setup pages, with a simulated controller for testing.'
    ],
    fixed: []
  }
];
