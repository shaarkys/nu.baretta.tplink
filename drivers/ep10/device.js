'use strict';
const Homey = require('homey');
const {
    Client
} = require('tplink-smarthome-api');
const {
    getEp10ClientOptions,
    getEp10Transport,
    getTpLinkDiscoveryClientOptions,
    isValidTpLinkTransport,
    normalizeTpLinkCredentials
} = require('../../lib/tplink-auth');

// get driver name based on dirname
function getDriverName() {
    var parts = __dirname.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1].split('.')[0];
};

var TPlinkModel = getDriverName().toUpperCase();

function createClientFromSettings(data, settings, activeTransport) {
    const options = getEp10ClientOptions(data, settings);

    if (!isValidTpLinkTransport(data.transport) && isValidTpLinkTransport(activeTransport)) {
        options.defaultSendOptions.transport = activeTransport;
    }

    return new Client(options);
}

function getSafeErrorMessage(error, settings = {}) {
    let message = error && typeof error.message === 'string' ? error.message : 'Unknown error';
    const credentials = normalizeTpLinkCredentials(settings);

    [credentials.username, credentials.password]
        .filter(value => value.length > 0)
        .forEach(secret => {
            message = message.split(secret).join('[redacted]');
        });

    return message;
}

function getDiscoveredTransport(plug) {
    const transport = plug && plug.defaultSendOptions ? plug.defaultSendOptions.transport : undefined;
    return isValidTpLinkTransport(transport) ? transport : undefined;
}


class TPlinkPlugDevice extends Homey.Device {

    async onInit() {
        this.log('device init');
        let device = this;

        // console.dir(this.getSettings()); // for debugging
        // console.dir(this.getData()); // for debugging
        let settings = this.getSettings();
        let id = this.getData().id;
        this.log('id: ', id);
        this.log('name: ', this.getName());
        this.log('class: ', this.getClass());
        this.log('settings IP address: ', settings["settingIPAddress"])
        this.log('Driver ID: ', TPlinkModel);

        // in case the device was not paired with a version including the dynamicIp setting, set it to false
        if ((settings["dynamicIp"] != undefined) && (typeof (settings["dynamicIp"]) === 'boolean')) {
            this.log("dynamicIp is defined: " + settings["dynamicIp"])
        } else {
            this.setSettings({
                dynamicIp: false
            }).catch(this.error);
        }

        this.activeTransport = getEp10Transport(this.getData(), settings);
        this.client = createClientFromSettings(this.getData(), settings, this.activeTransport);
        this.activeDiscovery = null;
        this.log('EP10 transport configured: ' + this.activeTransport);
        this.log('TP-Link account credentials configured: ' + (normalizeTpLinkCredentials(settings).username ? 'yes' : 'no'));

        this.log('settings totalOffset: ', settings["totalOffset"])


        this.oldpowerState = ""; 
        this.oldtotalState = 0; 
        this.totalOffset = settings["totalOffset"] || 0; 
        this.oldvoltageState = 0; 
        this.oldcurrentState = 0; 
        this.unreachableCount = 0; 
        this.discoverCount = 0; 
        this.oldRelayState = this.getCapabilityValue('onoff') ? 1 : 0;
        let interval;
        // Ensures that the pollingInterval is properly set during initialization
        if (typeof settings["pollingInterval"] === 'number') {
            this.log("Polling interval is set: " + settings["pollingInterval"] + " seconds");
            interval = parseInt(settings["pollingInterval"], 10); // Safely parse it to an integer
        } else {
            // Default value set if pollingInterval is not defined or is incorrectly set
            try {
                await this.setSettings({ pollingInterval: 10 }); // Use await to ensure settings are applied
                this.log("Polling interval was undefined, set to default: 10 seconds");
                interval = 10; // Set interval to default after ensuring settings are applied
            } catch (error) {
                this.error('Failed to set default polling interval: ' + getSafeErrorMessage(error, settings));
                interval = 10; // Optionally set a default even in case of error to ensure continuity
            }
        }

        this.pollDevice(interval);

        this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
        // actually quite useless to have the 'ledonoff' function in the mobile interface...
        this.registerCapabilityListener('ledonoff', this.onCapabilityLedOnoff.bind(this));

        // Register flow card action listeners
        this.homey.flow.getActionCard('ledOn').registerRunListener(async (args, state) => {
            return args.device.ledOn(args.device.getSettings().settingIPAddress);
        });

        this.homey.flow.getActionCard('ledOff').registerRunListener(async (args, state) => {
            return args.device.ledOff(args.device.getSettings().settingIPAddress);
        });

        this.homey.flow.getActionCard('meter_reset').registerRunListener(async (args, state) => {
            return args.device.meter_reset(args.device.getSettings().settingIPAddress);
        });

        this.homey.flow.getActionCard('undo_meter_reset').registerRunListener(async (args, state) => {
            return args.device.undo_meter_reset(args.device.getSettings().settingIPAddress);
        });

    } // end onInit    

    onAdded() {
        let id = this.getData().id;
        this.log("Device added: " + id);
        let settings = this.getSettings();
    }

    // this method is called when the Device is deleted
    onDeleted() {
        let id = this.getData().id;
        this.log("Device deleted: " + id);
        clearInterval(this.pollingInterval);
        this.stopActiveDiscovery();
    }

    // this method is called when the Device has requested a state change (turned on or off)
    async onCapabilityOnoff(value, opts) {
        try {
            this.log("Capability called: onoff value:", value);
            let settings = this.getSettings();
            let device = settings["settingIPAddress"];
            if (value) {
                await this.powerOn(device);
            } else {
                await this.powerOff(device);
            }
            return null;
        } catch (err) {
            this.error('Error in onCapabilityOnoff: ' + getSafeErrorMessage(err, this.getSettings()));
            throw err;
        }
    }

    async onCapabilityLedOnoff(value, opts) {
        try {
            this.log("Capability called: LED onoff value:", value);
            let settings = this.getSettings();
            let device = settings["settingIPAddress"];
            if (value) {
                await this.ledOn(device);
            } else {
                await this.ledOff(device);
            }
            return null;
        } catch (err) {
            this.error('Error in onCapabilityLedOnoff: ' + getSafeErrorMessage(err, this.getSettings()));
            throw err;
        }
    }

    async onSettings({ oldSettings, newSettings, changedKeys }) {
        try {
            let credentialsChanged = false;
            for (const key of changedKeys) {
                switch (key) {
                    case 'settingIPAddress':
                        this.log('IP address changed to ' + newSettings.settingIPAddress);
                        // Re-initialize connection if IP address changes
                        if (!newSettings.dynamicIp) { // Only reconnect if dynamic IP is not used
                            await this.reinitializeConnection(newSettings.settingIPAddress);
                        }
                        break;
                    case 'pollingInterval':
                        const interval = parseInt(newSettings.pollingInterval, 10) || 10; // Ensure there's a fallback interval
                        this.log('Polling interval changed to ' + interval + ' seconds');
                        clearInterval(this.pollingInterval);
                        this.pollDevice(interval); // Start polling with the defined interval
                        break;
                    case 'dynamicIp':
                        this.log('Dynamic IP setting changed to ' + newSettings.dynamicIp);
                        break;
                    case 'deviceUsername':
                    case 'devicePassword':
                        credentialsChanged = true;
                        break;
                    default:
                        this.log('Unhandled setting change detected for key:', key);
                        break;
                }
            }

            if (credentialsChanged) {
                const settings = { ...this.getSettings(), ...newSettings };
                const previousClient = this.client;
                const previousTransport = this.activeTransport;
                this.activeTransport = getEp10Transport(this.getData(), settings);
                this.client = createClientFromSettings(this.getData(), settings, this.activeTransport);
                this.log('TP-Link account credentials updated');
                try {
                    await this.reinitializeConnection(settings.settingIPAddress, {
                        settings,
                        throwOnFailure: true
                    });
                } catch (err) {
                    this.activeTransport = previousTransport;
                    this.client = previousClient;
                    throw err;
                }
            }
        } catch (error) {
            this.error('Failed to handle settings change: ' + getSafeErrorMessage(error, newSettings));
            throw new Error('Failed to update settings: ' + getSafeErrorMessage(error, newSettings));
        }
    }

    async reinitializeConnection(ipAddress, {
        settings = this.getSettings(),
        throwOnFailure = false
    } = {}) {
        // Implement the logic to reinitialize the connection
        // For example, update the plug instance
        try {
            const sysInfo = await this.client.getSysInfo(ipAddress);
            this.plug = this.client.getPlug({ host: ipAddress, sysInfo });
            this.log('Reinitialized connection to', ipAddress);
        } catch (err) {
            const message = getSafeErrorMessage(err, settings);
            this.error('Error reinitializing connection: ' + message);
            if (throwOnFailure) throw new Error(message);
        }
    }

    async powerOn(device) {
        try {
            this.log('Turning device on ' + device);
            const sysInfo = await this.client.getSysInfo(device);
            this.plug = this.client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.setPowerState(true);
        } catch (err) {
            this.log('Error turning device on: ' + getSafeErrorMessage(err, this.getSettings()));

        }
    }


    async powerOff(device) {
        try {
            this.log('Turning device off ' + device);
            const sysInfo = await this.client.getSysInfo(device);
            this.plug = this.client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.setPowerState(false);
        } catch (err) {
            this.log('Error turning device off: ' + getSafeErrorMessage(err, this.getSettings()));

        }
    }

    getPower(device) {
        return this.client.getSysInfo(device)  // Ensure this function returns a promise
            .then(sysInfo => {
                this.plug = this.client.getPlug({ host: device, sysInfo: sysInfo });
                return this.plug.getSysInfo();
            })
            .then(sysInfo => {
                if (sysInfo.relay_state === 1) {
                    this.log('State - relay state is on');
                    return true;  // Return true when the relay is on
                } else {
                    this.log('Plug poll - relay is off');
                    return false; // Return false when the relay is off
                }
            })
            .catch(err => {
                this.log("Caught error in getPower function: " + getSafeErrorMessage(err, this.getSettings()));

            });
    }

    getLed(device) {
        return this.client.getSysInfo(device)  // Ensure this function returns a promise
            .then(sysInfo => {
                this.plug = this.client.getPlug({ host: device, sysInfo: sysInfo });
                return this.plug.getSysInfo();
            })
            .then(sysInfo => {
                if (sysInfo.led_off === 0) {
                    this.log('LED on');
                    return true;  // Return true if LED is on
                } else {
                    this.log('LED off');
                    return false; // Return false if LED is off
                }
            })
            .catch(err => {
                this.log("Caught error in getLed function: " + getSafeErrorMessage(err, this.getSettings()));

            });
    }

    async ledOn(device) {
        try {
            this.log('Turning LED on for device ' + device);
            const sysInfo = await this.client.getSysInfo(device);
            this.plug = this.client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.setLedState(true);
            await this.setCapabilityValue('ledonoff', true)
        } catch (err) {
            this.log('Error turning LED on: ' + getSafeErrorMessage(err, this.getSettings()));

        }
    }


    async ledOff(device) {
        try {
            this.log('Turning LED off for device ' + device);
            const sysInfo = await this.client.getSysInfo(device);
            this.plug = this.client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.setLedState(false);
            await this.setCapabilityValue('ledonoff', false);
        } catch (err) {
            this.log('Error turning LED off: ' + getSafeErrorMessage(err, this.getSettings()));

        }
    }


    async meter_reset(device) {
        this.log('Reset meter ');
        try {
            const sysInfo = await this.client.getSysInfo(device);
            this.plug = this.client.getPlug({ host: device, sysInfo: sysInfo });
            // reset meter for counters in Kasa app. Does not actually clear the total counter though...
            // this.plug.emeter.eraseStats(null);
            this.log('Setting totalOffset to oldtotalState: ' + this.oldtotalState);
            this.totalOffset = this.oldtotalState;
            await this.setSettings({
                totalOffset: this.totalOffset
            }).catch(this.error);
        } catch (err) {
            this.log('Error resetting meter: ' + getSafeErrorMessage(err, this.getSettings()));
        }
    }

    undo_meter_reset(device) {
        this.log('Undo reset meter, setting totalOffset to 0 ');
        // reset meter for counters in Kasa app. Does not actually clear the total counter though...
        this.totalOffset = 0;
        this.setSettings({
            totalOffset: this.totalOffset
        }).catch(this.error);
    }

    async getStatus() {
        let settings = this.getSettings();
        let device = settings.settingIPAddress;
        let TPlinkModel = getDriverName().toUpperCase();
        this.log("getStatus device: " + device + ", name: " + this.getName());

        try {
            const sysInfo = await this.client.getSysInfo(device);
            this.plug = this.client.getPlug({ host: device, sysInfo });

            const data = await this.plug.getInfo();

            // **Processing data starts here**

            if (settings["deviceId"] === undefined) {
                try {
                    await this.setSettings({ deviceId: data.sysInfo.deviceId });
                    this.log("DeviceId added: " + settings["deviceId"]);
                } catch (error) {
                    this.log("Error setting deviceId: " + getSafeErrorMessage(error, settings));
                }
            }

            if (!["HS100", "HS200", "HS220", "KS230", "KP405", "HS103", "EP10", "ES20M", "HS210"].includes(TPlinkModel)) {
                this.oldpowerState = this.getCapabilityValue('measure_power');
                this.oldtotalState = this.getCapabilityValue('meter_power');
                this.oldvoltageState = this.getCapabilityValue('measure_voltage');
                this.oldcurrentState = this.getCapabilityValue('measure_current');
                this.oldRelayState = this.getCapabilityValue('onoff') ? 1 : 0;

                var total = data.emeter.realtime.total;
                var corrected_total = total - this.totalOffset;
            }

            if (this.oldRelayState !== data.sysInfo.relay_state) {
                try {
                    if (data.sysInfo.relay_state === 1) {
                        this.log('Plug poll - relay is on ');
                        await this.setCapabilityValue('onoff', true);
                    } else {
                        this.log('Plug poll - relay is off ');
                        await this.setCapabilityValue('onoff', false);
                    }
                    this.oldRelayState = data.sysInfo.relay_state;
                } catch (error) {
                    this.log("Error setting capability value: " + getSafeErrorMessage(error, settings));
                }
            }

            // Update realtime data only if it changed
            if (!["HS100", "HS200", "HS220", "KS230", "KP405", "HS103", "EP10", "ES20M", "HS210"].includes(TPlinkModel)) {

                try {
                    if (this.oldtotalState != corrected_total) {
                        this.log("Total - Offset: " + corrected_total);
                        await this.setCapabilityValue('meter_power', corrected_total);
                    }

                    if (this.oldpowerState != data.emeter.realtime.power) {
                        this.log('Power changed: ' + data.emeter.realtime.power);
                        await this.setCapabilityValue('measure_power', data.emeter.realtime.power);
                    }
                    if (this.oldvoltageState != data.emeter.realtime.voltage) {
                        this.log('Voltage changed: ' + data.emeter.realtime.voltage);
                        await this.setCapabilityValue('measure_voltage', data.emeter.realtime.voltage);
                    }
                    if (this.oldcurrentState != data.emeter.realtime.current) {
                        this.log('Current changed: ' + data.emeter.realtime.current);
                        await this.setCapabilityValue('measure_current', data.emeter.realtime.current);
                    }
                } catch (error) {
                    this.log("Error updating capability values: " + getSafeErrorMessage(error, settings));
                }
            }

        } catch (err) {
            var errRegEx = new RegExp("EHOSTUNREACH|ETIMEDOUT|ENETUNREACH|ECONNREFUSED", 'g');
            if (getSafeErrorMessage(err, settings).match(errRegEx)) {
                this.unreachableCount += 1;
                this.log("Device unreachable. Unreachable count: " + this.unreachableCount + " Discover count: " + this.discoverCount + " DynamicIP option: " + settings["dynamicIp"]);

                // Attempt autodiscovery once every hour
                if ((this.unreachableCount % 360 == 3) && settings["dynamicIp"]) {
                    this.setUnavailable("Device offline");
                    this.discoverCount += 1;
                    this.log("Unreachable, starting autodiscovery");
                    this.discover();
                }
            }
            this.log("Caught error in getStatus function: " + getSafeErrorMessage(err, settings));
        }
    }

    pollDevice(interval) {
        clearInterval(this.pollingInterval);
        this.pollingInterval = setInterval(async () => {
            try {
                await this.getStatus();
            } catch (err) {
                this.log("Error during polling: " + getSafeErrorMessage(err, this.getSettings()));
                // Optionally, handle reconnection or retry logic here
            }
        }, 1000 * interval);
    }


    stopActiveDiscovery() {
        if (this.activeDiscovery !== undefined && this.activeDiscovery !== null) {
            this.activeDiscovery.finish();
        }
    }

    updateInMemoryTransport(transport, settings) {
        if (
            !isValidTpLinkTransport(transport) ||
            isValidTpLinkTransport(this.getData().transport) ||
            transport === this.activeTransport
        ) return;

        this.activeTransport = transport;
        this.client = createClientFromSettings(this.getData(), settings, transport);
        this.log('Updated in-memory EP10 transport from rediscovery: ' + transport);
    }

    async discover() {
        this.stopActiveDiscovery();

        const settings = this.getSettings();
        const discoveryClient = new Client(getTpLinkDiscoveryClientOptions(settings));
        const discoveryOptions = {
            deviceTypes: ['plug'],
            discoveryInterval: 10000,
            discoveryTimeout: 5000,
            offlineTolerance: 3
        };
        const pendingCandidates = new Set();
        let finished = false;
        let finishTimer = null;

        const finishDiscovery = () => {
            if (finished) return;
            finished = true;
            if (finishTimer !== null) clearTimeout(finishTimer);
            discoveryClient.stopDiscovery();
            discoveryClient.removeAllListeners();
            if (this.activeDiscovery && this.activeDiscovery.client === discoveryClient) {
                this.activeDiscovery = null;
            }
        };

        const handleDiscoveredPlug = async plug => {
            if (finished) return;

            const candidateKey = plug.deviceId || plug.host;
            if (!candidateKey || pendingCandidates.has(candidateKey)) return;
            pendingCandidates.add(candidateKey);

            try {
                const sysInfo = await plug.getSysInfo();
                const model = typeof sysInfo.model === 'string' ? sysInfo.model : plug.model;
                const deviceId = sysInfo.deviceId || sysInfo.device_id || plug.deviceId;
                if (
                    finished ||
                    !String(model || '').toUpperCase().startsWith(TPlinkModel) ||
                    !deviceId ||
                    deviceId !== settings.deviceId
                ) return;

                const transport = getDiscoveredTransport(plug);
                await this.setSettings({ settingIPAddress: plug.host });
                this.updateInMemoryTransport(transport, settings);
                await this.setAvailable();
                this.log('Discovered online plug: ' + deviceId);
                this.log('Resetting unreachable count to 0');
                this.unreachableCount = 0;
                this.discoverCount = 0;
                finishDiscovery();
            } catch (err) {
                this.log('Error during EP10 discovery: ' + getSafeErrorMessage(err, settings));
            } finally {
                pendingCandidates.delete(candidateKey);
            }
        };

        discoveryClient.on('plug-new', handleDiscoveredPlug);
        discoveryClient.on('plug-online', handleDiscoveredPlug);
        discoveryClient.on('error', err => {
            if (!finished) {
                this.log('EP10 discovery failed: ' + getSafeErrorMessage(err, settings));
            }
        });

        this.activeDiscovery = { client: discoveryClient, finish: finishDiscovery };
        try {
            discoveryClient.startDiscovery(discoveryOptions);
            finishTimer = setTimeout(finishDiscovery, discoveryOptions.discoveryTimeout + 25);
        } catch (err) {
            this.log('Unable to start EP10 discovery: ' + getSafeErrorMessage(err, settings));
            finishDiscovery();
        }
    }

}

module.exports = TPlinkPlugDevice;
