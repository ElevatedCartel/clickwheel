# ClickWheel (web version)

An iPod classic with a click wheel that you add to your iPhone home screen from Safari. It needs no Xcode, no App Store and no Apple developer account. It's ten static files with no outside code, no analytics and no server.

## Put it on your phone

You need to host this folder at your own HTTPS address. Both options below are free.

**Option A: Cloudflare Pages (drag and drop)**
1. Make a free Cloudflare account, then go to Workers & Pages → Create → Pages → **Upload assets**.
2. Name the project, drag in the contents of this `web` folder, and deploy.
3. You get an address like `https://your-name.pages.dev`.

**Option B: GitHub Pages**
1. Make a new repository and upload the contents of this `web` folder with Add file → Upload files.
2. Go to Settings → Pages → Deploy from a branch → `main` / root.
3. You get an address like `https://your-username.github.io/repo-name/`. The code is public, but none of your music or data ever goes there.

**Then, on the iPhone:**
1. Open the address in Safari.
2. Tap Share → **Add to Home Screen**.
3. Always open it from the home-screen icon. Installed web apps get longer-lasting storage and run full screen.
4. Tap **Import Songs** and pick music from the Files app (On My iPhone, iCloud Drive, Downloads…).

## Updating it

Edit the files, change `VERSION` in `sw.js` (for example `clickwheel-v2`), and upload again. Your phone picks up the new version the second time you open the app after the upload.

## Controls

| Gesture | Lists | Now Playing |
|---|---|---|
| Circle the ring | Scroll. It speeds up on long lists and shows a big index letter. | Scrub through the song. On a computer it changes the volume instead; center-click switches to scrubbing. |
| Center click | Select | — |
| Hold center | Song options: Play Next, Add to Playlist, Go to Album/Artist, Delete | Options for this song |
| MENU | Back | Back |
| ⏮ / ⏭ tap | Previous / next | Previous / next |
| ⏮ / ⏭ hold | Rewind / fast-forward | Rewind / fast-forward |
| ⏯ | Play / pause | Play / pause |

You can also tap rows on the screen directly. On a computer, the arrow keys, Enter, Esc and Space work, and so does the trackpad over the wheel.

**Playlists:** Playlists → New Playlist… → name it → check songs.
Inside a playlist, **Edit Playlist** has Add Songs, Remove Songs, Rename and Delete. It also has **Reorder Songs**: center-click a song to pick it up, turn the wheel to move it, and center-click to drop it.

## Limits of a web app on iPhone

- **Volume:** iOS doesn't let web pages set volume, so use the phone's side buttons. On the phone, the wheel scrubs through the song on Now Playing.
- **Haptics:** a wheel-tick tap uses a Safari 18 trick and may not work on every iOS version. The click sound always works, though the ringer switch silences it.
- **Your library lives inside the app.** iOS can clear a web app's storage if the phone runs critically low on space. Your original files stay where they were in Files, so you can re-import them. Use **Settings → Back Up Playlists** now and then; **Restore Playlists** matches songs by title and artist.
- **No folder import:** pick multiple files instead. In the iPhone file picker, tap Select, then select all.

## Files

- `index.html`, `app.css`: the device and its screen
- `app.js`: menus, wheel input, player, playlists
- `tags.js`: reads song info and cover art from MP3, M4A and FLAC files
- `db.js`: on-device storage (IndexedDB)
- `sw.js`: offline caching of the app's own files
- `manifest.webmanifest`, `icon-*.png`: home-screen install
