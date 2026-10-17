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

- **Co-editing:** everyone with the file open edits the same document live. The app orders
  everyone's edits (`/apps/wordcraft/collab/*`, tables `wordcraft_sessions`, `wordcraft_ops`,
  `wordcraft_members`); WordLogic in each browser merges them. The member with the lowest client
  id saves the shared document to the file every 20 edits or 30 seconds, and on Save. A file
  changed outside the session (another app, a sync client) ends it: reload to pick the change up.
  Imports (.doc, .dot) open for one person at a time, since the shared document couldn't be saved
  back into them.
- **State snapshots:** each save for the session (a checkpoint) also stores WordLogic's snapshot
  of the shared document at that point: reading the saved .docx back doesn't reproduce the
  document's internal ids (parts, comments, lists) exactly, and everyone's edits refer to them.
  People who join later start from the snapshot. Snapshots are app data
  (`appdata_<instance>/wordcraft/collab/<session>/<log position>.json`), the latest checkpoint's
  only; a background job removes sessions idle for a day (everything saved) or a month, with their
  snapshots. A snapshot can be tens of MB (pictures travel inside it), so the checkpoint request
  is too: allow request bodies of at least 48 MB (PHP `post_max_size` and `upload_max_filesize`,
  and any proxy limit such as nginx `client_max_body_size`). The official Nextcloud Docker image
  allows 512 MB or more. A snapshot over 32 MB isn't kept: people joining from that save start from the file.
- **Presence:** everyone's caret and selection show in the document in their colour with their
  name, and a strip above the editor lists who's editing (positions travel with each poll and are
  kept in `wordcraft_members.selection`; the server doesn't read them).
- **Undo:** Undo and Redo take back a person's own edits only, never someone else's later change.
- **View-only access:** someone who can read but not write the file follows the others live; an
  edit they try is taken back with a message (and the server refuses it too). Only members who
  can edit save the shared document, and the server records a checkpoint only from them, and only
  for the save the file actually holds (its ETag).

Not yet: sharing, shared links, file locking (`files_lock`), Save As into another folder.

## Protocol

The page talks to WordLogic with `postMessage` on the Nextcloud origin; every message is a plain
object whose `type` starts with `wordcraft:`. The shapes are GridLogic's
(`gridcraft/packaging/web/README.md`), except where noted.

| Message | Direction | Fields |
|---|---|---|
| `wordcraft:ready` | to the page | `version`; `ack` (true with `&ack=1`); `collab` (true: this build can co-edit) |
| `wordcraft:open` | from the page | `name`, `bytes` (`ArrayBuffer`) |
| `wordcraft:save` | to the page | `name`, `bytes`, `id`: Save, Save As and Export (PDF). While co-editing, the opened file's own name writes a checkpoint instead. |
| `wordcraft:saved` / `wordcraft:saveFailed` | from the page | `id`; `name` / `error` |
| `wordcraft:dirty` | to the page | `dirty` |
| `wordcraft:failed` | to the page | `error` |
| `wordcraft:collab:start` | from the page | `client` (also as `clientId`), `seq`, `readOnly`, `user` (this person's name), `color` (theirs, `#rrggbb`), and `state` when the session keeps a snapshot for `seq`: the shared document, which WordLogic takes instead of the file just opened. Sent right after `wordcraft:open`. (GridLogic: `json`, the sheet ids.) |
| `wordcraft:collab:entries` | from the page | `json`: log entries `[{seq, client, client_seq, base, op}]` |
| `wordcraft:collab:op` | to the page | `json`: `{client, client_seq, base, op}` |
| `wordcraft:collab:checkpoint` | from the page | `id` |
| `wordcraft:collab:checkpointData` | to the page | `id`, `seq`, `name`, `bytes` (the document in the opened file's format), `state` (text: WordLogic's snapshot of the document at `seq`; GridLogic: `sheetIds`) |
| `wordcraft:collab:selection` | to the page | `json`: this person's position (a JSON object, such as caret and selection), whenever it changes |
| `wordcraft:collab:presence` | from the page | `json`: the others, `[{...their position as their WordLogic sent it, client, name, color}]` |
| `wordcraft:collab:stop` | from the page | ends sharing |
| `wordcraft:collab:error` | to the page | `error`: rejoin |

The sequencer (`/apps/wordcraft/collab/*`, JSON, with Nextcloud's CSRF token or
`OCS-APIRequest: true`):

| Route | Does |
|---|---|
| `POST join {fileId, etag}` | `{sessionId, client, seq, hasState, entries, members, canEdit}`, or `{retry: true}` (load the file again) |
| `GET state ?sessionId&client&seq` | The state snapshot for `seq` (when `hasState`); 404 `{retry: true}` if a newer save replaced it |
| `POST push {sessionId, client, clientSeq, base, op}` | `{seq}` |
| `GET sync ?sessionId&client&since&sel` | `{entries, members, checkpointSeq, checkpointEtag}` |
| `POST checkpoint {sessionId, client, seq, etag, state}` | Records the save and keeps its snapshot |
| `POST leave {sessionId, client}` | |

## Layout

| Path | What |
|---|---|
| `appinfo/info.xml` | App manifest |
| `lib/` | `Application` (Files hook), `EditorController` (`/edit` page and its CSP), `CollabController` + `Service/CollabService` (the co-editing sequencer), `Service/SnapshotStore` (checkpoint snapshots), `BackgroundJob/CleanUpSessions`, `Migration/` (the tables), listener |
| `templates/editor.php`, `css/editor.css` | The editor page |
| `src/editor.js` | The host page: WebDAV load/save and the WordLogic postMessage bridge |
| `src/collab.js` | Co-editing: join, op push and polling, checkpoint saves |
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
docker exec -u www-data nextcloud-app-1 php occ app:enable wordcraft   # after an update: php occ upgrade
```

The web server must serve `.wasm` as `application/wasm` (Nextcloud's `.htaccess` and nginx
sample configs do).

## Licence

AGPL-3.0-or-later (the bundled `@nextcloud/*` libraries are AGPL/GPL). The WordLogic build in
`editor/` is MIT OR Apache-2.0.
