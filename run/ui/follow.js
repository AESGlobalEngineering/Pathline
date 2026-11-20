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
  // Engraving (row): each line is swept at the engraving speed v, and costs c + cv·v − sh/v s more,
  // plus nk s per mm the line (with its overscan) is narrower than nw mm, plus the step to the next
  // line, kp·p / (1 + p/ps) s for a pitch of p mm (in proportion for fine pitches, levelling off for
  // coarse ones). Measured at 500 mm/s on 41 islands of 8 jobs at 100–1000 DPI (16–18 Nov,
  // J0093–J0111, from every report's line and place along it): 82.8 ms + 0.29 ms per mm under
  // 50 mm + 5.4 ms at 1000 DPI, 9.5 at 500, 14.1 at 300, 24.5 at 100. Each job left out of the fit and
  // worked out from the others: within 0.9 ms a line (rms, 1.9 at worst); the estimate's model was
  // 3.8 ms off (up to 8). How it changes with the speed is the estimate's (calibration bars at
  // 100–600 mm/s). The head speeds up and slows down over dr mm at each end of the line, and turns
  // in what's left.
  const TROTEC = { travel: { a: 2000, j: 50000, v: 1000 }, cut: { arc: 500, corner: 5, acc: 300 }, row: { c: 0.0782, cv: 2.295e-5, sh: 3.43, nk: 0.000288, nw: 50, kp: 0.261, ps: 0.15, dr: 20 } };
  // Of places on the route that fit a report about equally well, the one nearest where the drawing
  // has the head by then wins, by this many mm per second of the job between them. Engraving lines
  // 0.024 mm apart are closer than the laser's position steps (0.01 mm), so the report alone can't
  // tell which line, nor which way the head was going along it: the nearest line, taken before,
  // sent the drawing back across the island half the time
  const PLACE_TIME = 1;

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
    return { ...motion, ...(f.travel || TROTEC.travel), cut: f.cut || TROTEC.cut, row: { ...TROTEC.row, ...(f.row || {}) }, maxSpeed };
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
      // the lines as sent (rows.runs): each across at the engraving speed, speeding up and slowing
      // down at its ends, then the turn to the next line, which starts back the other way. Drawn at
      // an even pace over at most 200 lines spread across the island (before), the head was on the
      // right line but 8–21 mm off along it (median) on Ruby's engraving jobs: lines are 0.15–0.3 s
      // each, and blank lines are skipped
      if (s.type === 'engrave' && rows && Array.isArray(rows.runs) && rows.runs.length && rows.v > 0) {
        const RP = M.row || TROTEC.row, v = rows.v, w = Math.abs(rows.xe - rows.xs);
        const p = Math.abs(rows.dy || 0);
        const P = w / v + Math.max(0.01, RP.c + RP.cv * v - RP.sh / v) + RP.nk * Math.max(0, RP.nw - w) + (RP.kp * p) / (1 + p / RP.ps);
        const dr = Math.max(0, Math.min(RP.dr, w / 2, (v * (P - w / v - 0.002)) / 2));
        const tr = dr > 0 ? (2 * dr) / v : 0, cruise = (w - 2 * dr) / v, turn = Math.max(1e-3, P - cruise - 2 * tr);
        let r = 0;
        for (const [y0, cnt] of rows.runs) {
          for (let c = 0; c < cnt; c++, r++) {
            const y = y0 + c * (rows.dy || 0);
            const back = rows.bidi !== false && r % 2 === 1;
            const x0 = back ? rows.xe : rows.xs, sg = back ? -1 : 1;
            if (r === 0) go([x0, y], i);
            else add(cur, [x0, y], turn, 'step', i);
            let at = [x0, y];
            const to = (d, dt) => { const b = [x0 + sg * d, y]; add(at, b, dt, 'row', i); at = b; };
            // speeding up over dr mm (a quarter, then the rest: ¼ of the way in ½ the time), across,
            // slowing down
            if (tr > 0) { to(dr / 4, tr / 2); to(dr, tr / 2); }
            to(w - dr, cruise);
            if (tr > 0) { to(w - dr / 4, tr / 2); to(w, tr / 2); }
            cur = at;
          }
        }
        return;
      }
      if (s.type === 'engrave' && rows && rows.n > 0) {
        // each line at an even pace, the island's own time (lead) spread over them: against the
        // reported head on Ruby's 500 mm/s jobs that drew closer than across-then-turn (the reports'
        // timing scatters more than a line takes)
        const n = Math.max(1, Math.min(200, rows.n)), per = (rows.sec + (rows.lead || 0)) / n;
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
      // punch: travel to each point, then the strike (Prepare's time spread over the strikes)
      if (s.type === 'punch' && Array.isArray(s.p) && s.p.length) {
        const per = (Number(s.seconds) || 0.3 * s.p.length) / s.p.length;
        for (const q of s.p) { go(q, i); add(q, q, per, 'strike', i); }
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
  const follower = () => ({ job: null, route: null, k: 0, t: 0, at: 0, miss: 0, doneK: -1, rate: 1, found: false, shown: { t: null, at: 0 }, pace: {}, fix: null });

  // A part's shape, for telling parts alike: its cut segments and their length
  function shapeOf(R, step) {
    if (!R.shape) {
      R.shape = {};
      const n = {}, len = {};
      for (const g of R.segs) if (g.kind === 'cut') { n[g.step] = (n[g.step] || 0) + 1; len[g.step] = (len[g.step] || 0) + Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]); }
      for (const s of Object.keys(n)) R.shape[s] = n[s] + ':' + len[s].toFixed(1);
    }
    return R.shape[step];
  }
  // The pace along parts of this one's shape so far in the job (route seconds a real second), from
  // fixes in turn on one part's cut; 1 until there's a second of them
  function partPace(follow, R, best, now) {
    const g = R.segs[best.k], f = follow.fix;
    let rate = 1;
    if (g.kind === 'cut') {
      const shape = shapeOf(R, g.step);
      const real = f ? (now - f.at) / 1000 : 0, route = f ? best.t - f.t : 0;
      // (a pair at half or twice the pace isn't the shape's pace: a fix put on the wrong side of a
      // corner, or the head held up)
      if (f && f.step === g.step && R.segs[f.k].kind === 'cut' && real >= 0.15 && route > 0.5 * real && route < 2 * real) {
        const s = follow.pace[shape] || (follow.pace[shape] = { real: 0, route: 0 });
        s.real += real; s.route += route;
      }
      const s = follow.pace[shape];
      if (s && s.real >= 1) rate = Math.max(0.5, Math.min(2, s.route / s.real));
    }
    follow.fix = { step: g.step, k: best.k, t: best.t, at: now };
    return rate;
  }

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
    // where the drawing has the head by the report's time (PLACE_TIME)
    const tPred = follow.t + ((now - follow.at) / 1000) * (follow.rate || 1);
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
      const score = (wide ? d + off : d + PLACE_TIME * Math.abs(t - tPred)) + elsewhere;
      if (d < 4 && (!best || score < best.score - 0.01)) best = { k, t, d, score };
    }
    // the head moves on from here at the pace parts of this shape have gone so far in the job
    // (partPace), else the route's own. (A pace learnt from the last fixes alone, smoothed or from
    // the last two in one part, drew it further off: it mostly followed the fixes' own scatter.
    // Pooled over every part of a shape it's steady, and the route's timing can be well off for
    // one shape and right for another: on the X jobs the 3.5 mm holes went in 0.6 s, the route
    // took 1.0 s, while J0113's slots, with 1 mm round ends, took the route's own time)
    if (best) {
      const rate = M.learnPace === false ? 1 : partPace(follow, R, best, now);
      Object.assign(follow, { k: best.k, t: best.t, at: now, miss: 0, found: true, rate });
    }
    else follow.miss++;
  }

  // The head as drawn now: on from the last place at the route's pace (not while paused, never
  // more than 2 s on), and never backwards, so a report a little behind the drawing doesn't pull
  // it back; a big difference (more than 2 s of the job behind, 5 s ahead) is jumped to.
  // Only a correction is eased (a new report moving the prediction): the gap it opens closes over
  // ~0.2 s while the head moves on. Easing towards the prediction itself kept the drawing ~0.2 s
  // (6–8 mm) behind the head the whole job (J0043, 9 Nov).
  function draw(follow, running, now) {
    // (at most 2 s of the job on, whatever the pace. A learnt pace carries on into the travel and
    // the next part, usually of the same shape: held to the end of this part's cut only, the head
    // was drawn further off)
    const ahead = running ? Math.min(2, ((now - follow.at) / 1000) * (follow.rate || 1)) : 0;
    const target = Math.min(follow.route.end, follow.t + ahead);
    const sh = follow.shown;
    if (sh.t === null || target < sh.t - 2 || target > sh.t + 5) { sh.t = target; sh.gap = 0; }
    else {
      // a new report: carry on from where the drawing would be by now (no jump), then close the
      // gap. (Measured from where it was drawn last frame, the frame's own move counted as a gap
      // to close: the head was drawn a steady ~10 ms late with a report every 0.25 s, 5 mm at the
      // engraving speed)
      const moved = running && sh.at ? (Math.max(0, now - sh.at) / 1000) * follow.rate : 0;
      let gap = sh.fix !== follow.at ? sh.t + moved - target : sh.gap || 0;
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
