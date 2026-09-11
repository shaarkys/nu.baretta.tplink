'use strict';
//debug for API
// process.env.DEBUG = 'tplink-smarthome-api*';

const Homey = require('homey');
const { getRecovery } = require('../../lib/tplink-recovery');
const {
    Client
} = require('tplink-smarthome-api');

const client = new Client({
    //debug for API
    //    logLevel: 'debug' // Set the log level to 'debug' for detailed logs
});

// get driver name based on dirname
function getDriverName() {
    var parts = __dirname.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1].split('.')[0];
};

var TPlinkModel = getDriverName().toUpperCase();


class TPlinkPlugDevice extends Homey.Device {

    generateRandomInterval() {
        let interval;
        do {
            interval = 5 + Math.random() * 10; // Random interval
        } while (this.isIntervalTooClose(interval, this.lastInterval));
        this.lastInterval = interval; // Update the last interval
        return interval;
    }

    isIntervalTooClose(newInterval, lastInterval) {
        if (lastInterval === null) return false; // No last interval to compare
        const diff = Math.abs(newInterval - lastInterval);
        return diff < 2; // Define a threshold for 'too close', e.g., less than 2 seconds difference
    }

    async onInit() {
        getRecovery(this).initialize();
        this.log('Device initialization');
        //DEBUG - chrome://inspect
        //require('inspector').open(9229, '0.0.0.0');
        // Generate a random interval and assign it to 'interval'
        let interval = this.generateRandomInterval();
        let device = this;
        let settings = this.getSettings();
        let id = this.getData().id;
        let childId = this.getData().childId; // Retrieve the childId

        this.log('Device ID: ', id);
        this.log('Child ID: ', childId); // Log the childId for debugging
        this.log('name: ', this.getName());
        this.log('class: ', this.getClass());
        this.log('settings IP address: ', settings["settingIPAddress"])
        this.log('Driver ID: ', TPlinkModel);
        
        // In case the device was not paired with a version including the dynamicIp setting, set it to false
        if (settings["dynamicIp"] === undefined || typeof settings["dynamicIp"] !== 'boolean') {
            this.setSettings({
                dynamicIp: false
            }).catch(this.error);
        }
        this.log("dynamicIp is: " + settings["dynamicIp"]);

        this.log('settings totalOffset: ', settings["totalOffset"])

        this.totalOffset = settings["totalOffset"] || 0; 
        this.unreachableCount = 0; 
        this.discoverCount = 0;

        this.log('Initializing socket with Child ID: ', childId);
        // Initialize specific socket based on childId
        // Adjust settings, capabilities, and any other specifics for the socket

        this.registerCapabilityListener('onoff', value => this.onCapabilityOnoff(value, childId));
        this.registerCapabilityListener('ledonoff', value => this.onCapabilityLedOnoff(value, childId));

        // Register flow card action listeners
        this.homey.flow.getActionCard('ledOn').registerRunListener(async (args, state) => {
            let childId = args.device.getData().childId; // Retrieve the childId
            return args.device.ledOn(args.device.getSettings().settingIPAddress, childId);
        });

        this.homey.flow.getActionCard('ledOff').registerRunListener(async (args, state) => {
            let childId = args.device.getData().childId; // Retrieve the childId
            return args.device.ledOff(args.device.getSettings().settingIPAddress, childId);
        });

        this.homey.flow.getActionCard('meter_reset').registerRunListener(async (args, state) => {
            let childId = args.device.getData().childId; // Retrieve the childId
            return args.device.meter_reset(args.device.getSettings().settingIPAddress, childId);
        });

        this.homey.flow.getActionCard('undo_meter_reset').registerRunListener(async (args, state) => {
            let childId = args.device.getData().childId; // Retrieve the childId
            return args.device.undo_meter_reset(args.device.getSettings().settingIPAddress, childId);
        });

        // Call pollDevice with childId to start polling this specific socket
        this.pollDevice(interval, childId);
    } // end onInit

    onAdded() {

        let id = this.getData().id;
        let childId = this.getData().childId; // Retrieve the childId for the socket
        this.log("Device added: " + id + ", Child ID: " + childId);

        let settings = this.getSettings();

    }

    // This method is called when the Device is deleted
    onDeleted() {
        getRecovery(this).destroy();
        let id = this.getData().id;
        let childId = this.getData().childId; // Retrieve the childId for the socket

        this.log("Device deleted: " + id + ", Child ID: " + childId);

        clearInterval(this.pollingInterval);
    }


    async onCapabilityOnoff(value, opts) {
        let settings = this.getSettings();
        let device = settings["settingIPAddress"];
        let childId = this.getData().childId; // Retrieve the childId for the socket
        this.log("Capability called: onoff value: ", value, "for ChildID ", childId);

        try {
            if (value) {
                await this.powerOn(device, childId);
            } else {
                await this.powerOff(device, childId);
            }
        } catch (err) {
            this.log("Error in onCapabilityOnoff:", err.message);
            throw err; // Rethrow the error to ensure Homey knows the action failed
        }
    }


    async onCapabilityLedOnoff(value, opts) {
        let childId = this.getData().childId; // Get the childId
        let device = this.getSettings().settingIPAddress;
        this.log("Capability called: LED onoff value: ", value, "for ChildID ", childId);

        if (childId) {
            // If childId is present, control the LED of the specific socket on the HS300
            await this.ledOnOffSocket(device, childId, value);
        }
    }

    // rework needed !!!
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

    async powerOn(device, childId) {
        try {
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            this.log('Turning on device: ' + device + ', Child ID: ' + childId);
            // await this.plug.setPowerState(true, { childId: childId });
            // Send command directly with childId context
            await this.plug.sendCommand(
                `{"system":{"set_relay_state":{"state":1}}}`, // Command to turn on the device
                childId // Context with childId
            );
        } catch (err) {
            this.log('Error turning device on: ', err.message);
            throw err;
        }
    }

    async powerOff(device, childId) {
        try {
            this.log('Turning on device: ' + device + ', Child ID: ' + childId);
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            //await this.plug.setPowerState(false, { childId: childId });
            // Send command directly with childId context
            await this.plug.sendCommand(
                `{"system":{"set_relay_state":{"state":0}}}`, // Command to turn on the device
                childId // Context with childId
            );
        } catch (err) {
            this.log('Error turning device off: ', err.message);
            throw err;
        }
    }


    async getPower(device) {
        try {
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo, childId: childId });

            let childId = this.getData().childId; // Get the childId for the socket
            if (childId && sysInfo.children) {
                // If childId is present and the device has multiple sockets
                const childSocket = sysInfo.children.find(child => child.id === childId);
                if (childSocket) {
                    this.log('Relay state for socket ' + childId + ' is ' + (childSocket.state ? 'on' : 'off'));
                    return childSocket.state ? "true" : "false";
                } else {
                    this.log('Child socket not found for childId: ', childId);
                    return false;
                }
            }
        } catch (err) {
            this.log("Caught error in getPower function: " + err.message);
            return "error";
        }
    }
    
    async getLed(device) {
        try {
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });

            const updatedSysInfo = await this.plug.getSysInfo();
            if (updatedSysInfo.led_off === 0) {
                this.log('LED on ');
                return true;
            } else {
                this.log('LED off ');
                return false;
            }
        } catch (err) {
            this.log("Caught error in getLed function: " + err.message);
            return "error";
        }
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
        try {
            this.log('Reset meter');
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo, childId: childId });
            // reset meter for counters in Kasa app. Does not actually clear the total counter though...
            // this.plug.emeter.eraseStats(null);
                        this.log('Setting totalOffset to oldtotalState: ' + this.getCapabilityValue('meter_power'));
            this.totalOffset = this.getCapabilityValue('meter_power') || 0;
            await this.setSettings({
                totalOffset: this.totalOffset
            });
        } catch (err) {
            this.log("Caught error in meter_reset: " + err.message);
            // Handle the error accordingly
        }
    }

    async undo_meter_reset(device) {
        try {
            this.log('Undo reset meter, setting totalOffset to 0');
            // reset meter for counters in Kasa app. Does not actually clear the total counter though...
            this.totalOffset = 0;
            await this.setSettings({
                totalOffset: this.totalOffset
            });
        } catch (err) {
            this.log("Caught error in undo_meter_reset: " + err.message);
            // Handle the error accordingly
        }
    }

    async getStatus() {
        const recovery = getRecovery(this);
        const poll = recovery.beginPoll();
        if (!poll) return;

        let settings = this.getSettings();
        let device = settings.settingIPAddress;
        let childId = this.getData().childId; // Retrieve the childId
        //const sysInfo = client.getSysInfo(device);
        this.log("getStatus for device: " + device + ", Child ID: " + childId);

        try {
            const sysInfo = await client.getSysInfo(device);
            if (!recovery.isCurrent(poll)) return;
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo, childId: childId });

            // Check the relay state of the specific socket
            const childSocket = sysInfo.children.find(child => child.id === childId);
            const relayState = childSocket ? childSocket.state === 1 : false;

            this.setCapabilityValue('onoff', relayState).catch(this.error);
            this.log('Relay state for child socket ' + childId + ' is ' + (relayState ? 'on' : 'off'));

            // Get real-time electricity metrics
            const realtimeStats = await this.plug.emeter.getRealtime(this.plug, childId);
            if (!recovery.responded(poll)) return;

            if (realtimeStats) {
                const power = realtimeStats.power || 0;
                const voltage = realtimeStats.voltage || 0;
                const current = realtimeStats.current || 0;
                const total = realtimeStats.total || 0;

                this.setCapabilityValue('measure_power', power).catch(this.error);
                this.setCapabilityValue('measure_voltage', voltage).catch(this.error);
                this.setCapabilityValue('measure_current', current).catch(this.error);
                this.setCapabilityValue('meter_power', total).catch(this.error);

                this.log(`Updated stats for child socket ${childId}: Power - ${power}W, Voltage - ${voltage}V, Current - ${current}A, Total - ${total}kWh`);
            }

            await recovery.succeeded(poll);
        } catch (error) {
            await recovery.failed(poll, error);
        } finally {
            recovery.endPoll(poll);
        }
    }


    handleErrors(err, settings) {
        return getRecovery(this).failed(null, err);
    }


    pollDevice(randomInterval, childIds) {
        clearInterval(this.pollingInterval); // Clear any existing interval

        this.log("Starting polling with interval : ", randomInterval.toFixed(0), " with childIds:", childIds);

        this.pollingInterval = this.homey.setInterval(async () => {
            this.log("Polling for childId:", childIds);
            try {
                await this.getStatus(childIds);
            } catch (err) {
                this.log("Error in polling for childId", childIds, ":", err.message);
            }
        }, randomInterval * 1000); // Multiply by 1000 to convert to milliseconds
    }


    async discover() {
        return getRecovery(this).discover({
            createClient: () => new Client(),
            type: 'plug',
        });
    }


}

module.exports = TPlinkPlugDevice;