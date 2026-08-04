'use strict';

const Homey = require('homey');
const { Client } = require('tplink-smarthome-api');
const {
  getEp10ClientOptions,
  getEp10Transport,
  getTpLinkClientOptions,
} = require('./lib/tplink-auth');
const {
  CREDENTIAL_SOURCES,
  GLOBAL_CREDENTIALS_KEY,
  assertValidCredentialPair,
  credentialsMatch,
  getCredentialSource,
  getEffectiveDeviceSettings,
  getManualCredentialTransition,
  getPairedCredentialSettings,
  getSafeErrorMessage,
  hasCompleteCredentials,
  isAuthenticationError,
  isReachabilityError,
  maskUsername,
  normalizeCredentialPair,
  resolveDeviceCredentials,
  resolvePairingCredentials,
} = require('./lib/tplink-credentials');

const AUTHENTICATED_DRIVER_IDS = new Set(['ks225', 's500d', 'ks240']);
const MANAGED_DRIVER_IDS = new Set([...AUTHENTICATED_DRIVER_IDS, 'ep10']);
const CREDENTIAL_VALIDATION_TIMEOUT = 4000;

function getDriverId(driver, fallbackId) {
  if (driver && typeof driver.id === 'string') return driver.id;
  return fallbackId;
}

function getDeviceIpAddress(settings = {}) {
  return typeof settings.settingIPAddress === 'string'
    ? settings.settingIPAddress.trim()
    : '';
}

function createCredentialValidationClient(driverId, device, credentials) {
  const settings = {
    deviceUsername: credentials.username,
    devicePassword: credentials.password,
    credentialSource: CREDENTIAL_SOURCES.OVERRIDE,
  };
  const options =
    driverId === 'ep10'
      ? getEp10ClientOptions(device.getData(), settings)
      : getTpLinkClientOptions(driverId.toUpperCase(), settings);

  options.defaultSendOptions.timeout = CREDENTIAL_VALIDATION_TIMEOUT;
  return new Client(options);
}

class TpLinkApp extends Homey.App {
  async onInit() {
    this._credentialMutation = Promise.resolve();
    this._globalCredentialRefreshVersion = 0;
    this.log('TP-Link credential source management initialized');
  }

  getGlobalCredentials() {
    const stored = this.homey.settings.get(GLOBAL_CREDENTIALS_KEY);
    return hasCompleteCredentials(stored) ? normalizeCredentialPair(stored) : null;
  }

  resolveDeviceCredentials(settings = {}) {
    return resolveDeviceCredentials(settings, this.getGlobalCredentials());
  }

  getEffectiveDeviceSettings(settings = {}) {
    return getEffectiveDeviceSettings(settings, this.getGlobalCredentials());
  }

  getManualDeviceCredentialTransition(settings = {}) {
    return getManualCredentialTransition(settings, this.getGlobalCredentials());
  }

  resolvePairingCredentials(input = {}) {
    return resolvePairingCredentials(input, this.getGlobalCredentials());
  }

  async finalizePairingCredentials(pairingResolution) {
    if (!pairingResolution || !pairingResolution.credentials) {
      throw new Error('TP-Link pairing credentials were not resolved.');
    }

    return this.withCredentialMutation(async () => {
      const currentGlobal = this.getGlobalCredentials();
      let resolved;

      if (!currentGlobal) {
        this.homey.settings.set(GLOBAL_CREDENTIALS_KEY, {
          username: pairingResolution.credentials.username,
          password: pairingResolution.credentials.password,
        });
        this._globalCredentialRefreshVersion += 1;
        resolved = {
          credentials: pairingResolution.credentials,
          source: CREDENTIAL_SOURCES.GLOBAL,
          seedGlobal: true,
        };
      } else if (credentialsMatch(currentGlobal, pairingResolution.credentials)) {
        resolved = {
          credentials: currentGlobal,
          source: CREDENTIAL_SOURCES.GLOBAL,
          seedGlobal: false,
        };
      } else {
        resolved = {
          credentials: pairingResolution.credentials,
          source: CREDENTIAL_SOURCES.OVERRIDE,
          seedGlobal: false,
        };
      }

      if (resolved.seedGlobal) {
        await this.refreshDevicesUsingGlobalCredentials({
          reason: 'pairing seed',
          force: true,
        });
      }

      return {
        ...resolved,
        settings: getPairedCredentialSettings(resolved),
      };
    });
  }

  async getCredentialStatus() {
    const globalCredentials = this.getGlobalCredentials();
    const summary = this.getCredentialDeviceSummary(globalCredentials);

    return {
      configured: Boolean(globalCredentials),
      usernameHint: globalCredentials ? maskUsername(globalCredentials.username) : '',
      devices: summary,
    };
  }

  async saveGlobalCredentials(input = {}) {
    const credentials = assertValidCredentialPair(input);

    return this.withCredentialMutation(async () => {
      const validation = await this.validateGlobalCredentials(credentials);
      if (validation.status === 'rejected') {
        throw new Error(
          'The selected TP-Link device rejected these account credentials. The global credentials were not changed.',
        );
      }

      this.homey.settings.set(GLOBAL_CREDENTIALS_KEY, {
        username: credentials.username,
        password: credentials.password,
      });
      this._globalCredentialRefreshVersion += 1;
      const refreshed = await this.refreshDevicesUsingGlobalCredentials({
        reason: 'global credentials updated',
        force: true,
      });

      this.log(`TP-Link global credentials saved (${validation.status})`);
      return {
        saved: true,
        validation,
        refreshed,
        status: await this.getCredentialStatus(),
      };
    });
  }

  async clearGlobalCredentials() {
    return this.withCredentialMutation(async () => {
      this.homey.settings.unset(GLOBAL_CREDENTIALS_KEY);
      this._globalCredentialRefreshVersion += 1;
      const refreshed = await this.refreshDevicesUsingGlobalCredentials({
        reason: 'global credentials cleared',
        force: true,
      });

      this.log('TP-Link global credentials cleared');
      return {
        cleared: true,
        refreshed,
        status: await this.getCredentialStatus(),
      };
    });
  }

  async adoptMatchingLegacyDevices() {
    return this.withCredentialMutation(async () => {
      const globalCredentials = this.getGlobalCredentials();
      if (!globalCredentials) {
        throw new Error(
          'Save complete global TP-Link account credentials before adopting legacy devices.',
        );
      }

      const adopted = [];
      const skipped = [];
      const failed = [];

      for (const entry of this.getManagedDevices()) {
        const settings = entry.device.getSettings();
        const source = getCredentialSource(settings);
        const hasMatchingLocalPair = credentialsMatch(settings, globalCredentials);

        if (source === CREDENTIAL_SOURCES.OVERRIDE || !hasMatchingLocalPair) {
          skipped.push(entry.key);
          continue;
        }

        try {
          // Persist the global source first. Programmatic setSettings does not call
          // onSettings, so refresh the client explicitly after clearing the copy.
          await entry.device.setSettings({
            credentialSource: CREDENTIAL_SOURCES.GLOBAL,
          });
          await entry.device.setSettings({
            deviceUsername: '',
            devicePassword: '',
          });
          if (typeof entry.device.refreshGlobalCredentials === 'function') {
            await entry.device.refreshGlobalCredentials({
              force: true,
              version: this._globalCredentialRefreshVersion,
              reason: 'legacy credentials adopted',
            });
          }
          adopted.push(entry.key);
        } catch (error) {
          failed.push(entry.key);
          this.error(
            `Unable to adopt credentials for ${entry.driverId} device: ${getSafeErrorMessage(
              error,
              globalCredentials,
              settings,
            )}`,
          );
        }
      }

      return {
        adopted,
        skipped,
        failed,
        status: await this.getCredentialStatus(),
      };
    });
  }

  async validateGlobalCredentials(credentials) {
    const candidates = [];
    const seenTargets = new Set();
    this.getManagedDevices().forEach(entry => {
      if (!this.isEligibleValidationDevice(entry, credentials)) return;

      const settings = entry.device.getSettings();
      const ipAddress = getDeviceIpAddress(settings);
      // KS240 child channels share one authenticated parent target. More
      // generally, avoid retrying the same model/IP pair during one save.
      const targetKey = `${entry.driverId}:${ipAddress}`;
      if (seenTargets.has(targetKey)) return;
      seenTargets.add(targetKey);
      candidates.push({ entry, settings, ipAddress });
    });

    if (candidates.length === 0) {
      return {
        status: 'unverified',
        reason: 'No eligible paired authenticated device is available for local validation.',
      };
    }

    let sawReachabilityError = false;
    for (const candidate of candidates) {
      try {
        const client = createCredentialValidationClient(
          candidate.entry.driverId,
          candidate.entry.device,
          credentials,
        );
        await client.getSysInfo(candidate.ipAddress);
        return {
          status: 'validated',
          reason: 'Validated locally against a paired TP-Link device.',
        };
      } catch (error) {
        if (isAuthenticationError(error) && !isReachabilityError(error)) {
          return {
            status: 'rejected',
            reason: 'The paired TP-Link device rejected the account credentials.',
          };
        }

        if (isReachabilityError(error)) sawReachabilityError = true;
        this.log(
          `TP-Link global credential validation was inconclusive for ${candidate.entry.driverId}: ${getSafeErrorMessage(
            error,
            credentials,
          )}`,
        );
      }
    }

    return {
      status: 'unverified',
      reason: sawReachabilityError
        ? 'All eligible paired TP-Link devices were offline or timed out.'
        : 'All eligible paired TP-Link devices could not provide conclusive local validation.',
    };
  }

  getManagedDevices() {
    if (!this.homey.drivers || typeof this.homey.drivers.getDrivers !== 'function') {
      return [];
    }

    const drivers = this.homey.drivers.getDrivers();
    const entries = [];
    Object.entries(drivers).forEach(([fallbackId, driver]) => {
      const driverId = getDriverId(driver, fallbackId);
      if (!MANAGED_DRIVER_IDS.has(driverId) || !driver) return;

      let devices = [];
      try {
        devices = driver.getDevices();
      } catch (error) {
        this.error(`Unable to list ${driverId} devices: ${getSafeErrorMessage(error)}`);
      }

      devices.forEach((device, index) => {
        const data = device.getData ? device.getData() : {};
        entries.push({
          driverId,
          device,
          key: `${driverId}:${data.id || index}`,
        });
      });
    });
    return entries;
  }

  getCredentialDeviceSummary(globalCredentials = this.getGlobalCredentials()) {
    const summary = {
      global: 0,
      override: 0,
      legacy: 0,
      unavailable: 0,
    };

    this.getManagedDevices().forEach(entry => {
      // A persisted TCP transport is a confirmed credential-free EP10. Do not
      // present it in the account-source summary, even if old settings contain
      // a stale source marker.
      if (
        entry.driverId === 'ep10' &&
        entry.device.getData().transport === 'tcp'
      ) {
        return;
      }
      const settings = entry.device.getSettings();
      const resolved = resolveDeviceCredentials(settings, globalCredentials);
      if (!resolved.credentials) {
        summary.unavailable += 1;
      } else if (resolved.source === CREDENTIAL_SOURCES.GLOBAL) {
        summary.global += 1;
      } else if (resolved.source === CREDENTIAL_SOURCES.OVERRIDE) {
        summary.override += 1;
      } else {
        summary.legacy += 1;
      }
    });
    return summary;
  }

  isEligibleValidationDevice(entry, credentials) {
    const settings = entry.device.getSettings();
    const ipAddress = getDeviceIpAddress(settings);
    if (!ipAddress) return false;

    const source = getCredentialSource(settings);
    if (source === CREDENTIAL_SOURCES.OVERRIDE) return false;
    if (!source && hasCompleteCredentials(settings) && !credentialsMatch(settings, credentials)) {
      return false;
    }

    if (AUTHENTICATED_DRIVER_IDS.has(entry.driverId)) return true;
    if (entry.driverId !== 'ep10') return false;

    const data = entry.device.getData();
    return getEp10Transport(data, settings, credentials) !== 'tcp';
  }

  shouldRefreshGlobalCredentials(entry) {
    const settings = entry.device.getSettings();
    const source = getCredentialSource(settings);
    if (source === CREDENTIAL_SOURCES.OVERRIDE) return false;

    // Unmarked devices with their own complete legacy pair keep that pair until
    // the user explicitly adopts them. Pre-transport, credential-empty EP10s
    // also remain TCP and must not be refreshed with a new global account.
    if (!source && hasCompleteCredentials(settings)) return false;

    if (entry.driverId !== 'ep10') return true;
    const data = entry.device.getData();
    // A source marker keeps this pre-transport device linked to the global
    // account. On a global clear it must still refresh so its in-memory KLAP
    // client is replaced by the resulting TCP fallback.
    if (source === CREDENTIAL_SOURCES.GLOBAL && data.transport !== 'tcp') {
      return true;
    }
    return getEp10Transport(data, settings, this.getGlobalCredentials()) !== 'tcp';
  }

  async refreshDevicesUsingGlobalCredentials({ reason, force } = {}) {
    const version = this._globalCredentialRefreshVersion;
    const entries = this.getManagedDevices().filter(entry =>
      this.shouldRefreshGlobalCredentials(entry),
    );
    const results = await Promise.allSettled(
      entries.map(async entry => {
        if (typeof entry.device.refreshGlobalCredentials !== 'function') {
          return false;
        }
        return entry.device.refreshGlobalCredentials({ reason, force, version });
      }),
    );

    return {
      attempted: entries.length,
      refreshed: results.filter(result => result.status === 'fulfilled' && result.value)
        .length,
      failed: results.filter(
        result => result.status !== 'fulfilled' || result.value !== true,
      ).length,
    };
  }

  async withCredentialMutation(operation) {
    const previous = this._credentialMutation || Promise.resolve();
    let release;
    this._credentialMutation = new Promise(resolve => {
      release = resolve;
    });

    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

module.exports = TpLinkApp;
