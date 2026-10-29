// Output formats: DXF (R12, one layer per process, coloured by ACI), SVG,
// the human-readable job sheet, and the job package sent to the controller.
'use strict';

const CC = require('../shared/core');

const { bedOf, regMarks } = CC;

const outputEntities = (job, opts) => (job.entities || []).filter((e) => !e.hidden && (!opts || !opts.onlyOutput || CC.processOfAci(job, e.aci) >= 0));
const layerName = (job, aci) => {
  const i = CC.processOfAci(job, aci);
  if (i >= 0 && CC.isRegProc(job.processes[i])) return 'REGMARKS';
  return (i >= 0 ? job.processes[i].name : 'ACI ' + aci).replace(/[<>/\\":;?*|=,]/g, '_').slice(0, 60);
};

function toDxf(job, machine, opts) {
  opts = opts || {};
  const bed = bedOf(machine);
  const H = bed[1];
  const fy = (y) => (H - y).toFixed(4); // DXF is Y-up with origin bottom left
  const fx = (x) => x.toFixed(4);
  const out = [];
  const g = (code, val) => out.push(String(code), String(val));
  const ents = outputEntities(job, opts);
  const layers = [...new Set(ents.map((e) => layerName(job, e.aci)))].filter((l) => l !== 'REGMARKS');

  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4);
  g(9, '$EXTMIN'); g(10, 0); g(20, 0);
  g(9, '$EXTMAX'); g(10, bed[0]); g(20, bed[1]);
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length + 1);
  for (const l of layers.concat(['REGMARKS'])) { g(0, 'LAYER'); g(2, l); g(70, 0); g(62, 7); g(6, 'CONTINUOUS'); }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const e of ents) {
    const layer = layerName(job, e.aci);
    for (const path of e.paths) {
      if (path.p.length < 2) continue;
      if (path.p.length === 2 && !path.c) {
        g(0, 'LINE'); g(8, layer); g(62, e.aci);
        g(10, fx(path.p[0][0])); g(20, fy(path.p[0][1])); g(30, 0);
        g(11, fx(path.p[1][0])); g(21, fy(path.p[1][1])); g(31, 0);
        continue;
      }
      g(0, 'POLYLINE'); g(8, layer); g(62, e.aci); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, path.c ? 1 : 0);
      for (const [x, y] of path.p) { g(0, 'VERTEX'); g(8, layer); g(10, fx(x)); g(20, fy(y)); g(30, 0); }
      g(0, 'SEQEND'); g(8, layer);
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
function pathD(path) {
  const p = path.p;
  if (!p.length) return '';
  let d = 'M' + p[0][0].toFixed(3) + ' ' + p[0][1].toFixed(3);
  for (let i = 1; i < p.length; i++) d += 'L' + p[i][0].toFixed(3) + ' ' + p[i][1].toFixed(3);
  return d + (path.c ? 'Z' : '');
}

// opts.print: artwork for a print-and-cut sheet (filled shapes, marks, no cut lines)
function toSvg(job, machine, opts) {
  opts = opts || {};
  const bed = bedOf(machine);
  const box = opts.print && job.sheet && job.sheet.on ? job.sheet : { x: 0, y: 0, w: bed[0], h: bed[1] };
  const ents = outputEntities(job, opts);
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + box.w + 'mm" height="' + box.h + 'mm" viewBox="' + box.x + ' ' + box.y + ' ' + box.w + ' ' + box.h + '">');
  parts.push('<title>' + esc(job.name || 'job') + '</title>');
  if (!opts.print && job.sheet && job.sheet.on) {
    parts.push('<rect x="' + job.sheet.x + '" y="' + job.sheet.y + '" width="' + job.sheet.w + '" height="' + job.sheet.h + '" fill="none" stroke="#AEB5C0" stroke-width="0.3" data-role="sheet"/>');
  }
  const byLayer = new Map();
  for (const e of ents) {
    const l = layerName(job, e.aci);
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l).push(e);
  }
  for (const [l, list] of byLayer) {
    parts.push('<g id="' + esc(l.replace(/\s+/g, '_')) + '">');
    for (const e of list) {
      const proc = job.processes[CC.processOfAci(job, e.aci)];
      const reg = CC.isRegProc(proc);
      const col = reg ? '#000000' : CC.aciHex(e.aci);
      // printed sheet: engraving and reg marks are filled, cut lines are left off
      const fill = opts.print && proc && (proc.proc === 'Engrave' || reg) ? col : 'none';
      if (opts.print && proc && proc.proc === 'Cut') continue;
      const d = e.paths.map(pathD).join(' ');
      parts.push('<path d="' + d + '" fill="' + fill + '" fill-rule="evenodd" stroke="' + col + '" stroke-width="' + (opts.print ? 0.1 : 0.25) + '"/>');
    }
    parts.push('</g>');
  }
  parts.push('</svg>');
  return parts.join('\n');
}

function processSummary(p, isLaser) {
  if (isLaser) {
    const parts = [p.proc, p.power + ' %', p.speed + ' mm/s', (p.proc === 'Cut' ? p.f + ' Hz' : p.f + ' DPI'), p.passes + '×' + (p.passes > 1 && Number(p.dwell) > 0 ? ' (' + p.dwell + ' s dwell between)' : '')];
    if (p.proc === 'Engrave') { const s = CC.engraveScan(p); parts.push({ down: 'top down', up: 'bottom up', fastest: 'fastest direction' }[s.dir] + (s.uni ? ', one way' : ', both ways')); }
    if (p.proc === 'Cut' && p.dash) parts.push('links ' + p.dl + '/' + p.gl + ' mm');
    if (p.air) parts.push('air ' + p.air);
    return parts.join(' · ');
  }
  const parts = [p.tool, p.speed + ' mm/s', p.passes + '×'];
  if (p.dash) parts.push('dash ' + p.dl + '/' + p.gl + ' mm');
  return parts.join(' · ');
}

// Plain-text job sheet: settings per process plus the time estimate.
function jobSheet(job, machine, material, est) {
  const isLaser = machine.type !== 'plotter';
  const L = [];
  const line = (s) => L.push(s || '');
  line('JOB SHEET — ' + (job.name || 'Untitled'));
  line('Prepared ' + new Date().toLocaleString('en-GB'));
  line('');
  line('Machine:   ' + machine.name + ' (' + machine.ctrl + ', ' + (isLaser ? 'laser' : 'plotter') + ')');
  line('Material:  ' + (material ? material.name + ' · ' + material.t + ' mm' : '—'));
  const b = CC.boxOf((job.entities || []).filter((e) => !e.hidden));
  if (CC.boxValid(b)) line('Job area:  ' + CC.boxW(b).toFixed(1) + ' × ' + CC.boxH(b).toFixed(1) + ' mm at X ' + b.x0.toFixed(1) + ' Y ' + b.y0.toFixed(1));
  if (job.sheet && job.sheet.on) line('Sheet:     ' + job.sheet.w + ' × ' + job.sheet.h + ' mm at X ' + job.sheet.x + ' Y ' + job.sheet.y);
  if (isLaser) line('Reg marks: ' + ({ off: 'Off', pos: 'Position & rotation (2 marks)', linear: 'Full linear (3 marks)', nonlinear: 'Non-linear (3 marks)' }[job.regMode || 'off']) + (job.regMode && job.regMode !== 'off' ? ' · ' + regMarks(job, machine).length + ' in job' : ''));
  const co = CC.cutOrderOf(job);
  line('Cut order: ' + { process: 'by process (list order)', speed: 'fastest', ordered: 'ordered (marks, engraving, cutting)' }[co.order] + ' · inside shapes ' + { part: 'first, part by part', all: 'all first', off: 'not prioritised' }[co.inside]);
  if (!isLaser) line('Beds:      ' + est.beds);
  line('');
  line('ESTIMATED TIME: ' + CC.fmtDuration(est.total, true));
  line('');
  line('PROCESSES (run order)');
  const order = (est && est.procOrder) || CC.processOrder(job, isLaser);
  order.forEach((i, n) => {
    const p = job.processes[i];
    const pp = est.perProcess.find((x) => x.idx === i);
    line((n + 1) + '. ' + p.name + '  [ACI ' + ((p.aci || []).join(', ') || '—') + ']');
    line('   ' + processSummary(p, isLaser));
    if (p.adv && Object.keys(p.adv).length) line('   ' + Object.entries(p.adv).map(([k, v]) => k + ': ' + v).join(' · '));
    line('   time ' + (pp ? CC.fmtDuration(pp.time, true) : 'no geometry') + (pp && pp.cut ? ' · length ' + CC.fmtLen(pp.cut) : '') + (pp && pp.area ? ' · area ' + CC.fmtArea(pp.area) : ''));
  });
  const off = job.processes.filter((p) => p.out === false);
  if (off.length) line('Output off: ' + off.map((p) => p.name).join(', '));
  if (est.marks) line('Registration marks read first: ' + est.marks + ' marks · ' + CC.fmtDuration(est.inspectTime, true));
  line('Travel: ' + CC.fmtDuration(est.travelTime, true) + ' · ' + CC.fmtLen(est.travel) + ' (from and back to the origin included)');
  line('');
  line('Cut length ' + CC.fmtLen(est.cutLen) + (isLaser ? ' · engraved ' + CC.fmtArea(est.engArea) : ' · tool changes ' + est.toolChanges));
  const checks = CC.checkJob(job, machine);
  line('');
  line('CHECKS');
  checks.forEach((c) => line((c.ok ? '  ok   ' : '  !!   ') + c.l));
  return L.join('\r\n') + '\r\n';
}

// The job in run order, exactly as simulated: each cut with its chosen start
// point and passes, engraving blocks, tool changes and conveyor feeds.
// (Travel between them is implied: go to the next item's first point.)
function toolpath(job, est) {
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const out = [];
  for (const o of est.timeline || []) {
    const p = o.proc >= 0 ? job.processes[o.proc] : null;
    if (o.kind === 'op' && o.mode === 'vector') {
      out.push({ type: 'cut', process: o.proc, name: p.name, ent: o.ent, bed: o.bed, closed: !!o.path.c, passes: o.passes || 1, pass: o.pass || undefined, seconds: +o.dur.toFixed(3), p: o.path.p.map(([x, y]) => [r3(x), r3(y)]) });
    } else if (o.kind === 'op' && o.mode === 'raster') {
      // direction is resolved per step ("fastest" becomes up or down); bidirectional false = every line left to right
      out.push({ type: 'engrave', process: o.proc, name: p.name, ents: o.ents, bed: o.bed, dpi: o.dpi, passes: o.passes || 1, pass: o.pass || undefined, lines: o.rows, scan: o.shared ? 'across' : 'island', direction: o.dir || 'down', bidirectional: !o.uni, seconds: +o.dur.toFixed(3), box: [r3(o.box.x0), r3(o.box.y0), r3(o.box.x1), r3(o.box.y1)] });
    } else if (o.kind === 'inspect') {
      out.push({ type: 'inspect', mark: o.mark, of: o.of, at: [r3(o.at[0]), r3(o.at[1])], d: r3(o.d), seconds: +o.dur.toFixed(3) });
    } else if (o.kind === 'dwell') {
      out.push({ type: 'dwell', process: o.proc, name: p.name, pass: o.pass, seconds: +o.dur.toFixed(3) });
    } else if (o.kind === 'change') {
      out.push({ type: 'toolchange', process: o.proc, tool: o.tool, bed: o.bed });
    } else if (o.kind === 'feed') {
      out.push({ type: 'feed', bed: o.bed });
    }
  }
  return out;
}

// A process as sent: engrave processes always carry dir/uni (older jobs kept
// the direction in adv.Direction), and fields no longer used are left out.
function packageProcess(p, index, isLaser) {
  const { ratio, hidden, src, ...rest } = p;
  const out = { index, ...rest };
  if (isLaser && p.proc === 'Engrave') {
    const s = CC.engraveScan(p);
    out.dir = s.dir;
    out.uni = s.uni;
    if (out.adv && out.adv.Direction) { const { Direction, ...adv } = out.adv; out.adv = adv; }
  }
  out.summary = processSummary(p, isLaser);
  return out;
}

// Everything the controller needs, in one JSON document. est must come from
// CC.estimate(..., { timeline: true }) so the run order can be included.
function buildPackage(job, machine, material, est) {
  const isLaser = machine.type !== 'plotter';
  const order = (est && est.procOrder) || CC.processOrder(job, isLaser);
  return {
    format: 'lrc-job-package',
    version: 1,
    createdAt: new Date().toISOString(),
    job: { id: job.id, name: job.name, notes: job.notes || '' },
    machine: { id: machine.id, name: machine.name, type: machine.type, ctrl: machine.ctrl, bed: bedOf(machine) },
    material: material ? { id: material.id, name: material.name, thickness: material.t } : null,
    sheet: job.sheet && job.sheet.on ? { w: job.sheet.w, h: job.sheet.h, x: job.sheet.x, y: job.sheet.y } : null,
    regMarks: isLaser ? { mode: job.regMode || 'off', aci: [...CC.regMarkAci(job)], marks: regMarks(job, machine) } : null,
    beds: est.beds,
    cutOrder: CC.cutOrderOf(job),
    processes: order.map((i) => packageProcess(job.processes[i], i, isLaser)),
    disabledProcesses: job.processes.filter((p) => p.out === false).map((p) => p.name),
    estimate: {
      totalSeconds: Math.round(est.total),
      total: CC.fmtDuration(est.total, true),
      perProcess: est.perProcess.map((p) => ({ name: p.name, seconds: Math.round(p.time), cutLengthMm: Math.round(p.cut), engraveAreaMm2: Math.round(p.area) })),
      travelSeconds: Math.round(est.travelTime), travelMm: Math.round(est.travel), cutLengthMm: Math.round(est.cutLen), engraveAreaMm2: Math.round(est.engArea),
      toolChanges: est.toolChanges, feeds: est.feeds
    },
    checks: CC.checkJob(job, machine),
    toolpath: toolpath(job, est),
    entities: outputEntities(job).map((e) => ({ id: e.id, name: e.name, aci: e.aci, bed: e.bed || 0, paths: e.paths }))
  };
}

module.exports = { toDxf, toSvg, jobSheet, buildPackage, toolpath, regMarks, processSummary };
