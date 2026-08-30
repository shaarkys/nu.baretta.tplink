'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const test = require('node:test');

function loadFreshModule(modulePath, stubs) {
  const resolvedPath = require.resolve(modulePath);
  const previousModule = require.cache[resolvedPath];
  const originalLoad = Module._load;

  delete require.cache[resolvedPath];
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
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

      warn() {}

      error() {}
    },
    Device: class Device {},
  };
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

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function createPairClientClass() {
  const instances = [];

  class PairClient extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.discoveryOptions = null;
      this.stopDiscoveryCalls = 0;
      this.removeAllListenersCalls = 0;
      instances.push(this);
    }

    startDiscovery(options) {
      this.discoveryOptions = options;
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

  return { Client: PairClient, instances };
}

test('manifest declares HS107 as a two-outlet non-meter socket', () => {
  const manifest = require('../app.json');
  const driver = manifest.drivers.find(item => item.id === 'hs107');

  assert.ok(driver);
  assert.equal(driver.class, 'socket');
  assert.deepEqual(driver.capabilities, ['onoff', 'ledonoff']);
  assert.deepEqual(
    driver.settings.flatMap(group => group.children.map(setting => setting.id)),
    ['settingIPAddress', 'dynamicIp'],
  );
  assert.match(manifest.flow.actions.find(action => action.id === 'ledOn').args[0].filter, /hs107/);
  assert.match(manifest.flow.actions.find(action => action.id === 'ledOff').args[0].filter, /hs107/);
});

test('pairing exposes each undiscovered HS107 child once and keeps parent-child identity', { concurrency: false }, async () => {
  const { Client, instances } = createPairClientClass();
  const Driver = loadFreshModule('../drivers/hs107/driver.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const driver = new Driver();
  driver.getDevices = () => ({ existing: { getData: () => ({ id: 'parent-id', childId: 'parent-id01' }) } });
  driver.log = () => {};
  driver.warn = () => {};
  driver.error = () => {};
  const session = createPairSession();

  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = timer => {
    if (timer) timer.cleared = true;
  };

  try {
    await driver.onPair(session);
    await session.handlers.get('discover')({});
    const client = instances[0];
    assert.deepEqual(client.discoveryOptions, {
      deviceTypes: ['plug'],
      discoveryInterval: 1000,
      discoveryTimeout: 3000,
      breakoutChildren: true,
    });

    const outletOne = {
      model: 'HS107(US)',
      host: '192.0.2.10',
      deviceId: 'parent-id',
      childId: 'parent-id01',
      alias: 'Already paired outlet',
    };
    const outletTwo = { ...outletOne, childId: 'parent-id02', alias: 'Second outlet' };
    client.emit('plug-new', outletOne);
    client.emit('plug-online', outletTwo);
    client.emit('plug-online', { ...outletTwo, alias: 'Second outlet again' });
    client.emit('plug-new', { ...outletTwo, model: 'HS1070' });
    timers[0].callback();
    await flushMicrotasks();

    assert.equal(client.stopDiscoveryCalls, 1);
    assert.equal(client.removeAllListenersCalls, 1);
    assert.deepEqual(session.emitted, [{
      name: 'discovered_devices',
      value: [{
        ip: '192.0.2.10',
        name: 'Second outlet again',
        deviceId: 'parent-id',
        childId: 'parent-id02',
      }],
    }]);

    const devices = await session.handlers.get('get_devices')(session.emitted[0].value);
    assert.deepEqual(devices, [{
      data: { id: 'parent-id', childId: 'parent-id02' },
      name: 'Second outlet again',
      settings: {
        settingIPAddress: '192.0.2.10',
        dynamicIp: false,
      },
    }]);
    assert.deepEqual(await session.handlers.get('list_devices')(), devices);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('manual-IP pairing only accepts HS107 evidence from the requested host', { concurrency: false }, async () => {
  const { Client, instances } = createPairClientClass();
  const Driver = loadFreshModule('../drivers/hs107/driver.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const driver = new Driver();
  driver.getDevices = () => ({});
  driver.log = () => {};
  driver.warn = () => {};
  driver.error = () => {};
  const session = createPairSession();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = timer => {
    if (timer) timer.cleared = true;
  };

  try {
    await driver.onPair(session);
    await session.handlers.get('discover')([{ ip: '192.0.2.20' }]);
    const client = instances[0];
    assert.deepEqual(client.discoveryOptions.devices, [{ host: '192.0.2.20' }]);
    client.emit('plug-online', {
      model: 'HS107(US)',
      host: '192.0.2.21',
      deviceId: 'parent-id',
      childId: 'parent-id01',
    });
    client.emit('plug-online', {
      model: 'HS107(US)',
      host: '192.0.2.20',
      deviceId: 'parent-id',
      childId: 'parent-id01',
      alias: 'Requested outlet',
    });
    timers[0].callback();
    await flushMicrotasks();

    assert.equal(session.emitted[0].name, 'discovered_devices');
    const devices = await session.handlers.get('get_devices')(session.emitted[0].value);
    assert.equal(devices[0].settings.settingIPAddress, '192.0.2.20');
    await assert.rejects(
      session.handlers.get('get_devices')([{
        ip: '192.0.2.20',
        deviceId: 'synthetic-parent',
        childId: 'synthetic-parent01',
      }]),
      /discovery evidence/,
    );
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('HS107 device uses child power methods, parent LED methods, one interval, and dynamic-ID rediscovery', { concurrency: false }, async () => {
  const clientInstances = [];
  const plugOptions = [];
  const childPowerCalls = [];
  const parentLedCalls = [];
  const childPlug = {
    async getPowerState() {
      return true;
    },
    async setPowerState(value) {
      childPowerCalls.push(value);
      return true;
    },
  };
  const parentPlug = {
    async getLedState() {
      return false;
    },
    async setLedState(value) {
      parentLedCalls.push(value);
      return true;
    },
  };

  class DeviceClient extends EventEmitter {
    constructor() {
      super();
      this.stopDiscoveryCalls = 0;
      clientInstances.push(this);
    }

    async getSysInfo() {
      return { model: 'HS107(US)', deviceId: 'parent-id' };
    }

    getPlug(options) {
      plugOptions.push(options);
      return options.childId ? childPlug : parentPlug;
    }

    startDiscovery(options) {
      this.discoveryOptions = options;
      return this;
    }

    stopDiscovery() {
      this.stopDiscoveryCalls += 1;
    }
  }

  const Homey = createHomeyStub();
  const Device = loadFreshModule('../drivers/hs107/device.js', {
    homey: Homey,
    'tplink-smarthome-api': { Client: DeviceClient },
  });
  const device = new Device();
  const settings = { settingIPAddress: '192.0.2.30', dynamicIp: true };
  const data = { id: 'parent-id', childId: 'parent-id01' };
  const capabilities = {};
  const listeners = {};
  const intervals = [];
  const flowListeners = {};
  let availableCalls = 0;
  const settingWrites = [];

  device.homey = {
    setInterval(callback, delay) {
      const interval = { callback, delay, cleared: false };
      intervals.push(interval);
      return interval;
    },
    flow: {
      getActionCard(id) {
        return {
          registerRunListener(listener) {
            flowListeners[id] = listener;
          },
        };
      },
    },
  };
  device.getSettings = () => settings;
  device.getData = () => data;
  device.registerCapabilityListener = (id, listener) => {
    listeners[id] = listener;
  };
  device.setSettings = async update => {
    settingWrites.push(update);
    Object.assign(settings, update);
  };
  device.setCapabilityValue = async (id, value) => {
    capabilities[id] = value;
  };
  device.setAvailable = async () => {
    availableCalls += 1;
  };
  device.setUnavailable = async () => {};
  device.log = () => {};
  device.warn = () => {};
  device.error = () => {};

  const originalClearInterval = global.clearInterval;
  global.clearInterval = interval => {
    if (interval && typeof interval === 'object') interval.cleared = true;
  };

  try {
    await device.onInit();
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].delay, 10000);
    assert.equal(typeof flowListeners.ledOn, 'function');
    assert.equal(typeof flowListeners.ledOff, 'function');

    await device.getStatus();
    assert.equal(plugOptions[0].childId, 'parent-id01');
    assert.equal(Object.prototype.hasOwnProperty.call(plugOptions[1], 'childId'), false);
    assert.deepEqual(capabilities, { onoff: true, ledonoff: false });

    await listeners.onoff(false);
    await listeners.ledonoff(true);
    assert.deepEqual(childPowerCalls, [false]);
    assert.deepEqual(parentLedCalls, [true]);

    const rediscovery = device.discover();
    const client = clientInstances[0];
    assert.deepEqual(client.discoveryOptions, {
      deviceTypes: ['plug'],
      discoveryInterval: 1000,
      discoveryTimeout: 5000,
      breakoutChildren: true,
    });
    client.emit('plug-online', {
      model: 'HS107(US)',
      host: '192.0.2.31',
      deviceId: 'parent-id',
      childId: 'parent-id01',
    });
    assert.equal(await rediscovery, true);
    assert.deepEqual(settingWrites.at(-1), { settingIPAddress: '192.0.2.31' });
    assert.equal(data.childId, 'parent-id01');
    assert.equal(availableCalls, 2);

    device.onDeleted();
    assert.equal(intervals[0].cleared, true);
    assert.equal(client.stopDiscoveryCalls, 1);
  } finally {
    global.clearInterval = originalClearInterval;
  }
});
