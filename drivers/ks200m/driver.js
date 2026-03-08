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

function logEvent(eventName, plug) {
  console.log(`${new Date().toISOString()} ${eventName} ${plug.model} ${plug.host}`);
}

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

class TPlinkKs200mDriver extends Homey.Driver {
  async onPair(session) {
    const knownDeviceIds = {};

    try {
      const appDevices = this.getDevices();
      Object.values(appDevices).forEach(device => {
        const deviceId = device.getSettings().deviceId;
        if (deviceId) {
          knownDeviceIds[deviceId] = true;
        }
      });
      this.log('Existing devIDs: ' + JSON.stringify(knownDeviceIds));
    } catch (error) {
      this.log(error);
    }

    session.setHandler('discover', async () => {
      const discoveredDevices = [];
      const discoveryOptions = {
        deviceTypes: 'plug',
        discoveryInterval: 1500,
        discoveryTimeout: 2000,
      };

      const discovery = client.startDiscovery(discoveryOptions);
      this.log('Starting Plug Discovery');

      discovery.on('plug-new', async plug => {
        try {
          logEvent('Found plug-new type', plug);
          const sysInfo = await plug.getSysInfo();
          const deviceId = plug.deviceId || sysInfo.deviceId || sysInfo.device_id;
          const deviceName =
            sysInfo.name || sysInfo.alias || sysInfo.dev_name || sysInfo.model;

          if (plug.model.match(MODEL_REGEX) && deviceId && !knownDeviceIds[deviceId]) {
            if (!discoveredDevices.some(device => device.deviceId === deviceId)) {
              this.log(
                'New Plug found: ' +
                  plug.host +
                  ' model ' +
                  plug.model +
                  ' name ' +
                  deviceName +
                  ' id ' +
                  deviceId
              );
              discoveredDevices.push({
                ip: plug.host,
                name: deviceName,
                deviceId,
              });
            }
          }
        } catch (error) {
          this.log('Error discovering new plug: ' + error.message);
        }
      });

      discovery.on('plug-online', async plug => {
        try {
          const sysInfo = await plug.getSysInfo();
          const deviceId = plug.deviceId || sysInfo.deviceId || sysInfo.device_id;
          const deviceName =
            sysInfo.name || sysInfo.alias || sysInfo.dev_name || sysInfo.model;

          if (plug.model.match(MODEL_REGEX) && deviceId && !knownDeviceIds[deviceId]) {
            if (!discoveredDevices.some(device => device.deviceId === deviceId)) {
              this.log(
                'Online plug found: ' +
                  plug.host +
                  ' model ' +
                  plug.model +
                  ' name ' +
                  deviceName +
                  ' id ' +
                  deviceId
              );
              discoveredDevices.push({
                ip: plug.host,
                name: deviceName,
                deviceId,
              });
            }
          }
        } catch (error) {
          this.log('Error discovering online plug: ' + error.message);
        }
      });

      setTimeout(() => {
        client.stopDiscovery();

        if (discoveredDevices.length > 0) {
          session.emit('discovered_devices', discoveredDevices);
          this.log('Discovered devices: ' + JSON.stringify(discoveredDevices));
          return discoveredDevices;
        }

        this.log('No devices discovered');
        session.emit('discovery_failed', { devicesFound: false });
        return [];
      }, discoveryOptions.discoveryTimeout);
    });

    session.setHandler('get_devices', async data => {
      this.log('Received get_devices data: ' + JSON.stringify(data));

      const inputData = Array.isArray(data) ? data : [data];
      const devices = inputData.map(device => ({
        data: { id: guid() },
        name: device.name,
        settings: {
          settingIPAddress: device.ip,
          dynamicIp: false,
          deviceId: device.deviceId,
        },
      }));

      this.log('Processed devices: ' + JSON.stringify(devices));
      session.emit('continue', null);

      session.setHandler('list_devices', async () => devices);
    });

    session.setHandler('disconnect', () => {
      this.log('Pairing is finished (done or aborted)');
    });
  }
}

module.exports = TPlinkKs200mDriver;
