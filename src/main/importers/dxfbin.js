// Binary DXF → text DXF. AutoCAD can save a DXF as binary ("AutoCAD Binary
// DXF" at the start): the same group codes and values as a text DXF, but as
// bytes. dxf-parser only reads text, so a binary file is turned into the text
// form first and then imported as usual.
//
// Layout: the 22-byte sentinel "AutoCAD Binary DXF\r\n\x1a\0", then group code /
// value pairs to EOF. A group code is 2 bytes, little-endian (R13 and later),
// or 1 byte with 255 meaning "2 more bytes follow" (R12 and earlier). The
// value's type comes from the group code: strings end in a 0 byte, doubles
// are 8 bytes, 16/32/64-bit integers 2/4/8 bytes, booleans 1 byte, and binary
// chunks a length byte and then that many bytes.
'use strict';

const SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\0';

const isBinaryDxf = (buf) => buf.length >= SENTINEL.length && buf.toString('latin1', 0, SENTINEL.length) === SENTINEL;

// the value type of a group code (DXF reference, "Group Code Value Types")
function typeOf(c) {
  if (c >= 0 && c <= 9) return 'str';
  if (c >= 10 && c <= 59) return 'dbl';
  if (c >= 60 && c <= 79) return 'i16';
  if (c >= 90 && c <= 99) return 'i32';
  if (c >= 100 && c <= 109) return 'str';
  if (c >= 110 && c <= 149) return 'dbl';
  if (c >= 160 && c <= 169) return 'i64';
  if (c >= 170 && c <= 179) return 'i16';
  if (c >= 210 && c <= 239) return 'dbl';
  if (c >= 270 && c <= 289) return 'i16';
  if (c >= 290 && c <= 299) return 'bool';
  if (c >= 300 && c <= 309) return 'str';
  if (c >= 310 && c <= 319) return 'bin';
  if (c >= 320 && c <= 369) return 'str';
  if (c >= 370 && c <= 389) return 'i16';
  if (c >= 390 && c <= 399) return 'str';
  if (c >= 400 && c <= 409) return 'i16';
  if (c >= 410 && c <= 419) return 'str';
  if (c >= 420 && c <= 429) return 'i32';
  if (c >= 430 && c <= 439) return 'str';
  if (c >= 440 && c <= 459) return 'i32';
  if (c >= 460 && c <= 469) return 'dbl';
  if (c >= 470 && c <= 481) return 'str';
  if (c === 999) return 'str';
  if (c === 1004) return 'bin';
  if (c >= 1000 && c <= 1009) return 'str';
  if (c >= 1010 && c <= 1059) return 'dbl';
  if (c >= 1060 && c <= 1070) return 'i16';
  if (c === 1071) return 'i32';
  return null;
}

function binaryDxfToText(buf) {
  if (!isBinaryDxf(buf)) throw new Error('Not a binary DXF');
  let i = SENTINEL.length;
  // R13 and later: 2-byte codes (the first pair is 0 / "SECTION": 00 00 'S'…);
  // R12 and earlier: 1-byte codes (00 'S'…)
  const wide = buf[i] === 0 && buf[i + 1] === 0;
  // strings: ANSI before AutoCAD 2007 (AC1021), UTF-8 from it
  let enc = 'latin1';
  const out = [];
  const need = (n) => { if (i + n > buf.length) throw new Error('This binary DXF ends early (at byte ' + i + ')'); };
  while (i < buf.length) {
    let code;
    if (wide) { need(2); code = buf.readUInt16LE(i); i += 2; } else {
      need(1); code = buf[i++];
      if (code === 255) { need(2); code = buf.readUInt16LE(i); i += 2; }
    }
    const type = typeOf(code);
    let v;
    if (type === 'str') {
      const end = buf.indexOf(0, i);
      if (end < 0) throw new Error('This binary DXF ends early (at byte ' + i + ')');
      v = buf.toString(enc, i, end);
      i = end + 1;
    } else if (type === 'dbl') { need(8); v = String(buf.readDoubleLE(i)); i += 8; }
    else if (type === 'i16') { need(2); v = String(buf.readInt16LE(i)); i += 2; }
    else if (type === 'i32') { need(4); v = String(buf.readInt32LE(i)); i += 4; }
    else if (type === 'i64') { need(8); v = String(buf.readBigInt64LE(i)); i += 8; }
    else if (type === 'bool') { need(1); v = String(buf[i]); i += 1; }
    else if (type === 'bin') { need(1); const n = buf[i++]; need(n); v = buf.toString('hex', i, i + n).toUpperCase(); i += n; }
    else throw new Error('This binary DXF has group code ' + code + ', which Pathline Prepare can\'t read (at byte ' + (i - (wide ? 2 : 1)) + ')');
    // text values can't hold line breaks
    if (type === 'str') v = v.replace(/\r?\n/g, ' ');
    out.push(String(code), v);
    if (code === 1 && out[out.length - 4] === '9' && out[out.length - 3] === '$ACADVER' && v >= 'AC1021') enc = 'utf8';
    if (code === 0 && v === 'EOF') break;
  }
  return out.join('\n') + '\n';
}

module.exports = { isBinaryDxf, binaryDxfToText };
