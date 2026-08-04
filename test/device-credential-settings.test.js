'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadFreshModule(modulePath, stubs) {
  const resolvedPath = require.resolve(modulePath);
  const previousModule = require.cache[resolvedPath];
  const originalLoad = Module._load;

  delete require.cache[resolvedPath];
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) {
      return stubs[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(resolvedPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolvedPath];
    if (previousModule) require.cache[resolvedPath] = previousModule;
  }
}

function createHomeyStub() {
  return { Device: class Device {} };
}

function createHarness(Device, settings, data, globalCredentials = null) {
  const writes = [];
  const device = new Device();
  device.homey = {
    app: {
      getGlobalCredentials() {
        return globalCredentials;
      },
    },
  };
  device.getSettings = () => settings;
  device.getData = () => data;
  device.setSettings = async update => {
    writes.push(update);
    Object.assign(settings, update);
  };
  device.log = () => {};
  device.error = () => {};
  return { device, writes };
}

const STRICT_MODELS = [
  {
    name: 'KS225',
    modulePath: '../drivers/ks225/device.js',
    transport: 'klap',
  },
  {
    name: 'S500D',
    modulePath: '../drivers/s500d/device.js',
    transport: 'aes',
  },
  {
    name: 'KS240',
    modulePath: '../drivers/ks240/device.js',
    transport: 'aes',
  },
];

for (const spec of STRICT_MODELS) {
  test(
    `${spec.name} merges a subset credential update before validating and persisting it`,
    { concurrency: false },
    async () => {
      const instances = [];
      class Client {
        constructor(options) {
          this.options = options;
          instances.push(this);
        }

        async getSysInfo() {
          return { model: spec.name, deviceId: 'target-device' };
        }

        getPlug(args) {
          return { client: this, ...args };
        }
      }
      const Device = loadFreshModule(spec.modulePath, {
        homey: createHomeyStub(),
        'tplink-smarthome-api': { Client },
      });
      const settings = {
        settingIPAddress: '192.0.2.80',
        dynamicIp: false,
        pollingInterval: 10,
        credentialSource: 'override',
        deviceUsername: 'old@example.com',
        devicePassword: 'old password',
        deviceId: 'target-device',
        childId: 'child-device',
        channelType: 'light',
        channelName: 'Light',
      };
      const { device, writes } = createHarness(
        Device,
        settings,
        { id: `${spec.name}-device`, childId: 'child-device' },
      );
      device.childId = 'child-device';
      const previousClient = { name: 'previous-client' };
      const previousPlug = { name: 'previous-plug' };
      device.client = previousClient;
      device.plug = previousPlug;

      await device.onSettings({
        oldSettings: { ...settings },
        newSettings: { deviceUsername: ' new@example.com ' },
        changedKeys: ['deviceUsername'],
      });

      assert.equal(instances.length, 1);
      assert.deepEqual(instances[0].options, {
        defaultSendOptions: { transport: spec.transport, timeout: 4000 },
        credentials: {
          username: 'new@example.com',
          password: 'old password',
        },
      });
      assert.deepEqual(writes, [
        {
          credentialSource: 'override',
          deviceUsername: 'new@example.com',
          devicePassword: 'old password',
        },
      ]);
      assert.equal(device.client, instances[0]);
      assert.equal(device.plug.client, instances[0]);
    },
  );
}

test('a rejected strict credential update leaves the prior client, plug, and source settings intact', { concurrency: false }, async () => {
  class Client {
    async getSysInfo() {
      throw new Error('The device echoed candidate password');
    }
  }
  const Device = loadFreshModule('../drivers/ks225/device.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const settings = {
    settingIPAddress: '192.0.2.81',
    dynamicIp: false,
    credentialSource: 'override',
    deviceUsername: 'old@example.com',
    devicePassword: 'old password',
  };
  const { device, writes } = createHarness(Device, settings, { id: 'ks225-device' });
  const previousClient = { name: 'previous-client' };
  const previousPlug = { name: 'previous-plug' };
  device.client = previousClient;
  device.plug = previousPlug;

  let error;
  try {
    await device.onSettings({
      oldSettings: { ...settings },
      newSettings: { devicePassword: 'candidate password' },
      changedKeys: ['devicePassword'],
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.match(error.message, /Unable to validate TP-Link account credentials/);
  assert.equal(error.message.includes('candidate password'), false);
  assert.deepEqual(writes, []);
  assert.equal(device.client, previousClient);
  assert.equal(device.plug, previousPlug);
  assert.equal(settings.credentialSource, 'override');
  assert.equal(settings.devicePassword, 'old password');
});

test('a strict device cannot clear an override without a complete global account pair', { concurrency: false }, async () => {
  let clientCreated = false;
  class Client {
    constructor() {
      clientCreated = true;
    }
  }
  const Device = loadFreshModule('../drivers/s500d/device.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const settings = {
    settingIPAddress: '192.0.2.82',
    dynamicIp: false,
    credentialSource: 'override',
    deviceUsername: 'local@example.com',
    devicePassword: 'local password',
  };
  const { device, writes } = createHarness(Device, settings, { id: 's500d-device' });
  const previousClient = { name: 'previous-client' };
  const previousPlug = { name: 'previous-plug' };
  device.client = previousClient;
  device.plug = previousPlug;

  await assert.rejects(
    device.onSettings({
      oldSettings: { ...settings },
      newSettings: { deviceUsername: '', devicePassword: '' },
      changedKeys: ['deviceUsername', 'devicePassword'],
    }),
    /Complete global TP-Link account credentials are required/,
  );

  assert.equal(clientCreated, false);
  assert.deepEqual(writes, []);
  assert.equal(device.client, previousClient);
  assert.equal(device.plug, previousPlug);
  assert.equal(settings.credentialSource, 'override');
});

test('a confirmed TCP EP10 may clear local credentials without a global pair', { concurrency: false }, async () => {
  const instances = [];
  class Client {
    constructor(options) {
      this.options = options;
      instances.push(this);
    }

    async getSysInfo() {
      return { model: 'EP10', deviceId: 'ep10-device' };
    }

    getPlug(args) {
      return { client: this, ...args };
    }
  }
  const Device = loadFreshModule('../drivers/ep10/device.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const settings = {
    settingIPAddress: '192.0.2.83',
    dynamicIp: false,
    credentialSource: 'override',
    deviceUsername: 'local@example.com',
    devicePassword: 'local password',
  };
  const { device, writes } = createHarness(
    Device,
    settings,
    { id: 'ep10-device', transport: 'tcp' },
  );
  const previousClient = { name: 'previous-client' };
  device.client = previousClient;
  device.plug = { name: 'previous-plug' };
  device.activeTransport = 'tcp';

  await device.onSettings({
    oldSettings: { ...settings },
    newSettings: { deviceUsername: '', devicePassword: '' },
    changedKeys: ['deviceUsername', 'devicePassword'],
  });

  assert.deepEqual(instances[0].options, {
    defaultSendOptions: { transport: 'tcp', timeout: 4000 },
  });
  assert.deepEqual(writes, [
    {
      credentialSource: 'global',
      deviceUsername: '',
      devicePassword: '',
    },
  ]);
  assert.equal(device.activeTransport, 'tcp');
  assert.equal(device.client, instances[0]);
  assert.equal(device.plug.client, instances[0]);
});

test('an authenticated EP10 rejects a clear without global credentials before writing settings', { concurrency: false }, async () => {
  class Client {}
  const Device = loadFreshModule('../drivers/ep10/device.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const settings = {
    settingIPAddress: '192.0.2.84',
    dynamicIp: false,
    credentialSource: 'override',
    deviceUsername: 'local@example.com',
    devicePassword: 'local password',
  };
  const { device, writes } = createHarness(
    Device,
    settings,
    { id: 'ep10-device', transport: 'klap' },
  );
  const previousClient = { name: 'previous-client' };
  const previousPlug = { name: 'previous-plug' };
  device.client = previousClient;
  device.plug = previousPlug;
  device.activeTransport = 'klap';

  await assert.rejects(
    device.onSettings({
      oldSettings: { ...settings },
      newSettings: { deviceUsername: '', devicePassword: '' },
      changedKeys: ['deviceUsername', 'devicePassword'],
    }),
    /Complete global TP-Link account credentials are required/,
  );

  assert.deepEqual(writes, []);
  assert.equal(device.client, previousClient);
  assert.equal(device.plug, previousPlug);
  assert.equal(device.activeTransport, 'klap');
});

test('a rejected EP10 credential update preserves the prior transport, client, plug, and source', { concurrency: false }, async () => {
  class Client {
    async getSysInfo() {
      throw new Error('The device echoed candidate EP10 password');
    }
  }
  const Device = loadFreshModule('../drivers/ep10/device.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const settings = {
    settingIPAddress: '192.0.2.85',
    dynamicIp: false,
    credentialSource: 'override',
    deviceUsername: 'local@example.com',
    devicePassword: 'local password',
  };
  const { device, writes } = createHarness(
    Device,
    settings,
    { id: 'ep10-device', transport: 'klap' },
  );
  const previousClient = { name: 'previous-client' };
  const previousPlug = { name: 'previous-plug' };
  device.client = previousClient;
  device.plug = previousPlug;
  device.activeTransport = 'klap';

  let error;
  try {
    await device.onSettings({
      oldSettings: { ...settings },
      newSettings: { devicePassword: 'candidate EP10 password' },
      changedKeys: ['devicePassword'],
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.equal(error.message.includes('candidate EP10 password'), false);
  assert.deepEqual(writes, []);
  assert.equal(device.activeTransport, 'klap');
  assert.equal(device.client, previousClient);
  assert.equal(device.plug, previousPlug);
  assert.equal(settings.credentialSource, 'override');
});
