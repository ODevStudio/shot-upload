# Decent shot upload plugin

`shot-upload.reaplugin` uploads eligible Decaid espresso shots to the signed-in user's Decent account. It keeps the live `shotStored` path and reconciles missed local shots while the machine is idle.

This repository is the plugin's source of truth. Decaid bundles a pinned, checksum-verified release and associates installed copies with this repository for later updates.

## Install

Download `shot-upload.reaplugin-vX.Y.Z.zip` from Releases and install it through Decaid's plugin settings, or install the repository's `main` branch through Decaid.

Automatic upload is off by default. Enable **Upload shots automatically** in the plugin settings to opt in.

## Upload pauses

Before uploading, the plugin checks the shot's original serial against
`support/api/sn?onlyespressomachines=1&withskus=1` through Decaid's authenticated
proxy. A missing serial or an upload HTTP 403 pauses that serial for the session;
other linked machines can keep uploading. Live, backlog, replacement, and manual
uploads share this guard. The plugin preserves paused shots without rewriting
their machine identity or marking them permanently rejected.

HTTP 401 pauses the account's uploads and asks the user to sign in again.
Machine-list outages or unexpected responses hold uploads with a one-minute
backoff, without claiming the machine is unlinked. Existing transient upload
retries and permanent document rejections, including HTTP 400, are unchanged.
Nonempty machine-list rows must include the SKU requested by `withskus=1`;
unexpected plain text is an outage, not an ownership determination.

Restarting refreshes ownership. Decaid's `decentAccountChanged` event also
invalidates the cache; uploads resume only after the new lookup confirms the
serial is linked. Restart is a check trigger, not a recovery prerequisite.
Serial pauses and their notification deduplication are reset on each account
generation, so a new account never inherits the previous account's notices.
Returning from the native Support action invalidates the uploader cache; its
own authenticated lookup/backoff determines recovery. Account changes during
an active request discard stale failures and trigger immediate reconciliation.
The plugin needs `proxy.decent_api`, `proxy.decent_api.write`, and `notifications`.
This version requires a Decaid host supporting the generic notification contract;
older hosts that reject unknown permissions cannot load its manifest.

Pending replacements scan at most five entries per pass, independently of the
upload budget, and continue from their previous position. Known paused shots do
not reload their full records until ownership is refreshed. Authentication pauses
stop both replacement and backlog scans immediately.

The status endpoint includes `pausedSerials` and `authenticationPaused`.
`uploadPaused` carries `{reason, serialNumber, message, timestamp}`, with reason
`unlinked_serial` or `authentication` and a null serial for authentication.
The plugin supplies the native notice through `host.notify`: `ownership` opens
its HTTPS Support URL, while `authentication` opens native account settings.
An outstanding ownership notice stays current when more serials pause, so an
active Support action is not retired by backlog scanning. A targeted
`notificationDismissed` for `ownership` acknowledges that notice without clearing
any upload pause. A different serial pausing for the first time then gets a fresh
Support notice; repeated shots from an already paused serial remain quiet.
Authentication replaces the ownership notice. Account changes clear only this
plugin's notices. A targeted
`notificationAction` with ID `ownership`, action
`support`, and phase `returned` triggers a fresh ownership check. Merely opening
the link, a failed launch, or an unrelated action cannot resume uploads.
Decaid renders these through its generic permissioned banner without interpreting
upload policy or clearing unrelated messages. The plugin's existing UI and
`uploadPaused` event also retain their pause information.

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
node --test test/*.test.js
```

The tests exercise the public plugin lifecycle and HTTP interfaces with an in-memory Decaid host.

## Release

1. Update `version` in `shot-upload.reaplugin/manifest.json`.
2. Update `VERSION` in `shot-upload.reaplugin/plugin.js` to the same value.
3. Commit and push the change.
4. Tag that commit as `vX.Y.Z` and push the tag.

GitHub Actions validates the committed versions, tests the plugin, packages the top-level `shot-upload.reaplugin/` directory, and publishes one ZIP release asset.

The committed version must never be lower than the latest release because Decaid also supports installing directly from `main`.
