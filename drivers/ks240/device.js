'use strict';

const Homey = require('homey');
const { Client } = require('tplink-smarthome-api');

const DEFAULT_POLLING_INTERVAL = 10;
const FAN_MIN_LEVEL = 0;
const FAN_MAX_LEVEL = 4;

function normalizeOptionalSetting(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getClientOptions(settings) {
  const username = normalizeOptionalSetting(settings?.deviceUsername);
  const password =
    typeof settings?.devicePassword === 'string' ? settings.devicePassword : '';

  if (username && password) {
    return {
      credentials: {
        username,
        password,
      },
    };
  }

  return {};
}

function createClientFromSettings(settings) {
  return new Client(getClientOptions(settings));
}

function isReachabilityError(error) {
  return /(EHOSTUNREACH|ETIMEDOUT|ENETUNREACH|ECONNREFUSED)/.test(
    error && error.message ? error.message : ''
  );
}

class TPlinkKs240Device extends Homey.Device {
  async onInit() {
    this.log('KS240 device initialization');
    this.unreachableCount = 0;
    this.discoverCount = 0;
    this.plug = null;

    const settings = this.getSettings();
    const normalizedSettings = this.normalizeSettings(settings);
    await this.applySettingsDefaults(settings, normalizedSettings);
    this.client = createClientFromSettings(normalizedSettings);

    this.childId = this.getData().childId || normalizedSettings.childId;
    this.channelType = normalizedSettings.channelType || this.inferChannelType();

    this.log('Device ID: ', this.getData().id);
    this.log('Child ID: ', this.childId);
    this.log('Channel type: ', this.channelType);
    this.log('name: ', this.getName());
    this.log('class: ', this.getClass());
    this.log('settings IP address: ', normalizedSettings.settingIPAddress);
    this.log(
      'Local credentials configured: ' +
        (normalizedSettings.deviceUsername ? 'yes' : 'no')
    );

    await this.ensureDeviceShape();

    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));

    const setBrightnessAction = this.homey.flow.getActionCard('set_brightness');
    setBrightnessAction.registerRunListener(async args => {
      await args.device.setLevel(args.brightness);
      return true;
    });

    await this.getStatus();
    this.pollDevice(normalizedSettings.pollingInterval);
  }

  onAdded() {
    this.log('Device added: ' + this.getData().id + ', Child ID: ' + this.childId);
  }

  onDeleted() {
    this.log('Device deleted: ' + this.getData().id + ', Child ID: ' + this.childId);
    clearInterval(this.pollingInterval);
  }

  async onCapabilityOnoff(value) {
    this.log('Capability called: onoff value:', value, 'for Child ID', this.childId);
    try {
      await this.setPowerState(Boolean(value));
      return null;
    } catch (error) {
      this.error('Error in onCapabilityOnoff:', error);
      throw error;
    }
  }

  async onCapabilityDim(value) {
    this.log('Capability called: dim value:', value, 'for Child ID', this.childId);
    try {
      await this.setLevel(value);
      return null;
    } catch (error) {
      this.error('Error in onCapabilityDim:', error);
      throw error;
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    try {
      const normalizedSettings = this.normalizeSettings(newSettings);
      await this.applySettingsDefaults(newSettings, normalizedSettings);

      for (const key of changedKeys) {
        switch (key) {
          case 'settingIPAddress':
            this.log('IP address changed to ' + normalizedSettings.settingIPAddress);
            if (!normalizedSettings.dynamicIp) {
              await this.reinitializeConnection(normalizedSettings.settingIPAddress);
            }
            break;
          case 'pollingInterval':
            this.log(
              'Polling interval changed to ' +
                normalizedSettings.pollingInterval +
                ' seconds'
            );
            this.pollDevice(normalizedSettings.pollingInterval);
            break;
          case 'dynamicIp':
            this.log('Dynamic IP setting changed to ' + normalizedSettings.dynamicIp);
            break;
          case 'deviceUsername':
          case 'devicePassword':
            this.client = createClientFromSettings(normalizedSettings);
            this.log('Local credentials updated');
            await this.reinitializeConnection(normalizedSettings.settingIPAddress);
            break;
          default:
            this.log('Unhandled setting change detected for key:', key);
            break;
        }
      }
    } catch (error) {
      this.error('Failed to handle settings change:', error);
      throw new Error('Failed to update settings: ' + error.message);
    }
  }

  normalizeSettings(settings) {
    return {
      settingIPAddress: settings.settingIPAddress,
      pollingInterval: this.normalizeInteger(
        settings.pollingInterval,
        DEFAULT_POLLING_INTERVAL,
        2,
        60
      ),
      dynamicIp:
        typeof settings.dynamicIp === 'boolean' ? settings.dynamicIp : false,
      deviceUsername: normalizeOptionalSetting(settings.deviceUsername),
      devicePassword:
        typeof settings.devicePassword === 'string' ? settings.devicePassword : '',
      deviceId: settings.deviceId,
      childId: settings.childId,
      channelType: settings.channelType,
      channelName: settings.channelName,
    };
  }

  normalizeInteger(value, fallback, min, max) {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
  }

  async applySettingsDefaults(currentSettings, normalizedSettings) {
    const pending = {};

    Object.entries(normalizedSettings).forEach(([key, value]) => {
      if (value !== undefined && currentSettings[key] !== value) {
        pending[key] = value;
      }
    });

    if (Object.keys(pending).length > 0) {
      await this.setSettings(pending).catch(this.error);
    }
  }

  inferChannelType() {
    const channelName = (this.getName() || '').toLowerCase();
    return channelName.includes('fan') ? 'fan' : 'light';
  }

  async ensureDeviceShape() {
    const desiredClass = this.channelType === 'fan' ? 'fan' : 'light';

    if (this.getClass() !== desiredClass) {
      try {
        await this.setClass(desiredClass);
      } catch (error) {
        this.log(
          'Unable to set class to ' + desiredClass + ': ' + error.message
        );
      }
    }
  }

  async reinitializeConnection(ipAddress) {
    try {
      await this.getPlug(ipAddress);
      this.log('Reinitialized connection to', ipAddress);
    } catch (error) {
      this.error('Error reinitializing connection:', error);
    }
  }

  async getPlug(device) {
    const sysInfo = await this.client.getSysInfo(device);
    this.plug = this.client.getPlug({
      host: device,
      sysInfo,
      childId: this.childId,
    });
    return { sysInfo, plug: this.plug };
  }

  async setPowerState(powerState) {
    const { plug } = await this.getPlug(this.getSettings().settingIPAddress);

    if (this.channelType === 'fan' && powerState) {
      const currentInfo = await plug.getSysInfo();
      const currentLevel =
        typeof currentInfo.fan_speed_level === 'number'
          ? currentInfo.fan_speed_level
          : FAN_MIN_LEVEL;
      const nextLevel = currentLevel > FAN_MIN_LEVEL ? currentLevel : 1;
      await plug.sendSmartCommand(
        'set_device_info',
        { device_on: true, fan_speed_level: nextLevel },
        this.childId
      );
      plug.applySmartDeviceInfoPartial(
        { device_on: true, fan_speed_level: nextLevel },
        this.childId
      );
      await this.setCapabilityIfChanged('onoff', true);
      await this.setCapabilityIfChanged('dim', nextLevel / FAN_MAX_LEVEL);
      return true;
    }

    await plug.setPowerState(powerState);
    await this.setCapabilityIfChanged('onoff', powerState);

    if (!powerState) {
      await this.setCapabilityIfChanged('dim', 0);
    }

    return true;
  }

  async setLevel(level) {
    const { plug } = await this.getPlug(this.getSettings().settingIPAddress);
    const rawLevel = Number(level) || 0;
    const normalizedInput = rawLevel > 1 ? rawLevel / 100 : rawLevel;
    const normalized = Math.max(0, Math.min(1, normalizedInput));

    if (this.channelType === 'fan') {
      const fanLevel = Math.max(
        FAN_MIN_LEVEL,
        Math.min(FAN_MAX_LEVEL, Math.round(normalized * FAN_MAX_LEVEL))
      );

      await plug.sendSmartCommand(
        'set_device_info',
        fanLevel === 0
          ? { device_on: false, fan_speed_level: 0 }
          : { device_on: true, fan_speed_level: fanLevel },
        this.childId
      );
      plug.applySmartDeviceInfoPartial(
        fanLevel === 0
          ? { device_on: false, fan_speed_level: 0 }
          : { device_on: true, fan_speed_level: fanLevel },
        this.childId
      );

      await this.setCapabilityIfChanged('onoff', fanLevel > 0);
      await this.setCapabilityIfChanged('dim', fanLevel / FAN_MAX_LEVEL);
      return true;
    }

    const brightness = Math.round(normalized * 100);
    if (brightness <= 0) {
      return this.setPowerState(false);
    }

    await plug.sendSmartCommand(
      'set_device_info',
      { device_on: true, brightness },
      this.childId
    );
    plug.applySmartDeviceInfoPartial(
      { device_on: true, brightness },
      this.childId
    );
    await this.setCapabilityIfChanged('onoff', true);
    await this.setCapabilityIfChanged('dim', brightness / 100);
    return true;
  }

  async getStatus() {
    const settings = this.getSettings();
    const device = settings.settingIPAddress;
    this.log('getStatus for device: ' + device + ', Child ID: ' + this.childId);

    try {
      const { sysInfo, plug } = await this.getPlug(device);
      const childInfo = await plug.getSysInfo();
      const deviceId = settings.deviceId || sysInfo.deviceId || sysInfo.device_id;

      if (deviceId && settings.deviceId !== deviceId) {
        await this.syncSettingsIfChanged({ deviceId });
      }

      const isOn =
        childInfo.device_on === undefined
          ? childInfo.relay_state === 1
          : childInfo.device_on === true;
      await this.setCapabilityIfChanged('onoff', Boolean(isOn));

      if (this.channelType === 'fan') {
        const fanLevel =
          typeof childInfo.fan_speed_level === 'number'
            ? childInfo.fan_speed_level
            : 0;
        await this.setCapabilityIfChanged('dim', fanLevel / FAN_MAX_LEVEL);
      } else {
        const brightness =
          typeof childInfo.brightness === 'number' ? childInfo.brightness : 0;
        await this.setCapabilityIfChanged('dim', brightness / 100);
      }

      if (!this.getAvailable()) {
        await this.setAvailable().catch(this.error);
      }
      this.unreachableCount = 0;
      this.discoverCount = 0;
    } catch (error) {
      if (isReachabilityError(error)) {
        this.unreachableCount += 1;
        this.log(
          'Device unreachable. Unreachable count: ' +
            this.unreachableCount +
            ' Discover count: ' +
            this.discoverCount +
            ' DynamicIP option: ' +
            settings.dynamicIp
        );

        if (this.unreachableCount % 360 === 3 && settings.dynamicIp) {
          await this.setUnavailable('Device offline').catch(this.error);
          this.discoverCount += 1;
          this.log('Unreachable, starting autodiscovery');
          this.discover();
        }
      }

      this.log('Caught error in getStatus function: ' + error.message);
    }
  }

  pollDevice(interval) {
    clearInterval(this.pollingInterval);
    this.pollingInterval = setInterval(async () => {
      try {
        await this.getStatus();
      } catch (error) {
        this.log('Error during polling: ' + error.message);
      }
    }, 1000 * interval);
  }

  async setCapabilityIfChanged(capabilityId, value) {
    if (!this.hasCapability(capabilityId)) {
      return;
    }

    if (this.getCapabilityValue(capabilityId) === value) {
      return;
    }

    await this.setCapabilityValue(capabilityId, value).catch(this.error);
  }

  async syncSettingsIfChanged(partialSettings) {
    const currentSettings = this.getSettings();
    const pending = {};

    Object.entries(partialSettings).forEach(([key, value]) => {
      if (value !== undefined && currentSettings[key] !== value) {
        pending[key] = value;
      }
    });

    if (Object.keys(pending).length > 0) {
      await this.setSettings(pending).catch(this.error);
    }
  }

  discover() {
    const settings = this.getSettings();
    const discoveryOptions = {
      deviceTypes: 'plug',
      discoveryInterval: 10000,
      discoveryTimeout: 5000,
      offlineTolerance: 3,
      breakoutChildren: false,
    };

    try {
      const discovery = this.client.startDiscovery(discoveryOptions);

      const handleDiscoveredPlug = async plug => {
        try {
          if (plug.model !== 'KS240' && !String(plug.model).startsWith('KS240')) {
            return;
          }

          const parentDeviceId = plug.deviceId;
          if (parentDeviceId === settings.deviceId) {
            await this.setSettings({ settingIPAddress: plug.host });
            this.client.stopDiscovery();
            this.log('Updated KS240 host for device: ' + parentDeviceId);
            await this.setAvailable().catch(this.error);
            this.unreachableCount = 0;
            this.discoverCount = 0;
          }
        } catch (error) {
          this.log('Error during KS240 discovery: ' + error.message);
        }
      };

      discovery.on('plug-new', handleDiscoveredPlug);
      discovery.on('plug-online', handleDiscoveredPlug);
    } catch (error) {
      this.log('Discovery failed: ' + error.message);
    }
  }
}

module.exports = TPlinkKs240Device;
