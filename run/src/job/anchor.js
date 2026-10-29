// "Anchor to toolhead": moves a whole job so its top-left corner sits where
// the head was when the operator pressed the button. Everything in the
// package moves together (toolpath, shapes, registration marks, sheet).
'use strict';

// bounding box of what the machine does: cuts, engrave boxes, mark positions
function box(pkg) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const see = (x, y) => { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); };
  for (const s of pkg.toolpath || []) {
    if (s.p) for (const [x, y] of s.p) see(x, y);
    if (s.box) { see(s.box[0], s.box[1]); see(s.box[2], s.box[3]); }
    if (s.at) see(s.at[0], s.at[1]);
  }
  return Number.isFinite(b[0]) ? b : null;
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

// pkg placed with its top-left corner at anchor {x, y}; null anchor = as sent
function apply(pkg, anchor) {
  if (!anchor) return pkg;
  const b = box(pkg);
  if (!b) return pkg;
  const out = shift(pkg, anchor.x - b[0], anchor.y - b[1]);
  out.anchor = { x: anchor.x, y: anchor.y, dx: anchor.x - b[0], dy: anchor.y - b[1] };
  return out;
}

// throws (409) when the job, anchored at {x, y}, would leave the bed
function check(pkg, at, bed) {
  const b = box(pkg);
  if (!b) throw Object.assign(new Error('This job has nothing to place'), { code: 409 });
  const w = b[2] - b[0], h = b[3] - b[1];
  if (at.x < -0.01 || at.y < -0.01 || at.x + w > bed[0] + 0.5 || at.y + h > bed[1] + 0.5) {
    throw Object.assign(new Error('Anchored at the head (X ' + at.x.toFixed(1) + ', Y ' + at.y.toFixed(1) + '), the job (' + w.toFixed(0) + ' × ' + h.toFixed(0) + ' mm) would leave the bed. Move the head towards the back left and try again.'), { code: 409 });
  }
}

module.exports = { box, shift, apply, check };
