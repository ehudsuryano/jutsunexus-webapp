# JutsuNexus web app

JutsuNexus for any phone browser, made for iPhone users (there is no free way to put a native
app on other people's iPhones). The library is stored on the device in IndexedDB; nothing is
uploaded. Separate from `jutsunexus-viewer`, which stays a read-only viewer.

## What it does
- Library of groups and techniques: name, group, difficulty, type, position, description,
  steps, tags, notes, links, "Leads to" / "Comes from", favorites, cover image.
- Media: add photos/videos/PDFs from the phone, arrange order, use as cover, delete.
  Library thumbnail = cover, else the first video (as in the app).
- Study player: 1× / 0.5× / 0.25×, mirror, A-B loop, swipe between clips, "Play all videos".
- Import: JutsuNexus packages (.zip, format v1) from Files, or a public link (GitHub, Dropbox…);
  technique links (`#t1.…`). Google Drive can't be read by a web page — the screen explains the
  download-then-import route. "Send by link" (phone-to-phone) is Android-only.
- Share/backup: packages in the app's own format v1 (open in the Android app), with or without
  media; text-only technique links (same format as the app and viewer).
- Offline: a service worker caches the app; installable to the Home Screen.

## Layout
No build step — plain ES modules, served as static files.

    index.html  style.css  manifest.webmanifest  sw.js  logo.png  icons/  vendor/pako.min.js
    js/app.js        router + startup
    js/db.js         IndexedDB (rows + files); falls back to storing bytes where Blobs are refused
    js/library.js    in-memory library + mutations
    js/packages.js   import/export, matching the app's importManager.ts / exportManager.ts
    js/zip.js        ZIP reader (from the viewer) + STORE writer with CRC-32
    js/links.js      technique links (#t1.), byte-compatible with src/utils/techniqueLink.ts
    js/media.js      object URLs, video probing, thumbnails
    js/player.js     study player
    js/share.js      share/save packages, technique links
    js/views/*.js    screens
    js/strings/en.js strings (add he.js + register it in js/i18n.js for Hebrew)

## Releasing
Bump `VERSION` in `sw.js` (and `APP_VERSION` in `js/packages.js`) with every release, or phones
keep the old cached files. Add any new file to the `FILES` list in `sw.js`.

## Run locally
    python -m http.server 8765 --bind 127.0.0.1
then open http://127.0.0.1:8765/ (service workers need http://localhost or https).
