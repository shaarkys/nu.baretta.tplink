'use strict';
// need Homey module, see SDK Guidelines
const Homey = require('homey');

const {
    Client
} = require('tplink-smarthome-api');
const {
    getTpLinkClientOptions,
    normalizeTpLinkCredentials
} = require('../../lib/tplink-auth');

// get driver name based on dirname
function getDriverName() {
    var parts = __dirname.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1].split('.')[0];
}
var TPlinkModel = getDriverName().toUpperCase();

function getDiscoveryDeviceName(plug) {
    if (typeof plug.alias === 'string' && plug.alias.length > 0) {
        return plug.alias;
    }

    if (plug.sysInfo && typeof plug.sysInfo.alias === 'string' && plug.sysInfo.alias.length > 0) {
        return plug.sysInfo.alias;
    }

    if (typeof plug.name === 'string' && plug.name.length > 0) {
        return plug.name;
    }

    if (plug.sysInfo && typeof plug.sysInfo.model === 'string' && plug.sysInfo.model.length > 0) {
        return plug.sysInfo.model;
    }

    return plug.model;
}

function guid() {
    function s4() {
        return Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    }
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
}

class TPlinkPlugDriver extends Homey.Driver {

    async onPair(session) {
        const knownDeviceIds = new Set();
        let activeDiscoveryClient = null;
        let activeDiscoveryTimer = null;

        try {
            Object.values(this.getDevices()).forEach(device => {
                const deviceId = device.getSettings().deviceId;
                if (typeof deviceId === 'string' && deviceId.length > 0) {
                    knownDeviceIds.add(deviceId);
                }
            });
            this.log('Existing device IDs: ' + knownDeviceIds.size);
        } catch (err) {
            this.log('Unable to read existing devices: ' + err.message);
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

            const pairingInput = Array.isArray(data) ? data[0] || {} : data || {};
            const credentials = normalizeTpLinkCredentials(pairingInput);
            const discoveryClient = new Client(
                getTpLinkClientOptions(TPlinkModel, pairingInput)
            );
            const discoveredDevices = [];
            const discoveryOptions = {
                deviceTypes: ['plug'],
                discoveryInterval: 1500,
                discoveryTimeout: 2000
            };
            let finished = false;

            activeDiscoveryClient = discoveryClient;

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
                    this.log('Discovered ' + discoveredDevices.length + ' S500D device(s)');
                    session.emit('discovered_devices', discoveredDevices);
                } else {
                    this.log('No S500D devices discovered');
                    session.emit('discovery_failed', { devicesFound: false });
                }
            };

            const collectPlug = plug => {
                try {
                    const model = typeof plug.model === 'string' ? plug.model : '';
                    if (!model.startsWith(TPlinkModel) || knownDeviceIds.has(plug.deviceId)) {
                        return;
                    }
                    if (discoveredDevices.some(device => device.deviceId === plug.deviceId)) {
                        return;
                    }

                    discoveredDevices.push({
                        ip: plug.host,
                        name: getDiscoveryDeviceName(plug),
                        deviceId: plug.deviceId,
                        deviceUsername: credentials.username,
                        devicePassword: credentials.password
                    });
                } catch (err) {
                    this.log('Error collecting discovered S500D device: ' + err.message);
                }
            };

            discoveryClient.on('plug-new', collectPlug);
            discoveryClient.on('plug-online', collectPlug);
            discoveryClient.on('error', err => {
                this.log('S500D discovery error: ' + err.message);
            });
            discoveryClient.startDiscovery(discoveryOptions);
            activeDiscoveryTimer = setTimeout(
                finishDiscovery,
                discoveryOptions.discoveryTimeout + 25
            );
            this.log(
                'Starting S500D discovery with TP-Link account credentials: ' +
                (credentials.username ? 'yes' : 'no')
            );
        });

        session.setHandler('get_devices', async data => {
            const inputData = Array.isArray(data) ? data : [data];
            const devices = inputData.map(device => {
                const credentials = normalizeTpLinkCredentials(device || {});
                return {
                    data: { id: guid() },
                    name: device.name,
                    settings: {
                        settingIPAddress: device.ip,
                        deviceUsername: credentials.username,
                        devicePassword: credentials.password,
                        deviceId: device.deviceId,
                        dynamicIp: false,
                        totalOffset: 0
                    }
                };
            });

            this.log('Processed ' + devices.length + ' S500D pairing device(s)');
            session.emit('continue', null);
            session.setHandler('list_devices', async () => devices);
        });

        session.setHandler('cancel', () => {
            this.log('S500D pairing cancelled');
            stopActiveDiscovery();
        });

        session.setHandler('disconnect', () => {
            this.log('S500D pairing finished or aborted');
            stopActiveDiscovery();
        });
    }
}

module.exports = TPlinkPlugDriver;
