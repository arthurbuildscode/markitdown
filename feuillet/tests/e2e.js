'use strict';
/**
 * Test de bout en bout : lance l'application Electron et vérifie le parcours
 * essentiel (saisie, enregistrement, réouverture, import, export PDF, fermeture).
 *
 *   npm run test:e2e            (Linux sans écran : xvfb-run -a npm run test:e2e)
 *
 * Variables : FEUILLET_SAMPLES = dossier de fichiers à importer (facultatif),
 *             FEUILLET_SHOTS   = dossier où écrire des captures d'écran (facultatif).
 */
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');

const root = process.env.FEUILLET_APP || path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'feuillet-e2e-'));
const shots = process.env.FEUILLET_SHOTS || null;
const samples = process.env.FEUILLET_SAMPLES || null;

const log = (message) => console.log(`✓ ${message}`);

/** Image JPEG minimale (1 × 1 pixel). */
const JPEG_PIXEL =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';

async function shot(page, name) {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

async function documentText(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await zip.file('word/document.xml').async('string');
  return xml.replace(/<[^>]+>/g, '');
}

/** Clique sur une entrée du menu natif, repérée par son libellé (sans « & »). */
function clickMenu(app, menuLabel, itemLabel) {
  return app.evaluate(
    ({ Menu, BrowserWindow }, [menuLabel, itemLabel]) => {
      const clean = (label) => label.replace(/&/g, '');
      const menu = Menu.getApplicationMenu().items.find((item) => clean(item.label) === menuLabel);
      const item = menu.submenu.items.find((entry) => clean(entry.label) === itemLabel);
      item.click(undefined, BrowserWindow.getFocusedWindow(), undefined);
    },
    [menuLabel, itemLabel],
  );
}

async function waitForEditor(page) {
  await page.waitForSelector('.paged-editor__pages .layout-page', { timeout: 30000 });
  await page.waitForTimeout(1200);
}

async function pageText(page) {
  return page.evaluate(() => document.querySelector('.paged-editor__pages')?.textContent ?? '');
}

(async () => {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [root, '--no-sandbox', `--user-data-dir=${path.join(work, 'profile')}`],
    cwd: __dirname,
  });
  const errors = [];
  const watch = (page) => {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
  };

  try {
    const first = await app.firstWindow();
    watch(first);
    await waitForEditor(first);
    assert.match(await first.title(), /^Document1 – Feuillet$/);
    log('démarrage sur un document vierge');

    // Saisie → le document passe à l'état « modifié ».
    await first.locator('.paged-editor__pages .layout-page').first().click({ position: { x: 300, y: 300 } });
    await first.keyboard.type('Bonjour Feuillet, éàç œ €.');
    await first.waitForFunction(() => document.title.includes('*'));
    assert.ok((await pageText(first)).includes('Bonjour Feuillet'));
    await shot(first, '01-saisie');
    log('saisie de texte, état modifié signalé dans le titre');

    // Enregistrer (menu natif) → boîte « Enregistrer sous » simulée.
    const saved = path.join(work, 'essai.docx');
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, saved);
    await clickMenu(app, 'Fichier', 'Enregistrer');
    await first.waitForFunction(() => document.title.startsWith('essai.docx – '));
    assert.ok((await documentText(saved)).includes('Bonjour Feuillet, éàç œ €.'));
    log('enregistrement en .docx, titre mis à jour');

    // Modification puis Ctrl+S : réécrit le même fichier sans boîte de dialogue.
    await first.keyboard.type(' Suite.');
    await first.waitForFunction(() => document.title.includes('*'));
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => {
        throw new Error('La boîte « Enregistrer sous » ne doit pas apparaître.');
      };
    });
    await clickMenu(app, 'Fichier', 'Enregistrer');
    await first.waitForFunction(() => !document.title.includes('*'));
    assert.ok((await documentText(saved)).includes('Suite.'));
    log('enregistrement en place');

    // Le menu « Fichier » intégré à l'éditeur doit passer par l'enregistrement natif.
    await first.keyboard.type(' Menu.');
    await first.waitForFunction(() => document.title.includes('*'));
    await first.getByRole('menubar').getByText('Fichier', { exact: true }).click();
    await first.getByRole('button', { name: 'Enregistrer Ctrl+S' }).click();
    await first.waitForFunction(() => !document.title.includes('*'));
    assert.ok((await documentText(saved)).includes('Menu.'));
    log('menu Fichier de l’éditeur relié à l’enregistrement natif');

    // Export PDF.
    const pdf = path.join(work, 'essai.pdf');
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, pdf);
    await clickMenu(app, 'Fichier', 'Exporter en PDF…');
    await first.waitForFunction(() => !document.querySelector('.feuillet-busy'), null, { timeout: 30000 });
    for (let i = 0; i < 100 && !fs.existsSync(pdf); i++) await first.waitForTimeout(100);
    const pdfBytes = fs.readFileSync(pdf);
    assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdfBytes.length > 2000);
    if (shots) fs.copyFileSync(pdf, path.join(shots, 'essai.pdf'));
    log(`export PDF (${pdfBytes.length} octets)`);

    // Réouverture du fichier enregistré → nouvelle fenêtre (la première contient déjà un document).
    const [second] = await Promise.all([
      app.waitForEvent('window'),
      first.evaluate((file) => window.feuillet.newWindow(file), saved),
    ]);
    watch(second);
    await waitForEditor(second);
    assert.match(await second.title(), /^essai\.docx – Feuillet$/);
    assert.ok((await pageText(second)).includes('Bonjour Feuillet, éàç œ €. Suite. Menu.'));
    await shot(second, '02-reouverture');
    log('réouverture du .docx enregistré');
    await second.close();

    // Document avec image : deux enregistrements successifs ne doivent ni dupliquer l'image ni la renommer.
    const pagePath = path.join(work, 'image.html');
    fs.writeFileSync(pagePath, `<h1>Image</h1><p><img src="data:image/jpeg;base64,${JPEG_PIXEL}" width="40" height="40"></p>`);
    const [withImage] = await Promise.all([
      app.waitForEvent('window'),
      first.evaluate((file) => window.feuillet.newWindow(file), pagePath),
    ]);
    watch(withImage);
    await waitForEditor(withImage);
    await withImage.waitForSelector('.paged-editor__pages img');
    const imageDocx = path.join(work, 'image.docx');
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, imageDocx);
    const saveFromMenu = async (page) => {
      await page.getByRole('menubar').getByText('Fichier', { exact: true }).click();
      await page.getByRole('button', { name: 'Enregistrer Ctrl+S' }).click();
    };
    await saveFromMenu(withImage);
    await withImage.waitForFunction(() => document.title.startsWith('image.docx – '));
    await withImage.locator('.paged-editor__pages .layout-page').first().click({ position: { x: 300, y: 400 } });
    await withImage.keyboard.type('x');
    await withImage.waitForFunction(() => document.title.includes('*'));
    await saveFromMenu(withImage);
    await withImage.waitForFunction(() => !document.title.includes('*'));
    const media = Object.keys((await JSZip.loadAsync(fs.readFileSync(imageDocx))).files).filter((name) => /^word\/media\/./.test(name));
    assert.equal(media.length, 1, `images en double : ${media.join(', ')}`);
    assert.match(media[0], /\.jpe?g$/);
    log('document avec image : enregistrements répétés sans duplication');
    await withImage.close();

    // Import des autres formats.
    if (samples) {
      for (const name of fs.readdirSync(samples).sort()) {
        const file = path.join(samples, name);
        if (!fs.statSync(file).isFile()) continue;
        const [win] = await Promise.all([
          app.waitForEvent('window'),
          first.evaluate((target) => window.feuillet.newWindow(target), file),
        ]);
        watch(win);
        await waitForEditor(win);
        const text = (await pageText(win)).replace(/\s+/g, ' ').trim();
        assert.ok(text.length > 0, `${name} : document vide`);
        assert.ok(!(await win.title()).includes('*'), `${name} : marqué modifié dès l'ouverture`);
        await shot(win, `import-${name}`);
        log(`import ${name} → « ${text.slice(0, 60)}… »`);
        await win.close();
      }
    }

    // Fermeture d'un document modifié : confirmation, puis « Ne pas enregistrer ».
    await first.keyboard.type(' Encore.');
    await first.waitForFunction(() => document.title.includes('*'));
    let asked = 0;
    await app.evaluate(({ dialog }) => {
      globalThis.__asked = 0;
      dialog.showMessageBoxSync = () => {
        globalThis.__asked += 1;
        return globalThis.__asked === 1 ? 2 : 1; // « Annuler », puis « Ne pas enregistrer »
      };
    });
    await clickMenu(app, 'Fichier', 'Fermer');
    await first.waitForTimeout(500);
    asked = await app.evaluate(() => globalThis.__asked);
    assert.equal(asked, 1);
    assert.equal(app.windows().length, 1, 'la fenêtre doit rester ouverte après « Annuler »');
    const closed = app.waitForEvent('close').catch(() => {});
    await clickMenu(app, 'Fichier', 'Fermer');
    await closed;
    log('confirmation avant fermeture d’un document modifié');

    const serious = errors.filter((text) => !/Content Security Policy|fonts\.googleapis|ERR_BLOCKED|Failed to load resource/i.test(text));
    assert.deepEqual(serious, [], 'erreurs dans la console');
    console.log('\nTous les contrôles sont passés.');
  } catch (error) {
    console.error('\n✗ Échec :', error);
    if (errors.length) console.error('Console :', errors.slice(0, 10));
    process.exitCode = 1;
    app.process().kill('SIGKILL');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    setTimeout(() => process.exit(), 2000).unref();
  }
})();
