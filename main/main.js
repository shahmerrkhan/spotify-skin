'use strict';
// App lifecycle: tray, global shortcut, show/hide, Spotify, wallpaper safety, cleanup.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app, Tray, Menu, globalShortcut, ipcMain, nativeImage, net, protocol, powerMonitor, Notification, dialog,
} = require('electron');
const dbus = require('dbus-next');

const config = require('./config');
const wallpaper = require('./wallpaper');
const windowMgr = require('./window');
const art = require('./art');
const history = require('./history');
const { Mpris } = require('./mpris');
const { Visibility, isDesktopWindow } = require('./visibility');
const { SpotifyApp } = require('./spotify-app');

const DEV = process.argv.includes('--dev');
const DEVTOOLS = DEV && !process.argv.includes('--no-devtools');
const ROOT = windowMgr.ROOT;
const TRAY_ICON = path.join(ROOT, 'assets/icons/tray.png');
const TEST_WALLPAPER = '/usr/share/xfce4/backdrops/wallpapers_jbaer_wave.jpg';
const SERVED_DIRS = ['renderer', 'assets'];
const MAX_WALLPAPER_BYTES = 12 * 1024 * 1024;

// Serve the UI from app://skin/... so it has a real same-origin context
// (ES modules, external SVG <use>, fetch). file:// gives none of those reliably.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let tray = null;
let shortcutOk = false;
let cfg = null;
let sessionBus = null;
let systemBus = null;
let mpris = null;
let visibility = null;
let currentArt = { trackId: '', name: null }; // cover of the track Spotify is on now
let uiPaused = false;
let spotifyApp = null;
let quitting = false;
let launches = [];        // when the skin last started Spotify (relaunch rate limit)
let wasRunning = null;
let relaunchTimer = null;

const RELAUNCH_DELAY_MS = 3000;
const RELAUNCH_MAX = 3;           // at most this many automatic starts...
const RELAUNCH_WINDOW_MS = 10 * 60_000; // ...per 10 minutes, so a crashing Spotify can't loop

function log(...args) {
  console.log('[skin]', ...args);
}

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: 'Spotify Skin', body }).show();
  else log(body);
}

// Show / hide

function show() {
  const win = windowMgr.create({ dev: DEVTOOLS, layer: cfg.layer, onClosed: afterClose });
  win.once('show', () => {
    visibility?.start();
    mpris?.setActive(!uiPaused);
    spotifyApp?.rehide().catch(() => {});
    autoOpenSpotify('skin shown');
  });
  rebuildTrayMenu();
}

function hide() {
  windowMgr.destroy(); // afterClose runs from the window's 'closed' event
}

// Shared by Hide, Alt+F4 and the WM closing the window.
function afterClose() {
  visibility?.stop();
  uiPaused = false;
  mpris?.setActive(false);
  clearTimeout(relaunchTimer);
  spotifyApp?.release(); // Spotify back in the taskbar (minimised) while the skin is hidden
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

// Spotify

function onPlayerState(state, { trackChanged }) {
  windowMgr.send('skin:player', state);
  if (state.running !== wasRunning) {
    if (wasRunning && !state.running) {
      spotifyApp?.forget();
      clearTimeout(relaunchTimer);
      relaunchTimer = setTimeout(() => autoOpenSpotify('spotify quit'), RELAUNCH_DELAY_MS);
    }
    wasRunning = state.running;
    rebuildTrayMenu();
  }
  if (!state.running) {
    // Spotify quit: never leave album art behind as the wallpaper.
    currentArt = { trackId: '', name: null };
    restoreWallpaper('spotify closed');
    return;
  }
  if (trackChanged) {
    const t = state.track;
    if (t) windowMgr.send('skin:history', history.push(t));
    loadArt(t);
  }
}

async function loadArt(track) {
  const trackId = track?.id || '';
  currentArt = { trackId, name: null };
  const name = track?.artUrl ? await art.get(track.artUrl, { allowFile: DEV, keep: history.artNames() }) : null;
  if (currentArt.trackId !== trackId) return; // the song changed again while downloading
  currentArt = { trackId, name };
  windowMgr.send('skin:art', currentArt);
  if (name && trackId) windowMgr.send('skin:history', history.setArt(trackId, name));
}

// Starts Spotify in the background (window hidden), from the notice's button or automatically.
function openSpotify() {
  if (mpris?.state().running || spotifyApp.processRunning()) return;
  launches.push(Date.now());
  log('starting Spotify in the background');
  spotifyApp.launch().catch((err) => notify(`Couldn't start Spotify (${err.message}).`));
}

// Automatic start: when the skin starts or is shown, and when Spotify quits while
// the skin is open. Never while the skin is hidden or quitting.
function autoOpenSpotify(reason) {
  if (!cfg.autoOpenSpotify || quitting || !windowMgr.isOpen() || !mpris) return;
  if (mpris.state().running || spotifyApp.processRunning()) return;
  const now = Date.now();
  launches = launches.filter((t) => now - t < RELAUNCH_WINDOW_MS);
  if (launches.length >= RELAUNCH_MAX) {
    log(`not starting Spotify again (${reason}): already started ${RELAUNCH_MAX} times in 10 minutes`);
    return;
  }
  log(`auto-open (${reason})`);
  openSpotify();
}

// Space to play/pause: when no app window has focus (everything minimised, or
// the desktop clicked), the skin takes keyboard focus. Nothing system-wide.
async function onActiveWindow(id) {
  if (!windowMgr.isOpen() || windowMgr.getLayout()?.layer !== 'desktop') return;
  const own = windowMgr.xid();
  if (!own || id === own) return;
  if (id && !(await isDesktopWindow(id))) return; // an app has focus: leave it alone
  windowMgr.focusQuietly();
}

async function startServices() {
  sessionBus = dbus.sessionBus();
  sessionBus.on('error', (err) => console.error('[skin] session bus error:', err.message));
  try {
    systemBus = dbus.systemBus();
    systemBus.on('error', (err) => console.warn('[skin] system bus error:', err.message));
  } catch (err) {
    console.warn('[skin] no system bus; lock detection off:', err.message);
  }

  visibility = new Visibility({
    systemBus,
    sessionBus,
    getXid: windowMgr.xid,
    getBounds: () => windowMgr.getLayout()?.bounds,
  });
  visibility.on('change', (paused, flags) => {
    uiPaused = paused;
    if (DEV) log(`animations ${paused ? 'paused' : 'running'}`, JSON.stringify(flags));
    windowMgr.send('skin:paused', paused);
    mpris?.setActive(windowMgr.isOpen() && !paused);
  });
  visibility.on('active', (id) => onActiveWindow(id).catch(() => {}));
  powerMonitor.on('suspend', () => visibility.set('asleep', true));
  powerMonitor.on('resume', () => visibility.set('asleep', false));

  // Dev only: SKIN_MPRIS_BUS points the Spotify connection at another bus (e.g. a private
  // one running tools/mock-mpris.js) while xfconf and everything else stay on the real session.
  const mprisBus = DEV && process.env.SKIN_MPRIS_BUS ? dbus.sessionBus({ busAddress: process.env.SKIN_MPRIS_BUS }) : sessionBus;
  if (mprisBus !== sessionBus) log(`MPRIS on ${process.env.SKIN_MPRIS_BUS}`);
  // In dev against a private bus, "starting Spotify" starts the mock player there instead
  // (it opens a stand-in window named "spotify"), so the real Spotify is never touched.
  spotifyApp = new SpotifyApp({
    devCommand: mprisBus !== sessionBus
      ? [process.execPath, [path.join(ROOT, 'tools/mock-mpris.js'), '--window'], { ELECTRON_RUN_AS_NODE: '1', DBUS_SESSION_BUS_ADDRESS: process.env.SKIN_MPRIS_BUS }]
      : null,
  });
  spotifyApp.on('error', (err) => notify(`Couldn't start Spotify (${err.message}).`));
  spotifyApp.on('change', rebuildTrayMenu);
  mpris = new Mpris(mprisBus);
  mpris.on('state', onPlayerState);
  try {
    await mpris.start();
  } catch (err) {
    console.error('[skin] MPRIS unavailable:', err.message);
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
  if (spotifyApp?.hidden && mpris?.state().running) {
    template.push({ label: 'Show Spotify', click: () => spotifyApp.show() }, { type: 'separator' });
  }
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

// Static file protocol: the UI and assets from the app folder, cover art from the cache.

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const { host, pathname } = new URL(request.url);
    if (host !== 'skin') return new Response('Not found', { status: 404 });
    const rel = path.normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
    if (rel.startsWith(`art${path.sep}`)) {
      const file = art.resolve(rel.slice(4));
      return file ? net.fetch(pathToFileURL(file).toString()) : new Response('Not found', { status: 404 });
    }
    const abs = path.join(ROOT, rel);
    const allowed = SERVED_DIRS.some((d) => abs.startsWith(path.join(ROOT, d) + path.sep));
    if (!allowed) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(abs).toString());
  });
}

// IPC from the UI. Every handler checks that the message comes from our own page.

const fromUi = (event) => Boolean(event.senderFrame?.url.startsWith('app://skin/'));

function registerIpc() {
  ipcMain.on('skin:hide', (event) => {
    if (fromUi(event)) hide();
  });

  ipcMain.handle('skin:init', (event) => {
    if (!fromUi(event)) return null;
    const layout = windowMgr.getLayout();
    return {
      dev: DEV,
      layer: layout?.layer || cfg.layer,
      insets: layout?.insets || { top: 0, right: 0, bottom: 0, left: 0 },
      minimalAfterSec: Math.max(3, Number(cfg.minimalAfterSec) || 30),
      clock24h: cfg.clock24h !== false,
      a11y: cfg.a11y,
      paused: uiPaused,
      player: mpris ? mpris.state() : null,
      art: currentArt,
      history: history.list(),
    };
  });

  ipcMain.on('skin:control', (event, cmd) => {
    if (fromUi(event)) mpris?.command(String(cmd));
  });
  ipcMain.on('skin:shuffle', (event, on) => {
    if (fromUi(event)) mpris?.setShuffle(Boolean(on));
  });
  ipcMain.on('skin:repeat', (event, status) => {
    if (fromUi(event)) mpris?.setLoop(String(status));
  });
  ipcMain.on('skin:seek', (event, ms) => {
    if (fromUi(event) && Number.isFinite(ms)) mpris?.seek(ms);
  });
  ipcMain.on('skin:open-spotify', (event) => {
    if (fromUi(event)) openSpotify();
  });

  ipcMain.on('skin:wallpaper', (event, msg) => {
    if (!fromUi(event) || !cfg.setRealWallpaper || !windowMgr.isOpen()) return;
    const state = mpris?.state();
    if (!state?.running || !state.track || msg?.trackId !== state.track.id) return; // stale render
    const bytes = msg.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes.length > MAX_WALLPAPER_BYTES) return;
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return; // JPEG only
    wallpaper.queueImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
  });

  ipcMain.on('skin:a11y', (event, a) => {
    if (!fromUi(event) || !a || typeof a !== 'object') return;
    const pick = (v) => (v === null ? null : Boolean(v));
    cfg.a11y = { reducedMotion: pick(a.reducedMotion), largeText: Boolean(a.largeText), highContrast: Boolean(a.highContrast) };
    try {
      config.save(cfg);
    } catch (err) {
      console.error('[skin] saving settings failed:', err.message);
    }
  });
}

// Dev only: `kill -USR2 <pid>` saves a screenshot of the page and logs memory per process.
function installDevProbe() {
  process.on('SIGUSR2', async () => {
    const win = windowMgr.get();
    if (win) {
      const img = await win.webContents.capturePage();
      const file = path.join(config.CACHE_DIR, 'dev-capture.png');
      fs.writeFileSync(file, img.toPNG());
      log(`captured ${file}`);
    }
    const metrics = app.getAppMetrics().map((m) => `${m.type}:${Math.round(m.memory.workingSetSize / 1024)}MB`);
    log(`memory ${metrics.join(' ')}`);
  });
}

// Cleanup on exit

let cleanedUp = false;
function cleanup(reason) {
  if (cleanedUp) return;
  cleanedUp = true;
  quitting = true;
  clearTimeout(relaunchTimer);
  globalShortcut.unregisterAll();
  visibility?.stop();
  spotifyApp?.release();
  restoreWallpaper(reason);
}

function installExitHandlers() {
  app.on('before-quit', () => {
    quitting = true;
    cleanup('quit');
  });
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

  app.whenReady().then(async () => {
    cfg = config.load();
    // Recover from a crash while album art was the wallpaper.
    if (wallpaper.isDirty()) restoreWallpaper('crash recovery');

    installExitHandlers();
    registerAppProtocol();
    registerIpc();
    if (DEV) installDevProbe();
    registerShortcut();
    createTray();
    await startServices();
    wasRunning = mpris?.state().running ?? null;
    show(); // also starts Spotify if it isn't running (autoOpenSpotify)
    log(`ready${DEV ? ' (dev)' : ''}; layer ${cfg.layer}; shortcut ${shortcutOk ? cfg.shortcut : 'unavailable'}; config ${config.CONFIG_FILE}`);
  });
}
