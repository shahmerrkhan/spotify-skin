'use strict';
// The only bridge between the UI and Node. Keep it small and explicit.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skin', {
  hide: () => ipcRenderer.send('skin:hide'),
});
