// Génère build/icon.png et build/icon.ico à partir du logo SVG (nécessite Playwright).
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svg = await readFile(path.join(root, 'src/assets/logo.svg'), 'utf8');
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];

const browser = await chromium.launch();
const page = await browser.newPage();
const rendered = await page.evaluate(async ({ svg, sizes }) => {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const out = {};
  for (const size of sizes) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, size, size);
    out[size] = {
      png: canvas.toDataURL('image/png').split(',')[1],
      rgba: Array.from(ctx.getImageData(0, 0, size, size).data),
    };
  }
  return out;
}, { svg, sizes });
await browser.close();

await mkdir(path.join(root, 'build'), { recursive: true });
await writeFile(path.join(root, 'build/icon.png'), Buffer.from(rendered[512].png, 'base64'));

// Fichier .ico : petites tailles en bitmap 32 bits, 256 px en PNG.
const entries = [16, 24, 32, 48, 64, 128, 256].map((size) => {
  if (size === 256) return { size, data: Buffer.from(rendered[size].png, 'base64') };
  const rgba = rendered[size].rgba;
  const maskRow = Math.ceil(size / 32) * 4;
  const data = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  data.writeUInt32LE(40, 0);
  data.writeInt32LE(size, 4);
  data.writeInt32LE(size * 2, 8);
  data.writeUInt16LE(1, 12);
  data.writeUInt16LE(32, 14);
  data.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4;
      const dst = 40 + (y * size + x) * 4;
      data[dst] = rgba[src + 2];
      data[dst + 1] = rgba[src + 1];
      data[dst + 2] = rgba[src];
      data[dst + 3] = rgba[src + 3];
    }
  }
  return { size, data };
});
const header = Buffer.alloc(6 + entries.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach((entry, i) => {
  const at = 6 + i * 16;
  header[at] = entry.size === 256 ? 0 : entry.size;
  header[at + 1] = entry.size === 256 ? 0 : entry.size;
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(entry.data.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += entry.data.length;
});
await writeFile(path.join(root, 'build/icon.ico'), Buffer.concat([header, ...entries.map((e) => e.data)]));
console.log('icônes générées dans build/');
