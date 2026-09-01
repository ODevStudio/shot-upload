# Decent shot upload plugin

`shot-upload.reaplugin` uploads eligible Decaid espresso shots to the signed-in user's Decent account. It keeps the live `shotStored` path and reconciles missed local shots while the machine is idle.

This repository is the plugin's source of truth. Decaid bundles a pinned, checksum-verified release and associates installed copies with this repository for later updates.

## Install

Download `shot-upload.reaplugin-vX.Y.Z.zip` from Releases and install it through Decaid's plugin settings, or install the repository's `main` branch through Decaid.

Automatic upload is off by default. Enable **Upload shots automatically** in the plugin settings to opt in.

## Links to uploaded shots

After a shot uploads, the plugin records a link to view it in the user's Decent
account — `https://decentespresso.com/support/espressomachine?view=chart&sn=<serial>&id=<id>`
(built from the machine serial and the shot id the server returns). The most
recent 10 links are kept and exposed through the plugin's HTTP endpoints:

- `GET /api/v1/plugins/shot-upload.reaplugin/status` — includes `lastUrl` and `recentUploads`.
- `GET /api/v1/plugins/shot-upload.reaplugin/recent` — JSON `{ok, shots:[{id, sn, url, title, ts}]}`.
- `GET /api/v1/plugins/shot-upload.reaplugin/ui` — an HTML page listing the recent uploads as links.

The `shotUploaded` event also carries `{id, sn, url}` for the just-uploaded shot.

## Development

The distributable source is plain JavaScript and JSON under `shot-upload.reaplugin/`. It has no build step or package dependencies.

```bash
node --check shot-upload.reaplugin/plugin.js
node --test test/plugin.test.js
```

The tests exercise the public plugin lifecycle and HTTP interfaces with an in-memory Decaid host.

## Release

1. Update `version` in `shot-upload.reaplugin/manifest.json`.
2. Update `VERSION` in `shot-upload.reaplugin/plugin.js` to the same value.
3. Commit and push the change.
4. Tag that commit as `vX.Y.Z` and push the tag.

GitHub Actions validates the committed versions, tests the plugin, packages the top-level `shot-upload.reaplugin/` directory, and publishes one ZIP release asset.

The committed version must never be lower than the latest release because Decaid also supports installing directly from `main`.
