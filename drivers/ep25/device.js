'use strict';
const Homey = require('homey');
const { getRecovery } = require('../../lib/tplink-recovery');
const {
    Client
} = require('tplink-smarthome-api');

const client = new Client();

// get driver name based on dirname
function getDriverName() {
    var parts = __dirname.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1].split('.')[0];
};

var util = require('util');
var TPlinkModel = getDriverName().toUpperCase();


class TPlinkPlugDevice extends Homey.Device {

    async onInit() {
        getRecovery(this).initialize();
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

        this.pollDevice(interval); // Start polling with the defined interval

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
        getRecovery(this).destroy();
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
        await getRecovery(this).settingsChanged(changedKeys);
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
            const sysInfo = await client.getSysInfo(ipAddress);
            this.plug = client.getPlug({ host: ipAddress, sysInfo });
            this.log('Reinitialized connection to', ipAddress);
        } catch (err) {
            this.error('Error reinitializing connection:', err);
        }
    }

    async powerOn(device) {
        try {
            this.log('Turning device on ' + device);
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.setPowerState(true);
        } catch (err) {
            this.log('Error turning device on: ', err.message);

        }
    }


    async powerOff(device) {
        try {
            this.log('Turning device off ' + device);
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.setPowerState(false);
        } catch (err) {
            this.log('Error turning device off: ', err.message);

        }
    }

    getPower(device) {
        return client.getSysInfo(device)  // Ensure this function returns a promise
            .then(sysInfo => {
                this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
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
                this.log("Caught error in getPower function: " + err.message);

            });
    }

    getLed(device) {
        return client.getSysInfo(device)  // Ensure this function returns a promise
            .then(sysInfo => {
                this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
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
                this.log("Caught error in getLed function: " + err.message);

            });
    }

    async ledOn(device) {
        try {
            this.log('Turning LED on for device ' + device);
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.setLedState(true);
            await this.setCapabilityValue('ledonoff', true);
        } catch (err) {
            this.log('Error turning LED on: ', err.message);

        }
    }


    async ledOff(device) {
        try {
            this.log('Turning LED off for device ' + device);
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.setLedState(false);
            await this.setCapabilityValue('ledonoff', false);
        } catch (err) {
            this.log('Error turning LED off: ', err.message);

        }
    }


    async meter_reset(device) {
        this.log('Reset meter ');
        try {
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
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
        const recovery = getRecovery(this);
        const poll = recovery.beginPoll();
        if (!poll) return;

        let settings = this.getSettings();
        let device = settings.settingIPAddress;
        let TPlinkModel = getDriverName().toUpperCase();
        this.log("getStatus device: " + device + ", name: " + this.getName());

        try {
            const sysInfo = await client.getSysInfo(device);
            if (!recovery.isCurrent(poll)) return;
            this.plug = client.getPlug({ host: device, sysInfo });

            const data = await this.plug.getInfo();
            if (!recovery.responded(poll)) return;

            // **Processing data starts here**

            if (settings["deviceId"] === undefined) {
                try {
                    await this.setSettings({ deviceId: data.sysInfo.deviceId });
                    this.log("DeviceId added: " + settings["deviceId"]);
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


            await recovery.succeeded(poll);
        } catch (error) {
            await recovery.failed(poll, error);
        } finally {
            recovery.endPoll(poll);
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
        return getRecovery(this).discover({
            createClient: () => new Client(),
            type: 'plug',
        });
    }

}

module.exports = TPlinkPlugDevice;