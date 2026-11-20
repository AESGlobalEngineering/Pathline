// What changed in each release, newest first. Shown once after Pathline Run
// updates (the versions since the one last run) and from ☰ → What's new.
// Add an entry here with every version bump in package.json.
'use strict';

module.exports = [
  {
    version: '0.7.23', date: '20 Nov 2026',
    added: [
      'Pathline Prepare can send jobs to this machine from anywhere, through Pathline Monitor (Pathline Monitor 0.7 and Pathline Prepare 1.6.21 or newer). The computer signs in to Pathline Monitor with the workshop password and a code from an authenticator app. It can queue, reorder and remove jobs, read the machine and swap the materials list. It can\'t start a job, move the head, frame or switch outputs: a job sent this way waits in the queue for Start here. Pathline Run checks every call itself.',
      'The queue says where each job sent this way came from: From OFFICE-PC via Pathline Monitor. The diagnostics log has each job received this way and each call refused.',
      'Setup → Pathline Monitor: a switch, Let Pathline Prepare send jobs through Pathline Monitor. On unless turned off, and only changed on the machine\'s own screen.'
    ]
  },
  {
    version: '0.7.22', date: '20 Nov 2026',
    fixed: [
      'Part edges: each printed corner is read to within 10 µm, the same every time. Tested on the Q500 with J0115 (clear acrylic, four corners with 10 mm roundings), nothing cut. The old corner finder fitted each straight edge on its own, from the few mm showing past the rounding, and carried the two 10 mm to where they meet. Three pictures from the same place gave corners up to 0.45 mm apart, and moving the camera 2–3 mm moved them up to 0.9 mm. Now the whole outline is fitted: both straight edges and the rounding together.',
      'Part edges: the camera\'s scale on the print is no longer an error. The print isn\'t at the height the camera was calibrated at (printed under the clear sheet, or the table not focused on it). On J0115 the camera measured 1–7 % short, different at each corner, and a corner read 10 mm from the middle of the picture was pulled up to 0.5 mm into the part. Each corner is now read with it in the middle of the picture, where the scale can\'t move it; how far off the scale was shows in the log as the rounding read (9.2–10.2 mm for 10).',
      'Part edges: a corner well away from where it should be is found anyway, and the camera is aimed again on it. On J0115 the first corner was 12 mm from the laser, and the old finder took the white card\'s edge for the print, or asked for the camera to be jogged by hand.',
      'Part edges: the corners\' edge turn is held at what all the job\'s corners agree on, as a few mm of straight edge give it only to a degree. J0115 read three times from head positions up to 5 mm apart: the same four corners within 4–10 µm each time, the sheet turned −0.39°, its width as the job\'s within 0.05 mm/m.'
    ]
  },
  {
    version: '0.7.21', date: '20 Nov 2026',
    added: [
      'Pathline Monitor can ask this machine for a day\'s diagnostics log, a job\'s drawings, the camera\'s pictures of its marks, its run records, the head drawing fit and bed maps, its settings or its health (temperature, and a Raspberry Pi\'s power warnings), when someone at the company needs them (Pathline Monitor 0.6 or newer, with its pull token). Pathline Run reads what\'s asked and sends just that, over its own outgoing connection; Monitor passes it on and keeps nothing. An ask can only ever make Pathline Run read one of those things: it can\'t change a setting, or touch the machine or a job, and a running job is never held up. Each ask is in the diagnostics log.',
      'Setup → Pathline Monitor: a switch, Let Pathline Monitor ask for logs, drawings and camera pictures. On unless turned off, and only changed on the machine\'s own screen. The settings sent never include the Monitor key.'
    ]
  },
  {
    version: '0.7.20', date: '20 Nov 2026',
    added: [
      'Raspberry Pi: a Pi can be a Pathline Run station and nothing else. Switched on, it goes straight into Pathline Run full screen (no desktop, no login), starts it again by itself if it ever stops, keeps the screen on, and is safe to switch off at the wall. One setup line on a fresh Raspberry Pi OS Lite (64-bit) does it all: run/deploy/pi/README.md. Raspberry Pi\'s 10" Touch Display 2 is found by itself and Pathline Run is shown 1.5 times bigger on it (its own 1280×800 layout); it can be turned on its side.',
      'Touch screen without a keyboard (the Pi): Pathline Run brings its own on-screen keyboard. It comes up when a field is tapped, with a number pad for numbers, and goes when the field is left or Hide is tapped; Enter saves as it does on a real keyboard. A real keyboard\'s first key puts it away. The mouse pointer hides while fingers are used.',
      'If the screen\'s page ever crashes (out of memory on a small Pi), it comes back by itself a second later; a running job carries on underneath.'
    ],
    fixed: [
      'Settings, the queue and history, the head drawing\'s fit and the other saved files are written whole or not at all: a power cut while one was being saved could leave it half written, and Pathline Run then started with no machine set up or an empty queue.'
    ]
  },
  {
    version: '0.7.19', date: '20 Nov 2026',
    fixed: [
      'Trotec estimate: engraving is timed line by line as the Q500 was measured doing it, the same way the Queue draws the head: each line\'s turn is shorter on wide islands and longer on narrow ones, and the step to the next line takes longer at coarse pitches (5.4 ms a line at 1000 DPI, 24.5 ms at 100 DPI). On the 65 engraved islands of the 8 engraving jobs run, each job timed from the others: 3.3 % off an island (was 9.1 %) and each job within −0.3 … +1.4 % (was −3.9 … +2.8 %). J0106\'s 107 mm wide island had run 7 s long in 349. Whole jobs over the last 21 run: 2.7 % off (was 3.1 %).'
    ]
  },
  {
    version: '0.7.18', date: '19 Nov 2026',
    fixed: [
      'Queue: the head drawn during an engraving is where the head is. It was drawn on the right line but 8–21 mm along it from the real head (median, Ruby\'s engraving jobs), and 13.9 mm off over all of them; now 2.9 mm. The screen now draws every line the laser is sent, blank lines skipped as the laser skips them, each swept at the engraving speed with the head slowing for the turn at each end (it drew at most 200 lines spread over the island at an even pace). Each line\'s time was measured from the jobs run: 82.8 ms more than its sweep at 500 mm/s, more for narrow islands and coarse pitches (5.4 ms at 1000 DPI, 24.5 ms at 100 DPI), within 0.9 ms a line on jobs left out of the measuring.',
      'Queue: the head drawn picks the right line. At 1000 DPI the lines are 0.024 mm apart, closer than the laser\'s position steps, so a report alone can\'t tell which line the head is on or which way it\'s going, and the nearest line sent the drawing back across the island half the time. Of places that fit a report about as well, the one nearest where the drawing has the head by then now wins. On cuts this halves the times the head is drawn more than 10 mm off (8 % → 4 %).',
      'Queue: the head drawn learns how fast each shape of part really goes in the job, from the parts already cut. On the X jobs the 3.5 mm holes took 0.6 s and the drawing allowed 1.0 s, so it fell behind at every hole; J0113\'s slots took the drawing\'s own time. Cutting is now drawn 2.0 mm from the real head (median, was 2.35) and within 5.7 mm 9 times in 10 (was 8.0).',
      'Queue: the head was drawn a steady ~10 ms behind (5 mm at the engraving speed): each new report was eased in from where the head was drawn the frame before, the frame\'s own move counted as a gap to close.',
      'The head drawing\'s fit (after each job) replays the screen as it is now, with the head\'s position four times a second (was every 0.7 s), and measures the drawing at each report\'s own time, not up to a frame (33 ms) later. Measured a frame late, a drawing running slightly behind looked closer, so the fit preferred a slower route and a later stamp. Over every job run so far the head is drawn 2.15 mm from the reports (median, was 3.15) and within 9.0 mm 9 times in 10 (was 24.0).',
      'Queue: the engraved and cut parts drawn over the job stay small: an island\'s lines are drawn one every 0.1 mm, and a cut\'s segments joined (J0113\'s whole job: 0.49 MB, was 0.95 MB, rebuilt at every part).'
    ]
  },
  {
    version: '0.7.17', date: '19 Nov 2026',
    added: [
      'Part edges: the print\'s own edge is read, not its shadow. On clear acrylic the print casts a soft shadow on the card underneath, just outside its edge, and the corner finder took the outermost edge it saw: J0112\'s corners were read 0.1–1 mm outside the parts, and the job was cut about 1 mm low at the bottom. Now each edge close to another is told apart, and the sharpest is taken (the print is in focus on the top surface; the shadow 3 mm below is soft). How sharp each corner\'s edges were is logged.',
      'The camera\'s pictures of the marks are kept for the last 5 jobs (data\\marks\\<job>), not only the last one, so a job that went wrong can still be looked into after the next has run.'
    ]
  },
  {
    version: '0.7.16', date: '19 Nov 2026',
    added: [
      'Print and cut by Part edges (Pathline Prepare 1.6.19): a printed sheet without registration marks is lined up from the printed corners of the parts at its corners, on their own cut lines. The camera finds the edge of the print, dark on light or light on dark, from the longest straight runs along the expected directions, so the bed\'s honeycomb through clear acrylic and the artwork\'s own edges don\'t count. With three or four corners the job is fitted like marks, stretch included (Full linear); with two, moved, turned and scaled. Each corner\'s part and radius are logged, and with four corners how far the worst lies from the fit. When one isn\'t found, the jog dialog asks for the printed corner of the part at the top left (and so on). For a clean read, print a sharp edge on those parts with no bleed past it, and put white card under them on clear material.',
      'Corners (plates and parts): after the first, the next is looked for where the first corner\'s edges say the sheet is turned, not only moved. A sheet turned 0.5° put the corner diagonally across it 13 mm from where the camera looked.'
    ]
  },
  {
    version: '0.7.15', date: '19 Nov 2026',
    added: [
      'Ruida uploads are quicker. The controller\'s list of files is kept after the first look, so later uploads read one file name (or none) instead of every file\'s name again, which slowed down as Send to machine filled its memory; the whole list is read again only when files were added or deleted on the panel. A file name that doesn\'t come back costs 1.5 s, not 4. The job\'s name and end go in the same packets as the job itself.',
      'Frame ends at its last corner, the job\'s top right, and the head stays there. It went back to where it started, which on the router after a job is home, the machine\'s origin.',
      'While a knife job goes into the controller, the screen shows how far it has got ("Sending … to the controller · 40 %"), for Start and Send to machine. Each upload is logged with its size, packets and time: looking for the old file, sending and checking.'
    ]
  },
  {
    version: '0.7.14', date: '19 Nov 2026',
    added: [
      'Punching on plotters and routers (Pathline Prepare 1.6.18): a process set to Punch strikes once at each point Prepare sends, with the tool up in between (spaced along a line, or one at a shape\'s centre). The queue preview shows each strike as a ring. Lasers refuse punch jobs.',
      'Frame always goes the same way round: from the job\'s top right corner down, left, up and right, then back to where the head was when Frame was pressed (read from the machine then). It runs at the speed Pathline Prepare sends, capped at the machine\'s own speed, instead of a slow 100 mm/s on knife plotters. On RDD6584 knife controllers framing now sends the plain move VCutWorks uses: it sent the laser\'s "with red light" move, which the YC-1610 didn\'t follow as expected.',
      'Ruida: Send to machine, beside Start. Start runs the job now; Send to machine stores it in the controller\'s memory under its number (J0111; one file per bed, J0111A, J0111B …, for jobs that feed), not started, to run later from the machine\'s panel, as RDWorks\' Download does. Sending it again replaces it; the controller\'s other files are left alone. Dwells between passes are left out, and jobs with registration marks need Start.',
      'Pathline Prepare is told the machine\'s origin corner: a Ruida\'s from Setup → Controller → Machine origin (top right on a YC-1610), the Trotec\'s top left. Prepare draws its origin dot there and times travel from it; it was always told top left.',
      'Ruida: the controller\'s own work area is read when Pathline Run connects (in the Diagnostics log). A job or frame that reaches past it is refused with where and by how much, instead of being sent: the controller ignores moves and jobs past its area without a word (on the router, two jobs reaching Y 1571 mm on the 1600 mm bed never moved, and Frame didn\'t trace them). Frame also stops, goes back and says so when the head doesn\'t reach a corner.',
      'RDD6584: a bed that should take a while but ends with the head never having moved is reported as not run, not Completed. A job was kept as Completed after 13 s with nothing cut, and home was then learnt from wherever the head stood.',
      'Ruida uploads: a file name the controller doesn\'t answer for while looking for the old START is skipped, instead of stopping the job, and the check that the job arrived asks twice.'
    ]
  },
  {
    version: '0.7.13', date: '18 Nov 2026',
    added: [
      'Registration marks that aren\'t printed. A hole cut through a steel plate, with white card or paper under it, is found as a light disc in the darker steel (or a dark one where the steel shines brighter). Marks drawn as ordinary dots are looked for as holes too when no printed dot is there, so this works with jobs from today\'s Pathline Prepare. A plate\'s own corner, lying on a white background, is found from the two straight edges that meet there. The job is then only moved and turned, never stretched, and one corner is enough because its edges give the turn. Corners need a Pathline Prepare that sends them. When one isn\'t found, the jog dialog says to put the camera over the plate\'s corner. Rounded corners (Pathline Prepare 1.6.16 sends the radius) are found where the plate\'s straight edges would meet: the camera looks from a little inside the plate, and each edge is fitted only clear of the rounding. If the radius is too big for the camera to see 3 mm of straight edge past it, the jog dialog says so.',
      'Print and cut with engraving checks how far the sheet lies turned from the job as drawn, from its registration marks. The engraving lines always run along the machine\'s X, so a turned sheet gets its lines at that angle across the parts. Up to 5° runs as before. Between 5° and 10° the job waits, beam off, and asks: Continue runs it as it lies, Stop leaves it uncut. More than 10° stops before anything is cut and says to turn the sheet back. Jobs that only cut aren\'t asked.',
      'Trotec engraving times as Ruby really engraves: each line across the island and its overscan at the set speed, a turn of about 0.1 s at each end, and 0.2 s per island, fitted on the calibration bars and two 500 DPI stainless jobs. Those two jobs had been estimated 5–6 % long; they now come out −0.6 % and +0.9 %. The screen draws the head through each island in that time. The estimate\'s fit now works each past job out again with the current model, placed where it was cut, so it doesn\'t pull the scale back towards the old model.',
      'Setup → Pathline Monitor: this machine reports to the workshop\'s Pathline Monitor server (0.5 or later), so phones see its progress, queue and alerts from anywhere, not only on the workshop Wi-Fi. In the Monitor app, Settings → Add a machine gives the address and a code; type them here and Connect. Run then sends its status over https, straight away when something changes, every 5 s while a job runs and every 10 s otherwise, and the panel shows when it last sent or since when it can\'t reach the server. It\'s one way: Run reads back only its key and whether each report arrived, never instructions, and reporting runs apart from the machine, so a lost internet connection never touches a job. A machine removed in the app says so and stops. Once connected, ☰ → Pathline Monitor on a phone shows the server as a QR code.',
      'Queue: change a job\'s power and speed on the machine before it runs. Edit on any of a queued job\'s processes, type the power and speed, then Save (or Enter). The estimate follows, and a changed process shows its new setting in the accent colour with what Pathline sent under it ("was 90 % · 20 mm/s"). Set it back and the mark goes. Not while the job runs. The change is on this machine only: Pathline Prepare keeps the job as it sent it.',
      'Automatic power and speed from a test grid (Setup → Camera). Once a power × speed test grid from Pathline Prepare has been cut, the head camera looks at every square by itself and works out which cut through. It measures each square\'s cut line against the material either side, its weakest stretch (a bridge left uncut) and its inside. The grid decides: more power or a slower speed can only help, so the squares that cut through lie on one side of a staircase across the grid, and one misread square is put right by its neighbours. It then picks the fastest speed that cut through, one power step above the lowest that did, and shows every square\'s picture with the pick. Save puts it into that material\'s cut setting on this machine, and Pathline Prepare takes it on its next sync. When the squares don\'t separate cleanly it says it isn\'t sure.',
      'Setup is in the order things are set up: Machine (now with the bed and motion), Jobs, Materials (with the test grid), Camera (its three calibrations numbered in turn: camera, offset, bed), Z axis, Network, then the controller\'s factory values. Tabs with nothing for this machine aren\'t shown.',
      '☰ → Pathline Monitor on a phone: a QR code for the workshop\'s phone app. With Setup → Pathline Monitor connected it\'s the Monitor server\'s address; otherwise an older Monitor hub on the workshop network is found by itself (it\'s whoever has been watching this machine) and its Set up this phone page shown; a hub on another network can be typed in.',
      'Jog: each arrow says which way the head goes and along which axis (Back · Y−, Front · Y+, Left · X−, Right · X+), on bigger buttons.',
      'Touch screens: every control answers a tap at once, nothing highlights or selects under a finger, and on a finger-driven screen the buttons, switches, choices and scrollbars are bigger. A list being dragged isn\'t redrawn under the finger, so it scrolls and glides as it should.',
      'Trotec bed maps are kept (the last 20) with what each says about the machine: X and Y scale and squareness. A new one is compared with the last, and a change bigger than a machine makes on its own (0.5 ‰ in scale, 0.05° in squareness) is flagged: on Ruby the map of 12 Nov differed from 3 Nov\'s by 1.2 ‰ in Y and 0.18°, which is the board (paper, laid bent), not the machine. Cut a large rectangle and measure its diagonals to be sure.',
      'Trotec estimate: a registration mark is counted as 8 s, not 4 (Ruby\'s took 7–9 s), and from then on learnt from each print and cut job (not when a mark was found by hand).',
      'The diagnostics log is kept on this computer, a file a day for 30 days (data/logs), and ☰ → Diagnostics log shows earlier days. It was only in memory, so a restart lost it.',
      'History says why a job stopped: Stop pressed on this screen or from Pathline on another computer (and whether it was paused, the lid open or waiting for a mark), or what went wrong, with how far it had got. Pathline Monitor gets it too, with the finished job.',
      'Old jobs\' folders are cleared: a job\'s files (up to 7 MB each; 167 MB on Ruby after two weeks) are kept while it\'s queued, while the head drawing learns from its run, or for 30 days in History. An older History line stays, without Run again.',
      'Setup → Camera → 4 · Check with a cut rectangle: the machine\'s accuracy measured with a rule, not a printed board. Queue a large rectangle with its diagonals, cut or score it, type in its sides and diagonals, and Pathline Run says how far out the machine is in X, Y and squareness with the bed map as it is. If it\'s out, Correct the bed map by this.',
      'Trotec estimate: the cutting, the travel between cuts and the engraving are each fitted to what the jobs really took (after each job, with the head drawing\'s fit), and used when that brings the jobs\' times nearer. On Ruby\'s last 26 runs that took the estimate from 1.37 % off (rms) to 1.13 %, the X21 job from −0.8 % to +0.1 %.',
      'Print and cut: each mark\'s time is logged (moving, settling, pictures), each mark\'s picture is saved while the head goes on to the next, and the head is checked for having stopped every 40 ms, not 150.',
      'The camera checks it\'s at the right height: the printed marks are measured, and when they come out more than 5 % larger or smaller than printed the log says the sheet isn\'t where the board was at calibration (the table not focused on the sheet). With the head Z axis, its sensor\'s distance is kept with the camera calibration and compared at each job. Camera calibration now says to focus on the board first.'
    ],
    fixed: [
      'The head drawing\'s fit (after each job) drew print-and-cut engraving on the wrong islands when it replayed a job: the mark steps are left out of the job as placed, and the engraving lines were still looked up by the old step numbers. J0093 was replayed 76 mm from where the laser reported the head; with the lines worked out from the job as placed, 9 mm. On which line the head is, it\'s within 0.1 mm. That fit now judges engraving jobs right.',
      'Print and cut with Non-linear marks no longer stops when the marks are found further apart or closer together than the job has them: Non-linear is for a print that stretched unevenly, and it bends the job to the marks wherever they are. The difference is written to the log. Position & rotation and Full linear still stop.',
      '☰ → Pathline Monitor on a phone lost its QR code 10 minutes after Pathline Run started ("No Pathline Monitor hub has looked at this machine"). The hub keeps one connection open to watch the machine, and Run only counted it when it connected. A hub with its connection open now counts however long ago it connected.',
      'A request from Pathline Prepare or Monitor could fail as "connection reset" when it reused a connection just as Pathline Run closed it for being idle, most often right after the camera had kept Run busy. Idle connections are now kept 30 s, not 5.',
      'Camera calibration (stage 1) gave a slightly different answer each time. The picture\'s X and Y pixel sizes came from a 3 mm move of the head following one corner of the board, near the edge of the picture where the lens bends most, so they came out up to 0.8 % apart and the turn varied by 0.2°. The move now follows every corner on the board and averages them: on the Q500 three calibrations agreed to 0.01 % and 0.06°. The pixel size also no longer rests on the board\'s print: a printed 10 mm board measured 10.12 × 10.07 mm by the head\'s moves, which put the size 1 % out. The log says how the board measures. Recalibrate once to use it.',
      'Checkerboard bed check and calibration refused to start when the board\'s first (top-left) corner was out of the camera\'s reach: the camera sits beside the laser, so on a board reaching the bed\'s left edge it can\'t get over the first column. That corner is now left out like any other the camera can\'t reach or see, and the scan carries on from the next one it finds; the log says how many were out of reach. A board doesn\'t need every corner of every row seen.',
      'Trotec: the screen drew the job as Pathline placed it, but the laser is sent it through the bed map, so the head\'s reports sat off the drawn route (0.5 mm typical, 1.4 mm at worst on Ruby\'s X21 job) and the drawn head was further from the real one. The screen now draws what the laser is sent: on that job the reports sit 0.006 mm from the route, and the drawn head is 1.5 mm from the real one (was 2.0), 4.6 mm at worst 1 time in 10 (was 8.2). Each run also keeps which bed map it was sent with, so the learning replays it the same way.',
      'History wouldn\'t scroll: its list scrolls inside its card, and went back to the top every time the screen was redrawn (0.7 s). Every list that scrolls now keeps its place.'
    ]
  },
  {
    version: '0.7.12', date: '11 Nov 2026',
    added: [
      'For Pathline Monitor, the workshop\'s phone app: GET /api/v1/monitor gives watchers one small, read-only answer (the state and when it began, lid and registration-mark waits with their times, the running job with Run\'s own elapsed and remaining time, the queue in run order and whether each job starts by itself, and today\'s finished and stopped jobs), and GET /api/v1/events sends the same as it changes, with an event when a job finishes. The firewall rules the installer adds are now for private networks only.',
      'Head Z axis (Setup → Z axis, off until switched on): an ESP32 moving the whole nozzle, with an ultrasonic sensor beside it, keeps the nozzle focused on the sheet as it lies. Set focus once with the focus gauge, then Queue → Scan height measures the sheet under the chosen job (the nozzle up, the head back where it started), shown on the bed in blue (low) and red (high). Pathline Run works out the nozzle height along the whole job before it starts, follows the head along it and streams the height ahead to the axis. Replayed on the Q500\'s own jobs over a sheet bowed 3 mm, the nozzle stays within 0.1 mm of focus 9 times in 10 while cutting. The nozzle is never planned nearer the sheet than the smallest gap set, even with the head 0.5 s early or late. It lifts on longer moves, goes up when the job pauses, stops or opens the lid, or when Pathline Run isn\'t sure where the head is, and a sheet the axis can\'t follow is refused at Start. Dry run (on to begin with) works it all out and logs it without moving the nozzle. Firmware and wiring: run/firmware/pathline-z.',
      'Trotec: the head drawn during a job learns from every job run. Each position now keeps when it was asked for and when the laser answered (the answers come back with up to ±80 ms of scatter, ±2.6 mm at 33 mm/s), and after each job Pathline Run replays the recent jobs through the screen\'s own drawing to fit when the laser really read each position and how long its travel, curves and corners really take. A fit is used only when it clearly beats what\'s in use; ☰ → Diagnostics log shows each fit and how far the drawn head was from the real one, before and after.',
      'Pathline Prepare 1.6.11 and later find this machine on the network: Setup → Machines → Add machine lists it under Machines on this network, with no IP address to type. Pathline Run answers and announces "_pathline._tcp.local" (mDNS, as printers are found) and gives the machine an id that never changes, so when the router hands this PC a new address Prepare follows the machine there by itself. The installer lets Pathline Run through Windows Firewall (TCP for Prepare, UDP 5353 for finding it), and takes the rules out again on uninstall.'
    ],
    fixed: [
      'Trotec: a job started straight after another was shown at 100 % from the start, with the head drawn at its end for the whole job. The laser keeps reporting the last part it finished until it finishes another, so the new job started with the previous job\'s last part still showing (J0067 after J0066, both 966 parts; the test grid run five times). That part is now ignored until the laser reports a new one. Progress, Remaining and the head drawn follow the job again: J0067 drawn 1.3 mm from the real head, was 410 mm.',
      'Trotec: engraving is timed from the lines Pathline Run sends, not Pathline Prepare\'s estimate, which ran 10× long on the test grid\'s labels (80 s each, done in 8.5 s). The test grid is now estimated at 2 min 11 s for 2 min 14 s, was 10 min 29 s. The screen draws the head along the lines at that pace.',
      'Trotec: the time estimate is calibrated on motion tests run at 0 % power (shapes at 15–400 mm/s, travel of 20–600 mm, engraving at 100–600 mm/s). Travel is timed as the head really moves (it accelerates harder than the planner setting says, and each move costs 0.03 s more): the planner\'s values ran 18–34 % long on long moves. An engraved line\'s turn now takes 0.058 s plus 0.094 ms per mm/s (it was 26–38 % long at 600 mm/s). Every job and test run since 10 Nov is estimated within −1.8 % to +0.9 %, engraving within 4 %. The head drawing\'s fit uses recent runs until it has enough positions, so a run of short test jobs doesn\'t tune it away from real ones.',
      'Trotec: corners in the time estimate and the head drawing follow the usual junction-deviation rule (the speed at a join set by the angle between the two segments). The formula used the change of direction instead: the same at a right angle, but a near stop at each slight bend and too fast round sharp turns. With it every job run since 10 Nov is estimated within ±2.1 % (1.6 % on average). Each run now also keeps where the job was placed (its anchor, and the marks found), so the drawing\'s fit replays it exactly. tools/calibration-grid.js makes a motion calibration job (squares and circles at three speeds, at 0 % power).',
      'Queue: when the head drawing loses the head, it looks for it on the part the laser says it\'s on, not where the estimate says, and prefers that part when two places fit.',
      'Queue: the head drawn during a job is closer to where the head really is: 2.1 mm away half the time and within 7.7 mm 9 times in 10 (it was 2.7 and 10.6 mm), checked against every position the Q500 reported in the jobs run so far. The drawing no longer speeds up or slows down with a pace learnt from the reports, which mostly followed their own scatter. Its timing is also fitted to the moves the Trotec really makes: quicker travel between cuts, slower curves and corners.',
      'Trotec: estimates for fast cuts and small shapes. A cut was timed as its length ÷ its speed, but the Trotec slows for curves and corners, so a job at 400 mm/s took 1.78 × its estimate (J0053: 82 s for 2 min 26 s). Cuts are now timed as the machine moves them, and every job run since 10 Nov lands within 1 % of its estimate. Each registration mark adds about 4 s to a print and cut job\'s queue estimate.',
      'Trotec: a job the laser ended itself, going idle before its last part, is kept as Stopped with an alarm saying where it stopped. It was kept as Completed (J0055 stopped at part 14 of 188 after 15 s).'
    ]
  },
  {
    version: '0.7.11', date: '5 Nov 2026',
    added: [
      'Print and cut: a registration mark that isn\'t where the camera expects it no longer stops the job. Pathline Run opens Jog with the camera picture beside the arrows: jog until the mark is in the red circle and press Accept, and the camera finds its centre from there and reads the other marks itself. Stop job ends it.',
      'Anchor to toolhead starts on for a print and cut job and off for any other. A print and cut job puts its top-left registration mark at the head: put the laser head over that mark and press Start, and the camera finds the marks from there wherever the sheet lies. (It put the corner of the whole job there, which the cuts can reach past: on the X8 sheet every mark was looked for 22 mm away.) Switch it off to look for the marks where Pathline placed the job.',
      'Print and cut: Start checks that the camera can reach every registration mark before the head moves. The camera sits beside the laser, so it can\'t see right up to every edge. Trotec: to look at a mark, and when jogging, the head now also uses its travel behind and left of the bed, as far as the machine\'s own zero (14.8 and 9.5 mm on the Q500); cutting stays on the bed. So on the Q500 the camera sees from 27 mm to the left edge and 4 mm to the back (it was 42 and 13 mm). A mark too close now gets a plain answer, for example "Marks 1 and 3 are 28 mm from the left edge; the camera can only see from 42 mm", with how far to move the sheet, in place of "the head would leave the bed" after the run had begun.',
      'Print and cut: when the camera can\'t reach a mark, Start opens a box that stays up until you close it, with which way to move the sheet in large type: front, back, left or right, rounded up to the next 10 mm. It then says to put the laser (not the camera) over the top-left dot.',
      'Muted teal for what\'s chosen or on: the selected job, tabs, switches and the job\'s progress, as in Pathline Prepare. Red stays for buttons that act. The head on the bed stays black or white, so it isn\'t taken for a cyan drawing line. Start and Pause icons are white again in dark mode.',
      'Print and cut: when the cuts would go past the bed where the sheet lies, Start says which way to move the sheet and by how much ("Move the sheet 20 mm to the left"). It used to say to move the head, which belongs on the dot. Only the cuts have to be on the bed: a registration mark may be past its far edge, as long as the camera reaches it. Once the marks are read, the job is checked again before anything is cut. That check was missing, so a job expected 42 mm to the left of its marks cut out to X 1313 on the 1300 mm bed.',
      'Print and cut anchored at the head: if the camera was put over the top-left dot instead of the laser, the first mark is now found one camera offset away by itself, not left for you to jog to by hand.',
      'The screen no longer slows down on large jobs. A job\'s artwork is drawn once and kept between the screen\'s updates (on the X28 sheet each update rebuilt 2.3 MB of drawing, about 0.1 s every 0.7 s), and the queue\'s thumbnails are pictures. Buttons and menus no longer miss taps when they are redrawn.',
      'After a job completes the head goes back to where it was when Start was pressed, ready for the next sheet. Setup → Jobs → Return head to start after a job switches it off. A stopped job leaves the head where it stopped.',
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
