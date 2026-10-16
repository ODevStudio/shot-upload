const assert = require("node:assert/strict");
const test = require("node:test");
const { loadPlugin, shot } = require("./helpers");

async function status(harness) {
  return JSON.parse((await harness.plugin.__httpRequestHandler({ endpoint: "status" })).body);
}

for (const response of [{ status: 200, body: "" }, { status: 503, body: "offline" }]) {
  test(`account changes discard old serial pauses before lookup ${response.status}`, async () => {
    const harness = loadPlugin({ shots: [shot("pending")], machineListResponses: [
      { status: 200, body: "" }, response,
    ] });
    await harness.runNextTimer();
    assert.deepEqual((await status(harness)).pausedSerials, ["6262"]);
    harness.plugin.onEvent({ name: "decentAccountChanged", payload: {} });
    assert.deepEqual((await status(harness)).pausedSerials, []);
    await harness.runNextTimer();
    const notices = harness.emits.filter((event) => event.name === "uploadPaused");
    assert.equal(notices.length, response.status === 200 ? 2 : 1);
    assert.deepEqual((await status(harness)).pausedSerials, response.status === 200 ? ["6262"] : []);
  });
}

for (const body of ["temporarilyUnavailable", "maintenance", "6262\nmaintenance", "6262"]) {
  test(`unexpected machine-list text ${JSON.stringify(body)} backs off without an ownership notice`, async () => {
    const harness = loadPlugin({ shots: [shot("pending")], machineListResponses: [{ status: 200, body }] });
    await harness.runNextTimer();
    assert.equal(harness.proxyCalls.length, 0);
    assert.deepEqual((await status(harness)).pausedSerials, []);
    assert.equal(harness.emits.some((event) => event.name === "uploadPaused"), false);
    assert.equal(harness.nextTimerDelay, 60000);
  });
}

test("machine-list validation preserves opaque serials and unknown espresso SKUs", async () => {
  const harness = loadPlugin({ shots: [shot("pending", { serialNumber: "machine-a" })], machineListResponses: [
    { status: 200, body: "machine-a DE-NEW-MODEL+1\r\n" },
  ] });
  await harness.runNextTimer();
  assert.equal(harness.proxyCalls.length, 1);
});

test("large paused replacement queues have bounded reads and do not starve linked replacements", async () => {
  const edits = Array.from({ length: 200 }, (_, index) => shot(`edited-${index}`, {
    uploaded: true, serialNumber: "2222", updatedAt: "2026-01-01T00:01:00Z",
  }));
  const linked = shot("linked", { uploaded: true, serialNumber: "1111" });
  const harness = loadPlugin({ shots: [linked, ...edits], registeredSerials: ["1111"] });
  harness.plugin.onEvent({ name: "storageRead", payload: {
    key: "pendingReplacementShotIds", value: [...edits.map((item) => item.id), linked.id],
  } });
  const readCounts = new Map();
  for (let pass = 0; pass < 45; pass += 1) {
    const before = harness.fetches.length;
    if (!await harness.runNextTimer()) break;
    const reads = harness.fetches.slice(before).filter((url) => /\/shots\/(?!latest)[^/?]+$/.test(url));
    assert.ok(reads.length <= 105, `pass ${pass} made ${reads.length} full-shot reads`);
    for (const url of reads) readCounts.set(url, (readCounts.get(url) || 0) + 1);
  }
  assert.deepEqual(harness.proxyCalls.map((call) => JSON.parse(call.options.body).id), ["linked"]);
  for (const edit of edits) {
    const url = `http://localhost:8080/api/v1/shots/${edit.id}`;
    assert.equal(readCounts.get(url), 1, `${edit.id} was reread while its serial stayed paused`);
  }
  harness.plugin.onEvent({ name: "decentAccountChanged", payload: {} });
  await harness.runNextTimer();
  assert.equal(harness.emits.filter((event) => event.name === "uploadPaused").length, 2);
});

test("an authentication pause stops replacement and backlog reads immediately", async () => {
  const edits = Array.from({ length: 20 }, (_, index) => shot(`edited-${index}`, { uploaded: true }));
  const harness = loadPlugin({ shots: edits, responseStatuses: [401] });
  harness.plugin.onEvent({ name: "storageRead", payload: {
    key: "pendingReplacementShotIds", value: edits.map((item) => item.id),
  } });
  await harness.runNextTimer();
  assert.equal(harness.fetches.filter((url) => /\/shots\/(?!latest)[^/?]+$/.test(url)).length, 1);
  assert.equal(harness.fetches.some((url) => url.includes("/shots?")), false);
  assert.equal((await status(harness)).authenticationPaused, true);
});
