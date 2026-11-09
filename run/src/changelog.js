// What changed in each release, newest first. Shown once after Pathline Run
// updates (the versions since the one last run) and from ☰ → What's new.
// Add an entry here with every version bump in package.json.
'use strict';

module.exports = [
  {
    version: '0.7.11', date: '5 Nov 2026',
    added: [
      'Print and cut: a registration mark that isn\'t where the camera expects it no longer stops the job. Pathline Run opens Jog with the camera picture beside the arrows: jog until the mark is in the red circle and press Accept, and the camera finds its centre from there and reads the other marks itself. Stop job ends it.',
      'Anchor to toolhead starts on for a print and cut job and off for any other. A print and cut job puts its top-left registration mark at the head: put the laser head over that mark and press Start, and the camera finds the marks from there wherever the sheet lies. (It put the corner of the whole job there, which the cuts can reach past: on the X8 sheet every mark was looked for 22 mm away.) Switch it off to look for the marks where Pathline placed the job.',
      'Trotec: Setup → Controller → Travel between cuts. Most moves between cuts are a few mm, and how sharply the head starts and stops decides how long they take, not the travel speed. Standard is what Ruby sends; Faster (Ruby\'s own positioning jerk) takes about 4 % off a job of many small parts, Fastest about 10 %.'
    ],
    fixed: [
      'Trotec: time estimates match the machine. Pathline Prepare timed the moves between cuts at 2000 mm/s and 20000 mm/s², with no jerk limit, so a job estimated at 7 min 02 s took 9 min 26 s. Pathline Run now times them as the Trotec\'s path planner moves them (within 1–4 % of every job run since curves went in), shows that estimate, and tells Prepare the real travel speed and acceleration.',
      'Queue: the progress bar follows the cutting time. It had jumped to about half way, then sat at 100 % for minutes.',
      'Trotec: cutting is timed at each process\'s set speed (the planner holds it through corners and curves). Prepare\'s own cutting time ran about 15 % long, so the X8 sheet showed 10 min 37 s for 9 min 26 s; Pathline Run now estimates 9 min 21 s. The progress bar moves on with each part the laser reports finished.',
      'Queue: following a print and cut job. Once the marks are read the bed view shows the job where it was moved to, and follows the head along it. It had followed the job where Prepare placed it, about 150 mm away on the X8 sheet: no position fitted, so the head jumped between raw positions twice a second.',
      'Queue: the head drawn during a job is where the head is. It trailed by about 0.2 s (6–8 mm) all the time, and a job\'s first position, on the way to the first cut, could be placed 15 s on where the path passes close by.',
      'Queue: Remaining counts down a second at a time, kept within 2 s of the job\'s progress, instead of in uneven steps that stopped while a long part was cut.',
      'Queue: a job selected while its picture loaded could stop the page updating for a moment.',
      'Trotec: Prepare 1.6.0 and later are told the real travel acceleration and jerk, so their estimates and cut order follow Travel between cuts.',
      'Trotec: while the laser\'s buffer is full, a position check got the last position again, shown as if new: the head held still, then jumped. Repeated positions now keep their own time, and a refusal that still reports where the head is is used.',
      'Queue: following a running job is smoother. Trotec data goes in smaller packets (as Ruby sends them): the laser only answers a packet, with where the head is, once it has room for it, which with large packets could be a second or two. The screen also asks for the head\'s position four times a second while a job runs, and times the moves between cuts as the machine makes them.',
      '"Remove completed job from queue" off keeps completed jobs in the queue, marked Done. Start runs one again. Before, the switch had no effect.',
      'The registration marks found for a print and cut job no longer stay on the bed view after the job.',
      'Queue: Anchor to toolhead and Remove completed job from queue sit at the top, under the job\'s name, instead of below its processes.',
      'Anchor to toolhead takes the head\'s position when you press Start, not when the switch is turned on, so you can switch it on and then jog to the sheet. Frame shows where it will go from where the head is. It lasts for that run: a job run again, from the queue or from History, goes where Pathline placed it unless you switch it on again.',
      'Print and cut: the camera finds printed marks by itself again, also on clear acrylic in uneven light. It judged "dark" against nearly the whole picture (for a 6 mm mark), and wanted the white round a mark evenly lit; the Trotec\'s lamp lights it twice as bright on one side.',
      'Print and cut: marks found further apart or closer together than the job has them (by over 1 %) stop the job before anything is cut, saying which. A dot that wasn\'t the mark had stretched a job 6 % and it was cut off the print.',
      'Head camera: after its USB link dropped out ("couldn\'t start capturing", Vimba error -22) it failed every time until Pathline Run was restarted. It\'s now reset and tried again.',
      'A job with registration marks no longer says Pathline Run has no camera.',
      'Trotec: curves cut at speed. Rounded corners, circles and holes arrive from Prepare as many short straight segments, and the Trotec takes straight segments round a curve at about a third of the speed it allows an arc. Pathline Run now finds the stretches that lie on a circle and sends them as curves, the way Ruby does; straight sides and sharp corners are sent as before. The cut is also handed over in one piece instead of a segment at a time.'
    ]
  },
  {
    version: '0.7.10', date: '4 Nov 2026',
    fixed: [
      'A dialog\'s buttons always stay in sight at its bottom edge, however long it is. What\'s new after the update to 0.7.8 ran off the screen, and its Got it couldn\'t be reached.',
      'Trotec: a job the laser throws away itself (an FPGA error, then its buffers cleared) is stopped with the laser\'s reason, not recorded as done. One was marked done 3 s after it started without cutting anything.',
      'Queue: following a running job is smooth. The head is drawn from when the laser was really there (its position can be over a second old by the time it reaches the screen), the same position reported again no longer pulls it back, and it eases forward instead of jumping.'
    ]
  },
  {
    version: '0.7.9', date: '4 Nov 2026',
    fixed: [
      'Queue: a long list of processes (a test grid) can be scrolled. The screen redraws every 0.7 s and sent it back to the top; now every part that scrolls keeps its place (also the queue list and the Jog page).',
      'Queue: a running job is followed along its own paths. What\'s been cut and engraved is drawn over the job, and the head moves smoothly between the controller\'s reports, predicted at the pace the machine is really going. Before, the reported positions were joined with straight lines, which cut across the job.'
    ]
  },
  {
    version: '0.7.8', date: '4 Nov 2026',
    added: [
      'Material settings kept on the machine for Pathline Prepare 1.5.0: Prepare stores the settings it makes for this machine here (GET / PUT /api/v1/materials), so any computer running Prepare that connects gets them. Kept exactly as received, safe from a power cut while saving, and kept through restarts and updates. Setup → Materials shows them, read only.'
    ],
    fixed: [
      'Camera calibration still didn\'t recognise the 10 mm checkerboard: in the camera\'s full-size picture the paper\'s texture pulled each corner off into a white square, so none counted. Corners are now placed on a lightly smoothed copy, the same at any picture size. The bed checkerboard uses the same.',
      'Camera calibration (stage 1) now uses the camera where it is: put the 10 mm board under the camera, not the laser head. It needs no offset, so the camera isn\'t moved over the laser\'s spot first; the head still goes back where it was. The offset calibration and the checkerboard still start from the laser head.',
      'Camera calibration takes each picture at the exposure in use and at 3× and 9× it, and uses the corners from all three: the Trotec\'s light covers only part of the view, and corners in the shadow only show at a longer exposure.',
      'When a camera task gives up, its message is also written to ☰ → Diagnostics log.',
      'Head camera: after a picture that got stuck, the camera opens again by itself. It waits up to 10 s while the camera is still busy, and never takes pictures with a camera that didn\'t open (before: "Unexpected Undefined value"). A stuck picture now says which Vimba X call it was stuck in.',
      'Head camera: a camera that gets stuck (no pictures until it was unplugged) is reset by Pathline Run itself, with the camera\'s own DeviceReset, and the picture taken again: about 10 s, no unplugging.',
      'Head camera: always the whole sensor (2592 × 1944). A crop left on the camera by another program moved the picture\'s middle, and every position measured with it.',
      'Offset calibration (stage 2): the mark is three circles (r 1, 1.5, 2 mm) the Trotec cuts reliably (of the five tight ones only the outer one burnt), and the camera takes rings as one disc. If the mark isn\'t where the stored offset puts it, the camera looks where the offset with the other sign would put it (Ruby\'s offset is the other way round), and saves the one that finds it.',
      'Checkerboard, offset calibration and print and cut: where a picture doesn\'t show the corner or mark looked for, the same view is taken at 3× and then 9× the exposure. A checkerboard corner only counts where two black and two white squares really meet (a shadow\'s edge no longer does).',
      'Jog → Camera: the live picture is never taken while the head moves (the camera got stuck when pictures were taken during jogs); it waits for the head to stop, and shows the last picture while an arrow is held down.',
      'Head camera: the camera got stuck whenever a picture at a shorter exposure followed a long one (the stepped exposures on the checkerboard, auto exposure in the live picture). Pathline Run now waits as long as the last exposure before such a picture: 60 pictures in a row switching between 120 ms and 600 ms, none stuck (before: every switch down). Exposures are kept to 0.6 s at most, the camera\'s time to answer grows with the exposure, and a frame that doesn\'t come no longer leaves the camera busy.',
      'Trotec: cuts no longer slow down at every corner. The beam was switched off and on again round every segment, so the laser stopped at each one (curves are many short segments); now it\'s on for the whole cut. A test job\'s stream went from 10 270 commands to 4 663.',
      'Queue: a job shows only the processes it uses, not every process of its material.',
      'Queue: Select (several jobs back to back) is only offered for plotters / routers.'
    ]
  },
  {
    version: '0.7.7', date: '3 Nov 2026',
    fixed: [
      'Camera calibration (stage 1) didn\'t recognise the 10 mm checkerboard on the real camera. The camera sees under 3 squares across, so only 2 × 2 corners, and soft edges and shadows looked like extra corners. A corner now only counts where two black and two white squares really meet, and 2 × 2 corners are enough.'
    ]
  },
  {
    version: '0.7.6', date: '3 Nov 2026',
    fixed: [
      'Head camera: the camera process stopped at every picture ("The camera process stopped"), so the camera view and calibration couldn\'t get a picture. Pictures are now copied out of the camera\'s buffer in a way the installed app allows.',
      'Checkerboard and camera calibration pictures are looked at about 20 times faster, with the same results.'
    ],
    added: [
      'Updates: Pathline Run checks every minute (was every 5 minutes), and downloads only the parts of the installer that changed since the version it has.'
    ]
  },
  {
    version: '0.7.5', date: '3 Nov 2026',
    fixed: [
      'Head camera: the camera now works in a process of its own. A camera stuck in its USB driver can\'t hold up Pathline Run any more: it gives a message after a time limit, and the next picture starts the camera afresh.',
      'Head camera: only one USB transport is loaded, Vimba X\'s own (Ruby\'s VimbaUSBTL 1.4 only where Vimba X\'s is missing). With both loaded, the camera\'s driver could lock up.'
    ]
  },
  {
    version: '0.7.4', date: '2 Nov 2026',
    fixed: [
      'Head camera: Pathline Run froze ("stopped interacting with Windows") while the camera opened or took a picture. The camera now works in a thread of its own: the screen and the laser never wait on it, and a camera that stalls gives a message after a time limit instead.',
      'Camera calibration, the cut check and the checkerboard all start from where the laser head is, like an anchored job, and bring the head back there afterwards: put the laser head over the board or the scrap, not the camera.',
      'Trotec: a jog that doesn\'t move the head with the lid open now says so (the laser ignores moves while its lid is open) instead of doing nothing.',
      'Print and cut: a registration mark only counts with plain white round it, so dark artwork next to a dot can\'t be mistaken for a mark.'
    ]
  },
  {
    version: '0.7.3', date: '2 Nov 2026',
    added: [
      'Camera calibration in two stages (Setup → Camera). 1 · Camera: a small checkerboard (10 mm squares) under the camera, at any angle; its corners give the pixel size, independent of how accurately the machine moves, and how much the lens bends lines; a few mm of head movement gives which way the picture is turned. 2 · Offset (cut check): the laser cuts a small mark on scrap, the camera finds it and sets the offset, then checks it and says how far off it still is. Stage 2 waits for stage 1.'
    ]
  },
  {
    version: '0.7.2', date: '2 Nov 2026',
    added: [
      'Head camera: auto exposure (the default). It aims the brightest part of the view (the paper) at a set brightness, whatever the light does elsewhere, and keeps the exposure for the next picture. Setup → Camera shows the exposure in use; Fixed is still there.',
      'Checkerboard: choose the correction. Scale and squareness (the default, safe on a board that isn\'t flat), Smooth, or Every corner (a flat board). Corners a bump in the board moved are found and left out (shown hollow), and the board\'s misfit is reported.'
    ],
    fixed: [
      'Registration marks and checkerboard corners are found in uneven light: each mark is judged against the paper round it (with the light\'s slope taken out), and the board\'s picture is evened out before looking for corners.',
      'The bed map is anchored at home and to the X axis, so it can\'t move jobs as a whole; it now covers the whole bed, beyond the board too. X / Y travel are reported as the machine\'s own error (+ = goes further than told), squareness as how far Y leans.'
    ]
  },
  {
    version: '0.7.1', date: '2 Nov 2026',
    fixed: [
      'Head camera: opens the Alvium when Vimba X lists it more than once, and never one of Vimba X\'s own camera simulators.',
      'Head camera: on a USB 2 link every frame arrived incomplete; the camera now streams at what the link carries (it says so in the log). A USB 3 port and cable are faster.',
      'Head camera: default exposure 100 ms (20 ms was nearly black with the light off).'
    ]
  },
  {
    version: '0.7.0', date: '2 Nov 2026',
    added: [
      'Trotec head camera (Allied Vision Alvium, through Vimba X): Setup → Camera, and a live picture on the Jog page with "Camera to the laser\'s spot" and "Laser to the crosshair".',
      'Print and cut: jobs with registration marks have them read by the camera (re-centring on each, predicting the next), then are moved onto them: shift + rotation, affine or a triangle map, as Pathline asks. The marks found show on the bed view.',
      'Camera calibration: pixel size and rotation from any dot under the camera; the camera offset from a small mark the laser makes on scrap.',
      'Checkerboard (50 mm squares, laid anywhere at any angle): Calibrate bed measures the machine\'s accuracy across the bed and saves a bed map used for every job; Check bed measures again with it on. Shows the worst error, X/Y length and squareness, with an arrow for each corner.'
    ]
  },
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
