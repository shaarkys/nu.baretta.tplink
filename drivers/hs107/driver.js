'use strict';

const Homey = require('homey');
const { Client } = require('tplink-smarthome-api');

const MODEL_PATTERN = /^HS107(?:\([^()]+\))?$/i;
const DISCOVERY_INTERVAL_MS = 1000;
const DISCOVERY_TIMEOUT_MS = 3000;

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

function pairKey(parentId, childId) {
  return `${parentId}\u0000${childId}`;
}

function getModel(plug) {
  return plug && (plug.model || (plug.sysInfo && plug.sysInfo.model));
}

function getParentId(plug) {
  return plug && (plug.deviceId || (plug.sysInfo && plug.sysInfo.deviceId));
}

function getHost(plug) {
  return plug && typeof plug.host === 'string' ? plug.host.trim() : '';
}

function getPlugName(plug, child) {
  if (child && typeof child.alias === 'string' && child.alias.trim() !== '') {
    return child.alias.trim();
  }
  if (child && typeof child.name === 'string' && child.name.trim() !== '') {
    return child.name.trim();
  }
  if (plug && typeof plug.alias === 'string' && plug.alias.trim() !== '') {
    return plug.alias.trim();
  }
  if (plug && typeof plug.name === 'string' && plug.name.trim() !== '') {
    return plug.name.trim();
  }
  return 'HS107 outlet';
}

function getChildrenEntries(plug) {
  const children = plug && (plug.children || (plug.sysInfo && plug.sysInfo.children));
  if (children instanceof Map) return Array.from(children.entries());
  if (Array.isArray(children)) return children.map(child => [child && child.id, child]);
  return [];
}

function extractCandidates(plug, requestedHost) {
  if (!plug || !isHs107Model(getModel(plug))) return [];

  const host = getHost(plug);
  const parentId = getParentId(plug);
  if (!host || !parentId || (requestedHost && host !== requestedHost)) return [];

  if (typeof plug.childId === 'string' && plug.childId.length > 0) {
    const childId = normalizeChildId(parentId, plug.childId);
    if (!childId) return [];
    return [{
      ip: host,
      name: getPlugName(plug),
      deviceId: parentId,
      childId,
    }];
  }

  return getChildrenEntries(plug)
    .map(([rawChildId, child]) => {
      const childId = normalizeChildId(parentId, rawChildId);
      if (!childId) return null;
      return {
        ip: host,
        name: getPlugName(plug, child),
        deviceId: parentId,
        childId,
      };
    })
    .filter(Boolean);
}

function getHomeyDevices(driver) {
  const devices = driver.getDevices();
  if (devices instanceof Map) return Array.from(devices.values());
  if (Array.isArray(devices)) return devices;
  return Object.values(devices || {});
}

class HS107Driver extends Homey.Driver {
  async onPair(session) {
    const client = new Client();
    const state = {
      client,
      closed: false,
      active: false,
      timer: null,
      emitter: null,
      requestedHost: null,
      discovered: new Map(),
      paired: new Set(),
      devices: [],
    };

    try {
      getHomeyDevices(this).forEach(device => {
        const data = device.getData();
        if (data && data.id && data.childId) {
          const childId = normalizeChildId(data.id, data.childId) || data.childId;
          state.paired.add(pairKey(data.id, childId));
        }
      });
    } catch (error) {
      this.warn('Unable to inspect existing HS107 devices during pairing:', error);
    }

    const removeDiscoveryListeners = () => {
      const emitter = state.emitter;
      if (emitter && typeof emitter.removeAllListeners === 'function') {
        emitter.removeAllListeners();
      }
      if (emitter && emitter !== client && typeof client.removeAllListeners === 'function') {
        client.removeAllListeners();
      }
      state.emitter = null;
    };

    const stopDiscovery = () => {
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (state.active) {
        try {
          client.stopDiscovery();
        } catch (error) {
          this.warn('Unable to stop HS107 discovery:', error);
        }
        state.active = false;
      }
      removeDiscoveryListeners();
    };

    const finishDiscovery = () => {
      if (!state.active || state.closed) return;
      stopDiscovery();
      const devices = Array.from(state.discovered.values());
      if (devices.length > 0) {
        this.log('Discovered HS107 outlets:', JSON.stringify(devices));
        Promise.resolve(session.emit('discovered_devices', devices)).catch(error => {
          this.warn('Unable to report HS107 discovery results:', error);
        });
      } else {
        this.log('No HS107 outlets discovered');
        Promise.resolve(session.emit('discovery_failed', { devicesFound: false })).catch(error => {
          this.warn('Unable to report HS107 discovery failure:', error);
        });
      }
    };

    const addCandidate = plug => {
      extractCandidates(plug, state.requestedHost).forEach(candidate => {
        const key = pairKey(candidate.deviceId, candidate.childId);
        if (state.paired.has(key)) return;
        const previous = state.discovered.get(key);
        state.discovered.set(key, previous ? { ...previous, ...candidate } : candidate);
      });
    };

    const onDiscoveryError = error => {
      this.error('HS107 discovery failed:', error);
      finishDiscovery();
    };

    session.setHandler('discover', async data => {
      if (state.closed) throw new Error('HS107 pairing session is no longer active');

      stopDiscovery();
      state.discovered.clear();
      state.requestedHost = null;

      const input = Array.isArray(data) ? data : (data ? [data] : []);
      const requestedIp = input.length > 0 && input[0] && typeof input[0].ip === 'string'
        ? input[0].ip.trim()
        : '';
      if (requestedIp) state.requestedHost = requestedIp;

      const options = {
        deviceTypes: ['plug'],
        discoveryInterval: DISCOVERY_INTERVAL_MS,
        discoveryTimeout: DISCOVERY_TIMEOUT_MS,
        breakoutChildren: true,
      };
      if (state.requestedHost) options.devices = [{ host: state.requestedHost }];

      state.emitter = client;
      client.on('plug-new', addCandidate);
      client.on('plug-online', addCandidate);
      client.on('error', onDiscoveryError);
      state.active = true;
      state.timer = setTimeout(finishDiscovery, DISCOVERY_TIMEOUT_MS);

      this.log('Starting HS107 discovery with options:', JSON.stringify(options));
      try {
        const emitter = client.startDiscovery(options);
        if (emitter && emitter !== client && typeof emitter.on === 'function') {
          state.emitter = emitter;
          emitter.on('plug-new', addCandidate);
          emitter.on('plug-online', addCandidate);
          emitter.on('error', onDiscoveryError);
        }
      } catch (error) {
        onDiscoveryError(error);
      }
    });

    session.setHandler('get_devices', async data => {
      if (state.closed) throw new Error('HS107 pairing session is no longer active');

      const input = Array.isArray(data) ? data : (data ? [data] : []);
      if (input.length === 0) {
        throw new Error('No HS107 outlet was selected from LAN discovery evidence');
      }

      stopDiscovery();
      const selected = new Set();
      state.devices = input.map(item => {
        const parentId = item && (item.deviceId || item.id);
        const childId = item && normalizeChildId(parentId, item.childId);
        const key = parentId && childId ? pairKey(parentId, childId) : null;
        const discovered = key ? state.discovered.get(key) : null;
        if (!discovered) {
          throw new Error('HS107 pairing requires discovery evidence for the selected outlet');
        }
        if (selected.has(key)) return null;
        selected.add(key);
        return {
          data: { id: discovered.deviceId, childId: discovered.childId },
          name: discovered.name,
          settings: {
            settingIPAddress: discovered.ip,
            dynamicIp: false,
          },
        };
      }).filter(Boolean);

      if (state.devices.length === 0) {
        throw new Error('No new HS107 outlets were selected');
      }

      session.setHandler('list_devices', async () => state.devices);
      await session.emit('continue', null);
      return state.devices;
    });

    const closeSession = () => {
      if (state.closed) return;
      state.closed = true;
      stopDiscovery();
      this.log('HS107 pairing session closed');
    };
    session.setHandler('cancel', closeSession);
    session.setHandler('disconnect', closeSession);
  }
}

module.exports = HS107Driver;
