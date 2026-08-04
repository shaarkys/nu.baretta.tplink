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

test('EP10 save revalidates a selected device with the exact credentials to persist', { concurrency: false }, async () => {
  const sysInfo = createDeferred();
  const plug = {
    host: '192.0.2.10',
    model: 'EP10',
    deviceId: 'selected-device-id',
    defaultSendOptions: { transport: 'klap' },
    getSysInfo: () => sysInfo.promise,
  };
  const { Client, instances } = createClientStub(client => client.emit('plug-new', plug));
  const Driver = loadFreshModule('../drivers/ep10/driver.js', {
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
      name: 'Saved EP10',
      deviceId: 'selected-device-id',
      transport: 'klap',
      deviceUsername: ' account@example.com ',
      devicePassword: ' password with spaces ',
    }]);

    assert.equal(instances.length, 1);
    assert.deepEqual(instances[0].options, {
      credentials: {
        username: 'account@example.com',
        password: ' password with spaces ',
      },
    });
    assert.deepEqual(instances[0].discoveryOptions.devices, [{ host: '192.0.2.10' }]);
    assert.equal(timers.length, 1);

    timers[0].callback();
    sysInfo.resolve({ model: 'EP10', deviceId: 'selected-device-id', alias: 'Physical EP10' });

    const devices = await savePromise;
    assert.equal(instances[0].stopDiscoveryCalls, 1);
    assert.equal(instances[0].removeAllListenersCalls, 1);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].data.transport, 'klap');
    assert.deepEqual(devices[0].settings, {
      settingIPAddress: '192.0.2.10',
      dynamicIp: false,
      totalOffset: 0,
      deviceUsername: 'account@example.com',
      devicePassword: ' password with spaces ',
      deviceId: 'selected-device-id',
    });
    assert.deepEqual(session.emitted, [{ name: 'continue', value: null }]);
  });
});

test('EP10 save rejects a selected device when targeted validation finds a different device ID', { concurrency: false }, async () => {
  const plug = {
    host: '192.0.2.11',
    model: 'EP10',
    deviceId: 'physical-device-id',
    defaultSendOptions: { transport: 'klap' },
    getSysInfo: async () => ({ model: 'EP10', deviceId: 'physical-device-id' }),
  };
  const { Client, instances } = createClientStub(client => client.emit('plug-new', plug));
  const Driver = loadFreshModule('../drivers/ep10/driver.js', {
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

test('EP10 rediscovery keeps the existing client and transport when the IP settings update fails', { concurrency: false }, async () => {
  const settingsWrite = createDeferred();
  const plug = {
    host: '192.0.2.12',
    model: 'EP10',
    deviceId: 'device-id',
    defaultSendOptions: { transport: 'klap' },
    getSysInfo: async () => ({ model: 'EP10', deviceId: 'device-id' }),
  };
  const { Client, instances } = createClientStub(client => client.emit('plug-new', plug));
  const Device = loadFreshModule('../drivers/ep10/device.js', {
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
