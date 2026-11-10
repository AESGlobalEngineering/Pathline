# Brief for Pathline Run: let Pathline Prepare find the machine (no IP address to type)

From Pathline Prepare 1.6.11 (10 Nov 2026). The owner asked for machines to be found without typing an IP address.

## What Prepare already does (no Run change needed)

**Setup → Machines → Add machine** now shows **Machines on this network**. To fill it, Prepare:
1. **Scans** every address on its own local networks (each /24) with `GET /api/v1/info` on port 8470, giving up after 0.9 s per address. Any Run answers this today, but only on the same subnet as the PC, and only on port 8470.
2. **Asks the network** (mDNS / DNS-SD) for `_pathline._tcp.local`. **Run doesn't answer this yet.** That's what this brief adds.

Picking a machine in the list fills in its IP address and port.

Prepare also stores the machine's own **`id`** (`machine.deviceId`). When a saved machine stops answering, Prepare asks the network for it, at most once a minute. If a machine with the same `id` answers from a different address, Prepare moves the saved machine to that address on its own. This is for a router (DHCP) that hands Run a new IP address. It only works once both changes below are in.

## 1. A stable machine id in `GET /info`

Add `id` to `GET /api/v1/info`:

```json
{ "id": "run-3f9c2a71", "name": "Trotec Q500", "type": "laser", "ctrl": "Trotec", "model": "…", "firmware": "…", "protocol": 1, "bed": [1300, 900], "app": "Pathline Run 1.x.y" }
```

- Generate it once, at random, the first time Run starts: `'run-' + crypto.randomBytes(4).toString('hex')` is plenty. Save it in Run's config.
- It **never changes**: not when the machine is renamed, the IP changes, Run is updated, or the controller changes.
- A different PC running Run, or a fresh install with new config, gets a new id. That is correct, since it's a different machine as far as Prepare knows.

## 2. Announce the machine (mDNS / DNS-SD)

Answer questions for the service **`_pathline._tcp.local`** on UDP 5353 (multicast group 224.0.0.251), on every IPv4 network Run is on.

**Records to answer with** (TTL 120 s):

| Record | Name | Data |
|---|---|---|
| PTR | `_pathline._tcp.local` | `<machine name>._pathline._tcp.local` |
| SRV | `<machine name>._pathline._tcp.local` | port = Run's HTTP port (8470 by default, or whatever it is set to), target `<hostname>.local` |
| TXT | `<machine name>._pathline._tcp.local` | `id=…`, `name=…`, `type=laser\|plotter`, `ctrl=…`, `model=…`, `protocol=1`, `app=Pathline Run x.y.z` |
| A | `<hostname>.local` | each IPv4 address Run is reachable on (not 127.x, not 169.254.x) |

- Put the PTR in *answers* and the SRV, TXT and A records in *additionals*, so one reply is enough.
- `<machine name>` is the name set on Run. If it has no name yet, use "Pathline Run".
- The TXT values are the same as the matching fields in `GET /info`. `id` is the one Prepare relies on.

**How to reply, which matters for Windows:**
- Prepare asks from an ordinary port, not 5353, with the "unicast reply" bit set. When the question comes from a port other than 5353, **send the reply straight back to that address and port** (RFC 6762 §6.7). Windows Firewall lets that through to Prepare as a reply. A multicast-only reply often never reaches it.
- Copy the question's ID into the reply when you can. Prepare doesn't require it.
- A question from port 5353 (another mDNS device) gets the normal multicast reply.

**Announce yourself, too:** on start-up, and when the name or an IP address changes, send the same records unasked, twice, 1 s apart, to 224.0.0.251:5353. On a clean quit, sending them once with TTL 0 is a nice extra; it's not required.

**Library:** [`multicast-dns`](https://www.npmjs.com/package/multicast-dns) (pure JS, no native parts) does all of this:

```js
const mdns = require('multicast-dns')();
mdns.on('query', (q, rinfo) => {
  if (!q.questions.some((x) => x.type === 'PTR' && x.name.toLowerCase() === '_pathline._tcp.local')) return;
  const reply = { answers: [ptr], additionals: [srv, txt, ...aRecords] };
  // a question from an ordinary port gets its answer sent straight back
  mdns.respond(reply, rinfo.port !== 5353 ? rinfo : undefined);
});
```

`txt.data` takes an array of `'key=value'` strings. Prepare's own encoder, `encodeAnswer` in `src/main/discover.js`, shows the exact packet it expects.

## 3. Windows Firewall (the Run installer)

The Run PC must let these in:
- **TCP 8470** (or the configured port). Prepare's scan and every normal request need it. If it isn't already allowed, add it.
- **UDP 5353** for Pathline Run, so the questions arrive.

Add both as inbound rules in the NSIS installer (`netsh advfirewall firewall add rule name="Pathline Run" dir=in action=allow program="$INSTDIR\Pathline Run.exe" enable=yes`, for both protocols). Remove them on uninstall. The PC's network should be set to **Private**. Windows blocks discovery on a **Public** network.

## 4. Check it

1. Start Run on the machine's PC.
2. On another PC on the same network, open Pathline Prepare 1.6.11 or later → Setup → Machines → **Add machine**. The machine shows up in **Machines on this network** within about 2 s, with its name, Laser/Plotter, controller and IP address.
3. From Prepare's folder, this lists what answers the announcement only (not the scan):
   `node -e "require('./src/main/discover').browse().then((l) => console.log(l))"`
   Each entry has `via: ['announce']` and Run's `id`.
4. Add the machine, then give the Run PC a different IP address. Within about a minute of its first failed status check, Prepare's saved machine has the new address. The bug report log has a line `[discover] <name> moved from … to …`.

## Done when

- [x] `GET /info` has a stable `id`.
- [x] Run answers `_pathline._tcp.local` with PTR, SRV, TXT and A, replying straight to questions that come from an ordinary port.
- [x] Run announces itself on start-up and when its name or address changes.
- [x] The installer opens TCP and UDP 5353 inbound for Run.
- [ ] Prepare lists the machine with `via` including `announce`, and follows it to a new IP address.

## Done in Pathline Run 0.7.11

- **`id`:** `run-` plus 8 hex digits, made the first time Run starts and kept in `app.json` in Run's data folder, beside the app's own state rather than the machine's setup. Setup and Remove machine can't change it. A fresh data folder gets a new one.
- **Responder:** `run/src/discovery.js`, on Node's own `dgram` with no extra modules.
  - It answers PTR for `_pathline._tcp.local`, and SRV, TXT and A for its own names. Questions from an ordinary port get a legacy unicast reply with the question's ID and question echoed. QU questions from 5353 are answered straight back, and others by multicast.
  - The A records list the address on the asker's network first.
  - It announces twice, 1 s apart, on start-up, and again when the name, port or an address changes. It checks every 10 s and also when Setup is saved, and says goodbye with TTL 0 on quit.
  - It stays quiet until a machine is set up. A simulated machine (`--sim`) doesn't announce unless it's started with `--announce`.
- **Firewall:** `run/build/installer.nsh` adds "Pathline Run", TCP for the program on any port so a changed HTTP port still works, and "Pathline Run (discovery)", UDP 5353. The uninstaller removes both. The rules need the installer to run elevated (an install for all users). A per-user install, or the portable exe, relies on Windows' own "allow this app" prompt.
- **Self-test:** `run/tools/selftest.js` → "Found on the network". It checks that Prepare's own `browse()`, run against Run's responder, gets the `id`, name, port and type, and that a rename keeps the `id`. It also checks that `/info`'s `id` stays the same across restarts.
