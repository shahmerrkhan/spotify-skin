'use strict';
// App lifecycle: tray, global shortcut, show/hide, wallpaper safety, cleanup.

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app, Tray, Menu, globalShortcut, ipcMain, nativeImage, net, protocol, powerMonitor, Notification, dialog,
} = require('electron');

const config = require('./config');
const wallpaper = require('./wallpaper');
const windowMgr = require('./window');

const DEV = process.argv.includes('--dev');
const ROOT = windowMgr.ROOT;
const TRAY_ICON = path.join(ROOT, 'assets/icons/tray.png');
const TEST_WALLPAPER = '/usr/share/xfce4/backdrops/wallpapers_jbaer_wave.jpg';
const SERVED_DIRS = ['renderer', 'assets'];

// Serve the UI from app://skin/... so it has a real same-origin context
// (ES modules, external SVG <use>, fetch). file:// gives none of those reliably.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let tray = null;
let shortcutOk = false;
let cfg = null;

function log(...args) {
  console.log('[skin]', ...args);
}

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: 'Spotify Skin', body }).show();
  else log(body);
}

// Show / hide

function show() {
  windowMgr.create({ dev: DEV, onClosed: afterClose });
  rebuildTrayMenu();
}

function hide() {
  windowMgr.destroy(); // afterClose runs from the window's 'closed' event
}

// Shared by Hide, Alt+F4 and the WM closing the window.
function afterClose() {
  restoreWallpaper('hide');
  rebuildTrayMenu();
}

function toggle() {
  if (windowMgr.isOpen()) hide();
  else show();
}

function restoreWallpaper(reason) {
  try {
    if (wallpaper.restore()) log(`wallpaper restored (${reason})`);
  } catch (err) {
    console.error(`[skin] wallpaper restore failed (${reason}):`, err.message);
  }
}

// Tray

function rebuildTrayMenu() {
  if (!tray) return;
  const open = windowMgr.isOpen();
  const template = [
    { label: open ? 'Hide' : 'Show', accelerator: shortcutOk ? cfg.shortcut : undefined, click: toggle },
    { type: 'separator' },
  ];
  if (DEV) {
    template.push(
      { label: 'Dev: test wallpaper swap', click: devTestWallpaper },
      { label: 'Dev: restore wallpaper now', click: () => restoreWallpaper('manual') },
      { label: 'Dev: simulate crash (SIGKILL)', click: () => process.kill(process.pid, 'SIGKILL') },
      { type: 'separator' },
    );
  }
  template.push({ label: 'Quit', click: () => app.quit() });
  // Linux StatusNotifier trays only pick up changes when the menu is set again.
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function devTestWallpaper() {
  try {
    wallpaper.set(TEST_WALLPAPER);
    log(`test wallpaper set; backup at ${wallpaper.BACKUP_FILE}`);
  } catch (err) {
    dialog.showErrorBox('Wallpaper swap failed', err.message);
  }
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  tray.setToolTip('Spotify Skin');
  // A left click toggles on XEmbed trays. SNI/indicator trays may only open the menu,
  // which is why Show/Hide is also the first menu item.
  tray.on('click', toggle);
  rebuildTrayMenu();
}

// Shortcut

function registerShortcut() {
  try {
    shortcutOk = globalShortcut.register(cfg.shortcut, toggle);
  } catch (err) {
    shortcutOk = false;
    log(`invalid shortcut "${cfg.shortcut}": ${err.message}`);
  }
  if (!shortcutOk) {
    notify(`Couldn't register ${cfg.shortcut} (another app may be using it). Use the tray icon, or change "shortcut" in ${config.CONFIG_FILE}.`);
  }
}

// Static file protocol

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const { host, pathname } = new URL(request.url);
    const rel = path.normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
    const abs = path.join(ROOT, rel);
    const allowed = host === 'skin' && SERVED_DIRS.some((d) => abs.startsWith(path.join(ROOT, d) + path.sep));
    if (!allowed) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(abs).toString());
  });
}

// Cleanup on exit

let cleanedUp = false;
function cleanup(reason) {
  if (cleanedUp) return;
  cleanedUp = true;
  globalShortcut.unregisterAll();
  restoreWallpaper(reason);
}

function installExitHandlers() {
  app.on('before-quit', () => cleanup('quit'));
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => {
      cleanup(sig);
      app.exit(0);
    });
  }
  powerMonitor.on('shutdown', () => cleanup('shutdown'));
}

// Startup

if (!app.requestSingleInstanceLock()) {
  // Already running: that instance gets 'second-instance' and toggles.
  app.quit();
} else {
  app.on('second-instance', toggle);
  // The app lives in the tray, so closing the window must not quit it.
  app.on('window-all-closed', () => {});

  app.whenReady().then(() => {
    cfg = config.load();
    // Recover from a crash while album art was the wallpaper.
    if (wallpaper.isDirty()) restoreWallpaper('crash recovery');

    installExitHandlers();
    registerAppProtocol();
    registerShortcut();
    createTray();
    show();
    log(`ready${DEV ? ' (dev)' : ''}; shortcut ${shortcutOk ? cfg.shortcut : 'unavailable'}; config ${config.CONFIG_FILE}`);
  });

  ipcMain.on('skin:hide', (event) => {
    if (!event.senderFrame?.url.startsWith('app://skin/')) return;
    hide();
  });
}
