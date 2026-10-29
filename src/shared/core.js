/*
 * Shared core: colour index, geometry helpers, the job time estimator and the
 * simulation timeline. Loaded by the main process (require) and by the pages
 * (<script>, exposed as window.CC), so both sides compute identical numbers.
 *
 * Units: millimetres and seconds. Job coordinates have their origin at the top
 * left of the bed with Y pointing down, matching what the screen shows.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- colours
  const ACI_NAMES = { 1: 'Red', 2: 'Yellow', 3: 'Green', 4: 'Cyan', 5: 'Blue', 6: 'Magenta', 7: 'White / black', 8: 'Grey', 9: 'Light grey' };
  const ACI_BASE = { 1: '#FF0000', 2: '#FFFF00', 3: '#00FF00', 4: '#00FFFF', 5: '#0000FF', 6: '#FF00FF', 7: '#000000', 8: '#808080', 9: '#C0C0C0' };

  // AutoCAD Color Index 10-249 is a hue wheel in 24 steps with 5 shades in
  // full and half saturation; 250-255 are greys.
  const ACI_HEX = (() => {
    const out = { 0: '#000000', ...ACI_BASE };
    const hsv = (h, s, v) => {
      const f = (n) => {
        const k = (n + h / 60) % 6;
        return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
      };
      return [f(5), f(3), f(1)].map((c) => Math.round(c * 255));
    };
    const shades = [1, 0.8, 0.6, 0.5, 0.3];
    for (let i = 10; i <= 249; i++) {
      const h = Math.floor((i - 10) / 10) * 15;
      const j = (i - 10) % 10;
      const rgb = hsv(h, j % 2 ? 0.5 : 1, shades[Math.floor(j / 2)]);
      out[i] = '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase();
    }
    [0x33, 0x5b, 0x84, 0xad, 0xd6, 0xff].forEach((g, k) => {
      const h = g.toString(16).padStart(2, '0').toUpperCase();
      out[250 + k] = '#' + h + h + h;
    });
    return out;
  })();

  const aciHex = (n) => ACI_HEX[n] || '#5B6370';
  const aciName = (n) => ACI_NAMES[n] || 'ACI ' + n;
  const aciFg = (n) => ([2, 3, 4, 9].includes(n) ? '#15181E' : '#FFFFFF');
  // How a colour is drawn on the white canvas (ACI 7 is "white on dark, black on light").
  const aciStroke = (n) => (n === 7 ? '#15181E' : n === 2 ? '#C9B800' : n === 4 ? '#00B7C2' : aciHex(n));

  const hexToRgb = (h) => {
    const s = String(h).replace('#', '');
    const v = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
    const n = parseInt(v.slice(0, 6), 16);
    return Number.isNaN(n) ? [0, 0, 0] : [n >> 16, (n >> 8) & 255, n & 255];
  };

  // Map an RGB colour from an SVG/PDF to the closest colour index, preferring
  // the nine standard ones the process list works with.
  function rgbToAci(rgb) {
    const [r, g, b] = Array.isArray(rgb) ? rgb : hexToRgb(rgb);
    const dist = (n) => {
      const [R, G, B] = hexToRgb(ACI_HEX[n]);
      return (R - r) ** 2 + (G - g) ** 2 + (B - b) ** 2;
    };
    let best = 7, bd = Infinity;
    for (let n = 1; n <= 9; n++) {
      const d = dist(n);
      if (d < bd) { bd = d; best = n; }
    }
    if (bd < 40 * 40 * 3) return best;
    for (let n = 10; n <= 255; n++) {
      const d = dist(n);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  // ---------------------------------------------------------------- ids
  let idSeq = 0;
  const uid = (p) => (p || 'x') + Date.now().toString(36) + (idSeq++).toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------------------------------------------------------------- geometry
  // An entity holds one or more polylines: { paths: [{ p: [[x, y], ...], c: closed }] }
  const EMPTY_BOX = () => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  function growBox(b, x, y) {
    if (x < b.x0) b.x0 = x;
    if (y < b.y0) b.y0 = y;
    if (x > b.x1) b.x1 = x;
    if (y > b.y1) b.y1 = y;
    return b;
  }
  function entityBox(e, b) {
    b = b || EMPTY_BOX();
    for (const path of e.paths || []) for (const pt of path.p) growBox(b, pt[0], pt[1]);
    return b;
  }
  function boxOf(entities) {
    const b = EMPTY_BOX();
    for (const e of entities) entityBox(e, b);
    return b;
  }
  const boxValid = (b) => b && Number.isFinite(b.x0) && b.x1 >= b.x0;
  const boxW = (b) => (boxValid(b) ? b.x1 - b.x0 : 0);
  const boxH = (b) => (boxValid(b) ? b.y1 - b.y0 : 0);

  function mapEntity(e, fn) {
    return { ...e, paths: e.paths.map((path) => ({ ...path, p: path.p.map(fn) })) };
  }
  const translate = (e, dx, dy) => mapEntity(e, ([x, y]) => [x + dx, y + dy]);
  function scaleAbout(e, sx, sy, cx, cy) {
    return mapEntity(e, ([x, y]) => [cx + (x - cx) * sx, cy + (y - cy) * sy]);
  }
  function rotateAbout(e, deg, cx, cy) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return mapEntity(e, ([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
  }

  function polyLen(p, closed) {
    let L = 0;
    for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    if (closed && p.length > 2) L += Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]);
    return L;
  }
  function polyArea(p) {
    let a = 0;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
    return a / 2;
  }
  function pointInPoly(x, y, p) {
    let inside = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const L = dx * dx + dy * dy;
    let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  // Distance from a point to the nearest stroke of an entity (for click hit testing).
  function distToEntity(e, x, y) {
    let d = Infinity;
    for (const path of e.paths) {
      const p = path.p;
      for (let i = 1; i < p.length; i++) d = Math.min(d, distToSeg(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]));
      if (path.c && p.length > 2) d = Math.min(d, distToSeg(x, y, p[p.length - 1][0], p[p.length - 1][1], p[0][0], p[0][1]));
      if (path.c && p.length > 2 && pointInPoly(x, y, p)) d = Math.min(d, 0.0001 + d * 0.5);
    }
    return d;
  }

  function isClosedPts(p, tol) {
    if (p.length < 3) return false;
    const a = p[0], b = p[p.length - 1];
    return Math.hypot(a[0] - b[0], a[1] - b[1]) <= (tol || 0.01);
  }
  // Drop consecutive duplicate points and a duplicated closing point.
  function cleanPath(p, closed) {
    const out = [];
    for (const pt of p) {
      const last = out[out.length - 1];
      if (!last || Math.abs(last[0] - pt[0]) > 1e-6 || Math.abs(last[1] - pt[1]) > 1e-6) out.push([pt[0], pt[1]]);
    }
    if (closed && out.length > 2 && isClosedPts(out, 1e-6)) out.pop();
    return out;
  }

  // Shape builders used by the drawing tools.
  const shapes = {
    rect(x, y, w, h, r) {
      r = Math.max(0, Math.min(r || 0, Math.abs(w) / 2, Math.abs(h) / 2));
      if (!r) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      const pts = [];
      const arc = (cx, cy, a0) => {
        for (let i = 0; i <= 8; i++) {
          const a = a0 + (i / 8) * (Math.PI / 2);
          pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
      };
      arc(x + w - r, y + r, -Math.PI / 2);
      arc(x + w - r, y + h - r, 0);
      arc(x + r, y + h - r, Math.PI / 2);
      arc(x + r, y + r, Math.PI);
      return pts;
    },
    ellipse(cx, cy, rx, ry) {
      const n = Math.max(24, Math.min(256, Math.round((Math.abs(rx) + Math.abs(ry)) * 1.5)));
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
      }
      return pts;
    },
    polygon(cx, cy, r, sides, rot) {
      const pts = [];
      for (let i = 0; i < sides; i++) {
        const a = (rot || -Math.PI / 2) + (i / sides) * Math.PI * 2;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      return pts;
    },
    // Registration dot (as drawn on print-and-cut sheets).
    dot(cx, cy, d) {
      return shapes.ellipse(cx, cy, d / 2, d / 2);
    }
  };

  // ---------------------------------------------------------------- process ordering
  const PLOT_TOOL_ORDER = ['Pen', 'V-cut', 'Crease', 'Drag knife', 'Knife'];
  function toolRank(tool) {
    const t = String(tool || '');
    const i = PLOT_TOOL_ORDER.findIndex((k) => t.includes(k));
    return i < 0 ? 99 : i;
  }
  const toolSlot = (tool) => (String(tool || '').match(/T\d+/) || ['T?'])[0];
  // Laser jobs engrave first, then mark, then cut (so parts don't move before
  // they're engraved); plotter jobs run marking tools first and through-cuts last.
  function processOrder(job, isLaser) {
    const idx = job.processes.map((_, i) => i).filter((i) => job.processes[i].out !== false && !isRegProc(job.processes[i]));
    const rank = (p) => (isLaser ? ({ Engrave: 0, Mark: 1, Cut: 2 }[p.proc] ?? 3) : toolRank(p.tool));
    return idx.sort((a, b) => rank(job.processes[a]) - rank(job.processes[b]) || a - b);
  }
  // A process whose colours mark registration marks for the camera (not cut).
  const REG_PROC = 'Registration mark';
  // ('Reg mark' is the name older job files use)
  const isRegProc = (p) => !!p && (p.proc === REG_PROC || p.proc === 'Reg mark');
  // Which process an entity belongs to, through its colour index.
  function processOfAci(job, aci) {
    return job.processes.findIndex((p) => (p.aci || []).includes(aci));
  }

  // ---------------------------------------------------------------- motion model
  // Time to cover distance L starting at v0 and ending at v1, cruising at most
  // at v, with acceleration a (trapezoidal profile).
  function segTime(L, v0, v1, v, a) {
    if (L <= 0) return 0;
    if (!(a > 0)) return L / v;
    const da = Math.max(0, (v * v - v0 * v0) / (2 * a));
    const dd = Math.max(0, (v * v - v1 * v1) / (2 * a));
    if (da + dd <= L) return (v - v0) / a + (v - v1) / a + (L - da - dd) / v;
    // never reaches cruise speed: peak speed vp
    const vp = Math.sqrt(Math.max(v0 * v0, v1 * v1, (2 * a * L + v0 * v0 + v1 * v1) / 2));
    return Math.max(0, (vp - v0) / a) + Math.max(0, (vp - v1) / a);
  }
  const JUNCTION_DEV = 0.05; // mm, how far the head may round a corner at speed

  // Time to follow a polyline at feed speed v with acceleration a, slowing
  // at corners (grbl-style junction deviation) and stopping at both ends.
  function polyTime(p, closed, v, a) {
    const pts = closed && p.length > 2 ? p.concat([p[0]]) : p;
    const n = pts.length - 1;
    if (n < 1) return 0;
    const L = [], U = [];
    for (let i = 0; i < n; i++) {
      const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
      const l = Math.hypot(dx, dy);
      L.push(l);
      U.push(l > 0 ? [dx / l, dy / l] : [0, 0]);
    }
    // max speed at each junction
    const vj = new Array(n + 1).fill(0);
    for (let i = 1; i < n; i++) {
      const cos = -(U[i - 1][0] * U[i][0] + U[i - 1][1] * U[i][1]);
      if (cos < -0.999999) vj[i] = v;
      else if (cos > 0.999999) vj[i] = 0;
      else {
        const s = Math.sqrt(0.5 * (1 - cos));
        vj[i] = Math.min(v, Math.sqrt((a * JUNCTION_DEV * s) / (1 - s)));
      }
    }
    // forward / backward passes so every segment's speed change is reachable
    for (let i = 1; i <= n; i++) vj[i] = Math.min(vj[i], Math.sqrt(vj[i - 1] ** 2 + 2 * a * L[i - 1]));
    for (let i = n - 1; i >= 0; i--) vj[i] = Math.min(vj[i], Math.sqrt(vj[i + 1] ** 2 + 2 * a * L[i]));
    let t = 0;
    for (let i = 0; i < n; i++) t += segTime(L[i], vj[i], vj[i + 1], v, a);
    return t;
  }
  const travelTime = (d, v, a) => segTime(d, 0, 0, v, a);

  // Raster engraving: for each scan line, the head sweeps from the leftmost to
  // the rightmost crossing (plus overscan to accelerate) — even-odd fill for
  // closed shapes, a thin band for open ones.
  function rasterSpans(paths, dpi, base) {
    const step = 25.4 / Math.max(1, dpi);
    const edges = [];
    let y0 = Infinity, y1 = -Infinity;
    for (const path of paths) {
      const p = path.p;
      const n = p.length;
      const m = path.c ? n : n - 1;
      for (let i = 0; i < m; i++) {
        const a = p[i], b = p[(i + 1) % n];
        edges.push([a[0], a[1], b[0], b[1], path.c]);
        y0 = Math.min(y0, a[1], b[1]);
        y1 = Math.max(y1, a[1], b[1]);
      }
    }
    const rows = [];
    if (!edges.length) return { rows, step };
    // line up the scan lines on a shared grid (so separate shapes can share them)
    if (base !== undefined) y0 = base + Math.floor((y0 - base) / step) * step;
    // bucket edges by row for speed
    const nRows = Math.max(1, Math.ceil((y1 - y0) / step));
    const buckets = Array.from({ length: nRows + 1 }, () => []);
    edges.forEach((e, k) => {
      const lo = Math.max(0, Math.floor((Math.min(e[1], e[3]) - y0) / step));
      const hi = Math.min(nRows, Math.ceil((Math.max(e[1], e[3]) - y0) / step));
      for (let r = lo; r <= hi; r++) buckets[r].push(k);
    });
    for (let r = 0; r <= nRows; r++) {
      const y = y0 + r * step + step / 2;
      if (y > y1) break;
      let xmin = Infinity, xmax = -Infinity;
      for (const k of buckets[r]) {
        const [ax, ay, bx, by, closed] = edges[k];
        if ((ay > y) === (by > y)) {
          if (!closed && Math.abs(ay - y) <= step && Math.abs(by - y) <= step) {
            xmin = Math.min(xmin, ax, bx);
            xmax = Math.max(xmax, ax, bx);
          }
          continue;
        }
        const x = ax + ((y - ay) / (by - ay)) * (bx - ax);
        if (x < xmin) xmin = x;
        if (x > xmax) xmax = x;
      }
      if (xmax >= xmin) rows.push([y, xmin, xmax]);
    }
    return { rows, step };
  }

  // Scan settings of an engrave process:
  //   dir: 'down' (top down, the default) · 'up' (bottom up) · 'fastest' (whichever end is nearer)
  //   uni: true scans every line left to right only (one way), false both ways
  // (older jobs kept the direction as adv.Direction 'Top down' / 'Bottom up')
  const ENGRAVE_DIRS = ['down', 'up', 'fastest'];
  function engraveScan(proc) {
    const legacy = proc && proc.adv && ({ 'Top down': 'down', 'Bottom up': 'up' })[proc.adv.Direction];
    const dir = proc && ENGRAVE_DIRS.includes(proc.dir) ? proc.dir : legacy || 'down';
    return { dir, uni: !!(proc && proc.uni) };
  }
  // Time to engrave one scan line: the sweep, accelerating into and out of it,
  // and on one-way scans the return stroke to the start of the next line.
  function lineTime(x0, x1, speed, acc, uni, vTravel) {
    const t = (x1 - x0) / speed + (2 * speed) / acc;
    return uni ? t + travelTime(x1 - x0 + (speed * speed) / acc, Math.max(speed, vTravel || speed), acc) : t;
  }

  // Split an engraving into islands: shapes whose outlines are within `gap` mm
  // of each other are engraved together, separate groups on their own. Each
  // island gets its own scan lines, time and box (in original drawing order).
  function rasterIslands(ents, dpi, speed, acc, withYs, gap, uni, vTravel) {
    gap = gap === undefined ? 2 : gap;
    const boxes = ents.map((e) => entityBox(e));
    const parent = ents.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    // sort by left edge so only nearby boxes are compared
    const idx = ents.map((_, i) => i).sort((a, b) => boxes[a].x0 - boxes[b].x0);
    for (let s = 0; s < idx.length; s++) {
      const a = boxes[idx[s]];
      for (let u = s + 1; u < idx.length; u++) {
        const b = boxes[idx[u]];
        if (b.x0 > a.x1 + gap) break;
        if (b.y0 <= a.y1 + gap && b.y1 >= a.y0 - gap) {
          const ra = find(idx[s]), rb = find(idx[u]);
          if (ra !== rb) parent[rb] = ra;
        }
      }
    }
    const groups = new Map();
    ents.forEach((e, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(e); });
    const out = [];
    for (const list of groups.values()) {
      const paths = [];
      list.forEach((e) => e.paths.forEach((p) => paths.push(p)));
      const { rows, step } = rasterSpans(paths, dpi);
      if (!rows.length) continue;
      const b = EMPTY_BOX();
      rows.forEach(([y, x0, x1]) => { growBox(b, x0, y); growBox(b, x1, y); });
      let dur = 0, area = 0;
      for (const [, x0, x1] of rows) {
        dur += lineTime(x0, x1, speed, acc, uni, vTravel);
        area += (x1 - x0) * step;
      }
      // sampled scan-line heights so the simulation can follow gaps
      const every = Math.max(1, Math.ceil(rows.length / 240));
      const ys = withYs ? rows.filter((_, k) => k % every === 0).map((x) => x[0]) : undefined;
      out.push({ ents: list.map((e) => e.id), rows, step, b, dur, area, ys });
    }
    return out;
  }

  // Islands at the same height can instead share scan lines: one side-to-side
  // scan at engrave speed over each island and travel speed across the gaps
  // between them. For each set of islands that overlap in height, whichever
  // is quicker is used — the islands one by one, or the shared scan.
  function rasterBands(isl, ents, dpi, speed, acc, vTravel, withYs, uni) {
    if (isl.length < 2) return isl;
    const over = (speed * speed) / (2 * acc);
    const vGap = Math.max(speed, vTravel || speed);
    const startOf = (r) => [r.rows[0][1] - over, r.rows[0][0]];
    const endOf = (r) => { const l = r.rows[r.rows.length - 1]; return [uni || r.rows.length % 2 ? l[2] + over : l[1] - over, l[0]]; };
    const order = new Map(isl.map((r, i) => [r, i]));
    const byId = new Map(ents.map((e) => [e.id, e]));
    const bands = [];
    for (const r of isl.slice().sort((a, b) => a.b.y0 - b.b.y0)) {
      const cur = bands[bands.length - 1];
      if (cur && r.b.y0 <= cur.y1) { cur.list.push(r); cur.y1 = Math.max(cur.y1, r.b.y1); } else bands.push({ list: [r], y1: r.b.y1 });
    }
    const out = [];
    for (const { list } of bands) {
      if (list.length < 2) { out.push(list[0]); continue; }
      // one by one: each island's scan plus the travel to the next (nearest first)
      const left = list.slice().sort((a, b) => a.b.x0 - b.b.x0);
      let p = endOf(left.shift()), apart = list.reduce((s, r) => s + r.dur, 0);
      while (left.length) {
        let bi = 0, bd = Infinity;
        left.forEach((r, i) => { const s = startOf(r), d = Math.hypot(s[0] - p[0], s[1] - p[1]); if (d < bd) { bd = d; bi = i; } });
        apart += travelTime(bd, vGap, acc);
        p = endOf(left.splice(bi, 1)[0]);
      }
      // shared: every island's spans on a common grid of scan lines
      const base = Math.min(...list.map((r) => r.b.y0)) - 1;
      const lines = new Map();
      let step = 0;
      for (const r of list) {
        const paths = [];
        r.ents.forEach((id) => { const e = byId.get(id); if (e) e.paths.forEach((q) => paths.push(q)); });
        const sp = rasterSpans(paths, dpi, base);
        step = sp.step;
        for (const [y, x0, x1] of sp.rows) {
          const k = Math.round((y - base) / sp.step);
          if (!lines.has(k)) lines.set(k, { y, spans: [] });
          lines.get(k).spans.push([x0, x1]);
        }
      }
      const rows = [];
      let dur = 0;
      for (const k of [...lines.keys()].sort((a, b) => a - b)) {
        const { y, spans } = lines.get(k);
        spans.sort((a, b) => a[0] - b[0]);
        let t = (2 * speed) / acc, x0 = spans[0][0], x1 = spans[0][1];
        const first = x0;
        for (let i = 1; i < spans.length; i++) {
          const [a, b] = spans[i];
          if (a <= x1) { x1 = Math.max(x1, b); continue; }
          t += (x1 - x0) / speed + segTime(a - x1, speed, speed, vGap, acc);
          x0 = a; x1 = b;
        }
        t += (x1 - x0) / speed;
        // one way: back across the whole line to its start
        if (uni) t += travelTime(x1 - first + 2 * over, vGap, acc);
        dur += t;
        rows.push([y, first, x1]);
      }
      if (!rows.length || dur >= apart) { list.forEach((r) => out.push(r)); continue; }
      const b = EMPTY_BOX();
      rows.forEach(([y, a, c]) => { growBox(b, a, y); growBox(b, c, y); });
      const every = Math.max(1, Math.ceil(rows.length / 240));
      const unit = {
        ents: list.flatMap((r) => r.ents), rows, step, b, dur, area: list.reduce((s, r) => s + r.area, 0),
        ys: withYs ? rows.filter((_, k) => k % every === 0).map((x) => x[0]) : undefined, shared: list.length
      };
      order.set(unit, Math.min(...list.map((r) => order.get(r))));
      out.push(unit);
    }
    // keep the drawing order of the first island in each unit
    return out.sort((a, b) => order.get(a) - order.get(b));
  }

  // ---------------------------------------------------------------- nesting
  // Pack parts (their bounding boxes, plus spacing) into areas with MaxRects.
  // Several sort orders and placement rules are tried, optionally with parts
  // turned 90°; the result using the fewest areas, then the least material
  // (smallest used height on the last area), wins.
  //   parts: [{ id, w, h }] · area: { w, h } (inside the margin)
  //   opts: { spacing, rotate, maxAreas } (maxAreas 1 = a single sheet; parts that don't fit are left out)
  // Returns { placed: [{ id, area, x, y, rot }], unplaced: [ids], areas, used, util }.
  function nestRects(parts, area, opts) {
    const sp = Math.max(0, Number(opts.spacing) || 0);
    const maxAreas = opts.maxAreas || Infinity;
    // free rectangles are grown by the spacing so parts can touch the far edges
    const W = area.w + sp, H = area.h + sp;
    const fits = (r, w, h) => w <= r.w + 1e-9 && h <= r.h + 1e-9;
    const score = {
      bssf: (r, w, h) => [Math.min(r.w - w, r.h - h), Math.max(r.w - w, r.h - h)],
      bl: (r) => [r.y, r.x],
      baf: (r, w, h) => [r.w * r.h - w * h, Math.min(r.w - w, r.h - h)]
    };
    function packOnce(order, rule) {
      const bins = [];
      const placed = [], unplaced = [];
      const newBin = () => { const b = { free: [{ x: 0, y: 0, w: W, h: H }], used: 0 }; bins.push(b); return b; };
      const place = (bin, x, y, w, h) => {
        const out = [];
        for (const f of bin.free) {
          if (x >= f.x + f.w || x + w <= f.x || y >= f.y + f.h || y + h <= f.y) { out.push(f); continue; }
          if (x > f.x) out.push({ x: f.x, y: f.y, w: x - f.x, h: f.h });
          if (x + w < f.x + f.w) out.push({ x: x + w, y: f.y, w: f.x + f.w - x - w, h: f.h });
          if (y > f.y) out.push({ x: f.x, y: f.y, w: f.w, h: y - f.y });
          if (y + h < f.y + f.h) out.push({ x: f.x, y: y + h, w: f.w, h: f.y + f.h - y - h });
        }
        // drop free rectangles contained in another
        bin.free = out.filter((a, i) => !out.some((b, j) => j !== i && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h && (j < i || a.w !== b.w || a.h !== b.h || a.x !== b.x || a.y !== b.y)));
        bin.used = Math.max(bin.used, y + h);
      };
      for (const p of order) {
        const w0 = p.w + sp, h0 = p.h + sp;
        const turns = opts.rotate && Math.abs(p.w - p.h) > 1e-6 ? [[w0, h0, 0], [h0, w0, 90]] : [[w0, h0, 0]];
        let best = null;
        for (let bi = 0; bi < bins.length && !best; bi++) {
          for (const f of bins[bi].free) for (const [w, h, rot] of turns) {
            if (!fits(f, w, h)) continue;
            const s = score[rule](f, w, h);
            if (!best || s[0] < best.s[0] - 1e-9 || (Math.abs(s[0] - best.s[0]) <= 1e-9 && s[1] < best.s[1])) best = { bi, x: f.x, y: f.y, w, h, rot, s };
          }
        }
        if (!best && bins.length < maxAreas && turns.some(([w, h]) => w <= W + 1e-9 && h <= H + 1e-9)) {
          newBin();
          const bi = bins.length - 1, [w, h, rot] = turns.find(([tw, th]) => tw <= W + 1e-9 && th <= H + 1e-9);
          best = { bi, x: 0, y: 0, w, h, rot };
        }
        if (!best) { unplaced.push(p.id); continue; }
        place(bins[best.bi], best.x, best.y, best.w, best.h);
        placed.push({ id: p.id, area: best.bi, x: best.x, y: best.y, rot: best.rot });
      }
      return { placed, unplaced, areas: bins.length, last: bins.length ? bins[bins.length - 1].used : 0 };
    }
    const sorts = [
      (a, b) => b.w * b.h - a.w * a.h,
      (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h),
      (a, b) => b.h - a.h,
      (a, b) => b.w - a.w,
      (a, b) => b.w + b.h - a.w - a.h
    ];
    let best = null;
    for (const s of sorts) for (const rule of ['bssf', 'bl', 'baf']) {
      const r = packOnce(parts.slice().sort(s), rule);
      const better = !best || r.unplaced.length < best.unplaced.length ||
        (r.unplaced.length === best.unplaced.length && (r.areas < best.areas || (r.areas === best.areas && r.last < best.last - 1e-9)));
      if (better) best = r;
    }
    best = best || { placed: [], unplaced: parts.map((p) => p.id), areas: 0, last: 0 };
    const partArea = parts.filter((p) => !best.unplaced.includes(p.id)).reduce((s, p) => s + p.w * p.h, 0);
    const used = best.areas ? (best.areas - 1) * area.w * area.h + area.w * Math.min(area.h, Math.max(0, best.last - sp)) : 0;
    return { placed: best.placed, unplaced: best.unplaced, areas: best.areas, used, util: used ? partArea / used : 0 };
  }

  // ---------------------------------------------------------------- path ordering
  function nestDepth(path, all) {
    if (!path.c) return 0;
    const [x, y] = path.p[0];
    let d = 0;
    for (const o of all) {
      if (o === path || !o.c || o.area <= path.area) continue;
      const b = o.box;
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
      if (pointInPoly(x, y, o.p)) d++;
    }
    return d;
  }
  // Job-level cut order settings.
  //   order:  'file' (as drawn/imported) · 'speed' (shortest travel) · 'heat' (spread heat)
  //   inside: 'part' (each part's holes, then its outline) · 'all' (every hole before any outline) · 'off'
  const CUT_ORDER_DEFAULT = { order: 'speed', inside: 'part' };
  function cutOrderOf(job) {
    const c = job.cutOrder || {};
    const legacy = job.optimise === undefined ? null : job.optimise ? 'speed' : 'file';
    return { order: c.order || legacy || CUT_ORDER_DEFAULT.order, inside: c.inside || CUT_ORDER_DEFAULT.inside };
  }

  // Best place to start a path from point `at`: any vertex of a closed path,
  // either end of an open one. Returns { d, v, rev }.
  function entryOf(path, at, exact) {
    const p = path.p;
    if (!path.c) {
      const d0 = Math.hypot(p[0][0] - at[0], p[0][1] - at[1]);
      const d1 = Math.hypot(p[p.length - 1][0] - at[0], p[p.length - 1][1] - at[1]);
      return d1 < d0 ? { d: d1, v: 0, rev: true } : { d: d0, v: 0, rev: false };
    }
    const stride = exact ? 1 : Math.max(1, Math.floor(p.length / 16));
    let best = { d: Infinity, v: 0, rev: false };
    for (let v = 0; v < p.length; v += stride) {
      const d = Math.hypot(p[v][0] - at[0], p[v][1] - at[1]);
      if (d < best.d) best = { d, v, rev: false };
    }
    return best;
  }
  function startAt(it, e) {
    let p = it.path.p;
    if (it.path.c && e.v) p = p.slice(e.v).concat(p.slice(0, e.v));
    if (e.rev) p = p.slice().reverse();
    return { ...it, path: { ...it.path, p } };
  }
  const endOf = (path) => (path.c ? path.p[0] : path.p[path.p.length - 1]);

  // Sequence units (single paths or whole parts) from position `at`.
  // speed: nearest next. heat: the nearest unit that is well away from the
  // last few cuts, so the material cools between neighbouring cuts.
  function sequence(units, at, mode) {
    if (mode === 'file' || units.length < 2) return units;
    const left = units.slice();
    const out = [];
    const recent = [];
    let coolR = 0;
    if (mode === 'heat') {
      const diags = units.map((u) => Math.hypot(u.box.x1 - u.box.x0, u.box.y1 - u.box.y0)).sort((a, b) => a - b);
      coolR = Math.max(15, Math.min(150, 2 * diags[Math.floor(diags.length / 2)]));
    }
    // large jobs: compare by centre distance first, exact entry only for a short list
    while (left.length) {
      let bi = -1, bd = Infinity, far = -1, farD = -1;
      for (let i = 0; i < left.length; i++) {
        const u = left[i];
        const d = Math.hypot(u.cx - at[0], u.cy - at[1]) - u.r;
        if (mode === 'heat' && recent.length) {
          let md = Infinity;
          for (const q of recent) md = Math.min(md, Math.hypot(u.cx - q[0], u.cy - q[1]));
          if (md > farD) { farD = md; far = i; }
          if (md < coolR) continue;
        }
        if (d < bd) { bd = d; bi = i; }
      }
      if (bi < 0) bi = far;
      // smaller jobs: pick by the real distance to each path's best start point
      if (mode === 'speed' && left.length <= 400) {
        let best = Infinity;
        for (let i = 0; i < left.length; i++) {
          const e = left[i].entry(at);
          if (e < best) { best = e; bi = i; }
        }
      }
      const u = left.splice(bi, 1)[0];
      out.push(u);
      at = u.exit(at);
      if (mode === 'heat') { recent.push([u.cx, u.cy]); if (recent.length > 3) recent.shift(); }
    }
    return out;
  }

  /**
   * Order a process's paths. opts: { inside, order, start, nest } where nest
   * says whether holes matter for this process (cuts) — when false, `inside`
   * is ignored. Closed paths then start wherever is most convenient on the
   * travel path (see refineStarts).
   */
  function orderPaths(items, opts) {
    return refineStarts(arrangePaths(items, opts), opts.start || [0, 0], opts.order || 'file');
  }

  // Pick each closed path's start (= end) point so the travel in from the
  // previous cut plus the travel out to the next cut is shortest; open paths
  // may also be cut in reverse when optimising. Two sweeps, as each choice
  // moves its neighbours' best points.
  function refineStarts(list, start, order) {
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    for (let sweep = 0; sweep < 2; sweep++) {
      let prev = start;
      for (let i = 0; i < list.length; i++) {
        const path = list[i].path, p = path.p;
        const next = list[i + 1] ? list[i + 1].path.p[0] : null;
        if (path.c && p.length > 2) {
          let bv = 0, bd = Infinity;
          for (let v = 0; v < p.length; v++) {
            const c = d(prev, p[v]) + (next ? d(p[v], next) : 0);
            if (c < bd) { bd = c; bv = v; }
          }
          if (bv) list[i] = { ...list[i], path: { ...path, p: p.slice(bv).concat(p.slice(0, bv)) } };
        } else if (!path.c && order !== 'file' && p.length > 1) {
          const keep = d(prev, p[0]) + (next ? d(p[p.length - 1], next) : 0);
          const flip = d(prev, p[p.length - 1]) + (next ? d(p[0], next) : 0);
          if (flip < keep) list[i] = { ...list[i], path: { ...path, p: p.slice().reverse() } };
        }
        prev = endOf(list[i].path);
      }
    }
    return list;
  }

  function arrangePaths(items, opts) {
    const order = opts.order || 'file';
    const inside = opts.nest ? opts.inside || 'off' : 'off';
    let at = opts.start || [0, 0];
    // annotated copies so the job's own path objects stay untouched
    items = items.map((it, n) => {
      const b = EMPTY_BOX();
      it.path.p.forEach(([x, y]) => growBox(b, x, y));
      return { ...it, n, path: { ...it.path, area: it.path.c ? Math.abs(polyArea(it.path.p)) : 0, box: b } };
    });
    if (inside !== 'off') {
      const all = items.map((it) => it.path);
      items.forEach((it) => { it.depth = nestDepth(it.path, all); });
    }
    const pathUnit = (it) => {
      const b = it.path.box;
      return {
        it, box: b, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, r: Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2,
        entry: (a) => entryOf(it.path, a).d,
        exit: (a) => endOf(startAt(it, entryOf(it.path, a, true)).path)
      };
    };
    // place each path at its best start point (when optimising) and walk the list
    // blk names the group a path belongs to (a nesting layer, or one part's
    // layer); passes repeat a whole group before the next group starts
    const emit = (list, out, blk) => {
      for (const it of list) {
        const e = order === 'file' ? { v: 0, rev: false } : entryOf(it.path, at, true);
        const placed = { ...startAt(it, e), blk: blk || 'all' };
        out.push(placed);
        at = endOf(placed.path);
      }
    };
    const out = [];
    if (inside === 'all') {
      const layers = new Map();
      items.forEach((it) => { if (!layers.has(it.depth)) layers.set(it.depth, []); layers.get(it.depth).push(it); });
      for (const d of [...layers.keys()].sort((a, b) => b - a)) {
        emit(sequence(layers.get(d).map(pathUnit), at, order).map((u) => u.it), out, 'd' + d);
      }
      return out;
    }
    if (inside === 'part') {
      // a part = an outermost closed contour and everything inside it
      const roots = items.filter((it) => it.path.c && it.depth === 0);
      const parts = new Map(roots.map((r) => [r, [r]]));
      const loose = [];
      for (const it of items) {
        if (it.path.c && it.depth === 0) continue;
        const [x, y] = it.path.p[0];
        let home = null;
        for (const r of roots) {
          const b = r.path.box;
          if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
          if (pointInPoly(x, y, r.path.p) && (!home || r.path.area < home.path.area)) home = r;
        }
        if (home) parts.get(home).push(it);
        else loose.push([it]);
      }
      const units = [...parts.values()].concat(loose).map((list) => {
        const b = EMPTY_BOX();
        list.forEach((it) => { growBox(b, it.path.box.x0, it.path.box.y0); growBox(b, it.path.box.x1, it.path.box.y1); });
        return {
          list, box: b, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, r: Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2,
          entry: (a) => Math.min(...list.slice(0, 8).map((it) => entryOf(it.path, a).d)),
          exit: () => endOf(list[0].path)
        };
      });
      let partNo = 0;
      for (const u of sequence(units, at, order)) {
        partNo++;
        // inside the part: deepest holes first, outline last
        const byDepth = u.list.slice().sort((a, b) => (b.depth || 0) - (a.depth || 0) || a.n - b.n);
        const groups = [];
        byDepth.forEach((it) => {
          const g = groups[groups.length - 1];
          if (g && g.d === (it.depth || 0)) g.items.push(it);
          else groups.push({ d: it.depth || 0, items: [it] });
        });
        for (const g of groups) emit(sequence(g.items.map(pathUnit), at, order === 'file' ? 'file' : 'speed').map((x) => x.it), out, 'p' + partNo + 'd' + g.d);
      }
      return out;
    }
    emit(sequence(items.map(pathUnit), at, order).map((u) => u.it), out);
    return out;
  }

  // ---------------------------------------------------------------- estimator
  // Beds a plotter job uses (loop rather than Math.max(...) — jobs can hold 100k+ entities).
  function bedCount(job) {
    let n = Math.max(1, job.beds || 1);
    for (const e of job.entities || []) if ((e.bed || 0) + 1 > n) n = (e.bed || 0) + 1;
    return n;
  }

  const DEFAULTS = {
    laser: { speed: 1000, acc: 10000 },
    plotter: { speed: 1000, acc: 8000, toolDown: 0.15, toolUp: 0.12, toolChange: 8, feedSpeed: 200, feedSettle: 3, dashLift: 0.08 }
  };

  /**
   * Estimate a job on a machine. Returns the total time, a per-process
   * breakdown, motion statistics and (with opts.timeline) the ordered list of
   * operations the Simulation page animates.
   */
  function estimate(job, machine, opts) {
    opts = opts || {};
    const isLaser = (machine && machine.type ? machine.type : job.machineType) !== 'plotter';
    const info = (machine && machine.info) || {};
    const D = isLaser ? DEFAULTS.laser : DEFAULTS.plotter;
    const vMax = Number(info.speed) || D.speed;
    const acc = Number(info.acc) || D.acc;
    const plot = { ...DEFAULTS.plotter, ...(info.timing || {}) };
    const order = processOrder(job, isLaser);
    const ents = (job.entities || []).filter((e) => !e.hidden && !e.isRegMark);
    const nBeds = isLaser ? 1 : bedCount(job);
    const feedLen = Number(info.feedLen) || (info.bed ? info.bed[1] : 1000);

    const per = job.processes.map((p, i) => ({ idx: i, name: p.name, time: 0, cut: 0, travel: 0, area: 0, ops: 0 }));
    const timeline = [];
    let t = 0, travel = 0, travelT = 0, cutLen = 0, engArea = 0, toolChanges = 0, feeds = 0;
    const trav = { fromOrigin: 0, between: 0, toOrigin: 0 };
    const cut = cutOrderOf(job);
    // the head starts (and ends) at the machine's origin corner
    const bedSize = bedOf(machine);
    const o = info.origin || 'tl';
    const home = [o.includes('r') ? bedSize[0] : 0, o.includes('b') ? bedSize[1] : 0];
    const vTravel = Math.min(vMax, Number(info.travelSpeed) || vMax);
    let at = home;
    let first = true;
    let curTool = null;
    const push = (o2) => {
      if (opts.timeline) timeline.push({ ...o2, start: t, end: t + o2.dur });
      t += o2.dur;
    };
    const travelTo = (pt, bedNo, proc, kind) => {
      const d = Math.hypot(pt[0] - at[0], pt[1] - at[1]);
      if (d < 1e-6) return;
      const dur = travelTime(d, vTravel, acc);
      const leg = kind || (first ? 'fromOrigin' : 'between');
      first = false;
      travel += d;
      travelT += dur;
      trav[leg] += dur;
      if (proc >= 0) per[proc].travel += d;
      push({ kind: 'travel', leg, proc, bed: bedNo, dur, from: at, to: pt });
      at = pt;
    };

    // Passes repeat a whole group back to back before the next group starts:
    // an engraving is engraved, then engraved again; cut paths go in groups —
    // all the inside shapes of a layer (or of one part), every one of them once,
    // then all of them again, then the outlines once, then again. On a plotter
    // this all happens per bed, before the conveyor moves on.
    const passesOf = (proc) => Math.max(1, Math.round(Number(proc.passes) || 1));
    // Run order: registration marks are read first (the camera visits each
    // mark), then engraving, then cutting (processOrder).
    let inspectTime = 0, dwellTime = 0;
    const regIdx = job.processes.findIndex(isRegProc);
    const markTime = Number(info.markTime) || 1.5;
    // where the work begins, seen from the machine origin: the first item to
    // run (as drawn) or the one nearest the origin
    const workStart = () => {
      for (const pi of order) {
        const mine = ents.filter((e) => (job.processes[pi].aci || []).includes(e.aci) && (isLaser || !(e.bed || 0)));
        if (!mine.length) continue;
        let best = null, bd = Infinity;
        for (const e of cut.order === 'file' ? mine.slice(0, 1) : mine) {
          const b = entityBox(e);
          const q = [Math.max(b.x0, Math.min(home[0], b.x1)), Math.max(b.y0, Math.min(home[1], b.y1))];
          const d = Math.hypot(q[0] - home[0], q[1] - home[1]);
          if (d < bd) { bd = d; best = q; }
        }
        return best;
      }
      return home;
    };
    // read the marks in the order with the least travel that ends nearest
    // where the work begins, so the job then runs from that end
    const marks = (() => {
      const list = isLaser ? regMarks(job, machine) : [];
      if (list.length < 2 || list.length > 6) return list;
      const end = workStart();
      const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      let best = list, bd = Infinity;
      const perm = (done, left) => {
        if (!left.length) {
          let d = dist(home, [done[0].x, done[0].y]);
          for (let i = 1; i < done.length; i++) d += dist([done[i - 1].x, done[i - 1].y], [done[i].x, done[i].y]);
          d += dist([done[done.length - 1].x, done[done.length - 1].y], end);
          if (d < bd - 1e-9) { bd = d; best = done; }
          return;
        }
        left.forEach((m, i) => perm(done.concat([m]), left.filter((_, k) => k !== i)));
      };
      perm([], list);
      return best;
    })();
    marks.forEach((m, i) => {
      travelTo([m.x, m.y], 0, -1);
      inspectTime += markTime;
      push({ kind: 'inspect', proc: regIdx, bed: 0, dur: markTime, at: [m.x, m.y], d: m.d, mark: i + 1, of: marks.length });
    });
    for (let bed = 0; bed < nBeds; bed++) {
      const bedEnts = isLaser ? ents : ents.filter((e) => (e.bed || 0) === bed);
      const work = order.map((pi) => ({ pi, mine: bedEnts.filter((e) => (job.processes[pi].aci || []).includes(e.aci)) })).filter((w) => w.mine.length);
      const cache = new Map();
      for (const { pi, mine } of work) runPass(bed, pi, job.processes[pi], mine, passesOf(job.processes[pi]), cache);
      if (!isLaser && bed < nBeds - 1) {
        const dur = travelTime(feedLen, plot.feedSpeed, 500) + plot.feedSettle;
        feeds++;
        push({ kind: 'feed', proc: -1, bed, dur });
        at = home;
      }
    }
    // return to origin at the end
    if (t > 0) travelTo(home, nBeds - 1, -1, 'toOrigin');

    // Fastest: each item's passes back to back, or every item once and then
    // every item again — whichever needs less travel and waiting (a dwell
    // between passes is paid once per round instead of once per item).
    function backToBack(units, startOf, endOf, passes, dwell) {
      if (passes < 2) return true;
      const tt = (a, b) => travelTime(Math.hypot(a[0] - b[0], a[1] - b[1]), vTravel, acc);
      let item = 0, group = 0, p = at;
      for (const u of units) { item += tt(p, startOf(u)) + (passes - 1) * (dwell + tt(endOf(u), startOf(u))); p = endOf(u); }
      p = at;
      for (let k = 1; k <= passes; k++) {
        if (k > 1) group += dwell;
        for (const u of units) { group += tt(p, startOf(u)); p = endOf(u); }
      }
      return item <= group;
    }

    // One process on one bed, with all its passes.
    function runPass(bed, pi, proc, mine, passes, cache) {
      const passNo = (k) => (passes > 1 ? k : null);
      // laser processes can wait between passes (the head stays put, the beam off)
      const dwell = isLaser ? Math.max(0, Number(proc.dwell) || 0) : 0;
      const dwellBefore = (k) => {
        if (k < 2 || !dwell) return;
        dwellTime += dwell;
        push({ kind: 'dwell', proc: pi, bed, dur: dwell, pass: k });
      };
      const speed = Math.max(0.1, Math.min(Number(proc.speed) || 1, vMax));
      if (!isLaser) {
        const slot = toolSlot(proc.tool);
        if (curTool !== null && slot !== curTool) {
          toolChanges++;
          push({ kind: 'change', proc: pi, bed, dur: plot.toolChange, tool: slot });
          per[pi].time += plot.toolChange;
        }
        curTool = slot;
      }

      if (isLaser && proc.proc === 'Engrave') {
        // each separate island of artwork is engraved on its own, unless one
        // side-to-side scan across islands at the same height is quicker
        const dpi = Number(proc.f) || 500;
        const over = (speed * speed) / (2 * acc);
        const scan = engraveScan(proc);
        // an island's scan lines run top down, or bottom up (reversed)
        const rowsOf = (r, up) => (up ? r.rowsUp || (r.rowsUp = r.rows.slice().reverse()) : r.rows);
        const startAt = (rows) => [rows[0][1] - over, rows[0][0]];
        const endAt = (rows) => { const l = rows[rows.length - 1]; return [scan.uni || rows.length % 2 ? l[2] + over : l[1] - over, l[0]]; };
        const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
        // bottom up when set, or for "fastest" when the bottom line is nearer the head
        const goesUp = (r, from) => scan.dir === 'up' || (scan.dir === 'fastest' && dist(startAt(rowsOf(r, true)), from) < dist(startAt(r.rows), from));
        let isl = cache.get(pi);
        if (!isl) {
          isl = rasterBands(rasterIslands(mine, dpi, speed, acc, opts.timeline, undefined, scan.uni, vTravel), mine, dpi, speed, acc, vTravel, opts.timeline, scan.uni);
          isl.forEach((r) => { per[pi].area += r.area; engArea += r.area; });
          // order the islands like cuts: as drawn, or nearest next
          if (cut.order !== 'file') {
            const left = isl.slice(), out = [];
            let p0 = at;
            while (left.length) {
              let bi = 0, bd = Infinity;
              left.forEach((r, i) => { const d = dist(startAt(rowsOf(r, goesUp(r, p0))), p0); if (d < bd) { bd = d; bi = i; } });
              const r = left.splice(bi, 1)[0];
              out.push(r);
              p0 = endAt(rowsOf(r, goesUp(r, p0)));
            }
            isl = out;
          }
          cache.set(pi, isl);
        }
        const engrave = (r, k) => {
          const up = goesUp(r, at);
          const rows = rowsOf(r, up);
          travelTo(startAt(rows), bed, pi);
          per[pi].time += r.dur;
          per[pi].ops++;
          push({ kind: 'op', mode: 'raster', proc: pi, bed, dur: r.dur, box: r.b, rows: rows.length, step: r.step, ys: up && r.ys ? r.ys.slice().reverse() : r.ys, dir: up ? 'up' : 'down', uni: scan.uni, dpi, passes: 1, pass: passNo(k), ents: r.ents, shared: r.shared || 0 });
          at = endAt(rows);
        };
        // fastest: each island's passes back to back unless whole rounds are
        // quicker; otherwise every island once, then every island again
        const rStart = (r) => startAt(rowsOf(r, scan.dir === 'up'));
        const rEnd = (r) => endAt(rowsOf(r, scan.dir === 'up'));
        if (cut.order === 'speed' && backToBack(isl, rStart, rEnd, passes, dwell)) isl.forEach((r) => { for (let k = 1; k <= passes; k++) { dwellBefore(k); engrave(r, k); } });
        else for (let k = 1; k <= passes; k++) { dwellBefore(k); isl.forEach((r) => engrave(r, k)); }
        return;
      }

      // the cut order is worked out once and repeated on later passes
      let ordered = cache.get(pi);
      if (!ordered) {
        const items = [];
        mine.forEach((e) => e.paths.forEach((path, k) => items.push({ ent: e.id, k, path })));
        ordered = orderPaths(items, {
          nest: isLaser ? proc.proc === 'Cut' : /Knife/.test(proc.tool || ''),
          inside: cut.inside, order: cut.order, start: at
        });
        cache.set(pi, ordered);
      }
      // consecutive paths of the same group (nesting layer / part layer) form a block
      const blocks = [];
      for (const it of ordered) {
        const b = blocks[blocks.length - 1];
        if (b && b.key === it.blk) b.items.push(it);
        else blocks.push({ key: it.blk, items: [it] });
      }
      const cutOne = (it, k) => {
        const p = it.path.p;
        if (p.length < 2) return;
        travelTo(p[0], bed, pi);
        const L = polyLen(p, it.path.c);
        let dur = polyTime(p, it.path.c, speed, acc);
        if (!isLaser) {
          dur += plot.toolDown + plot.toolUp;
          if (proc.dash) dur += Math.floor(L / Math.max(0.5, (Number(proc.dl) || 5) + (Number(proc.gl) || 2))) * plot.dashLift;
        }
        cutLen += L;
        per[pi].cut += L;
        per[pi].time += dur;
        per[pi].ops++;
        push({ kind: 'op', mode: 'vector', proc: pi, bed, dur, ent: it.ent, path: it.path, len: L, passes: 1, pass: passNo(k) });
        at = it.path.c ? p[0] : p[p.length - 1];
      };
      for (const blk of blocks) {
        // fastest: repeat each path straight away (a closed path ends where it
        // starts, so the next pass needs no travel); otherwise the whole group
        // once, then the whole group again
        const live = blk.items.filter((it) => it.path.p.length >= 2);
        const vEnd = (it) => (it.path.c ? it.path.p[0] : it.path.p[it.path.p.length - 1]);
        if (cut.order === 'speed' && backToBack(live, (it) => it.path.p[0], vEnd, passes, dwell)) live.forEach((it) => { for (let k = 1; k <= passes; k++) { dwellBefore(k); cutOne(it, k); } });
        else for (let k = 1; k <= passes; k++) { dwellBefore(k); blk.items.forEach((it) => cutOne(it, k)); }
      }
    }

    return {
      total: t,
      perProcess: per.filter((p) => p.ops > 0),
      travel, travelTime: travelT, travelLegs: trav, home, cutOrder: cut, inspectTime, dwellTime, marks: marks.length,
      cutLen, engArea, toolChanges, feeds, beds: nBeds,
      machine: { speed: vMax, acc },
      timeline: opts.timeline ? timeline : undefined
    };
  }

  // Head position at time t along a timeline (for the Simulation page).
  function headAt(timeline, t) {
    if (!timeline.length) return { x: 0, y: 0, op: null, i: -1 };
    let lo = 0, hi = timeline.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (timeline[mid].end <= t) lo = mid + 1;
      else hi = mid;
    }
    const op = timeline[lo];
    const f = op.dur > 0 ? Math.max(0, Math.min(1, (t - op.start) / op.dur)) : 1;
    let x = 0, y = 0;
    if (op.kind === 'travel') {
      x = op.from[0] + (op.to[0] - op.from[0]) * f;
      y = op.from[1] + (op.to[1] - op.from[1]) * f;
    } else if (op.kind === 'op' && op.mode === 'vector') {
      const p = op.path.c ? op.path.p.concat([op.path.p[0]]) : op.path.p;
      let want = f * (op.len || polyLen(op.path.p, op.path.c));
      x = p[0][0]; y = p[0][1];
      for (let i = 1; i < p.length; i++) {
        const l = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
        if (want <= l) {
          const k = l ? want / l : 0;
          x = p[i - 1][0] + (p[i][0] - p[i - 1][0]) * k;
          y = p[i - 1][1] + (p[i][1] - p[i - 1][1]) * k;
          break;
        }
        want -= l;
        x = p[i][0]; y = p[i][1];
      }
    } else if (op.kind === 'inspect') {
      x = op.at[0]; y = op.at[1];
    } else if (op.kind === 'op' && op.mode === 'raster') {
      const b = op.box;
      const rows = Math.max(1, op.rows);
      const r = Math.min(rows - 1, Math.floor(f * rows));
      const fr = f * rows - r;
      // both ways: alternate lines run back; one way: every line left to right
      x = b.x0 + (b.x1 - b.x0) * (!op.uni && r % 2 ? 1 - fr : fr);
      if (op.ys && op.ys.length) {
        const k = Math.min(op.ys.length - 1, Math.floor((r / rows) * op.ys.length));
        y = op.ys[k];
      } else {
        const k = r / Math.max(1, rows - 1);
        y = op.dir === 'up' ? b.y1 - (b.y1 - b.y0) * k : b.y0 + (b.y1 - b.y0) * k;
      }
    } else {
      const prev = timeline[lo - 1];
      const pt = prev ? (prev.kind === 'travel' ? prev.to : headAt(timeline, prev.end - 1e-9)) : { x: 0, y: 0 };
      x = Array.isArray(pt) ? pt[0] : pt.x;
      y = Array.isArray(pt) ? pt[1] : pt.y;
    }
    return { x, y, op, i: lo, f };
  }

  function fmtDuration(s, long) {
    s = Math.max(0, Math.round(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (!long) return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
    if (h) return h + ' h ' + String(m).padStart(2, '0') + ' min';
    if (m) return m + ' min ' + String(sec).padStart(2, '0') + ' s';
    return sec + ' s';
  }
  const fmtLen = (mm) => (mm >= 1000 ? (mm / 1000).toFixed(1) + ' m' : Math.round(mm) + ' mm');
  // areas in mm², switching to m² from one square metre
  const fmtArea = (mm2) => (mm2 >= 1e6 ? (mm2 / 1e6).toFixed(2) + ' m²' : Math.round(mm2 || 0).toLocaleString('en-GB') + ' mm²');

  // A material's presets for one machine: its own list (each machine can
  // need different power settings), else the shared list for its type.
  function presetsFor(mat, machine) {
    if (!mat || !mat.presets || !machine) return [];
    const own = mat.presets[machine.id];
    return Array.isArray(own) ? own : mat.presets[machine.type] || [];
  }

  // ---------------------------------------------------------------- default presets
  // Starting presets for a material, scaled by thickness (mm).
  function defaultPresets(type, t) {
    t = Number(t) || 3;
    if (type === 'plotter') {
      const ks = Math.max(150, Math.round(450 - t * 30));
      return [
        { name: 'Knife through', tool: 'T1 · Knife', speed: ks, passes: t > 4 ? 2 : 1, dash: false, dl: 5, gl: 2, out: true, aci: [1] },
        { name: 'Perforate', tool: 'T1 · Knife', speed: ks, passes: 1, dash: true, dl: 8, gl: 2, out: true, aci: [6] },
        { name: 'V-cut 45°', tool: 'T2 · V-cut 45°', speed: 250, passes: 1, dash: false, dl: 5, gl: 2, out: true, aci: [5] },
        { name: 'Crease', tool: 'T3 · Crease wheel', speed: 300, passes: 1, dash: false, dl: 5, gl: 2, out: true, aci: [3] },
        { name: 'Pen', tool: 'T4 · Pen', speed: 500, passes: 1, dash: false, dl: 5, gl: 2, out: false, aci: [7, 8] }
      ].map((p) => ({ ...p, adv: {} }));
    }
    const cs = Math.max(4, Math.round(60 / t));
    return [
      { name: 'Cut contour', proc: 'Cut', power: 90, speed: cs, f: 5000, passes: 1, air: 'On', dash: false, dl: 5, gl: 2, out: true, aci: [1, 6] },
      { name: 'Tear-off line', proc: 'Cut', power: 90, speed: cs, f: 5000, passes: 1, air: 'On', dash: true, dl: 4, gl: 1, out: true, aci: [3] },
      { name: 'Engrave outline', proc: 'Engrave', power: 45, speed: 300, f: 500, passes: 1, air: 'Off', dash: false, dl: 5, gl: 2, out: true, aci: [5] },
      { name: 'Engrave fill', proc: 'Engrave', power: 60, speed: 400, f: 500, passes: 1, air: 'Off', dash: false, dl: 5, gl: 2, out: true, aci: [7] },
      { name: 'Kiss cut', proc: 'Cut', power: 40, speed: cs * 3, f: 5000, passes: 1, air: 'On', dash: false, dl: 5, gl: 2, out: false, aci: [] }
    ].map((p) => ({ ...p, adv: {} }));
  }

  // Starting presets for metal sheet. On a CO2 laser bare metal is marked
  // through a marking spray/coating (anodised aluminium marks directly);
  // cutting needs a fibre source or very thin sheet, hence the slow cut.
  function metalPresets(t) {
    t = Number(t) || 1;
    return [
      { name: 'Cut contour', proc: 'Cut', power: 100, speed: Math.max(1, Math.round(10 / t)), f: 5000, passes: t > 1 ? 2 : 1, air: 'On', dash: false, dl: 5, gl: 2, out: true, aci: [1, 6] },
      { name: 'Engrave outline', proc: 'Engrave', power: 90, speed: 150, f: 500, passes: 1, air: 'Off', dash: false, dl: 5, gl: 2, out: true, aci: [5] },
      { name: 'Engrave fill', proc: 'Engrave', power: 100, speed: 120, f: 600, passes: 1, air: 'Off', dash: false, dl: 5, gl: 2, out: true, aci: [7] }
    ].map((p) => ({ ...p, adv: {} }));
  }

  // ---------------------------------------------------------------- thermal
  // Reference properties, fixed (not editable per material): density kg/m³,
  // specific heat J/kg·K, conductivity W/m·K, the temperature where the
  // material is damaged, and absorption of the beam (CO2 10.6 µm / fibre
  // 1.06 µm, room-temperature values from Steen & Mazumder, Laser Material
  // Processing). `src` names where the bulk values come from.
  const THERMAL = {
    acrylic: { name: 'Cast acrylic (PMMA)', rho: 1190, c: 1470, k: 0.19, aCO2: 0.95, aFiber: 0.1, limit: 105, limitLabel: 'softens (glass transition)', src: 'Evonik PLEXIGLAS GS technical data' },
    wood: { name: 'Plywood', rho: 680, c: 1600, k: 0.17, aCO2: 0.9, aFiber: 0.3, limit: 250, limitLabel: 'scorches', src: 'EN ISO 10456 (plywood); charring ≈ 250 °C' },
    mdf: { name: 'MDF / fibreboard', rho: 750, c: 1700, k: 0.17, aCO2: 0.9, aFiber: 0.3, limit: 250, limitLabel: 'scorches', src: 'EN ISO 10456 (fibreboard); charring ≈ 250 °C' },
    card: { name: 'Paper board', rho: 700, c: 1340, k: 0.07, aCO2: 0.85, aFiber: 0.3, limit: 230, limitLabel: 'can ignite', src: 'Engineering ToolBox (paper/cardboard); paper ignition ≈ 230 °C' },
    foam: { name: 'Polystyrene foam board', rho: 30, c: 1300, k: 0.035, aCO2: 0.8, aFiber: 0.2, limit: 90, limitLabel: 'foam melts', src: 'EN ISO 10456 (EPS); polystyrene softens ≈ 90–100 °C' },
    film: { name: 'Polyester film (PET)', rho: 1390, c: 1170, k: 0.15, aCO2: 0.9, aFiber: 0.1, limit: 150, limitLabel: 'film shrinks', src: 'DuPont Teijin Mylar physical properties' },
    magnetic: { name: 'Flexible magnet (ferrite in rubber)', rho: 3600, c: 900, k: 0.5, aCO2: 0.9, aFiber: 0.5, limit: 85, limitLabel: 'demagnetises', src: 'Typical flexible-magnet data sheets (max. working 85 °C)' },
    ss304: { name: 'Stainless steel 304', rho: 8000, c: 500, k: 16.2, aCO2: 0.1, aFiber: 0.35, limit: 1400, limitLabel: 'melts', src: 'AISI 304 data (ASM Handbook); melts 1400–1450 °C' },
    ss316: { name: 'Stainless steel 316', rho: 8000, c: 500, k: 16.3, aCO2: 0.1, aFiber: 0.35, limit: 1375, limitLabel: 'melts', src: 'AISI 316 data (ASM Handbook); melts 1375–1400 °C' },
    mildsteel: { name: 'Mild steel (1018)', rho: 7870, c: 486, k: 51.9, aCO2: 0.1, aFiber: 0.35, limit: 1420, limitLabel: 'melts', src: 'AISI 1018 data (ASM Handbook); melts ≈ 1420–1460 °C' },
    aluminium: { name: 'Aluminium 5052', rho: 2680, c: 880, k: 138, aCO2: 0.03, aFiber: 0.1, limit: 607, limitLabel: 'melts', src: 'Aluminium 5052-H32 data (ASM Handbook); melts 607–650 °C' },
    anodised: { name: 'Anodised aluminium 5005', rho: 2700, c: 900, k: 200, aCO2: 0.8, aFiber: 0.3, limit: 632, limitLabel: 'melts', src: 'Aluminium 5005 data (ASM Handbook); the oxide layer absorbs 10.6 µm' },
    brass: { name: 'Brass C26000', rho: 8530, c: 375, k: 120, aCO2: 0.03, aFiber: 0.1, limit: 915, limitLabel: 'melts', src: 'C26000 cartridge brass (Copper Development Association); melts 915–955 °C' }
  };
  // Reference properties for a material, matched on its name and group.
  // Values stored on a material are ignored; no match means no thermal data.
  function thermalKey(mat) {
    const n = (((mat && mat.name) || '') + ' ' + ((mat && mat.g) || '')).toLowerCase();
    if (/anodi/.test(n)) return 'anodised';
    if (/alumin/.test(n)) return 'aluminium';
    if (/316/.test(n)) return 'ss316';
    if (/stainless|304/.test(n)) return 'ss304';
    if (/steel/.test(n)) return 'mildsteel';
    if (/brass/.test(n)) return 'brass';
    if (/acryl|pmma|perspex|plexi/.test(n)) return 'acrylic';
    if (/mdf|fibreboard|fiberboard|hardboard/.test(n)) return 'mdf';
    if (/foam|polystyrene/.test(n)) return 'foam';
    if (/magnet/.test(n)) return 'magnetic';
    if (/film|polyester|\bpet\b|mylar/.test(n)) return 'film';
    if (/board|card|grey|paper/.test(n)) return 'card';
    if (/wood|ply|birch|oak|poplar|bamboo/.test(n)) return 'wood';
    return null;
  }
  function thermalOf(mat) {
    const key = thermalKey(mat);
    return key ? { key, ...THERMAL[key] } : null;
  }

  /**
   * Heat build-up in the sheet during a job. The sheet is split into cells;
   * the laser's absorbed power (rated power × process power × absorption,
   * less the part carried off with the cut/vaporised material) is added at
   * the head as it moves along the simulated toolpath, then the heat spreads
   * through the material and is lost to the air from both faces.
   * Temperatures are cell averages (a few mm across), not the spot itself.
   */
  function thermalSim(job, machine, material, timeline) {
    const info = (machine && machine.info) || {};
    const props = thermalOf(material);
    if (!props) return null;
    const fibre = /fib/i.test(info.source || '');
    const absorb = fibre ? props.aFiber : props.aCO2;
    const rated = Number(info.power) || 80;
    const t_m = Math.max(0.1, Number(material && material.t) || 3) / 1000;
    // Every laser has a robust extraction system, so the sheet is cooled by
    // forced airflow rather than still air (h ≈ 10 W/m²·K): ≈ 50 W/m²·K across
    // the top and ≈ 25 underneath, where the air is drawn through the bed.
    const T0 = 20, hTop = 50, hBottom = 25;
    // area covered by the job (+ margin)
    const b = boxOf((job.entities || []).filter((e) => !e.hidden));
    if (!boxValid(b) || !timeline || !timeline.length) return null;
    const pad = 15;
    const x0 = b.x0 - pad, y0 = b.y0 - pad, W = b.x1 - b.x0 + 2 * pad, H = b.y1 - b.y0 + 2 * pad;
    const total = timeline[timeline.length - 1].end;
    const a = props.k / (props.rho * props.c); // m²/s
    let dx = Math.max(1, Math.max(W, H) / 110);
    // keep the work bounded: coarser cells for very conductive metals or long jobs
    for (;;) {
      const dxm = dx / 1000, dt = Math.min(0.25, (0.2 * dxm * dxm) / a);
      const work = (total / dt) * Math.ceil(W / dx) * Math.ceil(H / dx);
      if (work < 1.5e8 || dx > 40) break;
      dx *= 1.4;
    }
    const nx = Math.max(2, Math.ceil(W / dx)), ny = Math.max(2, Math.ceil(H / dx));
    const dxm = dx / 1000;
    const dt = Math.min(0.25, (0.2 * dxm * dxm) / a);
    const C = props.rho * props.c * dxm * dxm * t_m; // J/K per cell
    const cool = (hTop + hBottom) / (props.rho * props.c * t_m); // 1/s
    const lam = (a * dt) / (dxm * dxm);
    // fastest head speed in the job, to sample the head often enough
    const vmax = Math.max(50, ...job.processes.map((p) => Number(p.speed) || 0));
    const samples = Math.max(1, Math.min(200, Math.ceil((dt * vmax) / (dx / 2))));
    const powerOf = (op) => {
      const p = job.processes[op.proc];
      if (!p || op.kind !== 'op') return 0;
      // most of a cut's energy leaves with the vaporised material; engraving keeps more
      const residual = p.proc === 'Cut' ? 0.3 : 0.45;
      return rated * ((Number(p.power) || 0) / 100) * absorb * residual;
    };
    let T = new Float32Array(nx * ny).fill(T0), N = new Float32Array(nx * ny);
    let time = 0, peak = T0, peakAt = 0;
    const snaps = [{ time: 0, T: T.slice(), peak, peakAt }];
    const step = () => {
      // heat from the beam
      for (let s = 1; s <= samples; s++) {
        const hd = headAt(timeline, time + (dt * s) / samples);
        const P = hd.op ? powerOf(hd.op) : 0;
        if (!P) continue;
        const i = Math.floor((hd.x - x0) / dx), j = Math.floor((hd.y - y0) / dx);
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        T[j * nx + i] += (P * dt) / samples / C;
      }
      // spread and cool (insulated edges)
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i, v = T[k];
          const l = i > 0 ? T[k - 1] : v, r = i < nx - 1 ? T[k + 1] : v, u = j > 0 ? T[k - nx] : v, d = j < ny - 1 ? T[k + nx] : v;
          N[k] = v + lam * (l + r + u + d - 4 * v) - dt * cool * (v - T0);
        }
      }
      const tmp = T; T = N; N = tmp;
      time += dt;
      for (let k = 0; k < T.length; k++) if (T[k] > peak) { peak = T[k]; peakAt = time; }
      if (time - snaps[snaps.length - 1].time >= 5) snaps.push({ time, T: T.slice(), peak, peakAt });
    };
    const api = {
      nx, ny, dx, x0, y0, T0, props, absorb, fibre, cellMm: dx,
      get T() { return T; }, get time() { return time; }, get peak() { return peak; }, get peakAt() { return peakAt; },
      // advance (or rewind to a snapshot and advance) to time t
      to(t) {
        t = Math.max(0, Math.min(total, t));
        if (t < time) {
          let s = snaps[0];
          for (const x of snaps) if (x.time <= t) s = x;
          T = s.T.slice(); time = s.time; peak = s.peak; peakAt = s.peakAt;
          snaps.length = snaps.indexOf(s) + 1;
        }
        while (time + dt <= t) step();
        return api;
      },
      at(x, y) {
        const i = Math.floor((x - x0) / dx), j = Math.floor((y - y0) / dx);
        return i < 0 || j < 0 || i >= nx || j >= ny ? T0 : T[j * nx + i];
      },
      max() { let m = T0; for (let k = 0; k < T.length; k++) if (T[k] > m) m = T[k]; return m; }
    };
    return api;
  }

  // ---------------------------------------------------------------- reg marks
  const bedOf = (machine) => (machine && machine.info && machine.info.bed) || (machine && machine.type === 'plotter' ? [1600, 1000] : [813, 508]);
  const REG_NEEDED = { pos: 2, linear: 3, nonlinear: 3 };
  // Colours assigned to the reg-mark process, while reg marks are switched on.
  function regMarkAci(job) {
    if (!job.regMode || job.regMode === 'off') return new Set();
    return new Set(job.processes.filter(isRegProc).flatMap((p) => p.aci || []));
  }
  // Print-and-cut registration marks: the objects drawn in a reg-mark colour
  // (nothing is placed automatically). Each mark is reported by its centre.
  function regMarks(job, machine) {
    if (machine && machine.type === 'plotter') return [];
    const acis = regMarkAci(job);
    if (!acis.size) return [];
    return (job.entities || []).filter((e) => !e.hidden && acis.has(e.aci)).map((e) => {
      const b = entityBox(e);
      return { id: e.id, x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, d: Math.max(b.x1 - b.x0, b.y1 - b.y0) };
    });
  }
  // A new reg-mark process (added when reg marks are switched on).
  const regProcess = () => ({ name: 'Registration marks', proc: REG_PROC, power: 0, speed: 0, f: 0, passes: 1, dash: false, dl: 5, gl: 2, out: true, aci: [], adv: {}, src: 'job' });

  // ---------------------------------------------------------------- job checks
  function checkJob(job, machine) {
    const isLaser = machine ? machine.type !== 'plotter' : true;
    const bed = (machine && machine.info && machine.info.bed) || (isLaser ? [813, 508] : [1600, 1000]);
    const ents = (job.entities || []).filter((e) => !e.hidden);
    const out = [];
    const used = new Set(ents.filter((e) => !e.isRegMark).map((e) => e.aci));
    const assigned = new Set(job.processes.flatMap((p) => p.aci || []));
    const orphan = [...used].filter((a) => !assigned.has(a));
    if (!ents.length) out.push({ ok: false, l: 'No objects in job' });
    const b = boxOf(ents);
    if (ents.length) {
      const inside = b.x0 >= -0.01 && b.y0 >= -0.01 && b.x1 <= bed[0] + 0.01 && b.y1 <= bed[1] + 0.01;
      out.push(inside ? { ok: true, l: isLaser ? 'Job inside bed' : 'Parts inside bed edges' } : { ok: false, l: 'Objects outside the bed' });
    }
    if (orphan.length) out.push({ ok: false, l: 'No process for ACI ' + orphan.join(', ') });
    if (isLaser) {
      const cutAci = new Set(job.processes.filter((p) => p.proc === 'Cut' && p.out !== false).flatMap((p) => p.aci || []));
      // open lines are fine (tear-off lines, perforations); a contour whose ends
      // almost meet is usually a drawing error that leaves the part attached
      let open = 0, nearly = 0;
      for (const e of ents) {
        if (!cutAci.has(e.aci)) continue;
        for (const p of e.paths) {
          if (p.c) continue;
          open++;
          if (p.p.length < 2) continue;
          const a = p.p[0], z = p.p[p.p.length - 1];
          const gap = Math.hypot(a[0] - z[0], a[1] - z[1]);
          if (p.p.length > 2 && gap > 0.001 && gap < 1) nearly++;
        }
      }
      if (ents.length && cutAci.size) {
        out.push(nearly ? { ok: false, warn: true, l: nearly + ' cut contour' + (nearly > 1 ? 's' : '') + ' not quite closed' }
          : { ok: true, l: open ? 'Cut paths OK · ' + open + ' open line' + (open > 1 ? 's' : '') : 'All cut paths closed' });
      }
      if (job.regMode && job.regMode !== 'off') {
        const need = REG_NEEDED[job.regMode] || 3;
        const have = regMarks(job, machine).length;
        const name = { pos: 'Position & rotation', linear: 'Full linear', nonlinear: 'Non-linear' }[job.regMode] || job.regMode;
        // too many marks is ambiguous for the camera, so the job can't be sent
        if (have > need) out.push({ ok: false, block: true, l: 'Registration marks · ' + have + ' found, ' + name + ' uses ' + need + ' — remove ' + (have - need) });
        else out.push(have === need ? { ok: true, l: 'Registration marks · ' + have + ' · ' + name }
          : { ok: false, warn: true, l: 'Registration marks · ' + have + ' of ' + need + ' — give the marks a Registration marks colour' });
      }
    }
    return out;
  }

  return {
    ACI_HEX, ACI_NAMES, aciHex, aciName, aciFg, aciStroke, rgbToAci, hexToRgb,
    uid, EMPTY_BOX, growBox, entityBox, boxOf, boxValid, boxW, boxH,
    mapEntity, translate, scaleAbout, rotateAbout, polyLen, polyArea, pointInPoly, distToEntity, isClosedPts, cleanPath, shapes,
    processOrder, processOfAci, toolSlot, toolRank, polyTime, travelTime, rasterSpans, orderPaths,
    estimate, headAt, fmtDuration, fmtLen, fmtArea, checkJob, regMarks, regMarkAci, regProcess, isRegProc, REG_PROC, REG_NEEDED,
    cutOrderOf, CUT_ORDER_DEFAULT, bedOf, bedCount, defaultPresets, DEFAULTS,
    rasterIslands, engraveScan, ENGRAVE_DIRS, nestRects, THERMAL, thermalKey, thermalOf, thermalSim, metalPresets, presetsFor
  };
});
