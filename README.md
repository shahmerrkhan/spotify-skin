# Spotify Skin

Fullscreen glass music dashboard for Linux Mint XFCE. It drives the Spotify desktop app.

Status: **Phase 1**. Window, tray, shortcut, show/hide, and wallpaper backup/restore. No Spotify connection yet.

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

Hide **destroys** the window. The app keeps running in the tray.

## Files on disk

- `~/.config/spotify-skin/config.json`: settings (`shortcut`, later the Spotify client ID and Last.fm key)
- `~/.config/spotify-skin/wallpaper-backup.json`: snapshot of every `/backdrop/**/last-image` and `image-style` key, taken before the first wallpaper change. `"dirty": true` means the app's wallpaper is currently applied.

## Wallpaper safety

The originals are restored on Hide, Quit, SIGTERM/SIGINT/SIGHUP, and system shutdown. If the app is killed while `dirty` is true, the next launch restores first. While dirty, the snapshot is never overwritten.

**Manual recovery** if you ever need it (prints the commands; review them, then run them):

```sh
node -e 'const b=require(process.env.HOME+"/.config/spotify-skin/wallpaper-backup.json"); for (const e of b.entries) console.log(`xfconf-query -c xfce4-desktop -p ${e.key} -s ${JSON.stringify(e.value)}`)'
```

## Icons

Source SVGs are in `assets/icons/` (24px grid, 1.75 stroke). The tray PNGs are generated with:

```sh
ffmpeg -y -width 22 -height 22 -i assets/icons/tray.svg -pix_fmt rgba assets/icons/tray.png
ffmpeg -y -width 44 -height 44 -i assets/icons/tray.svg -pix_fmt rgba assets/icons/tray@2x.png
```
