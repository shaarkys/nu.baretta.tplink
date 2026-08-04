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

function createAppClass(Client = class Client {}) {
  return loadFreshModule('../app.js', {
    homey: { App: class App {} },
    'tplink-smarthome-api': { Client },
  });
}

function createSettings(initial = {}) {
  const values = { ...initial };
  return {
    values,
    get(key) {
      return values[key];
    },
    set(key, value) {
      values[key] = value;
    },
    unset(key) {
      delete values[key];
    },
  };
}

async function createApp({ settings = {}, drivers = {}, Client } = {}) {
  const App = createAppClass(Client);
  const app = new App();
  app.homey = {
    settings: createSettings(settings),
    drivers: {
      getDrivers() {
        return drivers;
      },
    },
  };
  app.log = () => {};
  app.error = () => {};
  await app.onInit();
  return app;
}

test('credential status and private API results never expose the password', async () => {
  const app = await createApp({
    settings: {
      tplinkCredentials: {
        username: 'account@example.com',
        password: 'do-not-return-this-password',
      },
    },
  });
  const api = require('../api');

  const status = await api.getCredentialStatus({ homey: { app } });
  assert.equal(status.configured, true);
  assert.equal(status.usernameHint, 'a***@example.com');
  assert.equal(JSON.stringify(status).includes('do-not-return-this-password'), false);

  const saved = await api.saveCredentials({
    homey: { app },
    body: { username: 'new@example.com', password: 'never-return-this-one' },
  });
  assert.equal(saved.validation.status, 'unverified');
  assert.equal(JSON.stringify(saved).includes('never-return-this-one'), false);
});

test('credential summary omits confirmed TCP EP10s but retains authenticated devices', async () => {
  const createDevice = (id, data, settings) => ({
    getData() {
      return { id, ...data };
    },
    getSettings() {
      return settings;
    },
  });
  const app = await createApp({
    settings: {
      tplinkCredentials: {
        username: 'account@example.com',
        password: 'account password',
      },
    },
    drivers: {
      ep10: {
        id: 'ep10',
        getDevices() {
          return [
            createDevice(
              'tcp-ep10',
              { transport: 'tcp' },
              { credentialSource: 'global' },
            ),
            createDevice(
              'authenticated-ep10',
              { transport: 'klap' },
              { credentialSource: 'global' },
            ),
          ];
        },
      },
      ks225: {
        id: 'ks225',
        getDevices() {
          return [
            createDevice(
              'authenticated-strict-device',
              {},
              { credentialSource: 'global' },
            ),
          ];
        },
      },
    },
  });

  assert.deepEqual((await app.getCredentialStatus()).devices, {
    global: 2,
    override: 0,
    legacy: 0,
    unavailable: 0,
  });
});

test('first authenticated pairing seeds the atomic global pair and later differing pairs stay overrides', async () => {
  const app = await createApp();
  const first = await app.finalizePairingCredentials({
    credentials: { username: 'first@example.com', password: 'first password' },
  });

  assert.equal(first.source, 'global');
  assert.deepEqual(app.homey.settings.values.tplinkCredentials, {
    username: 'first@example.com',
    password: 'first password',
  });
  assert.deepEqual(first.settings, {
    credentialSource: 'global',
    deviceUsername: '',
    devicePassword: '',
  });

  const second = await app.finalizePairingCredentials({
    credentials: { username: 'other@example.com', password: 'other password' },
  });
  assert.equal(second.source, 'override');
  assert.deepEqual(app.homey.settings.values.tplinkCredentials, {
    username: 'first@example.com',
    password: 'first password',
  });
  assert.deepEqual(second.settings, {
    credentialSource: 'override',
    deviceUsername: 'other@example.com',
    devicePassword: 'other password',
  });
});

test('explicit adoption persists global source before clearing matching legacy copies and is idempotent', async () => {
  const settings = {
    settingIPAddress: '192.0.2.20',
    deviceUsername: 'global@example.com',
    devicePassword: 'global password',
  };
  const writes = [];
  let refreshCalls = 0;
  const device = {
    getData() {
      return { id: 'legacy-device' };
    },
    getSettings() {
      return settings;
    },
    async setSettings(update) {
      writes.push(update);
      Object.assign(settings, update);
    },
    async refreshGlobalCredentials() {
      refreshCalls += 1;
      return true;
    },
  };
  const app = await createApp({
    settings: {
      tplinkCredentials: {
        username: 'global@example.com',
        password: 'global password',
      },
    },
    drivers: {
      ks225: {
        id: 'ks225',
        getDevices() {
          return [device];
        },
      },
    },
  });

  const first = await app.adoptMatchingLegacyDevices();
  assert.deepEqual(first.adopted, ['ks225:legacy-device']);
  assert.deepEqual(writes, [
    { credentialSource: 'global' },
    { deviceUsername: '', devicePassword: '' },
  ]);
  assert.equal(refreshCalls, 1);

  const second = await app.adoptMatchingLegacyDevices();
  assert.deepEqual(second.adopted, []);
  assert.deepEqual(second.skipped, ['ks225:legacy-device']);
  assert.equal(refreshCalls, 1);
});

test('a global credential update refreshes global and legacy-fallback devices, but not local overrides', async () => {
  const refreshes = [];
  const createDevice = (id, settings) => ({
    getData() {
      return { id };
    },
    getSettings() {
      return settings;
    },
    async refreshGlobalCredentials(options) {
      refreshes.push({ id, options });
      return true;
    },
  });
  const globalDevice = createDevice('global', {
    settingIPAddress: '192.0.2.41',
    credentialSource: 'global',
  });
  const overrideDevice = createDevice('override', {
    settingIPAddress: '192.0.2.42',
    credentialSource: 'override',
    deviceUsername: 'other@example.com',
    devicePassword: 'other password',
  });
  const legacyLocalDevice = createDevice('legacy-local', {
    settingIPAddress: '192.0.2.43',
    deviceUsername: 'legacy@example.com',
    devicePassword: 'legacy password',
  });
  const legacyFallbackDevice = createDevice('legacy-fallback', {
    settingIPAddress: '192.0.2.44',
  });
  const app = await createApp({
    settings: {
      tplinkCredentials: {
        username: 'old@example.com',
        password: 'old password',
      },
    },
    drivers: {
      ks225: {
        id: 'ks225',
        getDevices() {
          return [
            globalDevice,
            overrideDevice,
            legacyLocalDevice,
            legacyFallbackDevice,
          ];
        },
      },
    },
  });

  const result = await app.saveGlobalCredentials({
    username: 'new@example.com',
    password: 'new password',
  });

  assert.equal(result.validation.status, 'unverified');
  assert.deepEqual(app.homey.settings.values.tplinkCredentials, {
    username: 'new@example.com',
    password: 'new password',
  });
  assert.deepEqual(
    refreshes.map(refresh => refresh.id).sort(),
    ['global', 'legacy-fallback'],
  );
  assert.equal(refreshes.every(refresh => refresh.options.version === 1), true);
});

test('global credential validation tries distinct eligible targets after an inconclusive result', async () => {
  const calls = [];
  class Client {
    constructor(options) {
      this.options = options;
    }

    async getSysInfo(ipAddress) {
      calls.push(ipAddress);
      if (ipAddress === '192.0.2.61') {
        throw new Error('ETIMEDOUT while validating account credentials');
      }
      return { deviceId: ipAddress };
    }
  }
  const createDevice = (id, ipAddress) => ({
    getData() {
      return { id };
    },
    getSettings() {
      return {
        settingIPAddress: ipAddress,
        credentialSource: 'global',
      };
    },
  });
  const app = await createApp({
    Client,
    drivers: {
      ks240: {
        id: 'ks240',
        getDevices() {
          return [
            createDevice('ks240-light', '192.0.2.61'),
            createDevice('ks240-fan', '192.0.2.61'),
          ];
        },
      },
      ks225: {
        id: 'ks225',
        getDevices() {
          return [createDevice('ks225', '192.0.2.62')];
        },
      },
    },
  });

  const result = await app.validateGlobalCredentials({
    username: 'account@example.com',
    password: 'password',
  });

  assert.equal(result.status, 'validated');
  assert.deepEqual(calls, ['192.0.2.61', '192.0.2.62']);
});

test('a fulfilled false global refresh is reported as failed', async () => {
  const device = {
    getData() {
      return { id: 'global-device' };
    },
    getSettings() {
      return {
        settingIPAddress: '192.0.2.70',
        credentialSource: 'global',
      };
    },
    async refreshGlobalCredentials() {
      return false;
    },
  };
  const app = await createApp({
    drivers: {
      ks225: {
        id: 'ks225',
        getDevices() {
          return [device];
        },
      },
    },
  });

  assert.deepEqual(
    await app.refreshDevicesUsingGlobalCredentials({ reason: 'test' }),
    { attempted: 1, refreshed: 0, failed: 1 },
  );
});

test('an unmarked pre-transport EP10 is not selected for global auth validation or refresh', async () => {
  let refreshCalls = 0;
  const device = {
    getData() {
      return { id: 'legacy-ep10' };
    },
    getSettings() {
      return { settingIPAddress: '192.0.2.71' };
    },
    async refreshGlobalCredentials() {
      refreshCalls += 1;
      return true;
    },
  };
  const app = await createApp({
    settings: {
      tplinkCredentials: {
        username: 'account@example.com',
        password: 'password',
      },
    },
    drivers: {
      ep10: {
        id: 'ep10',
        getDevices() {
          return [device];
        },
      },
    },
  });
  const entry = app.getManagedDevices()[0];

  assert.equal(
    app.isEligibleValidationDevice(entry, {
      username: 'account@example.com',
      password: 'password',
    }),
    false,
  );
  assert.deepEqual(
    await app.refreshDevicesUsingGlobalCredentials({ reason: 'test' }),
    { attempted: 0, refreshed: 0, failed: 0 },
  );
  assert.equal(refreshCalls, 0);
});

test('an explicitly global pre-transport EP10 refreshes when the global pair is cleared', async () => {
  let refreshCalls = 0;
  const device = {
    getData() {
      return { id: 'global-ep10' };
    },
    getSettings() {
      return {
        settingIPAddress: '192.0.2.72',
        credentialSource: 'global',
      };
    },
    async refreshGlobalCredentials() {
      refreshCalls += 1;
      return true;
    },
  };
  const app = await createApp({
    drivers: {
      ep10: {
        id: 'ep10',
        getDevices() {
          return [device];
        },
      },
    },
  });

  assert.deepEqual(
    await app.refreshDevicesUsingGlobalCredentials({ reason: 'global cleared' }),
    { attempted: 1, refreshed: 1, failed: 0 },
  );
  assert.equal(refreshCalls, 1);
});
