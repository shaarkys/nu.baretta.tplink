'use strict';
const Homey = require('homey');
const { isIP } = require('node:net');
const { getRecovery } = require('../../lib/tplink-recovery');
const { Client } = require('tplink-smarthome-api');

const {
    getEp10ClientOptions,
    getDeviceConnectionData,
    getEp10Transport,
    getTpLinkDiscoveryClientOptions,
    isValidTpLinkTransport
} = require('../../lib/tplink-auth');
const {
    CREDENTIAL_SOURCES,
    resolveDeviceCredentials,
    getManualCredentialTransition,
    getSafeErrorMessage: redactErrorMessage
} = require('../../lib/tplink-credentials');

const CREDENTIAL_VALIDATION_TIMEOUT = 4000;

// get driver name based on dirname
function getDriverName() {
    var parts = __dirname.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1].split('.')[0];
}

var util = require('util')

const TPlinkModel = 'HS200';

function getGlobalCredentials(device) {
    const app = device && device.homey && device.homey.app;
    return app && typeof app.getGlobalCredentials === 'function'
        ? app.getGlobalCredentials()
        : null;
}

function createClientFromSettings(device, data, settings, activeTransport, { timeout } = {}) {
    const connectionData = { ...data, transport: isValidTpLinkTransport(data.transport) ? data.transport : activeTransport };
    const options = getEp10ClientOptions(connectionData, settings, getGlobalCredentials(device));

    if (timeout) options.defaultSendOptions.timeout = timeout;

    return new Client({ ...options, logLevel: 'silent' });
}

function getSafeErrorMessage(error, settings = {}, globalCredentials = null) {
    return redactErrorMessage(error, settings, globalCredentials);
}

function getDiscoveredTransport(plug) {
    const transport = plug && plug.defaultSendOptions ? plug.defaultSendOptions.transport : undefined;
    return isValidTpLinkTransport(transport) ? transport : undefined;
}


class TPlinkPlugDevice extends Homey.Device {

    async onInit() {
        getRecovery(this).initialize();
        this.activeTransport = getEp10Transport(getDeviceConnectionData(this), this.getSettings(), getGlobalCredentials(this));
        this.client = createClientFromSettings(this, getDeviceConnectionData(this), this.getSettings(), this.activeTransport);
        this.log('HS200 transport configured: ' + this.activeTransport);
        this.log('device init');
        let device = this;

        // console.dir(this.getSettings()); // for debugging
        // console.dir(getDeviceConnectionData(this)); // for debugging
        let settings = this.getSettings();
        let id = getDeviceConnectionData(this).id;
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

        this.pollDevice(interval);

        this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
        // actually quite useless to have the 'ledonoff' function in the mobile interface...
        this.registerCapabilityListener('ledonoff', this.onCapabilityLedOnoff.bind(this));



        this.homey.flow.getActionCard('meter_reset').registerRunListener(async (args, state) => {
            return args.device.meter_reset(args.device.getSettings().settingIPAddress);
        });

        this.homey.flow.getActionCard('undo_meter_reset').registerRunListener(async (args, state) => {
            return args.device.undo_meter_reset(args.device.getSettings().settingIPAddress);
        });

    } // end onInit

    onAdded() {
        let id = getDeviceConnectionData(this).id;
        this.log("Device added: " + id);
        let settings = this.getSettings();
    }

    // this method is called when the Device is deleted
    onDeleted() {
        getRecovery(this).destroy();
        let id = getDeviceConnectionData(this).id;
        this.log("Device deleted: " + id);
        clearInterval(this.pollingInterval);
        clearTimeout(this.pollStartTimer);
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
            this.error('Error in onCapabilityOnoff:', getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
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
            this.error('Error in onCapabilityLedOnoff:', getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
            throw err;
        }
    }

    async onSettings({ oldSettings = {}, newSettings = {}, changedKeys = [] }) {
        await getRecovery(this).settingsChanged(changedKeys);
        let candidateSettings = {};
        try {
            const currentSettings = this.getSettings() || {};
            candidateSettings = { ...currentSettings, ...oldSettings, ...newSettings };
            const changed = Array.isArray(changedKeys) ? changedKeys : [];
            const credentialsChanged = changed.includes('deviceUsername') || changed.includes('devicePassword');
            let credentialConnectionUpdated = false;

            if (credentialsChanged) {
                const transition = this.getManualCredentialTransition(candidateSettings);
                const data = getDeviceConnectionData(this);
                if (!transition.credentials && data.transport !== 'tcp') {
                    throw new Error(
                        'Complete global TP-Link account credentials are required before clearing credentials for authenticated HS200 firmware.'
                    );
                }

                const effectiveSettings = { ...candidateSettings, ...transition.settings };
                const transport = getEp10Transport(data, effectiveSettings, getGlobalCredentials(this));
                const validated = await this.validateCredentialTransition(
                    effectiveSettings,
                    transport
                );
                await this.setSettings(transition.settings);
                this.activeTransport = transport;
                this.client = validated.client;
                this.plug = validated.plug;
                credentialConnectionUpdated = true;
                candidateSettings = effectiveSettings;
                this.log('TP-Link account credential source updated: ' + transition.source);
            }

            for (const key of changed) {
                switch (key) {
                    case 'settingIPAddress':
                        this.log('IP address changed to ' + candidateSettings.settingIPAddress);
                        // Re-initialize connection if IP address changes
                        if (!candidateSettings.dynamicIp && !credentialConnectionUpdated) { // Only reconnect if dynamic IP is not used
                            await this.reinitializeConnection(candidateSettings.settingIPAddress, {
                                settings: candidateSettings
                            });
                        }
                        break;
                    case 'pollingInterval':
                        const interval = parseInt(candidateSettings.pollingInterval, 10) || 10; // Ensure there's a fallback interval
                        this.log('Polling interval changed to ' + interval + ' seconds');
                        clearInterval(this.pollingInterval);
                        clearTimeout(this.pollStartTimer);
                        this.pollDevice(interval); // Start polling with the defined interval
                        break;
                    case 'dynamicIp':
                        this.log('Dynamic IP setting changed to ' + candidateSettings.dynamicIp);
                        break;
                    case 'deviceUsername':
                    case 'devicePassword':
                        break;
                    default:
                        this.log('Unhandled setting change detected for key:', key);
                        break;
                }
            }
        } catch (error) {
            const message = getSafeErrorMessage(error, candidateSettings, getGlobalCredentials(this));
            this.error('Failed to handle settings change: ' + message);
            throw new Error('Failed to update settings: ' + message);
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
            const message = getSafeErrorMessage(err, settings, getGlobalCredentials(this));
            this.error('Error reinitializing connection: ' + message);
            if (throwOnFailure) throw new Error(message);
        }
    }

async powerOn(device) {
        try {
            this.log('Turning device on ' + device);
            const sysInfo = await this.client.getSysInfo(device);
            this.plug = this.client.getPlug({ host: device, sysInfo });
            await this.plug.setPowerState(true);
        } catch (err) {
            this.error('Error turning device on:', getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
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
            this.error('Error turning device off:', getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
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
            this.log("Caught error in getPower function: " + getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
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
            this.error('Caught error in getLed function:', getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
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
            this.log('Error turning LED on: ', getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
            throw err;

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
            this.log('Error turning LED off: ', getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
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
            this.log('Error resetting meter: ', getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
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

        try {
            if (!this.plug || this.plug.client !== this.client || this.plug.host !== device) {
                const sysInfo = await this.client.getSysInfo(device);
                if (!recovery.isCurrent(poll)) return;
                this.plug = this.client.getPlug({ host: device, sysInfo });
            }

            const data = this.activeTransport === 'tcp'
                ? await this.plug.getInfo()
                : { sysInfo: await this.plug.getSysInfo() };
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
        clearTimeout(this.pollStartTimer);
        // Stagger the first poll within the interval so devices initialized
        // together do not all open connections in the same tick.
        const pollStatus = async () => {
            try {
                await this.getStatus();
            } catch (err) {
                this.log("Error during polling: " + getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
                // Optionally, handle reconnection or retry logic here
            }
        };
        this.pollStartTimer = setTimeout(() => {
            this.pollStartTimer = null;
            this.pollingInterval = setInterval(pollStatus, 1000 * interval);
            void pollStatus();
        }, Math.floor(Math.random() * 1000 * interval));
    }


    stopActiveDiscovery() {
        getRecovery(this).cancel();
    }

    isConfiguredForGlobalCredentials() {
        if (getDeviceConnectionData(this).transport === 'tcp') return false;
        return this.getSettings().credentialSource !== CREDENTIAL_SOURCES.OVERRIDE;
    }

    async refreshGlobalCredentials({ reason } = {}) {
        if (!this.isConfiguredForGlobalCredentials()) return false;

        this.stopActiveDiscovery();
        const refreshGeneration = (this.globalCredentialRefreshGeneration || 0) + 1;
        this.globalCredentialRefreshGeneration = refreshGeneration;
        const settings = this.getSettings();
        const transport = getEp10Transport(getDeviceConnectionData(this), settings, getGlobalCredentials(this));
        const client = createClientFromSettings(this, getDeviceConnectionData(this), settings, transport);
        this.activeTransport = transport;
        this.client = client;
        this.plug = null;

        try {
            const sysInfo = await client.getSysInfo(settings.settingIPAddress);
            if (
                refreshGeneration !== this.globalCredentialRefreshGeneration ||
                client !== this.client
            ) return false;

            this.plug = client.getPlug({ host: settings.settingIPAddress, sysInfo });
            this.log('Refreshed global TP-Link credentials' + (reason ? ': ' + reason : ''));
            return true;
        } catch (error) {
            if (
                refreshGeneration === this.globalCredentialRefreshGeneration &&
                client === this.client
            ) {
                this.log('Unable to refresh global TP-Link credentials: ' + getSafeErrorMessage(error, settings, getGlobalCredentials(this)));
            }
            return false;
        }
    }

    getManualCredentialTransition(settings) {
        const app = this.homey && this.homey.app;
        if (app && typeof app.getManualDeviceCredentialTransition === 'function') {
            return app.getManualDeviceCredentialTransition(settings);
        }
        return getManualCredentialTransition(settings);
    }

    async validateCredentialTransition(settings, transport) {
        if (!settings.settingIPAddress) {
            throw new Error('A device IP address is required to validate TP-Link account credentials.');
        }

        const client = createClientFromSettings(
            this,
            getDeviceConnectionData(this),
            settings,
            transport,
            { timeout: CREDENTIAL_VALIDATION_TIMEOUT }
        );
        try {
            const sysInfo = await client.getSysInfo(settings.settingIPAddress);
            return {
                client,
                plug: client.getPlug({ host: settings.settingIPAddress, sysInfo })
            };
        } catch (error) {
            throw new Error(
                'Unable to validate TP-Link account credentials for this device: ' +
                getSafeErrorMessage(error, settings, getGlobalCredentials(this))
            );
        }
    }

    canRecoverTransport(error) {
        return this.activeTransport === 'tcp' &&
            (error && error.code === 'ECONNREFUSED' && error.port === 9999 ||
             /ECONNREFUSED[^\n]*:9999/.test(error && error.message || ''));
    }

    async updateInMemoryTransport(transport, settings, protocol, current = () => true, source = 'rediscovery') {
        if (!isValidTpLinkTransport(transport) || !current()) return;
        const profile = { host: settings.settingIPAddress, transport, protocol };
        const previous = this.getStoreValue('tplinkConnection');
        if (!previous || previous.host !== profile.host || previous.transport !== transport || previous.protocol !== protocol) {
            await this.setStoreValue('tplinkConnection', profile);
        }
        if (!current()) return;
        this.activeTransport = transport;
        this.client = createClientFromSettings(this, getDeviceConnectionData(this), settings, transport);
        this.log('Transport confirmed by ' + source + ': ' + transport + ', protocol=' + protocol);
    }

    // Legacy pairings may lack a stored device ID, so IP rediscovery cannot
    // match them after a firmware update disables the legacy TCP port.
    // Probe the configured address directly instead of skipping recovery.
    async probeTransportAtConfiguredIp(settings) {
        const host = settings.settingIPAddress;
        const probeConnectionData = { ...getDeviceConnectionData(this), transport: 'klap' };
        const probeClient = createClientFromSettings(this, probeConnectionData, settings, 'klap');
        try {
            const sysInfo = await probeClient.getSysInfo(host);
            if (!String(sysInfo.model || '').toUpperCase().startsWith(TPlinkModel)) {
                throw new Error('unexpected model: ' + (sysInfo.model || 'unknown'));
            }
            const protocol = String(sysInfo.type || sysInfo.mic_type || '').startsWith('SMART.') ? 'smart' : 'iot';
            await this.updateInMemoryTransport('klap', { ...settings, settingIPAddress: host }, protocol, () => true, 'direct probe');
            this.log('Device at ' + host + ' answered over KLAP; legacy pairing recovered without re-pairing');
        } catch (error) {
            const message = getSafeErrorMessage(error, settings, getGlobalCredentials(this));
            getRecovery(this).logChanged('directProbeFailure', message, 'Direct transport probe failed: ' + message);
        }
    }

    async discover({ transportRecovery = false } = {}) {
        const settings = this.getSettings();
        if (transportRecovery && !settings.deviceId &&
            isIP(settings.settingIPAddress) === 4) {
            await this.probeTransportAtConfiguredIp(settings);
            return;
        }
        return getRecovery(this).discover({
            createClient: settings => new Client({ ...getTpLinkDiscoveryClientOptions(settings, getGlobalCredentials(this)), defaultSendOptions: { timeout: 4000 }, logLevel: 'silent' }),
            type: 'plug',
            allowFixedIp: transportRecovery,
            resolveCandidate: async (plug, settings) => {
                if (!String(plug.model || '').toUpperCase().startsWith(TPlinkModel)) return null;
                const discoveryId = plug.deviceId;
                const options = getTpLinkDiscoveryClientOptions(settings, getGlobalCredentials(this));
                const transport = getDiscoveredTransport(plug);
                const resolved = resolveDeviceCredentials(settings, getGlobalCredentials(this));
                const account = !resolved.credentials ? 'none' : resolved.usesGlobalCredentials ? 'global' : 'device';
                const advertisedVersion = plug.sysInfo && plug.sysInfo.mgt_encrypt_schm && plug.sysInfo.mgt_encrypt_schm.lv;
                const loginVersion = Number.isInteger(advertisedVersion) ? advertisedVersion : 'unknown';
                const diagnostic = `transport=${transport}, login version=${loginVersion}, account=${account}`;
                getRecovery(this).logChanged('transportCandidate', diagnostic, 'Transport candidate: ' + diagnostic);
                if (transport !== 'tcp' && !options.credentials) {
                    throw new Error('Authenticated firmware found; save the TP-Link owner account in app settings.');
                }
                const sysInfo = await plug.getSysInfo();
                const model = sysInfo.model || plug.model;
                if (!String(model || '').toUpperCase().startsWith(TPlinkModel)) return null;
                const protocol = String(sysInfo.type || sysInfo.mic_type || '').startsWith('SMART.') ? 'smart' : 'iot';
                return {
                    deviceId: discoveryId === settings.deviceId ? discoveryId : sysInfo.deviceId || sysInfo.device_id || plug.deviceId,
                    host: plug.host,
                    afterSave: current => this.updateInMemoryTransport(transport, { ...settings, settingIPAddress: plug.host }, protocol, current),
                };
            },
        });
    }

}

module.exports = TPlinkPlugDevice;
