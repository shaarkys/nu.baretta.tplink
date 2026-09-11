'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');

const AUTHENTICATED = new Set(['ep10', 'ks225', 'ks240', 's500d']);

function fixture(id = 'hs110') {
  const filename = path.resolve(__dirname, '../../drivers', id, 'device.js');
  const recoveryFile = path.resolve(__dirname, '../../lib/tplink-recovery.js');
  const state = { now: 0, clients: [], timers: new Set(), requests: [], writes: [], logs: [], commands: [] };
  const sysInfo = () => ({ deviceId: 'plug-1', model: id.toUpperCase(), relay_state: 1,
    brightness: 60, fan_speed_level: 3, children: [{ id: 'child-1', state: 1 }],
    ...(state.sysInfo || {}) });
  const realtime = { total: 10, power: 20, voltage: 230, current: 0.1 };
  class Client extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.stops = 0;
      state.clients.push(this);
    }
    async getSysInfo(host) {
      state.requests.push(host);
      if (state.pending) return state.pending;
      if (state.error) throw state.error;
      return sysInfo();
    }
    getPlug(options) {
      state.lastPlugOptions = options;
      return {
        getInfo: async () => {
          if (state.infoError) throw state.infoError;
          return { sysInfo: sysInfo(), emeter: { realtime } };
        },
        getSysInfo: async () => {
          if (state.infoError) throw state.infoError;
          return sysInfo();
        },
        emeter: { getRealtime: async () => {
          if (state.infoError) throw state.infoError;
          return realtime;
        } },
        setPowerState: async value => state.commands.push({ ...options, command: 'power', value }),
        setLedState: async value => state.commands.push({ ...options, command: 'led', value }),
      };
    }
    getBulb(options) {
      state.lastBulbOptions = options;
      return {
        getSysInfo: async () => sysInfo(),
        lighting: {
          getLightState: async () => {
            if (state.infoError) throw state.infoError;
            return { on_off: 1, brightness: 60, hue: 180, saturation: 50,
              color_temp: 3000, mode: 'normal' };
          },
          setLightState: async value => state.commands.push({ ...options, command: 'light', value }),
        },
      };
    }
    startDiscovery(options) {
      this.discoveryOptions = options;
      if (state.startError) throw state.startError;
      if (state.immediatePlug) this.emit(options.deviceTypes[0] + '-new', state.immediatePlug);
      return this;
    }
    stopDiscovery() { this.stops++; }
  }
  const setTimer = (callback, delay) => {
    const timer = { callback, delay };
    state.timers.add(timer);
    return timer;
  };
  const cache = new Map();
  const load = file => {
    if (cache.has(file)) return cache.get(file).exports;
    const localRequire = createRequire(file);
    const module = { exports: {} };
    cache.set(file, module);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      module, __dirname: path.dirname(file),
      require: name => {
        if (name === 'homey') return { Device: class {} };
        if (name === 'tplink-smarthome-api') return { Client };
        if (localRequire.resolve(name) === recoveryFile) return load(recoveryFile);
        return localRequire(name);
      },
      Date: class extends Date { static now() { return state.now; } },
      setTimeout: setTimer, clearTimeout: timer => state.timers.delete(timer),
      setInterval: setTimer, clearInterval: timer => state.timers.delete(timer),
    }, { filename: file });
    return module.exports;
  };
  const Device = load(filename);
  state.makeDevice = (settings = {}) => {
    const device = new Device();
    device.settings = { settingIPAddress: '192.0.2.10', deviceId: 'plug-1', dynamicIp: true,
      pollingInterval: 10, ...settings };
    device.values = { onoff: false, measure_power: 0, meter_power: 0,
      measure_voltage: 0, measure_current: 0, dim: 0, light_mode: 'normal',
      light_temperature: 0, light_hue: 0, light_saturation: 0 };
    Object.assign(device, {
      available: true, unreachableCount: 0, discoverCount: 0, totalOffset: 0,
      oldRelayState: 0, childId: 'child-1', channelType: 'light',
      getSettings() { return { ...this.settings }; },
      getData: () => ({ id: 'existing-homey-id', childId: 'child-1' }),
      getName: () => 'Test ' + id.toUpperCase(), getClass: () => 'socket',
      hasCapability(key) { return Object.hasOwn(this.values, key); },
      getCapabilityValue(key) { return this.values[key]; },
      async setCapabilityValue(key, value) { this.values[key] = value; },
      getAvailable() { return this.available; },
      async setAvailable() { this.available = true; },
      async setUnavailable() { this.available = false; },
      async setSettings(update) {
        if (state.saveError) throw state.saveError;
        if (state.saveGate) await state.saveGate;
        state.writes.push({ ...update });
        Object.assign(this.settings, update);
      },
      log: (...args) => state.logs.push(args.join(' ')),
      error: (...args) => state.logs.push(args.join(' ')),
      registerCapabilityListener() {},
      homey: {
        flow: { getActionCard: () => ({ registerRunListener() {} }) },
        app: { getGlobalCredentials: () => state.globalCredentials || null },
        setInterval: setTimer,
      },
    });
    if (AUTHENTICATED.has(id)) device.client = new Client();
    return device;
  };
  state.device = state.makeDevice();
  state.poll = async (count = 1, device = state.device) => {
    for (let i = 0; i < count; i++) await device.getStatus();
  };
  state.expireScan = () => {
    for (const timer of [...state.timers]) {
      if (timer.delay === 5000) { state.timers.delete(timer); timer.callback(); }
    }
  };
  return state;
}

const flush = () => new Promise(resolve => setImmediate(resolve));

module.exports = { fixture, flush };
