'use strict';
// "Recently played" for the queue panel (the last 50 songs; the panel scrolls).
// Tracks seen on this computer, newest first, saved in ~/.cache/spotify-skin/history.json.

const fs = require('node:fs');
const path = require('node:path');
const { CACHE_DIR, writeJsonAtomic } = require('./config');

const FILE = path.join(CACHE_DIR, 'history.json');
const MAX = 50;

let items = null;

function load() {
  if (items) return items;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    items = Array.isArray(raw) ? raw.filter((x) => x && typeof x.id === 'string').slice(0, MAX) : [];
  } catch {
    items = [];
  }
  return items;
}

function save() {
  try {
    writeJsonAtomic(FILE, items);
  } catch (err) {
    console.warn(`[history] save failed: ${err.message}`);
  }
}

// Moves the track to the front (or adds it). Ads and nameless tracks are skipped.
function push(track) {
  if (!track?.id || !track.title || track.id.includes('/ad/') || track.id.includes(':ad:')) return list();
  load();
  const prev = items.find((x) => x.id === track.id);
  items = [
    { id: track.id, title: track.title, artist: track.artist, art: prev?.art || null },
    ...items.filter((x) => x.id !== track.id),
  ].slice(0, MAX);
  save();
  return list();
}

function setArt(id, art) {
  load();
  const it = items.find((x) => x.id === id);
  if (!it || it.art === art) return list();
  it.art = art;
  save();
  return list();
}

function list() {
  return load().map((x) => ({ ...x }));
}

function artNames() {
  return load().map((x) => x.art).filter(Boolean);
}

module.exports = { push, setArt, list, artNames };
