'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { OPEN_FILTERS, extensionOf, isSupported, importFile } = require('./converters');
const { tidyDocxMedia } = require('./docxMedia');

const APP_NAME = 'Feuillet';
/** `electron . --dev` : l'interface est servie par Vite (npm run dev) au lieu du dossier dist. */
const DEV_URL = process.argv.includes('--dev') ? 'http://localhost:5173' : null;
const MAX_RECENTS = 10;

/** État par fenêtre : { initialFile, dirty, closing }. */
const windowState = new Map();
let recents = [];

// ───────────────────────── Fichiers récents ─────────────────────────

const recentsPath = () => path.join(app.getPath('userData'), 'recents.json');

function loadRecents() {
  try {
    const list = JSON.parse(fs.readFileSync(recentsPath(), 'utf8'));
    recents = Array.isArray(list) ? list.filter((p) => typeof p === 'string').slice(0, MAX_RECENTS) : [];
  } catch {
    recents = [];
  }
}

function addRecent(filePath) {
  recents = [filePath, ...recents.filter((p) => p !== filePath)].slice(0, MAX_RECENTS);
  fsp.writeFile(recentsPath(), JSON.stringify(recents)).catch(() => {});
  app.addRecentDocument(filePath);
  buildMenu();
}

function clearRecents() {
  recents = [];
  fsp.writeFile(recentsPath(), '[]').catch(() => {});
  app.clearRecentDocuments();
  buildMenu();
}

// ───────────────────────── Fenêtres ─────────────────────────

/** Repère, dans une ligne de commande, les documents à ouvrir. */
function filesFromArgv(argv, cwd) {
  return argv
    .slice(1)
    .filter((arg) => arg && !arg.startsWith('-'))
    .map((arg) => path.resolve(cwd || process.cwd(), arg))
    .filter((p) => {
      try {
        return isSupported(p) && fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

function createWindow(initialFile = null) {
  const focused = BrowserWindow.getFocusedWindow();
  const offset = focused ? { x: focused.getPosition()[0] + 28, y: focused.getPosition()[1] + 28 } : {};
  const win = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 720,
    minHeight: 480,
    ...offset,
    show: false,
    title: APP_NAME,
    backgroundColor: '#f8f9fa',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  windowState.set(win.id, { initialFile, dirty: false, closing: false });
  const id = win.id;

  win.once('ready-to-show', () => win.show());

  // La page ne navigue jamais ; les liens s'ouvrent dans le navigateur par défaut.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (event) => {
    const state = windowState.get(id);
    if (!state || state.closing || !state.dirty) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      title: APP_NAME,
      message: 'Voulez-vous enregistrer les modifications apportées à ce document ?',
      detail: 'Vos modifications seront perdues si vous ne les enregistrez pas.',
      buttons: ['Enregistrer', 'Ne pas enregistrer', 'Annuler'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (choice === 0) {
      win.webContents.send('command', 'save-and-close');
    } else if (choice === 1) {
      state.closing = true;
      win.close();
    }
  });
  win.on('closed', () => windowState.delete(id));

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  return win;
}

function sendCommand(command, payload) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send('command', command, payload);
  else if (command === 'open-path') createWindow(payload);
  else if (command === 'new') createWindow();
}

// ───────────────────────── Menus ─────────────────────────

function buildMenu() {
  const key = (keyCode, modifiers = ['control']) => () => {
    const wc = BrowserWindow.getFocusedWindow()?.webContents;
    if (!wc) return;
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const recentItems = recents.length
    ? [
        ...recents.map((filePath) => ({
          label: path.basename(filePath),
          toolTip: filePath,
          click: () => sendCommand('open-path', filePath),
        })),
        { type: 'separator' },
        { label: 'Effacer la liste', click: clearRecents },
      ]
    : [{ label: 'Aucun document récent', enabled: false }];

  const template = [
    {
      label: '&Fichier',
      submenu: [
        { label: '&Nouveau', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new') },
        { label: '&Ouvrir…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open') },
        { label: 'Documents &récents', submenu: recentItems },
        { type: 'separator' },
        { label: '&Enregistrer', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('save') },
        { label: 'Enregistrer &sous…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendCommand('save-as') },
        { label: 'Exporter en &PDF…', click: () => sendCommand('export-pdf') },
        { type: 'separator' },
        { label: '&Imprimer…', accelerator: 'CmdOrCtrl+P', click: () => sendCommand('print') },
        { type: 'separator' },
        { label: '&Fermer', accelerator: 'CmdOrCtrl+W', click: () => BrowserWindow.getFocusedWindow()?.close() },
        { label: '&Quitter', accelerator: 'Alt+F4', registerAccelerator: false, click: () => app.quit() },
      ],
    },
    {
      // L'éditeur gère lui-même ces raccourcis : le menu se contente de les rejouer.
      label: '&Édition',
      submenu: [
        { label: '&Annuler', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: key('Z') },
        { label: '&Rétablir', accelerator: 'CmdOrCtrl+Y', registerAccelerator: false, click: key('Y') },
        { type: 'separator' },
        { label: '&Couper', accelerator: 'CmdOrCtrl+X', registerAccelerator: false, role: 'cut' },
        { label: 'Co&pier', accelerator: 'CmdOrCtrl+C', registerAccelerator: false, role: 'copy' },
        { label: 'C&oller', accelerator: 'CmdOrCtrl+V', registerAccelerator: false, role: 'paste' },
        { label: '&Tout sélectionner', accelerator: 'CmdOrCtrl+A', registerAccelerator: false, click: key('A') },
        { type: 'separator' },
        { label: 'Rec&hercher…', accelerator: 'CmdOrCtrl+F', registerAccelerator: false, click: key('F') },
        { label: 'R&emplacer…', accelerator: 'CmdOrCtrl+H', registerAccelerator: false, click: key('H') },
      ],
    },
    {
      label: '&Affichage',
      submenu: [
        { label: 'Zoom &avant', accelerator: 'CmdOrCtrl+Plus', click: () => sendCommand('zoom-in') },
        { label: 'Zoom a&rrière', accelerator: 'CmdOrCtrl+-', click: () => sendCommand('zoom-out') },
        { label: 'Taille &réelle', accelerator: 'CmdOrCtrl+0', click: () => sendCommand('zoom-reset') },
        { type: 'separator' },
        { label: '&Plein écran', role: 'togglefullscreen' },
      ],
    },
    {
      label: 'A&ide',
      submenu: [
        { label: 'Outils de développement', accelerator: 'CmdOrCtrl+Shift+I', role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: `À propos de ${APP_NAME}`,
          click: () =>
            dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
              type: 'info',
              title: `À propos de ${APP_NAME}`,
              message: `${APP_NAME} ${app.getVersion()}`,
              detail:
                'Traitement de texte pour documents Word.\n' +
                'Édition spéciale, conçue pour Olivier Denise. 😉\n\n' +
                'Moteur d’édition : docx-editor (Apache-2.0). ' +
                'Conversions : html-to-docx, word-extractor, marked (MIT).',
              buttons: ['OK'],
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ───────────────────────── Impression et PDF ─────────────────────────

/** Charge le rendu paginé dans une fenêtre cachée, sans script, puis exécute `fn`. */
async function withPrintWindow(parent, html, fn) {
  const tmp = path.join(app.getPath('temp'), `feuillet-impression-${process.pid}-${Date.now()}.html`);
  await fsp.writeFile(tmp, html, 'utf8');
  const win = new BrowserWindow({
    show: false,
    parent: parent || undefined,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true },
  });
  try {
    await win.loadFile(tmp);
    return await fn(win.webContents);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

// ───────────────────────── Échanges avec l'interface ─────────────────────────

function registerIpc() {
  const winOf = (event) => BrowserWindow.fromWebContents(event.sender);

  ipcMain.handle('app:startup', (event) => {
    const state = windowState.get(winOf(event)?.id);
    const file = state ? state.initialFile : null;
    if (state) state.initialFile = null;
    let userName = '';
    try {
      userName = os.userInfo().username;
    } catch {
      // Sans nom d'utilisateur, l'éditeur garde son auteur par défaut.
    }
    return { file, userName, version: app.getVersion() };
  });

  ipcMain.handle('file:open-dialog', async (event) => {
    const result = await dialog.showOpenDialog(winOf(event), {
      title: 'Ouvrir un document',
      filters: OPEN_FILTERS,
      properties: ['openFile'],
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  ipcMain.handle('file:read', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !isSupported(filePath)) {
      throw new Error("Ce format de fichier n'est pas pris en charge.");
    }
    const { data, native, format } = await importFile(filePath);
    addRecent(filePath);
    return { filePath, name: path.basename(filePath), data: new Uint8Array(data), native, format };
  });

  ipcMain.handle('file:save-dialog', async (event, options = {}) => {
    const pdf = options.kind === 'pdf';
    const result = await dialog.showSaveDialog(winOf(event), {
      title: pdf ? 'Exporter en PDF' : 'Enregistrer sous',
      defaultPath: typeof options.defaultPath === 'string' ? options.defaultPath : undefined,
      filters: pdf
        ? [{ name: 'Document PDF', extensions: ['pdf'] }]
        : [{ name: 'Document Word', extensions: ['docx'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const wanted = pdf ? 'pdf' : 'docx';
    return extensionOf(result.filePath) === wanted ? result.filePath : `${result.filePath}.${wanted}`;
  });

  ipcMain.handle('file:write', async (_event, filePath, data) => {
    if (typeof filePath !== 'string' || !['docx', 'docm'].includes(extensionOf(filePath))) {
      throw new Error("Enregistrement impossible : extension de fichier non autorisée.");
    }
    // Écriture dans un fichier voisin puis renommage : une panne en cours
    // d'écriture ne peut pas abîmer le document existant.
    let bytes = Buffer.from(data);
    try {
      bytes = await tidyDocxMedia(bytes);
    } catch {
      // La remise en ordre des images est un confort : en cas d'échec, on écrit le document tel quel.
    }
    const tmp = `${filePath}.${process.pid}.tmp`;
    try {
      await fsp.writeFile(tmp, bytes);
      await fsp.rename(tmp, filePath);
    } catch (error) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
    addRecent(filePath);
    return true;
  });

  ipcMain.handle('print:pdf', async (event, filePath, html) => {
    if (typeof filePath !== 'string' || extensionOf(filePath) !== 'pdf') {
      throw new Error('Export impossible : le fichier doit porter l’extension .pdf.');
    }
    const pdf = await withPrintWindow(winOf(event), html, (wc) =>
      wc.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      }),
    );
    await fsp.writeFile(filePath, pdf);
    return true;
  });

  ipcMain.handle('print:print', (event, html) =>
    withPrintWindow(
      winOf(event),
      html,
      (wc) =>
        new Promise((resolve) => {
          wc.print({ silent: false, printBackground: true, margins: { marginType: 'none' } }, (success, reason) =>
            resolve({ success, reason: reason || null }),
          );
        }),
    ),
  );

  ipcMain.handle('win:new', (_event, filePath) => {
    createWindow(typeof filePath === 'string' ? filePath : null);
  });

  ipcMain.on('win:state', (event, state) => {
    const win = winOf(event);
    const current = windowState.get(win?.id);
    if (!win || !current || !state) return;
    current.dirty = !!state.dirty;
    if (typeof state.title === 'string') win.setTitle(state.title);
    if (process.platform === 'darwin') win.setDocumentEdited(current.dirty);
  });

  ipcMain.on('win:close-now', (event) => {
    const win = winOf(event);
    const state = windowState.get(win?.id);
    if (!win || !state) return;
    state.closing = true;
    win.close();
  });

  ipcMain.handle('dialog:error', (event, title, detail) =>
    dialog.showMessageBox(winOf(event), {
      type: 'error',
      title: APP_NAME,
      message: String(title),
      detail: detail ? String(detail) : undefined,
      buttons: ['OK'],
    }),
  );
}

// ───────────────────────── Démarrage ─────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName(APP_NAME);
  if (process.platform === 'win32') app.setAppUserModelId('fr.feuillet.app');

  // Un second lancement (double-clic sur un document, par exemple) ouvre une
  // fenêtre dans l'instance déjà en cours.
  app.on('second-instance', (_event, argv, cwd) => {
    const files = filesFromArgv(argv, cwd);
    if (files.length) files.forEach((file) => createWindow(file));
    else createWindow();
  });

  // macOS : ouverture depuis le Finder.
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (app.isReady()) createWindow(filePath);
    else app.once('ready', () => createWindow(filePath));
  });

  app.whenReady().then(() => {
    loadRecents();
    registerIpc();
    buildMenu();
    const files = filesFromArgv(process.argv.slice(app.isPackaged ? 0 : 1), process.cwd());
    if (files.length) files.forEach((file) => createWindow(file));
    else if (!BrowserWindow.getAllWindows().length) createWindow();

    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
