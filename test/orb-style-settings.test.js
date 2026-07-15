const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');

test('settings persist one validated orb style from the supported set', () => {
  assert.match(main, /const ORB_STYLES = new Set\(\['classic', 'aurora', 'pixel', 'flip'\]\);/);
  assert.match(main, /orbStyle:\s*normalizeOrbStyle\(config\.orbStyle\)/);
  assert.match(main, /config\.orbStyle = normalizeOrbStyle\(config\.orbStyle\);/);
  assert.match(main, /typeof patch\.orbStyle !== 'string' \|\| !ORB_STYLES\.has\(patch\.orbStyle\)/);
  assert.match(main, /config\.orbStyle = patch\.orbStyle;[\s\S]*?writeJson\(configPath\(\), config\)/);
});

test('settings center exposes four live-preview orb choices and saves the selected choice', () => {
  const values = [...html.matchAll(/name="orbStyle" value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(values, ['classic', 'aurora', 'pixel', 'flip']);
  assert.match(html, /id="settingsOrbTab"[\s\S]*?>悬浮球</);
  assert.match(html, /id="orbSettingsPanel"/);
  assert.match(renderer, /field\.addEventListener\('change',[\s\S]*?applyOrbStyle\(field\.value\)/);
  assert.match(renderer, /saveSettings\(\{ orbStyle \}\)/);
  assert.match(renderer, /function closePricingDialog\(\)[\s\S]*?applyOrbStyle\(state\.settings\.orbStyle\)/);
});

test('renderer contains distinct classic, aurora, pixel and flip visual treatments', () => {
  assert.match(styles, /\.ring\s*\{[\s\S]*?conic-gradient\(var\(--accent\)/);
  for (const style of ['aurora', 'pixel', 'flip']) {
    assert.match(styles, new RegExp(`\\.orb\\[data-orb-style="${style}"\\]`));
  }
  assert.match(styles, /@keyframes orb-flip-number/);
  assert.match(styles, /\.pixel-eyes/);
});

test('custom orb styles follow quota colors and provide light theme surfaces', () => {
  assert.match(styles, /\.orb\[data-orb-style="aurora"\] \.ring::before[\s\S]*?var\(--accent\) var\(--angle/);
  assert.match(styles, /\.orb\[data-orb-style="aurora"\] \.orb-core strong\s*\{[\s\S]*?color:\s*var\(--accent\)/);
  assert.match(styles, /\.orb\[data-orb-style="pixel"\] \.orb-core strong[\s\S]*?color:\s*var\(--accent\)/);
  assert.match(styles, /\.orb\[data-orb-style="flip"\] \.orb-core strong\s*\{[\s\S]*?color:\s*var\(--accent\)/);
  for (const style of ['aurora', 'pixel', 'flip']) {
    assert.match(styles, new RegExp(`:root\\[data-theme="light"\\] \\.orb\\[data-orb-style="${style}"\\]`));
  }
});
