'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CREDENTIAL_SOURCES,
  assertValidCredentialPair,
  getManualCredentialTransition,
  getPairedCredentialSettings,
  resolveDeviceCredentials,
  resolvePairingCredentials,
  validateCredentialPair,
} = require('../lib/tplink-credentials');

const GLOBAL = {
  username: ' global@example.com ',
  password: ' global password ',
};

test('credential validation trims only usernames and rejects partial or control-character pairs', () => {
  assert.deepEqual(assertValidCredentialPair(GLOBAL), {
    username: 'global@example.com',
    password: ' global password ',
  });
  assert.equal(validateCredentialPair({ username: 'user@example.com' }).valid, false);
  assert.equal(
    validateCredentialPair({ username: 'user@example.com', password: 'line\nbreak' }).valid,
    false,
  );
  assert.equal(
    validateCredentialPair({ username: 'user@example.com\n', password: 'password' }).valid,
    false,
  );
  assert.throws(
    () => assertValidCredentialPair({ username: ' ', password: 'password' }),
    /Enter both/,
  );
});

test('credential-source resolution keeps global, override, and unmarked legacy rules separate', () => {
  const global = { username: 'global@example.com', password: 'global' };

  assert.deepEqual(
    resolveDeviceCredentials(
      {
        credentialSource: CREDENTIAL_SOURCES.GLOBAL,
        deviceUsername: 'local@example.com',
        devicePassword: 'local',
      },
      global,
    ),
    {
      source: CREDENTIAL_SOURCES.GLOBAL,
      credentials: global,
      usesGlobalCredentials: true,
      isLegacy: false,
    },
  );
  assert.deepEqual(
    resolveDeviceCredentials(
      { credentialSource: CREDENTIAL_SOURCES.OVERRIDE, deviceUsername: 'local@example.com' },
      global,
    ),
    {
      source: CREDENTIAL_SOURCES.OVERRIDE,
      credentials: null,
      usesGlobalCredentials: false,
      isLegacy: false,
    },
  );
  assert.deepEqual(
    resolveDeviceCredentials(
      { deviceUsername: 'local@example.com', devicePassword: 'local' },
      global,
    ),
    {
      source: 'legacy',
      credentials: { username: 'local@example.com', password: 'local' },
      usesGlobalCredentials: false,
      isLegacy: true,
    },
  );
  assert.deepEqual(resolveDeviceCredentials({}, global), {
    source: 'legacy',
    credentials: global,
    usesGlobalCredentials: true,
    isLegacy: true,
  });
});

test('pairing seeds an empty global account, and a differing account becomes only a device override', () => {
  const firstPair = resolvePairingCredentials(
    { deviceUsername: ' first@example.com ', devicePassword: 'first password' },
    null,
  );
  assert.equal(firstPair.source, CREDENTIAL_SOURCES.GLOBAL);
  assert.equal(firstPair.seedGlobal, true);
  assert.deepEqual(getPairedCredentialSettings(firstPair), {
    credentialSource: CREDENTIAL_SOURCES.GLOBAL,
    deviceUsername: '',
    devicePassword: '',
  });

  const override = resolvePairingCredentials(
    { deviceUsername: 'other@example.com', devicePassword: 'other password' },
    { username: 'first@example.com', password: 'first password' },
  );
  assert.equal(override.source, CREDENTIAL_SOURCES.OVERRIDE);
  assert.equal(override.seedGlobal, false);
  assert.deepEqual(getPairedCredentialSettings(override), {
    credentialSource: CREDENTIAL_SOURCES.OVERRIDE,
    deviceUsername: 'other@example.com',
    devicePassword: 'other password',
  });
});

test('manual device credential changes explicitly select override or return to global', () => {
  assert.deepEqual(
    getManualCredentialTransition({
      deviceUsername: 'other@example.com',
      devicePassword: 'password',
    }),
    {
      source: CREDENTIAL_SOURCES.OVERRIDE,
      credentials: { username: 'other@example.com', password: 'password' },
      settings: {
        credentialSource: CREDENTIAL_SOURCES.OVERRIDE,
        deviceUsername: 'other@example.com',
        devicePassword: 'password',
      },
    },
  );
  assert.deepEqual(
    getManualCredentialTransition(
      { deviceUsername: '', devicePassword: '' },
      { username: 'global@example.com', password: 'password' },
    ),
    {
      source: CREDENTIAL_SOURCES.GLOBAL,
      credentials: { username: 'global@example.com', password: 'password' },
      settings: {
        credentialSource: CREDENTIAL_SOURCES.GLOBAL,
        deviceUsername: '',
        devicePassword: '',
      },
    },
  );
});
