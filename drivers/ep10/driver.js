'use strict';

const Homey = require('homey');
const { Client } = require('tplink-smarthome-api');
const {
  getTpLinkDiscoveryClientOptions,
  isValidTpLinkTransport,
} = require('../../lib/tplink-auth');
const {
  getPairedCredentialSettings,
  getSafeErrorMessage,
  hasCredentialInput,
  resolvePairingCredentials,
} = require('../../lib/tplink-credentials');

const TPLINK_MODEL = 'EP10';

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
  const data = input.data && typeof input.data === 'object' ? input.data : {};
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
    transport: isValidTpLinkTransport(input.transport)
      ? input.transport
      : isValidTpLinkTransport(data.transport)
        ? data.transport
        : undefined,
    deviceUsername:
      input.deviceUsername ?? input.username ?? settings.deviceUsername ?? '',
    devicePassword:
      input.devicePassword ?? input.password ?? settings.devicePassword ?? '',
  };
}

function getDiscoveryDeviceName(plug, sysInfo) {
  return [
    sysInfo && sysInfo.name,
    sysInfo && sysInfo.alias,
    sysInfo && sysInfo.dev_name,
    plug && plug.alias,
    plug && plug.name,
    sysInfo && sysInfo.model,
    plug && plug.model,
  ].find(value => typeof value === 'string' && value.length > 0) || TPLINK_MODEL;
}

function isAuthenticatedTransport(transport) {
  return transport === 'klap' || transport === 'aes';
}

function getCredentialSettings(resolution) {
  if (!resolution) return {};
  return {
    credentialSource: 'override',
    deviceUsername: resolution.credentials.username,
    devicePassword: resolution.credentials.password,
  };
}

function resolveOptionalPairingCredentials(driver, input) {
  const app = driver.homey && driver.homey.app;
  const globalCredentials =
    app && typeof app.getGlobalCredentials === 'function'
      ? app.getGlobalCredentials()
      : null;
  if (!hasCredentialInput(input) && !globalCredentials) return null;

  if (app && typeof app.resolvePairingCredentials === 'function') {
    return app.resolvePairingCredentials(input);
  }
  return resolvePairingCredentials(input, globalCredentials);
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

    const discoverEp10Devices = (input, targetHost) => {
      stopActiveDiscovery();
      const credentialResolution = resolveOptionalPairingCredentials(this, input);
      const client = new Client(
        getTpLinkDiscoveryClientOptions(getCredentialSettings(credentialResolution)),
      );
      const discoveryOptions = {
        deviceTypes: ['plug'],
        discoveryInterval: 1500,
        discoveryTimeout: 5000,
        ...(targetHost
          ? {
              broadcast: targetHost,
              devices: [{ host: targetHost }],
            }
          : {}),
      };

      return new Promise(resolve => {
        const discoveredDevices = [];
        const pendingCandidates = new Set();
        const validations = new Set();
        let authenticationRequired = false;
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
          Promise.allSettled([...validations]).then(() =>
            resolve({ devices: discoveredDevices, authenticationRequired }),
          );
        };

        const validatePlug = async (plug, key) => {
          try {
            const transport = isValidTpLinkTransport(
              plug.defaultSendOptions && plug.defaultSendOptions.transport,
            )
              ? plug.defaultSendOptions.transport
              : 'tcp';
            if (isAuthenticatedTransport(transport) && !credentialResolution) {
              authenticationRequired = true;
              return;
            }

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
              transport,
            });
          } catch (error) {
            this.log(
              `Unable to validate a discovered ${TPLINK_MODEL}: ${getSafeErrorMessage(
                error,
                credentialResolution && credentialResolution.credentials,
              )}`,
            );
          } finally {
            pendingCandidates.delete(key);
          }
        };

        const collectPlug = plug => {
          if (!acceptingCandidates || (targetHost && plug.host !== targetHost)) return;
          const key = plug.deviceId || plug.host;
          if (!key || pendingCandidates.has(key)) return;
          pendingCandidates.add(key);
          const validation = validatePlug(plug, key);
          validations.add(validation);
          void validation.finally(() => validations.delete(validation));
        };

        client.on('plug-new', collectPlug);
        client.on('plug-online', collectPlug);
        client.on('error', error => {
          if (acceptingCandidates) {
            this.log(
              `${TPLINK_MODEL} discovery error: ${getSafeErrorMessage(
                error,
                credentialResolution && credentialResolution.credentials,
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
              credentialResolution && credentialResolution.credentials,
            )}`,
          );
          finish();
        }
      });
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

    session.setHandler('discover', async data => {
      const version = ++requestVersion;
      const input = getPairingInput(Array.isArray(data) ? data[0] : data);
      const result = await discoverEp10Devices(input);
      if (!pairingOpen || version !== requestVersion) return [];

      if (result.devices.length > 0) {
        await session.emit('discovered_devices', result.devices);
      } else {
        await session.emit('discovery_failed', {
          devicesFound: false,
          authenticationRequired: result.authenticationRequired,
        });
      }
      return result.devices;
    });

    session.setHandler('get_devices', async data => {
      const version = ++requestVersion;
      const inputs = (Array.isArray(data) ? data : [data]).map(getPairingInput);
      const devices = [];

      for (const input of inputs) {
        if (!input.ip) {
          throw new Error('An IP address is required to pair an EP10 manually.');
        }

        const result = await discoverEp10Devices(input, input.ip);
        if (!pairingOpen || version !== requestVersion) return [];
        const target = result.devices.find(device => device.ip === input.ip);
        if (!target) {
          if (result.authenticationRequired) {
            throw new Error(
              'This EP10 uses authenticated firmware. Enter complete TP-Link account credentials and try again.',
            );
          }
          throw new Error(
            'No accessible EP10 was found at the supplied IP address. Check the address and try discovery again.',
          );
        }
        if (input.deviceId && input.deviceId !== target.deviceId) {
          throw new Error(
            'The EP10 at the supplied address no longer matches the device selected during discovery.',
          );
        }
        if (knownDeviceIds.has(target.deviceId)) {
          throw new Error('This EP10 is already paired.');
        }

        let credentialSettings = {
          deviceUsername: '',
          devicePassword: '',
        };
        if (isAuthenticatedTransport(target.transport)) {
          const pairingResolution = resolveOptionalPairingCredentials(this, input);
          if (!pairingResolution) {
            throw new Error(
              'This EP10 uses authenticated firmware. Enter complete TP-Link account credentials and try again.',
            );
          }
          const finalized = await finalizeCredentialsForPairing(this, pairingResolution);
          credentialSettings = finalized.settings;
        }

        devices.push({
          data: {
            id: guid(),
            transport: target.transport,
          },
          name: input.name || target.name,
          settings: {
            settingIPAddress: target.ip,
            dynamicIp: false,
            totalOffset: 0,
            deviceId: target.deviceId,
            ...credentialSettings,
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
