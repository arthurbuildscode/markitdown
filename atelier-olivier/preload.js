// Pont sécurisé entre l'interface et le système (fichiers, dialogues).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('atelier', {
  info: () => ipcRenderer.invoke('app:info'),
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  saveDialog: (options) => ipcRenderer.invoke('dialog:save', options),
  writeFile: (filePath, data) => ipcRenderer.invoke('file:write', filePath, data),
  showInFolder: (filePath) => ipcRenderer.invoke('shell:show', filePath),
  defaultDir: () => ipcRenderer.invoke('app:default-dir'),
  setDirty: (dirty) => ipcRenderer.send('app:dirty', dirty),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  onOpenPath: (callback) => ipcRenderer.on('open-path', (_event, filePath) => callback(filePath)),
});
