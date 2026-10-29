/*
 * Renderer toolkit shared by the four pages (window.LRC): toasts and dialogs,
 * keyboard shortcuts, job editing operations and the interactive job canvas.
 * Loaded after support.js, so window.React is available.
 */
(function () {
  'use strict';
  const CC = window.CC;
  const h = (...a) => window.React.createElement(...a);

  // ------------------------------------------------------------ toasts
  let toastBox = null;
  function toast(msg, opts) {
    opts = opts || {};
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.className = 'lrc-toasts';
      document.body.appendChild(toastBox);
    }
    const el = document.createElement('div');
    el.className = 'lrc-toast' + (opts.kind ? ' ' + opts.kind : '');
    el.setAttribute('role', opts.kind === 'err' ? 'alert' : 'status');
    const span = document.createElement('span');
    span.textContent = msg;
    el.appendChild(span);
    if (opts.action) {
      const b = document.createElement('button');
      b.textContent = opts.action;
      b.onclick = () => { el.remove(); opts.onAction && opts.onAction(); };
      el.appendChild(b);
    }
    toastBox.appendChild(el);
    setTimeout(() => el.remove(), opts.ms || (opts.kind === 'err' ? 7000 : 3500));
  }
  const fail = (err) => toast(err && err.message ? err.message : String(err), { kind: 'err' });

  // numbers and units are set in mono, words in sans
  const numCls = (v) => {
    const s = String(v === undefined || v === null ? '' : v);
    const digits = (s.match(/\d/g) || []).length;
    const letters = (s.match(/[A-Za-z]/g) || []).length;
    return digits > 0 && digits >= letters ? 'num' : '';
  };

  // ------------------------------------------------------------ theme
  // Preference 'system' | 'light' | 'dark', kept in settings.theme (and mirrored in
  // localStorage so the page paints in the right theme before settings load).
  // The resolved theme goes on <html data-theme>; theme.css does the rest.
  const THEME_KEY = 'pathline-theme';
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let themePref = 'system';
  try { themePref = localStorage.getItem(THEME_KEY) || 'system'; } catch (e) { /* storage unavailable */ }
  const themeListeners = [];
  function applyTheme() {
    const dark = themePref === 'dark' || (themePref === 'system' && !!(darkQuery && darkQuery.matches));
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    themeListeners.forEach((fn) => fn(dark));
  }
  function setTheme(pref, persist) {
    themePref = ['light', 'dark'].includes(pref) ? pref : 'system';
    try { localStorage.setItem(THEME_KEY, themePref); } catch (e) { /* storage unavailable */ }
    applyTheme();
    if (persist !== false && window.api && window.api.settings) window.api.settings.set({ theme: themePref }).catch(() => {});
  }
  applyTheme();
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', () => { if (themePref === 'system') applyTheme(); });
  if (window.api && window.api.settings) window.api.settings.get().then((s) => { if (s && s.theme && s.theme !== themePref) setTheme(s.theme, false); }).catch(() => {});
  const theme = {
    get pref() { return themePref; },
    get dark() { return document.documentElement.dataset.theme === 'dark'; },
    set: setTheme,
    // flips between light and dark (leaving 'system'); the choice is in Preferences
    toggle: () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'),
    onChange: (fn) => { themeListeners.push(fn); return () => themeListeners.splice(themeListeners.indexOf(fn), 1); },
    // icon paths for the theme button (sun shown in dark, moon in light)
    icons: { sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4', moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' }
  };

  // ACI colours on screen. They are data, except ACI 7: black on a light bed and
  // white on a dark one (as in CAD), so it is painted with a theme token. Use these
  // only as CSS values (style strings, or `style` on SVG elements); exports keep
  // using CC.aciHex / CC.aciStroke.
  const aci = {
    hex: (n) => (n === 7 ? 'var(--aci7)' : CC.aciHex(n)),
    fg: (n) => (n === 7 ? 'var(--aci7-fg)' : CC.aciFg(n)),
    stroke: (n) => (n === 7 ? 'var(--aci7-stroke)' : CC.aciStroke(n))
  };

  // ------------------------------------------------------------ dialogs
  // fields: [{ key, label, type: text|textarea|number|select|seg|check|info|note, value, options, unit, full, warn, rows, placeholder }]
  // buttons: [{ label, value, primary, danger }] — resolves { button, values } or null on cancel.
  function dialog(spec) {
    return new Promise((resolve) => {
      const scrim = document.createElement('div');
      scrim.className = 'lrc-scrim';
      const box = document.createElement('div');
      box.className = 'lrc-dlg';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', spec.title || 'Dialog');
      const values = {};
      const add = (tag, cls, text) => {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (text !== undefined) el.textContent = text;
        return el;
      };
      if (spec.title) box.appendChild(add('h2', '', spec.title));
      if (spec.message) box.appendChild(add('p', '', spec.message));
      let row = null;
      const inputs = [];
      (spec.fields || []).forEach((f) => {
        values[f.key] = f.value;
        if (f.type === 'note') {
          box.appendChild(add('div', 'note' + (f.warn ? ' warn' : ''), f.label));
          row = null;
          return;
        }
        if (f.type === 'table') {
          const t = add('table');
          f.rows.forEach(([a, b]) => {
            const tr = add('tr');
            tr.appendChild(add('td', '', a));
            tr.appendChild(add('td', numCls(b), b));
            t.appendChild(tr);
          });
          box.appendChild(t);
          row = null;
          return;
        }
        const wrap = add('label', f.full || f.type === 'seg' || f.type === 'select' && f.full !== false ? 'full' : '');
        if (f.type === 'check') {
          wrap.className = 'chk full';
          const c = add('input');
          c.type = 'checkbox';
          c.checked = !!f.value;
          c.onchange = () => { values[f.key] = c.checked; };
          wrap.appendChild(c);
          wrap.appendChild(add('span', '', f.label));
        } else {
          wrap.appendChild(add('span', 'lbl', f.label));
          if (f.type === 'seg') {
            const seg = add('div', 'seg');
            seg.setAttribute('role', 'radiogroup');
            f.options.forEach((o) => {
              const ov = typeof o === 'object' ? o.value : o;
              const b = add('button', ov === f.value ? 'on' : '', typeof o === 'object' ? o.label : o);
              b.type = 'button';
              b.setAttribute('role', 'radio');
              if (o.disabled) b.disabled = true;
              b.onclick = (e) => {
                e.preventDefault();
                values[f.key] = ov;
                [...seg.children].forEach((c) => c.classList.toggle('on', c === b));
                if (f.onChange) f.onChange(ov, values, box);
              };
              seg.appendChild(b);
            });
            wrap.appendChild(seg);
          } else {
            const fld = add('span', f.type === 'textarea' ? 'fld area' : 'fld');
            let inp;
            if (f.type === 'textarea') {
              inp = add('textarea');
              inp.rows = f.rows || 4;
              inp.value = f.value || '';
              if (f.placeholder) inp.placeholder = f.placeholder;
              inp.oninput = () => { values[f.key] = inp.value; };
              // Enter makes a new line here instead of pressing the default button
              inp.onkeydown = (e) => { if (e.key === 'Enter') e.stopPropagation(); };
            } else if (f.type === 'select') {
              inp = add('select');
              f.options.forEach((o) => {
                const opt = add('option', '', typeof o === 'object' ? o.label : o);
                opt.value = typeof o === 'object' ? o.value : o;
                if (opt.value === String(f.value)) opt.selected = true;
                inp.appendChild(opt);
              });
              inp.onchange = () => { values[f.key] = inp.value; };
            } else {
              inp = add('input', f.type === 'number' ? '' : 'sans');
              inp.type = 'text';
              inp.value = f.value === undefined || f.value === null ? '' : String(f.value);
              inp.oninput = () => { values[f.key] = f.type === 'number' ? inp.value : inp.value; };
            }
            inputs.push(inp);
            fld.appendChild(inp);
            if (f.unit) fld.appendChild(add('span', 'lbl', f.unit));
            wrap.appendChild(fld);
          }
        }
        if (wrap.classList.contains('full')) { box.appendChild(wrap); row = null; }
        else {
          if (!row) { row = add('div', 'row'); box.appendChild(row); }
          row.appendChild(wrap);
          if (row.children.length >= 2) row = null;
        }
      });
      const btns = add('div', 'btns');
      const buttons = spec.buttons || [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', primary: true }];
      const close = (val) => {
        scrim.remove();
        document.removeEventListener('keydown', onKey, true);
        if (val === null || val === undefined) return resolve(null);
        const out = {};
        for (const f of spec.fields || []) out[f.key] = f.type === 'number' ? parseFloat(String(values[f.key]).replace(',', '.')) : values[f.key];
        resolve({ button: val, values: out });
      };
      buttons.forEach((b) => {
        const el = add('button', b.primary ? 'primary' : b.danger ? 'danger' : '', b.label);
        el.type = 'button';
        el.onclick = () => close(b.value);
        btns.appendChild(el);
      });
      box.appendChild(btns);
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(null); }
        if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
          e.stopPropagation(); e.preventDefault();
          const p = buttons.find((b) => b.primary || b.danger);
          if (p) close(p.value);
        }
      };
      document.addEventListener('keydown', onKey, true);
      scrim.appendChild(box);
      scrim.onmousedown = (e) => { if (e.target === scrim) close(null); };
      document.body.appendChild(scrim);
      setTimeout(() => (inputs[0] ? (inputs[0].focus(), inputs[0].select && inputs[0].select()) : btns.lastChild.focus()), 0);
    });
  }
  const confirm = async (title, message, okLabel, danger) => {
    const r = await dialog({ title, message, buttons: [{ label: 'Cancel', value: null }, { label: okLabel || 'OK', value: 'ok', primary: !danger, danger: !!danger }] });
    return !!r;
  };

  // ------------------------------------------------------------ send dialog
  // opts: { title, rows: [[k, v]], via: 'Ethernet'|'Local', blocked: [msg], warnings: [msg],
  //         check(): Promise (rejects when the machine doesn't answer), send(via): Promise<result|null>,
  //         doneLabel(result) }
  function sendDialog(opts) {
    return new Promise((resolve) => {
      const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
      const scrim = el('div', 'lrc-scrim');
      const box = el('div', 'lrc-dlg');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', opts.title);
      box.appendChild(el('h2', '', opts.title));
      const t = el('table');
      opts.rows.forEach(([a, b]) => { const tr = el('tr'); tr.appendChild(el('td', '', a)); tr.appendChild(el('td', numCls(b), b)); t.appendChild(tr); });
      box.appendChild(t);
      let via = opts.via === 'Ethernet' ? 'Ethernet' : 'Local';
      const wrap = el('label', 'full');
      wrap.appendChild(el('span', 'lbl', 'Send via'));
      const seg = el('div', 'seg');
      seg.setAttribute('role', 'radiogroup');
      const segBtns = [['Ethernet', 'Ethernet'], ['Local', 'Save locally']].map(([v, l]) => {
        const b = el('button', v === via ? 'on' : '', l);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.onclick = (e) => { e.preventDefault(); if (busy) return; via = v; segBtns.forEach((x) => x.classList.toggle('on', x === b)); refresh(); };
        seg.appendChild(b);
        return b;
      });
      wrap.appendChild(seg);
      box.appendChild(wrap);
      const status = el('div');
      box.appendChild(status);
      const bar = el('div', 'lrc-progress');
      bar.appendChild(el('div'));
      bar.style.display = 'none';
      box.appendChild(bar);
      const btns = el('div', 'btns');
      const cancel = el('button', '', 'Cancel');
      const go = el('button', 'primary', '');
      cancel.type = go.type = 'button';
      btns.appendChild(cancel);
      btns.appendChild(go);
      box.appendChild(btns);

      let busy = false, online = null, checkErr = '', sent = null, sendErr = '', checking = false;
      const note = (cls, text, action) => {
        const n = el('div', 'note ' + cls, text);
        if (action) { const a = el('button', '', action.l); a.type = 'button'; a.onclick = action.run; n.appendChild(a); }
        status.appendChild(n);
      };
      function refresh() {
        status.innerHTML = '';
        if (sent) {
          note('ok', opts.doneLabel ? opts.doneLabel(sent, via) : 'Sent');
        } else {
          (opts.blocked || []).forEach((m) => note('err', m));
          if (sendErr) note('err', sendErr);
          else if (via === 'Ethernet' && online === false) note('err', 'Connection failed — ' + checkErr, { l: 'Try again', run: () => runCheck() });
          if (via === 'Ethernet' && checking) note('muted', 'Checking connection…');
          (opts.warnings || []).forEach((m) => note('warn', m));
        }
        go.textContent = sent ? 'Done' : busy ? (via === 'Ethernet' ? 'Sending…' : 'Saving…') : via === 'Ethernet' ? opts.sendLabel || 'Send' : 'Save…';
        go.disabled = !sent && (busy || (opts.blocked || []).length > 0 || (via === 'Ethernet' && online !== true));
        cancel.disabled = busy;
        cancel.style.display = sent ? 'none' : '';
      }
      async function runCheck() {
        checking = true; online = null; sendErr = ''; refresh();
        try { await opts.check(); online = true; } catch (err) { online = false; checkErr = err.message; }
        checking = false;
        refresh();
      }
      const close = (val) => { scrim.remove(); document.removeEventListener('keydown', onKey, true); resolve(val); };
      const onKey = (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); close(sent); } };
      cancel.onclick = () => close(null);
      go.onclick = async () => {
        if (sent) return close(sent);
        busy = true; sendErr = '';
        if (via === 'Ethernet') {
          bar.style.display = '';
          bar.classList.remove('done');
          bar.firstChild.style.width = '0';
          requestAnimationFrame(() => requestAnimationFrame(() => { bar.firstChild.style.width = '88%'; }));
        }
        refresh();
        try {
          const r = await opts.send(via);
          busy = false;
          if (!r) { bar.style.display = 'none'; refresh(); return; } // save window cancelled
          sent = r;
          bar.style.display = via === 'Ethernet' ? '' : 'none';
          bar.classList.add('done');
          refresh();
          setTimeout(() => { if (document.body.contains(scrim)) close(sent); }, 1600);
        } catch (err) {
          busy = false;
          bar.style.display = 'none';
          sendErr = (via === 'Ethernet' && err.offline ? 'Connection failed — ' : '') + err.message;
          if (err.offline) online = false;
          refresh();
        }
      };
      document.addEventListener('keydown', onKey, true);
      scrim.appendChild(box);
      document.body.appendChild(scrim);
      refresh();
      if (opts.check) runCheck(); else { online = true; refresh(); }
    });
  }

  // ------------------------------------------------------------ keyboard
  function keys(map) {
    const onKey = (e) => {
      if (document.querySelector('.lrc-scrim')) return;
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const k = (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.altKey ? 'Alt+' : '') + (e.key.length === 1 ? e.key.toUpperCase() : e.key);
      const fn = map[k];
      if (!fn) return;
      if (typing && !k.startsWith('Ctrl+') && !/^F\d+$/.test(e.key)) return;
      if (typing && ['Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y'].includes(k)) return;
      e.preventDefault();
      fn(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }

  // ------------------------------------------------------------ context menu
  // items: { l, k, run, off } | '-' | { swatches: [{ n, hex, on, title, run }], label, other }
  let openMenu = null;
  function closeMenu() {
    if (openMenu) { openMenu.remove(); openMenu = null; }
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }
  function onOutside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
  function onMenuKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }
  function contextMenu(x, y, items) {
    closeMenu();
    const m = document.createElement('div');
    m.setAttribute('role', 'menu');
    m.className = 'lrc-menu';
    for (const it of items) {
      if (it === '-') {
        const s = document.createElement('div');
        s.setAttribute('role', 'separator');
        s.className = 'sep';
        m.appendChild(s);
        continue;
      }
      if (it.swatches) {
        const wrap = document.createElement('div');
        wrap.className = 'sw-wrap';
        const lab = document.createElement('div');
        lab.textContent = it.label || 'Colour';
        lab.className = 'sw-lbl';
        wrap.appendChild(lab);
        const row = document.createElement('div');
        row.className = 'sw-row';
        for (const sw of it.swatches) {
          const b = document.createElement('button');
          b.type = 'button';
          b.title = sw.title || 'ACI ' + sw.n;
          b.setAttribute('aria-label', b.title);
          b.textContent = sw.n;
          b.className = 'aci' + (sw.on ? ' on' : '');
          // the swatch is the real ACI colour (ACI 7 follows the theme)
          b.style.background = aci.hex(sw.n);
          b.style.color = aci.fg(sw.n);
          b.onclick = () => { closeMenu(); sw.run(); };
          row.appendChild(b);
        }
        if (it.other) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = 'ACI #';
          b.className = 'aci-other';
          b.onclick = () => { closeMenu(); it.other(); };
          row.appendChild(b);
        }
        wrap.appendChild(row);
        m.appendChild(wrap);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.disabled = !!it.off;
      b.className = 'mi';
      const l = document.createElement('span');
      l.textContent = it.l;
      b.appendChild(l);
      if (it.k) {
        const k = document.createElement('span');
        k.textContent = it.k;
        k.className = 'k';
        b.appendChild(k);
      }
      b.onclick = () => { closeMenu(); if (!it.off) it.run(); };
      m.appendChild(b);
    }
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
    openMenu = m;
    setTimeout(() => {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onMenuKey, true);
    }, 0);
  }

  // Ask before leaving a page with unsaved edits (links between pages).
  function guardNav(isDirty, save) {
    const onClick = async (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a || !isDirty() || a.getAttribute('href').startsWith('#')) return;
      e.preventDefault();
      e.stopPropagation();
      const r = await dialog({ title: 'Save changes?', message: 'You have unsaved changes on this page.', buttons: [{ label: 'Cancel', value: null }, { label: "Don't save", value: 'drop' }, { label: 'Save', value: 'save', primary: true }] });
      if (!r) return;
      if (r.button === 'save') {
        try { await save(); } catch (err) { return fail(err); }
      }
      location.href = a.href;
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }

  // clipboard shared between pages for the session
  const clip = {
    get() { try { return JSON.parse(sessionStorage.getItem('lrc-clip') || 'null'); } catch (e) { return null; } },
    set(v) { try { sessionStorage.setItem('lrc-clip', JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };

  // ------------------------------------------------------------ job operations
  // All operations take a job and a list of selected ids and return a new job
  // (and sometimes a new selection); nothing mutates in place.
  const ops = {};
  const byId = (job) => new Map(job.entities.map((e) => [e.id, e]));
  ops.expand = (job, ids) => {
    const groups = new Set(job.entities.filter((e) => ids.includes(e.id) && e.group).map((e) => e.group));
    const off = ops.offAci(job);
    return job.entities.filter((e) => ids.includes(e.id) || (e.group && groups.has(e.group) && !off.has(e.aci))).map((e) => e.id);
  };
  // colours of processes hidden on the canvas (eye icon) or with output off
  ops.offAci = (job) => new Set(job.processes.filter((p) => p.hidden || p.out === false).flatMap((p) => p.aci || []));
  // everything that can be selected (visible, process output on)
  ops.pickableIds = (job) => { const off = ops.offAci(job); return job.entities.filter((e) => !e.hidden && !off.has(e.aci)).map((e) => e.id); };
  ops.selected = (job, ids) => {
    const set = new Set(ids);
    return job.entities.filter((e) => set.has(e.id));
  };
  ops.editable = (job, ids) => ops.selected(job, ids).filter((e) => !e.locked);
  const mapSel = (job, ids, fn) => {
    const set = new Set(ops.editable(job, ids).map((e) => e.id));
    return { ...job, entities: job.entities.map((e) => (set.has(e.id) ? fn(e) : e)) };
  };
  ops.selBox = (job, ids) => CC.boxOf(ops.selected(job, ids));
  ops.translate = (job, ids, dx, dy) => mapSel(job, ids, (e) => CC.translate(e, dx, dy));
  ops.remove = (job, ids) => {
    const set = new Set(ops.editable(job, ids).map((e) => e.id));
    return { ...job, entities: job.entities.filter((e) => !set.has(e.id)) };
  };
  // Names for copies: "Ring" → "Ring 2", "Ring 3"… numbered on from the
  // highest number already used for that name in the job.
  ops.copyNamer = (entities) => {
    const top = new Map();
    const split = (n) => { const m = /^(.*\S) (\d+)$/.exec(n || ''); return m ? [m[1], Number(m[2])] : [n || 'Object', 1]; };
    for (const e of entities) { const [b, k] = split(e.name); top.set(b, Math.max(top.get(b) || 1, k)); }
    return (name) => { const [b] = split(name); const k = (top.get(b) || 1) + 1; top.set(b, k); return b + ' ' + k; };
  };
  const freshCopy = (e, gmap, nm) => ({ ...e, id: CC.uid('e'), name: nm ? nm(e.name) : e.name, group: e.group ? (gmap[e.group] = gmap[e.group] || CC.uid('g')) : null, locked: false });
  ops.duplicate = (job, ids, dx, dy) => {
    const gmap = {}, nm = ops.copyNamer(job.entities);
    const copies = ops.selected(job, ids).map((e) => CC.translate(freshCopy(e, gmap, nm), dx === undefined ? 5 : dx, dy === undefined ? 5 : dy));
    return { job: { ...job, entities: job.entities.concat(copies) }, sel: copies.map((e) => e.id) };
  };
  ops.paste = (job, ents, at) => {
    const gmap = {}, nm = ops.copyNamer(job.entities);
    const b = CC.boxOf(ents);
    const dx = at ? at[0] - b.x0 : 5, dy = at ? at[1] - b.y0 : 5;
    // after a cut the name is free again, so the pasted object keeps it
    const taken = new Set(job.entities.map((e) => e.name));
    const copies = ents.map((e) => CC.translate(freshCopy(e, gmap, taken.has(e.name) ? nm : null), dx, dy));
    return { job: { ...job, entities: job.entities.concat(copies) }, sel: copies.map((e) => e.id) };
  };
  ops.align = (job, ids, how, ref) => {
    const sel = ops.editable(job, ids);
    if (!sel.length) return job;
    const B = sel.length > 1 && !ref ? CC.boxOf(sel) : ref;
    // align each group as one unit
    const units = new Map();
    sel.forEach((e) => { const k = e.group || e.id; if (!units.has(k)) units.set(k, []); units.get(k).push(e); });
    const moves = new Map();
    for (const list of units.values()) {
      const b = CC.boxOf(list);
      let dx = 0, dy = 0;
      if (how === 'left') dx = B.x0 - b.x0;
      if (how === 'right') dx = B.x1 - b.x1;
      if (how === 'centre') dx = (B.x0 + B.x1) / 2 - (b.x0 + b.x1) / 2;
      if (how === 'top') dy = B.y0 - b.y0;
      if (how === 'bottom') dy = B.y1 - b.y1;
      if (how === 'middle') dy = (B.y0 + B.y1) / 2 - (b.y0 + b.y1) / 2;
      list.forEach((e) => moves.set(e.id, [dx, dy]));
    }
    return { ...job, entities: job.entities.map((e) => (moves.has(e.id) ? CC.translate(e, ...moves.get(e.id)) : e)) };
  };
  ops.distribute = (job, ids, axis) => {
    const sel = ops.editable(job, ids);
    const units = new Map();
    sel.forEach((e) => { const k = e.group || e.id; if (!units.has(k)) units.set(k, []); units.get(k).push(e); });
    const list = [...units.values()].map((l) => ({ l, b: CC.boxOf(l) }));
    if (list.length < 3) return job;
    const lo = axis === 'x' ? 'x0' : 'y0', hi = axis === 'x' ? 'x1' : 'y1';
    list.sort((a, b) => a.b[lo] - b.b[lo]);
    const total = list.reduce((s, u) => s + (u.b[hi] - u.b[lo]), 0);
    const span = list[list.length - 1].b[hi] - list[0].b[lo];
    const gap = (span - total) / (list.length - 1);
    let at = list[0].b[lo];
    const moves = new Map();
    list.forEach((u) => {
      const d = at - u.b[lo];
      u.l.forEach((e) => moves.set(e.id, axis === 'x' ? [d, 0] : [0, d]));
      at += u.b[hi] - u.b[lo] + gap;
    });
    return { ...job, entities: job.entities.map((e) => (moves.has(e.id) ? CC.translate(e, ...moves.get(e.id)) : e)) };
  };
  ops.mirror = (job, ids, axis) => {
    const b = CC.boxOf(ops.editable(job, ids));
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    return mapSel(job, ids, (e) => {
      const m = CC.scaleAbout(e, axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1, cx, cy);
      return { ...m, paths: m.paths.map((p) => ({ ...p, p: p.p.slice().reverse() })) };
    });
  };
  ops.rotate = (job, ids, deg) => {
    const b = CC.boxOf(ops.editable(job, ids));
    return mapSel(job, ids, (e) => ({ ...CC.rotateAbout(e, deg, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2), rot: ((e.rot || 0) + deg) % 360 }));
  };
  ops.scale = (job, ids, sx, sy, cx, cy) => mapSel(job, ids, (e) => CC.scaleAbout(e, sx, sy, cx, cy));
  ops.order = (job, ids, how) => {
    const set = new Set(ids);
    const sel = job.entities.filter((e) => set.has(e.id));
    const rest = job.entities.filter((e) => !set.has(e.id));
    if (how === 'front') return { ...job, entities: rest.concat(sel) };
    if (how === 'back') return { ...job, entities: sel.concat(rest) };
    const list = job.entities.slice();
    const idx = list.map((e, i) => (set.has(e.id) ? i : -1)).filter((i) => i >= 0);
    if (how === 'forward') for (let k = idx.length - 1; k >= 0; k--) { const i = idx[k]; if (i < list.length - 1 && !set.has(list[i + 1].id)) [list[i], list[i + 1]] = [list[i + 1], list[i]]; }
    if (how === 'backward') for (const i of idx) { if (i > 0 && !set.has(list[i - 1].id)) [list[i], list[i - 1]] = [list[i - 1], list[i]]; }
    return { ...job, entities: list };
  };
  ops.group = (job, ids) => {
    const g = CC.uid('g');
    return { ...job, entities: job.entities.map((e) => (ids.includes(e.id) ? { ...e, group: g } : e)) };
  };
  ops.ungroup = (job, ids) => ({ ...job, entities: job.entities.map((e) => (ids.includes(e.id) ? { ...e, group: null } : e)) });
  ops.setAci = (job, ids, aci) => mapSel(job, ids, (e) => ({ ...e, aci }));
  ops.setFlag = (job, ids, k, v) => ({ ...job, entities: job.entities.map((e) => (ids.includes(e.id) ? { ...e, [k]: v } : e)) });
  // Absolute position/size of the selection (Objects panel fields).
  ops.setProps = (job, ids, p) => {
    const b = CC.boxOf(ops.editable(job, ids));
    if (!CC.boxValid(b)) return job;
    let out = job;
    const w = b.x1 - b.x0, hh = b.y1 - b.y0;
    if (p.w !== undefined && w > 0 && p.w > 0) out = ops.scale(out, ids, p.w / w, p.lock ? p.w / w : 1, b.x0, b.y0);
    if (p.h !== undefined && hh > 0 && p.h > 0) out = ops.scale(out, ids, p.lock ? p.h / hh : 1, p.h / hh, b.x0, b.y0);
    if (p.rot !== undefined) {
      const cur = (ops.selected(job, ids)[0] || {}).rot || 0;
      if (p.rot - cur) out = ops.rotate(out, ids, p.rot - cur);
    }
    const nb = CC.boxOf(ops.selected(out, ids));
    if (p.x !== undefined || p.y !== undefined) out = ops.translate(out, ids, p.x !== undefined ? p.x - nb.x0 : 0, p.y !== undefined ? p.y - nb.y0 : 0);
    return out;
  };

  // Clipper-based boolean / offset (closed paths only), in micrometres.
  const S = 1000;
  const toClip = (paths) => paths.map((p) => p.p.map(([x, y]) => ({ X: Math.round(x * S), Y: Math.round(y * S) })));
  const fromClip = (polys) => polys.filter((p) => p.length > 2).map((p) => ({ p: p.map((q) => [q.X / S, q.Y / S]), c: true }));
  ops.weld = (job, ids) => {
    const CL = window.ClipperLib;
    const sel = ops.editable(job, ids).filter((e) => e.paths.some((p) => p.c));
    if (sel.length < 2) throw new Error('Select two or more closed shapes to weld');
    const c = new CL.Clipper();
    sel.forEach((e) => c.AddPaths(toClip(e.paths.filter((p) => p.c)), CL.PolyType.ptSubject, true));
    const out = new CL.Paths();
    c.Execute(CL.ClipType.ctUnion, out, CL.PolyFillType.pftNonZero, CL.PolyFillType.pftNonZero);
    const paths = fromClip(out);
    const set = new Set(sel.map((e) => e.id));
    const ent = { id: CC.uid('e'), name: 'Welded shape', type: 'Welded shape', aci: sel[0].aci, paths };
    return { job: { ...job, entities: job.entities.filter((e) => !set.has(e.id)).concat(ent) }, sel: [ent.id] };
  };
  ops.offset = (job, ids, delta) => {
    const CL = window.ClipperLib;
    const sel = ops.selected(job, ids);
    const co = new CL.ClipperOffset(2, 0.25 * S);
    sel.forEach((e) => e.paths.forEach((p) => co.AddPath(toClip([p])[0], CL.JoinType.jtRound, p.c ? CL.EndType.etClosedPolygon : CL.EndType.etOpenRound)));
    const out = new CL.Paths();
    co.Execute(out, delta * S);
    const paths = fromClip(out);
    if (!paths.length) throw new Error('The offset removed the whole shape — use a smaller inward offset');
    const ent = { id: CC.uid('e'), name: 'Offset ' + (delta > 0 ? '+' : '') + delta + ' mm', type: 'Offset path', aci: sel[0] ? sel[0].aci : 7, paths };
    return { job: { ...job, entities: job.entities.concat(ent) }, sel: [ent.id] };
  };
  ops.array = (job, ids, cols, rows, gx, gy) => {
    const sel = ops.selected(job, ids);
    const b = CC.boxOf(sel);
    const w = b.x1 - b.x0, hh = b.y1 - b.y0;
    const add = [], nm = ops.copyNamer(job.entities);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (!r && !c) continue;
      const gmap = {};
      sel.forEach((e) => add.push(CC.translate(freshCopy(e, gmap, nm), c * (w + gx), r * (hh + gy))));
    }
    return { job: { ...job, entities: job.entities.concat(add) }, sel: ids.concat(add.map((e) => e.id)) };
  };
  // How many copies of the selection fit an area (and where they go).
  ops.fillPlan = (job, ids, area, spacing, margin) => {
    const b = CC.boxOf(ops.selected(job, ids));
    const w = b.x1 - b.x0, hh = b.y1 - b.y0;
    if (!(w > 0 || hh > 0)) return { cols: 0, rows: 0, per: 0, w, h: hh };
    const W = area.w - 2 * margin, H = area.h - 2 * margin;
    const cols = Math.max(0, Math.floor((W + spacing) / (w + spacing)));
    const rows = Math.max(0, Math.floor((H + spacing) / (hh + spacing)));
    return { cols, rows, per: cols * rows, w, h: hh, x0: area.x + margin, y0: area.y + margin };
  };
  // Fill: place `count` copies (or as many as fit) over one or more areas.
  // areas: list of {x, y, w, h, bed} tried in order.
  ops.fill = (job, ids, areas, count, spacing, margin) => {
    const sel = ops.selected(job, ids);
    const b = CC.boxOf(sel);
    const placed = [];
    let need = count;
    const add = [];
    for (const area of areas) {
      const plan = ops.fillPlan(job, ids, area, spacing, margin);
      for (let r = 0; r < plan.rows; r++) for (let c = 0; c < plan.cols; c++) {
        if (need !== null && placed.length >= need) break;
        const x = plan.x0 + c * (plan.w + spacing), y = plan.y0 + r * (plan.h + spacing);
        placed.push([x, y, area.bed || 0]);
      }
    }
    // the first copy is the original, moved into place
    const gmapFirst = {}, nm = ops.copyNamer(job.entities);
    let out = job;
    placed.forEach(([x, y, bed], i) => {
      if (i === 0) {
        out = ops.translate(out, ids, x - b.x0, y - b.y0);
        out = { ...out, entities: out.entities.map((e) => (ids.includes(e.id) ? { ...e, bed } : e)) };
        return;
      }
      const gmap = {};
      sel.forEach((e) => add.push({ ...CC.translate(freshCopy(e, gmap, nm), x - b.x0, y - b.y0), bed }));
    });
    void gmapFirst;
    return { job: { ...out, entities: out.entities.concat(add) }, placed: placed.length, sel: ids.concat(add.map((e) => e.id)) };
  };
  // Nesting: pack whole parts (a group counts as one part) into an area with
  // CC.nestRects, turning parts 90° where that packs better (opts.rotate).
  //   opts: { area: { x, y, w, h }, spacing, margin, rotate, beds }
  //   beds: true adds plotter beds as needed; otherwise one area, and parts that
  //   don't fit stay where they are.
  // Returns { job, sel, nested, unplaced, areas, util }.
  ops.nest = (job, ids, opts) => {
    const sel = ops.editable(job, ids.length ? ids : job.entities.filter((e) => !e.hidden).map((e) => e.id));
    const units = new Map();
    sel.forEach((e) => { const k = e.group || e.id; if (!units.has(k)) units.set(k, []); units.get(k).push(e); });
    const list = [...units.entries()].map(([k, l]) => ({ id: k, l, b: CC.boxOf(l) }));
    const m = Math.max(0, Number(opts.margin) || 0);
    const area = { w: opts.area.w - 2 * m, h: opts.area.h - 2 * m };
    const r = CC.nestRects(list.map((u) => ({ id: u.id, w: CC.boxW(u.b), h: CC.boxH(u.b) })), area, { spacing: opts.spacing, rotate: opts.rotate, maxAreas: opts.beds ? Infinity : 1 });
    const byId = new Map(list.map((u) => [u.id, u]));
    const out = new Map();
    for (const p of r.placed) {
      const u = byId.get(p.id);
      const cx = (u.b.x0 + u.b.x1) / 2, cy = (u.b.y0 + u.b.y1) / 2;
      let ents = p.rot ? u.l.map((e) => CC.rotateAbout(e, p.rot, cx, cy)) : u.l;
      const nb = CC.boxOf(ents);
      const dx = opts.area.x + m + p.x - nb.x0, dy = opts.area.y + m + p.y - nb.y0;
      ents.forEach((e) => out.set(e.id, { ...CC.translate(e, dx, dy), bed: opts.beds ? p.area : e.bed || 0 }));
    }
    const nested = sel.filter((e) => out.has(e.id)).map((e) => e.id);
    return {
      job: { ...job, beds: opts.beds ? Math.max(job.beds || 1, r.areas) : job.beds, entities: job.entities.map((e) => out.get(e.id) || e) },
      sel: nested, nested: r.placed.length, unplaced: r.unplaced.length, areas: r.areas, util: r.util
    };
  };

  // Text → outlined paths with the bundled IBM Plex Sans.
  let fontP = null;
  function loadFont() {
    if (!fontP) {
      fontP = fetch('../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff')
        .then((r) => r.arrayBuffer())
        .then((buf) => window.opentype.parse(buf));
    }
    return fontP;
  }
  async function textEntity(text, sizeMm, x, y, aci) {
    const font = await loadFont();
    const path = font.getPath(text, x, y + sizeMm * 0.8, sizeMm * 1.35);
    const polys = [];
    let cur = null, cx = 0, cy = 0;
    const N = 8;
    for (const c of path.commands) {
      if (c.type === 'M') { if (cur && cur.length > 1) polys.push(cur); cur = [[c.x, c.y]]; cx = c.x; cy = c.y; }
      else if (c.type === 'L') { cur.push([c.x, c.y]); cx = c.x; cy = c.y; }
      else if (c.type === 'Q') {
        for (let i = 1; i <= N; i++) { const t = i / N, u = 1 - t; cur.push([u * u * cx + 2 * u * t * c.x1 + t * t * c.x, u * u * cy + 2 * u * t * c.y1 + t * t * c.y]); }
        cx = c.x; cy = c.y;
      } else if (c.type === 'C') {
        for (let i = 1; i <= N; i++) { const t = i / N, u = 1 - t; cur.push([u * u * u * cx + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x, u * u * u * cy + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y]); }
        cx = c.x; cy = c.y;
      } else if (c.type === 'Z') { if (cur && cur.length > 2) polys.push(cur); cur = null; }
    }
    if (cur && cur.length > 1) polys.push(cur);
    if (!polys.length) throw new Error('Nothing to draw for that text');
    return { id: CC.uid('e'), name: '“' + text.slice(0, 24) + '”', type: 'Text', text, aci: aci || 7, paths: polys.map((p) => ({ p: CC.cleanPath(p, true), c: true })) };
  }

  // ------------------------------------------------------------ job canvas
  const dCache = new WeakMap();
  function entityD(e) {
    let d = dCache.get(e);
    if (d === undefined) {
      d = e.paths.map((path) => {
        const p = path.p;
        if (!p.length) return '';
        let s = 'M' + p[0][0].toFixed(3) + ' ' + p[0][1].toFixed(3);
        for (let i = 1; i < p.length; i++) s += 'L' + p[i][0].toFixed(3) + ' ' + p[i][1].toFixed(3);
        return s + (path.c ? 'Z' : '');
      }).join('');
      dCache.set(e, d);
    }
    return d;
  }
  const PX_PER_MM = 96 / 25.4;

  class JobCanvas extends window.React.Component {
    constructor(props) {
      super(props);
      this.state = { view: null, drag: null, w: 0, h: 0 };
      this.root = window.React.createRef();
      this.space = false;
    }
    componentDidMount() {
      const el = this.root.current;
      this.ro = new ResizeObserver(() => {
        const r = el.getBoundingClientRect();
        const first = !this.state.view;
        this.setState({ w: r.width, h: r.height }, () => { if (first) this.fit(); });
      });
      this.ro.observe(el);
      this.onWheel = (e) => {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        if (e.shiftKey && !e.ctrlKey) return this.pan(-e.deltaY, 0);
        this.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      };
      el.addEventListener('wheel', this.onWheel, { passive: false });
      this.onKeyDown = (e) => { if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) { this.space = true; } };
      this.onKeyUp = (e) => { if (e.code === 'Space') this.space = false; };
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
      if (this.props.canvasRef) this.props.canvasRef(this);
    }
    componentWillUnmount() {
      this.ro.disconnect();
      this.root.current.removeEventListener('wheel', this.onWheel);
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
      if (this.props.canvasRef) this.props.canvasRef(null);
    }
    componentDidUpdate(prev) {
      const pm = prev.machine || {}, m = this.props.machine || {};
      const beds = (p) => (p.machine && p.machine.type === 'plotter' && p.job ? CC.bedCount(p.job) : 1);
      if (pm.id !== m.id || beds(prev) !== beds(this.props)) this.fit();
    }
    bed() { return CC.bedOf(this.props.machine); }
    isPlot() { return this.props.machine && this.props.machine.type === 'plotter'; }
    nBeds() {
      if (!this.isPlot()) return 1;
      return CC.bedCount(this.props.job);
    }
    // whole 100 mm so every bed lines up with the same snapping grid
    gap() { return Math.max(100, Math.ceil((this.bed()[0] * 0.06) / 100) * 100); }
    bedX(k) { return k * (this.bed()[0] + this.gap()); }
    world() {
      const [bw, bh] = this.bed();
      const n = this.nBeds();
      return { w: n * bw + (n - 1) * this.gap(), h: bh };
    }
    fit() {
      const { w, h } = this.state;
      if (!w || !h) return;
      const W = this.world();
      const s = Math.min((w - 60) / W.w, (h - 70) / W.h);
      const view = { s, tx: (w - W.w * s) / 2, ty: (h - W.h * s) / 2 + 10 };
      this.setState({ view });
      this.report(view);
    }
    report(view) {
      if (this.props.onView) this.props.onView({ zoom: Math.round((view.s / PX_PER_MM) * 100) });
    }
    zoomAt(f, x, y) {
      const v = this.state.view;
      if (!v) return;
      const s = Math.max(0.02, Math.min(200, v.s * f));
      const k = s / v.s;
      const view = { s, tx: x - (x - v.tx) * k, ty: y - (y - v.ty) * k };
      this.setState({ view });
      this.report(view);
    }
    zoomBy(f) { this.zoomAt(f, this.state.w / 2, this.state.h / 2); }
    zoomActual() { this.zoomBy(PX_PER_MM / this.state.view.s); }
    pan(dx, dy) {
      const v = this.state.view;
      this.setState({ view: { ...v, tx: v.tx + dx, ty: v.ty + dy } });
    }
    // screen → world mm; also which bed (plotter) and bed-local coordinates
    toWorld(cx, cy) {
      const r = this.root.current.getBoundingClientRect();
      const v = this.state.view;
      const x = (cx - r.left - v.tx) / v.s, y = (cy - r.top - v.ty) / v.s;
      let bed = 0;
      if (this.isPlot()) {
        const step = this.bed()[0] + this.gap();
        bed = Math.max(0, Math.min(this.nBeds() - 1, Math.floor((x + this.gap() / 2) / step)));
      }
      return { x, y, bed, lx: x - this.bedX(bed), ly: y };
    }
    entsWorld() {
      return this.props.job.entities.filter((e) => !e.hidden);
    }
    // Objects whose process is hidden (eye icon) or has its output off can't
    // be picked on the canvas.
    pickable() {
      const job = this.props.job;
      const off = ops.offAci(job);
      return job.entities.filter((e) => !e.hidden && !off.has(e.aci));
    }
    // world-space offset of an entity's bed
    off(e) { return this.isPlot() ? this.bedX(e.bed || 0) : 0; }
    hit(wx, wy) {
      const tol = 5 / this.state.view.s;
      const list = this.pickable();
      const reg = CC.regMarkAci(this.props.job);
      let best = null, bd = tol, ba = Infinity;
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        const ox = this.off(e);
        const b = CC.entityBox(e);
        if (wx < b.x0 + ox - tol || wx > b.x1 + ox + tol || wy < b.y0 - tol || wy > b.y1 + tol) continue;
        // reg marks are drawn solid, so a click anywhere inside one picks it
        const solid = reg.has(e.aci) && e.paths.some((q) => q.c && CC.pointInPoly(wx - ox, wy, q.p));
        const d = solid ? 0 : CC.distToEntity(e, wx - ox, wy);
        const a = CC.boxW(b) * CC.boxH(b);
        // on a tie (a mark sitting exactly in a ring's hole) the smaller object wins
        if (d < bd - 1e-9 || (d <= bd + 1e-9 && a < ba)) { bd = d; ba = a; best = e; }
      }
      return best;
    }
    selBoxWorld() {
      const sel = ops.selected(this.props.job, this.props.sel || []).filter((e) => !e.hidden);
      if (!sel.length) return null;
      const b = CC.EMPTY_BOX();
      sel.forEach((e) => { const eb = CC.entityBox(e); const ox = this.off(e); CC.growBox(b, eb.x0 + ox, eb.y0); CC.growBox(b, eb.x1 + ox, eb.y1); });
      return b;
    }
    // Grid spacing in mm: the finest of 1/2/5/10… that is at least 8 px on screen.
    // The canvas draws this grid, and snapping uses the same lines.
    gridStep() {
      const s = this.state.view ? this.state.view.s : 1;
      return [1, 2, 5, 10, 20, 50, 100, 200].find((g) => g * s >= 8) || 500;
    }
    // Nearest point on an object outline within a few pixels: corners/vertices
    // first, then anywhere along an edge. Returns { x, y, kind } in world mm.
    snapToContour(wx, wy) {
      const v = this.state.view;
      const tol = 9 / v.s;
      let best = null, bd = tol;
      for (const e of this.entsWorld()) {
        const ox = this.off(e);
        const b = CC.entityBox(e);
        if (wx < b.x0 + ox - tol || wx > b.x1 + ox + tol || wy < b.y0 - tol || wy > b.y1 + tol) continue;
        for (const path of e.paths) {
          const p = path.p;
          for (let i = 0; i < p.length; i++) {
            const d = Math.hypot(p[i][0] + ox - wx, p[i][1] - wy);
            if (d < bd) { bd = d; best = { x: p[i][0] + ox, y: p[i][1], kind: 'vertex' }; }
          }
        }
      }
      // vertices win; otherwise the nearest point along an edge
      if (best) return best;
      bd = tol * 0.8;
      for (const e of this.entsWorld()) {
        const ox = this.off(e);
        const b = CC.entityBox(e);
        if (wx < b.x0 + ox - tol || wx > b.x1 + ox + tol || wy < b.y0 - tol || wy > b.y1 + tol) continue;
        for (const path of e.paths) {
          const p = path.p, n = p.length, m = path.c ? n : n - 1;
          for (let i = 0; i < m; i++) {
            const ax = p[i][0] + ox, ay = p[i][1], bx = p[(i + 1) % n][0] + ox, by = p[(i + 1) % n][1];
            const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
            const t = L ? Math.max(0, Math.min(1, ((wx - ax) * dx + (wy - ay) * dy) / L)) : 0;
            const qx = ax + t * dx, qy = ay + t * dy;
            const d = Math.hypot(qx - wx, qy - wy);
            if (d < bd) { bd = d; best = { x: qx, y: qy, kind: 'edge' }; }
          }
        }
      }
      return best;
    }
    // Where a drawing/measuring point lands: on an outline (measure and line
    // tools), else on the grid when grid snap is on.
    snapPoint(w, tool) {
      if (tool === 'measure' || tool === 'line') {
        const c = this.snapToContour(w.x, w.y);
        if (c) return { ...w, x: c.x, y: c.y, snap: c.kind };
      }
      if ((this.props.snap || {}).grid) {
        const g = this.gridStep();
        const ox = this.bedX(w.bed || 0);
        return { ...w, x: Math.round((w.x - ox) / g) * g + ox, y: Math.round(w.y / g) * g, snap: 'grid' };
      }
      return w;
    }
    // Snap a moving box: other objects' edges/centres, bed or sheet centre, else the grid.
    snapDelta(b, dx, dy) {
      const sn = this.props.snap || {};
      const tol = 5 / this.state.view.s;
      let sx = dx, sy = dy, gx = null, gy = null;
      const xs = [], ys = [];
      if (sn.objects) {
        const selSet = new Set(this.props.sel || []);
        for (const e of this.entsWorld()) {
          if (selSet.has(e.id)) continue;
          const eb = CC.entityBox(e), ox = this.off(e);
          xs.push(eb.x0 + ox, eb.x1 + ox, (eb.x0 + eb.x1) / 2 + ox);
          ys.push(eb.y0, eb.y1, (eb.y0 + eb.y1) / 2);
        }
      }
      if (sn.centre) {
        const [bw, bh] = this.bed();
        const sh = this.props.job.sheet;
        const area = !this.isPlot() && sh && sh.on ? sh : { x: 0, y: 0, w: bw, h: bh };
        xs.push(area.x + area.w / 2); ys.push(area.y + area.h / 2);
      }
      const cand = (vals, edges, d) => {
        let best = null;
        for (const v of vals) for (const e of edges) {
          const want = v - e;
          if (Math.abs(want - d) <= tol && (best === null || Math.abs(want - d) < Math.abs(best.d - d))) best = { d: want, at: v };
        }
        return best;
      };
      const bx = cand(xs, [b.x0, b.x1, (b.x0 + b.x1) / 2], dx);
      const by = cand(ys, [b.y0, b.y1, (b.y0 + b.y1) / 2], dy);
      // grid: the selection's top-left corner lands on a grid line you can see.
      // When an object edge is also in range, whichever is closer wins.
      const g = this.gridStep();
      const gdx = Math.round((b.x0 + dx) / g) * g - b.x0, gdy = Math.round((b.y0 + dy) / g) * g - b.y0;
      const useObjX = bx && (!sn.grid || Math.abs(bx.d - dx) < Math.abs(gdx - dx));
      const useObjY = by && (!sn.grid || Math.abs(by.d - dy) < Math.abs(gdy - dy));
      if (useObjX) { sx = bx.d; gx = bx.at; } else if (sn.grid) sx = gdx;
      if (useObjY) { sy = by.d; gy = by.at; } else if (sn.grid) sy = gdy;
      return { dx: sx, dy: sy, gx, gy };
    }
    cursorText(w) {
      const el = document.getElementById('lrc-cursor');
      if (!el) return;
      el.textContent = (this.isPlot() ? 'Bed ' + (w.bed + 1) + '  ' : '') + 'X ' + w.lx.toFixed(2) + '  Y ' + w.ly.toFixed(2) + ' mm';
    }
    handleAt(cx, cy) {
      const b = this.selBoxWorld();
      if (!b || this.props.tool !== 'select') return null;
      const v = this.state.view;
      const r = this.root.current.getBoundingClientRect();
      const px = cx - r.left, py = cy - r.top;
      const pad = 8 / v.s;
      const corners = { tl: [b.x0 - pad, b.y0 - pad], tr: [b.x1 + pad, b.y0 - pad], bl: [b.x0 - pad, b.y1 + pad], br: [b.x1 + pad, b.y1 + pad] };
      for (const [k, [x, y]] of Object.entries(corners)) {
        if (Math.abs(v.tx + x * v.s - px) <= 7 && Math.abs(v.ty + y * v.s - py) <= 7) return k;
      }
      return null;
    }
    onDown = (e) => {
      if (!this.state.view) return;
      const el = this.root.current;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* capture unsupported */ }
      const w = this.toWorld(e.clientX, e.clientY);
      const p = this.props;
      if (e.button === 2) {
        // right button: a click opens the menu, a drag pans
        this.drag = { kind: 'rclick', sx: e.clientX, sy: e.clientY, v: this.state.view, w };
        return;
      }
      if (e.button === 1 || this.space || p.tool === 'pan') {
        this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, v: this.state.view };
        return;
      }
      if (this.state.measure) this.setState({ measure: null });
      if (e.button !== 0) return;
      const tool = p.tool || 'select';
      if (tool === 'select') {
        const hk = this.handleAt(e.clientX, e.clientY);
        if (hk) {
          const b = this.selBoxWorld();
          const anchor = { tl: [b.x1, b.y1], tr: [b.x0, b.y1], bl: [b.x1, b.y0], br: [b.x0, b.y0] }[hk];
          this.drag = { kind: 'scale', anchor, b, w0: w, k: 1 };
          return;
        }
        const ent = this.hit(w.x, w.y);
        if (ent) {
          let sel = p.sel || [];
          const ids = ops.expand(p.job, [ent.id]);
          if (e.shiftKey) sel = sel.includes(ent.id) ? sel.filter((id) => !ids.includes(id)) : sel.concat(ids);
          else if (!sel.includes(ent.id)) sel = ids;
          p.onSelect(sel);
          if (!e.shiftKey) this.drag = { kind: 'move', w0: w, sel, b: null, dup: e.altKey };
          return;
        }
        // drag the sheet by its border (laser)
        const sh = p.job.sheet;
        if (!this.isPlot() && sh && sh.on) {
          const tol = 6 / this.state.view.s;
          const inX = w.x > sh.x - tol && w.x < sh.x + sh.w + tol, inY = w.y > sh.y - tol && w.y < sh.y + sh.h + tol;
          const nearEdge = inX && inY && (Math.abs(w.x - sh.x) < tol || Math.abs(w.x - sh.x - sh.w) < tol || Math.abs(w.y - sh.y) < tol || Math.abs(w.y - sh.y - sh.h) < tol);
          if (nearEdge) { this.drag = { kind: 'sheet', w0: w, s0: { ...sh } }; return; }
        }
        if (!e.shiftKey && (p.sel || []).length) p.onSelect([]);
        this.drag = { kind: 'band', w0: w, add: e.shiftKey ? (p.sel || []) : [] };
        return;
      }
      this.drag = { kind: 'draw', tool, w0: this.snapPoint(w, tool) };
    };
    onMove = (e) => {
      if (!this.state.view) return;
      const w = this.toWorld(e.clientX, e.clientY);
      this.cursorText(w);
      const d = this.drag;
      if (!d) {
        const hk = this.handleAt(e.clientX, e.clientY);
        const c = hk ? (hk === 'tl' || hk === 'br' ? 'nwse-resize' : 'nesw-resize') : (this.space ? 'grab' : (this.props.tool && this.props.tool !== 'select' ? 'crosshair' : 'default'));
        if (this.root.current.style.cursor !== c) this.root.current.style.cursor = c;
        // show where a measuring/drawing click would snap to
        const tool = this.props.tool;
        if (tool === 'measure' || tool === 'line') {
          const sp = this.snapPoint(w, tool);
          const hover = sp.snap && sp.snap !== 'grid' ? { x: sp.x, y: sp.y, kind: sp.snap } : null;
          const cur = this.state.hover;
          if ((hover && (!cur || cur.x !== hover.x || cur.y !== hover.y)) || (!hover && cur)) this.setState({ hover });
        } else if (this.state.hover) this.setState({ hover: null });
        return;
      }
      if (d.kind === 'rclick') {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) this.drag = { kind: 'pan', sx: d.sx, sy: d.sy, v: d.v };
        return;
      }
      if (d.kind === 'pan') {
        this.setState({ view: { ...d.v, tx: d.v.tx + e.clientX - d.sx, ty: d.v.ty + e.clientY - d.sy } });
        return;
      }
      if (d.kind === 'move') {
        if (!d.b) d.b = this.selBoxWorld();
        if (!d.b) return;
        let dx = w.x - d.w0.x, dy = w.y - d.w0.y;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        const s = this.snapDelta(d.b, dx, dy);
        d.dx = s.dx; d.dy = s.dy;
        this.setState({ drag: { kind: 'move', dx: s.dx, dy: s.dy, gx: s.gx, gy: s.gy } });
        return;
      }
      if (d.kind === 'scale') {
        const [ax, ay] = d.anchor;
        const w0 = d.b.x1 - d.b.x0 || 1, h0 = d.b.y1 - d.b.y0 || 1;
        const kx = Math.abs(w.x - ax) / w0, ky = Math.abs(w.y - ay) / h0;
        const k = Math.max(0.01, e.shiftKey ? kx : Math.max(kx, ky));
        d.kx = e.shiftKey ? kx : k; d.ky = e.shiftKey ? ky : k;
        this.setState({ drag: { kind: 'scale', ax, ay, kx: d.kx, ky: d.ky } });
        return;
      }
      if (d.kind === 'sheet') {
        const [bw, bh] = this.bed();
        const x = Math.round(Math.max(0, Math.min(bw - d.s0.w, d.s0.x + w.x - d.w0.x)));
        const y = Math.round(Math.max(0, Math.min(bh - d.s0.h, d.s0.y + w.y - d.w0.y)));
        d.to = { x, y };
        this.setState({ drag: { kind: 'sheet', x, y } });
        return;
      }
      if (d.kind === 'band' || d.kind === 'draw') {
        const sp = d.kind === 'draw' ? this.snapPoint(w, d.tool) : w;
        d.w1 = sp;
        const hover = sp.snap && sp.snap !== 'grid' ? { x: sp.x, y: sp.y, kind: sp.snap } : null;
        this.setState({ hover, drag: { kind: d.kind, tool: d.tool, x0: d.w0.x, y0: d.w0.y, x1: sp.x, y1: sp.y, shift: e.shiftKey } });
      }
    };
    onUp = (e) => {
      const d = this.drag;
      this.drag = null;
      try { this.root.current.releasePointerCapture(e.pointerId); } catch (err) { /* not captured */ }
      const p = this.props;
      if (!d) return;
      this.setState({ drag: null });
      if (d.kind === 'rclick') {
        // select what was clicked (unless it is already part of the selection), then open the menu
        const ent = this.hit(d.w.x, d.w.y);
        let sel = p.sel || [];
        if (ent && !sel.includes(ent.id)) { sel = ops.expand(p.job, [ent.id]); p.onSelect(sel); }
        if (p.onContext) p.onContext(e.clientX, e.clientY, sel, d.w);
        return;
      }
      if (d.kind === 'move' && d.dx !== undefined && (Math.abs(d.dx) > 1e-6 || Math.abs(d.dy) > 1e-6)) {
        let job = p.job, sel = d.sel;
        if (d.dup) { const r = ops.duplicate(job, sel, 0, 0); job = r.job; sel = r.sel; }
        job = ops.translate(job, sel, d.dx, d.dy);
        if (this.isPlot()) {
          // dropped onto another bed?
          const b = this.selBoxWorld();
          const step = this.bed()[0] + this.gap();
          const cx = (b.x0 + b.x1) / 2 + d.dx;
          const bed = Math.max(0, Math.min(this.nBeds() - 1, Math.floor((cx + this.gap() / 2) / step)));
          const ents = ops.selected(job, sel);
          if (ents.length && ents.some((x) => (x.bed || 0) !== bed)) {
            const set = new Set(sel);
            job = { ...job, entities: job.entities.map((x) => (set.has(x.id) ? { ...CC.translate(x, this.bedX(x.bed || 0) - this.bedX(bed), 0), bed } : x)) };
          }
        }
        p.onCommit(job, { record: true }, sel);
      } else if (d.kind === 'scale' && d.kx) {
        const ax = d.anchor[0], ay = d.anchor[1];
        const sel = ops.selected(p.job, p.sel).filter((x) => !x.locked);
        const set = new Set(sel.map((x) => x.id));
        const job = { ...p.job, entities: p.job.entities.map((x) => (set.has(x.id) ? CC.scaleAbout(x, d.kx, d.ky, ax - this.off(x), ay) : x)) };
        p.onCommit(job, { record: true });
      } else if (d.kind === 'sheet' && d.to) {
        p.onCommit({ ...p.job, sheet: { ...p.job.sheet, ...d.to } }, { record: true });
      } else if (d.kind === 'band' && d.w1) {
        const x0 = Math.min(d.w0.x, d.w1.x), x1 = Math.max(d.w0.x, d.w1.x), y0 = Math.min(d.w0.y, d.w1.y), y1 = Math.max(d.w0.y, d.w1.y);
        const ids = this.pickable().filter((x) => {
          const b = CC.entityBox(x), ox = this.off(x);
          return b.x0 + ox >= x0 && b.x1 + ox <= x1 && b.y0 >= y0 && b.y1 <= y1;
        }).map((x) => x.id);
        p.onSelect(ops.expand(p.job, [...new Set(d.add.concat(ids))]));
      } else if (d.kind === 'draw') {
        this.finishDraw(d, e);
      }
    };
    finishDraw(d) {
      const p = this.props;
      const a = d.w0, b = d.w1 || d.w0;
      const bed = this.isPlot() ? a.bed : 0;
      const ox = this.bedX(bed);
      const x0 = Math.min(a.x, b.x) - ox, y0 = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), hh = Math.abs(b.y - a.y);
      const aci = p.drawAci || 7;
      let ent = null;
      if (d.tool === 'measure') {
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1e-6) return;
        // keep the measurement on screen until the next click
        this.setState({ measure: { x0: a.x, y0: a.y, x1: b.x, y1: b.y } });
        toast('Distance ' + len.toFixed(2) + ' mm · ΔX ' + Math.abs(b.x - a.x).toFixed(2) + ' · ΔY ' + Math.abs(b.y - a.y).toFixed(2) + ' · ' + ((Math.atan2(a.y - b.y, b.x - a.x) * 180) / Math.PI).toFixed(1) + '°', { ms: 6000 });
        return;
      }
      if (d.tool === 'text') {
        if (p.onText) p.onText(a.lx, a.ly, bed);
        return;
      }
      if (w < 0.5 && hh < 0.5) return;
      if (d.tool === 'line') ent = { name: 'Line', type: 'Line', paths: [{ p: [[a.x - ox, a.y], [b.x - ox, b.y]], c: false }], size: [w, hh] };
      if (d.tool === 'rect') ent = { name: 'Rectangle', type: 'Rectangle', paths: [{ p: CC.shapes.rect(x0, y0, w, d.shift ? w : hh, 0), c: true }] };
      if (d.tool === 'ellipse') ent = { name: 'Ellipse', type: 'Ellipse', paths: [{ p: CC.shapes.ellipse(x0 + w / 2, y0 + (d.shift ? w : hh) / 2, w / 2, (d.shift ? w : hh) / 2), c: true }] };
      if (d.tool === 'polygon') ent = { name: 'Polygon', type: 'Polygon', paths: [{ p: CC.shapes.polygon(a.x - ox, a.y, Math.hypot(w, hh), p.polySides || 6), c: true }] };
      if (!ent) return;
      ent = { ...ent, id: CC.uid('e'), aci, bed };
      p.onCommit({ ...p.job, entities: p.job.entities.concat(ent) }, { record: true }, [ent.id]);
    }

    // selection/origin colour on the bed: a real colour (the page may pass a CSS var)
    accent() { const a = this.props.accent; return !a || /^var\(/.test(a) ? '#D62828' : a; }
    renderBed(k) {
      const [bw, bh] = this.bed();
      const x = this.bedX(k);
      const v = this.state.view;
      const kids = [];
      kids.push(h('rect', { key: 'b', x, y: 0, width: bw, height: bh, strokeWidth: 1, vectorEffect: 'non-scaling-stroke', style: { fill: 'var(--bed)', stroke: 'var(--bed-line)' } }));
      kids.push(h('rect', { key: 'g', x, y: 0, width: bw, height: bh, fill: 'url(#lrc-grid-minor)' }));
      kids.push(h('rect', { key: 'gm', x, y: 0, width: bw, height: bh, fill: 'url(#lrc-grid-major)' }));
      const sh = this.props.job.sheet;
      if (sh && sh.on) {
        const dsh = this.state.drag && this.state.drag.kind === 'sheet' ? this.state.drag : null;
        kids.push(h('rect', { key: 's', x: x + (dsh ? dsh.x : sh.x), y: dsh ? dsh.y : sh.y, width: sh.w, height: sh.h, strokeWidth: 1.2, vectorEffect: 'non-scaling-stroke', style: { fill: 'var(--sheet)', stroke: 'var(--sheet-line)', filter: 'drop-shadow(0 2px 4px rgba(21,24,30,0.10))' } }));
      }
      if (this.isPlot()) {
        const now = k === 0;
        // drawn on the viewport, outside the bed, so it follows the theme
        kids.push(h('text', { key: 'l', x, y: -8 / v.s, fontSize: 13 / v.s, fontWeight: 600, style: { fill: now ? 'var(--accent-fg)' : 'var(--text)' }, fontFamily: 'IBM Plex Sans, sans-serif' }, 'Bed ' + (k + 1) + (now ? ' · on the table now' : ' · after feed ' + k)));
      }
      kids.push(h('circle', { key: 'o', cx: x, cy: 0, r: 5 / v.s, stroke: this.accent(), strokeWidth: 2, vectorEffect: 'non-scaling-stroke', style: { fill: 'var(--bed)' } }));
      return h('g', { key: 'bed' + k }, kids);
    }
    // Screen-space rulers along the top and left, labelled in bed millimetres.
    renderRulers() {
      const v = this.state.view;
      const { w, h: H } = this.state;
      const R = 22;
      const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
      const major = steps.find((s) => s * v.s >= 64) || 5000;
      const minor = major / (String(major)[0] === '2' ? 4 : 5);
      const out = [];
      // rulers are app chrome: theme colours (as style, so var() resolves)
      const tick = (key, x1, y1, x2, y2) => out.push(h('line', { key, x1, y1, x2, y2, style: { stroke: 'var(--line-hover)' }, strokeWidth: 1 }));
      const label = (key, x, y, t, vert) => out.push(h('text', { key, x, y, fontSize: 10.5, style: { fill: 'var(--text-3)' }, fontFamily: 'IBM Plex Mono, monospace', transform: vert ? 'rotate(-90 ' + x + ' ' + y + ')' : undefined }, t));
      out.push(h('rect', { key: 'rt', x: 0, y: 0, width: w, height: R, style: { fill: 'var(--surface)' } }));
      out.push(h('rect', { key: 'rl', x: 0, y: 0, width: R, height: H, style: { fill: 'var(--surface)' } }));
      out.push(h('line', { key: 'rtb', x1: 0, y1: R - 0.5, x2: w, y2: R - 0.5, style: { stroke: 'var(--line)' } }));
      out.push(h('line', { key: 'rlb', x1: R - 0.5, y1: 0, x2: R - 0.5, y2: H, style: { stroke: 'var(--line)' } }));
      const bw = this.bed()[0], step = bw + this.gap();
      const xw0 = (R - v.tx) / v.s, xw1 = (w - v.tx) / v.s;
      for (let x = Math.floor(xw0 / minor) * minor; x <= xw1; x += minor) {
        const k = this.isPlot() ? Math.floor(x / step) : 0;
        const local = x - k * step;
        if (this.isPlot() && (local < -1e-6 || local > bw + 1e-6)) continue;
        const sx = v.tx + x * v.s;
        const isMajor = Math.abs(local / major - Math.round(local / major)) < 1e-6;
        tick('tx' + x, sx, isMajor ? 8 : 15, sx, R);
        if (isMajor) label('lx' + x, sx + 3, 10, String(Math.round(local)));
      }
      const yw0 = (R - v.ty) / v.s, yw1 = (H - v.ty) / v.s;
      for (let y = Math.floor(yw0 / minor) * minor; y <= yw1; y += minor) {
        const sy = v.ty + y * v.s;
        const isMajor = Math.abs(y / major - Math.round(y / major)) < 1e-6;
        tick('ty' + y, isMajor ? 8 : 15, sy, R, sy);
        if (isMajor) label('ly' + y, 11, sy - 3, String(Math.round(y)), true);
      }
      out.push(h('rect', { key: 'rc', x: 0, y: 0, width: R, height: R, style: { fill: 'var(--surface)' } }));
      return h('g', { key: 'rulers', pointerEvents: 'none' }, out);
    }
    render() {
      const p = this.props;
      const v = this.state.view;
      const kids = [];
      if (v) {
        const n = this.nBeds();
        for (let k = 0; k < n; k++) kids.push(this.renderBed(k));
        const selSet = new Set(p.sel || []);
        const procByAci = new Map();
        p.job.processes.forEach((pr) => (pr.aci || []).forEach((a) => { if (!procByAci.has(a)) procByAci.set(a, pr); }));
        const regAci = CC.regMarkAci(p.job);
        const drag = this.state.drag;
        const moving = drag && drag.kind === 'move';
        const scaling = drag && drag.kind === 'scale';
        const normal = [], selected = [];
        for (const e of p.job.entities) {
          if (e.hidden) continue;
          const pr = procByAci.get(e.aci);
          const col = aci.stroke(e.aci);
          const isEng = pr && pr.proc === 'Engrave';
          const isReg = regAci.has(e.aci);
          const dash = pr && pr.dash && !isReg ? (pr.dl * v.s).toFixed(1) + ' ' + (pr.gl * v.s).toFixed(1) : null;
          const el = h('path', {
            key: e.id, d: entityD(e), transform: this.isPlot() && e.bed ? 'translate(' + this.bedX(e.bed) + ' 0)' : undefined,
            fillOpacity: isReg ? 1 : isEng ? 0.22 : undefined, fillRule: 'evenodd',
            strokeWidth: selSet.has(e.id) ? 2 : 1.3, strokeDasharray: dash || undefined,
            vectorEffect: 'non-scaling-stroke', opacity: pr && pr.hidden ? 0.2 : !pr || pr.out === false ? 0.35 : e.locked ? 0.7 : 1,
            // colours as CSS so ACI 7 and reg marks follow the theme; reg marks are drawn solid, the way the camera sees them
            style: { fill: isReg ? 'var(--ink)' : isEng ? col : 'none', stroke: col }
          });
          (selSet.has(e.id) ? selected : normal).push(el);
        }
        kids.push(h('g', { key: 'ents' }, normal));
        let selXf;
        if (moving) selXf = 'translate(' + drag.dx + ' ' + drag.dy + ')';
        if (scaling) selXf = 'translate(' + drag.ax + ' ' + drag.ay + ') scale(' + drag.kx + ' ' + drag.ky + ') translate(' + -drag.ax + ' ' + -drag.ay + ')';
        kids.push(h('g', { key: 'sel', transform: selXf }, selected));
        // last measurement, and the point a measure/line click would snap to
        const ms = this.state.measure;
        if (ms && p.tool === 'measure') {
          const len = Math.hypot(ms.x1 - ms.x0, ms.y1 - ms.y0);
          kids.push(h('line', { key: 'ms', x1: ms.x0, y1: ms.y0, x2: ms.x1, y2: ms.y1, stroke: '#E5484D', strokeWidth: 1.5, strokeDasharray: '5 3', vectorEffect: 'non-scaling-stroke' }));
          [[ms.x0, ms.y0], [ms.x1, ms.y1]].forEach(([x, y], i) => kids.push(h('circle', { key: 'mse' + i, cx: x, cy: y, r: 3.5 / v.s, fill: '#FFFFFF', stroke: '#E5484D', strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke' })));
          kids.push(h('text', { key: 'msl', x: (ms.x0 + ms.x1) / 2 + 8 / v.s, y: (ms.y0 + ms.y1) / 2 - 8 / v.s, fontSize: 12 / v.s, fontWeight: 600, fill: '#B42318', fontFamily: 'IBM Plex Mono, monospace', stroke: '#FFFFFF', strokeWidth: 3 / v.s, paintOrder: 'stroke' }, len.toFixed(2) + ' mm'));
        }
        const hv = this.state.hover;
        if (hv && (p.tool === 'measure' || p.tool === 'line')) {
          const r = 5 / v.s;
          kids.push(hv.kind === 'vertex'
            ? h('rect', { key: 'hv', x: hv.x - r, y: hv.y - r, width: 2 * r, height: 2 * r, fill: 'none', stroke: '#E5484D', strokeWidth: 1.6, vectorEffect: 'non-scaling-stroke' })
            : h('circle', { key: 'hv', cx: hv.x, cy: hv.y, r, fill: 'none', stroke: '#E5484D', strokeWidth: 1.6, vectorEffect: 'non-scaling-stroke' }));
        }
        // selection frame + handles
        const b = this.selBoxWorld();
        if (b && !scaling) {
          const dx = moving ? drag.dx : 0, dy = moving ? drag.dy : 0;
          const pad = 8 / v.s;
          const x0 = b.x0 + dx - pad, y0 = b.y0 + dy - pad, x1 = b.x1 + dx + pad, y1 = b.y1 + dy + pad;
          kids.push(h('rect', { key: 'sb', x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: 'none', stroke: this.accent(), strokeWidth: 1.2, strokeDasharray: '4 3', vectorEffect: 'non-scaling-stroke' }));
          const hs = 4 / v.s;
          [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].forEach(([x, y], i) => kids.push(h('rect', { key: 'h' + i, x: x - hs, y: y - hs, width: 2 * hs, height: 2 * hs, fill: '#FFFFFF', stroke: this.accent(), strokeWidth: 1.4, vectorEffect: 'non-scaling-stroke' })));
          if (!moving) {
            const label = (b.x1 - b.x0).toFixed(1) + ' × ' + (b.y1 - b.y0).toFixed(1) + ' mm';
            kids.push(h('text', { key: 'sl', x: x0, y: y1 + 16 / v.s, fontSize: 11 / v.s, fill: this.accent(), fontFamily: 'IBM Plex Mono, monospace' }, label));
          }
        }
        if (moving && (drag.gx !== null || drag.gy !== null)) {
          const W = this.world();
          if (drag.gx !== null) kids.push(h('line', { key: 'gx', x1: drag.gx, y1: -20, x2: drag.gx, y2: W.h + 20, stroke: '#E5484D', strokeWidth: 1, strokeDasharray: '3 3', vectorEffect: 'non-scaling-stroke' }));
          if (drag.gy !== null) kids.push(h('line', { key: 'gy', x1: -20, y1: drag.gy, x2: W.w + 20, y2: drag.gy, stroke: '#E5484D', strokeWidth: 1, strokeDasharray: '3 3', vectorEffect: 'non-scaling-stroke' }));
        }
        if (drag && (drag.kind === 'band' || drag.kind === 'draw')) {
          const x0 = Math.min(drag.x0, drag.x1), y0 = Math.min(drag.y0, drag.y1), w = Math.abs(drag.x1 - drag.x0), hh = Math.abs(drag.y1 - drag.y0);
          const st = { fill: 'none', strokeWidth: 1.3, vectorEffect: 'non-scaling-stroke', style: { stroke: drag.kind === 'band' ? this.accent() : aci.stroke(p.drawAci || 7) } };
          if (drag.kind === 'band') kids.push(h('rect', { key: 'band', x: x0, y: y0, width: w, height: hh, ...st, fill: 'rgba(214,40,40,0.06)', strokeDasharray: '4 3' }));
          else if (drag.tool === 'line' || drag.tool === 'measure') kids.push(h('line', { key: 'pv', x1: drag.x0, y1: drag.y0, x2: drag.x1, y2: drag.y1, ...st, strokeDasharray: drag.tool === 'measure' ? '5 3' : undefined }));
          else if (drag.tool === 'rect') kids.push(h('rect', { key: 'pv', x: x0, y: y0, width: w, height: drag.shift ? w : hh, ...st }));
          else if (drag.tool === 'ellipse') kids.push(h('ellipse', { key: 'pv', cx: x0 + w / 2, cy: y0 + (drag.shift ? w : hh) / 2, rx: w / 2, ry: (drag.shift ? w : hh) / 2, ...st }));
          else if (drag.tool === 'polygon') kids.push(h('path', { key: 'pv', d: 'M' + CC.shapes.polygon(drag.x0, drag.y0, Math.hypot(w, hh), p.polySides || 6).map((q) => q.join(' ')).join('L') + 'Z', ...st }));
          if (drag.kind === 'draw') kids.push(h('text', { key: 'pvl', x: drag.x1 + 10 / v.s, y: drag.y1 - 8 / v.s, fontSize: 11 / v.s, fontFamily: 'IBM Plex Mono, monospace', style: { fill: 'var(--ink)' } }, drag.tool === 'measure' || drag.tool === 'line' ? Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0).toFixed(2) + ' mm' : w.toFixed(1) + ' × ' + hh.toFixed(1)));
        }
      }
      // minor grid = the snapping step; major lines every 5 or 10 steps
      const g = this.gridStep();
      const G = g * (String(g)[0] === '2' ? 5 : 10);
      const defs = h('defs', { key: 'defs' },
        h('pattern', { id: 'lrc-grid-minor', width: g, height: g, patternUnits: 'userSpaceOnUse' }, h('path', { d: 'M' + g + ' 0H0V' + g, fill: 'none', strokeWidth: 1, vectorEffect: 'non-scaling-stroke', style: { stroke: 'var(--bed-grid)' } })),
        h('pattern', { id: 'lrc-grid-major', width: G, height: G, patternUnits: 'userSpaceOnUse' }, h('path', { d: 'M' + G + ' 0H0V' + G, fill: 'none', strokeWidth: 1, vectorEffect: 'non-scaling-stroke', style: { stroke: 'var(--bed-grid-major)' } })));
      return h('div', {
        ref: this.root,
        onPointerDown: this.onDown, onPointerMove: this.onMove, onPointerUp: this.onUp, onPointerCancel: this.onUp,
        onContextMenu: (e) => e.preventDefault(),
        onPointerLeave: () => { if (this.state.hover) this.setState({ hover: null }); },
        onDoubleClick: () => { if (this.props.onDouble) this.props.onDouble(); },
        style: { position: 'absolute', inset: 0, overflow: 'hidden', touchAction: 'none', userSelect: 'none' },
        'aria-label': 'Job canvas', role: 'application'
      }, h('svg', { width: '100%', height: '100%', style: { display: 'block' } }, defs, v ? h('g', { transform: 'translate(' + v.tx + ' ' + v.ty + ') scale(' + v.s + ')' }, kids) : null, v ? this.renderRulers() : null));
    }
  }

  // ------------------------------------------------------------ support: bug reports, crashes, updates
  // Reports are folders in the reports folder beside the data folder; nothing is sent.
  const support = {
    async reportBug() {
      const r = await dialog({
        title: 'Report a bug',
        message: 'Saves a report on this computer, in Pathline\'s reports folder, with the app version, a screenshot and, if you like, the current job. Attach the folder when you ask for help.',
        fields: [
          { key: 'title', label: 'What went wrong (one line)', value: '', full: true },
          { key: 'description', label: 'What happened, and what you expected', type: 'textarea', value: '', full: true, rows: 4 },
          { key: 'steps', label: 'Steps to make it happen again', type: 'textarea', value: '', full: true, rows: 3, placeholder: '1. Import …\n2. Click …' },
          { key: 'includeJob', label: 'Include the current job', type: 'check', value: true },
          { key: 'screenshot', label: 'Include a screenshot of the window', type: 'check', value: true }
        ],
        buttons: [{ label: 'Cancel', value: null }, { label: 'Save report', value: 'ok', primary: true }]
      });
      if (!r) return;
      if (!r.values.title && !r.values.description) return toast('Describe the problem first');
      // let the dialog close so it isn't in the screenshot
      await new Promise((res) => setTimeout(res, 250));
      const folder = await window.api.report.bug({ ...r.values, page: location.pathname.split('/').pop() });
      toast('Bug report saved', { kind: 'ok', action: 'Show', onAction: () => window.api.report.openFolder(folder), ms: 8000 });
    },
    openReports: () => window.api.report.openFolder(),
    // manual: Help → Check for updates (says what it found); otherwise quiet
    async checkUpdates(manual) {
      const s = await window.api.update.check();
      if (s.state === 'ready') return updateReady(s);
      if (!manual) return;
      const msg = {
        current: 'Pathline ' + s.version + ' is up to date.',
        downloading: 'Version ' + s.version + ' is available and is downloading now. You can carry on working; you\'ll be asked to restart when it\'s ready.',
        none: 'No Pathline releases have been published yet. You have version ' + s.version + '.',
        off: 'Update checks aren\'t set up in this copy of Pathline (version ' + s.version + ').',
        portable: 'This is the portable copy (version ' + s.version + '). It can\'t update itself: download the latest version from the releases page.',
        error: 'Couldn\'t check for updates: ' + (s.message || 'no connection') + '.'
      }[s.state];
      dialog({ title: 'Check for updates', message: msg, buttons: [{ label: 'Close', value: 'ok', primary: true }] });
    }
  };
  function updateReady(s) {
    toast('Pathline ' + s.version + ' is ready to install', { action: 'Restart now', onAction: () => window.api.update.install(), ms: 20000 });
  }
  if (window.api && window.api.report) {
    // uncaught page errors go to the reports folder's errors.log
    window.addEventListener('error', (e) => { window.api.report.error({ page: location.pathname.split('/').pop(), message: e.message, stack: e.error && e.error.stack }).catch(() => {}); });
    window.addEventListener('unhandledrejection', (e) => { const r = e.reason; window.api.report.error({ page: location.pathname.split('/').pop(), message: String(r && r.message || r), stack: r && r.stack }).catch(() => {}); });
    window.api.report.crashed((d) => toast('Something went wrong inside Pathline. A crash report was saved.', { kind: 'err', action: 'Show', onAction: () => window.api.report.openFolder(d && d.folder), ms: 12000 }));
    // a crash in the last session (or an unexpected close) is mentioned once
    window.api.report.pending().then((folder) => {
      if (folder) setTimeout(() => toast('Pathline didn\'t close normally last time. A crash report was saved.', { action: 'Show', onAction: () => window.api.report.openFolder(folder), ms: 12000 }), 1200);
    }).catch(() => {});
    window.api.update.onState((s) => { if (s.state === 'ready') updateReady(s); else if (s.state === 'downloading') toast('Downloading Pathline ' + s.version + ' in the background', { ms: 5000 }); });
    // an update that finished downloading earlier in this session is offered again on each page
    window.api.update.status().then((s) => { if (s.state === 'ready') updateReady(s); }).catch(() => {});
  }

  window.LRC = { toast, fail, dialog, sendDialog, confirm, keys, guardNav, clip, ops, textEntity, JobCanvas, entityD, PX_PER_MM, contextMenu, closeMenu, theme, aci, support };
})();
