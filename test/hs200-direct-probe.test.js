'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./helpers/tplink-device-fixture');

const refused = Object.assign(new Error('connect ECONNREFUSED 192.0.2.10:9999'),
  { code: 'ECONNREFUSED', port: 9999 });

test('hs200: legacy pairing without a device ID probes the configured IP over KLAP and recovers', async () => {
  const f = fixture('hs200');
  f.globalCredentials = { username: 'owner@example.com', password: 'secret' };
  f.device.settings.dynamicIp = false;
  f.device.settings.deviceId = '';
  f.device.getData = () => ({ id: 'legacy-homey-id', transport: 'tcp' });
  await f.device.onInit();
  assert.equal(f.device.activeTransport, 'tcp');

  f.error = refused;
  await f.poll(3);
  assert.equal(f.device.activeTransport, 'tcp');
  assert.equal(f.device.store.tplinkConnection, undefined);
  const probeClient = f.clients.at(-1);
  assert.equal(probeClient.discoveryOptions, undefined, 'No discovery scan is started for a direct probe');
  assert.deepEqual(probeClient.options.credentials, f.globalCredentials);
  assert.ok(f.logs.some(line => line.includes('Direct transport probe failed: connect ECONNREFUSED 192.0.2.10:9999')));
  assert.equal(f.logs.some(line => line.includes('IP discovery skipped')), false);
  assert.equal(f.logs.some(line => line.includes('secret')), false);

  f.now += 60000;
  await f.poll();
  assert.equal(f.logs.filter(line => line.includes('Direct transport probe failed:')).length, 1,
    'Repeated probe failures are deduplicated');

  f.error = null;
  await f.device.discover({ transportRecovery: true });
  assert.equal(f.device.activeTransport, 'klap');
  assert.equal(f.device.store.tplinkConnection.host, '192.0.2.10');
  assert.equal(f.device.client.options.defaultSendOptions.transport, 'klap');
  assert.equal(f.device.client.options.defaultSendOptions.protocol, 'iot');
  assert.deepEqual(f.device.client.options.credentials, f.globalCredentials);
  assert.equal(f.device.getData().id, 'legacy-homey-id', 'Device identity is preserved');
  assert.ok(f.logs.some(line => line.includes('Transport confirmed by direct probe: klap, protocol=iot')));

  f.error = refused;
  const before = f.clients.length;
  await f.poll(3);
  assert.equal(f.clients.length, before, 'KLAP transport is no longer treated as recoverable legacy TCP');
});

test('hs200: direct probe ignores non-HS200 answers and invalid addresses', async () => {
  const f = fixture('hs200');
  f.globalCredentials = { username: 'owner@example.com', password: 'secret' };
  f.device.settings.dynamicIp = false;
  f.device.settings.deviceId = '';
  f.device.settings.settingIPAddress = 'not-an-ip-address';
  f.device.getData = () => ({ id: 'legacy-homey-id', transport: 'tcp' });
  await f.device.onInit();
  f.error = refused;
  const before = f.clients.length;
  await f.poll(3);
  assert.equal(f.clients.length, before, 'A non-IPv4 configured address skips the probe entirely');
  assert.equal(f.device.activeTransport, 'tcp');

  f.device.settings.settingIPAddress = '192.0.2.10';
  f.sysInfo = { model: 'LB100' };
  f.error = null;
  await f.device.discover({ transportRecovery: true });
  assert.ok(f.logs.some(line => line.includes('Direct transport probe failed: unexpected model: LB100')));
  assert.equal(f.device.activeTransport, 'tcp');
  assert.equal(f.device.store.tplinkConnection, undefined);
});
