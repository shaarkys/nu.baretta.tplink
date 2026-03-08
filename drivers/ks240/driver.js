'use strict';

const Homey = require('homey');
const { Client } = require('tplink-smarthome-api');

function getDriverName() {
  const parts = __dirname.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1].split('.')[0];
}

const TPLINK_MODEL = getDriverName().toUpperCase();
const MODEL_REGEX = new RegExp(TPLINK_MODEL, 'g');

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
    const knownChildIds = {};
    let activeDiscoveryClient = null;

    try {
      const appDevices = this.getDevices();
      Object.values(appDevices).forEach(device => {
        const childId = device.getData().id;
        if (childId) {
          knownChildIds[childId] = true;
        }
      });
      this.log('Existing child IDs: ' + JSON.stringify(knownChildIds));
    } catch (error) {
      this.log(error);
    }

    session.setHandler('discover', async data => {
      const discoveredDevices = [];
      const inputData = Array.isArray(data) ? data : [data];
      const firstInput = inputData.length > 0 ? inputData[0] : undefined;
      const specifiedIp =
        firstInput && firstInput.ip
          ? firstInput.ip
          : undefined;
      const discoveryClient = createClientFromSettings(firstInput);
      activeDiscoveryClient = discoveryClient;

      const discoveryOptions = {
        deviceTypes: 'plug',
        discoveryInterval: 1500,
        discoveryTimeout: 3000,
        breakoutChildren: false,
        ...(specifiedIp ? { devices: [specifiedIp] } : {}),
      };

      const discovery = discoveryClient.startDiscovery(discoveryOptions);
      this.log(
        'Starting KS240 discovery with options: ' +
          JSON.stringify(discoveryOptions)
      );

      const collectChildren = async plug => {
        try {
          if (!plug.model.match(MODEL_REGEX)) {
            return;
          }

          const responses = await plug.sendSmartRequests([
            { method: 'get_child_device_list' },
          ]);

          const childListResponse = responses.get_child_device_list;
          const childList = Array.isArray(childListResponse.child_device_list)
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

            if (!knownChildIds[childId]) {
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
                    deviceUsername: normalizeOptionalSetting(
                      firstInput?.deviceUsername
                    ),
                    devicePassword:
                      typeof firstInput?.devicePassword === 'string'
                        ? firstInput.devicePassword
                        : '',
                  },
                });
              }
            }
          });
        } catch (error) {
          this.log('Error collecting KS240 children: ' + error.message);
        }
      };

      discovery.on('plug-new', collectChildren);
      discovery.on('plug-online', collectChildren);

      setTimeout(() => {
        discoveryClient.stopDiscovery();
        if (activeDiscoveryClient === discoveryClient) {
          activeDiscoveryClient = null;
        }

        if (discoveredDevices.length > 0) {
          session.emit('discovered_devices', discoveredDevices);
          this.log('Discovered devices: ' + JSON.stringify(discoveredDevices));
          return discoveredDevices;
        }

        this.log('No KS240 child devices discovered');
        session.emit('discovery_failed', { devicesFound: false });
        return [];
      }, discoveryOptions.discoveryTimeout);
    });

    session.setHandler('get_devices', async data => {
      this.log('Received get_devices data: ' + JSON.stringify(data));

      const devices = (Array.isArray(data) ? data : [data]).map(device => ({
        data: {
          id: device.data?.id || guid(),
          parentId: device.data?.parentId || device.settings?.deviceId,
          childId: device.data?.childId || device.settings?.childId,
          channelType:
            device.data?.channelType || device.settings?.channelType || 'light',
        },
        name: device.name,
        settings: {
          settingIPAddress: device.settings?.settingIPAddress || device.ip,
          dynamicIp:
            typeof device.settings?.dynamicIp === 'boolean'
              ? device.settings.dynamicIp
              : false,
          deviceUsername: normalizeOptionalSetting(
            device.settings?.deviceUsername || device.deviceUsername
          ),
          devicePassword:
            typeof (device.settings?.devicePassword || device.devicePassword) ===
            'string'
              ? device.settings?.devicePassword || device.devicePassword
              : '',
          deviceId:
            device.settings?.deviceId || device.data?.parentId || undefined,
          childId: device.settings?.childId || device.data?.childId,
          channelType:
            device.settings?.channelType ||
            device.data?.channelType ||
            'light',
          channelName: device.settings?.channelName || device.name,
        },
      }));

      this.log('Processed devices: ' + JSON.stringify(devices));
      session.emit('continue', null);

      session.setHandler('list_devices', async () => devices);
    });

    session.setHandler('cancel', () => {
      this.log('Pairing cancelled, state reset.');
      if (activeDiscoveryClient != null) activeDiscoveryClient.stopDiscovery();
    });

    session.setHandler('disconnect', () => {
      this.log('Pairing is finished (done or aborted)');
      if (activeDiscoveryClient != null) activeDiscoveryClient.stopDiscovery();
    });
  }
}

module.exports = TPlinkKs240Driver;
