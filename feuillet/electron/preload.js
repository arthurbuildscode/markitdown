'use strict';
/**
 * Pont entre l'interface (isolée, sans accès à Node) et le processus principal.
 * Seules les opérations listées ici sont accessibles depuis la page.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('feuillet', {
  /** Contexte de démarrage : fichier à ouvrir (double-clic, « Ouvrir avec »…), nom d'utilisateur. */
  getStartup: () => ipcRenderer.invoke('app:startup'),
  /** Boîte de dialogue « Ouvrir » → chemin choisi, ou null. */
  showOpenDialog: () => ipcRenderer.invoke('file:open-dialog'),
  /** Lit un fichier et le renvoie converti en .docx. */
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  /** Boîte de dialogue « Enregistrer sous » → chemin choisi, ou null. */
  showSaveDialog: (options) => ipcRenderer.invoke('file:save-dialog', options),
  writeFile: (filePath, data) => ipcRenderer.invoke('file:write', filePath, data),
  exportPdf: (filePath, html) => ipcRenderer.invoke('print:pdf', filePath, html),
  print: (html) => ipcRenderer.invoke('print:print', html),
  /** Ouvre une nouvelle fenêtre, vide ou sur le fichier indiqué. */
  newWindow: (filePath) => ipcRenderer.invoke('win:new', filePath ?? null),
  /** Informe le processus principal du titre et de l'état « modifié ». */
  setState: (state) => ipcRenderer.send('win:state', state),
  /** Ferme la fenêtre sans redemander confirmation. */
  closeWindow: () => ipcRenderer.send('win:close-now'),
  showError: (title, detail) => ipcRenderer.invoke('dialog:error', title, detail),
  pathForFile: (file) => webUtils.getPathForFile(file),
  /** Commandes venant des menus natifs (« new », « open », « save »…). */
  onCommand: (callback) => {
    const listener = (_event, command, payload) => callback(command, payload);
    ipcRenderer.on('command', listener);
    return () => ipcRenderer.removeListener('command', listener);
  },
});
