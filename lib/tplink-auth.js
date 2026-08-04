'use strict';

const {
  CREDENTIAL_SOURCES,
  getCredentialSource,
  getEffectiveDeviceSettings,
  hasCompleteCredentials,
  normalizeCredentialPair,
  resolveDeviceCredentials,
} = require('./tplink-credentials');

const SMART_TRANSPORT_BY_MODEL = Object.freeze({
  KS225: 'klap',
  S500D: 'aes',
  KS240: 'aes',
});

const VALID_TPLINK_TRANSPORTS = Object.freeze(['tcp', 'klap', 'aes']);

function normalizeTpLinkCredentials(settings = {}) {
  return normalizeCredentialPair(settings);
}

function hasCompleteTpLinkCredentials(settings = {}) {
  return hasCompleteCredentials(settings);
}

function getTpLinkCredentialOptions(settings = {}, globalCredentials = null) {
  const credentials = resolveDeviceCredentials(settings, globalCredentials).credentials;
  return credentials ? { credentials } : {};
}

function getTpLinkDiscoveryClientOptions(settings = {}, globalCredentials = null) {
  return getTpLinkCredentialOptions(settings, globalCredentials);
}

function isValidTpLinkTransport(transport) {
  return (
    typeof transport === 'string' &&
    VALID_TPLINK_TRANSPORTS.includes(transport)
  );
}

function getEp10Transport(deviceData = {}, settings = {}, globalCredentials = null) {
  const data = deviceData && typeof deviceData === 'object' ? deviceData : {};

  if (isValidTpLinkTransport(data.transport)) {
    return data.transport;
  }

  const source = getCredentialSource(settings);
  const resolved = resolveDeviceCredentials(settings, globalCredentials);

  // Pre-transport EP10 pairings were TCP. Do not silently change an unmarked,
  // credential-empty legacy device merely because an app-wide account is added.
  if (
    (source === CREDENTIAL_SOURCES.GLOBAL || source === CREDENTIAL_SOURCES.OVERRIDE) &&
    resolved.credentials
  ) {
    return 'klap';
  }

  if (!source && hasCompleteCredentials(settings)) {
    return 'klap';
  }

  return 'tcp';
}

function getEp10ClientOptions(deviceData = {}, settings = {}, globalCredentials = null) {
  const transport = getEp10Transport(deviceData, settings, globalCredentials);
  return {
    defaultSendOptions: { transport },
    ...(transport === 'tcp'
      ? {}
      : getTpLinkCredentialOptions(settings, globalCredentials)),
  };
}

function getTpLinkClientOptions(model, settings = {}, globalCredentials = null) {
  const transport = SMART_TRANSPORT_BY_MODEL[model];
  if (transport === undefined) {
    throw new Error(`Unsupported TP-Link SMART model: ${model}`);
  }

  return {
    defaultSendOptions: { transport },
    ...getTpLinkCredentialOptions(settings, globalCredentials),
  };
}

module.exports = {
  SMART_TRANSPORT_BY_MODEL,
  VALID_TPLINK_TRANSPORTS,
  getEp10ClientOptions,
  getEp10Transport,
  getTpLinkClientOptions,
  getTpLinkDiscoveryClientOptions,
  getEffectiveDeviceSettings,
  hasCompleteTpLinkCredentials,
  isValidTpLinkTransport,
  normalizeTpLinkCredentials,
};
