// "Anchor to toolhead": moves a whole job so its top-left corner sits where
// the head was when the operator pressed the button. Everything in the
// package moves together (toolpath, shapes, registration marks, sheet).
'use strict';

// bounding box of what the machine does: cuts, engrave boxes, mark positions (opts.marks false:
// without the marks, which the camera only has to reach: they needn't be on the bed's cutting area)
function box(pkg, opts = {}) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const see = (x, y) => { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); };
  for (const s of pkg.toolpath || []) {
    if (opts.marks === false && s.type === 'inspect') continue;
    if (s.p) for (const [x, y] of s.p) see(x, y);
    if (s.box) { see(s.box[0], s.box[1]); see(s.box[2], s.box[3]); }
    if (s.at) see(s.at[0], s.at[1]);
  }
  return Number.isFinite(b[0]) ? b : null;
}

// the point that goes to the head: the job's top-left corner, or for print and cut its top-left
// registration mark (the operator puts the head on the mark; the corner of everything was ~14 and
// 17 mm off it on the X8 sheet, so the camera looked 22 mm from each mark)
function ref(pkg) {
  let best = null;
  for (const s of pkg.toolpath || []) if (s.type === 'inspect' && Array.isArray(s.at) && (!best || s.at[0] + s.at[1] < best[0] + best[1])) best = s.at;
  if (best) return [best[0], best[1]];
  const b = box(pkg);
  return b ? [b[0], b[1]] : null;
}

// a copy of pkg moved by dx, dy
function shift(pkg, dx, dy) {
  const pt = ([x, y]) => [+(x + dx).toFixed(4), +(y + dy).toFixed(4)];
  const out = { ...pkg };
  out.toolpath = (pkg.toolpath || []).map((s) => {
    const t = { ...s };
    if (s.p) t.p = s.p.map(pt);
    if (s.box) t.box = [s.box[0] + dx, s.box[1] + dy, s.box[2] + dx, s.box[3] + dy];
    if (s.at) t.at = pt(s.at);
    return t;
  });
  out.entities = (pkg.entities || []).map((e) => ({ ...e, paths: (e.paths || []).map((p) => ({ ...p, p: p.p.map(pt) })) }));
  if (pkg.regMarks && pkg.regMarks.marks) out.regMarks = { ...pkg.regMarks, marks: pkg.regMarks.marks.map((m) => ({ ...m, x: m.x + dx, y: m.y + dy })) };
  if (pkg.sheet) out.sheet = { ...pkg.sheet, x: pkg.sheet.x + dx, y: pkg.sheet.y + dy };
  return out;
}

// pkg placed with its reference point (ref) at anchor {x, y}; null anchor = as sent
function apply(pkg, anchor) {
  if (!anchor) return pkg;
  const r = ref(pkg);
  if (!r) return pkg;
  const out = shift(pkg, anchor.x - r[0], anchor.y - r[1]);
  out.anchor = { x: anchor.x, y: anchor.y, dx: anchor.x - r[0], dy: anchor.y - r[1] };
  return out;
}

// How far a job's cuts reach past each edge of the bed (mm, 0 when inside), with their box:
// { left, right, back, front, box }. The marks don't count (box: marks false)
function overBed(pkg, bed) {
  const b = box(pkg, { marks: false });
  if (!b) return null;
  const o = (v) => (v > 0.5 ? v : 0); // (half a mm, as moveCamera allows)
  return { left: o(-b[0]), back: o(-b[1]), right: o(b[2] - bed[0]), front: o(b[3] - bed[1]), box: b };
}

// throws (409) when the job, anchored at {x, y}, would leave the bed; e.over: overBed's answer
function check(pkg, at, bed) {
  const r = ref(pkg);
  if (!box(pkg, { marks: false }) || !r) throw Object.assign(new Error('This job has nothing to place'), { code: 409 });
  const ov = overBed(apply(pkg, at), bed);
  if (ov.left || ov.right || ov.back || ov.front) {
    const b = ov.box, w = b[2] - b[0], h = b[3] - b[1];
    throw Object.assign(new Error('Anchored at the head (X ' + at.x.toFixed(1) + ', Y ' + at.y.toFixed(1) + '), the job (' + w.toFixed(0) + ' × ' + h.toFixed(0) + ' mm) would leave the bed. Move the head ' + (ov.left || ov.back ? 'away from the back left' : 'towards the back left') + ' and try again.'), { code: 409, over: ov });
  }
}

module.exports = { box, ref, shift, apply, check, overBed };
