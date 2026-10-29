// What changed in each release, newest first. Shown once after Pathline Run
// updates (the versions since the one last run) and from ☰ → What's new.
// Add an entry here with every version bump in package.json.
'use strict';

module.exports = [
  {
    version: '0.4.1', date: '29 Oct 2026',
    added: ['The Trotec\'s USB port is found automatically: Setup → Serial port → Automatic (the default) looks for the Trotec controller (USB id 1CBE:0002) each time it connects. The ports it finds are listed too, with the Trotec marked.'],
    fixed: ['When the port is in use, the message says by what (for example Trotec JobDispatcher, part of Ruby) instead of "Access denied".']
  },
  {
    version: '0.4.0', date: '29 Oct 2026',
    added: [
      'No ready-made machine any more: Pathline Run opens on Setup → Add a machine until you\'ve added yours (name, Trotec or Ruida, how it\'s connected, bed size). Until then Pathline is told that no machine is set up.',
      '☰ → Remove machine… forgets the machine\'s setup, after two "are you sure" checks. Queued jobs and history stay.'
    ],
    fixed: ['The "Idle" label on the Queue page is gone. Machine status is shown top right.', 'After saving the setup, the form showed the old values as "Unsaved changes".']
  },
  {
    version: '0.3.4', date: '29 Oct 2026',
    added: [
      'The machine\'s status is shown top right, by the machine name: green connected, blue processing, red not connected, orange for a warning or error (flagged with a warning sign).',
      'Tap the machine name for its status and connection details: controller, connection, model, firmware, head position, the address Pathline connects to, and Reconnect or Clear error when needed.'
    ],
    fixed: ['The Queue page no longer shows connection errors, "Device not connected", or the Save stream and Code listing buttons.']
  },
  {
    version: '0.3.3', date: '29 Oct 2026',
    added: ['Anchor to toolhead is a switch, like "Remove completed job from queue". On: the job starts at the head\'s position when you switched it on. Off: back where Pathline placed it.'],
    fixed: [
      'With the laser unplugged, the Diagnostics log filled with the same connection error every 10 seconds. It\'s now logged once.',
      'The toolhead circle on the Queue preview always shows in full, also at the edges and corners of the bed. When the position isn\'t known (laser not connected), no circle is drawn.'
    ]
  },
  {
    version: '0.3.2', date: '29 Oct 2026',
    added: ['Update checks (when Pathline Run opens and every 5 minutes) are written to ☰ → Diagnostics log.'],
    fixed: ['When no update information is found, Check for updates says where it looked, instead of "no releases published yet".']
  },
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
