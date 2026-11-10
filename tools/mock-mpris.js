#!/usr/bin/env node
'use strict';
// Dev tool: a fake Spotify on the session bus (org.mpris.MediaPlayer2.spotify),
// so the skin can be tested without touching your real Spotify or its history.
// Only works while the real Spotify is closed (they'd fight over the bus name).
// Its covers are file:// URLs, which the skin only accepts with --dev.
//
//   node tools/mock-mpris.js [--dir <images>] [--auto <ms>] [--count <n>] [--quit-after] [--window] [--ignore-sets]
//
// --ignore-sets: accept Shuffle/LoopStatus writes but don't apply them (and say
// nothing), like a Spotify build that ignores them; the skin should grey the button.
// Signals act like changing it in Spotify's own window (announced to the skin):
//   kill -USR1 <pid>  cycles repeat     kill -USR2 <pid>  toggles shuffle
//
// --window opens a stand-in "Spotify window" (xmessage, instance name "spotify") so
// the skin's hide-Spotify's-window logic can be tested; it closes when the mock exits.
//
// Keys while running: n next, b previous, p play/pause, s shuffle, q quit (= "Spotify closed").

const fs = require('node:fs');
const path = require('node:path');
const dbus = require('dbus-next');

const { Interface, ACCESS_READ, ACCESS_READWRITE } = dbus.interface;
const { Variant } = dbus;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const DIR = arg('dir', '/usr/share/xfce4/backdrops');
const AUTO_MS = Number(arg('auto', 0));
const COUNT = Number(arg('count', 0));
const QUIT_AFTER = process.argv.includes('--quit-after');
const WINDOW = process.argv.includes('--window');
const IGNORE_SETS = process.argv.includes('--ignore-sets');

const TITLES = [
  ['Love Me', 'Lil Tecca'], ['Lucid Dreams', 'Juice WRLD'], ['Ransom', 'Lil Tecca'],
  ['Empty Out Your Pockets (Bonus Track Version)', 'Juice WRLD'], ['Party Girl', 'StaySolidRocky'],
  ['Calling My Phone', 'Lil Tjay, 6LACK'], ['Señorita, Pt. II (Live in Bogotá)', 'Various Artists'],
  ['Moonlight', 'XXXTENTACION'], ['Our Time', 'Lil Tecca'], ['Blueberry Faygo', 'Lil Mosey'],
  ['Wishing Well', 'Juice WRLD'], ['All Girls Are The Same', 'Juice WRLD'],
];

const images = fs.readdirSync(DIR).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort().map((f) => path.join(DIR, f));
if (!images.length) {
  console.error(`No .jpg/.png images in ${DIR}`);
  process.exit(1);
}

let index = 0;
let status = 'Playing';
let shuffle = false;
let loop = 'None';
let posMs = 0;
let posAt = Date.now();

const track = () => {
  const [title, artist] = TITLES[index % TITLES.length];
  return { title, artist, art: images[index % images.length], lengthMs: 150_000 + (index % 5) * 23_000 };
};
const position = () => (status === 'Playing' ? posMs + Date.now() - posAt : posMs);
function metadata() {
  const t = track();
  return {
    'mpris:trackid': new Variant('o', `/com/spotify/track/mock${index}`),
    'mpris:length': new Variant('t', BigInt(t.lengthMs * 1000)),
    'mpris:artUrl': new Variant('s', `file://${encodeURI(t.art)}`),
    'xesam:title': new Variant('s', t.title),
    'xesam:artist': new Variant('as', [t.artist]),
    'xesam:album': new Variant('s', 'Mock Album'),
    'xesam:url': new Variant('s', `https://open.spotify.com/track/mock${index}`),
  };
}

class MediaPlayer2 extends Interface {
  get Identity() { return 'Spotify (mock)'; }
  get CanQuit() { return true; }
  get CanRaise() { return false; }
  get HasTrackList() { return false; }
  Raise() {}
  Quit() { process.exit(0); }
}
MediaPlayer2.configureMembers({
  properties: {
    Identity: { signature: 's', access: ACCESS_READ },
    CanQuit: { signature: 'b', access: ACCESS_READ },
    CanRaise: { signature: 'b', access: ACCESS_READ },
    HasTrackList: { signature: 'b', access: ACCESS_READ },
  },
  methods: { Raise: {}, Quit: {} },
});

class Player extends Interface {
  get PlaybackStatus() { return status; }
  get Metadata() { return metadata(); }
  get Position() { return BigInt(Math.round(position() * 1000)); }
  get Shuffle() { return shuffle; }
  set Shuffle(v) {
    if (IGNORE_SETS) return console.log(`[mock] ignored Shuffle=${v}`);
    shuffle = Boolean(v);
    Interface.emitPropertiesChanged(this, { Shuffle: shuffle }, []);
    console.log(`[mock] shuffle ${shuffle}`);
  }
  get LoopStatus() { return loop; }
  set LoopStatus(v) {
    if (!['None', 'Playlist', 'Track'].includes(v)) return;
    if (IGNORE_SETS) return console.log(`[mock] ignored LoopStatus=${v}`);
    loop = v;
    Interface.emitPropertiesChanged(this, { LoopStatus: loop }, []);
    console.log(`[mock] repeat ${loop}`);
  }
  get Rate() { return 1; }
  get CanGoNext() { return true; }
  get CanGoPrevious() { return true; }
  get CanPlay() { return true; }
  get CanPause() { return true; }
  get CanSeek() { return true; }
  get CanControl() { return true; }
  Play() { setStatus('Playing'); }
  Pause() { setStatus('Paused'); }
  PlayPause() { setStatus(status === 'Playing' ? 'Paused' : 'Playing'); }
  Next() { go(1); }
  Previous() { go(-1); }
  OpenUri() {}
  SetPosition(_id, us) { posMs = Number(us) / 1000; posAt = Date.now(); this.Seeked(BigInt(us)); }
  Seek(us) { posMs = Math.max(0, position() + Number(us) / 1000); posAt = Date.now(); this.Seeked(BigInt(Math.round(posMs * 1000))); }
  Seeked(us) { return us; }
}
Player.configureMembers({
  properties: {
    PlaybackStatus: { signature: 's', access: ACCESS_READ },
    Metadata: { signature: 'a{sv}', access: ACCESS_READ },
    Position: { signature: 'x', access: ACCESS_READ },
    Shuffle: { signature: 'b', access: ACCESS_READWRITE },
    LoopStatus: { signature: 's', access: ACCESS_READWRITE },
    Rate: { signature: 'd', access: ACCESS_READ },
    CanGoNext: { signature: 'b', access: ACCESS_READ },
    CanGoPrevious: { signature: 'b', access: ACCESS_READ },
    CanPlay: { signature: 'b', access: ACCESS_READ },
    CanPause: { signature: 'b', access: ACCESS_READ },
    CanSeek: { signature: 'b', access: ACCESS_READ },
    CanControl: { signature: 'b', access: ACCESS_READ },
  },
  methods: {
    Play: {}, Pause: {}, PlayPause: {}, Next: {}, Previous: {},
    OpenUri: { inSignature: 's' },
    SetPosition: { inSignature: 'ox' },
    Seek: { inSignature: 'x' },
  },
  signals: { Seeked: { signature: 'x' } },
});

const player = new Player('org.mpris.MediaPlayer2.Player');

// "Changed in Spotify's own window": applied even with --ignore-sets, and announced.
process.on('SIGUSR1', () => {
  loop = { None: 'Playlist', Playlist: 'Track', Track: 'None' }[loop];
  Interface.emitPropertiesChanged(player, { LoopStatus: loop }, []);
  console.log(`[mock] repeat changed by Spotify itself: ${loop}`);
});
process.on('SIGUSR2', () => {
  shuffle = !shuffle;
  Interface.emitPropertiesChanged(player, { Shuffle: shuffle }, []);
  console.log(`[mock] shuffle changed by Spotify itself: ${shuffle}`);
});

function setStatus(s) {
  posMs = position();
  posAt = Date.now();
  status = s;
  Interface.emitPropertiesChanged(player, { PlaybackStatus: status }, []);
  console.log(`[mock] ${status}`);
}

let changes = 0;
function go(step) {
  index = (index + step + TITLES.length * images.length) % (TITLES.length * images.length);
  posMs = 0;
  posAt = Date.now();
  changes++;
  Interface.emitPropertiesChanged(player, { Metadata: metadata() }, []);
  console.log(`[mock] #${changes} ${track().title} (${path.basename(track().art)})`);
}

(async () => {
  const bus = dbus.sessionBus();
  bus.export('/org/mpris/MediaPlayer2', new MediaPlayer2('org.mpris.MediaPlayer2'));
  bus.export('/org/mpris/MediaPlayer2', player);
  const res = await bus.requestName('org.mpris.MediaPlayer2.spotify', dbus.NameFlag.DO_NOT_QUEUE);
  if (res !== dbus.RequestNameReply.PRIMARY_OWNER) {
    console.error('[mock] org.mpris.MediaPlayer2.spotify is taken (is the real Spotify running?)');
    process.exit(1);
  }
  console.log(`[mock] playing; ${images.length} covers from ${DIR}. Keys: n b p s q`);

  if (WINDOW) {
    const { spawn } = require('node:child_process');
    const win = spawn('xmessage', ['-name', 'spotify', '-geometry', '640x360+200+200', 'Mock Spotify window'], { stdio: 'ignore' });
    win.on('error', (err) => console.error(`[mock] no stand-in window: ${err.message}`));
    process.on('exit', () => win.kill());
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
  }

  if (AUTO_MS > 0) {
    const timer = setInterval(() => {
      go(1);
      if (COUNT && changes >= COUNT) {
        clearInterval(timer);
        console.log(`[mock] done: ${changes} song changes`);
        if (QUIT_AFTER) process.exit(0);
      }
    }, AUTO_MS);
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.on('data', (b) => {
      const k = b.toString();
      if (k === 'n') go(1);
      else if (k === 'b') go(-1);
      else if (k === 'p') player.PlayPause();
      else if (k === 's') player.Shuffle = !shuffle;
      else if (k === 'q' || k === '\u0003') process.exit(0);
    });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
