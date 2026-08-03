'use strict';
const Homey = require('homey');
const {
    Client
} = require('tplink-smarthome-api');
const { getTpLinkClientOptions } = require('../../lib/tplink-auth');

function createClientFromSettings(settings) {
    return new Client(getTpLinkClientOptions('KS225', settings));
}

// get driver name based on dirname
function getDriverName() {
    var parts = __dirname.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1].split('.')[0];
};

var TPlinkModel = getDriverName().toUpperCase();


class TPlinkPlugDevice extends Homey.Device {

    async onInit() {
        this.log('device init');
        let device = this;

        // console.dir(this.getSettings()); // for debugging
        // console.dir(this.getData()); // for debugging
        let settings = this.getSettings();
        const settingsDefaults = {};
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
            settingsDefaults.dynamicIp = false;
        }

        if (typeof settings["deviceUsername"] !== 'string') {
            settingsDefaults.deviceUsername = '';
        }

        if (typeof settings["devicePassword"] !== 'string') {
            settingsDefaults.devicePassword = '';
        }

        if (Object.keys(settingsDefaults).length > 0) {
            await this.setSettings(settingsDefaults).catch(this.error);
            settings = {
                ...settings,
                ...settingsDefaults
            };
        }

        this.client = createClientFromSettings(settings);
        this.log(
            'TP-Link account credentials configured: ' +
            (settings["deviceUsername"] ? 'yes' : 'no')
        );

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
                this.error('Failed to set default polling interval:', error);
                interval = 10; // Optionally set a default even in case of error to ensure continuity
            }
        }

        this.pollDevice(interval);

        if (!this.hasCapability('dim')) {
            try {
                await this.addCapability('dim');
                this.log('Added missing dim capability to existing device');
            } catch (error) {
                this.error('Failed to add dim capability:', error);
            }
        }

        this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
        // actually quite useless to have the 'ledonoff' function in the mobile interface...
        this.registerCapabilityListener('ledonoff', this.onCapabilityLedOnoff.bind(this));
        this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));

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

        this.homey.flow.getActionCard('set_brightness').registerRunListener(async (args, state) => {
            return args.device.setBrightness(args.device.getSettings().settingIPAddress, args.brightness);
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
            this.error('Error in onCapabilityOnoff:', err);
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
            this.error('Error in onCapabilityLedOnoff:', err);
            throw err;
        }
    }

    async onSettings({ oldSettings, newSettings, changedKeys }) {
        try {
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
                        this.client = createClientFromSettings(newSettings);
                        this.log('TP-Link account credentials updated');
                        await this.reinitializeConnection(newSettings.settingIPAddress);
                        break;
                    default:
                        this.log('Unhandled setting change detected for key:', key);
                        break;
                }
            }
        } catch (error) {
            this.error('Failed to handle settings change:', error);
            throw new Error('Failed to update settings: ' + error.message);
        }
    }

    async reinitializeConnection(ipAddress) {
        // Implement the logic to reinitialize the connection
        // For example, update the plug instance
        try {
            const sysInfo = await this.client.getSysInfo(ipAddress);
            this.plug = this.client.getPlug({ host: ipAddress, sysInfo });
            this.log('Reinitialized connection to', ipAddress);
        } catch (err) {
            this.error('Error reinitializing connection:', err);
        }
    }

    async powerOn(device) {
        try {
            this.log('Turning device on ' + device);
            const sysInfo = await this.client.getSysInfo(device);
            this.plug = this.client.getPlug({ host: device, sysInfo });
            await this.plug.setPowerState(true);
        } catch (err) {
            this.error('Error turning device on:', err);
            throw err;
        }
    }


    async powerOff(device) {
        try {
            this.log('Turning device off ' + device);
            const sysInfo = await this.client.getSysInfo(device);
            this.plug = this.client.getPlug({ host: device, sysInfo });
            await this.plug.setPowerState(false);
        } catch (err) {
            this.error('Error turning device off:', err);
            throw err;
        }
    }

    async setBrightness(device, brightness) {
        try {
            const brightnessValue = Math.max(0, Math.min(100, Math.round(brightness)));
            this.log('Setting brightness for device ' + device + ' to ' + brightnessValue);
            const sysInfo = await this.client.getSysInfo(device);
            this.plug = this.client.getPlug({ host: device, sysInfo });

            if (!this.plug.dimmer) {
                this.log('Device does not expose dimmer controls');
                return false;
            }

            if (brightnessValue === 0) {
                await this.plug.setPowerState(false);
                await this.setCapabilityValue('dim', 0);
                if (this.getCapabilityValue('onoff') !== false) {
                    await this.setCapabilityValue('onoff', false);
                }
                return true;
            }

            await this.plug.dimmer.setBrightness(brightnessValue);
            await this.setCapabilityValue('dim', brightnessValue / 100);

            if (brightnessValue > 0 && this.getCapabilityValue('onoff') !== true) {
                await this.setCapabilityValue('onoff', true);
            }

            return true;
        } catch (err) {
            this.error('Error setting brightness:', err);
            throw err;
        }
    }

    async getPower(device) {
        try {
            const sysInfo = await this.client.getSysInfo(device);
            this.plug = this.client.getPlug({ host: device, sysInfo });
            const plugInfo = await this.plug.getSysInfo();
            const isOn = plugInfo.relay_state === 1;
            this.log(`State - relay state is ${isOn ? 'on' : 'off'}`);
            return isOn;
        } catch (err) {
            this.log("Caught error in getPower function: " + err.message);
            return false; // or throw err;
        }
    }

    async getLed(device) {
        try {
            const sysInfo = await this.client.getSysInfo(device);
            this.plug = this.client.getPlug({ host: device, sysInfo });
            const plugInfo = await this.plug.getSysInfo();
            const isLedOn = plugInfo.led_off === 0;
            this.log(`LED is ${isLedOn ? 'on' : 'off'}`);
            return isLedOn;
        } catch (err) {
            this.error('Caught error in getLed function:', err);
            return false;
        }
    }

    async ledOn(device) {
        try {
            this.log('Turning LED on for device ' + device);
            const sysInfo = await this.client.getSysInfo(device);
            this.plug = this.client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.setLedState(true);
            await this.setCapabilityValue('ledonoff', true);
        } catch (err) {
            this.log('Error turning LED on: ', err.message);

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
            this.log('Error turning LED off: ', err.message);

        }
    }

    async onCapabilityDim(value, opts) {
        try {
            this.log("Capability called: dim value:", value);
            let settings = this.getSettings();
            let device = settings["settingIPAddress"];
            await this.setBrightness(device, value * 100);
            return null;
        } catch (err) {
            this.error('Error in onCapabilityDim:', err);
            throw err;
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
            this.log('Error resetting meter: ', err.message);
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
                    const deviceId = data.sysInfo.deviceId || data.sysInfo.device_id;
                    if (deviceId) {
                        await this.setSettings({ deviceId: deviceId });
                        this.log("DeviceId added: " + deviceId);
                    }
                } catch (error) {
                    this.log("Error setting deviceId: " + error.message);
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
                    this.log("Error setting capability value: " + error.message);
                }
            }

            if (this.hasCapability('dim') && typeof data.sysInfo.brightness === 'number') {
                const dimValue = Math.max(0, Math.min(1, data.sysInfo.brightness / 100));
                if (this.getCapabilityValue('dim') !== dimValue) {
                    try {
                        await this.setCapabilityValue('dim', dimValue);
                    } catch (error) {
                        this.log("Error setting dim capability value: " + error.message);
                    }
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
                    this.log("Error updating capability values: " + error.message);
                }
            }

        } catch (err) {
            var errRegEx = new RegExp("EHOSTUNREACH", 'g');
            if (err.message.match(errRegEx)) {
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
            this.log("Caught error in getStatus function: " + err.message);
        }
    }

    pollDevice(interval) {
        clearInterval(this.pollingInterval);
        this.pollingInterval = setInterval(async () => {
            try {
                await this.getStatus();
            } catch (err) {
                this.log("Error during polling: " + err.message);
                // Optionally, handle reconnection or retry logic here
            }
        }, 1000 * interval);
    }


    async discover() {
        let settings = this.getSettings();
        var discoveryOptions = {
            deviceTypes: 'plug',
            discoveryInterval: 10000,
            discoveryTimeout: 5000,
            offlineTolerance: 3
        };

        try {
            // As startDiscovery does not return a promise, it does not need await but errors should be handled appropriately
            const discovery = this.client.startDiscovery(discoveryOptions);

            // Handle new plug event
            discovery.on('plug-new', async (plug) => {
                try {
                    if (plug.deviceId === settings["deviceId"]) {
                        await this.setSettings({ settingIPAddress: plug.host });
                        // Stopping discovery after finding the device, assuming one device setup per call
                        this.client.stopDiscovery();
                        this.log("Discovered online plug: " + plug.deviceId);
                        this.setAvailable();
                        this.log("Resetting unreachable count to 0");
                        this.unreachableCount = 0;
                        this.discoverCount = 0;
                    }
                } catch (err) {
                    this.log('Error updating settings during discovery: ' + err.message);
                }
            });

            // Optionally handle plug-online event if needed
            discovery.on('plug-online', async (plug) => {
                try {
                    if (plug.deviceId === settings["deviceId"]) {
                        await this.setSettings({ settingIPAddress: plug.host });
                        // Similar to plug-new, stop discovery once the intended device is online
                        this.client.stopDiscovery();
                        this.log("Discovered online plug: " + plug.deviceId + " is back online");
                        this.setAvailable();
                    }
                } catch (err) {
                    this.log('Error handling online plug during discovery: ' + err.message);
                }
            });
        } catch (err) {
            this.log('Discovery failed: ' + err.message);
            // Implement retry logic or further error handling as needed
        }
    }

}

module.exports = TPlinkPlugDevice;
