const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const styles = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('pricing select declares readable native option colors in both themes', () => {
  assert.match(styles, /--select-popup-bg:\s*#202329;/);
  assert.match(styles, /--select-popup-ink:\s*#f7fbff;/);
  assert.match(styles, /:root\[data-theme="light"\][\s\S]*?--select-popup-bg:\s*#ffffff;/);
  assert.match(styles, /\.price-field select\s*\{\s*color-scheme:\s*dark;/);
  assert.match(styles, /:root\[data-theme="light"\] \.price-field select\s*\{\s*color-scheme:\s*light;/);
  assert.match(styles, /\.price-field select option\s*\{[\s\S]*?background-color:\s*var\(--select-popup-bg\);[\s\S]*?color:\s*var\(--select-popup-ink\);/);
  assert.match(styles, /\.price-field select option:checked\s*\{[\s\S]*?var\(--select-popup-selected-bg\)[\s\S]*?color:\s*var\(--select-popup-selected-ink\);/);
});

test('release version is 2.1.0', () => {
  assert.equal(manifest.version, '2.1.0');
});
