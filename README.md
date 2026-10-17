# WordLogic for Nextcloud

A minimal Nextcloud app (Nextcloud 32–34) that opens documents from Files in WordLogic (by
Aegean Logic, based on [WordCraft](https://github.com/storytold/wordcraft)) and saves them back.
It is the word processor beside [GridLogic for Nextcloud](../gridcraft-nextcloud), and works the
same way.

- **Files:** clicking a .docx, .docm, .dotx, .dotm, .odt, .rtf, .doc or .dot file opens it in
  WordLogic ("Open in WordLogic" in the file's menu). Text and Markdown files (.txt, .md) have
  "Open in WordLogic" in their menu; a click still opens them in Nextcloud's Text app.
- **Editor:** `/apps/wordcraft/edit?path=/Documents/Report.docx` shows WordLogic in an iframe on
  the Nextcloud origin (`?host=parent&ack=1`). The page reads the file over WebDAV with the
  user's session and writes back what WordLogic saves.
- **Conflicts:** saves send `If-Match` with the ETag the file had when it was opened (or last
  saved). If someone else changed it meanwhile, Nextcloud answers 412 and WordLogic tells the user
  instead of overwriting. A file the page didn't open or create is never overwritten
  (`If-None-Match: *`). Nextcloud keeps a version for every save.
- **Formats:** documents WordLogic's engine writes are saved back in their own format: .docx,
  .docm, .dotx, .dotm, .odt, .rtf, .txt and .md. Word 97–2003 files (.doc, .dot) are imports:
  saving one creates `<name>.docx` next to it and leaves the original untouched.

Not yet: co-editing, sharing, shared links, file locking (`files_lock`), Save As into another
folder.

## Layout

| Path | What |
|---|---|
| `appinfo/info.xml` | App manifest |
| `lib/` | `Application` (Files hook), `EditorController` (`/edit` page and its CSP), listener |
| `templates/editor.php`, `css/editor.css` | The editor page |
| `src/editor.js` | The host page: WebDAV load/save and the WordLogic postMessage bridge |
| `src/files.js` | The Files actions |
| `js/` | Bundles built from `src/` (`npm run build`) |
| `editor/` | The WordLogic web build, vendored by `scripts/vendor-editor.sh` (`editor/README.md`) |
| `img/` | App icons (placeholders until the WordLogic icon is drawn) |

## Build

```sh
npm install
npm run build
scripts/vendor-editor.sh   # the WordLogic web build from ../wordcraft into editor/
```

## Install (Docker)

Copy the app without `node_modules/`, `src/` and `.git/`:

```sh
docker exec nextcloud-app-1 mkdir -p /var/www/html/custom_apps/wordcraft
for d in appinfo css editor img js lib templates README.md; do docker cp "$d" nextcloud-app-1:/var/www/html/custom_apps/wordcraft/; done
docker exec nextcloud-app-1 chown -R www-data:www-data /var/www/html/custom_apps/wordcraft
docker exec -u www-data nextcloud-app-1 php occ app:enable wordcraft
```

The web server must serve `.wasm` as `application/wasm` (Nextcloud's `.htaccess` and nginx
sample configs do).

## Licence

AGPL-3.0-or-later (the bundled `@nextcloud/*` libraries are AGPL/GPL). The WordLogic build in
`editor/` is MIT OR Apache-2.0.
