'use strict';

const Homey = require('homey');
const { Client } = require('tplink-smarthome-api');
const {
  getTpLinkClientOptions,
  normalizeTpLinkCredentials,
} = require('../../lib/tplink-auth');

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

  return (
    s4() +
    s4() +
    '-' +
    s4() +
    '-' +
    s4() +
    '-' +
    s4() +
    '-' +
    s4() +
    s4() +
    s4()
  );
}

function getChannelType(category) {
  if (category === 'kasa.switch.outlet.sub-fan') {
    return 'fan';
  }
  return 'light';
}

function getChannelName(parentName, category) {
  return `${parentName} ${getChannelType(category) === 'fan' ? 'Fan' : 'Light'}`;
}

function createClientFromSettings(settings) {
  return new Client(getTpLinkClientOptions(TPLINK_MODEL, settings));
}

function getDiscoveryParentName(plug) {
  if (typeof plug.alias === 'string' && plug.alias.length > 0) {
    return plug.alias;
  }

  if (
    plug.sysInfo &&
    typeof plug.sysInfo.alias === 'string' &&
    plug.sysInfo.alias.length > 0
  ) {
    return plug.sysInfo.alias;
  }

  if (
    plug.sysInfo &&
    typeof plug.sysInfo.dev_name === 'string' &&
    plug.sysInfo.dev_name.length > 0
  ) {
    return plug.sysInfo.dev_name;
  }

  if (typeof plug.name === 'string' && plug.name.length > 0) {
    return plug.name;
  }

  return 'KS240';
}

class TPlinkKs240Driver extends Homey.Driver {
  async onPair(session) {
    const knownChildIds = new Set();
    let activeDiscoveryClient = null;
    let activeDiscoveryTimer = null;

    try {
      Object.values(this.getDevices()).forEach(device => {
        const childId = device.getData().id;
        if (typeof childId === 'string' && childId.length > 0) {
          knownChildIds.add(childId);
        }
      });
      this.log('Existing child IDs: ' + knownChildIds.size);
    } catch (error) {
      this.log('Unable to read existing KS240 children: ' + error.message);
    }

    const stopActiveDiscovery = () => {
      if (activeDiscoveryTimer !== null) {
        clearTimeout(activeDiscoveryTimer);
        activeDiscoveryTimer = null;
      }
      if (activeDiscoveryClient !== null) {
        activeDiscoveryClient.removeAllListeners();
        activeDiscoveryClient.stopDiscovery();
        activeDiscoveryClient = null;
      }
    };

    session.setHandler('discover', async data => {
      stopActiveDiscovery();

      const discoveredDevices = [];
      const pairingInput = Array.isArray(data) ? data[0] || {} : data || {};
      const credentials = normalizeTpLinkCredentials(pairingInput);
      const specifiedIp = pairingInput.ip;
      const discoveryClient = createClientFromSettings(pairingInput);
      activeDiscoveryClient = discoveryClient;

      const discoveryOptions = {
        deviceTypes: ['plug'],
        discoveryInterval: 1500,
        discoveryTimeout: 3000,
        breakoutChildren: false,
        ...(typeof specifiedIp === 'string' && specifiedIp.length > 0
          ? { devices: [{ host: specifiedIp }] }
          : {}),
      };
      const queriedParentIds = new Set();
      let finished = false;

      const collectChildren = async plug => {
        try {
          const model = typeof plug.model === 'string' ? plug.model : '';
          if (
            finished ||
            !model.startsWith(TPLINK_MODEL) ||
            queriedParentIds.has(plug.deviceId)
          ) {
            return;
          }
          queriedParentIds.add(plug.deviceId);

          const responses = await plug.sendSmartRequests([
            { method: 'get_child_device_list' },
          ]);
          if (finished) return;

          const childListResponse = responses.get_child_device_list;
          const childList =
            childListResponse && Array.isArray(childListResponse.child_device_list)
            ? childListResponse.child_device_list
            : [];
          const parentInfo = plug.sysInfo || {};
          const parentDeviceId =
            parentInfo.deviceId || parentInfo.device_id || plug.deviceId;
          const parentName = getDiscoveryParentName(plug);

          childList.forEach(child => {
            if (typeof child.device_id !== 'string') {
              return;
            }

            const channelType = getChannelType(child.category);
            const childId = child.device_id;
            const channelName =
              typeof child.alias === 'string' && child.alias.length > 0
                ? child.alias
                : getChannelName(parentName, child.category);

            if (!knownChildIds.has(childId)) {
              if (!discoveredDevices.some(device => device.data.id === childId)) {
                discoveredDevices.push({
                  ip: plug.host,
                  data: {
                    id: childId,
                    parentId: parentDeviceId,
                    childId,
                    channelType,
                  },
                  name: channelName,
                  settings: {
                    settingIPAddress: plug.host,
                    dynamicIp: false,
                    deviceId: parentDeviceId,
                    childId,
                    channelType,
                    channelName,
                    deviceUsername: credentials.username,
                    devicePassword: credentials.password,
                  },
                });
              }
            }
          });
        } catch (error) {
          queriedParentIds.delete(plug.deviceId);
          this.log('Error collecting KS240 children: ' + error.message);
        }
      };

      const finishDiscovery = () => {
        if (finished) return;
        finished = true;
        if (activeDiscoveryTimer !== null) {
          clearTimeout(activeDiscoveryTimer);
          activeDiscoveryTimer = null;
        }
        discoveryClient.removeAllListeners();
        discoveryClient.stopDiscovery();
        if (activeDiscoveryClient === discoveryClient) {
          activeDiscoveryClient = null;
        }

        if (discoveredDevices.length > 0) {
          this.log('Discovered ' + discoveredDevices.length + ' KS240 child device(s)');
          session.emit('discovered_devices', discoveredDevices);
        } else {
          this.log('No KS240 child devices discovered');
          session.emit('discovery_failed', { devicesFound: false });
        }
      };

      discoveryClient.on('plug-new', collectChildren);
      discoveryClient.on('plug-online', collectChildren);
      discoveryClient.on('error', error => {
        this.log('KS240 discovery error: ' + error.message);
      });
      discoveryClient.startDiscovery(discoveryOptions);
      activeDiscoveryTimer = setTimeout(
        finishDiscovery,
        discoveryOptions.discoveryTimeout + 25
      );
      this.log(
        'Starting KS240 discovery with TP-Link account credentials: ' +
          (credentials.username ? 'yes' : 'no')
      );
    });

    session.setHandler('get_devices', async data => {
      const devices = (Array.isArray(data) ? data : [data]).map(device => {
        const settings = device.settings || {};
        const deviceData = device.data || {};
        const credentials = normalizeTpLinkCredentials({
          deviceUsername: settings.deviceUsername ?? device.deviceUsername,
          devicePassword: settings.devicePassword ?? device.devicePassword,
        });
        const channelType =
          settings.channelType ?? deviceData.channelType ?? 'light';

        return {
          data: {
            id: deviceData.id ?? guid(),
            parentId: deviceData.parentId ?? settings.deviceId,
            childId: deviceData.childId ?? settings.childId,
            channelType,
          },
          name: device.name,
          settings: {
            settingIPAddress: settings.settingIPAddress ?? device.ip,
            dynamicIp:
              typeof settings.dynamicIp === 'boolean'
                ? settings.dynamicIp
                : false,
            deviceUsername: credentials.username,
            devicePassword: credentials.password,
            deviceId: settings.deviceId ?? deviceData.parentId,
            childId: settings.childId ?? deviceData.childId,
            channelType,
            channelName: settings.channelName ?? device.name,
          },
        };
      });

      this.log('Processed ' + devices.length + ' KS240 pairing device(s)');
      session.emit('continue', null);

      session.setHandler('list_devices', async () => devices);
    });

    session.setHandler('cancel', () => {
      this.log('KS240 pairing cancelled');
      stopActiveDiscovery();
    });

    session.setHandler('disconnect', () => {
      this.log('KS240 pairing finished or aborted');
      stopActiveDiscovery();
    });
  }
}

module.exports = TPlinkKs240Driver;
