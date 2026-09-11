'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, flush } = require('./helpers/tplink-device-fixture');

for (const message of ['connect EHOSTUNREACH 192.0.2.10:9999',
  'TCP Timeout after 10000ms\n192.0.2.10:9999 {"system":{"get_sysinfo":{}}}',
  'connect ECONNREFUSED 192.0.2.10:9999', 'connect ENETUNREACH 192.0.2.10:9999']) {
  test(`initial status failure starts discovery after three polls: ${message.split('\n')[0]}`, async () => {
    const f = fixture();
    f.error = new Error(message);
    await f.poll(2);
    assert.equal(f.clients.length, 1);
    await f.poll();
    assert.equal(f.clients.length, 2);
    assert.equal(f.device.discoverCount, 1);
    assert.equal(f.device.available, false);
    assert.deepEqual([...f.clients[1].discoveryOptions.deviceTypes], ['plug']);
    assert.equal(f.clients[1].discoveryOptions.discoveryInterval, 1000);
    assert.equal(f.clients[1].discoveryOptions.discoveryTimeout, 5000);
  });
}

test('getInfo failures also reach rediscovery, while disabled discovery and unrelated errors do not', async () => {
  const f = fixture();
  f.infoError = new Error('TCP Timeout after 10000ms');
  await f.poll(3);
  assert.equal(f.clients.length, 2);
  const disabled = fixture();
  disabled.device.settings.dynamicIp = false;
  disabled.error = new Error('connect EHOSTUNREACH');
  await disabled.poll(10);
  assert.equal(disabled.clients.length, 1);
  const unrelated = fixture();
  unrelated.error = new Error('Invalid sysinfo response');
  await unrelated.poll(10);
  assert.equal(unrelated.clients.length, 1);
});

test('failed scans release resources and retry no more than once per minute', async () => {
  const f = fixture();
  f.error = new Error('TCP Timeout after 10000ms');
  await f.poll(3);
  await f.poll(10);
  assert.equal(f.clients.length, 2);
  f.expireScan();
  assert.equal(f.clients[1].stops, 1);
  assert.deepEqual(f.clients[1].eventNames(), []);
  assert.equal(f.timers.size, 0);
  f.now = 59999;
  await f.poll();
  assert.equal(f.clients.length, 2);
  f.now = 60000;
  await f.poll();
  assert.equal(f.clients.length, 3);
});

for (const event of ['plug-new', 'plug-online']) {
  test(`${event} saves only the matching plug IP and polling restores telemetry and availability`, async () => {
    const f = fixture();
    f.error = new Error('connect EHOSTUNREACH');
    await f.poll(3);
    const scan = f.clients[1];
    scan.emit(event, { deviceId: 'other-plug', host: '192.0.2.21' });
    assert.equal(f.writes.length, 0);
    scan.emit(event, { deviceId: 'plug-1', host: '192.0.2.20' });
    scan.emit(event, { deviceId: 'plug-1', host: '192.0.2.20' });
    await flush();
    assert.deepEqual(f.writes, [{ settingIPAddress: '192.0.2.20' }]);
    assert.equal(f.device.settings.deviceId, 'plug-1');
    assert.equal(f.device.getData().id, 'existing-homey-id');
    assert.equal(f.device.available, false);
    assert.equal(scan.stops, 1);
    assert.equal(f.timers.size, 0);
    f.error = null;
    await f.poll();
    assert.equal(f.requests.at(-1), '192.0.2.20');
    assert.equal(f.device.available, true);
    assert.equal(f.device.values.onoff, true);
    assert.equal(f.device.values.measure_power, 20);
    assert.equal(f.device.values.meter_power, 10);
    assert.equal(f.device.values.measure_voltage, 230);
    assert.equal(f.device.values.measure_current, 0.1);
    assert.equal(f.device.unreachableCount, 0);
    assert.equal(f.device.discoverCount, 0);
  });
}

test('successful polling resets failures and allows a fresh outage to rediscover promptly', async () => {
  const f = fixture();
  f.error = new Error('TCP Timeout after 10000ms');
  await f.poll(2);
  f.error = null;
  await f.poll();
  assert.equal(f.device.unreachableCount, 0);
  f.error = new Error('TCP Timeout after 10000ms');
  await f.poll(2);
  assert.equal(f.clients.length, 1);
  await f.poll();
  assert.equal(f.clients.length, 2);
  f.error = null;
  await f.poll();
  assert.equal(f.clients[1].stops, 1);
  f.error = new Error('TCP Timeout after 10000ms');
  await f.poll(3);
  assert.equal(f.clients.length, 3);
});

test('two paired HS110 devices have independent discovery sessions', async () => {
  const f = fixture();
  const second = f.makeDevice({ deviceId: 'plug-2', settingIPAddress: '192.0.2.11' });
  f.device.discover();
  second.discover();
  assert.notEqual(f.device._ipRecovery.scan.client, second._ipRecovery.scan.client);
  f.clients[1].emit('plug-new', { deviceId: 'plug-1', host: '192.0.2.20' });
  await flush();
  assert.equal(f.clients[1].stops, 1);
  assert.equal(f.clients[2].stops, 0);
  f.clients[2].emit('plug-online', { deviceId: 'plug-2', host: '192.0.2.21' });
  await flush();
  assert.equal(second.settings.settingIPAddress, '192.0.2.21');
  assert.equal(f.clients[2].stops, 1);
});

test('deletion, settings changes and repeated initialization cancel active discovery', async () => {
  for (const action of ['delete', 'disable', 'ip', 'init']) {
    const f = fixture();
    f.device.discover();
    const scan = f.clients[1];
    const staleCallback = scan.listeners('plug-new')[0];
    if (action === 'delete') f.device.onDeleted();
    else if (action === 'init') await f.device.onInit();
    else {
      const update = action === 'disable' ? { dynamicIp: false } : { settingIPAddress: '192.0.2.30' };
      await f.device.onSettings({ oldSettings: f.device.getSettings(),
        newSettings: { ...f.device.settings, ...update }, changedKeys: Object.keys(update) });
      Object.assign(f.device.settings, update);
    }
    await staleCallback({ deviceId: 'plug-1', host: '192.0.2.20' });
    assert.equal(scan.stops, 1, action);
    assert.deepEqual(scan.eventNames(), [], action);
    assert.equal(f.writes.length, 0, action);
    if (action === 'init') {
      await f.device.onInit();
      assert.equal(f.timers.size, 1);
      f.device.onDeleted();
    }
    assert.equal(f.timers.size, 0, action);
  }
});

test('pending polling cannot overlap or restart discovery after deletion or an IP change', async () => {
  for (const action of ['delete', 'ip']) {
    const f = fixture();
    let reject;
    f.pending = new Promise((resolve, rejectPending) => { reject = rejectPending; });
    const pendingPoll = f.device.getStatus();
    await f.poll(3);
    assert.equal(f.requests.length, 1);
    if (action === 'delete') f.device.onDeleted();
    else f.device.settings.settingIPAddress = '192.0.2.20';
    reject(new Error('TCP Timeout after 10000ms'));
    await pendingPoll;
    assert.equal(f.device.unreachableCount, 0);
    assert.equal(f.clients.length, 1);
    assert.equal(f.device._ipRecovery.pendingPoll, null);
  }
});

test('missing identity, start errors, socket errors and persistence failures are handled safely', async () => {
  const missing = fixture();
  delete missing.device.settings.deviceId;
  missing.device.discover();
  assert.equal(missing.clients.length, 1);
  assert.match(missing.logs.join(' '), /device ID missing/);
  for (const failure of ['start', 'socket', 'save']) {
    const f = fixture();
    if (failure === 'start') f.startError = new Error('bind EADDRINUSE');
    f.device.discover();
    if (failure === 'socket') f.clients[1].emit('error', new Error('UDP EACCES'));
    if (failure === 'save') {
      f.saveError = new Error('settings persistence failed');
      f.clients[1].emit('plug-new', { deviceId: 'plug-1', host: '192.0.2.20' });
      await flush();
    }
    assert.equal(f.device.settings.settingIPAddress, '192.0.2.10', failure);
    assert.equal(f.clients[1].stops, 1, failure);
    assert.equal(f.timers.size, 0, failure);
    assert.match(f.logs.join(' '), /EADDRINUSE|EACCES|settings persistence failed/);
  }
});

test('listeners are installed before discovery can emit a result', async () => {
  const f = fixture();
  f.immediatePlug = { deviceId: 'plug-1', host: '192.0.2.20' };
  f.device.discover();
  await flush();
  assert.equal(f.device.settings.settingIPAddress, '192.0.2.20');
  assert.equal(f.clients[1].stops, 1);
});

test('a Homey capability timeout after a successful device response does not start discovery', async () => {
  const f = fixture();
  f.device.setCapabilityValue = async () => { throw new Error('Homey API timeout'); };
  await f.poll(5);
  assert.equal(f.clients.length, 1);
  assert.equal(f.device.unreachableCount, 0);
  assert.match(f.logs.join(' '), /Homey API timeout/);
});
