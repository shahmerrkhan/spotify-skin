'use strict';
// The single dashboard window. "Hide" destroys it (frees the GPU and memory);
// "Show" builds a new one.
//
// Two layers (config "layer"):
// - "desktop" (default): an X11 desktop-type window. xfwm4 keeps it below every
//   normal window on all workspaces, out of the taskbar and Alt+Tab, with the XFCE
//   panel on top. Apps such as Opera stay fully usable above it; wherever it shows,
//   it gets the clicks. It never steals focus when it appears.
// - "overlay": the phase 1 fullscreen window on top of everything, panel included.

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

const ROOT = path.join(__dirname, '..');
const ENTRY = 'app://skin/renderer/index.html';

let win = null;
let layout = null;

function isOpen() {
  return win !== null && !win.isDestroyed();
}

function get() {
  return isOpen() ? win : null;
}

// X11 window id, for the stacking checks in visibility.js.
function xid() {
  if (!isOpen()) return 0;
  const h = win.getNativeWindowHandle();
  return h.length >= 4 ? h.readUInt32LE(0) : 0;
}

// Screen bounds plus how much of each edge the XFCE panel(s) take, so the UI can
// keep its controls out from under the panel in desktop mode.
function computeLayout(layer) {
  const d = screen.getPrimaryDisplay();
  const b = d.bounds;
  const w = d.workArea;
  const insets = layer === 'overlay'
    ? { top: 0, right: 0, bottom: 0, left: 0 }
    : {
        top: w.y - b.y,
        left: w.x - b.x,
        right: b.x + b.width - (w.x + w.width),
        bottom: b.y + b.height - (w.y + w.height),
      };
  return { layer, bounds: { ...b }, insets };
}

function getLayout() {
  return layout;
}

function create({ dev = false, layer = 'desktop', onClosed } = {}) {
  if (isOpen()) {
    if (layout?.layer === 'overlay') win.focus();
    return win;
  }

  const desktop = layer !== 'overlay';
  layout = computeLayout(desktop ? 'desktop' : 'overlay');
  const { bounds } = layout;
  win = new BrowserWindow({
    ...bounds,
    ...(desktop ? { type: 'desktop' } : { fullscreen: true }), // xfwm4 puts fullscreen windows above the panel
    frame: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
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
      backgroundThrottling: false, // a desktop window is "unfocused" most of the time; we pause animations ourselves
    },
  });

  // This is a single-page app: block in-window navigation and popups.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.once('ready-to-show', () => {
    if (desktop) {
      win.showInactive();
      win.setBounds(bounds);
      win.setVisibleOnAllWorkspaces(true);
    } else {
      win.show();
      win.setFullScreen(true); // sometimes ignored on X11 before the window is mapped
      win.focus();
    }
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

// Keyboard focus for the desktop-layer window (so Space works) without raising it:
// a desktop-type window stays below every app whatever has focus.
function focusQuietly() {
  if (isOpen() && layout?.layer === 'desktop') win.focus();
}

function send(channel, payload) {
  if (isOpen()) win.webContents.send(channel, payload);
}

module.exports = { create, destroy, isOpen, get, send, xid, getLayout, focusQuietly, ROOT };
