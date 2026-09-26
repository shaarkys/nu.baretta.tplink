'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const test = require('node:test');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function withFakeTimers(callback) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];

  global.setTimeout = (callbackFn, delay) => {
    const timer = { callback: callbackFn, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = timer => {
    if (timer && typeof timer === 'object') timer.cleared = true;
  };

  try {
    return await callback(timers);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

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
  return {
    Driver: class Driver {
      getDevices() {
        return {};
      }

      log() {}
    },
    Device: class Device {},
  };
}

function createClientStub(onStartDiscovery) {
  const instances = [];

  class Client extends EventEmitter {
    constructor(options = {}) {
      super();
      this.options = options;
      this.stopDiscoveryCalls = 0;
      this.removeAllListenersCalls = 0;
      instances.push(this);
    }

    startDiscovery(options) {
      this.discoveryOptions = options;
      onStartDiscovery(this);
      return this;
    }

    stopDiscovery() {
      this.stopDiscoveryCalls += 1;
    }

    removeAllListeners(...args) {
      this.removeAllListenersCalls += 1;
      return super.removeAllListeners(...args);
    }
  }

  return { Client, instances };
}

function createPairSession() {
  const handlers = new Map();
  const emitted = [];

  return {
    handlers,
    emitted,
    setHandler(name, handler) {
      handlers.set(name, handler);
    },
    async emit(name, value) {
      emitted.push({ name, value });
    },
  };
}

test('HS200 uses the saved account, filters other models, validates once and reports rejected authentication', async () => {
  let calls = 0;
  let rejected = false;
  const account = { username: 'owner@example.com', password: 'private-password' };
  const plug = {
    host: '192.168.10.101', model: 'HS200(US)', deviceId: 'discovery-hash',
    defaultSendOptions: { transport: 'klap' },
    async getSysInfo() {
      calls++;
      if (rejected) throw new Error('KlapConnection(KLAP): authentication failed (challenge mismatch) private-password');
      this.deviceId = 'canonical-id';
      return { deviceId: this.deviceId, model: this.model };
    },
  };
  const { Client, instances } = createClientStub(client => {
    assert.equal(client.discoveryOptions.filterCallback({ model: 'KS240(US)' }), false);
    client.emit('plug-new', { model: 'KS240(US)', host: '192.168.10.103',
      getSysInfo() { throw new Error('Unrelated device must not be queried'); } });
    client.emit('plug-new', plug);
    client.emit('plug-online', plug);
  });
  const Driver = loadFreshModule('../drivers/hs200/driver.js', {
    homey: createHomeyStub(), 'tplink-smarthome-api': { Client },
  });
  const driver = new Driver();
  const logs = [];
  driver.log = (...args) => logs.push(args.join(' '));
  driver.homey = { app: { getGlobalCredentials: () => account } };
  const session = createPairSession();
  await withFakeTimers(async timers => {
    await driver.onPair(session);
    const discovering = session.handlers.get('discover')({});
    timers.at(-1).callback();
    const devices = await discovering;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].deviceId, 'canonical-id');
    assert.equal(devices[0].transport, 'klap');
    assert.deepEqual(instances[0].options.credentials, account);
    assert.equal(calls, 1);
    rejected = true;
    const failing = session.handlers.get('discover')({});
    timers.at(-1).callback();
    await assert.rejects(failing, error => /challenge mismatch/.test(error.message)
      && !error.message.includes(account.password));
    assert.equal(calls, 2);
    assert.equal(logs.some(line => line.includes(account.password)), false);
    assert.ok(logs.some(line => /transport=klap, login version=unknown, account=global/.test(line)));
    const cancelled = session.handlers.get('discover')({});
    session.handlers.get('cancel')();
    assert.deepEqual(await cancelled, []);
    assert.equal(instances.at(-1).eventNames().length, 0);
    assert.equal(instances.at(-1).stopDiscoveryCalls, 1);
  });
});

test('HS200 save revalidates a selected device with the exact credentials to persist', { concurrency: false }, async () => {
  const sysInfo = createDeferred();
  const plug = {
    host: '192.0.2.10',
    model: 'HS200',
    deviceId: 'selected-device-id',
    defaultSendOptions: { transport: 'klap' },
    getSysInfo: () => sysInfo.promise,
  };
  const { Client, instances } = createClientStub(client => client.emit('plug-new', plug));
  const Driver = loadFreshModule('../drivers/hs200/driver.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const driver = new Driver();
  const session = createPairSession();
  driver.log = () => {};

  await withFakeTimers(async timers => {
    await driver.onPair(session);
    const savePromise = session.handlers.get('get_devices')([{
      ip: '192.0.2.10',
      name: 'Saved HS200',
      deviceId: 'selected-device-id',
      transport: 'klap',
      deviceUsername: ' account@example.com ',
      devicePassword: ' password with spaces ',
    }]);

    assert.equal(instances.length, 1);
    assert.deepEqual(instances[0].options, {
      logLevel: 'silent',
      defaultSendOptions: { timeout: 4000 },
      credentials: {
        username: 'account@example.com',
        password: ' password with spaces ',
      },
    });
    assert.deepEqual(instances[0].discoveryOptions.devices, [{ host: '192.0.2.10' }]);
    assert.equal(timers.length, 1);

    timers[0].callback();
    sysInfo.resolve({ model: 'HS200', deviceId: 'selected-device-id', alias: 'Physical HS200' });

    const devices = await savePromise;
    assert.equal(instances[0].stopDiscoveryCalls, 1);
    assert.equal(instances[0].removeAllListenersCalls, 1);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].data.transport, 'klap');
    assert.deepEqual(devices[0].settings, {
      settingIPAddress: '192.0.2.10',
      dynamicIp: false,
      totalOffset: 0,
      deviceId: 'selected-device-id',
      credentialSource: 'global',
      deviceUsername: '',
      devicePassword: '',
    });
    assert.deepEqual(session.emitted, [{ name: 'continue', value: null }]);
  });
});

test('HS200 save rejects a selected device when targeted validation finds a different device ID', { concurrency: false }, async () => {
  const plug = {
    host: '192.0.2.11',
    model: 'HS200',
    deviceId: 'physical-device-id',
    defaultSendOptions: { transport: 'klap' },
    getSysInfo: async () => ({ model: 'HS200', deviceId: 'physical-device-id' }),
  };
  const { Client, instances } = createClientStub(client => client.emit('plug-new', plug));
  const Driver = loadFreshModule('../drivers/hs200/driver.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const driver = new Driver();
  const session = createPairSession();
  driver.log = () => {};

  await withFakeTimers(async timers => {
    await driver.onPair(session);
    const savePromise = session.handlers.get('get_devices')([{
      ip: '192.0.2.11',
      deviceId: 'selected-device-id',
      transport: 'klap',
      deviceUsername: 'account@example.com',
      devicePassword: 'password',
    }]);

    assert.equal(instances.length, 1);
    timers[0].callback();

    await assert.rejects(
      savePromise,
      /no longer matches the device selected during discovery/,
    );
    assert.deepEqual(session.emitted, []);
  });
});

test('HS200 TCP pairing does not persist or seed unused account credentials', { concurrency: false }, async () => {
  const plug = {
    host: '192.0.2.13',
    model: 'HS200',
    deviceId: 'tcp-device-id',
    defaultSendOptions: { transport: 'tcp' },
    getSysInfo: async () => ({ model: 'HS200', deviceId: 'tcp-device-id' }),
  };
  const { Client, instances } = createClientStub(client => client.emit('plug-new', plug));
  const Driver = loadFreshModule('../drivers/hs200/driver.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const driver = new Driver();
  const session = createPairSession();
  driver.log = () => {};

  await withFakeTimers(async timers => {
    await driver.onPair(session);
    const pairing = session.handlers.get('get_devices')([{
      ip: '192.0.2.13',
      deviceUsername: 'unused@example.com',
      devicePassword: 'unused password',
    }]);

    timers[0].callback();
    const devices = await pairing;
    assert.equal(instances.length, 1);
    assert.equal(devices[0].data.transport, 'tcp');
    assert.deepEqual(devices[0].settings, {
      settingIPAddress: '192.0.2.13',
      dynamicIp: false,
      totalOffset: 0,
      deviceId: 'tcp-device-id',
      deviceUsername: '',
      devicePassword: '',
    });
  });
});

test('HS200 authenticated discovery requires a complete account pair before returning a device', { concurrency: false }, async () => {
  let sysInfoCalls = 0;
  const plug = {
    host: '192.0.2.14',
    model: 'HS200',
    deviceId: 'authenticated-device-id',
    defaultSendOptions: { transport: 'klap' },
    getSysInfo: async () => {
      sysInfoCalls += 1;
      return { model: 'HS200', deviceId: 'authenticated-device-id' };
    },
  };
  const { Client } = createClientStub(client => client.emit('plug-new', plug));
  const Driver = loadFreshModule('../drivers/hs200/driver.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const driver = new Driver();
  const session = createPairSession();
  driver.log = () => {};

  await withFakeTimers(async timers => {
    await driver.onPair(session);
    const pairing = session.handlers.get('get_devices')([{ ip: '192.0.2.14' }]);
    timers[0].callback();
    await assert.rejects(pairing, /uses authenticated firmware/);
    assert.equal(sysInfoCalls, 0);
  });
});

test('HS200 rediscovery keeps the existing client and transport when the IP settings update fails', { concurrency: false }, async () => {
  const settingsWrite = createDeferred();
  const plug = {
    host: '192.0.2.12',
    model: 'HS200',
    deviceId: 'device-id',
    defaultSendOptions: { transport: 'klap' },
    getSysInfo: async () => ({ model: 'HS200', deviceId: 'device-id' }),
  };
  const { Client, instances } = createClientStub(client => client.emit('plug-new', plug));
  const Device = loadFreshModule('../drivers/hs200/device.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const device = new Device();
  const previousClient = { name: 'previous-client' };
  const logs = [];
  let setAvailableCalls = 0;

  device.activeTransport = 'tcp';
  device.client = previousClient;
  device.getData = () => ({ id: 'legacy-device' });
  device.getSettings = () => ({
    settingIPAddress: '192.0.2.4',
    deviceId: 'device-id',
    dynamicIp: true,
    deviceUsername: 'account@example.com',
    devicePassword: 'secret-password',
  });
  device.setSettings = async update => {
    assert.deepEqual(update, { settingIPAddress: '192.0.2.12' });
    return settingsWrite.promise;
  };
  device.setAvailable = async () => {
    setAvailableCalls += 1;
  };
  device.log = (...args) => logs.push(args.join(' '));

  await withFakeTimers(async timers => {
    await device.discover();
    await flushMicrotasks();

    assert.equal(instances.length, 1);
    assert.equal(instances[0].stopDiscoveryCalls, 0);
    assert.equal(device.activeTransport, 'tcp');
    assert.equal(device.client, previousClient);
    assert.equal(timers.length, 1);

    timers[0].callback();
    settingsWrite.reject(new Error('Could not save secret-password'));
    await flushMicrotasks();

    assert.equal(instances[0].stopDiscoveryCalls, 1);
    assert.equal(device.activeTransport, 'tcp');
    assert.equal(device.client, previousClient);
    assert.equal(setAvailableCalls, 0);
    assert.equal(logs.some(message => message.includes('Could not save [redacted]')), true);
    assert.equal(logs.some(message => message.includes('secret-password')), false);
  });
});
