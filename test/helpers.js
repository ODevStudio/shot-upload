const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const pluginPath = path.join(__dirname, "..", "shot-upload.reaplugin", "plugin.js");

function shot(
  id,
  {
    serialNumber = "6262",
    provenanceStatus = "captured",
    capturedMachine = true,
    uploaded = false,
    uploadedAt,
    rejected = false,
    rejectedRevision,
    mockDeviceSkipped = false,
    espressoNotes,
    updatedAt,
  } = {},
) {
  return {
    id,
    ...(updatedAt ? { updatedAt } : {}),
    annotations: {
      ...(espressoNotes ? { espressoNotes } : {}),
      extras: {
        ...(uploaded ? { uploaded_to_decent: uploadedAt ?? 1 } : {}),
        ...(rejected
          ? {
              decent_upload_rejected: {
                status: 422,
                timestamp: 1,
                ...(rejectedRevision ? { updatedAt: rejectedRevision } : {}),
              },
            }
          : {}),
        ...(mockDeviceSkipped ? { upload_skipped: "mock-device" } : {}),
      },
    },
    workflow: {
      profile: { title: "Test", steps: [] },
      context: {},
      ...(capturedMachine
        ? {
            machine: {
              provenanceStatus,
              ...(serialNumber
                ? {
                    serialNumber,
                    model: "DE1Pro",
                    firmwareVersion: "1352",
                  }
                : {}),
            },
          }
        : {}),
    },
    measurements: [
      { machine: { timestamp: "2026-01-01T00:00:00Z" } },
      { machine: { timestamp: "2026-01-01T00:00:30Z" } },
    ],
  };
}

async function pump() {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function loadPlugin({
  settings = { AutoUpload: true, LengthThreshold: 0 },
  shots = [],
  machineState = "sleeping",
  connectedMachine = {
    serialNumber: "9999",
    model: "DE1XL",
    version: "1400",
  },
  responseStatuses = [],
  consentDenied = false,
  annotationStatus = 200,
  beforeProxy,
  notificationsAvailable = true,
  machineListResponses = [],
  registeredSerials = [...new Set([
    ...shots.map((item) => item.workflow?.machine?.serialNumber).filter(Boolean),
    connectedMachine?.serialNumber,
  ].filter(Boolean))],
} = {}) {
  const proxyCalls = [];
  const machineListCalls = [];
  const fetches = [];
  const puts = [];
  const emits = [];
  const notifications = [];
  const dismissedNotifications = [];
  const storageCalls = [];
  const timers = [];
  const fullShots = new Map(shots.map((item) => [item.id, item]));
  let nextTimerId = 0;
  let now = Date.now();

  const context = vm.createContext({
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    setTimeout(callback, delay) {
      const timer = { id: ++nextTimerId, callback, delay, cancelled: false };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(id) {
      const timer = timers.find((item) => item.id === id);
      if (timer) timer.cancelled = true;
    },
    async fetch(url, options = {}) {
      const value = String(url);
      fetches.push(value);
      if (options.method === "PUT") {
        puts.push({ url: value, body: JSON.parse(options.body) });
        if (annotationStatus < 200 || annotationStatus >= 300) {
          return { ok: false, status: annotationStatus, json: async () => ({}) };
        }
        const id = decodeURIComponent(value.substring(value.lastIndexOf("/") + 1));
        const item = fullShots.get(id);
        const extras = puts.at(-1).body.annotations?.extras;
        if (item && extras) {
          item.annotations ||= {};
          item.annotations.extras = { ...(item.annotations.extras || {}), ...extras };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (value.endsWith("/machine/state")) {
        return machineState === null
          ? { ok: false, status: 503, json: async () => ({}) }
          : {
              ok: true,
              status: 200,
              json: async () => ({ state: { state: machineState } }),
            };
      }
      if (value.includes("/shots?")) {
        const parsed = new URL(value);
        const offset = Number(parsed.searchParams.get("offset") || 0);
        const limit = Number(parsed.searchParams.get("limit") || 20);
        const ordered = parsed.searchParams.get("order") === "desc"
          ? [...shots].reverse()
          : shots;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: ordered.slice(offset, offset + limit),
            total: shots.length,
            limit,
            offset,
          }),
        };
      }
      if (value.endsWith("/shots/latest")) {
        const item = shots.at(-1);
        return {
          ok: Boolean(item),
          status: item ? 200 : 404,
          json: async () => item,
        };
      }
      if (value.includes("/shots/")) {
        const id = decodeURIComponent(value.substring(value.lastIndexOf("/") + 1));
        const item = fullShots.get(id);
        return {
          ok: Boolean(item),
          status: item ? 200 : 404,
          json: async () => item,
        };
      }
      if (value.endsWith("/machine/info")) {
        return {
          ok: Boolean(connectedMachine),
          status: connectedMachine ? 200 : 503,
          json: async () => connectedMachine,
        };
      }
      if (value.endsWith("/info")) {
        return { ok: true, status: 200, json: async () => ({ version: "9.9.9" }) };
      }
      throw new Error(`unexpected fetch: ${value}`);
    },
  });

  vm.runInContext(fs.readFileSync(pluginPath, "utf8"), context);
  const statuses = [...responseStatuses];
  const lists = [...machineListResponses];
  const plugin = context.createPlugin({
    ...(notificationsAvailable ? {
      notify(value) { notifications.push(value); },
      dismissNotification(id) { dismissedNotifications.push(id); },
    } : {}),
    log() {},
    emit(name, payload) {
      emits.push({ name, payload });
    },
    storage(operation) {
      storageCalls.push(operation);
    },
    async decentProxy(proxyPath, options) {
      if (consentDenied) {
        const error = new Error("account consent denied");
        error.code = "account_consent_denied";
        throw error;
      }
      if (proxyPath === "support/api/sn") {
        machineListCalls.push({ path: proxyPath, options });
        const response = lists.length ? lists.shift() : {
          status: 200,
          body: registeredSerials.map((serial) => `${serial} DE-DE1PRO`).join("\n"),
        };
        if (response instanceof Error) throw response;
        return response;
      }
      proxyCalls.push({ path: proxyPath, options });
      if (beforeProxy) await beforeProxy(proxyCalls.length);
      const status = statuses.length ? statuses.shift() : 200;
      return {
        status,
        body: status >= 200 && status < 300
          ? '{"ok":true,"profile_ref":"test@1"}'
          : "rejected",
      };
    },
  });
  plugin.onLoad(settings);

  return {
    plugin,
    proxyCalls,
    machineListCalls,
    fetches,
    puts,
    emits,
    notifications,
    dismissedNotifications,
    storageCalls,
    get nextTimerDelay() {
      return timers.find((timer) => !timer.cancelled)?.delay ?? null;
    },
    setMachineState(value) {
      machineState = value;
    },
    setConnectedMachine(value) {
      connectedMachine = value;
    },
    updateShot(id, value) {
      fullShots.set(id, value);
      const index = shots.findIndex((item) => item.id === id);
      if (index >= 0) shots[index] = value;
    },
    async runNextTimer() {
      while (timers.length) {
        const timer = timers.shift();
        if (timer.cancelled) continue;
        now += timer.delay;
        timer.callback();
        await pump();
        return true;
      }
      return false;
    },
  };
}


module.exports = { loadPlugin, pump, shot };
