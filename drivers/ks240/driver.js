'use strict';

const Homey = require('homey');
const { Client } = require('tplink-smarthome-api');

const client = new Client();

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

class TPlinkKs240Driver extends Homey.Driver {
  async onPair(session) {
    const knownChildIds = {};

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
      const specifiedIp =
        inputData.length > 0 && inputData[0] && inputData[0].ip
          ? inputData[0].ip
          : undefined;

      const discoveryOptions = {
        deviceTypes: 'plug',
        discoveryInterval: 1500,
        discoveryTimeout: 3000,
        breakoutChildren: false,
        ...(specifiedIp ? { devices: [specifiedIp] } : {}),
      };

      const discovery = client.startDiscovery(discoveryOptions);
      this.log(
        'Starting KS240 discovery with options: ' +
          JSON.stringify(discoveryOptions)
      );

      const collectChildren = async plug => {
        try {
          if (!plug.model.match(MODEL_REGEX)) {
            return;
          }

          const parentInfo = await plug.getSysInfo();
          const responses = await plug.sendSmartRequests([
            { method: 'get_child_device_list' },
          ]);

          const childListResponse = responses.get_child_device_list;
          const childList = Array.isArray(childListResponse.child_device_list)
            ? childListResponse.child_device_list
            : [];

          childList.forEach(child => {
            if (typeof child.device_id !== 'string') {
              return;
            }

            const channelType = getChannelType(child.category);
            const childId = child.device_id;
            const parentName =
              parentInfo.alias || parentInfo.dev_name || plug.alias || 'KS240';
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
                    parentId: parentInfo.deviceId,
                    childId,
                    channelType,
                  },
                  name: channelName,
                  settings: {
                    settingIPAddress: plug.host,
                    dynamicIp: false,
                    deviceId: parentInfo.deviceId,
                    childId,
                    channelType,
                    channelName,
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
        client.stopDiscovery();

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
      client.stopDiscovery();
    });

    session.setHandler('disconnect', () => {
      this.log('Pairing is finished (done or aborted)');
      client.stopDiscovery();
    });
  }
}

module.exports = TPlinkKs240Driver;
