// Following the running job along its paths: the screen's route, where each reported head
// position goes on it, and where the head is drawn in between. Shared by the screen (app.js,
// as window.PathlineFollow) and the server, which replays each finished job through this same
// code to fit its timing to where the head really was (src/follow-fit.js).
//
// The head's position comes every 0.4–0.8 s; in between it may cut several shapes, so joining
// the positions drew lines straight across the job. Instead the job's toolpath is laid out as one
// route (travel to each step's start, then along it), every reported position is placed on the
// route (only ahead of the last one and not far ahead in time, so a path crossing another can't
// pull it back or on), and between reports the head moves on along the route at its own pace.
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PathlineFollow = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  // The Trotec's route timing for drawing the head, fitted to where the head really was: every
  // report of J0040–J0065 replayed through this code as the screen sees them (a refresh every
  // 0.7 s). Travel between cuts is quicker than the planner limits say, and curves and corners
  // slower than the estimate's model, which is fitted to whole parts only (it gets each part's
  // time right, not how it's split). The head drawn is then 2.1 mm from the reported head
  // (median; 7.7 mm for 9 in 10), was 2.7 and 10.6 mm. On runs left out of the fit: 2.3 and
  // 8.0 mm, was 3.2 and 11.2 mm. Each finished job refits it (follow-fit.js): the server sends
  // what it learnt as motion.follow.
  const TROTEC = { travel: { a: 2000, j: 50000, v: 1000 }, cut: { arc: 500, corner: 5, acc: 300 } };

  // rest-to-rest time over d mm at speed v, acceleration a, jerk j (as src/ctrl/trotec/motion.js)
  function moveTime(d, v, a, j) {
    if (!(d > 0)) return 0;
    const ramp = (u) => { const t = u <= (a * a) / j ? 2 * Math.sqrt(u / j) : u / a + a / j; return { t, s: (u * t) / 2 }; };
    const top = ramp(v);
    if (2 * top.s <= d) return 2 * top.t + (d - 2 * top.s) / v;
    let lo = 0, hi = v;
    for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (2 * ramp(m).s > d) hi = m; else lo = m; }
    return 2 * ramp(lo).t;
  }

  // Seconds along each segment of a cut polyline at speed v, as the Trotec moves it (prof: arc,
  // corner, acc): slower round curves (a bend of up to 16° between segments is part of a curve,
  // of radius ≈ segment ÷ bend) and corners, accelerating at prof.acc, from a stop and to a stop.
  // Timing cuts as length ÷ speed put J0053 (400 mm/s, small shapes) 60 s ahead of the head.
  function polyTimes(pts, v, prof) {
    const n = pts.length, L = [], dir = [];
    for (let k = 1; k < n; k++) { L.push(Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1])); dir.push(Math.atan2(pts[k][1] - pts[k - 1][1], pts[k][0] - pts[k - 1][0])); }
    const vj = new Array(n).fill(v);
    vj[0] = 0; vj[n - 1] = 0;
    for (let k = 1; k < n - 1; k++) {
      let th = Math.abs(dir[k] - dir[k - 1]) % (2 * Math.PI);
      if (th > Math.PI) th = 2 * Math.PI - th;
      if (th < 1e-3) continue;
      // a corner: junction deviation, v² = corner · c / (1 − c), c = cos(φ/2) for a turn of φ
      // (compile.js runTime; it was sin(φ/2), too fast round sharp turns)
      const c = Math.cos(th / 2);
      const lim = th <= (16 * Math.PI) / 180 ? Math.sqrt((prof.arc * Math.min(L[k], L[k - 1])) / th) : c <= 1e-4 ? 0 : Math.sqrt((prof.corner * c) / (1 - c));
      vj[k] = Math.min(v, lim);
    }
    const a = prof.acc;
    for (let k = 0; k < n - 1; k++) vj[k + 1] = Math.min(vj[k + 1], Math.sqrt(vj[k] ** 2 + 2 * a * L[k]));
    for (let k = n - 2; k >= 0; k--) vj[k] = Math.min(vj[k], Math.sqrt(vj[k + 1] ** 2 + 2 * a * L[k]));
    return L.map((l, k) => {
      const u0 = vj[k], u1 = vj[k + 1];
      const pk = Math.max(1e-6, Math.min(v, Math.sqrt((2 * a * l + u0 * u0 + u1 * u1) / 2)));
      const s1 = (pk * pk - u0 * u0) / (2 * a), s2 = (pk * pk - u1 * u1) / (2 * a);
      return (pk - u0) / a + (pk - u1) / a + Math.max(0, l - s1 - s2) / pk;
    });
  }

  // The motion the route is timed with. motion: the server's (travel limits, and for a Trotec
  // `cut` and what it learnt, `follow`); cfg: the setup (travel speed, speed limit)
  function motionFor(motion, cfg) {
    const t = (cfg && cfg.trotec) || {};
    const maxSpeed = Number(t.maxSpeed) || Infinity;
    if (!motion) return { v: Number(t.travelSpeed) || 500, a: 5000, j: 1e6, maxSpeed };
    if (!motion.cut) return { ...motion, maxSpeed };
    const f = motion.follow || TROTEC;
    return { ...motion, ...(f.travel || TROTEC.travel), cut: f.cut || TROTEC.cut, maxSpeed };
  }

  function routeOf(pkg, M) {
    const segs = [];
    let t = 0, cur = null;
    const add = (a, b, dt, kind, step) => { segs.push({ a, b, t0: t, dt: Math.max(dt, 1e-3), kind, step }); t += Math.max(dt, 1e-3); };
    const go = (p, step) => { if (cur && Math.hypot(p[0] - cur[0], p[1] - cur[1]) > 0.01) add(cur, p, moveTime(Math.hypot(p[0] - cur[0], p[1] - cur[1]), M.v, M.a, M.j), 'travel', step); cur = p; };
    (pkg.toolpath || []).forEach((s, i) => {
      let pts = null, kind = 'cut';
      // engraving as Pathline Run sends it (pkg.rows from the server: the lines, their overscan
      // and their time); the head is drawn across each line at the real pace (Prepare's own time
      // for J0068's labels was 10× too long, and the drawing fell far behind)
      const rows = pkg.rows && pkg.rows[i];
      if (s.type === 'engrave' && rows && rows.n > 0) {
        const n = Math.max(1, Math.min(200, rows.n)), per = rows.sec / n;
        go([rows.xs, rows.y0], i);
        for (let r = 0; r < n; r++) {
          const y = n > 1 ? rows.y0 + ((rows.y1 - rows.y0) * r) / (n - 1) : rows.y0;
          const back = rows.bidi !== false && r % 2;
          const a = back ? [rows.xe, y] : [rows.xs, y], b = back ? [rows.xs, y] : [rows.xe, y];
          if (r) add(cur, a, 1e-3, 'step', i);
          add(a, b, per, 'row', i);
          cur = b;
        }
        return;
      }
      if (Array.isArray(s.p) && s.p.length > 1) pts = s.closed ? s.p.concat([s.p[0]]) : s.p;
      else if (s.type === 'engrave' && Array.isArray(s.box) && s.box.length === 4) {
        // the scan lines (at most 200 of them here: enough to follow and draw)
        const [x0, y0, x1, y1] = s.box, n = Math.max(1, Math.min(200, s.lines || 20)), up = s.direction === 'up';
        pts = [];
        for (let r = 0; r < n; r++) {
          const y = up ? y1 - ((y1 - y0) * (r + 0.5)) / n : y0 + ((y1 - y0) * (r + 0.5)) / n;
          const back = s.bidirectional !== false && r % 2;
          pts.push(back ? [x1, y] : [x0, y], back ? [x0, y] : [x1, y]);
        }
        kind = 'row';
      }
      if (!pts) { if (s.seconds) add(cur || [0, 0], cur || [0, 0], s.seconds, 'wait', i); return; }
      go(pts[0], i);
      const proc = (pkg.processes || []).find((p) => p.index === s.process) || {};
      let len = 0;
      for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      // a Trotec cut as it moves it (set speed on straights, slower round curves and corners); other
      // cuts at their set speed (Pathline's own time ran ~15 % long), engraving at Pathline's time
      const speed = Math.min(Number(proc.speed) || 0, M.maxSpeed || Infinity);
      if (kind === 'cut' && speed > 0 && M.cut) {
        const dts = polyTimes(pts, speed, M.cut);
        for (let k = 1; k < pts.length; k++) add(pts[k - 1], pts[k], dts[k - 1], kind, i);
        cur = pts[pts.length - 1];
        return;
      }
      const secs = kind === 'cut' && speed > 0 ? len / speed : s.seconds || len / (Number(proc.speed) || 20);
      for (let k = 1; k < pts.length; k++) {
        // engraving: the beam is on along a row, the step between rows is part of the scan
        const dl = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        add(pts[k - 1], pts[k], len ? (secs * dl) / len : 0, kind === 'row' && k % 2 === 0 ? 'step' : kind, i);
      }
      cur = pts[pts.length - 1];
    });
    return { segs, end: t };
  }

  // where the route is at time t (s): segment index and point
  function routeAt(route, t) {
    const s = route.segs;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m].t0 <= t) lo = m; else hi = m - 1; }
    const g = s[lo], u = Math.max(0, Math.min(1, (t - g.t0) / g.dt));
    return { k: lo, p: [g.a[0] + (g.b[0] - g.a[0]) * u, g.a[1] + (g.b[1] - g.a[1]) * u] };
  }

  // The route times [from, to] of the part after the one marker m says is done (marker m is set
  // after toolpath step m − 1): the travel to it and the part itself. null if there's none
  function partSpan(R, m) {
    if (!R.byStep) {
      R.byStep = [];
      R.segs.forEach((g, k) => { if (R.byStep.length === 0 || R.segs[R.byStep[R.byStep.length - 1]].step !== g.step) R.byStep.push(k); });
    }
    const starts = R.byStep;
    let lo = 0, hi = starts.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (R.segs[starts[mid]].step >= m) { found = mid; hi = mid - 1; } else lo = mid + 1; }
    if (found < 0) return null;
    const t0 = R.segs[starts[found]].t0, t1 = found + 1 < starts.length ? R.segs[starts[found + 1]].t0 : R.end;
    return [t0, t1];
  }

  // A new follower: job, route, where the head was last placed (k, t, at), shown: where it's drawn
  const follower = () => ({ job: null, route: null, k: 0, t: 0, at: 0, miss: 0, doneK: -1, rate: 1, found: false, shown: { t: null, at: 0 } });

  // A reported head position (st: { job, pos, posAge, progress }), placed on the route: ahead of
  // the last place and within reach in time. now: the clock (ms) the screen draws with; M: motionFor
  function place(follow, st, pkg, now0, M) {
    if (!st.job || !pkg || pkg === 'loading' || !Number.isFinite(st.pos.x)) { follow.job = null; return; }
    // when the head was there: the server says how old its position is (it polls the controller,
    // the screen polls the server: together over a second at times). The same position again (no
    // newer one from the controller) is no news: taking it as now made the head snap back
    const now = now0 - Math.max(0, Number(st.posAge) || 0);
    if (follow.job !== st.job) Object.assign(follow, follower(), { job: st.job, route: routeOf(pkg, M), at: now, last: null });
    const R = follow.route;
    if (!R.segs.length) return;
    const P = [st.pos.x, st.pos.y];
    if (follow.last && follow.last.x === P[0] && follow.last.y === P[1] && Math.abs(follow.last.at - now) < 400) return;
    follow.last = { x: P[0], y: P[1], at: now };
    // The first time (the screen opened mid-job), or lost for a few reports: anywhere on the route
    // the controller's progress allows (the head waiting where the last run ended can also be where
    // this one ends: the same job again), nearest that progress. Otherwise a few seconds ahead.
    const wide = !follow.found || follow.miss >= 3;
    // Where to look when searching wide: the part the laser says it's on (st.marker: the last
    // part it reported done, so the head is on the next one, or travelling to it), else the
    // progress (within 10 % of the job, at least 5 s, of it: with 30 % and 15 s, J0043's first
    // report was placed 15 s on). The progress comes from the estimate: with J0068's labels timed
    // 10× too long it pointed far from the head, and the drawing never found it again
    let a = (Number(st.progress) || 0) * R.end, b = a;
    let tol = Math.max(5, 0.1 * R.end);
    const part = Number.isFinite(st.marker) ? partSpan(R, st.marker) : null;
    if (part) { a = part[0]; b = part[1]; tol = 3; }
    const from = wide ? 0 : follow.k;
    const reach = wide ? b + tol : follow.t + 3 + (2 * (now - follow.at)) / 1000;
    let best = null;
    for (let k = from; k < R.segs.length && R.segs[k].t0 <= reach; k++) {
      const g = R.segs[k], dx = g.b[0] - g.a[0], dy = g.b[1] - g.a[1], L2 = dx * dx + dy * dy;
      let u = L2 ? ((P[0] - g.a[0]) * dx + (P[1] - g.a[1]) * dy) / L2 : 0;
      u = Math.max(!wide && k === follow.k ? Math.min(1, (follow.t - g.t0) / g.dt) : 0, Math.min(1, u));
      const d = Math.hypot(g.a[0] + dx * u - P[0], g.a[1] + dy * u - P[1]), t = g.t0 + u * g.dt;
      const off = Math.max(0, a - t, t - b);
      if (wide && off > tol) continue;
      // (searching wide, of the places that fit, the one nearest where the head should be: a
      // second of the job away counts as a mm off. At 0.01 mm a second, the first report, on the
      // way to the first cut, was put 15 s on where the path passes close by: the head drawn
      // 40–50 mm off for 3 s)
      // and the part the laser says: on it (or on the way to the next) beats a place on another
      // part by 3 mm. J0068's 8 mm test squares, 4.5 mm apart: a corner of one is within reach
      // of the travel across to another, and the drawing jumped squares ahead
      const elsewhere = Number.isFinite(st.marker) && (g.step < st.marker || g.step > st.marker + 1) ? 3 : 0;
      const score = (wide ? d + off : d) + elsewhere;
      if (d < 4 && (!best || score < best.score - 0.01)) best = { k, t, d, score };
    }
    // the head moves on from here at the route's own pace (rate 1). A pace learnt from the fixes
    // (smoothed, or from the last two in one part) drew it further off: with the route timed as
    // the machine moves, the pace between fixes is mostly the fixes' own scatter
    if (best) Object.assign(follow, { k: best.k, t: best.t, at: now, miss: 0, found: true, rate: 1 });
    else follow.miss++;
  }

  // The head as drawn now: on from the last place at the route's pace (not while paused, never
  // more than 2 s on), and never backwards, so a report a little behind the drawing doesn't pull
  // it back; a big difference (more than 2 s of the job behind, 5 s ahead) is jumped to.
  // Only a correction is eased (a new report moving the prediction): the gap it opens closes over
  // ~0.2 s while the head moves on. Easing towards the prediction itself kept the drawing ~0.2 s
  // (6–8 mm) behind the head the whole job (J0043, 9 Nov).
  function draw(follow, running, now) {
    const ahead = running ? Math.min(2, (now - follow.at) / 1000) * follow.rate : 0;
    const target = Math.min(follow.route.end, follow.t + ahead);
    const sh = follow.shown;
    if (sh.t === null || target < sh.t - 2 || target > sh.t + 5) { sh.t = target; sh.gap = 0; }
    else {
      // a new report: carry on from where the drawing is (no jump), then close the gap
      let gap = sh.fix !== follow.at ? sh.t - target : sh.gap || 0;
      gap *= Math.exp(-Math.max(0, now - (sh.at || now)) / 200);
      sh.t = Math.max(sh.t, target + gap); // never backwards
      sh.gap = sh.t - target;
    }
    sh.fix = follow.at;
    sh.at = now;
    return routeAt(follow.route, sh.t);
  }

  return { TROTEC, moveTime, polyTimes, motionFor, routeOf, routeAt, partSpan, follower, place, draw };
}));
