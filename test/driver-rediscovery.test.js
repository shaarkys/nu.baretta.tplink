'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, flush } = require('./helpers/tplink-device-fixture');

const DRIVERS = ['ep10', 'ep25', 'ep40', 'es20m', 'hs100', 'hs103', 'hs110', 'hs200',
  'hs210', 'hs220', 'hs300', 'kl110', 'kl120', 'kl130', 'kl400', 'kl430', 'kl50', 'kl60',
  'kp105', 'kp115', 'kp200', 'kp303', 'kp400', 'kp405', 'ks200m', 'ks225', 'ks230',
  'ks240', 'lb100', 'lb110', 'lb120', 'lb130', 's500d'];
const CHILDREN = new Set(['ep40', 'hs300', 'kp200', 'kp303', 'kp400']);
const BULBS = new Set(DRIVERS.filter(id => /^(kl|lb)/.test(id)));

function candidate(id, changes = {}) {
  return { deviceId: 'plug-1', host: '192.0.2.20', model: id.toUpperCase(),
    defaultSendOptions: { transport: 'tcp' },
    getSysInfo: async () => ({ deviceId: 'plug-1', model: id.toUpperCase() }), ...changes };
}

for (const id of DRIVERS) {
  test(`${id}: unreachable and TCP timeout failures rediscover the same device and resume polling`, async () => {
    for (const message of ['connect EHOSTUNREACH 192.0.2.10:9999',
      'TCP Timeout after 10000ms\n192.0.2.10:9999 {"system":{"get_sysinfo":{}}}']) {
      const f = fixture(id);
      const originalData = f.device.getData();
      f.error = new Error(message);
      await f.poll(2);
      assert.equal(f.clients.length, 1);
      await f.poll();
      const scan = f.clients[1];
      assert.ok(scan.discoveryOptions);
      assert.equal(f.device.available, false);
      const type = BULBS.has(id) ? 'bulb' : 'plug';
      assert.deepEqual([...scan.discoveryOptions.deviceTypes], [type]);
      assert.equal(scan.discoveryOptions.breakoutChildren, false);
      scan.emit(type + '-new', candidate(id, { deviceId: 'wrong-id',
        getSysInfo: async () => ({ deviceId: 'wrong-id', model: id.toUpperCase() }) }));
      await flush();
      assert.equal(f.writes.length, 0);
      scan.emit(type + '-online', candidate(id));
      await flush();
      assert.equal(f.device.settings.settingIPAddress, '192.0.2.20');
      assert.equal(f.device.settings.deviceId, 'plug-1');
      assert.deepEqual(f.device.getData(), originalData);
      assert.equal(scan.stops, 1);
      assert.deepEqual(scan.eventNames(), []);
      assert.equal(f.timers.size, 0);
      assert.equal(f.device.available, false);
      f.error = null;
      await f.poll();
      assert.equal(f.requests.at(-1), '192.0.2.20');
      assert.equal(f.device.available, true, f.logs.join('\n'));
      assert.equal(f.device.values.onoff, true, f.logs.join('\n'));
      assert.equal(f.device.unreachableCount, 0);
      if (CHILDREN.has(id)) assert.equal(f.lastPlugOptions.childId, 'child-1');
      if (BULBS.has(id)) assert.equal(f.device.values.dim, 0.6);
      if (['hs110', 'hs300', 'ep25', 'kp115'].includes(id)) {
        assert.equal(f.device.values.measure_power, 20);
        assert.equal(f.device.values.meter_power, 10);
      }
    }
  });

  test(`${id}: disabled discovery, cooldown, settings cancellation and deletion are respected`, async () => {
    const f = fixture(id);
    f.error = new Error('TCP Timeout after 10000ms');
    f.device.settings.dynamicIp = false;
    await f.poll(5);
    assert.equal(f.clients.length, 1);
    f.device.settings.dynamicIp = true;
    await f.poll();
    const first = f.clients[1];
    f.expireScan();
    await f.poll(5);
    assert.equal(f.clients.length, 2);
    assert.equal(first.stops, 1);
    f.now = 60000;
    await f.poll();
    const second = f.clients[2];
    const staleCallback = second.listeners((BULBS.has(id) ? 'bulb' : 'plug') + '-new')[0];
    await f.device.onSettings({ oldSettings: f.device.getSettings(),
      newSettings: { ...f.device.settings, dynamicIp: false }, changedKeys: ['dynamicIp'] });
    f.device.settings.dynamicIp = false;
    await staleCallback(candidate(id));
    assert.equal(f.writes.some(update => update.settingIPAddress === '192.0.2.20'), false);
    assert.equal(second.stops, 1);
    f.device.settings.dynamicIp = true;
    await f.poll(3);
    const last = f.clients.at(-1);
    f.device.onDeleted();
    assert.equal(last.stops, 1);
    assert.deepEqual(last.eventNames(), []);
    assert.equal(f.timers.size, 0);
    const requests = f.requests.length;
    await f.poll();
    assert.equal(f.requests.length, requests);
  });

  if (!['ep40', 'kp200', 'kp303', 'kp400', 'ks200m'].includes(id)) {
    test(`${id}: a secondary status request timeout also enters recovery`, async () => {
      const f = fixture(id);
      f.infoError = new Error('TCP Timeout after 10000ms');
      await f.poll(3);
      assert.equal(f.clients.length, 2, f.logs.join('\n'));
      assert.equal(f.device.available, false);
    });
  }
}

test('EP10 changes an unmarked device transport only after its new IP has been saved', async () => {
  const f = fixture('ep10');
  f.device.activeTransport = 'tcp';
  const oldClient = f.device.client;
  let resolveSave;
  f.saveGate = new Promise(resolve => { resolveSave = resolve; });
  await f.device.discover();
  f.clients[1].emit('plug-new', candidate('ep10', { defaultSendOptions: { transport: 'klap' } }));
  await flush();
  assert.equal(f.device.activeTransport, 'tcp');
  assert.equal(f.device.client, oldClient);
  resolveSave();
  await flush();
  assert.equal(f.device.settings.settingIPAddress, '192.0.2.20');
  assert.equal(f.device.activeTransport, 'klap');
  assert.notEqual(f.device.client, oldClient);
});

for (const id of ['ks225', 's500d', 'ks240', 'ep10']) {
  test(`${id}: discovery preserves credential source, redacts errors and rejects stale credential sessions`, async () => {
    const f = fixture(id);
    f.globalCredentials = { username: 'global@example.invalid', password: 'global-secret' };
    Object.assign(f.device.settings, { credentialSource: 'global' });
    await f.device.discover();
    const globalScan = f.clients.at(-1);
    assert.equal(globalScan.options.credentials.username, 'global@example.invalid');
    assert.equal(globalScan.options.credentials.password, 'global-secret');
    globalScan.emit('error', new Error('Failure for global@example.invalid global-secret'));
    assert.equal(f.logs.some(line => line.includes('global-secret') || line.includes('global@example.invalid')), false);
    assert.match(f.logs.join(' '), /\[redacted\]/);

    Object.assign(f.device.settings, { credentialSource: 'override',
      deviceUsername: 'override@example.invalid', devicePassword: 'override-secret' });
    await f.device.discover();
    const overrideScan = f.clients.at(-1);
    assert.equal(overrideScan.options.credentials.username, 'override@example.invalid');
    assert.equal(overrideScan.options.credentials.password, 'override-secret');
    const stale = overrideScan.listeners('plug-new')[0];
    f.device.stopActiveDiscovery();
    await stale(candidate(id));
    assert.equal(f.writes.length, 0);
    assert.equal(overrideScan.stops, 1);
  });
}

test('a user IP change waits for an in-flight discovery save and remains the final address', async () => {
  const f = fixture('hs100');
  let resolveSave;
  f.saveGate = new Promise(resolve => { resolveSave = resolve; });
  await f.device.discover();
  f.clients[1].emit('plug-new', candidate('hs100'));
  await flush();
  let settingsFinished = false;
  const update = f.device.onSettings({ oldSettings: f.device.getSettings(),
    newSettings: { ...f.device.settings, settingIPAddress: '192.0.2.30' },
    changedKeys: ['settingIPAddress'] }).then(() => {
    f.device.settings.settingIPAddress = '192.0.2.30';
    settingsFinished = true;
  });
  await flush();
  assert.equal(settingsFinished, false);
  resolveSave();
  await update;
  assert.equal(f.device.settings.settingIPAddress, '192.0.2.30');
  assert.equal(f.timers.size, 0);
});

test('authenticated errors do not trigger rediscovery, but a code-only network failure does', async () => {
  const f = fixture('ks225');
  f.error = new Error('Authentication failed');
  await f.poll(5);
  assert.equal(f.clients.length, 1);
  f.error = Object.assign(new Error('Connection failed'), { code: 'ECONNRESET' });
  await f.poll(3);
  assert.equal(f.clients.length, 2);
});

test('late authenticated candidate validation cannot overwrite changed connection settings', async () => {
  const f = fixture('ep10');
  let resolveInfo;
  await f.device.discover();
  f.clients[1].emit('plug-new', candidate('ep10', {
    getSysInfo: () => new Promise(resolve => { resolveInfo = resolve; }),
  }));
  f.device.stopActiveDiscovery();
  resolveInfo({ deviceId: 'plug-1', model: 'EP10' });
  await flush();
  assert.equal(f.writes.length, 0);
  assert.equal(f.timers.size, 0);
});
