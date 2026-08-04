'use strict';

const Homey = require('homey');
const { Client } = require('tplink-smarthome-api');
const { getTpLinkClientOptions } = require('../../lib/tplink-auth');
const {
  getPairedCredentialSettings,
  getSafeErrorMessage,
  resolvePairingCredentials,
} = require('../../lib/tplink-credentials');

function getDriverName() {
  const parts = __dirname.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1].split('.')[0];
}

const TPLINK_MODEL = getDriverName().toUpperCase();

function guid() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1);
  }
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
}

function getPairingInput(value) {
  const input = value && typeof value === 'object' ? value : {};
  const settings = input.settings && typeof input.settings === 'object' ? input.settings : {};
  return {
    ip:
      typeof input.ip === 'string'
        ? input.ip.trim()
        : typeof settings.settingIPAddress === 'string'
          ? settings.settingIPAddress.trim()
          : '',
    name: typeof input.name === 'string' ? input.name.trim() : '',
    deviceId: typeof input.deviceId === 'string' ? input.deviceId : '',
    deviceUsername:
      input.deviceUsername ?? input.username ?? settings.deviceUsername ?? '',
    devicePassword:
      input.devicePassword ?? input.password ?? settings.devicePassword ?? '',
  };
}

function getDiscoveryDeviceName(plug, sysInfo) {
  return [
    sysInfo && sysInfo.alias,
    sysInfo && sysInfo.name,
    sysInfo && sysInfo.dev_name,
    plug && plug.alias,
    plug && plug.name,
    sysInfo && sysInfo.model,
    plug && plug.model,
  ].find(value => typeof value === 'string' && value.length > 0) || TPLINK_MODEL;
}

function getPairingClient(credentials) {
  const options = getTpLinkClientOptions(TPLINK_MODEL, {
    credentialSource: 'override',
    deviceUsername: credentials.username,
    devicePassword: credentials.password,
  });
  options.defaultSendOptions.timeout = 4000;
  return new Client(options);
}

function resolveCredentialsForPairing(driver, input) {
  if (
    driver.homey &&
    driver.homey.app &&
    typeof driver.homey.app.resolvePairingCredentials === 'function'
  ) {
    return driver.homey.app.resolvePairingCredentials(input);
  }
  return resolvePairingCredentials(input);
}

async function finalizeCredentialsForPairing(driver, resolution) {
  if (
    driver.homey &&
    driver.homey.app &&
    typeof driver.homey.app.finalizePairingCredentials === 'function'
  ) {
    return driver.homey.app.finalizePairingCredentials(resolution);
  }
  return {
    ...resolution,
    settings: getPairedCredentialSettings(resolution),
  };
}

async function validateTarget(input, credentials) {
  if (!input.ip) {
    throw new Error('An IP address is required to pair a KS225.');
  }

  const client = getPairingClient(credentials);
  const sysInfo = await client.getSysInfo(input.ip);
  const model = String(sysInfo.model || '').toUpperCase();
  const deviceId = sysInfo.deviceId || sysInfo.device_id;
  if (!model.startsWith(TPLINK_MODEL) || !deviceId) {
    throw new Error('The supplied address is not an accessible KS225.');
  }
  if (input.deviceId && input.deviceId !== deviceId) {
    throw new Error(
      'The KS225 at the supplied address no longer matches the device selected during discovery.',
    );
  }

  return {
    ip: input.ip,
    name: input.name || getDiscoveryDeviceName(null, sysInfo),
    deviceId,
  };
}

class TPlinkPlugDriver extends Homey.Driver {
  async onPair(session) {
    const knownDeviceIds = new Set();
    let activeDiscovery = null;
    let pairingOpen = true;
    let requestVersion = 0;

    try {
      this.getDevices().forEach(device => {
        const deviceId = device.getSettings().deviceId;
        if (typeof deviceId === 'string' && deviceId.length > 0) {
          knownDeviceIds.add(deviceId);
        }
      });
      this.log(`Existing ${TPLINK_MODEL} device IDs: ${knownDeviceIds.size}`);
    } catch (error) {
      this.log(`Unable to read existing ${TPLINK_MODEL} devices: ${getSafeErrorMessage(error)}`);
    }

    const stopActiveDiscovery = () => {
      if (activeDiscovery) activeDiscovery.finish();
    };

    session.setHandler('get_credential_status', async () => {
      if (
        this.homey &&
        this.homey.app &&
        typeof this.homey.app.getCredentialStatus === 'function'
      ) {
        return this.homey.app.getCredentialStatus();
      }
      return { configured: false };
    });

    const discover = async input => {
      stopActiveDiscovery();
      const credentials = resolveCredentialsForPairing(this, input);
      const client = getPairingClient(credentials.credentials);
      const discoveredDevices = [];
      const pending = new Set();
      const validations = new Set();
      const discoveryOptions = {
        deviceTypes: ['plug'],
        discoveryInterval: 1500,
        discoveryTimeout: 5000,
      };

      return new Promise(resolve => {
        let acceptingCandidates = true;
        let timer = null;
        let finished = false;

        const finish = () => {
          if (finished) return;
          finished = true;
          acceptingCandidates = false;
          if (timer !== null) clearTimeout(timer);
          client.stopDiscovery();
          client.removeAllListeners();
          if (activeDiscovery && activeDiscovery.client === client) {
            activeDiscovery = null;
          }
          Promise.allSettled([...validations]).then(() => resolve(discoveredDevices));
        };

        const validateCandidate = async (plug, key) => {
          try {
            const sysInfo = await plug.getSysInfo();
            const model = String(sysInfo.model || plug.model || '').toUpperCase();
            const deviceId = sysInfo.deviceId || sysInfo.device_id || plug.deviceId;
            if (
              !model.startsWith(TPLINK_MODEL) ||
              !deviceId ||
              knownDeviceIds.has(deviceId) ||
              discoveredDevices.some(device => device.deviceId === deviceId)
            ) {
              return;
            }
            discoveredDevices.push({
              ip: plug.host,
              name: getDiscoveryDeviceName(plug, sysInfo),
              deviceId,
            });
          } catch (error) {
            this.log(
              `Unable to validate a discovered ${TPLINK_MODEL}: ${getSafeErrorMessage(
                error,
                credentials.credentials,
              )}`,
            );
          } finally {
            pending.delete(key);
          }
        };

        const collectCandidate = plug => {
          if (!acceptingCandidates) return;
          const key = plug.deviceId || plug.host;
          if (!key || pending.has(key)) return;
          pending.add(key);
          const validation = validateCandidate(plug, key);
          validations.add(validation);
          void validation.finally(() => validations.delete(validation));
        };

        client.on('plug-new', collectCandidate);
        client.on('plug-online', collectCandidate);
        client.on('error', error => {
          if (acceptingCandidates) {
            this.log(
              `${TPLINK_MODEL} discovery error: ${getSafeErrorMessage(
                error,
                credentials.credentials,
              )}`,
            );
          }
        });

        activeDiscovery = { client, finish };
        try {
          client.startDiscovery(discoveryOptions);
          timer = setTimeout(finish, discoveryOptions.discoveryTimeout + 25);
        } catch (error) {
          this.log(
            `Unable to start ${TPLINK_MODEL} discovery: ${getSafeErrorMessage(
              error,
              credentials.credentials,
            )}`,
          );
          finish();
        }
      });
    };

    session.setHandler('discover', async data => {
      const version = ++requestVersion;
      const input = getPairingInput(Array.isArray(data) ? data[0] : data);
      const discoveredDevices = await discover(input);
      if (!pairingOpen || version !== requestVersion) return [];

      if (discoveredDevices.length > 0) {
        await session.emit('discovered_devices', discoveredDevices);
      } else {
        await session.emit('discovery_failed', { devicesFound: false });
      }
      return discoveredDevices;
    });

    session.setHandler('get_devices', async data => {
      const version = ++requestVersion;
      const inputs = (Array.isArray(data) ? data : [data]).map(getPairingInput);
      const devices = [];

      for (const input of inputs) {
        const pairingResolution = resolveCredentialsForPairing(this, input);
        let target;
        try {
          target = await validateTarget(input, pairingResolution.credentials);
        } catch (error) {
          throw new Error(
            `Unable to validate the selected ${TPLINK_MODEL}: ${getSafeErrorMessage(
              error,
              pairingResolution.credentials,
            )}`,
          );
        }
        if (!pairingOpen || version !== requestVersion) return [];
        if (knownDeviceIds.has(target.deviceId)) {
          throw new Error('This KS225 is already paired.');
        }

        const finalized = await finalizeCredentialsForPairing(this, pairingResolution);
        devices.push({
          data: { id: guid() },
          name: target.name,
          settings: {
            settingIPAddress: target.ip,
            dynamicIp: false,
            totalOffset: 0,
            deviceId: target.deviceId,
            ...finalized.settings,
          },
        });
      }

      session.setHandler('list_devices', async () => devices);
      await session.emit('continue', null);
      return devices;
    });

    session.setHandler('cancel', () => {
      pairingOpen = false;
      requestVersion += 1;
      stopActiveDiscovery();
    });

    session.setHandler('disconnect', () => {
      pairingOpen = false;
      requestVersion += 1;
      stopActiveDiscovery();
    });
  }
}

module.exports = TPlinkPlugDriver;
