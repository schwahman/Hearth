'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  save: (url) => ipcRenderer.invoke('setup:save', String(url || '')),
});
