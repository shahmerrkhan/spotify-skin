'use strict';
// Paths and the user-editable settings file (~/.config/spotify-skin/config.json).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'spotify-skin');
const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'spotify-skin');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = Object.freeze({
  spotifyClientId: '',      // phase 3
  lastfmApiKey: '',         // phase 4, optional
  shortcut: 'Control+Alt+M',
  setRealWallpaper: true,   // phase 2
  reducedEffects: false,    // phase 5
  clock24h: true,
  // "desktop": behind every app, like a live wallpaper. "overlay": the phase 1
  // fullscreen window on top of everything (fallback if the desktop layer misbehaves).
  layer: 'desktop',
  // Start Spotify in the background (window hidden) when the skin starts, and again
  // if it quits while the skin is open. "Show Spotify" in the tray brings the window back.
  autoOpenSpotify: true,
  // Seconds without mouse movement before the panels fade to the minimal state.
  minimalAfterSec: 30,
  // reducedMotion: null follows the system setting; true/false is your choice from the Aa menu.
  // glow: edge glow strength from the Aa menu, "low" | "medium" | "high".
  a11y: { reducedMotion: null, largeText: false, highContrast: false, glow: 'medium' },
});

function ensureDirs() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Write to a temp file, fsync, then rename, so a crash never leaves half a file.
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function load() {
  ensureDirs();
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // First run: write the defaults so there is a file to edit.
    writeJsonAtomic(CONFIG_FILE, DEFAULTS);
    return { ...DEFAULTS };
  }
  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed, a11y: { ...DEFAULTS.a11y, ...parsed.a11y } };
  } catch (err) {
    // Never overwrite a file the user broke by hand; run on defaults instead.
    console.warn(`[config] ${CONFIG_FILE} is not valid JSON (${err.message}); using defaults.`);
    return { ...DEFAULTS };
  }
}

function save(cfg) {
  ensureDirs();
  writeJsonAtomic(CONFIG_FILE, cfg);
}

module.exports = { CONFIG_DIR, CACHE_DIR, CONFIG_FILE, DEFAULTS, load, save, writeJsonAtomic };
