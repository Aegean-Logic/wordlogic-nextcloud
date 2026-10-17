# editor/: the WordLogic web build

This folder holds the WordLogic web build that the app shows in its iframe
(`/apps/wordcraft/editor/index.html?host=parent&ack=1`). It isn't committed: only this README is.
Until it's here, the editor page says the editor isn't installed instead of opening the file.

The build comes from the WordLogic repository (`../wordcraft`): `apps/wordcraft-web`, built with
Trunk, as packaged by `packaging/web/package.sh`. It must include the host bridge for
`?host=parent` (the `wordcraft:` messages: ready/open/save/saved/saveFailed/dirty/failed,
co-editing, sharing and Open in Desktop App; see this app's README, "Protocol"). Builds without
it start, but never ask for the file.

## Vendoring

From this app's folder:

```sh
scripts/vendor-editor.sh                       # build ../wordcraft/apps/wordcraft-web with trunk, then copy it here
scripts/vendor-editor.sh ../wordcraft/dist/web # copy a site that's already built
scripts/vendor-editor.sh wordcraft-web-X.Y.Z.zip  # unpack a release zip (packaging/web/package.sh)
```

The script keeps this README, replaces everything else, drops the static-host samples
(`_headers`, `.htaccess`, `HOSTING.md`), and checks that `index.html` uses relative URLs and that
the build knows the bridge (`wordcraft:ready`). Set `WORDCRAFT=/path/to/wordcraft` if the
repository isn't next to this one. Building needs `trunk` (`cargo install trunk --locked`) and the
`wasm32-unknown-unknown` target.

After vendoring, bump the app version (`appinfo/info.xml`, `package.json`) so browsers fetch the
new `index.html` (its URL carries `?v=<app version>`), then deploy the app (README, "Install").

The files here are WordCraft's licence, MIT OR Apache-2.0.
