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
  return {
    Driver: class Driver {
      getDevices() {
        return [];
      }

      log() {}
    },
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

test('KS225 refuses missing credentials and validates the physical selected target before returning a pair device', async () => {
  const instances = [];
  class Client {
    constructor(options) {
      this.options = options;
      instances.push(this);
    }

    async getSysInfo(host) {
      assert.equal(host, '192.0.2.30');
      return { model: 'KS225(US)', deviceId: 'physical-ks225', alias: 'Kitchen' };
    }
  }
  const Driver = loadFreshModule('../drivers/ks225/driver.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const driver = new Driver();
  const session = createPairSession();
  await driver.onPair(session);

  await assert.rejects(
    session.handlers.get('get_devices')([{ ip: '192.0.2.30', name: 'Kitchen' }]),
    /credentials are required/,
  );

  const devices = await session.handlers.get('get_devices')([
    {
      ip: '192.0.2.30',
      name: 'Kitchen',
      deviceId: 'physical-ks225',
      deviceUsername: ' account@example.com ',
      devicePassword: ' password ',
    },
  ]);

  assert.equal(instances.length, 1);
  assert.deepEqual(instances[0].options, {
    defaultSendOptions: { transport: 'klap', timeout: 4000 },
    credentials: { username: 'account@example.com', password: ' password ' },
  });
  assert.equal(devices.length, 1);
  assert.deepEqual(devices[0].settings, {
    settingIPAddress: '192.0.2.30',
    dynamicIp: false,
    totalOffset: 0,
    deviceId: 'physical-ks225',
    credentialSource: 'global',
    deviceUsername: '',
    devicePassword: '',
  });
  assert.deepEqual(session.emitted, [{ name: 'continue', value: null }]);
});

test('KS225 rejects a stale discovery selection when the authenticated target has another device ID', async () => {
  class Client {
    async getSysInfo() {
      return { model: 'KS225', deviceId: 'other-device' };
    }
  }
  const Driver = loadFreshModule('../drivers/ks225/driver.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const driver = new Driver();
  const session = createPairSession();
  await driver.onPair(session);

  await assert.rejects(
    session.handlers.get('get_devices')([
      {
        ip: '192.0.2.31',
        deviceId: 'selected-device',
        deviceUsername: 'account@example.com',
        devicePassword: 'password',
      },
    ]),
    /no longer matches the device selected during discovery/,
  );
});

test('KS225 redacts a target-validation error before returning it to the pairing UI', async () => {
  class Client {
    async getSysInfo() {
      throw new Error('Target validation echoed pairing-secret');
    }
  }
  const Driver = loadFreshModule('../drivers/ks225/driver.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const driver = new Driver();
  const session = createPairSession();
  await driver.onPair(session);

  let error;
  try {
    await session.handlers.get('get_devices')([
      {
        ip: '192.0.2.32',
        deviceUsername: 'account@example.com',
        devicePassword: 'pairing-secret',
      },
    ]);
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.match(error.message, /Unable to validate the selected KS225/);
  assert.equal(error.message.includes('pairing-secret'), false);
});
