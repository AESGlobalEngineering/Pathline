// Builds design-handoff\ (and Pathline-design-handoff.zip): every page of the
// app, runnable on its own in a browser or design tool with sample data from
// design\mock-api.js. The folder layout matches the app (src\ui, src\shared and
// the few node_modules files the pages load), so edited pages copy straight
// back into src\ui. Run: node tools/make-design-package.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'design-handoff');
const ZIP = path.join(ROOT, 'Pathline-design-handoff.zip');
const PAGES = ['MainDetailed', 'SimulationDetailed', 'MaterialsDetailed', 'MachineSetupDetailed'];
// the mock goes straight after core.js (it needs CC) and before the page runtime
const MOCK_TAG = '<script src="../../design/mock-api.js"></script><!-- design preview only: remove when copying back into the app -->';

const copy = (rel, to) => {
  const dst = path.join(OUT, to || rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(path.join(ROOT, rel), dst, { recursive: true });
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const p of PAGES) {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui', p + '.dc.html'), 'utf8');
  const tag = '<script src="../shared/core.js"></script>';
  if (!html.includes(tag)) throw new Error(p + ': core.js script tag not found');
  fs.mkdirSync(path.join(OUT, 'src/ui'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'src/ui', p + '.dc.html'), html.replace(tag, tag + '\n' + MOCK_TAG));
}
['src/ui/support.js', 'src/ui/app.js', 'src/ui/fonts.css', 'src/ui/theme.css', 'src/ui/brand', 'src/shared/core.js',
  'node_modules/clipper-lib/clipper.js', 'node_modules/opentype.js/dist/opentype.min.js', 'build/brand', 'build/icon.png'].forEach((f) => copy(f));
for (const [pkg, files] of [['ibm-plex-sans', ['latin-400-normal.woff2', 'latin-500-normal.woff2', 'latin-600-normal.woff2', 'latin-500-normal.woff']], ['ibm-plex-mono', ['latin-400-normal.woff2', 'latin-500-normal.woff2']]]) {
  for (const f of files) copy('node_modules/@fontsource/' + pkg + '/files/' + pkg + '-' + f);
}
copy('design/mock-api.js');
copy('design/index.html', 'START HERE.html');
copy('design/DESIGN-BRIEF.md', 'DESIGN-BRIEF.md');
copy('design/HARMONISE-SPEC.md', 'HARMONISE-SPEC.md');
if (fs.existsSync(path.join(ROOT, 'design/screenshots'))) copy('design/screenshots', 'screenshots');

fs.rmSync(ZIP, { force: true });
execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Compress-Archive -Path "' + OUT + '\\*" -DestinationPath "' + ZIP + '"'], { stdio: 'inherit' });
console.log('Wrote ' + path.relative(ROOT, OUT) + '\\ and ' + path.basename(ZIP));
