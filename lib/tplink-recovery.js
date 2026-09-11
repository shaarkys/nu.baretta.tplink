'use strict';

const { isIP } = require('node:net');
const { getSafeErrorMessage, isAuthenticationError, isReachabilityError } = require('./tplink-credentials');

const RETRY_MS = 60000;
const DISCOVERY_MS = 5000;
const CONNECTION_SETTINGS = new Set([
  'settingIPAddress', 'dynamicIp', 'deviceUsername', 'devicePassword', 'credentialSource',
]);

class TpLinkRecovery {
  constructor(device) {
    this.device = device;
    this.generation = 0;
    this.deleted = false;
    this.pendingPoll = null;
    this.pendingSave = null;
    this.scan = null;
    this.lastDiscoveryAt = null;
  }

  globalCredentials() {
    const app = this.device.homey && this.device.homey.app;
    return app && typeof app.getGlobalCredentials === 'function' ? app.getGlobalCredentials() : null;
  }

  logError(context, error, settings, credentials) {
    this.device.log(context + ': ' + getSafeErrorMessage(
      error, settings, credentials, this.device.getSettings(), this.globalCredentials(),
    ));
  }

  initialize() {
    this.cancel();
    this.deleted = false;
  }

  cancel() {
    this.generation++;
    this.stopDiscovery();
    this.device.unreachableCount = 0;
    this.device.discoverCount = 0;
    this.lastDiscoveryAt = null;
  }

  destroy() {
    this.deleted = true;
    this.cancel();
  }

  async settingsChanged(changedKeys = []) {
    if (!changedKeys.some(key => CONNECTION_SETTINGS.has(key))) return;
    this.cancel();
    // Finish a previously issued IP write before Homey commits the user's settings.
    if (this.pendingSave) await this.pendingSave.catch(() => {});
  }

  beginPoll() {
    if (this.deleted || this.pendingPoll) return null;
    const poll = {
      generation: this.generation,
      ip: this.device.getSettings().settingIPAddress,
      client: this.device.client,
      responded: false,
    };
    this.pendingPoll = poll;
    return poll;
  }

  isCurrent(poll) {
    return !this.deleted && poll.generation === this.generation &&
      poll.ip === this.device.getSettings().settingIPAddress && poll.client === this.device.client;
  }

  responded(poll) {
    if (!this.isCurrent(poll)) return false;
    poll.responded = true;
    return true;
  }

  endPoll(poll) {
    if (this.pendingPoll === poll) this.pendingPoll = null;
  }

  async succeeded(poll) {
    if (!this.isCurrent(poll)) return;
    this.device.unreachableCount = 0;
    this.device.discoverCount = 0;
    this.lastDiscoveryAt = null;
    this.stopDiscovery();
    if (!this.device.getAvailable()) {
      try {
        await this.device.setAvailable();
      } catch (error) {
        this.logError('Unable to restore device availability', error);
      }
    }
  }

  async failed(poll, error) {
    // The optional token preserves legacy handleErrors() callers.
    poll = poll || { generation: this.generation, ip: this.device.getSettings().settingIPAddress,
      client: this.device.client, responded: false };
    if (!this.isCurrent(poll)) return;
    this.logError('Status polling failed', error);
    const networkError = { message: `${error && error.code || ''} ${error && error.message || ''}` };
    if (poll.responded || isAuthenticationError(error) || !isReachabilityError(networkError)) return;
    this.device.unreachableCount = (this.device.unreachableCount || 0) + 1;
    if (!this.device.getSettings().dynamicIp || this.device.unreachableCount < 3 || this.scan ||
        (this.lastDiscoveryAt !== null && Date.now() - this.lastDiscoveryAt < RETRY_MS)) return;
    this.lastDiscoveryAt = Date.now();
    try {
      await this.device.setUnavailable('Device offline');
    } catch (availabilityError) {
      this.logError('Unable to mark device unavailable', availabilityError);
    }
    if (!this.isCurrent(poll) || !this.device.getSettings().dynamicIp) return;
    this.device.discoverCount = (this.device.discoverCount || 0) + 1;
    this.device.log('Unreachable, starting IP discovery');
    try {
      await this.device.discover();
    } catch (discoveryError) {
      this.logError('Unable to start IP discovery', discoveryError);
    }
  }

  stopDiscovery() {
    const state = this.scan;
    if (!state) return;
    this.scan = null;
    clearTimeout(state.timer);
    try {
      state.client.stopDiscovery();
    } catch (error) {
      this.logError('Unable to stop IP discovery', error, state.settings, state.credentials);
    }
    state.client.removeAllListeners();
  }

  discover({ createClient, type = 'plug', resolveCandidate }) {
    const settings = this.device.getSettings();
    if (this.deleted || this.scan || !settings.dynamicIp) return;
    this.lastDiscoveryAt = Date.now();
    if (!settings.deviceId) {
      this.device.log('IP discovery skipped: device ID missing; restore the IP address manually first');
      return;
    }
    const credentials = this.globalCredentials();
    let client;
    try {
      client = createClient(settings);
    } catch (error) {
      this.logError('Unable to create discovery client', error, settings, credentials);
      return;
    }
    const state = { client, settings, credentials, generation: this.generation,
      timer: null, saving: false, pending: new Set() };
    this.scan = state;
    const current = () => {
      const latest = this.device.getSettings();
      return this.scan === state && !this.deleted && this.generation === state.generation &&
        latest.dynamicIp && latest.settingIPAddress === settings.settingIPAddress &&
        latest.deviceId === settings.deviceId;
    };
    const onDevice = async discovered => {
      if (!current() || state.saving || !discovered || !isIP(discovered.host || '')) return;
      const key = discovered.deviceId || discovered.host;
      if (state.pending.has(key)) return;
      state.pending.add(key);
      try {
        const candidate = resolveCandidate ? await resolveCandidate(discovered, settings)
          : { deviceId: discovered.deviceId, host: discovered.host };
        if (!current() || state.saving || !candidate || candidate.deviceId !== settings.deviceId ||
            !isIP(candidate.host || '')) return;
        state.saving = true;
        const save = this.device.setSettings({ settingIPAddress: candidate.host });
        this.pendingSave = save;
        try {
          await save;
        } finally {
          if (this.pendingSave === save) this.pendingSave = null;
        }
        if (this.scan !== state || this.deleted || this.generation !== state.generation ||
            this.device.getSettings().settingIPAddress !== candidate.host) return;
        if (candidate.afterSave) candidate.afterSave();
        this.device.unreachableCount = 0;
        this.device.discoverCount = 0;
        this.device.log('Rediscovered device at ' + candidate.host + '; awaiting successful status poll');
      } catch (error) {
        this.logError('IP discovery candidate failed', error, settings, credentials);
      } finally {
        state.pending.delete(key);
        if (state.saving && this.scan === state) this.stopDiscovery();
      }
    };
    const onError = error => {
      this.logError('IP discovery failed', error, settings, credentials);
      if (this.scan === state) this.stopDiscovery();
    };
    client.on(type + '-new', onDevice);
    client.on(type + '-online', onDevice);
    client.on('error', onError);
    state.timer = setTimeout(() => {
      if (this.scan !== state) return;
      this.device.log('IP discovery timed out; will retry after the cooldown');
      this.stopDiscovery();
    }, DISCOVERY_MS);
    try {
      client.startDiscovery({ deviceTypes: [type], discoveryInterval: 1000,
        discoveryTimeout: DISCOVERY_MS, breakoutChildren: false });
    } catch (error) {
      onError(error);
    }
  }
}

function getRecovery(device) {
  if (!device._ipRecovery) device._ipRecovery = new TpLinkRecovery(device);
  return device._ipRecovery;
}

module.exports = { getRecovery };
