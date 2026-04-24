'use strict';
const Homey = require('homey');
const {
    Client
} = require('tplink-smarthome-api');
const client = new Client();

// mode: enum: color, temperature
const mode = {
    color: 'color',
    temperature: 'temperature'
}

// get driver name based on dirname
function getDriverName() {
    var parts = __dirname.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1].split('.')[0];
}

var TPlinkModel = getDriverName().toUpperCase();

// Kelvin (LB/KL120:2700-6500 LB/KL130:2500-9000)
if ((TPlinkModel == "LB120") || (TPlinkModel == "KL120")) {
    var kelvinLow = 2700;
    var kelvinHigh = 6500
} else {
    var kelvinLow = 2500;
    var kelvinHigh = 9000
}

var options = {};

class TPlinkBulbDevice extends Homey.Device {

    async onInit() {


        this.log('device init');
        //        console.dir(this.getSettings()); // for debugging
        //        console.dir(this.getData()); // for debugging
        let settings = this.getSettings();
        let id = this.getData().id;
        this.log('id: ', id);
        this.log('name: ', this.getName());
        this.log('class: ', this.getClass());
        this.log('settings IP address: ', settings["settingIPAddress"])
        //this.log('settings totalOffset: ', settings["totalOffset"])
        //totalOffset = settings["totalOffset"];

        // in case the device was not paired with a version including the dynamicIp setting, set it to false
        if ((settings["dynamicIp"] != undefined) && (typeof (settings["dynamicIp"]) === 'boolean')) {
            this.log("dynamicIp is defined: " + settings["dynamicIp"])
        } else {
            this.setSettings({
                dynamicIp: false
            }).catch(this.error);
        }

        this.oldColorTemp = ""; 
        this.oldHue = ""; 
        this.oldSaturation = ""; 
        this.oldBrightness = ""; 
        this.unreachableCount = 0; 
        this.discoverCount = 0; 
        this.oldBulbState = this.getCapabilityValue('onoff') === true ? 1 : 0; 
        this.oldMode = mode[this.getCapabilityValue('light_mode')] || mode.color;

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

        // Capabilities: "measure_power", "meter_power""
        //"onoff", "dim", "light_hue", "light_saturation","light_mode","light_temperature"
        this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
        this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));
        this.registerCapabilityListener('light_hue', this.onCapabilityHue.bind(this));
        this.registerCapabilityListener('light_saturation', this.onCapabilitySaturation.bind(this));
        this.registerCapabilityListener('light_temperature', this.onCapabilityTemperature.bind(this));
        this.registerCapabilityListener('light_mode', this.onCapabilityMode.bind(this));

        // flow conditions

        // register flow card actions

        this.homey.flow.getActionCard('circadianModeOn').registerRunListener(async (args, state) => {
            return args.device.circadianModeOn(args.device.getSettings().settingIPAddress);
        });

        this.homey.flow.getActionCard('circadianModeOff').registerRunListener(async (args, state) => {
            return args.device.circadianModeOff(args.device.getSettings().settingIPAddress);
        });

        this.homey.flow.getActionCard('transitionOn').registerRunListener(async (args, state) => {
            var transition = args.transition * 1000;
            return args.device.onTransition(args.device.getSettings().settingIPAddress, transition);
        });

        this.homey.flow.getActionCard('transitionOff').registerRunListener(async (args, state) => {
            var transition = args.transition * 1000;
            return args.device.offTransition(args.device.getSettings().settingIPAddress, transition);
        });



    } // end onInit

    onAdded() {
        let id = this.getData().id;
        this.log("Device added: " + id);

        //this.pollDevice(interval);
    }

    // this method is called when the Device is deleted
    onDeleted() {
        let id = this.getData().id;
        this.log('device deleted: ', id);
        clearInterval(this.pollingInterval);
    }

    // this method is called when the Device has requested a state change (turned on or off)
    onCapabilityOnoff(value, opts, callback) {
        // ... set value to real device
        this.log("Capability called: onoff value: ", value);
        let settings = this.getSettings();
        let device = settings["settingIPAddress"];
        if (value) {
            this.powerOn(device);
        } else {
            this.powerOff(device);
        }
        // Then, emit a callback ( err, result )
        return true;
    }

    onCapabilityDim(value, opts, callback) {
        // ... set value to real device
        this.log("Capability called: dim value: ", value);
        let settings = this.getSettings();
        let device = settings["settingIPAddress"];
        // name: 'brightness', type: 'num', max: 100, min: 5, step: 1
        var dimLevel = Math.round((value * 100));
        if (dimLevel >= 100) {
            dimLevel = 100;
        }
        if (dimLevel <= 5) {
            dimLevel = 5;
        }
        this.log('Setting brightness ' + device + ' to ' + dimLevel);
        this.dim(device, dimLevel);
        this.setCapabilityValue('dim', value)
            .catch(this.error);
        // Then, emit a callback ( err, result )
        return (null, value);
    }

    onCapabilityHue(value, opts, callback) {
        // ... set value to real device
        this.log("Capability called: hue value: ", value);
        let settings = this.getSettings();
        let device = settings["settingIPAddress"];
        // name: 'hue', type: 'num', max: 360, min: 0, step: 1
        // FIXME: minimum is 3.6 instead of 0
        var hueLevel = Math.round((value) * 360);
        if (hueLevel >= 360) {
            hueLevel = 360;
        }
        if (hueLevel <= 0) {
            hueLevel = 0;
        }
        this.log('Setting hue level of ' + device + ' to ' + hueLevel);
        this.set_hue(device, hueLevel);
        this.setCapabilityValue('light_hue', value)
            .catch(this.error);
        // Then, emit a callback ( err, result )
        return (null, value);
    }

    onCapabilitySaturation(value, opts, callback) {
        // ... set value to real device
        this.log("Capability called: saturation value: ", value);
        let settings = this.getSettings();
        let device = settings["settingIPAddress"];
        // name: 'saturation', type: 'num', max: 100, min: 0, step: 1
        var saturationLevel = Math.round((value * 100));
        if (saturationLevel >= 100) {
            saturationLevel = 100;
        }
        if (saturationLevel <= 0) {
            saturationLevel = 0;
        }
        this.log('Setting light saturation of ' + device + ' to ' + saturationLevel);
        this.set_saturation(device, saturationLevel);
        this.setCapabilityValue('light_saturation', value)
            .catch(this.error);
        // Then, emit a callback ( err, result )
        return (null, value);
    }

    onCapabilityTemperature(value, opts, callback) {
        // ... set value to real device
        this.log("Capability called: light temperature value: ", value);
        let settings = this.getSettings();
        let device = settings["settingIPAddress"];
        // name: 'color_temp', type: 'num', max: kelvinHigh, min: kelvinLow, step: 1
        if (value == 0) {
            var tempLevel = value;
        } else {
            var tempLevel = Math.round(((1 - value) * (kelvinHigh - kelvinLow) + kelvinLow));
            if (tempLevel >= kelvinHigh) {
                tempLevel = kelvinHigh;
            }
            if (tempLevel <= kelvinLow) {
                tempLevel = kelvinLow;
            }
            this.log('Setting light temperature of ' + device + ' to ' + tempLevel);
            this.color_temp(device, tempLevel);
            this.setCapabilityValue('light_temperature', value)
                .catch(this.error);
            // Then, emit a callback ( err, result )
            return (null, value);
        }
    }

    onCapabilityMode(value, opts, callback) {
        // ... set value to real device
        this.log("Capability called: mode value: ", value);
        let settings = this.getSettings();
        let device = settings["settingIPAddress"];
        this.log('Setting light mode of ' + device + ' to ' + value);
        //   Someone touched one of the 'mode' icons: turn on device
        this.powerOn(device);
        this.setCapabilityValue('light_mode', value)
            .catch(this.error);
        // Then, emit a callback ( err, result )
        return (null, value);
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
            const sysInfo = await client.getSysInfo(device);
            this.bulb = client.getBulb({ host: device, sysInfo: sysInfo });
            options = { "transition_period": 300, "on_off": 1 };
            await this.bulb.lighting.setLightState(options);
        } catch (err) {
            this.log('Error in powerOn method: ', err.message);
            
        }
    }

    async powerOff(device) {
        try {
            const sysInfo = await client.getSysInfo(device);
            this.bulb = client.getBulb({ host: device, sysInfo: sysInfo });
            options = { "transition_period": 1000, "on_off": 0 };
            await this.bulb.lighting.setLightState(options);
        } catch (err) {
            this.log('Error in powerOff method: ', err.message);
        }
    }

    async dim(device, dimLevel) {
        try {
            const sysInfo = await client.getSysInfo(device);
            this.bulb = client.getBulb({ host: device, sysInfo: sysInfo });
            options = { "transition_period": 30, "brightness": dimLevel };
            await this.bulb.lighting.setLightState(options);
        } catch (err) {
            this.log('Error in dim method: ', err.message);
        }
    }

    async color_temp(device, tempLevel) {
        try {
            const sysInfo = await client.getSysInfo(device);
            this.bulb = client.getBulb({ host: device, sysInfo: sysInfo });
            options = { "transition_period": 30, "color_temp": tempLevel };
            await this.bulb.lighting.setLightState(options);
        } catch (err) {
            this.log('Error in color_temp method: ', err.message);
        }
    }


    async set_hue(device, hueLevel) {
        try {
            const sysInfo = await client.getSysInfo(device);
            this.bulb = client.getBulb({ host: device, sysInfo: sysInfo });
            options = { "transition_period": 30, "hue": hueLevel, "color_temp": 0 };
            await this.bulb.lighting.setLightState(options);
        } catch (err) {
            this.log('Error in set_hue method: ', err.message);
        }
    }


    async set_saturation(device, saturationLevel) {
        try {
            const sysInfo = await client.getSysInfo(device);
            this.bulb = client.getBulb({ host: device, sysInfo: sysInfo });
            options = { "transition_period": 30, "saturation": saturationLevel };
            await this.bulb.lighting.setLightState(options);
        } catch (err) {
            this.log('Error in set_saturation method: ', err.message);
        }
    }


    getPower(device) {
        this.bulb = client.getBulb({
            host: device
        });
        this.bulb.getSysInfo().then((sysInfo) => {
            if (sysInfo.relay_state === 1) {
                Homey.log('TP Link smartbulb app - light is on ');
                return true;
            } else {
                Homey.log('TP Link smartbulb app - light is off ');
                return false;
            }
        });
    }

    // mode 'normal', 'circadian'
    async circadianModeOn(device) {
        try {
            const sysInfo = await client.getSysInfo(device);
            this.bulb = client.getBulb({ host: device, sysInfo: sysInfo });
            options = { "transition_period": 100, "mode": "circadian" };
            await this.bulb.lighting.setLightState(options);
        } catch (err) {
            this.log('Error in circadianModeOn method: ', err.message);
        }
    }


    async circadianModeOff(device) {
        try {
            const sysInfo = await client.getSysInfo(device);
            this.bulb = client.getBulb({ host: device, sysInfo: sysInfo });
            options = { "transition_period": 100, "mode": "normal", "brightness": 100 };
            await this.bulb.lighting.setLightState(options);
        } catch (err) {
            this.log('Error in circadianModeOff method: ', err.message);
        }
    }


    async onTransition(device, transition) {
        try {
            const sysInfo = await client.getSysInfo(device);
            this.bulb = client.getBulb({ host: device, sysInfo: sysInfo });
            options = { "transition_period": transition, "on_off": 1, "brightness": 100 };
            await this.bulb.lighting.setLightState(options);
        } catch (err) {
            this.log('Error in onTransition method: ', err.message);
        }
    }


    async offTransition(device, transition) {
        try {
            const sysInfo = await client.getSysInfo(device);
            this.bulb = client.getBulb({ host: device, sysInfo: sysInfo });
            options = { "transition_period": transition, "on_off": 0 };
            await this.bulb.lighting.setLightState(options);
        } catch (err) {
            this.log('Error in offTransition method: ', err.message);
        }
    }




    async getStatus() {
        let settings = this.getSettings();
        let device = settings.settingIPAddress;
        let deviceId = settings.deviceId;
        this.log("getStatus device: " + device + ", name: " + this.getName());
        //this.log("DeviceId device: " + deviceId);

        try {
            const sysInfo = await client.getSysInfo(device);
            this.bulb = client.getBulb({
                host: device, sysInfo: sysInfo
            });

            if (settings["deviceId"] === undefined) {
                try {
                    this.bulb.getSysInfo().then((info) => {
                        this.log("Fetched bulb deviceId: " + info.deviceId);
                        this.setSettings({
                            deviceId: info.deviceId
                        }).catch(this.error);
                    }).catch(this.error)
                } catch (err) {
                    this.log("Caught error in setting deviceId: " + err.message);
                }
            } else {
                //this.log("DeviceId: " + settings["deviceId"])
            }

            this.oldColorTemp = this.getCapabilityValue('light_temperature');
            this.oldHue = this.getCapabilityValue('light_hue');
            this.oldSaturation = this.getCapabilityValue('light_saturation');
            this.oldBrightness = this.getCapabilityValue('dim');
            this.oldMode = mode[this.getCapabilityValue('light_mode')];
            this.oldBulbState = this.getCapabilityValue('onoff') === true ? 1 : 0;

            await this.bulb.lighting.getLightState().then((bulbState) => {

                    if (this.oldBulbState !== bulbState.on_off) {
                         this.log('getLightState after change: ' + JSON.stringify(bulbState));
                        if (bulbState.on_off === 1) {
                            this.log('Bulb poll state - on');
                            this.setCapabilityValue('onoff', true)
                                .catch(this.error);
                        } else if (bulbState.on_off === 0) {
                            this.log('Bulb poll state - off ');
                            this.setCapabilityValue('onoff', false)
                                .catch(this.error);
                        } else {
                        //    this.log("BulbState.on_off undefined");
                        }
                        this.oldBulbState = bulbState.on_off; 
                    } else {
                        //    this.log("Bulb state unchanged.");
                    }

               if (bulbState.on_off === 1) {
                    //this.log('Bulb poll state - on');
                    this.setCapabilityValue('onoff', true)
                        .catch(this.error);

                    // bulbState mode: circadian or normal. Only for LB130/120 and KL130/120
                    if ((TPlinkModel == "LB130") || (TPlinkModel == "LB120") || (TPlinkModel == "KL130") || (TPlinkModel == "KL120")) {
                        if (bulbState.mode == "normal") {
                            this.log('Bulb state: normal');
                        } else
                            if (bulbState.mode == "circadian") {
                                this.log('Bulb state: circadian');
                            }

                        if (bulbState.color_temp == 0) {
                            var new_light_temperature = 0
                        } else {
                            var new_light_temperature = this.round(1 - ((bulbState.color_temp - kelvinLow) / (kelvinHigh - kelvinLow)), 2);
                        }

                        if (this.oldColorTemp != new_light_temperature) {
                            this.log('ColorTemp changed: ' + new_light_temperature);
                            this.setCapabilityValue('light_temperature', new_light_temperature)
                                .catch(this.error);
                        }
                        if (this.oldSaturation != bulbState.saturation / 100) {
                            this.log('Saturation changed: ' + bulbState.saturation);
                            this.setCapabilityValue('light_saturation', bulbState.saturation / 100)
                                .catch(this.error);
                        }
                    }

                    if ((TPlinkModel == "LB130") || (TPlinkModel == "KL130")) {
                        if (this.oldHue != this.round((bulbState.hue / 360), 2)) {
                            this.log('Hue changed: ' + this.round((bulbState.hue / 360), 2));
                            this.setCapabilityValue('light_hue', this.round((bulbState.hue / 360), 2))
                                .catch(this.error);
                        }
                    }

                    if (typeof bulbState.brightness === 'number') {
                        let newBrightness = bulbState.brightness / 100;
                        if (this.oldBrightness !== newBrightness) {
                            this.log('Brightness changed: ' + newBrightness);
                            this.setCapabilityValue('dim', newBrightness)
                                .catch(this.error);
                        }
                    } else {
                        this.log('Brightness data not available or not changed.');
                    }

                    if (this.oldMode != this.getCapabilityValue('light_mode')) {
                        this.log('Light_mode changed: ' + this.getCapabilityValue('light_mode'));
                    }

                } else {
                    //    this.log("BulbState.on_off undefined or not changed")
                }
            })
                .catch((err) => {
                    var errRegEx = new RegExp("EHOSTUNREACH", 'g')
                    if (err.message.match(errRegEx)) {
                        this.unreachableCount += 1;
                        this.log("Device unreachable. Unreachable count: " + this.unreachableCount + " Discover count: " + this.discoverCount + " DynamicIP option: " + settings["dynamicIp"]);

                        // attempt autodiscovery once every hour
                        if ((this.unreachableCount % 360 == 3) && settings["dynamicIp"]) {
                            this.setUnavailable("Device offline");
                            this.discoverCount += 1;
                            this.log("Unreachable, starting autodiscovery");
                            this.discover();
                        }
                    }
                    this.log("Caught error in getStatus / getSysInfo function: " + err.message);
                });
        } catch (err) {
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


    round(value, decimals) {
        return Number(Math.round(value + 'e' + decimals) + 'e-' + decimals);
    }

    discover() {
        // TODO: rewrite with API's discovery options (timeout, excluded MAC addresses, interval)
        let settings = this.getSettings();
        var discoveryOptions = {
            deviceTypes: 'bulb',
            discoveryInterval: 10000,
            discoveryTimeout: 5000,
            offlineTolerance: 3
        }
        // discover new bulbs
        client.startDiscovery(discoveryOptions);
        client.on('bulb-new', (bulb) => {
            if (bulb.deviceId == settings["deviceId"]) {
                this.setSettings({
                    settingIPAddress: bulb.host
                }).catch(this.error);
                setTimeout(function () {
                    client.stopDiscovery()
                }, 1000);
                this.log("Discovered online bulb: " + bulb.deviceId);
                this.log("Resetting unreachable count to 0");
                this.unreachableCount = 0;
                this.discoverCount = 0;
                this.setAvailable();
            }
        })
        client.on('bulb-online', (bulb) => {
            if (bulb.deviceId == settings["deviceId"]) {
                this.setSettings({
                    settingIPAddress: bulb.host
                }).catch(this.error);
                setTimeout(function () {
                    client.stopDiscovery()
                }, 1000);
                this.log("Discovered online bulb: " + bulb.deviceId);
                this.log("Resetting unreachable count to 0");
                this.unreachableCount = 0;
                this.discoverCount = 0;
                this.setAvailable();
            }
        })
    }

}

module.exports = TPlinkBulbDevice;