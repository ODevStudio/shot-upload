const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const pluginPath = path.join(__dirname, "..", "shot-upload.reaplugin", "plugin.js");

function shot(
  id,
  {
    serialNumber = "6262",
    provenanceStatus = "captured",
    capturedMachine = true,
    uploaded = false,
    rejected = false,
    mockDeviceSkipped = false,
  } = {},
) {
  return {
    id,
    annotations: {
      extras: {
        ...(uploaded ? { uploaded_to_decent: 1 } : {}),
        ...(rejected
          ? { decent_upload_rejected: { status: 422, timestamp: 1 } }
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
} = {}) {
  const proxyCalls = [];
  const fetches = [];
  const puts = [];
  const emits = [];
  const timers = [];
  const fullShots = new Map(shots.map((item) => [item.id, item]));
  let nextTimerId = 0;

  const context = vm.createContext({
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
  const plugin = context.createPlugin({
    log() {},
    emit(name, payload) {
      emits.push({ name, payload });
    },
    storage() {},
    async decentProxy(proxyPath, options) {
      if (consentDenied) {
        const error = new Error("account consent denied");
        error.code = "account_consent_denied";
        throw error;
      }
      proxyCalls.push({ path: proxyPath, options });
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
    fetches,
    puts,
    emits,
    setMachineState(value) {
      machineState = value;
    },
    async runNextTimer() {
      while (timers.length) {
        const timer = timers.shift();
        if (timer.cancelled) continue;
        timer.callback();
        await pump();
        return true;
      }
      return false;
    },
  };
}

test("automatic upload remains opt-in", async () => {
  const harness = loadPlugin({ settings: {}, shots: [shot("shot-1")] });

  harness.plugin.onEvent({ name: "shotStored", payload: { id: "shot-1" } });
  await pump();

  assert.equal(harness.proxyCalls.length, 0);
  harness.plugin.onUnload();
});

test("shotStored uploads the persisted shot with captured identity", async () => {
  const harness = loadPlugin({ shots: [shot("shot-1")] });

  harness.plugin.onEvent({ name: "shotStored", payload: { id: "shot-1" } });
  await pump();

  assert.equal(harness.proxyCalls.length, 1);
  assert.equal(harness.proxyCalls[0].path, "support/api/shot_upload");
  const payload = JSON.parse(harness.proxyCalls[0].options.body);
  assert.equal(payload.id, "shot-1");
  assert.equal(payload.machine.serialNumber, "6262");
  assert.equal(payload.app.version, "9.9.9");
  assert.equal(
    harness.fetches.some((url) => url.endsWith("/machine/info")),
    false,
  );
  assert.equal(Boolean(harness.puts[0].body.annotations.extras.uploaded_to_decent), true);
});

test("reconciliation uploads only eligible captured shots", async () => {
  const harness = loadPlugin({
    shots: [
      shot("eligible"),
      shot("uploaded", { uploaded: true }),
      shot("rejected", { rejected: true }),
      shot("simulated", { serialNumber: "MockDe1" }),
      shot("unavailable", { serialNumber: "", provenanceStatus: "unavailable" }),
      shot("legacy-mock", { capturedMachine: false, mockDeviceSkipped: true }),
    ],
  });

  assert.equal(await harness.runNextTimer(), true);

  assert.deepEqual(
    harness.proxyCalls.map((call) => JSON.parse(call.options.body).id),
    ["eligible"],
  );
});

test("reconciliation waits until the machine is idle", async () => {
  const harness = loadPlugin({ shots: [shot("eligible")], machineState: "espresso" });

  assert.equal(await harness.runNextTimer(), true);
  assert.equal(harness.proxyCalls.length, 0);

  harness.setMachineState("idle");
  harness.plugin.onEvent({
    name: "stateUpdate",
    payload: { state: { state: "idle" } },
  });
  assert.equal(await harness.runNextTimer(), true);
  assert.equal(harness.proxyCalls.length, 1);
});

test("consent denial pauses reconciliation", async () => {
  const harness = loadPlugin({ shots: [shot("eligible")], consentDenied: true });

  assert.equal(await harness.runNextTimer(), true);
  assert.equal(harness.proxyCalls.length, 0);
  assert.equal(await harness.runNextTimer(), false);

  harness.plugin.onEvent({
    name: "stateUpdate",
    payload: { state: { state: "idle" } },
  });
  assert.equal(await harness.runNextTimer(), false);
});

test("transient failures retry on a later reconciliation pass", async () => {
  const harness = loadPlugin({
    shots: [shot("eventual")],
    responseStatuses: [503, 503, 503, 200],
  });

  for (let i = 0; i < 5; i += 1) {
    assert.equal(await harness.runNextTimer(), true);
  }

  assert.equal(harness.proxyCalls.length, 4);
  assert.equal(Boolean(harness.puts.at(-1).body.annotations.extras.uploaded_to_decent), true);
});

test("permanent rejection is marked and not posted again", async () => {
  const harness = loadPlugin({
    shots: [shot("bad")],
    responseStatuses: [422, 200],
  });

  assert.equal(await harness.runNextTimer(), true);
  assert.equal(harness.proxyCalls.length, 1);
  assert.equal(
    harness.puts[0].body.annotations.extras.decent_upload_rejected.status,
    422,
  );

  assert.equal(await harness.runNextTimer(), true);
  assert.equal(harness.proxyCalls.length, 1);
});

test("successful upload is not repeated when its local marker write fails", async () => {
  const harness = loadPlugin({
    shots: [shot("posted")],
    responseStatuses: [200, 200],
    annotationStatus: 500,
  });

  assert.equal(await harness.runNextTimer(), true);
  assert.equal(await harness.runNextTimer(), true);
  assert.equal(harness.proxyCalls.length, 1);
});

test("manual upload may use the connected machine after unavailable capture", async () => {
  const harness = loadPlugin({
    settings: { AutoUpload: false, LengthThreshold: 0 },
    shots: [shot("manual", { serialNumber: "", provenanceStatus: "unavailable" })],
  });

  const response = await harness.plugin.__httpRequestHandler({ endpoint: "upload" });

  assert.equal(response.status, 200);
  assert.equal(harness.proxyCalls.length, 1);
  const payload = JSON.parse(harness.proxyCalls[0].options.body);
  assert.equal(payload.machine.serialNumber, "9999");
});
