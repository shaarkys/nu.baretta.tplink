'use strict';

const Homey = require('homey');
const { getRecovery } = require('../../lib/tplink-recovery');
const { Client } = require('tplink-smarthome-api');

const client = new Client();

const DEFAULT_POLLING_INTERVAL = 10;
const DEFAULT_MOTION_RANGE_INDEX = 1;
const DEFAULT_MOTION_THRESHOLD = 50;
const DEFAULT_MOTION_TIMEOUT_SECONDS = 600;
const DEFAULT_AMBIENT_LIGHT_LIMIT = 15;



class TPlinkKs200mDevice extends Homey.Device {
  async onInit() {
        getRecovery(this).initialize();
    this.log('device init');
    this.unreachableCount = 0;
    this.discoverCount = 0;
    this.plug = null;

    const settings = this.getSettings();
    this.log('id: ', this.getData().id);
    this.log('name: ', this.getName());
    this.log('class: ', this.getClass());
    this.log('settings IP address: ', settings.settingIPAddress);
    this.log('Driver ID: KS200M');

    const normalizedSettings = this.normalizeSettings(settings);
    await this.applySettingsDefaults(settings, normalizedSettings);

    this.log('dynamicIp is defined: ' + normalizedSettings.dynamicIp);
    this.log(
      'Polling interval is set: ' + normalizedSettings.pollingInterval + ' seconds'
    );

    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
    this.registerCapabilityListener(
      'ledonoff',
      this.onCapabilityLedOnoff.bind(this)
    );

    this.homey.flow
      .getActionCard('ledOn')
      .registerRunListener(async args =>
        args.device.ledOn(args.device.getSettings().settingIPAddress)
      );

    this.homey.flow
      .getActionCard('ledOff')
      .registerRunListener(async args =>
        args.device.ledOff(args.device.getSettings().settingIPAddress)
      );

    await this.getStatus();
    this.pollDevice(normalizedSettings.pollingInterval);
  }

  onAdded() {
    this.log('Device added: ' + this.getData().id);
  }

  onDeleted() {
        getRecovery(this).destroy();
    this.log('Device deleted: ' + this.getData().id);
    clearInterval(this.pollingInterval);
  }

  async onCapabilityOnoff(value) {
    try {
      this.log('Capability called: onoff value:', value);
      const device = this.getSettings().settingIPAddress;
      if (value) {
        await this.powerOn(device);
      } else {
        await this.powerOff(device);
      }
      return null;
    } catch (error) {
      this.error('Error in onCapabilityOnoff:', error);
      throw error;
    }
  }

  async onCapabilityLedOnoff(value) {
    try {
      this.log('Capability called: LED onoff value:', value);
      const device = this.getSettings().settingIPAddress;
      if (value) {
        await this.ledOn(device);
      } else {
        await this.ledOff(device);
      }
      return null;
    } catch (error) {
      this.error('Error in onCapabilityLedOnoff:', error);
      throw error;
    }
  }

  async onSettings({ newSettings, changedKeys }) {
        await getRecovery(this).settingsChanged(changedKeys);
    try {
      const normalizedSettings = this.normalizeSettings(newSettings);

      for (const key of changedKeys) {
        switch (key) {
          case 'settingIPAddress':
            this.log('IP address changed to ' + normalizedSettings.settingIPAddress);
            if (!normalizedSettings.dynamicIp) {
              await this.reinitializeConnection(normalizedSettings.settingIPAddress);
            }
            break;
          case 'pollingInterval': {
            this.log(
              'Polling interval changed to ' +
                normalizedSettings.pollingInterval +
                ' seconds'
            );
            this.pollDevice(normalizedSettings.pollingInterval);
            break;
          }
          case 'dynamicIp':
            this.log(
              'Dynamic IP setting changed to ' + normalizedSettings.dynamicIp
            );
            break;
          case 'motionSensorEnabled':
          case 'motionRangeIndex':
          case 'motionThreshold':
          case 'motionInactivityTimeoutSeconds':
          case 'ambientLightEnabled':
          case 'ambientLightBrightnessLimit':
            break;
          default:
            this.log('Unhandled setting change detected for key:', key);
            break;
        }
      }

      await this.applySettingsDefaults(newSettings, normalizedSettings);
      await this.applyDeviceConfiguration(normalizedSettings, changedKeys);
    } catch (error) {
      this.error('Failed to handle settings change:', error);
      throw new Error('Failed to update settings: ' + error.message);
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
    const sysInfo = await client.getSysInfo(device);
    this.plug = client.getPlug({ host: device, sysInfo });
    return { sysInfo, plug: this.plug };
  }

  async powerOn(device) {
    try {
      this.log('Turning device on ' + device);
      const { plug } = await this.getPlug(device);
      await plug.setPowerState(true);
      await this.setCapabilityIfChanged('onoff', true);
    } catch (error) {
      this.error('Error turning device on:', error);
      throw error;
    }
  }

  async powerOff(device) {
    try {
      this.log('Turning device off ' + device);
      const { plug } = await this.getPlug(device);
      await plug.setPowerState(false);
      await this.setCapabilityIfChanged('onoff', false);
    } catch (error) {
      this.error('Error turning device off:', error);
      throw error;
    }
  }

  async ledOn(device) {
    try {
      this.log('Turning LED on for device ' + device);
      const { plug } = await this.getPlug(device);
      await plug.setLedState(true);
      await this.setCapabilityIfChanged('ledonoff', true);
    } catch (error) {
      this.log('Error turning LED on: ', error.message);
      throw error;
    }
  }

  async ledOff(device) {
    try {
      this.log('Turning LED off for device ' + device);
      const { plug } = await this.getPlug(device);
      await plug.setLedState(false);
      await this.setCapabilityIfChanged('ledonoff', false);
    } catch (error) {
      this.log('Error turning LED off: ', error.message);
      throw error;
    }
  }

  async getStatus() {
        const recovery = getRecovery(this);
        const poll = recovery.beginPoll();
        if (!poll) return;

    const settings = this.getSettings();
    const device = settings.settingIPAddress;
    this.log('getStatus device: ' + device + ', name: ' + this.getName());

    try {
      const { sysInfo, plug } = await this.getPlug(device);
            if (!recovery.responded(poll)) return;
            if (!recovery.isCurrent(poll)) return;
      const deviceId = sysInfo.deviceId || sysInfo.device_id;

      if (deviceId && settings.deviceId !== deviceId) {
        await this.setSettings({ deviceId }).catch(this.error);
        this.log('DeviceId updated: ' + deviceId);
      }

      await this.setCapabilityIfChanged('onoff', sysInfo.relay_state === 1);

      if (Object.prototype.hasOwnProperty.call(sysInfo, 'led_off')) {
        await this.setCapabilityIfChanged('ledonoff', sysInfo.led_off === 0);
      }

      if (plug.supportsMotionSensor && this.hasCapability('alarm_motion')) {
        const motionState = await plug.motion.getInfo().catch(error => {
          this.log('Error getting motion info: ' + error.message);
          return undefined;
        });

        if (motionState) {
          await this.setCapabilityIfChanged(
            'alarm_motion',
            Boolean(motionState.pirTriggered)
          );
          await this.syncSettingsIfChanged({
            motionSensorEnabled: Boolean(motionState.enabled),
            motionRangeIndex: motionState.rangeIndex,
            motionThreshold: motionState.threshold,
            motionInactivityTimeoutSeconds: Math.max(
              1,
              Math.round(motionState.inactivityTimeout / 1000)
            ),
          });
        }
      }

      if (
        plug.supportsAmbientLight &&
        this.hasCapability('measure_ambient_light')
      ) {
        const ambientLight = await plug.ambientLight.getInfo().catch(error => {
          this.log('Error getting ambient light info: ' + error.message);
          return undefined;
        });

        if (
          ambientLight &&
          typeof ambientLight.brightness === 'number' &&
          Number.isFinite(ambientLight.brightness)
        ) {
          await this.setCapabilityIfChanged(
            'measure_ambient_light',
            ambientLight.brightness
          );
        }

        if (ambientLight && ambientLight.config) {
          const ambientLimit = this.getAmbientLightLimit(ambientLight.config);
          await this.syncSettingsIfChanged({
            ambientLightEnabled: Boolean(ambientLight.config.enable),
            ...(ambientLimit === undefined
              ? {}
              : { ambientLightBrightnessLimit: ambientLimit }),
          });
        }
      }

            await recovery.succeeded(poll);
        } catch (error) {
            await recovery.failed(poll, error);
        } finally {
            recovery.endPoll(poll);
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
      motionSensorEnabled:
        typeof settings.motionSensorEnabled === 'boolean'
          ? settings.motionSensorEnabled
          : true,
      motionRangeIndex: this.normalizeInteger(
        settings.motionRangeIndex,
        DEFAULT_MOTION_RANGE_INDEX,
        0,
        3
      ),
      motionThreshold: this.normalizeInteger(
        settings.motionThreshold,
        DEFAULT_MOTION_THRESHOLD,
        0,
        100
      ),
      motionInactivityTimeoutSeconds: this.normalizeInteger(
        settings.motionInactivityTimeoutSeconds,
        DEFAULT_MOTION_TIMEOUT_SECONDS,
        1,
        86400
      ),
      ambientLightEnabled:
        typeof settings.ambientLightEnabled === 'boolean'
          ? settings.ambientLightEnabled
          : true,
      ambientLightBrightnessLimit: this.normalizeInteger(
        settings.ambientLightBrightnessLimit,
        DEFAULT_AMBIENT_LIGHT_LIMIT,
        0,
        100
      ),
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
      if (currentSettings[key] !== value) {
        pending[key] = value;
      }
    });

    if (Object.keys(pending).length > 0) {
      await this.setSettings(pending).catch(this.error);
    }
  }

  async applyDeviceConfiguration(settings, changedKeys) {
    const device = settings.settingIPAddress;
    const changed = new Set(changedKeys);

    if (
      !changed.has('motionSensorEnabled') &&
      !changed.has('motionRangeIndex') &&
      !changed.has('motionThreshold') &&
      !changed.has('motionInactivityTimeoutSeconds') &&
      !changed.has('ambientLightEnabled') &&
      !changed.has('ambientLightBrightnessLimit')
    ) {
      return;
    }

    const { plug } = await this.getPlug(device);

    if (plug.supportsMotionSensor) {
      if (changed.has('motionSensorEnabled')) {
        await plug.motion.setEnabled(settings.motionSensorEnabled);
      }

      if (changed.has('motionRangeIndex')) {
        await plug.motion.setRange(settings.motionRangeIndex);
      }

      if (changed.has('motionThreshold')) {
        await plug.motion.setThreshold(settings.motionThreshold);
      }

      if (changed.has('motionInactivityTimeoutSeconds')) {
        await plug.motion.setInactivityTimeout(
          settings.motionInactivityTimeoutSeconds * 1000
        );
      }
    }

    if (plug.supportsAmbientLight) {
      if (changed.has('ambientLightEnabled')) {
        await plug.ambientLight.setEnabled(settings.ambientLightEnabled);
      }

      if (changed.has('ambientLightBrightnessLimit')) {
        await plug.ambientLight.setBrightnessLimit(
          settings.ambientLightBrightnessLimit
        );
      }
    }

    await this.getStatus();
  }

  getAmbientLightLimit(config) {
    if (!config || !Array.isArray(config.level_array) || config.level_array.length === 0) {
      return undefined;
    }

    const [firstPreset] = config.level_array;
    if (firstPreset && typeof firstPreset.value === 'number') {
      return firstPreset.value;
    }

    return undefined;
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
        return getRecovery(this).discover({
            createClient: () => new Client(),
            type: 'plug',
        });
    }
}

module.exports = TPlinkKs200mDevice;
