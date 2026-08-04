'use strict';

const Homey = require('homey');
const { Client } = require('tplink-smarthome-api');
const { getTpLinkClientOptions } = require('../../lib/tplink-auth');
const {
  getPairedCredentialSettings,
  getSafeErrorMessage,
  resolvePairingCredentials,
} = require('../../lib/tplink-credentials');

const TPLINK_MODEL = 'KS240';

function guid() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1);
  }
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
}

function getChannelType(category) {
  return category === 'kasa.switch.outlet.sub-fan' ? 'fan' : 'light';
}

function getChannelName(parentName, category) {
  return `${parentName} ${getChannelType(category) === 'fan' ? 'Fan' : 'Light'}`;
}

function getDiscoveryParentName(plug, sysInfo) {
  return [
    sysInfo && sysInfo.alias,
    sysInfo && sysInfo.name,
    sysInfo && sysInfo.dev_name,
    plug && plug.alias,
    plug && plug.name,
    TPLINK_MODEL,
  ].find(value => typeof value === 'string' && value.length > 0);
}

function getPairingInput(value) {
  const input = value && typeof value === 'object' ? value : {};
  const settings = input.settings && typeof input.settings === 'object' ? input.settings : {};
  const data = input.data && typeof input.data === 'object' ? input.data : {};
  return {
    ip:
      typeof input.ip === 'string'
        ? input.ip.trim()
        : typeof settings.settingIPAddress === 'string'
          ? settings.settingIPAddress.trim()
          : '',
    name: typeof input.name === 'string' ? input.name.trim() : '',
    parentId:
      input.parentId ?? settings.deviceId ?? data.parentId ?? '',
    childId: input.childId ?? settings.childId ?? data.childId ?? '',
    channelType: input.channelType ?? settings.channelType ?? data.channelType ?? '',
    deviceUsername:
      input.deviceUsername ?? input.username ?? settings.deviceUsername ?? '',
    devicePassword:
      input.devicePassword ?? input.password ?? settings.devicePassword ?? '',
  };
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

function getChildrenFromResponse(response) {
  const childList = response && response.get_child_device_list;
  return childList && Array.isArray(childList.child_device_list)
    ? childList.child_device_list
    : [];
}

function makeChannels(input, parent) {
  const selectedChildren = input.childId
    ? parent.children.filter(child => child.device_id === input.childId)
    : parent.children;
  if (input.childId && selectedChildren.length === 0) {
    throw new Error(
      'The KS240 at the supplied address no longer exposes the channel selected during discovery.',
    );
  }

  return selectedChildren
    .filter(child => typeof child.device_id === 'string' && child.device_id.length > 0)
    .map(child => {
      const channelType = getChannelType(child.category);
      return {
        id: child.device_id,
        parentId: parent.deviceId,
        childId: child.device_id,
        channelType,
        name:
          input.name ||
          (typeof child.alias === 'string' && child.alias.length > 0
            ? child.alias
            : getChannelName(parent.name, child.category)),
      };
    });
}

async function validateTarget(input, credentials) {
  if (!input.ip) {
    throw new Error('An IP address is required to pair a KS240.');
  }

  const client = getPairingClient(credentials);
  const sysInfo = await client.getSysInfo(input.ip);
  const model = String(sysInfo.model || '').toUpperCase();
  const deviceId = sysInfo.deviceId || sysInfo.device_id;
  if (!model.startsWith(TPLINK_MODEL) || !deviceId) {
    throw new Error('The supplied address is not an accessible KS240.');
  }
  if (input.parentId && input.parentId !== deviceId) {
    throw new Error(
      'The KS240 at the supplied address no longer matches the device selected during discovery.',
    );
  }

  const plug = client.getPlug({ host: input.ip, sysInfo });
  const responses = await plug.sendSmartRequests([
    { method: 'get_child_device_list' },
  ]);
  return {
    ip: input.ip,
    deviceId,
    name: getDiscoveryParentName(plug, sysInfo),
    children: getChildrenFromResponse(responses),
  };
}

class TPlinkKs240Driver extends Homey.Driver {
  async onPair(session) {
    const knownChildIds = new Set();
    let activeDiscovery = null;
    let pairingOpen = true;
    let requestVersion = 0;

    try {
      this.getDevices().forEach(device => {
        const childId = device.getData().id;
        if (typeof childId === 'string' && childId.length > 0) {
          knownChildIds.add(childId);
        }
      });
      this.log(`Existing ${TPLINK_MODEL} child IDs: ${knownChildIds.size}`);
    } catch (error) {
      this.log(`Unable to read existing ${TPLINK_MODEL} children: ${getSafeErrorMessage(error)}`);
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
      const pendingParents = new Set();
      const validations = new Set();
      const discoveryOptions = {
        deviceTypes: ['plug'],
        discoveryInterval: 1500,
        discoveryTimeout: 5000,
        breakoutChildren: false,
        ...(input.ip ? { devices: [{ host: input.ip }] } : {}),
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

        const validateParent = async (plug, key) => {
          try {
            const sysInfo = await plug.getSysInfo();
            const model = String(sysInfo.model || plug.model || '').toUpperCase();
            const parentId = sysInfo.deviceId || sysInfo.device_id || plug.deviceId;
            if (!model.startsWith(TPLINK_MODEL) || !parentId) return;

            const responses = await plug.sendSmartRequests([
              { method: 'get_child_device_list' },
            ]);
            const parent = {
              ip: plug.host,
              deviceId: parentId,
              name: getDiscoveryParentName(plug, sysInfo),
              children: getChildrenFromResponse(responses),
            };
            makeChannels({}, parent).forEach(channel => {
              if (
                !knownChildIds.has(channel.id) &&
                !discoveredDevices.some(device => device.data.id === channel.id)
              ) {
                discoveredDevices.push({
                  ip: parent.ip,
                  name: channel.name,
                  data: {
                    id: channel.id,
                    parentId: channel.parentId,
                    childId: channel.childId,
                    channelType: channel.channelType,
                  },
                  settings: {
                    settingIPAddress: parent.ip,
                    dynamicIp: false,
                    deviceId: channel.parentId,
                    childId: channel.childId,
                    channelType: channel.channelType,
                    channelName: channel.name,
                  },
                });
              }
            });
          } catch (error) {
            this.log(
              `Unable to validate a discovered ${TPLINK_MODEL}: ${getSafeErrorMessage(
                error,
                credentials.credentials,
              )}`,
            );
          } finally {
            pendingParents.delete(key);
          }
        };

        const collectParent = plug => {
          if (!acceptingCandidates) return;
          const key = plug.deviceId || plug.host;
          if (!key || pendingParents.has(key)) return;
          pendingParents.add(key);
          const validation = validateParent(plug, key);
          validations.add(validation);
          void validation.finally(() => validations.delete(validation));
        };

        client.on('plug-new', collectParent);
        client.on('plug-online', collectParent);
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
        let parent;
        try {
          parent = await validateTarget(input, pairingResolution.credentials);
        } catch (error) {
          throw new Error(
            `Unable to validate the selected ${TPLINK_MODEL}: ${getSafeErrorMessage(
              error,
              pairingResolution.credentials,
            )}`,
          );
        }
        if (!pairingOpen || version !== requestVersion) return [];
        const channels = makeChannels(input, parent);
        if (channels.length === 0) {
          throw new Error('No pairable KS240 channels were found at the supplied address.');
        }
        const finalized = await finalizeCredentialsForPairing(this, pairingResolution);

        channels.forEach(channel => {
          if (knownChildIds.has(channel.id)) return;
          devices.push({
            data: {
              id: channel.id || guid(),
              parentId: channel.parentId,
              childId: channel.childId,
              channelType: channel.channelType,
            },
            name: channel.name,
            settings: {
              settingIPAddress: parent.ip,
              dynamicIp: false,
              deviceId: channel.parentId,
              childId: channel.childId,
              channelType: channel.channelType,
              channelName: channel.name,
              ...finalized.settings,
            },
          });
        });
      }

      if (devices.length === 0) {
        throw new Error('All selected KS240 channels are already paired.');
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

module.exports = TPlinkKs240Driver;
