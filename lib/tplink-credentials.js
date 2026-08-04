'use strict';

const GLOBAL_CREDENTIALS_KEY = 'tplinkCredentials';
const DEVICE_CREDENTIAL_SOURCE_SETTING = 'credentialSource';

const CREDENTIAL_SOURCES = Object.freeze({
  GLOBAL: 'global',
  OVERRIDE: 'override',
});

const MAX_USERNAME_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 1024;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const AUTHENTICATION_ERROR_CODES = new Set([
  -40412,
  -1501,
  -1005,
  1003,
  1100,
  1111,
]);

function getObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function getCredentialValues(value = {}) {
  const source = getObject(value);
  return {
    username:
      typeof source.username === 'string'
        ? source.username
        : typeof source.deviceUsername === 'string'
          ? source.deviceUsername
          : '',
    password:
      typeof source.password === 'string'
        ? source.password
        : typeof source.devicePassword === 'string'
          ? source.devicePassword
          : '',
  };
}

function normalizeCredentialPair(value = {}) {
  const credentials = getCredentialValues(value);
  return {
    username: credentials.username.trim(),
    password: credentials.password,
  };
}

function hasCredentialInput(value = {}) {
  const credentials = normalizeCredentialPair(value);
  return credentials.username.length > 0 || credentials.password.length > 0;
}

function hasCompleteCredentials(value = {}) {
  const credentials = normalizeCredentialPair(value);
  return credentials.username.length > 0 && credentials.password.length > 0;
}

function validateCredentialPair(value = {}, { required = true } = {}) {
  const rawCredentials = getCredentialValues(value);
  if (
    CONTROL_CHARACTER_PATTERN.test(rawCredentials.username) ||
    CONTROL_CHARACTER_PATTERN.test(rawCredentials.password)
  ) {
    return {
      valid: false,
      error: 'The TP-Link account credentials contain unsupported characters.',
    };
  }

  const credentials = normalizeCredentialPair(value);
  const hasInput = hasCredentialInput(value);

  if (!hasInput && !required) {
    return { valid: true, credentials: null };
  }

  if (!credentials.username || !credentials.password) {
    return {
      valid: false,
      error: 'Enter both the TP-Link account username and password.',
    };
  }

  if (
    credentials.username.length > MAX_USERNAME_LENGTH ||
    credentials.password.length > MAX_PASSWORD_LENGTH
  ) {
    return {
      valid: false,
      error: 'The TP-Link account credentials are too long.',
    };
  }

  return { valid: true, credentials };
}

function assertValidCredentialPair(value = {}, options = {}) {
  const result = validateCredentialPair(value, options);
  if (!result.valid) {
    throw new Error(result.error);
  }
  return result.credentials;
}

function credentialsMatch(left, right) {
  const normalizedLeft = normalizeCredentialPair(left);
  const normalizedRight = normalizeCredentialPair(right);
  return (
    hasCompleteCredentials(normalizedLeft) &&
    hasCompleteCredentials(normalizedRight) &&
    normalizedLeft.username === normalizedRight.username &&
    normalizedLeft.password === normalizedRight.password
  );
}

function getCredentialSource(settings = {}) {
  const source = getObject(settings)[DEVICE_CREDENTIAL_SOURCE_SETTING];
  return Object.values(CREDENTIAL_SOURCES).includes(source) ? source : null;
}

function resolveDeviceCredentials(settings = {}, globalCredentials = null) {
  const localCredentials = hasCompleteCredentials(settings)
    ? normalizeCredentialPair(settings)
    : null;
  const completeGlobalCredentials = hasCompleteCredentials(globalCredentials)
    ? normalizeCredentialPair(globalCredentials)
    : null;
  const source = getCredentialSource(settings);

  if (source === CREDENTIAL_SOURCES.GLOBAL) {
    return {
      source,
      credentials: completeGlobalCredentials,
      usesGlobalCredentials: Boolean(completeGlobalCredentials),
      isLegacy: false,
    };
  }

  if (source === CREDENTIAL_SOURCES.OVERRIDE) {
    return {
      source,
      credentials: localCredentials,
      usesGlobalCredentials: false,
      isLegacy: false,
    };
  }

  if (localCredentials) {
    return {
      source: 'legacy',
      credentials: localCredentials,
      usesGlobalCredentials: false,
      isLegacy: true,
    };
  }

  return {
    source: 'legacy',
    credentials: completeGlobalCredentials,
    usesGlobalCredentials: Boolean(completeGlobalCredentials),
    isLegacy: true,
  };
}

function getEffectiveDeviceSettings(settings = {}, globalCredentials = null) {
  const resolved = resolveDeviceCredentials(settings, globalCredentials);
  return {
    ...getObject(settings),
    deviceUsername: resolved.credentials ? resolved.credentials.username : '',
    devicePassword: resolved.credentials ? resolved.credentials.password : '',
  };
}

function resolvePairingCredentials(input = {}, globalCredentials = null) {
  const supplied = assertValidCredentialPair(input, { required: false });
  const global = hasCompleteCredentials(globalCredentials)
    ? normalizeCredentialPair(globalCredentials)
    : null;

  if (supplied) {
    if (global && credentialsMatch(supplied, global)) {
      return {
        credentials: global,
        source: CREDENTIAL_SOURCES.GLOBAL,
        seedGlobal: false,
      };
    }

    if (global) {
      return {
        credentials: supplied,
        source: CREDENTIAL_SOURCES.OVERRIDE,
        seedGlobal: false,
      };
    }

    return {
      credentials: supplied,
      source: CREDENTIAL_SOURCES.GLOBAL,
      seedGlobal: true,
    };
  }

  if (global) {
    return {
      credentials: global,
      source: CREDENTIAL_SOURCES.GLOBAL,
      seedGlobal: false,
    };
  }

  throw new Error(
    'TP-Link account credentials are required for this authenticated device.',
  );
}

function getPairedCredentialSettings(pairingResolution) {
  if (!pairingResolution || !pairingResolution.source) {
    throw new Error('TP-Link pairing credentials were not resolved.');
  }

  if (pairingResolution.source === CREDENTIAL_SOURCES.OVERRIDE) {
    return {
      [DEVICE_CREDENTIAL_SOURCE_SETTING]: CREDENTIAL_SOURCES.OVERRIDE,
      deviceUsername: pairingResolution.credentials.username,
      devicePassword: pairingResolution.credentials.password,
    };
  }

  return {
    [DEVICE_CREDENTIAL_SOURCE_SETTING]: CREDENTIAL_SOURCES.GLOBAL,
    deviceUsername: '',
    devicePassword: '',
  };
}

function getManualCredentialTransition(settings = {}, globalCredentials = null) {
  const supplied = assertValidCredentialPair(settings, { required: false });
  if (supplied) {
    return {
      source: CREDENTIAL_SOURCES.OVERRIDE,
      credentials: supplied,
      settings: {
        [DEVICE_CREDENTIAL_SOURCE_SETTING]: CREDENTIAL_SOURCES.OVERRIDE,
        deviceUsername: supplied.username,
        devicePassword: supplied.password,
      },
    };
  }

  const global = hasCompleteCredentials(globalCredentials)
    ? normalizeCredentialPair(globalCredentials)
    : null;
  return {
    source: CREDENTIAL_SOURCES.GLOBAL,
    credentials: global,
    settings: {
      [DEVICE_CREDENTIAL_SOURCE_SETTING]: CREDENTIAL_SOURCES.GLOBAL,
      deviceUsername: '',
      devicePassword: '',
    },
  };
}

function maskUsername(value = '') {
  const username = normalizeCredentialPair({ username: value }).username;
  if (!username) return '';

  const atIndex = username.indexOf('@');
  if (atIndex > 0) {
    return `${username.slice(0, 1)}***${username.slice(atIndex)}`;
  }

  return `${username.slice(0, 1)}***`;
}

function getSafeErrorMessage(error, ...credentialValues) {
  let message =
    error && typeof error.message === 'string' ? error.message : 'Unknown error';

  credentialValues
    .flatMap(value => {
      const credentials = normalizeCredentialPair(value);
      return [credentials.username, credentials.password];
    })
    .filter(value => value.length > 0)
    .forEach(secret => {
      message = message.split(secret).join('[redacted]');
    });

  return message;
}

function isAuthenticationError(error) {
  if (error && AUTHENTICATION_ERROR_CODES.has(error.errorCode)) {
    return true;
  }

  const message = error && typeof error.message === 'string' ? error.message : '';
  return /auth(?:entication)?|credential|login|password|username|unauthori[sz]ed|forbidden/i.test(
    message,
  );
}

function isReachabilityError(error) {
  const message = error && typeof error.message === 'string' ? error.message : '';
  return /EHOSTUNREACH|ETIMEDOUT|ENETUNREACH|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|timeout|timed out/i.test(
    message,
  );
}

module.exports = {
  AUTHENTICATION_ERROR_CODES,
  CREDENTIAL_SOURCES,
  DEVICE_CREDENTIAL_SOURCE_SETTING,
  GLOBAL_CREDENTIALS_KEY,
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  assertValidCredentialPair,
  credentialsMatch,
  getCredentialSource,
  getEffectiveDeviceSettings,
  getManualCredentialTransition,
  getPairedCredentialSettings,
  getSafeErrorMessage,
  hasCompleteCredentials,
  hasCredentialInput,
  isAuthenticationError,
  isReachabilityError,
  maskUsername,
  normalizeCredentialPair,
  resolveDeviceCredentials,
  resolvePairingCredentials,
  validateCredentialPair,
};
