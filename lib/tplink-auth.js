'use strict';

const SMART_TRANSPORT_BY_MODEL = Object.freeze({
  KS225: 'klap',
  S500D: 'aes',
  KS240: 'aes',
});

const VALID_TPLINK_TRANSPORTS = Object.freeze(['tcp', 'klap', 'aes']);

function normalizeTpLinkCredentials(settings = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  return {
    username:
      typeof source.deviceUsername === 'string'
        ? source.deviceUsername.trim()
        : '',
    password:
      typeof source.devicePassword === 'string'
        ? source.devicePassword
        : '',
  };
}

function hasCompleteTpLinkCredentials(settings = {}) {
  const credentials = normalizeTpLinkCredentials(settings);
  return Boolean(credentials.username && credentials.password);
}

function getTpLinkCredentialOptions(settings = {}) {
  const credentials = normalizeTpLinkCredentials(settings);
  return credentials.username && credentials.password ? { credentials } : {};
}

function getTpLinkDiscoveryClientOptions(settings = {}) {
  return getTpLinkCredentialOptions(settings);
}

function isValidTpLinkTransport(transport) {
  return (
    typeof transport === 'string' &&
    VALID_TPLINK_TRANSPORTS.includes(transport)
  );
}

function getEp10Transport(deviceData = {}, settings = {}) {
  const data = deviceData && typeof deviceData === 'object' ? deviceData : {};

  if (isValidTpLinkTransport(data.transport)) {
    return data.transport;
  }

  return hasCompleteTpLinkCredentials(settings) ? 'klap' : 'tcp';
}

function getEp10ClientOptions(deviceData = {}, settings = {}) {
  return {
    defaultSendOptions: { transport: getEp10Transport(deviceData, settings) },
    ...getTpLinkCredentialOptions(settings),
  };
}

function getTpLinkClientOptions(model, settings = {}) {
  const transport = SMART_TRANSPORT_BY_MODEL[model];
  if (transport === undefined) {
    throw new Error(`Unsupported TP-Link SMART model: ${model}`);
  }

  return {
    defaultSendOptions: { transport },
    ...getTpLinkCredentialOptions(settings),
  };
}

module.exports = {
  SMART_TRANSPORT_BY_MODEL,
  VALID_TPLINK_TRANSPORTS,
  getEp10ClientOptions,
  getEp10Transport,
  getTpLinkClientOptions,
  getTpLinkDiscoveryClientOptions,
  hasCompleteTpLinkCredentials,
  isValidTpLinkTransport,
  normalizeTpLinkCredentials,
};
