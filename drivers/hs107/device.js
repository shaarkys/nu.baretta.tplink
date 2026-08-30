'use strict';

const Homey = require('homey');
const { Client } = require('tplink-smarthome-api');

const MODEL_PATTERN = /^HS107(?:\([^()]+\))?$/i;
const POLL_INTERVAL_MS = 10000;
const API_TIMEOUT_MS = 5000;
const REDISCOVERY_INTERVAL_MS = 1000;
const REDISCOVERY_TIMEOUT_MS = 5000;

function isHs107Model(model) {
  return typeof model === 'string' && MODEL_PATTERN.test(model.trim());
}

function normalizeChildId(parentId, childId) {
  if (typeof parentId !== 'string' || parentId.length === 0) return null;
  if (typeof childId !== 'string' || childId.length === 0) return null;
  if (childId.length === 1) return `${parentId}0${childId}`;
  if (childId.length === 2) return `${parentId}${childId}`;
  return childId;
}

function withTimeout(operation, timeoutMs, description) {
  let timeout;
  const timeoutPromise = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${description} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([Promise.resolve(operation), timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function getModel(sysInfo) {
  return sysInfo && sysInfo.model;
}

function getChildrenEntries(plug) {
  const children = plug && (plug.children || (plug.sysInfo && plug.sysInfo.children));
  if (children instanceof Map) return Array.from(children.entries());
  if (Array.isArray(children)) return children.map(child => [child && child.id, child]);
  return [];
}

class HS107Device extends Homey.Device {
  async onInit() {
    this.client = new Client();
    this.pollingInterval = null;
    this.pollInFlight = false;
    this.discoveryState = null;

    const data = this.getData();
    this.parentId = data && data.id;
    this.childId = data && data.childId;
    if (!this.parentId || !this.childId) {
      throw new Error('HS107 device data must contain parent id and childId');
    }

    const settings = this.getSettings();
    if (typeof settings.dynamicIp !== 'boolean') {
      try {
        await this.setSettings({ dynamicIp: false });
      } catch (error) {
        this.warn('Unable to initialize HS107 dynamic-IP setting:', error);
      }
    }

    this.registerCapabilityListener('onoff', value => this.onCapabilityOnoff(value));
    this.registerCapabilityListener('ledonoff', value => this.onCapabilityLedOnoff(value));
    this.registerFlowActions();
    this.startPolling();
  }

  registerFlowActions() {
    const flow = this.homey && this.homey.flow;
    if (!flow || typeof flow.getActionCard !== 'function') return;

    const register = (cardId, value) => {
      const card = flow.getActionCard(cardId);
      if (!card || typeof card.registerRunListener !== 'function') return;
      card.registerRunListener(async args => {
        const device = args && args.device ? args.device : this;
        const settings = device.getSettings();
        const data = device.getData();
        return device.setLedState(settings.settingIPAddress, data.childId, value);
      });
    };

    register('ledOn', true);
    register('ledOff', false);
  }

  startPolling() {
    if (this.pollingInterval !== null) {
      clearInterval(this.pollingInterval);
    }
    const setIntervalFunction = this.homey && typeof this.homey.setInterval === 'function'
      ? this.homey.setInterval.bind(this.homey)
      : setInterval;
    this.pollingInterval = setIntervalFunction(() => {
      if (!this.pollInFlight) {
        this.pollInFlight = true;
        this.getStatus()
          .catch(error => this.handlePollingError(error))
          .finally(() => {
            this.pollInFlight = false;
          });
      }
    }, POLL_INTERVAL_MS);
  }

  onDeleted() {
    if (this.pollingInterval !== null) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.stopRediscovery();
    if (this.client && typeof this.client.removeAllListeners === 'function') {
      this.client.removeAllListeners();
    }
  }

  async onCapabilityOnoff(value) {
    const settings = this.getSettings();
    const childId = this.getData().childId;
    await this.setPowerState(settings.settingIPAddress, childId, Boolean(value));
    return null;
  }

  async onCapabilityLedOnoff(value) {
    const settings = this.getSettings();
    const childId = this.getData().childId;
    await this.setLedState(settings.settingIPAddress, childId, Boolean(value));
    return null;
  }

  async onSettings({ newSettings, changedKeys }) {
    if (!Array.isArray(changedKeys) || !changedKeys.includes('settingIPAddress')) return;
    const ipAddress = newSettings && newSettings.settingIPAddress;
    if (typeof ipAddress !== 'string' || ipAddress.trim() === '') {
      throw new Error('HS107 IP address must not be empty');
    }
    await this.getConnection(ipAddress.trim());
  }

  async getConnection(ipAddress) {
    const host = typeof ipAddress === 'string' ? ipAddress.trim() : '';
    if (!host || host === '0.0.0.0') throw new Error('HS107 IP address is not configured');

    const sysInfo = await withTimeout(
      this.client.getSysInfo(host),
      API_TIMEOUT_MS,
      'HS107 sysinfo request',
    );
    if (!isHs107Model(getModel(sysInfo))) {
      throw new Error(`Expected HS107 at ${host}, found ${getModel(sysInfo) || 'unknown model'}`);
    }
    if (sysInfo.deviceId && sysInfo.deviceId !== this.getData().id) {
      throw new Error('HS107 parent device ID does not match the paired device');
    }

    const childId = this.getData().childId;
    const childPlug = this.client.getPlug({ host, sysInfo, childId });
    const parentPlug = this.client.getPlug({ host, sysInfo });
    if (!childPlug) throw new Error(`HS107 child outlet ${childId} was not found`);

    this.parentId = this.getData().id;
    this.childId = childId;
    this.plug = childPlug;
    this.parentPlug = parentPlug;
    this.currentIp = host;
    return { childPlug, parentPlug, sysInfo, host };
  }

  async setPowerState(device, childId, powerState) {
    const host = typeof device === 'string' && device.trim() !== ''
      ? device.trim()
      : this.getSettings().settingIPAddress;
    const selectedChildId = childId || this.getData().childId;
    if (selectedChildId !== this.getData().childId) {
      throw new Error('HS107 child outlet does not match the paired device');
    }

    const { childPlug } = await this.getConnection(host);
    await withTimeout(
      childPlug.setPowerState(Boolean(powerState)),
      API_TIMEOUT_MS,
      'HS107 child power request',
    );
    await this.setCapabilityValue('onoff', Boolean(powerState));
    return true;
  }

  async setLedState(device, childId, ledState) {
    let host = device;
    let value = ledState;
    if (typeof device === 'boolean' && childId === undefined && ledState === undefined) {
      host = undefined;
      value = device;
    } else if (typeof value !== 'boolean' && typeof childId === 'boolean') {
      value = childId;
      host = device;
    }
    if (typeof value !== 'boolean') {
      throw new Error('HS107 LED state must be boolean');
    }

    const ipAddress = typeof host === 'string' && host.trim() !== ''
      ? host.trim()
      : this.getSettings().settingIPAddress;
    const { parentPlug } = await this.getConnection(ipAddress);
    await withTimeout(
      parentPlug.setLedState(value),
      API_TIMEOUT_MS,
      'HS107 parent LED request',
    );
    await this.setCapabilityValue('ledonoff', value);
    return true;
  }

  async ledOn(device) {
    return this.setLedState(device, this.getData().childId, true);
  }

  async ledOff(device) {
    return this.setLedState(device, this.getData().childId, false);
  }

  async getStatus() {
    const settings = this.getSettings();
    const { childPlug, parentPlug } = await this.getConnection(settings.settingIPAddress);
    const powerState = await withTimeout(
      childPlug.getPowerState(),
      API_TIMEOUT_MS,
      'HS107 child power status request',
    );
    const ledState = await withTimeout(
      parentPlug.getLedState(),
      API_TIMEOUT_MS,
      'HS107 parent LED status request',
    );
    await this.setCapabilityValue('onoff', Boolean(powerState));
    await this.setCapabilityValue('ledonoff', Boolean(ledState));
    if (typeof this.setAvailable === 'function') await this.setAvailable();
    return { onoff: Boolean(powerState), ledonoff: Boolean(ledState) };
  }

  async handlePollingError(error) {
    this.warn('HS107 status polling failed:', error);
    if (this.getSettings().dynamicIp === true) {
      try {
        if (typeof this.setUnavailable === 'function') await this.setUnavailable('Device offline');
        await this.discover();
      } catch (discoveryError) {
        this.warn('HS107 dynamic-IP recovery failed:', discoveryError);
      }
    }
  }

  stopRediscovery() {
    const state = this.discoveryState;
    if (!state) return;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    if (state.client && typeof state.client.stopDiscovery === 'function') {
      try {
        state.client.stopDiscovery();
      } catch (error) {
        this.warn('Unable to stop HS107 rediscovery:', error);
      }
    }
    if (state.client && typeof state.client.removeAllListeners === 'function') {
      state.client.removeAllListeners();
    }
    this.discoveryState = null;
  }

  async discover() {
    if (this.discoveryState) return this.discoveryState.promise;

    const parentId = this.getData().id;
    const childId = this.getData().childId;
    let resolveDiscovery;
    const promise = new Promise(resolve => {
      resolveDiscovery = resolve;
    });
    const state = {
      client: this.client,
      timer: null,
      promise,
      finished: false,
      finishing: false,
    };
    this.discoveryState = state;

    const finish = result => {
      if (state.finished) return;
      state.finished = true;
      this.stopRediscovery();
      resolveDiscovery(result);
    };

    const onPlug = async plug => {
      if (state.finished || state.finishing || !plug || !isHs107Model(plug.model || (plug.sysInfo && plug.sysInfo.model))) return;
      if (typeof plug.host !== 'string' || plug.host.trim() === '') return;
      const discoveredParentId = plug.deviceId || (plug.sysInfo && plug.sysInfo.deviceId);
      if (discoveredParentId !== parentId) return;

      let discoveredChildId = typeof plug.childId === 'string' ? plug.childId : null;
      if (!discoveredChildId) {
        const children = getChildrenEntries(plug);
        const match = children.find(([key, child]) => {
          const candidate = child && typeof child.id === 'string' ? child.id : key;
          return candidate === childId || normalizeChildId(parentId, candidate) === childId;
        });
        if (match) discoveredChildId = match[0];
      }
      if (normalizeChildId(parentId, discoveredChildId) !== childId) return;

      const host = plug.host.trim();
      state.finishing = true;
      try {
        await this.setSettings({ settingIPAddress: host });
        if (typeof this.setAvailable === 'function') await this.setAvailable();
        this.log('HS107 parent rediscovered at', host);
        finish(true);
      } catch (error) {
        this.warn('Unable to save HS107 rediscovered IP:', error);
        finish(false);
      }
    };

    const onError = error => {
      this.warn('HS107 rediscovery failed:', error);
      finish(false);
    };

    this.client.on('plug-new', onPlug);
    this.client.on('plug-online', onPlug);
    this.client.on('error', onError);
    state.timer = setTimeout(() => finish(false), REDISCOVERY_TIMEOUT_MS);

    try {
      this.client.startDiscovery({
        deviceTypes: ['plug'],
        discoveryInterval: REDISCOVERY_INTERVAL_MS,
        discoveryTimeout: REDISCOVERY_TIMEOUT_MS,
        breakoutChildren: true,
      });
    } catch (error) {
      onError(error);
    }

    return promise;
  }
}

module.exports = HS107Device;
