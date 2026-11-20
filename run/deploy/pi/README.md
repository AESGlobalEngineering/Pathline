# Pathline Run on a Raspberry Pi

A Raspberry Pi with a touch screen can be the Pathline Run station next to the laser (the Trotec Q500) or a Ruida machine, and do nothing else:

- **Switch it on and Pathline Run is there**, full screen. No desktop, no login, nothing else on the screen.
- **If Pathline Run ever stops** (a crash, or it was closed), it comes back by itself two seconds later. If the screen's page crashes, it comes back a second later and a running job carries on underneath.
- **Safe to switch off at the wall.** Settings, the queue and history are always saved whole, so a power cut can't leave them half written. The disk check after a power cut fixes what it finds by itself, and the Pi's watchdog restarts it if it ever hangs completely.
- **The screen stays on.** It never blanks or goes to sleep.
- **Made for fingers.** Pathline Run brings its own on-screen keyboard (a number pad for numbers), and the mouse pointer hides while fingers are used.
- **It updates itself** the way it does on Windows: a new version is offered on the screen, and only installed when the operator says so.

## What you need

- A Raspberry Pi 5 (4 GB or more is best), with its official 27 W power supply. A Pi 4 works with other screens, but not with the 10" Touch Display 2.
- A touch screen: **Raspberry Pi Touch Display 2, 10"** (the one this was set up for, see below), or a 10" HDMI touch screen whose touch plugs into a USB port.
- A microSD card, 16 GB or bigger (a good brand: it holds Pathline Run's data).
- An Ethernet cable to the network Pathline is on.
- For a Trotec: its USB cable, plugged into the Pi. For a Ruida: the Ruida on the same network.

## Setting it up

1. **Put Raspberry Pi OS on the card.** On any computer, use Raspberry Pi Imager (free, from raspberrypi.com). Choose your Pi model, then **Raspberry Pi OS Lite (64-bit)** (under *Raspberry Pi OS (other)*). In the Imager's settings, set a user name and password for yourself, and switch on SSH if you'd like to reach the Pi from another computer. Write the card.
2. **Start the Pi** with the card, the screen, a keyboard (just for setting up) and the network cable plugged in. Log in with the user name and password you chose.
3. **Run the setup.** Type this line exactly and press Enter:

   `curl -fsSL https://github.com/AESGlobalEngineering/Pathline/releases/download/pathlinerun/install-pi.sh | sudo bash`

   It takes a few minutes. At the end it shows the Pi's IP address.
4. **Restart the Pi** (type `sudo reboot`, or switch it off and on). Pathline Run comes up full screen. The keyboard can be unplugged.
5. **In Pathline:** Setup → Machines → Add machine → Ethernet, the IP address the setup showed, port 8470. On the Pi's screen, add the machine in Setup as on Windows.

No network at the Pi? Copy `Pathline-Run-arm64.AppImage` (from the pathlinerun release on GitHub) and `install-pi.sh` to a USB stick, plug it in, and run `sudo bash install-pi.sh --appimage /media/…/Pathline-Run-arm64.AppImage` with the stick's folder.

## Raspberry Pi Touch Display 2, 10"

Raspberry Pi's own 10" touch screen (1200×1920, ten-finger touch). It plugs into a Raspberry Pi 5 with the short wide ribbon cable that comes with it (in one of the Pi 5's CAM/DISP ports) and the power cable onto the Pi's pins. Raspberry Pi's leaflet shows which pins: get those right, as the wrong way round can damage the screen.

- **Size:** the setup finds this screen by itself and shows Pathline Run 1.5 times bigger on it, which lays it out exactly as on a 1280×800 screen. Nothing to set.
- **On its side or standing tall:** the screen stands tall as it comes. Pathline Run works that way, but the bed drawing is small in its narrow column. On its side it gets Pathline Run's own wide layout, and that's the way to mount it. Run the setup again with `--rotate 90` at the end (see below) and restart the Pi. If the picture comes out upside down, use `--rotate 270` instead.
- **If taps land in the wrong place after turning it:** run the setup again with `--touch-rotate` and the other number. For example, after `--rotate 90`, try `--touch-rotate 270`, and if that's still wrong, `--touch-rotate 0`. Each run, then restart the Pi.
- The first setup also brings the Pi's software and firmware up to date, as Raspberry Pi asks for this screen.

## A screen mounted turned or upside down

Run the setup again with `--rotate` and how far to turn it: 90, 180 or 270. The touch is turned to match. For example, upside down:

`curl -fsSL https://github.com/AESGlobalEngineering/Pathline/releases/download/pathlinerun/install-pi.sh | sudo bash -s -- --rotate 180`

Then restart the Pi. If 90 comes out the wrong way, use 270 instead (and the other way round). Running the setup again keeps Pathline Run, its data and its updates as they are.

## Screen size

Pathline Run fits a 10" screen as it is. At the usual 1280×800 the on-screen keyboard's keys are about 18 mm wide and 9 mm tall, and the field being typed in stays in sight above it; at 1024×600 they're the same size on the glass. Nothing to set.

A sharper 10" screen (1920×1200) shows everything about two thirds that size. Raspberry Pi's own 10" Touch Display 2 is made bigger by itself (above). For another sharp screen, run the setup again with `--scale 1.5` at the end, like `--rotate` above, then restart the Pi. (1.25, 1.75 and 2 work too; `--scale auto` goes back to choosing by itself.)

## Other choices

- **A touch screen that shows a mouse pointer under the finger** (some pretend to be a mouse): run the setup again with `--hide-cursor` at the end, like `--rotate` above.
- **A real keyboard always plugged in, and no on-screen keyboard wanted:** add `--no-keyboard` to the `ARGS` line in `/etc/default/pathline-run`, then restart the Pi.
- **The head camera:** install Allied Vision's Vimba X for ARM64 Linux (free, from alliedvision.com) into `/opt` with its own install script, then restart the Pi. Pathline Run finds it there.

## Where things are

| What | Where |
| --- | --- |
| Pathline Run | `/home/pathline/Applications/Pathline-Run.AppImage` (it updates this file itself) |
| Its data: settings, queue, history, received jobs, logs | `/home/pathline/.config/Pathline Run/data` |
| Kiosk settings (turning, size, extra options) | `/etc/default/pathline-run` |
| What starts it at power on | `/etc/systemd/system/pathline-run.service` and `/usr/local/bin/pathline-run-kiosk` |

Pathline Run runs as its own user, `pathline`, which has no password: nobody logs in as it. To work on the Pi, press Ctrl+Alt+F2 on a plugged-in keyboard for a login prompt (Ctrl+Alt+F1 goes back to Pathline Run), or connect over SSH.

To see why Pathline Run stopped or restarted: ☰ → Diagnostics on its screen, or on the Pi `journalctl -u pathline-run`.

## What the setup changes on the Pi

So nothing is a surprise:

- Installs `cage` (shows one program full screen and nothing else), the libraries Pathline Run needs, and the IBM Plex fonts its screen uses.
- Adds the `pathline` user, allowed to use the USB serial ports, the screen, touch, the camera and the network settings.
- Starts Pathline Run at power on in place of the desktop and the login prompt on the screen, and starts it again whenever it stops. Turns off the desktop if the Pi had one.
- Turns off ModemManager and keeps the Trotec's USB port away from it (it probes serial ports as if they were modems), and from brltty if it's there.
- Lets Pathline Run set the Pi's own IP address from its Setup → Network.
- Boot settings (`cmdline.txt`, a copy of the old one is kept beside it): the screen never blanks, a disk check fixes what it finds after a power cut, more USB memory for the camera, and no scrolling text at boot. `config.txt`: no rainbow square at boot.
- The Pi's hardware watchdog on, and the system log kept to 100 MB.

The card is not made read-only: Pathline Run's queue, settings and updates have to be saved. Instead every file it saves is written in full first and then swapped in, so a power cut leaves the old file or the new one, never half of one.

## For developers

- `npm run dist:pi` (on Linux) builds `dist/Pathline-Run-<version>-arm64.AppImage`. AppImages can't be packed on Windows; the GitHub release workflow (`.github/workflows/release-run.yml`) builds them on Linux with every version, along with `latest-linux-arm64.yml`, which installed copies read to find updates.
- On Windows, `npx electron-builder --linux tar.gz --arm64` builds the same app as an arm64 `.tar.gz`, enough to check what goes in it.
- `electron/main.js` options used by the kiosk: `--kiosk` (full screen; on Linux also turns the on-screen keyboard on), `--keyboard` / `--no-keyboard`, `--hide-cursor`. The keyboard and pointer hiding are `ui/keyboard.js`.
- The setup script is `install-pi.sh` here. The release copies it next to the AppImages, which is where the setup line downloads it from.
