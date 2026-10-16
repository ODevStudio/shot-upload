const assert = require("node:assert/strict");
const test = require("node:test");
const { loadPlugin, pump, shot } = require("./helpers");

async function status(harness) {
  return JSON.parse((await harness.plugin.__httpRequestHandler({ endpoint: "status" })).body);
}

function stored(harness, id) {
  harness.plugin.onEvent({ name: "shotStored", payload: { id } });
}

test("missing serial pauses without a POST and does not block linked serials", async () => {
  const harness = loadPlugin({
    shots: [shot("linked", { serialNumber: "1111" }), shot("unlinked", { serialNumber: "2222" })],
    registeredSerials: ["1111"],
  });
  await harness.runNextTimer();
  assert.deepEqual(harness.proxyCalls.map((call) => JSON.parse(call.options.body).id), ["linked"]);
  assert.deepEqual((await status(harness)).pausedSerials, ["2222"]);
  assert.equal(harness.machineListCalls.length, 1);
  assert.deepEqual({ ...harness.machineListCalls[0].options.query }, { onlyespressomachines: "1", withskus: "1" });
  assert.equal(harness.puts.some((put) => put.body.annotations.extras.decent_upload_rejected), false);
  assert.equal(harness.emits.filter((event) => event.name === "uploadPaused").length, 1);
  assert.match(harness.emits.find((event) => event.name === "uploadPaused").payload.message, /2222.*isn't linked/);
});

test("403 pauses the serial immediately across backlog live manual and settings paths", async () => {
  const harness = loadPlugin({ shots: [shot("old"), shot("new")], responseStatuses: [403, 200] });
  await harness.runNextTimer();
  assert.equal(harness.proxyCalls.length, 1);
  assert.deepEqual((await status(harness)).pausedSerials, ["6262"]);
  assert.equal(harness.puts.length, 0);
  stored(harness, "old");
  stored(harness, "new");
  await pump();
  await harness.plugin.__httpRequestHandler({ endpoint: "upload" });
  harness.plugin.onEvent({ name: "settingsUpdated", payload: { AutoUpload: false } });
  harness.plugin.onEvent({ name: "settingsUpdated", payload: { AutoUpload: true } });
  await harness.runNextTimer();
  assert.equal(harness.proxyCalls.length, 1);
  assert.equal(harness.emits.filter((event) => event.name === "uploadPaused").length, 1);
});

test("a 403 serial does not stop a different linked serial in the same backlog", async () => {
  const harness = loadPlugin({
    shots: [shot("good", { serialNumber: "1111" }), shot("bad", { serialNumber: "2222" })],
    responseStatuses: [403, 200],
  });
  await harness.runNextTimer();
  assert.deepEqual(harness.proxyCalls.map((call) => JSON.parse(call.options.body).id), ["bad", "good"]);
  assert.deepEqual((await status(harness)).pausedSerials, ["2222"]);
});

for (const source of ["lookup", "upload"]) {
  test(`401 from ${source} pauses the account without repeated requests or rejection markers`, async () => {
    const harness = loadPlugin({
      shots: [shot("old"), shot("new")],
      ...(source === "lookup" ? { machineListResponses: [{ status: 401, body: "unauthorized" }] } : { responseStatuses: [401, 200] }),
    });
    await harness.runNextTimer();
    stored(harness, "old");
    await pump();
    await harness.plugin.__httpRequestHandler({ endpoint: "upload" });
    assert.equal(harness.proxyCalls.length, source === "upload" ? 1 : 0);
    assert.equal(harness.machineListCalls.length, 1);
    assert.equal((await status(harness)).authenticationPaused, true);
    assert.equal(harness.puts.length, 0);
    const notice = harness.emits.find((event) => event.name === "uploadPaused");
    assert.equal(notice.payload.reason, "authentication");
    assert.match(notice.payload.message, /sign in/i);
    assert.doesNotMatch(notice.payload.message, /isn't linked/);
  });
}

for (const response of [{ status: 503, body: "unavailable" }, new Error("offline"), { status: 200, body: "<html>error</html>" }, { status: 200, body: "0" }]) {
  test(`machine-list failure ${response.body || response.message} holds uploads without an ownership notice`, async () => {
    const harness = loadPlugin({ shots: [shot("pending")], machineListResponses: [response, { status: 200, body: "6262 DE-DE1PRO" }] });
    await harness.runNextTimer();
    assert.equal(harness.proxyCalls.length, 0);
    assert.deepEqual((await status(harness)).pausedSerials, []);
    assert.equal(harness.emits.some((event) => event.name === "uploadPaused"), false);
    assert.equal(harness.puts.length, 0);
    stored(harness, "pending");
    await pump();
    assert.equal(harness.machineListCalls.length, 1);
    assert.equal(harness.proxyCalls.length, 0);
    await harness.runNextTimer();
    assert.equal(harness.machineListCalls.length, 2);
    assert.equal(harness.proxyCalls.length, 1);
    assert.equal(harness.emits.some((event) => event.name === "uploadPaused"), false);
  });
}

test("account changes recheck ownership and resume a confirmed linked serial", async () => {
  const harness = loadPlugin({ shots: [shot("pending")], machineListResponses: [{ status: 200, body: "" }, { status: 200, body: "6262 DE-DE1PRO" }] });
  await harness.runNextTimer();
  assert.equal(harness.proxyCalls.length, 0);
  harness.plugin.onEvent({ name: "decentAccountChanged", payload: {} });
  await harness.runNextTimer();
  assert.equal(harness.proxyCalls.length, 1);
  assert.deepEqual((await status(harness)).pausedSerials, []);
});

test("a fresh session checks ownership again without persisting 403 as a shot rejection", async () => {
  const pending = shot("pending");
  const original = loadPlugin({ shots: [pending], responseStatuses: [403] });
  await original.runNextTimer();
  original.plugin.onUnload();
  const restarted = loadPlugin({ shots: [pending] });
  await restarted.runNextTimer();
  assert.equal(restarted.proxyCalls.length, 1);
  assert.equal(original.puts.length, 0);
});

test("replacement uploads retain pending work while their serial is paused", async () => {
  const initial = shot("edited", { uploaded: true, updatedAt: "2026-01-01T00:01:00Z" });
  const harness = loadPlugin({ shots: [initial], registeredSerials: [] });
  harness.plugin.onEvent({ name: "shotUpdated", payload: { id: "edited", patch: { annotations: { espressoNotes: "changed" } } } });
  await pump();
  await harness.runNextTimer();
  assert.equal(harness.proxyCalls.length, 0);
  assert.deepEqual((await status(harness)).pausedSerials, ["6262"]);
  assert.equal(harness.puts.length, 0);
});

test("paused replacement work does not consume the upload budget for linked shots", async () => {
  const edits = Array.from({ length: 6 }, (_, index) => shot(`edited-${index}`, { uploaded: true, serialNumber: "2222", updatedAt: "2026-01-01T00:01:00Z" }));
  const harness = loadPlugin({ shots: [...edits, shot("linked", { serialNumber: "1111" })], registeredSerials: ["1111"] });
  harness.plugin.onEvent({ name: "storageRead", payload: { key: "pendingReplacementShotIds", value: edits.map((item) => item.id) } });
  await harness.runNextTimer();
  assert.deepEqual(harness.proxyCalls.map((call) => JSON.parse(call.options.body).id), ["linked"]);
});

test("signing in again refreshes the machine list before resuming an authentication pause", async () => {
  const harness = loadPlugin({ shots: [shot("pending")], responseStatuses: [401, 200] });
  await harness.runNextTimer();
  assert.equal((await status(harness)).authenticationPaused, true);
  harness.plugin.onEvent({ name: "decentAccountChanged", payload: {} });
  await harness.runNextTimer();
  assert.equal(harness.proxyCalls.length, 2);
  assert.equal(harness.machineListCalls.length, 2);
  assert.equal((await status(harness)).authenticationPaused, false);
});

test("400 rejects only the document and does not pause a machine or keep posting it", async () => {
  const harness = loadPlugin({ shots: [shot("invalid")], responseStatuses: [400, 200] });
  await harness.runNextTimer();
  await harness.runNextTimer();
  assert.equal(harness.proxyCalls.length, 1);
  assert.equal(harness.puts[0].body.annotations.extras.decent_upload_rejected.status, 400);
  assert.deepEqual((await status(harness)).pausedSerials, []);
});

test("an account switch discards the previous account's in-flight ownership response", async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const harness = loadPlugin({ settings: { AutoUpload: false }, shots: [shot("pending")], machineListResponses: [pending, { status: 200, body: "" }] });
  const original = harness.plugin.__httpRequestHandler({ endpoint: "upload" });
  await pump();
  harness.plugin.onEvent({ name: "decentAccountChanged", payload: {} });
  resolve({ status: 200, body: "6262 DE-DE1PRO" });
  await original;
  await harness.plugin.__httpRequestHandler({ endpoint: "upload" });
  assert.equal(harness.proxyCalls.length, 0);
  assert.deepEqual((await status(harness)).pausedSerials, ["6262"]);
});

for (const code of ["account_authentication_required", "account_consent_denied"]) {
  test(`stale lookup ${code} cannot pause or poison the new account`, async () => {
    let reject;
    const pending = new Promise((_, fail) => { reject = fail; });
    const harness = loadPlugin({ shots: [shot("pending")], machineListResponses: [pending] });
    await harness.runNextTimer();
    harness.plugin.onEvent({ name: "decentAccountChanged", payload: {} });
    reject(Object.assign(new Error("old account rejected"), { code }));
    await pump();
    assert.equal((await status(harness)).authenticationPaused, false);
    assert.equal(harness.emits.some((event) => event.name === "uploadPaused"), false);
    assert.equal(harness.nextTimerDelay, 0);
    await harness.runNextTimer();
    assert.equal(harness.machineListCalls.length, 2);
    assert.equal(harness.proxyCalls.length, 1);
  });
}

for (const staleStatus of [401, 403, 400]) {
  test(`an old upload ${staleStatus} cannot reject shots or pause the new account`, async () => {
    let resolve;
    const pending = new Promise((done) => { resolve = done; });
    const harness = loadPlugin({
      shots: [shot("pending")], responseStatuses: [staleStatus, 200],
      beforeProxy: (count) => count === 1 ? pending : undefined,
    });
    await harness.runNextTimer();
    assert.equal(harness.proxyCalls.length, 1);
    harness.plugin.onEvent({ name: "decentAccountChanged", payload: {} });
    resolve();
    await pump();
    assert.equal((await status(harness)).authenticationPaused, false);
    assert.deepEqual((await status(harness)).pausedSerials, []);
    assert.equal(harness.puts.length, 0);
    assert.equal(harness.nextTimerDelay, 0);
    await harness.runNextTimer();
    assert.equal(harness.machineListCalls.length, 2);
    assert.equal(harness.proxyCalls.length, 2);
  });
}

test("host auth-failure notification before a lookup 401 prompts an immediate new check", async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const error = Object.assign(new Error("credentials known invalid"), { code: "account_authentication_required" });
  const harness = loadPlugin({ shots: [shot("pending")], machineListResponses: [pending, error] });
  await harness.runNextTimer();
  harness.plugin.onEvent({ name: "decentAccountChanged", payload: {} });
  resolve({ status: 401, body: "unauthorized" });
  await pump();
  assert.equal(harness.nextTimerDelay, 0);
  await harness.runNextTimer();
  assert.equal((await status(harness)).authenticationPaused, true);
  assert.equal(harness.emits.filter((event) => event.name === "uploadPaused").length, 1);
  assert.equal(harness.proxyCalls.length, 0);
});

test("account refresh during a live upload remains immediate after a busy reconciliation timer", async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const harness = loadPlugin({
    shots: [shot("pending")], responseStatuses: [401, 200],
    beforeProxy: (count) => count === 1 ? pending : undefined,
  });
  stored(harness, "pending");
  await pump();
  harness.plugin.onEvent({ name: "decentAccountChanged", payload: {} });
  await harness.runNextTimer();
  assert.equal(harness.nextTimerDelay, 60000);
  resolve();
  await pump();
  assert.equal((await status(harness)).authenticationPaused, false);
  assert.equal(harness.nextTimerDelay, 0);
  await harness.runNextTimer();
  assert.equal(harness.proxyCalls.length, 2);
});

for (const code of ["account_authentication_required", "account_consent_denied"]) {
  test(`a stale upload ${code} cannot poison the new account`, async () => {
    let reject;
    const pending = new Promise((_, fail) => { reject = fail; });
    const harness = loadPlugin({ shots: [shot("pending")], beforeProxy: (count) => count === 1 ? pending : undefined });
    await harness.runNextTimer();
    harness.plugin.onEvent({ name: "decentAccountChanged", payload: {} });
    reject(Object.assign(new Error("old account rejected"), { code }));
    await pump();
    assert.equal((await status(harness)).authenticationPaused, false);
    assert.equal(harness.nextTimerDelay, 0);
    await harness.runNextTimer();
    assert.equal(harness.machineListCalls.length, 2);
    assert.equal(harness.proxyCalls.length, 2);
  });
}

test("support refresh outage retries ownership and resumes without a second support visit", async () => {
  const harness = loadPlugin({ shots: [shot("pending")], machineListResponses: [
    { status: 200, body: "" },
    { status: 503, body: "offline" },
    { status: 200, body: "6262 DE-DE1PRO" },
  ] });
  await harness.runNextTimer();
  assert.deepEqual((await status(harness)).pausedSerials, ["6262"]);
  harness.plugin.onEvent({ name: "decentAccountChanged", payload: {} });
  await harness.runNextTimer();
  assert.equal(harness.proxyCalls.length, 0);
  assert.equal(harness.nextTimerDelay, 60000);
  await harness.runNextTimer();
  assert.equal(harness.proxyCalls.length, 1);
  assert.equal(harness.machineListCalls.length, 3);
  assert.deepEqual((await status(harness)).pausedSerials, []);
  assert.equal(harness.emits.filter((event) => event.name === "uploadPaused").length, 1);
});

test("account refresh restarts a long backlog at the skipped shot rather than the advanced offset", async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const shots = Array.from({ length: 120 }, (_, index) => shot(`pending-${index}`));
  const harness = loadPlugin({ shots, machineListResponses: [pending] });
  await harness.runNextTimer();
  harness.plugin.onEvent({ name: "decentAccountChanged", payload: {} });
  resolve({ status: 200, body: "6262 DE-DE1PRO" });
  await pump();
  assert.equal(harness.nextTimerDelay, 0);
  await harness.runNextTimer();
  assert.equal(harness.proxyCalls.some((call) => JSON.parse(call.options.body).id === "pending-119"), true);
});

test("a late successful upload remains recorded after an account change", async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const harness = loadPlugin({ shots: [shot("accepted")], beforeProxy: (count) => count === 1 ? pending : undefined });
  await harness.runNextTimer();
  harness.plugin.onEvent({ name: "decentAccountChanged", payload: {} });
  resolve();
  await pump();
  assert.equal(harness.puts.some((put) => put.body.annotations.extras.uploaded_to_decent), true);
  assert.equal(harness.nextTimerDelay, 0);
  await harness.runNextTimer();
  assert.equal(harness.proxyCalls.length, 1);
});
