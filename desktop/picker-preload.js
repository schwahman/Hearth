'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  onSources: (cb) => ipcRenderer.on('picker:sources', (_e, data) => cb(data)),
  choose: (id, audio) => ipcRenderer.send('picker:choose', id ? { id, audio: !!audio } : null),
});
