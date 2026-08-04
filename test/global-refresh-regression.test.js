'use strict';

const assert = require('node:assert/strict');
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

test('a stale global credential refresh cannot replace the newer per-device client or plug', async () => {
  const pending = [createDeferred(), createDeferred()];
  const instances = [];
  class Client {
    constructor(options) {
      this.options = options;
      this.pending = pending.shift();
      instances.push(this);
    }

    getSysInfo() {
      return this.pending.promise;
    }

    getPlug({ sysInfo }) {
      return { client: this, sysInfo };
    }
  }
  const Device = loadFreshModule('../drivers/ks225/device.js', {
    homey: { Device: class Device {} },
    'tplink-smarthome-api': { Client },
  });
  const device = new Device();
  const settings = {
    credentialSource: 'global',
    settingIPAddress: '192.0.2.40',
  };
  device.homey = {
    app: {
      getGlobalCredentials() {
        return { username: 'global@example.com', password: 'global password' };
      },
    },
  };
  device.getSettings = () => settings;
  device.log = () => {};

  const first = device.refreshGlobalCredentials({ reason: 'first' });
  const second = device.refreshGlobalCredentials({ reason: 'second' });
  assert.equal(instances.length, 2);
  assert.equal(device.client, instances[1]);

  instances[1].pending.resolve({ model: 'KS225', deviceId: 'newer' });
  assert.equal(await second, true);
  assert.equal(device.plug.client, instances[1]);

  instances[0].pending.resolve({ model: 'KS225', deviceId: 'older' });
  assert.equal(await first, false);
  assert.equal(device.client, instances[1]);
  assert.equal(device.plug.client, instances[1]);
});
