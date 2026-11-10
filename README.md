# Spotify Skin

Fullscreen glass music dashboard for Linux Mint XFCE. It drives the Spotify desktop app.

Status: **Phase 2b**. Single-screen core: now playing and controls over MPRIS, album-art background and wallpaper, idle clock, spinning record, tilted "Recently played" panel, edge glow, display options. Multi-screen and CJK fonts are phase 2c.

## How it sits on the desktop

By default (`"layer": "desktop"`) the skin is an X11 desktop-type window: behind every app, on all workspaces, out of the taskbar and Alt+Tab, with the XFCE panel on top. Apps like Opera stay fully usable above it, and wherever it shows, it takes clicks. `"layer": "overlay"` brings back the phase 1 fullscreen window on top of everything.

## States

| State | When | What you see |
|---|---|---|
| Playing | Spotify is playing | Clock top right, panels, spinning record, title bottom left and in the dock |
| Idle | Spotify paused, stopped or closed | Clock moves to the centre, bigger; panels fade (the mouse brings them back) |
| Minimal | No mouse movement for `minimalAfterSec` (30 s) | Only art, title and clock; any mouse movement brings the panels back |
| Spotify closed | Spotify quits | "Spotify isn't open" card; your normal wallpaper is restored at once |
| Paused animations | Screen locked, screensaver on, asleep, or other windows fully cover the skin | Everything stops moving |

## Run

```sh
npm install
npm start        # normal
npm run start:dev  # opens DevTools and adds Dev items to the tray menu
```

## Controls

| Action | How |
|---|---|
| Hide / show | `Ctrl+Alt+M`, the tray icon (left click or menu), the **Hide** pill, or `Esc` (hide only) |
| Quit | Tray menu → Quit |
| Second launch | Toggles the running instance instead of starting a new one |
| Play/pause, previous, next, shuffle | The dock. Repeat is shown but disabled until a later phase |
| Seek | Click the progress bar, or focus it and use the arrow keys (5 s steps) |
| Display options | The **Aa** pill: reduce motion, larger text, higher contrast (saved to config) |

Hide **destroys** the window. The app keeps running in the tray.

## Files on disk

- `~/.config/spotify-skin/config.json`: settings: `shortcut`, `layer` (`desktop` or `overlay`), `minimalAfterSec`, `clock24h`, `setRealWallpaper`, `a11y` (written by the Aa menu); later the Spotify client ID and Last.fm key
- `~/.cache/spotify-skin/art/`: cover art from Spotify's CDN plus thumbnails (30 newest kept)
- `~/.cache/spotify-skin/history.json`: "Recently played" on this computer (12 newest)
- `~/.cache/spotify-skin/wall-a.jpg`, `wall-b.jpg`: the rendered background, used as the real wallpaper (two names because xfdesktop ignores a rewrite of the path it already shows)
- `~/.config/spotify-skin/wallpaper-backup.json`: snapshot of every `/backdrop/**/last-image` and `image-style` key, taken before the first wallpaper change. `"dirty": true` means the app's wallpaper is currently applied.

## Wallpaper safety

The originals are restored on Hide, when Spotify quits, on Quit, SIGTERM/SIGINT/SIGHUP, and system shutdown. If the app is killed while `dirty` is true, the next launch restores first. While dirty, the snapshot is never overwritten.

**Manual recovery** if you ever need it (prints the commands; review them, then run them):

```sh
node -e 'const b=require(process.env.HOME+"/.config/spotify-skin/wallpaper-backup.json"); for (const e of b.entries) console.log(`xfconf-query -c xfce4-desktop -p ${e.key} -s ${JSON.stringify(e.value)}`)'
```

## Testing without your real Spotify (dev)

`tools/mock-mpris.js` is a fake Spotify for testing. It needs the real Spotify closed, or a private bus:

```sh
dbus-daemon --session --fork --print-address=1 --address=unix:dir=/tmp   # prints ADDR
DBUS_SESSION_BUS_ADDRESS=ADDR node tools/mock-mpris.js --dir /usr/share/xfce4/backdrops
SKIN_MPRIS_BUS=ADDR npm run start:dev -- --no-devtools
```

In `--dev`, `kill -USR2 <electron pid>` saves a screenshot to `~/.cache/spotify-skin/dev-capture.png` and logs memory per process.

## Icons

Source SVGs are in `assets/icons/` (24px grid, 1.75 stroke). The tray PNGs are generated with:

```sh
ffmpeg -y -width 22 -height 22 -i assets/icons/tray.svg -pix_fmt rgba assets/icons/tray.png
ffmpeg -y -width 44 -height 44 -i assets/icons/tray.svg -pix_fmt rgba assets/icons/tray@2x.png
```
