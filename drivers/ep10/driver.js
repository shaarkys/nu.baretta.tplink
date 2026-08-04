'use strict';
// need Homey module, see SDK Guidelines
const Homey = require('homey');

const {
    Client
} = require('tplink-smarthome-api');
const {
    getTpLinkDiscoveryClientOptions,
    isValidTpLinkTransport,
    normalizeTpLinkCredentials
} = require('../../lib/tplink-auth');

// get driver name based on dirname
function getDriverName() {
    var parts = __dirname.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1].split('.')[0];
}
var TPlinkModel = getDriverName().toUpperCase();
var myRegEx = new RegExp(TPlinkModel, 'g');

//var devIds = {};
var logEvent = function (eventName, plug) {
    //this.log(`${(new Date()).toISOString()} ${eventName} ${plug.model} ${plug.host} ${plug.deviceId}`);
    console.log(`${(new Date()).toISOString()} ${eventName} ${plug.model} ${plug.host}`);
};

function guid() {
    function s4() {
        return Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    }
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
}

function getPairingInput(value) {
    const input = value && typeof value === 'object' ? value : {};
    const data = input.data && typeof input.data === 'object' ? input.data : {};
    const settings = input.settings && typeof input.settings === 'object' ? input.settings : {};
    const credentials = normalizeTpLinkCredentials({
        deviceUsername: input.deviceUsername ?? input.username ?? settings.deviceUsername,
        devicePassword: input.devicePassword ?? input.password ?? settings.devicePassword
    });

    return {
        ip: typeof input.ip === 'string' ? input.ip.trim() : '',
        name: typeof input.name === 'string' ? input.name.trim() : '',
        deviceId: typeof input.deviceId === 'string' ? input.deviceId : '',
        transport: isValidTpLinkTransport(input.transport)
            ? input.transport
            : (isValidTpLinkTransport(data.transport) ? data.transport : undefined),
        ...credentials
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
        plug && plug.model
    ].find(value => typeof value === 'string' && value.length > 0) || TPlinkModel;
}

function getSafeErrorMessage(error, credentials) {
    let message = error && typeof error.message === 'string' ? error.message : 'Unknown error';

    [credentials && credentials.username, credentials && credentials.password]
        .filter(value => typeof value === 'string' && value.length > 0)
        .forEach(secret => {
            message = message.split(secret).join('[redacted]');
        });

    return message;
}

class TPlinkPlugDriver extends Homey.Driver {

    async onPair(session) {
        const knownDeviceIds = new Set();
        let activeDiscovery = null;
        let discoveryRequest = 0;
        let pairingOpen = true;

        try {
            Object.values(this.getDevices()).forEach(device => {
                const deviceId = device.getSettings().deviceId;
                if (typeof deviceId === 'string' && deviceId.length > 0) {
                    knownDeviceIds.add(deviceId);
                }
            });
            this.log('Existing EP10 device IDs: ' + knownDeviceIds.size);
        } catch (err) {
            this.log('Unable to read existing EP10 devices: ' + getSafeErrorMessage(err));
        }

        const stopActiveDiscovery = () => {
            if (activeDiscovery !== null) {
                activeDiscovery.finish();
            }
        };

        const discoverEp10Devices = (input, targetHost) => {
            stopActiveDiscovery();

            const credentialSettings = {
                deviceUsername: input.username,
                devicePassword: input.password
            };
            const credentials = normalizeTpLinkCredentials(credentialSettings);
            const discoveryClient = new Client(getTpLinkDiscoveryClientOptions(credentialSettings));
            const discoveryOptions = {
                deviceTypes: ['plug'],
                discoveryInterval: 1500,
                discoveryTimeout: 5000,
                ...(targetHost ? {
                    // The API sends direct legacy and SMART discovery probes to each device.
                    broadcast: targetHost,
                    devices: [{ host: targetHost }]
                } : {})
            };

            return new Promise(resolve => {
                const discoveredDevices = [];
                const pendingCandidates = new Set();
                const validationPromises = new Set();
                let acceptingCandidates = true;
                let finishTimer = null;
                let finishPromise = null;

                const finishDiscovery = () => {
                    if (finishPromise !== null) return finishPromise;
                    acceptingCandidates = false;
                    if (finishTimer !== null) clearTimeout(finishTimer);
                    discoveryClient.stopDiscovery();
                    discoveryClient.removeAllListeners();
                    if (activeDiscovery && activeDiscovery.client === discoveryClient) {
                        activeDiscovery = null;
                    }
                    finishPromise = Promise.allSettled([...validationPromises]).then(() => {
                        resolve(discoveredDevices);
                    });
                    return finishPromise;
                };

                const validatePlug = async (plug, candidateKey) => {
                    try {
                        // SMART discovery metadata identifies the transport, but a plug is
                        // only pairable after a credentialed request can read it.
                        const sysInfo = await plug.getSysInfo();
                        const model = typeof sysInfo.model === 'string' ? sysInfo.model : plug.model;
                        const deviceId = sysInfo.deviceId || sysInfo.device_id || plug.deviceId;
                        if (
                            !String(model || '').toUpperCase().startsWith(TPlinkModel) ||
                            !deviceId ||
                            knownDeviceIds.has(deviceId) ||
                            discoveredDevices.some(device => device.deviceId === deviceId)
                        ) return;

                        logEvent('Found accessible EP10', plug);
                        discoveredDevices.push({
                            ip: plug.host,
                            name: getDiscoveryDeviceName(plug, sysInfo),
                            deviceId,
                            transport: isValidTpLinkTransport(plug.defaultSendOptions.transport)
                                ? plug.defaultSendOptions.transport
                                : 'tcp'
                        });
                    } catch (err) {
                        this.log('Unable to validate a discovered EP10: ' + getSafeErrorMessage(err, credentials));
                    } finally {
                        pendingCandidates.delete(candidateKey);
                    }
                };

                const collectPlug = plug => {
                    if (!acceptingCandidates || (targetHost && plug.host !== targetHost)) return;

                    const candidateKey = plug.deviceId || plug.host;
                    if (!candidateKey || pendingCandidates.has(candidateKey)) return;
                    pendingCandidates.add(candidateKey);

                    const validationPromise = validatePlug(plug, candidateKey);
                    validationPromises.add(validationPromise);
                    void validationPromise.finally(() => validationPromises.delete(validationPromise));
                };

                discoveryClient.on('plug-new', collectPlug);
                discoveryClient.on('plug-online', collectPlug);
                discoveryClient.on('error', err => {
                    if (acceptingCandidates) {
                        this.log('EP10 discovery error: ' + getSafeErrorMessage(err, credentials));
                    }
                });

                activeDiscovery = { client: discoveryClient, finish: finishDiscovery };
                try {
                    discoveryClient.startDiscovery(discoveryOptions);
                    finishTimer = setTimeout(() => {
                        void finishDiscovery();
                    }, discoveryOptions.discoveryTimeout);
                } catch (err) {
                    this.log('Unable to start EP10 discovery: ' + getSafeErrorMessage(err, credentials));
                    void finishDiscovery();
                }
            });
        };

        const createPairedDevice = input => {
            const pairingInput = getPairingInput(input);
            if (!isValidTpLinkTransport(pairingInput.transport)) {
                throw new Error('EP10 pairing did not detect a supported transport.');
            }

            return {
                data: {
                    id: guid(),
                    transport: pairingInput.transport
                },
                name: pairingInput.name || TPlinkModel,
                settings: {
                    settingIPAddress: pairingInput.ip,
                    dynamicIp: false,
                    totalOffset: 0,
                    deviceUsername: pairingInput.username,
                    devicePassword: pairingInput.password,
                    deviceId: pairingInput.deviceId
                }
            };
        };

        session.setHandler('discover', async data => {
            const requestId = ++discoveryRequest;
            const pairingInput = getPairingInput(data);
            this.log('Starting EP10 discovery with TP-Link account credentials: ' + (pairingInput.username ? 'yes' : 'no'));

            const discoveredDevices = await discoverEp10Devices(pairingInput);
            if (!pairingOpen || requestId !== discoveryRequest) return [];

            if (discoveredDevices.length > 0) {
                this.log('Discovered ' + discoveredDevices.length + ' EP10 device(s)');
                await session.emit('discovered_devices', discoveredDevices);
            } else {
                this.log('No accessible EP10 devices discovered');
                await session.emit('discovery_failed', { devicesFound: false });
            }

            return discoveredDevices;
        });

        session.setHandler('get_devices', async data => {
            const requestId = ++discoveryRequest;
            const inputs = (Array.isArray(data) ? data : [data]).map(getPairingInput);
            const devices = [];

            for (const pairingInput of inputs) {
                if (!pairingInput.ip) {
                    throw new Error('An IP address is required to pair an EP10 manually.');
                }

                this.log('Validating the supplied EP10 IP address with TP-Link account credentials: ' + (pairingInput.username ? 'yes' : 'no'));
                const matches = await discoverEp10Devices(pairingInput, pairingInput.ip);
                if (!pairingOpen || requestId !== discoveryRequest) return [];

                const matchedDevice = matches.find(device => device.ip === pairingInput.ip);
                if (!matchedDevice) {
                    throw new Error('No accessible EP10 was found at the supplied IP address. Check the address and, for authenticated firmware, the TP-Link account credentials.');
                }
                if (pairingInput.deviceId && pairingInput.deviceId !== matchedDevice.deviceId) {
                    throw new Error('The EP10 found at the supplied IP address no longer matches the device selected during discovery.');
                }

                const resolvedInput = {
                    ...pairingInput,
                    ...matchedDevice,
                    name: pairingInput.name || matchedDevice.name
                };
                devices.push(createPairedDevice(resolvedInput));
            }

            session.setHandler('list_devices', async () => devices);
            this.log('Prepared ' + devices.length + ' EP10 device(s) for pairing');
            await session.emit('continue', null);
            return devices;
        });

        session.setHandler('cancel', () => {
            pairingOpen = false;
            discoveryRequest += 1;
            this.log('EP10 pairing cancelled');
            stopActiveDiscovery();
        });

        session.setHandler('disconnect', () => {
            pairingOpen = false;
            discoveryRequest += 1;
            this.log('EP10 pairing finished or aborted');
            stopActiveDiscovery();
        });
    }
}

module.exports = TPlinkPlugDriver;
