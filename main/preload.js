'use strict';
// The only bridge between the UI and Node. Keep it small and explicit.

const { contextBridge, ipcRenderer } = require('electron');

function listen(channel, fn) {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('skin', {
  hide: () => ipcRenderer.send('skin:hide'),
  init: () => ipcRenderer.invoke('skin:init'),
  // Spotify
  control: (cmd) => ipcRenderer.send('skin:control', cmd),
  setShuffle: (on) => ipcRenderer.send('skin:shuffle', Boolean(on)),
  setRepeat: (status) => ipcRenderer.send('skin:repeat', String(status)),
  seek: (ms) => ipcRenderer.send('skin:seek', Number(ms)),
  openSpotify: () => ipcRenderer.send('skin:open-spotify'),
  // The rendered background, written as the real XFCE wallpaper
  setWallpaper: (trackId, bytes) => ipcRenderer.send('skin:wallpaper', { trackId: String(trackId), bytes }),
  saveA11y: (a11y) => ipcRenderer.send('skin:a11y', a11y),
  onPlayer: (fn) => listen('skin:player', fn),
  onArt: (fn) => listen('skin:art', fn),
  onHistory: (fn) => listen('skin:history', fn),
  onPaused: (fn) => listen('skin:paused', fn),
  onBeat: (fn) => listen('skin:beat', fn),
  onLyrics: (fn) => listen('skin:lyrics', fn),
  // The glow tells the app when the beat pulse is on screen (listening only happens then).
  setGlowWanted: (on) => ipcRenderer.send('skin:glow-want', Boolean(on)),
});
