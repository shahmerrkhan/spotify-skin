'use strict';
// Real XFCE wallpaper control through xfconf-query, with a crash-safe backup.
//
// Lifecycle:
//   set(path)  -> on the first change, snapshot every backdrop key to
//                 wallpaper-backup.json with dirty:true, then write the new image
//                 to every workspace that was snapshotted.
//   restore()  -> write the snapshot back exactly, then mark dirty:false.
// While dirty is true the snapshot is never replaced, so repeated set() calls
// (one per song later) can't overwrite your real originals with album art.
// If the app dies while dirty, the next launch calls restore() first.
//
// Every call is synchronous on purpose: restore() has to finish inside
// signal handlers and before-quit, where async work may never run.

const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { CONFIG_DIR, CACHE_DIR, writeJsonAtomic } = require('./config');

const CHANNEL = 'xfce4-desktop';
const BACKUP_FILE = path.join(CONFIG_DIR, 'wallpaper-backup.json');
// Matches per-workspace keys (monitoreDP-1/workspace0/last-image) and the
// legacy per-monitor ones (monitor0/last-image). Monitor names come from the
// live key list, so plugging in another display just adds keys.
const KEY_RE = /^\/backdrop\/screen\d+\/monitor[^/]+(?:\/workspace\d+)?\/(?:last-image|image-style)$/;
const STYLE_ZOOMED = '5';

function xfconf(args) {
  return execFileSync('xfconf-query', ['-c', CHANNEL, ...args], {
    encoding: 'utf8',
    timeout: 4000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\n$/, '');
}

function listKeys() {
  return xfconf(['-l'])
    .split('\n')
    .map((k) => k.trim())
    .filter((k) => KEY_RE.test(k));
}

function snapshot() {
  return listKeys().map((key) => ({ key, value: xfconf(['-p', key]) }));
}

function readBackup() {
  try {
    return JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function isDirty() {
  return readBackup()?.dirty === true;
}

function ensureBackup() {
  const existing = readBackup();
  if (existing?.dirty) return existing;
  const entries = snapshot();
  if (!entries.some((e) => e.key.endsWith('/last-image'))) {
    throw new Error('No XFCE backdrop keys found in xfconf; refusing to change the wallpaper.');
  }
  const backup = { dirty: true, savedAt: new Date().toISOString(), entries };
  writeJsonAtomic(BACKUP_FILE, backup);
  return backup;
}

// Note for later phases: xfdesktop ignores a write of the same path it already
// shows, so per-song images must alternate filenames.
function set(imagePath) {
  if (!fs.existsSync(imagePath)) throw new Error(`Wallpaper file not found: ${imagePath}`);
  const backup = ensureBackup();
  // Only touch keys that are in the snapshot, so everything we change can be put back.
  for (const { key } of backup.entries) {
    xfconf(['-p', key, '-s', key.endsWith('/last-image') ? imagePath : STYLE_ZOOMED]);
  }
}

// Per-song wallpaper (phase 2b)
//
// queueImage(jpegBuffer) never blocks the main process: the newest image wins,
// older pending ones are dropped, and only one write runs at a time. Files
// alternate between wall-a.jpg and wall-b.jpg because xfdesktop ignores a write
// of the path it already shows. The slot being shown is never overwritten.

const SLOTS = ['wall-a.jpg', 'wall-b.jpg'].map((f) => path.join(CACHE_DIR, f));
let slot = 0;
let pending = null;
let working = false;
let generation = 0;     // bumped by restore(); a running job stops at its next step
let inflight = null;    // the xfconf-query child currently writing, if any
let redoRestore = false;

function xfconfAsync(args) {
  return new Promise((resolve, reject) => {
    inflight = execFile('xfconf-query', ['-c', CHANNEL, ...args], { timeout: 4000 }, (err) => {
      inflight = null;
      if (redoRestore) {
        // restore() ran while this write was in the air; make sure the originals win.
        redoRestore = false;
        restore({ force: true });
      }
      if (err) reject(err);
      else resolve();
    });
  });
}

function queueImage(buf) {
  pending = buf;
  if (!working) work();
}

async function work() {
  working = true;
  try {
    while (pending) {
      const buf = pending;
      pending = null;
      const gen = generation;
      const file = SLOTS[slot];
      try {
        fs.writeFileSync(file, buf);
        const backup = ensureBackup();
        for (const { key } of backup.entries) {
          if (gen !== generation) break;
          await xfconfAsync(['-p', key, '-s', key.endsWith('/last-image') ? file : STYLE_ZOOMED]);
        }
        if (gen === generation) slot = 1 - slot;
      } catch (err) {
        console.error(`[wallpaper] per-song update failed: ${err.message}`);
      }
    }
  } finally {
    working = false;
  }
}

// Returns true if anything was restored. Partial failure keeps dirty:true so the
// next launch tries again.
// force: write the snapshot back even if it's already marked clean (used when a
// killed per-song write may have landed after the first restore).
function restore({ force = false } = {}) {
  generation++;
  pending = null;
  if (inflight) {
    inflight.kill();
    redoRestore = true; // in case the killed write still lands after ours
  }
  const backup = readBackup();
  if (!backup || (!backup.dirty && !force)) return false;
  // Style first, so xfdesktop redraws the original image with its original style.
  const ordered = [...backup.entries].sort(
    (a, b) => Number(b.key.endsWith('/image-style')) - Number(a.key.endsWith('/image-style')),
  );
  const failed = [];
  for (const { key, value } of ordered) {
    try {
      xfconf(['-p', key, '-s', value]);
    } catch (err) {
      failed.push(`${key}: ${String(err.stderr || err.message).trim()}`);
    }
  }
  if (failed.length) {
    console.error(`[wallpaper] restore incomplete, will retry next launch:\n  ${failed.join('\n  ')}`);
    return false;
  }
  writeJsonAtomic(BACKUP_FILE, { ...backup, dirty: false, restoredAt: new Date().toISOString() });
  return true;
}

module.exports = { BACKUP_FILE, set, queueImage, restore, isDirty, listKeys };
