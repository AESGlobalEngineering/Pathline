// What changed in each release, newest first. Shown once after Pathline Run
// updates (the versions since the one last run) and from ☰ → What's new.
// Add an entry here with every version bump in package.json.
'use strict';

module.exports = [
  {
    version: '0.6.3', date: '2 Nov 2026',
    added: ['Queue → Select (replaces Run all): tick the jobs you want, then Start runs them one after another, in queue order. Stopping, or a job that doesn\'t complete, ends the run.'],
    fixed: ['Start runs the job selected in the queue.']
  },
  {
    version: '0.6.2', date: '2 Nov 2026',
    added: [
      'Queue → Run all: when a job completes, the next one in the queue starts by itself (it stops at a job that is stopped or can\'t start).',
      'Setup fills in the work area, max speed, acceleration and conveyor speed from the controller each time it connects. Type over any of them to use your own value; Reset puts the controller\'s back.'
    ],
    fixed: [
      'RDD6584: the head parked at home reads 0, 0. Home is where the head homes and parks: Pathline Run learns it after Home and after each job and keeps it (the controller address it used read Y 1404 mm).',
      'RDD6584: framing goes round the job only (it ran the whole length of Y), then back to where the head started.'
    ]
  },
  {
    version: '0.6.1', date: '2 Nov 2026',
    fixed: [
      'RDD6584: "frame slop" on the controller. Home is 0, 0: jobs go in measured from home, as the controller expects (0.5.9 took home off again, which put parts of jobs past home).',
      'RDD6584: positions, X/Y readouts and jogging are measured from home too, so the bed view shows where the head really is relative to the job.'
    ]
  },
  {
    version: '0.6.0', date: '2 Nov 2026',
    added: [
      'RDD6584: each Pathline process runs with its own tool, taken from its name (or Setup → Tools): knife, pen or punch. One layer per process, in Pathline\'s order, with the tool changes the controller expects.',
      'Pen paths are drawn in one go; punch processes punch a hole every 5 mm along a line, or one hole in the middle of a small closed shape (10 mm or less).'
    ],
    fixed: ['RDD6584: the Conveyor button no longer starts the knife: its feed-only job uses the pen.']
  },
  {
    version: '0.5.9', date: '2 Nov 2026',
    fixed: [
      'RDD6584 jobs no longer land offset by the origin set on the machine\'s panel: the controller runs a job relative to that origin, so Pathline Run reads it before each job and allows for it. The Diagnostics log shows the origin it read.'
    ]
  },
  {
    version: '0.5.8', date: '2 Nov 2026',
    fixed: [
      'RDD6584 jobs land where they are on Pathline\'s bed: the machine counts from its top right corner (Setup → origin), and jobs now do too. A shape at the top right was cut at the top middle.',
      'X and Y readouts (Jog page, toolhead, machine panel) show the machine\'s own coordinates, as its panel does.'
    ]
  },
  {
    version: '0.5.7', date: '2 Nov 2026',
    added: [
      'RDD6584 knife controllers: jobs in the knife\'s own format, as VCutWorks sends them. Each bed is uploaded to the controller as a file (START, replacing the last one) and started; every cut carries the knife\'s angle, and the knife lifts and turns at sharp corners.',
      'RDD6584: jobs over several beds feed between beds. The controller does the feed itself (clamps and pulls along Y), and runs its vacuum zones as it does for VCutWorks.',
      'RDD6584: the Conveyor button runs a job with no cuts and one feed.'
    ]
  },
  {
    version: '0.5.6', date: '2 Nov 2026',
    added: ['Jog page: the conveyor button is called Conveyor.'],
    fixed: [
      'RDD6584: holding a jog arrow is one smooth move at the chosen speed, stopped when you let go (it moved a step, slowed to a stop, then the next step).',
      'Home works again on RDD6584 controllers.',
      'Go to 0, 0 removed from the Jog page.'
    ]
  },
  {
    version: '0.5.5', date: '2 Nov 2026',
    fixed: [
      'RDD6584 knife controllers: jogging no longer runs away. These controllers move BY the distance in a move command, not TO it (found by recording VCutWorks): Pathline Run now sends a speed, then the distance to go, as VCutWorks does. Go to 0, 0, Frame and Feed work the same way.',
      'RDD6584: Home asks you to use the machine\'s panel, until its home command is known.'
    ]
  },
  {
    version: '0.5.4', date: '2 Nov 2026',
    fixed: [
      'Ruida: moves by hand (jog, go to 0, 0, frame) use the one-axis move commands. The two-axis command isn\'t the same on every controller: on an RDD6584 knife controller one jog ran on for seconds, with the controller deaf to Pathline Run and its own panel.'
    ]
  },
  {
    version: '0.5.3', date: '2 Nov 2026',
    added: [
      'Pathline Run always fits the window: the bed view takes the space that\'s left, and the Start/Stop bar is always on screen.',
      'Bed view: zoom with the wheel, a pinch or the + / − buttons, drag to pan, Fit (or double-click) to see the whole bed again.'
    ],
    fixed: [
      'Jogging: letting go of an arrow stops the head (Ruida finished its last move at full travel speed). Pressing another arrow stops first, then goes the new way.',
      'Jogging with the head outside the bed set in Setup no longer sends it across to the bed edge, whichever arrow was pressed. The Jog page says when the head is outside the bed.',
      'A job with nothing to cut (its drawing on a colour no process uses) is refused with the reason, instead of "completing" at once without moving.'
    ]
  },
  {
    version: '0.5.2', date: '2 Nov 2026',
    added: ['Setup → Machine → Find on network (Ruida): lists the Ruida controllers that answer, with their IP address and card ID. Tap Use to fill it in.'],
    fixed: [
      'Ruida controllers only answer on UDP port 40200: Pathline Run no longer falls back to another port (it never got a reply). If LightBurn, RDWorks or RDCutting holds the port, it says so.',
      'Read from controller works while the machine is connected (it shares the connection instead of opening a second one).',
      'RDD6584 knife controllers (card 0x6910) use swizzle magic 0xA1.',
      'Settings the controller doesn\'t have no longer show as huge numbers in Read from controller.'
    ]
  },
  {
    version: '0.5.1', date: '29 Oct 2026',
    added: [
      'Setup → Read from controller (Ruida): reads the controller\'s own settings (work area, speeds, acceleration, conveyor axis, outputs, card ID) and fills them in for you to check. Works while adding a machine too.',
      'Setup → Tools: as many tools as the plotter has (1 to 4). Remove one with ×, or Add tool.'
    ],
    fixed: ['Switches on the Setup page (for example Conveyor and Vacuum) didn\'t change when tapped.']
  },
  {
    version: '0.5.0', date: '29 Oct 2026',
    added: [
      'Ruida: choosing Ruida shows a Controller model list: laser controllers (RDC6442G/S, 6445, 6332, 634x, 654x, RDLC320/220, RDL9635) and plotters and cutters. The model sets laser or plotter and the swizzle magic.',
      'Ruida: the swizzle magic is worked out from the controller\'s first reply, so a wrong model choice still connects. Setup shows the controller\'s card ID and magic.',
      'Ruida plotters: Pathline\'s plotter jobs run with each tool on a controller output (Setup → Tools: T1–T4 → outputs 1–4), tool down/up times, perforation, and the conveyor fed between beds on the U axis. The Jog page has Feed one bed. Pathline sees the machine as a plotter.'
    ],
    fixed: []
  },
  {
    version: '0.4.3', date: '29 Oct 2026',
    added: [
      'Jog page: hold an arrow to keep moving. 0.1, 1, 10 and 100 are the step in mm for a tap, and the speed in mm/s while held. The head stops when you let go, at the edge of the bed, or by itself if the screen stops answering.',
      'The head can be jogged, homed and sent to 0, 0 with the lid open (the beam is always off for these). Start, Frame and test fire still need the lid closed.'
    ],
    fixed: ['The "Ready" label on the Queue page is gone too.']
  },
  {
    version: '0.4.2', date: '29 Oct 2026',
    added: [],
    fixed: [
      'Trotec: jogs and jobs were refused with "invalid id". Every packet now carries a data section, as Ruby\'s do, so the packet numbering stays in step with the laser. If the laser still refuses a number, the numbering is started again and the packet is resent.',
      'Trotec: Pathline Run hands the laser back properly when it disconnects or closes, so reconnecting takes about a second.',
      'A failed connection attempt kept the port open, so the next attempt said "Access denied".'
    ]
  },
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
