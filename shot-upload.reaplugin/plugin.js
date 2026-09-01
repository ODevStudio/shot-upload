/* shot-upload.reaplugin
 *
 * Uploads finished espresso shots to the user's Decent account at
 * decentespresso.com (POST support/api/shot_upload) through the authenticated
 * Decent proxy, reusing the account the user is already logged into. The proxy
 * attaches the account credentials in Dart and never exposes them to plugin JS;
 * the server verifies the account and that the captured machine's serial
 * belongs to it, then stores the shot.
 *
 * Opt-in: AutoUpload defaults to FALSE, so nothing is uploaded until the user
 * turns it on. (Beta stance. Post-beta, logging into the Decent account will
 * itself serve as opt-in consent and AutoUpload will default to true.)
 *
 * The upload binds to the exact persisted shot via the `shotStored` event (fired
 * with the shot id after persistence), so there is no timer/`/shots/latest`
 * race, and machine identity is captured at shot start.
 *
 * Contract: must define createPlugin(host) returning {id, version, onLoad,
 * onUnload, onEvent}.
 */

function createPlugin(host) {
  "use strict";

  const NS = "shot-upload.reaplugin";
  const VERSION = "0.2.2";
  const LOCAL_API_URL = "http://localhost:8080/api/v1";
  const UPLOAD_PATH = "support/api/shot_upload"; // exact allowlisted proxy write path
  // Web view of an uploaded shot in the user's Decent account. The server returns
  // the stored shot id; combined with the machine serial it addresses the shot on
  // decentespresso.com. e.g. .../espressomachine?view=chart&sn=6262&id=<id>
  const SHOT_VIEW_BASE = "https://decentespresso.com/support/espressomachine";
  const RECENT_MAX = 10; // keep links to the most recent N uploads
  const RETRIES = 3;
  const RETRY_DELAY_MS = 2000;
  const RECONCILE_PAGE_SIZE = 20;
  const RECONCILE_PAGE_LIMIT = 5;
  const RECONCILE_BATCH_SIZE = 5;
  const RECONCILE_PERIOD_MS = 5 * 60 * 1000;
  const RECONCILE_RETRY_MS = 60 * 1000;
  const RECONCILE_CONTINUE_MS = 30 * 1000;
  const SAFE_MACHINE_STATES = new Set(["idle", "schedIdle", "sleeping"]);

  let isUploading = false;
  let isReconciling = false;
  let pendingLiveShots = [];
  const remotelyPostedShotIds = new Set();
  const permanentlyRejectedShotIds = new Set();
  let reconcileTimerId = null;
  let reconciliationPausedForConsent = false;
  let unloaded = false;
  let decaidVersion = null;

  const state = {
    autoUpload: false, // opt-in; see header
    lengthThreshold: 5,
    lastUploadedShot: null,
    lastResult: null,
    lastUrl: null,
    recentUploads: [], // [{id, localId, sn, url, title, ts}], newest first, max RECENT_MAX
    reconcileOffset: 0,
    machineState: null,
  };

  function log(msg) { try { host.log(`[shot-upload] ${msg}`); } catch (e) {} }

  // Web URL for a shot the server stored, e.g.
  // https://decentespresso.com/support/espressomachine?view=chart&sn=6262&id=<id>
  function shotUrl(sn, id) {
    if (!sn || !id) return null;
    return `${SHOT_VIEW_BASE}?view=chart&sn=${encodeURIComponent(sn)}&id=${encodeURIComponent(id)}`;
  }

  // Prepend an upload to the recent list (dedup by shot id), cap at RECENT_MAX,
  // and persist it so the links survive a restart.
  function recordRecentUpload(entry) {
    state.recentUploads = [entry, ...state.recentUploads.filter((e) => e && e.id !== entry.id)].slice(0, RECENT_MAX);
    try { host.storage({ type: "write", key: "recentUploads", data: state.recentUploads }); } catch (e) {}
  }

  async function fetchLocal(path) {
    const res = await fetch(`${LOCAL_API_URL}${path}`);
    if (!res.ok) { log(`local ${path} -> ${res.status}`); return null; }
    return await res.json();
  }

  async function updateShotExtras(shotId, extras) {
    const res = await fetch(`${LOCAL_API_URL}/shots/${shotId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ annotations: { extras: extras } }),
    });
    if (!res || !res.ok) throw new Error(`mark ${shotId} -> HTTP ${res && res.status}`);
  }

  async function markUploaded(shotId) {
    try {
      await updateShotExtras(shotId, {
        uploaded_to_decent: Math.floor(Date.now() / 1000),
        decent_upload_rejected: null,
      });
    } catch (e) {
      log(`could not mark ${shotId} uploaded: ${e.message}`);
    }
  }

  async function markRejected(shotId, error) {
    try {
      await updateShotExtras(shotId, {
        decent_upload_rejected: {
          status: error.status,
          timestamp: Math.floor(Date.now() / 1000),
        },
      });
    } catch (e) {
      log(`could not mark ${shotId} rejected: ${e.message}`);
    }
  }

  // Decaid app version (for provenance), cached.
  async function getDecaidVersion() {
    if (decaidVersion) return decaidVersion;
    const info = await fetchLocal("/info");
    decaidVersion = (info && (info.version || info.fullVersion)) || "unknown";
    return decaidVersion;
  }

  // seconds between first and last measurement
  function shotDuration(shot) {
    const m = shot && shot.measurements;
    if (!m || m.length < 2) return 0;
    const t0 = Date.parse(m[0].machine.timestamp);
    const t1 = Date.parse(m[m.length - 1].machine.timestamp);
    return isNaN(t0) || isNaN(t1) ? 0 : (t1 - t0) / 1000;
  }

  function capturedMachine(shot) {
    const machine = shot && shot.workflow && shot.workflow.machine;
    if (!machine || !machine.serialNumber || /^mock/i.test(String(machine.serialNumber))) return null;
    return {
      serialNumber: String(machine.serialNumber),
      ...(machine.firmwareVersion ? { firmwareVersion: String(machine.firmwareVersion) } : {}),
      ...(machine.model ? { model: String(machine.model) } : {}),
    };
  }

  async function withMachine(shot, manualRetry) {
    const captured = shot && shot.workflow && shot.workflow.machine;
    let machine = capturedMachine(shot);
    if (captured && captured.serialNumber && !machine) return null;
    const hasProvenanceStatus = captured && Object.prototype.hasOwnProperty.call(captured, "provenanceStatus");
    if (hasProvenanceStatus) {
      if (captured.provenanceStatus === "captured" && !machine) return null;
      if (captured.provenanceStatus === "unavailable") {
        if (!manualRetry) return null;
        machine = null;
      } else if (captured.provenanceStatus !== "captured") {
        return null;
      }
    }
    if (!machine) {
      const current = await fetchLocal("/machine/info");
      if (!current || !current.serialNumber || /^mock/i.test(String(current.serialNumber))) return null;
      machine = {
        serialNumber: String(current.serialNumber),
        ...(current.version ? { firmwareVersion: String(current.version) } : {}),
        ...(current.model ? { model: String(current.model) } : {}),
      };
    }
    if (!machine) return null;
    return {
      ...shot,
      machine: machine,
      app: { name: "decaid", version: await getDecaidVersion(), sourceFormat: "decaid" },
      schemaVersion: 1,
    };
  }

  // POST the shot through the authenticated Decent proxy (reuses account login).
  async function postShot(shot, replace) {
    const body = JSON.stringify(shot);
    let lastErr = null;
    for (let i = 0; i < RETRIES; i++) {
      if (unloaded || ((isUploading || isReconciling) && !state.autoUpload)) {
        throw skipped("automatic upload stopped");
      }
      if (isReconciling && !reconciliationIsSafe()) {
        throw skipped("machine is active");
      }
      try {
        const res = await host.decentProxy(UPLOAD_PATH, {
          method: "POST",
          query: replace ? { replace: "1" } : {},
          body: body,
          contentType: "application/json",
        });
        const status = res && res.status;
        const text = (res && res.body) || "";
        if (status >= 200 && status < 300) {
          try { return JSON.parse(text); } catch (e) { return { ok: true }; }
        }
        const error = new Error(`HTTP ${status}: ${text}`);
        error.status = status;
        error.permanent = status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 408 && status !== 429;
        if (error.permanent) {
          throw error;
        }
        lastErr = error;
      } catch (e) {
        lastErr = e;
        if (e.code === "account_consent_denied") {
          e.consent = true;
          throw e;
        }
        if (e.permanent) throw e;
      }
      if (i < RETRIES - 1) await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (i + 1)));
    }
    throw lastErr || new Error("upload failed");
  }

  function extrasFor(shot) {
    return shot && shot.annotations && shot.annotations.extras || {};
  }

  function skipped(message) {
    const error = new Error(message);
    error.skipped = true;
    return error;
  }

  async function uploadShot(shotId, { manualRetry = false, replace = false } = {}) {
    if (!replace && remotelyPostedShotIds.has(shotId)) throw skipped(`shot ${shotId} already uploaded`);
    if (!manualRetry && permanentlyRejectedShotIds.has(shotId)) throw skipped(`shot ${shotId} was rejected`);
    const full = await fetchLocal(`/shots/${shotId}`);
    if (!full || !full.id) throw skipped(`shot ${shotId} not found`);

    const extras = extrasFor(full);
    if (!replace && extras.uploaded_to_decent) throw skipped(`shot ${shotId} already uploaded`);
    if (extras.decent_upload_rejected && !manualRetry) throw skipped(`shot ${shotId} was rejected`);
    if (extras.upload_skipped === "mock-device") throw skipped(`shot ${shotId} came from a mock device`);

    const dur = shotDuration(full);
    if (dur < state.lengthThreshold) {
      throw skipped(`shot too short (${dur.toFixed(1)}s < ${state.lengthThreshold}s)`);
    }

    const payload = await withMachine(full, manualRetry);
    if (!payload) throw skipped("no real machine serial available");

    let result;
    try {
      result = await postShot(payload, replace);
    } catch (e) {
      if (e.permanent) permanentlyRejectedShotIds.add(full.id);
      throw e;
    }
    remotelyPostedShotIds.add(full.id);
    await markUploaded(full.id);
    state.lastUploadedShot = full.id;
    state.lastResult = result;
    // Build the shot's web URL from the server's stored id + the machine serial,
    // record it in the recent list, and hand it back to the app via the event.
    const sn = payload.machine && payload.machine.serialNumber;
    const serverId = (result && result.id) || full.id;
    const url = shotUrl(sn, serverId);
    state.lastUrl = url;
    recordRecentUpload({
      id: serverId,
      localId: full.id,
      sn: sn || null,
      url: url,
      title: (full.workflow && full.workflow.profile && full.workflow.profile.title) || null,
      ts: Date.now(),
    });
    host.storage({ type: "write", key: "lastUploadedShot", data: full.id });
    host.emit("shotUploaded", { shotId: full.id, id: serverId, sn: sn || null, url: url, result: result, timestamp: Date.now() });
    return result;
  }

  function queueLiveShot(operation) {
    const queued = pendingLiveShots.find((item) => item.shotId === operation.shotId);
    pendingLiveShots = queued
      ? pendingLiveShots.map((item) => item.shotId === operation.shotId
        ? { shotId: item.shotId, replace: item.replace || operation.replace }
        : item)
      : [...pendingLiveShots, operation];
  }

  function takeLiveShot() {
    const operation = pendingLiveShots[0];
    pendingLiveShots = pendingLiveShots.slice(1);
    return operation;
  }

  async function uploadAutomatically(operation) {
    const { shotId, replace } = operation;
    if (!replace && shotId && shotId === state.lastUploadedShot) {
      log(`shot ${shotId} already uploaded`);
      return;
    }
    try {
      const r = await uploadShot(shotId, { replace });
      log(`uploaded ${shotId} -> ${r && r.profile_ref ? r.profile_ref : "ok"}`);
    } catch (e) {
      if (e.skipped) { log(`skipped ${shotId}: ${e.message}`); }
      else {
        if (e.permanent) {
          await markRejected(shotId, e);
        }
        log(`error uploading ${shotId}: ${e.message}`);
        host.emit("uploadError", { shotId: shotId, error: e.message, timestamp: Date.now() });
        if (e.consent) reconciliationPausedForConsent = true;
        else scheduleReconcile(RECONCILE_RETRY_MS);
      }
    }
  }

  async function autoUpload(shotId, replace = false) {
    if (!state.autoUpload || reconciliationPausedForConsent || unloaded) return;
    const operation = { shotId, replace };
    if (isUploading || isReconciling) {
      queueLiveShot(operation);
      return;
    }
    isUploading = true;
    try {
      await uploadAutomatically(operation);
    } finally {
      isUploading = false;
      const nextOperation = takeLiveShot();
      if (nextOperation) autoUpload(nextOperation.shotId, nextOperation.replace);
    }
  }

  function applySettings(settings) {
    if (!settings) return;
    // Opt-in: default OFF unless the user explicitly enabled it.
    state.autoUpload = settings.AutoUpload === true;
    state.lengthThreshold = settings.LengthThreshold !== undefined ? settings.LengthThreshold : 5;
  }

  function scheduleReconcile(delay) {
    if (!state.autoUpload || reconciliationPausedForConsent || unloaded) return;
    if (reconcileTimerId !== null) clearTimeout(reconcileTimerId);
    reconcileTimerId = setTimeout(() => {
      reconcileTimerId = null;
      reconcile();
    }, delay);
  }

  function currentMachineState(snapshot) {
    return snapshot && snapshot.state && snapshot.state.state || null;
  }

  function reconciliationIsSafe() {
    return SAFE_MACHINE_STATES.has(state.machineState);
  }

  async function confirmReconciliationIsSafe() {
    const snapshot = await fetchLocal("/machine/state");
    state.machineState = currentMachineState(snapshot);
    return reconciliationIsSafe();
  }

  function reconcileCandidate(shot) {
    const extras = extrasFor(shot);
    const captured = shot && shot.workflow && shot.workflow.machine;
    const hasProvenanceStatus = captured && Object.prototype.hasOwnProperty.call(captured, "provenanceStatus");
    return !remotelyPostedShotIds.has(shot.id) &&
      !permanentlyRejectedShotIds.has(shot.id) &&
      !extras.uploaded_to_decent &&
      !extras.decent_upload_rejected &&
      extras.upload_skipped !== "mock-device" &&
      (hasProvenanceStatus
        ? captured.provenanceStatus === "captured" && capturedMachine(shot) !== null
        : !captured || !captured.serialNumber || capturedMachine(shot) !== null);
  }

  function setReconcileOffset(offset) {
    state.reconcileOffset = offset;
    host.storage({ type: "write", key: "reconcileOffset", data: offset });
  }

  async function reconcile() {
    if (!state.autoUpload || reconciliationPausedForConsent || unloaded) return;
    if (isUploading || isReconciling) {
      scheduleReconcile(RECONCILE_RETRY_MS);
      return;
    }
    isReconciling = true;
    let nextDelay = RECONCILE_PERIOD_MS;
    try {
      if (!await confirmReconciliationIsSafe()) return;
      let pages = 0;
      let attempts = 0;
      while (pages < RECONCILE_PAGE_LIMIT && attempts < RECONCILE_BATCH_SIZE && state.autoUpload && !reconciliationPausedForConsent && !unloaded && reconciliationIsSafe()) {
        const page = await fetchLocal(`/shots?limit=${RECONCILE_PAGE_SIZE}&offset=${state.reconcileOffset}&order=desc`);
        if (!page || !Array.isArray(page.items)) throw new Error("could not list local shots");
        if (page.items.length === 0 || state.reconcileOffset >= page.total) {
          setReconcileOffset(0);
          break;
        }
        let scanned = 0;
        for (const shot of page.items) {
          if (!state.autoUpload || reconciliationPausedForConsent || unloaded || !reconciliationIsSafe() || attempts >= RECONCILE_BATCH_SIZE) break;
          while (pendingLiveShots.length > 0 && attempts < RECONCILE_BATCH_SIZE && !reconciliationPausedForConsent) {
            await uploadAutomatically(takeLiveShot());
            attempts++;
          }
          if (reconciliationPausedForConsent || attempts >= RECONCILE_BATCH_SIZE) break;
          scanned++;
          if (!reconcileCandidate(shot)) continue;
          try {
            await uploadShot(shot.id);
            attempts++;
          } catch (e) {
            if (e.skipped) continue;
            if (!e.permanent) throw e;
            await markRejected(shot.id, e);
            attempts++;
            log(`shot ${shot.id} rejected: ${e.message}`);
          }
        }
        setReconcileOffset(state.reconcileOffset + scanned);
        pages++;
        if (state.reconcileOffset >= page.total) {
          setReconcileOffset(0);
          break;
        }
      }
      if (attempts >= RECONCILE_BATCH_SIZE) nextDelay = RECONCILE_CONTINUE_MS;
    } catch (e) {
      log(`reconciliation paused: ${e.message}`);
      if (e.consent) reconciliationPausedForConsent = true;
      nextDelay = e.consent ? null : RECONCILE_RETRY_MS;
    } finally {
      isReconciling = false;
      const nextOperation = reconciliationPausedForConsent ? null : takeLiveShot();
      if (nextOperation) {
        autoUpload(nextOperation.shotId, nextOperation.replace);
        scheduleReconcile(RECONCILE_CONTINUE_MS);
      } else if (nextDelay !== null) {
        scheduleReconcile(nextDelay);
      }
    }
  }

  function jsonResponse(status, obj) {
    return { status: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
  }

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function isUploaderBookkeepingPatch(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return false;
    if (Object.keys(patch).length !== 1 || !patch.annotations) return false;
    const annotations = patch.annotations;
    if (typeof annotations !== "object" || Array.isArray(annotations) || Object.keys(annotations).length !== 1 || !annotations.extras) return false;
    const extras = annotations.extras;
    if (typeof extras !== "object" || Array.isArray(extras)) return false;
    const keys = Object.keys(extras);
    return keys.length > 0 && keys.every((key) => key === "uploaded_to_decent" || key === "decent_upload_rejected");
  }

  // Human-readable page listing the most recent uploads, each linking to the shot
  // in the user's Decent account. Big tap targets — it may be shown on the DE1's
  // touchscreen.
  function recentShotsHtml() {
    const items = (state.recentUploads || []).map((s) => {
      let when = "";
      try { when = s.ts ? new Date(s.ts).toLocaleString() : ""; } catch (e) {}
      const label = escHtml(s.title || s.id || "shot");
      const meta = escHtml([s.sn ? "SN " + s.sn : "", when].filter(Boolean).join(" · "));
      return s.url
        ? `<li><a href="${escHtml(s.url)}">${label}</a><div class="meta">${meta}</div></li>`
        : `<li><span class="nourl">${label}</span><div class="meta">${meta}</div></li>`;
    }).join("");
    const list = items || '<li class="empty">No shots uploaded yet.</li>';
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Recent uploaded shots</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f7; color: #1c1c22; padding: 24px; }
  h1 { font-size: 1.6em; margin-bottom: 16px; }
  ul.shots { list-style: none; }
  ul.shots li { background: #fff; border-radius: 12px; padding: 20px 24px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  ul.shots a { font-size: 1.15em; font-weight: 600; color: #2f6bff; text-decoration: none; word-break: break-word; }
  ul.shots a:active { opacity: .6; }
  .meta { color: #6b6b76; font-size: .9em; margin-top: 6px; }
  .empty, .nourl { color: #6b6b76; }
  @media (prefers-color-scheme: dark) {
    body { background: #16161a; color: #e7e7ec; }
    ul.shots li { background: #23232a; box-shadow: none; }
    ul.shots a { color: #7aa2ff; }
    .meta, .empty, .nourl { color: #9a9aa5; }
  }
</style></head>
<body><h1>Recent uploaded shots</h1><ul class="shots">${list}</ul></body></html>`;
  }

  return {
    id: NS,
    version: VERSION,

    onLoad(settings) {
      unloaded = false;
      reconciliationPausedForConsent = false;
      applySettings(settings);
      // Storage reads are event-based: this triggers a `storageRead` event,
      // handled in onEvent, that restores lastUploadedShot.
      try { host.storage({ type: "read", key: "lastUploadedShot" }); } catch (e) {}
      try { host.storage({ type: "read", key: "reconcileOffset" }); } catch (e) {}
      try { host.storage({ type: "read", key: "recentUploads" }); } catch (e) {}
      log(`loaded (autoUpload ${state.autoUpload})`);
      scheduleReconcile(1000);
    },

    onUnload() {
      unloaded = true;
      if (reconcileTimerId !== null) clearTimeout(reconcileTimerId);
      reconcileTimerId = null;
      pendingLiveShots = [];
    },

    onEvent(event) {
      switch (event.name) {
        case "shotStored": {
          const id = event.payload && event.payload.id;
          if (id && state.autoUpload) autoUpload(id);
          break;
        }
        case "shotUpdated": {
          const payload = event.payload || {};
          // Marker PUTs emit shotUpdated too; only suppress patches exclusively owned by this uploader.
          if (payload.id && state.autoUpload && !isUploaderBookkeepingPatch(payload.patch)) {
            autoUpload(payload.id, true);
          }
          break;
        }
        case "storageRead":
          if (event.payload && event.payload.key === "lastUploadedShot") {
            state.lastUploadedShot = event.payload.value || null;
          }
          if (event.payload && event.payload.key === "reconcileOffset") {
            const offset = Number(event.payload.value);
            state.reconcileOffset = Number.isFinite(offset) && offset >= 0 ? Math.trunc(offset) : 0;
          }
          if (event.payload && event.payload.key === "recentUploads") {
            const v = event.payload.value;
            state.recentUploads = Array.isArray(v) ? v.slice(0, RECENT_MAX) : [];
          }
          break;
        case "stateUpdate": {
          const previousMachineState = state.machineState;
          state.machineState = currentMachineState(event.payload);
          if (state.machineState !== previousMachineState && reconciliationIsSafe()) {
            scheduleReconcile(0);
          }
          break;
        }
        case "settingsUpdated": {
          const wasEnabled = state.autoUpload;
          applySettings(event.payload);
          if (!state.autoUpload) {
            if (reconcileTimerId !== null) clearTimeout(reconcileTimerId);
            reconcileTimerId = null;
            pendingLiveShots = [];
          } else if (state.autoUpload) {
            if (!wasEnabled) {
              reconciliationPausedForConsent = false;
              setReconcileOffset(0);
            }
            scheduleReconcile(0);
          }
          break;
        }
      }
    },

    // Control endpoints. GET status; POST upload of the latest eligible shot.
    async __httpRequestHandler(request) {
      const endpoint = request && request.endpoint;
      if (endpoint === "status") {
        return jsonResponse(200, {
          autoUpload: state.autoUpload,
          lastUploaded: state.lastUploadedShot,
          lastResult: state.lastResult,
          lastUrl: state.lastUrl,
          recentUploads: state.recentUploads,
        });
      }
      // JSON list of the recent uploads with their links (for programmatic use).
      if (endpoint === "recent") {
        return jsonResponse(200, { ok: true, shots: state.recentUploads });
      }
      // Human-readable page listing the recent uploads as links.
      if (endpoint === "ui") {
        return {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
          body: recentShotsHtml(),
        };
      }
      if (endpoint === "upload") {
        try {
          const latest = await fetchLocal("/shots/latest");
          if (!latest || !latest.id) return jsonResponse(404, { ok: false, error: "no shot available" });
          const result = await uploadShot(latest.id, { manualRetry: true });
          return jsonResponse(200, { ok: true, id: latest.id, url: state.lastUrl, result: result });
        } catch (e) {
          if (e.skipped) return jsonResponse(200, { ok: false, skipped: true, error: e.message });
          return jsonResponse(502, { ok: false, error: e.message });
        }
      }
      return jsonResponse(404, { error: "unknown endpoint" });
    },
  };
}
