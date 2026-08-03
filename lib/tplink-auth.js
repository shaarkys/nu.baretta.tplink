'use strict';

const SMART_TRANSPORT_BY_MODEL = Object.freeze({
  KS225: 'klap',
  S500D: 'aes',
  KS240: 'aes',
});

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

function getTpLinkClientOptions(model, settings = {}) {
  const transport = SMART_TRANSPORT_BY_MODEL[model];
  if (transport === undefined) {
    throw new Error(`Unsupported TP-Link SMART model: ${model}`);
  }

  const credentials = normalizeTpLinkCredentials(settings);
  return {
    defaultSendOptions: { transport },
    ...(credentials.username && credentials.password ? { credentials } : {}),
  };
}

module.exports = {
  SMART_TRANSPORT_BY_MODEL,
  getTpLinkClientOptions,
  normalizeTpLinkCredentials,
};
