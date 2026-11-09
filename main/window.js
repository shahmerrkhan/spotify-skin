'use strict';
// The single fullscreen, borderless dashboard window. "Hide" destroys it
// (frees the GPU and memory); "Show" builds a new one.

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

const ROOT = path.join(__dirname, '..');
const ENTRY = 'app://skin/renderer/index.html';

let win = null;

function isOpen() {
  return win !== null && !win.isDestroyed();
}

function create({ dev = false, onClosed } = {}) {
  if (isOpen()) {
    win.focus();
    return win;
  }

  const { bounds } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...bounds,
    frame: false,
    fullscreen: true,          // xfwm4 puts fullscreen windows above the XFCE panel
    skipTaskbar: true,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#0c0b0a', // matches --ink-950, so there's no white flash
    title: 'Spotify Skin',
    icon: path.join(ROOT, 'assets/icons/tray.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // This is a single-page app: block in-window navigation and popups.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.once('ready-to-show', () => {
    win.show();
    win.setFullScreen(true); // sometimes ignored on X11 before the window is mapped
    win.focus();
  });

  // Fires for Hide, and also for Alt+F4 or the WM closing the window.
  win.on('closed', () => {
    win = null;
    onClosed?.();
  });

  win.loadURL(ENTRY);
  if (dev) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

function destroy() {
  if (isOpen()) win.destroy(); // triggers 'closed'
  win = null;
}

module.exports = { create, destroy, isOpen, ROOT };
