// The only bridge between the Hearth web page and the desktop app. The page
// gets these few functions and nothing else: no files, no Node.js.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hearthDesktop', {
  platform: process.platform,
  onToggleMute: (cb) => ipcRenderer.on('desktop:toggle-mute', () => cb()),
  onToggleDeafen: (cb) => ipcRenderer.on('desktop:toggle-deafen', () => cb()),
  setBadge: (count) => ipcRenderer.send('desktop:badge', Number(count) || 0),
  flash: () => ipcRenderer.send('desktop:flash'),
  retry: () => ipcRenderer.send('desktop:retry'),
  changeServer: () => ipcRenderer.send('desktop:change-server'),
});
