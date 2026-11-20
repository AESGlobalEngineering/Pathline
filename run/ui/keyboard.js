// Touch screen helpers for Pathline Run full screen with no keyboard of its own (the Raspberry Pi
// kiosk: electron/main.js opens the page with these switches):
//   ?osk=1     an on-screen keyboard. It comes up from the bottom when a field you type in is
//              tapped, types into it the way a real keyboard does (the screen sees the same
//              typing, Enter and Escape), and goes when the field is left or Hide is tapped.
//              Number fields get a number pad. A real keyboard's first key puts it away until the
//              screen is touched again.
//   ?kiosk=1   the mouse pointer hides while fingers are used, and shows when a mouse moves
//   ?cursor=0  no mouse pointer at all (touch screens that pretend to be a mouse)
// Opened any other way (a browser, a tablet, Windows) none of this is on.
(function () {
  'use strict';
  const q = new URLSearchParams(location.search);
  const root = document.documentElement;

  // ------------------------------------------------------------ mouse pointer
  if (q.get('cursor') === '0') root.classList.add('no-cursor');
  else if (q.get('kiosk') === '1') {
    addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') root.classList.add('no-cursor'); }, true);
    addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') root.classList.remove('no-cursor'); }, true);
  }

  if (q.get('osk') !== '1') return;

  // ------------------------------------------------------------ on-screen keyboard
  const TYPED = /^(text|search|url|email|tel|number|password|)$/;
  const typeable = (el) => !!el && ((el.tagName === 'INPUT' && TYPED.test((el.getAttribute('type') || '').toLowerCase())) || el.tagName === 'TEXTAREA') && !el.disabled && !el.readOnly;
  // the number pad: number fields (Setup's are data-num) and Setup → Network's addresses (digits and dots)
  const numeric = (el) => /^(decimal|numeric)$/.test(el.getAttribute('inputmode') || '') || (el.getAttribute('type') || '') === 'number' ||
    !!el.dataset.num || /^(ip|mask|gateway)$/.test(el.dataset.n || '');

  // keys: a character, or [label, action, width]
  const BS = ['⌫', 'back', 1.4], ENTER = ['Enter', 'enter', 1.8], HIDE = ['Hide', 'hide', 1.4];
  const LAYOUTS = {
    num: [
      ['7', '8', '9', BS],
      ['4', '5', '6', '-'],
      ['1', '2', '3', ['Clear', 'clear', 1]],
      [HIDE, '0', '.', ENTER]
    ],
    abc: [
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', BS],
      ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '-'],
      ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ENTER],
      [['⇧', 'shift', 1.4], 'z', 'x', 'c', 'v', 'b', 'n', 'm', '.', ':', '/'],
      [HIDE, ['#+=', 'sym', 1.4], [' ', 'space', 5], '@', '_', ['Clear', 'clear', 1.4]]
    ],
    sym: [
      ['!', '?', '#', '$', '%', '&', '*', '(', ')', '=', BS],
      ['+', '"', '\'', ';', ',', '<', '>', '[', ']', '{', '}'],
      ['~', '`', '^', '|', '\\', '€', '£', '°', '±', ENTER],
      [['abc', 'abc', 1.4], '×', '÷', '²', '³', 'µ', '§', '…', '.', ':', '/'],
      [HIDE, ['abc', 'abc', 1.4], [' ', 'space', 5], '@', '_', ['Clear', 'clear', 1.4]]
    ]
  };

  let target = null;  // the field being typed in
  let layout = 'abc';
  let shift = false;  // capitals for the next letter (twice: until tapped again)
  let caps = false;
  let hardware = false; // a real keyboard was used: stay away until the screen is touched
  let watch = 0;

  const kb = document.createElement('div');
  kb.className = 'hmi osk';
  kb.setAttribute('role', 'group');
  kb.setAttribute('aria-label', 'On-screen keyboard');
  kb.hidden = true;
  document.body.appendChild(kb);

  function draw() {
    const rows = LAYOUTS[layout];
    kb.dataset.layout = layout;
    kb.innerHTML = rows.map((row) => '<div class="osk-row">' + row.map((k) => {
      const [label, act, w] = Array.isArray(k) ? k : [k, 'char', 1];
      const ch = act === 'char' && (shift || caps) ? label.toUpperCase() : label;
      const on = act === 'shift' && (shift || caps);
      return '<button type="button" tabindex="-1" class="osk-k' + (act !== 'char' && act !== 'space' ? ' fn' : '') + (act === 'enter' ? ' go' : '') + (on ? ' on' : '') + '"' +
        ' data-k="' + esc(act === 'char' ? ch : '') + '" data-act="' + act + '" style="flex:' + w + ' 1 0"' +
        (act === 'space' ? ' aria-label="Space"' : act === 'back' ? ' aria-label="Backspace"' : act === 'shift' ? ' aria-label="Shift"' : '') + '>' +
        (act === 'shift' && caps ? '⇪' : esc(ch)) + '</button>';
    }).join('') + '</div>').join('');
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function show(el) {
    target = el;
    const want = numeric(el) ? 'num' : (layout === 'num' ? 'abc' : layout);
    if (want !== layout || kb.hidden) { layout = want; shift = false; caps = false; }
    const app = document.getElementById('app');
    kb.dataset.theme = (app && app.dataset.theme) || 'light';
    draw();
    kb.hidden = false;
    root.classList.add('osk-open');
    root.style.setProperty('--osk-h', kb.offsetHeight + 'px');
    // the field stays in sight above the keyboard
    requestAnimationFrame(() => { try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* gone */ } });
    clearInterval(watch);
    // the field went away under the keyboard (the screen changed): put it away
    watch = setInterval(() => { if (!target || !target.isConnected || document.activeElement !== target) hide(false); }, 400);
  }

  function hide(blur) {
    clearInterval(watch);
    const el = target;
    target = null;
    kb.hidden = true;
    root.classList.remove('osk-open');
    root.style.removeProperty('--osk-h');
    // leaving the field is what saves it (Setup reads a field when it's left)
    if (blur && el && document.activeElement === el) el.blur();
  }

  const insert = (s) => { if (!document.execCommand('insertText', false, s)) { target.setRangeText(s, target.selectionStart, target.selectionEnd, 'end'); target.dispatchEvent(new Event('input', { bubbles: true })); } };
  const key = (name) => {
    const o = { key: name, code: name, bubbles: true, cancelable: true };
    const go = target.dispatchEvent(new KeyboardEvent('keydown', o));
    target.dispatchEvent(new KeyboardEvent('keyup', o));
    return go;
  };

  function press(btn) {
    if (!target || !target.isConnected) { hide(false); return; }
    if (document.activeElement !== target) target.focus();
    const act = btn.dataset.act;
    if (act === 'char') {
      insert(btn.dataset.k);
      if (shift && !caps) { shift = false; draw(); }
    } else if (act === 'space') insert(' ');
    else if (act === 'back') {
      if (target.selectionStart === target.selectionEnd && target.selectionStart > 0) target.setSelectionRange(target.selectionStart - 1, target.selectionEnd);
      if (target.selectionStart !== target.selectionEnd) insert('');
    } else if (act === 'clear') { target.select(); insert(''); }
    else if (act === 'shift') {
      // once: the next letter; again: every letter (caps lock); again: off
      if (caps) { caps = false; shift = false; } else if (shift) caps = true; else shift = true;
      draw();
    } else if (act === 'sym' || act === 'abc') { layout = act; shift = false; caps = false; draw(); }
    else if (act === 'enter') {
      const el = target;
      key('Enter');
      // the screen didn't take Enter itself (it saves most fields): done typing here
      if (document.activeElement === el) hide(true);
    } else if (act === 'hide') hide(true);
  }

  // a key keeps the field focused (no focus change on press) and acts at once; ⌫ repeats while held
  let repeat = 0;
  kb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const btn = e.target.closest('.osk-k');
    if (!btn) return;
    btn.classList.add('down');
    press(btn);
    if (btn.dataset.act === 'back') {
      clearTimeout(repeat);
      const again = () => { press(btn); repeat = setTimeout(again, 70); };
      repeat = setTimeout(again, 450);
    }
  });
  const up = () => { clearTimeout(repeat); for (const b of kb.querySelectorAll('.down')) b.classList.remove('down'); };
  kb.addEventListener('pointerup', up);
  kb.addEventListener('pointercancel', up);
  kb.addEventListener('pointerleave', up);
  kb.addEventListener('mousedown', (e) => e.preventDefault());
  kb.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('focusin', (e) => { if (typeable(e.target) && !hardware) show(e.target); });
  document.addEventListener('focusout', () => setTimeout(() => { if (target && document.activeElement !== target) { if (typeable(document.activeElement) && !hardware) show(document.activeElement); else hide(false); } }, 0));
  // a real keyboard: put this one away until the screen is touched again
  document.addEventListener('keydown', (e) => { if (e.isTrusted && typeable(e.target)) { hardware = true; if (target) hide(false); } }, true);
  addEventListener('pointerdown', (e) => {
    if (kb.contains(e.target)) return;
    if (e.pointerType !== 'mouse') hardware = false;
    // tapping the field again brings the keyboard back after Hide
    const el = e.target.closest && e.target.closest('input, textarea');
    if (!hardware && typeable(el) && document.activeElement === el && !target) show(el);
  }, true);
  addEventListener('resize', () => { if (target) root.style.setProperty('--osk-h', kb.offsetHeight + 'px'); });
})();
