// Driving the head Z axis during a job: the server follows the head along the job's route with
// the screen's own code (ui/follow.js) and streams the planned nozzle height ahead of it.
//
// Each reported head position is placed on the route. Every `every` ms, while the head is placed
// with confidence (a fresh fix, none missed), the next `horizon` s of the plan go to the axis as
// trajectory points on its own clock, so USB delays don't matter. When it isn't sure where the
// head is, it holds at the highest the plan goes from 2 s back to 6 s on (safe wherever the head
// is in that stretch); after `lostUp` s unsure, or when the job pauses, stops or alarms, the axis
// goes UP. Dry run: everything is worked out and logged, nothing is sent.
'use strict';

const F = require('../../ui/follow');
const P = require('./planner');

class ZFollow {
  // o: { sink (link: trajectory(pts), up(), go(pos, v)), plan, pkg, M, job, dry, log, clock,
  //      every (ms), horizon (s), lostUp (s), keep (log every n ticks) }
  constructor(o) {
    this.o = { every: 50, horizon: 1.5, lostUp: 3, ...o };
    this.clock = o.clock || (() => Date.now());
    this.follow = F.follower();
    this.state = 'start';
    this.log = [];       // [ms, route t (or null), pos sent, 'f' followed | 'h' held | 'u' up]
    this.lostSince = null;
    this.lastSent = null;
  }

  // a head position from the laser: { pos, at }, the job's progress and the last part reported done
  position(p, progress, marker) {
    if (!p || !p.pos || !Number.isFinite(p.pos.x)) return;
    const now = this.clock();
    F.place(this.follow, { job: this.o.job, pos: p.pos, posAge: now - (p.at || now), progress, marker }, this.o.pkg, now, this.o.M);
  }

  // where the head is on the route now (s), when it's sure
  routeNow(now) {
    const f = this.follow;
    // the first moments, before the first fix: the route from when the job was handed over
    // (o.startAt; the plan's ±0.5 s window covers the travel to the first cut)
    if (!f.found && this.o.startAt && now - this.o.startAt < 3000) return Math.max(0, (now - this.o.startAt) / 1000);
    if (!f.found || f.miss > 0 || now - f.at > 1500) return null;
    return Math.min(f.route.end, f.t + Math.min(2, (now - f.at) / 1000));
  }

  // every `every` ms while the job runs: running = the machine's state is running
  tick(running) {
    const now = this.clock();
    const o = this.o;
    if (!running) return this.up('not running');
    const t = this.routeNow(now);
    if (t !== null) {
      this.lostSince = null;
      const pts = [];
      for (let dt = 0; dt <= o.horizon + 1e-9; dt += 0.05) pts.push([now + dt * 1000, P.at(o.plan, t + dt)]);
      this.send(pts, 'f', t);
      return;
    }
    if (this.lostSince === null) this.lostSince = now;
    if ((now - this.lostSince) / 1000 > o.lostUp || !this.follow.route) return this.up('not sure where the head is');
    // unsure for a moment: hold at the highest the plan goes round the last place
    this.send([[now, P.highest(o.plan, this.follow.t - 2, this.follow.t + 6)]], 'h', null);
  }

  send(pts, how, t) {
    this.state = how === 'f' ? 'following' : 'holding';
    this.lastSent = pts[0][1];
    if (!this.o.dry && this.o.sink) this.o.sink.trajectory(pts);
    this.record(t, pts[0][1], how);
  }

  up(why) {
    if (this.state !== 'up') {
      this.state = 'up';
      if (!this.o.dry && this.o.sink) Promise.resolve(this.o.sink.up()).catch(() => {});
      if (this.o.say) this.o.say('z axis up: ' + why);
    }
    this.lastSent = 0;
    this.record(null, 0, 'u');
  }

  record(t, pos, how) {
    if (this.log.length < 60000) this.log.push([this.clock(), t === null ? null : +t.toFixed(3), +pos.toFixed(3), how]);
  }
}

module.exports = { ZFollow };
