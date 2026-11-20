// Saving a file so that pulling the power mid-save can't leave half of it (the Raspberry Pi
// has no off switch: it is switched off at the wall). The new contents go to a temporary file
// beside the real one, are flushed to the disk, then renamed over the real one in one step:
// whoever reads it next finds the old file or the new one, never a broken one.
'use strict';

const fs = require('fs');
const path = require('path');

function write(file, data) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows: something (a virus scanner, the search indexer) holding the file open refuses the
    // rename now and then: save it the plain way rather than not at all
    if (process.platform !== 'win32') throw e;
    fs.writeFileSync(file, data);
    try { fs.unlinkSync(tmp); } catch (e2) { /* left for next time */ }
    return;
  }
  // Linux: the rename itself is on the disk only once its folder is flushed too
  if (process.platform !== 'win32') {
    try { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch (e) { /* not every file system allows it */ }
  }
}

module.exports = { write };
