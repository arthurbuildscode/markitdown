// Test de bout en bout : lance l'application, ouvre une image, applique des réglages,
// exporte dans tous les formats, puis essaie le recadrage et les deux fonctions IA.
//   npm test                       -> version de développement
//   ATELIER_EXE=chemin npm test    -> application empaquetée
import { _electron as electron, chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packaged = process.env.ATELIER_EXE;
const flags = process.platform === 'linux' ? ['--no-sandbox'] : [];

let page;
let close;
if (packaged) {
  // Application empaquetée : on s'y connecte par le port de débogage de Chromium.
  const port = 9300 + Math.floor(Math.random() * 500);
  const child = spawn(packaged, [...flags, `--remote-debugging-port=${port}`], { stdio: 'ignore' });
  let browser = null;
  for (let attempt = 0; attempt < 60 && !browser; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
  }
  if (!browser) {
    child.kill();
    throw new Error("L'application empaquetée n'a pas démarré");
  }
  page = browser.contexts()[0].pages()[0];
  close = async () => {
    await browser.close();
    child.kill();
  };
} else {
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [root, ...flags], cwd: root });
  page = await app.firstWindow();
  close = () => app.close();
}
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
await page.waitForFunction(() => window.__atelier);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok ' : 'ÉCHEC'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// 1. Ouverture d'une photo de synthèse (PNG 640 x 480 fabriqué dans la page).
await page.evaluate(async () => {
  window.confirm = () => true;
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  const sky = ctx.createLinearGradient(0, 0, 0, 480);
  sky.addColorStop(0, '#5b8fd0');
  sky.addColorStop(1, '#e8d6a0');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 640, 480);
  ctx.fillStyle = '#5d6b2c';
  ctx.beginPath();
  ctx.ellipse(320, 420, 380, 120, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#c0452c';
  ctx.fillRect(260, 250, 120, 110);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  await window.__atelier.openBytes(new Uint8Array(await blob.arrayBuffer()), 'essai.png', null);
});
const size = () => page.evaluate(() => [window.__atelier.state.base.width, window.__atelier.state.base.height].join('x'));
check('ouverture', (await size()) === '640x480', await size());
check('isolation multi-cœur', await page.evaluate(() => crossOriginIsolated));

// 2. Réglages puis export dans chaque format.
await page.evaluate(() =>
  window.__atelier.applyParams({ ...window.__atelier.DEFAULTS, contrast: 0.2, sharpen: 0.5, vibrance: 0.3, vignette: 0.3 }, 'test'),
);
const signatures = {
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47],
  webp: [0x52, 0x49, 0x46, 0x46],
  pdf: [0x25, 0x50, 0x44, 0x46],
  tiff: [0x4d, 0x4d, 0x00, 0x2a],
  bmp: [0x42, 0x4d],
  gif: [0x47, 0x49, 0x46, 0x38],
  avif: null,
};
for (const [format, signature] of Object.entries(signatures)) {
  const result = await page.evaluate(async (format) => {
    try {
      const bytes = await window.__atelier.produceFile({ format, pdfLayout: 'a4' });
      return { length: bytes.length, head: Array.from(bytes.subarray(0, 12)) };
    } catch (error) {
      return { error: String(error) };
    }
  }, format);
  const ok = !result.error && result.length > 500 &&
    (signature ? signature.every((byte, i) => result.head[i] === byte) : String.fromCharCode(...result.head.slice(4, 12)) === 'ftypavif');
  check(`export ${format}`, ok, result.error || `${result.length} octets`);
}

// 3. Rotation et recadrage.
await page.evaluate(() => window.__atelier.transformBase('right'));
check('rotation', (await size()) === '480x640', await size());
await page.evaluate(() => {
  window.__atelier.selectTab('cadre');
  window.__atelier.state.crop.rect = { cx: 0, cy: 0, w: 300, h: 200 };
  window.__atelier.bakeCrop();
});
check('recadrage', (await size()) === '300x200', await size());

// 4. Intelligence artificielle locale.
await page.evaluate(() => window.__atelier.runUpscale(2));
check('agrandissement ×2', (await size()) === '600x400', await size());
await page.evaluate(() => window.__atelier.runColorize());
check('colorisation', (await size()) === '600x400' && (await page.evaluate(() => window.__atelier.state.history.at(-1).label)) === 'Colorisation');

check('aucune erreur dans la console', errors.length === 0, errors.join(' | '));
await page.evaluate(() => window.atelier.setDirty(false));
await close();
console.log(failures ? `\n${failures} vérification(s) en échec` : '\nTout fonctionne.');
process.exit(failures ? 1 : 0);
