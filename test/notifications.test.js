const assert = require('node:assert/strict');
const test = require('node:test');
const { loadPlugin, shot, pump } = require('./helpers');

test('ownership policy describes a generic host notification and HTTPS action', async () => {
  const harness = loadPlugin({ shots: [shot('a')], registeredSerials: [] });
  await harness.runNextTimer();
  const notice = harness.notifications.at(-1);
  assert.ok(notice);
  assert.match(notice.message, /serial 6262.*isn't linked/);
  assert.equal(notice.action.type, 'openExternalUrl');
  assert.equal(notice.action.url, 'https://decentespresso.com/support/');
  assert.equal(notice.action.label, 'Support');
  assert.equal(harness.emits.filter(event => event.name === 'uploadPaused').length, 1);
  await harness.runNextTimer();
  assert.equal(harness.notifications.length, 1);
});

test('authentication requests the approved account settings action', async () => {
  const harness = loadPlugin({ shots: [shot('a')], machineListResponses: [{ status: 401, body: '' }] });
  await harness.runNextTimer();
  const notice = harness.notifications.at(-1);
  assert.ok(notice);
  assert.match(notice.message, /sign in/);
  assert.equal(notice.action.type, 'openDecentAccount');
  assert.equal(notice.action.label, 'Sign In');
  assert.equal(notice.action.url, undefined);
});

test('additional paused serials do not replace an outstanding support action', async () => {
  const harness = loadPlugin({
    shots: [shot('a'), shot('b', { serialNumber: '7000' })],
    registeredSerials: [],
  });
  await harness.runNextTimer();
  assert.equal(harness.notifications.length, 1);
  const response = await harness.plugin.__httpRequestHandler({ endpoint: 'status' });
  assert.equal(JSON.parse(response.body).pausedSerials.length, 2);
});

test('authentication supersedes the ownership notice without another support action', async () => {
  const harness = loadPlugin({
    shots: [shot('linked', { serialNumber: '7000' }), shot('missing')],
    registeredSerials: ['7000'],
    responseStatuses: [401],
  });
  await harness.runNextTimer();
  assert.equal(harness.notifications.length, 2);
  assert.equal(harness.notifications.at(-1).id, 'authentication');
  assert.ok(harness.dismissedNotifications.includes('ownership'));
});

test('only return from this plugin support action rechecks ownership', async () => {
  const harness = loadPlugin({
    shots: [shot('a')],
    machineListResponses: [{ status: 200, body: '' }, { status: 200, body: '6262 DE-DE1PRO' }],
  });
  await harness.runNextTimer();
  const notice = harness.notifications.at(-1);
  assert.ok(notice);
  for (const payload of [
    { id: notice.id, actionId: notice.action.id, phase: 'activated' },
    { id: 'unrelated', actionId: notice.action.id, phase: 'returned' },
    { id: notice.id, actionId: 'unrelated', phase: 'returned' },
  ]) harness.plugin.onEvent({ name: 'notificationAction', payload });
  await pump();
  assert.equal(harness.machineListCalls.length, 1);
  harness.plugin.onEvent({
    name: 'notificationAction',
    payload: { id: notice.id, actionId: notice.action.id, phase: 'returned' },
  });
  await harness.runNextTimer();
  assert.equal(harness.machineListCalls.length, 2);
  assert.equal(harness.proxyCalls.length, 1);
  assert.ok(harness.dismissedNotifications.includes(undefined));
});

test('account changes clear stale native notices, not another plugin UI', async () => {
  const harness = loadPlugin({ shots: [shot('a')], registeredSerials: [] });
  await harness.runNextTimer();
  assert.ok(harness.notifications.length);
  harness.plugin.onEvent({ name: 'decentAccountChanged', payload: {} });
  assert.ok(harness.dismissedNotifications.includes(undefined));
});

test('missing optional notification methods do not bypass the ownership guard', async () => {
  const harness = loadPlugin({ shots: [shot('a')], registeredSerials: [], notificationsAvailable: false });
  await harness.runNextTimer();
  assert.equal(harness.proxyCalls.length, 0);
  assert.equal(harness.emits.filter(event => event.name === 'uploadPaused').length, 1);
  const response = await harness.plugin.__httpRequestHandler({ endpoint: 'status' });
  assert.equal(JSON.parse(response.body).pausedSerials[0], '6262');
});
