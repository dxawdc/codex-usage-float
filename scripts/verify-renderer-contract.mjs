import fs from 'node:fs/promises';

const [html, renderer, preload, main] = await Promise.all([
  fs.readFile('src/renderer/index.html', 'utf8'),
  fs.readFile('src/renderer/app.js', 'utf8'),
  fs.readFile('src/preload.js', 'utf8'),
  fs.readFile('src/main.js', 'utf8')
]);

const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index);
if (duplicateIds.length) throw new Error(`Duplicate HTML ids: ${[...new Set(duplicateIds)].join(', ')}`);

const referencedIds = [...renderer.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]);
const missingIds = [...new Set(referencedIds)].filter((id) => !htmlIds.includes(id));
if (missingIds.length) throw new Error(`Renderer references missing ids: ${missingIds.join(', ')}`);

const preloadChannels = [...preload.matchAll(/ipcRenderer\.invoke\(['"]([^'"]+)['"]/g)].map((match) => match[1]);
const registeredChannels = [...main.matchAll(/handleTrusted\(['"]([^'"]+)['"]/g)].map((match) => match[1]);
const missingChannels = [...new Set(preloadChannels)].filter((channel) => !registeredChannels.includes(channel));
if (missingChannels.length) throw new Error(`Preload invokes unregistered channels: ${missingChannels.join(', ')}`);

console.log(`Renderer contract OK: ${referencedIds.length} ids, ${preloadChannels.length} IPC channels`);
