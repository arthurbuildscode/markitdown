// L'Atelier d'Olivier — processus principal Electron.
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const APP_TITLE = "L'Atelier d'Olivier";
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'heif', 'ico', 'svg'];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.onnx': 'application/octet-stream',
};

const DIST_DIR = path.join(__dirname, 'dist');
const MODELS_DIR = app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(__dirname, 'models');

let mainWindow = null;
let hasUnsavedChanges = false;
const approvedSavePaths = new Set();

// Filet de sécurité : sur un ordinateur sans accélération graphique utilisable,
// l'affichage WebGL bascule sur un rendu logiciel au lieu d'échouer.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

// Un schéma « app:// » sécurisé permet l'isolation d'origine (COOP/COEP),
// indispensable au calcul multi-cœur des modèles IA (WebAssembly threads).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function resolveAppUrl(requestUrl) {
  const url = new URL(requestUrl);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const isModel = pathname.startsWith('/models/');
  const root = isModel ? MODELS_DIR : DIST_DIR;
  const relative = isModel ? pathname.slice('/models/'.length) : pathname.slice(1);
  const file = path.normalize(path.join(root, relative));
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const file = resolveAppUrl(request.url);
    if (!file) return new Response('Interdit', { status: 403 });
    try {
      const data = await fsp.readFile(file);
      return new Response(data, {
        headers: {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'Cache-Control': 'no-cache',
        },
      });
    } catch {
      return new Response('Introuvable', { status: 404 });
    }
  });
}

function isImagePath(candidate) {
  if (!candidate || candidate.startsWith('-')) return false;
  const ext = path.extname(candidate).slice(1).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext) && fs.existsSync(candidate);
}

function findImageArgument(argv) {
  return argv.slice(1).find(isImagePath) || null;
}

async function readImageFile(filePath) {
  const data = await fsp.readFile(filePath);
  return { path: filePath, name: path.basename(filePath), data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1020,
    minHeight: 660,
    show: false,
    title: APP_TITLE,
    backgroundColor: '#14170f',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!hasUnsavedChanges) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      title: APP_TITLE,
      message: 'Quitter sans enregistrer ?',
      detail: "Les retouches de la photo en cours n'ont pas été enregistrées.",
      buttons: ['Rester dans l’atelier', 'Quitter sans enregistrer'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice === 0) event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL('app://atelier/index.html');
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    initialFile: findImageArgument(process.argv),
    platform: process.platform,
  }));

  ipcMain.handle('dialog:open', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Ouvrir une photo',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: IMAGE_EXTENSIONS },
        { name: 'Tous les fichiers', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return readImageFile(result.filePaths[0]);
  });

  ipcMain.handle('file:read', async (_event, filePath) => {
    if (!isImagePath(filePath)) return null;
    return readImageFile(filePath);
  });

  ipcMain.handle('dialog:save', async (_event, options) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Enregistrer la photo',
      defaultPath: options.defaultPath,
      filters: options.filters,
      properties: ['showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return null;
    let filePath = result.filePath;
    if (options.extension && !path.extname(filePath)) filePath += '.' + options.extension;
    approvedSavePaths.add(filePath);
    return filePath;
  });

  ipcMain.handle('file:write', async (_event, filePath, data) => {
    if (!approvedSavePaths.has(filePath)) throw new Error('Emplacement non autorisé');
    await fsp.writeFile(filePath, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    return true;
  });

  ipcMain.handle('shell:show', (_event, filePath) => {
    if (approvedSavePaths.has(filePath)) shell.showItemInFolder(filePath);
  });

  ipcMain.on('app:dirty', (_event, dirty) => {
    hasUnsavedChanges = Boolean(dirty);
  });

  ipcMain.handle('app:default-dir', () => app.getPath('pictures'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const file = findImageArgument(argv);
    if (file) mainWindow.webContents.send('open-path', file);
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerAppProtocol();
    registerIpc();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
