// A small QR code maker for the authenticator app's setup link (Settings, Pathline Prepare): byte
// mode, error correction M, sizes 1 to 10 (up to 213 bytes). Draws an SVG. No packages.
(function () {
  'use strict';
  // per size: error correction codewords per block, then (blocks, data codewords) once or twice
  const EC = [null, [10, 1, 16], [16, 1, 28], [26, 1, 44], [18, 2, 32], [24, 2, 43], [16, 4, 27], [18, 4, 31], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  // arithmetic in GF(256), for the Reed-Solomon error correction
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  function ecc(data, n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
      g = next;
    }
    const r = data.concat(new Array(n).fill(0));
    for (let i = 0; i < data.length; i++) { const c = r[i]; if (c) for (let j = 0; j < g.length; j++) r[i + j] ^= mul(g[j], c); }
    return r.slice(data.length);
  }
  const blocksOf = (v) => { const e = EC[v], list = []; for (let i = 1; i < e.length; i += 2) for (let k = 0; k < e[i]; k++) list.push(e[i + 1]); return list; };
  const capOf = (v) => blocksOf(v).reduce((a, b) => a + b, 0);
  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
  ];

  // a lower score is easier to read (the standard's four rules)
  function penalty(m) {
    const n = m.length;
    let p = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < n; a++) {
        let run = 0, prev = null, s = '';
        for (let b = 0; b < n; b++) {
          const d = pass ? m[b][a] : m[a][b];
          s += d ? '1' : '0';
          if (d === prev) run++; else { if (run >= 5) p += run - 2; run = 1; prev = d; }
        }
        if (run >= 5) p += run - 2;
        for (const pat of ['10111010000', '00001011101']) for (let k = s.indexOf(pat); k >= 0; k = s.indexOf(pat, k + 1)) p += 40;
      }
    }
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) { const d = m[y][x]; if (d === m[y][x + 1] && d === m[y + 1][x] && d === m[y + 1][x + 1]) p += 3; }
    let dark = 0;
    for (const r of m) for (const d of r) if (d) dark++;
    return p + Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
  }

  // { version, mask, modules: rows of true (dark) / false }. mask: 0–7 to choose it (tests)
  function encode(text, mask) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    let v = 1;
    while (v <= 10 && 4 + (v < 10 ? 8 : 16) + 8 * bytes.length > 8 * capOf(v)) v++;
    if (v > 10) throw new Error('Too long for a QR code');
    const cap = capOf(v);
    const bits = [];
    const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4);
    put(bytes.length, v < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    put(0, Math.min(4, cap * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const words = [];
    for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let k = 0; words.length < cap; k++) words.push(k % 2 ? 0x11 : 0xec);
    // split into blocks, each with its error correction; then interleaved
    const sizes = blocksOf(v), n = EC[v][0], blocks = [], ecs = [];
    let at = 0;
    for (const s of sizes) { const b = words.slice(at, at + s); at += s; blocks.push(b); ecs.push(ecc(b, n)); }
    const all = [];
    for (let i = 0; i < Math.max(...sizes); i++) for (const b of blocks) if (i < b.length) all.push(b[i]);
    for (let i = 0; i < n; i++) for (const e of ecs) all.push(e[i]);

    const size = 17 + 4 * v;
    const grid = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (g, x, y, d) => { g[y][x] = !!d; fixed[y][x] = true; };
    for (let i = 0; i < size; i++) { set(grid, 6, i, i % 2 === 0); set(grid, i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(grid, x, y, d !== 2 && d !== 4);
      }
    }
    const al = ALIGN[v], last = al.length - 1;
    for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(grid, al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const format = (g, mk) => {
      const data = mk; // error correction M: 00
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = ((data << 10) | rem) ^ 0x5412;
      const bit = (i) => (b >>> i) & 1;
      for (let i = 0; i <= 5; i++) set(g, 8, i, bit(i));
      set(g, 8, 7, bit(6)); set(g, 8, 8, bit(7)); set(g, 7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(g, 14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(g, size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(g, 8, size - 15 + i, bit(i));
      set(g, 8, size - 8, 1);
    };
    format(grid, 0); // reserves the format areas
    if (v >= 7) {
      let rem = v;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const b = (v << 12) | rem;
      for (let i = 0; i < 18; i++) { const d = (b >>> i) & 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(grid, a, c, d); set(grid, c, a, d); }
    }
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
          if (!fixed[y][x] && i < all.length * 8) { grid[y][x] = ((all[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
        }
      }
    }
    let best = null;
    for (let mk = 0; mk < 8; mk++) {
      if (mask !== undefined && mask !== mk) continue;
      const g = grid.map((r) => r.slice());
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[mk](x, y)) g[y][x] = !g[y][x];
      format(g, mk);
      const score = mask !== undefined ? 0 : penalty(g);
      if (!best || score < best.score) best = { version: v, mask: mk, modules: g, score };
    }
    return { version: best.version, mask: best.mask, modules: best.modules };
  }

  // the code as an SVG: black on white with the quiet border round it
  function svg(text) {
    const m = encode(text).modules, n = m.length, q = 4;
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + (n + 2 * q) + ' ' + (n + 2 * q) + '" shape-rendering="crispEdges" role="img" aria-label="QR code for the authenticator app"><rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="' + d + '"/></svg>';
  }

  const api = { encode, svg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.QR = api;
})();
