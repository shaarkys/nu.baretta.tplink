# Changelog

**Unreleased**

### New authenticated SMART-device support

- Added local discovery, pairing, status polling, and control for newer authenticated TP-Link SMART devices.
- Added KS225 support using the KLAP transport, including on/off, dimming, and LED control.
- Added S500D support using the AES transport, including on/off, dimming, and LED control.
- Re-enabled KS240 support using the AES transport. Its fan and light channels are paired as separate Homey devices and retain their parent/child identity.
- Added app-wide TP-Link account credentials for authenticated SMART devices. New KS225, S500D, KS240, and authenticated EP10 devices can use one default account without copying its password to each paired device; different-account overrides remain available per device.
- Added private Homey Pro Settings controls to validate and save the default account, report only secret-safe status, explicitly adopt matching legacy local pairs, and refresh only devices that use the global source.
- Pairing now revalidates the selected physical target before saving. TCP EP10 pairing remains credential-free, while authenticated KLAP/AES EP10 pairing requires a complete account pair.
- Updated discovery for authenticated devices to use TP-Link TDP v2 while retaining legacy UDP discovery for existing Kasa devices.
- Pinned `tplink-smarthome-api` to the exact reviewed API revision used by this app, preventing future API changes from being installed unexpectedly.

### Pairing and reliability

- Isolated discovery state for each pairing session so simultaneous or cancelled pairing sessions do not share devices, listeners, or timers.
- Added cleanup when pairing finishes or is cancelled to prevent stale discovery listeners and timeouts.
- Preserved manual-IP pairing as a fallback when automatic discovery cannot cross VLAN, Wi-Fi, or firewall boundaries.
- Improved polling for ES20M, HS110, HS220, and KS230 by waiting for Homey capability updates and reconciling device state more consistently.
- Preserved existing driver IDs, capability IDs, paired-device data, and Flow compatibility.

### Community testing requested

- KS225, S500D, and KS240 owners are asked to test both automatic discovery and manual-IP pairing with their TP-Link account credentials, followed by on/off and dimming control. KS225 and S500D owners should also test LED control; KS240 owners should test both the fan and light channels.
- Existing ES20M, HS110, HS220, and KS230 users are asked to confirm that paired devices remain available after the update and that status, controls, measurements, and existing Flows continue to work.
- Physical-device testing was not possible before this release because no volunteer hardware access was available following the earlier community request. The implementation passed source, unit, dependency, and Homey package validation, but real-device behavior still needs community confirmation.
- If something stops working, do not remove the paired device immediately because doing so can affect existing Flows. Restart the TP-Link KASA LAN app once, reproduce the problem, and create a Homey app diagnostic report as soon as possible.
- When reporting a problem, include the diagnostic-report ID, exact TP-Link model and hardware/firmware version, Homey model and firmware version, app version, whether the device was already paired or newly paired, automatic or manual-IP pairing, the failed action, and the approximate time of the failure.
- Never post TP-Link credentials, Homey credentials, access tokens, public IP addresses, or remote-access details. Use a private message only if additional coordination is required.

**Version 0.2.2**
- Added support for HS210 - 3way

**Version 0.2.1**
- experimental - compatibility updates due to the plink-smarthome-api v5

**Version 0.2.00**
- Adding KP105, KP115,Fix getdrivername is not defined, Flow title fix, new name for app store
**Version 0.1.14**
- Catching possible stacktraces / refactored methods

**Version 0.1.13**
- SDK3 rewrite

**Version 0.1.12**
- Added support for KL range of bulbs: KL50/60/110/120/130

**Version 0.1.8**
- Copied lb130 driver for other bulb devices

**Version 0.1.7**
- Updated tplink-smarthome-api version
- Fixed LED on/off function ('nightmode') for plugs
- Properly removed LED on/off switch from mobile interface

**Version 0.1.6**
- Version bump due to silly app submission process caused by app-store overhaul

**Version 0.1.5**
- Updated tplink-smarthome-api version and reduced the footprint of the app
- Added energy estimation for bulbs

**Version 0.1.4**
- Small code improvement for pairing.
- Removed on/off function from mobile interface for plugs
- Added the TP-Link brand color.

**Version 0.1.3**
- Fixed typo in function name which caused the app to crash for some users on V2.

**Version 0.1.2**
- Bugfixes, 'dynamic' ip feature is now an option that can be enabled in the settings.
- Changed to discovery process, now using some of the builtin options.
- The number of discovery attempts is limited to 3 at 2,5 s intervals and a timeout of 9 seconds. 

**Version 0.1.1**
- Bugfixes 

**Version 0.1.0**
- Complete SDK2 rewrite
- The app will now continue to work when the IP address of the plugs or bulbs changes.

**Version 0.0.17**
- Switched to the tplink-smarthome-api (https://github.com/plasticrake/tplink-smarthome-api) to address
the issues with encryption of newer devices as well as changes in metering.

**Version 0.0.16**
- Edited app.json. Ready for beta release. 

**Version 0.0.15**
- Sorted out hue/saturation/color temp. options. 

**Version 0.0.14**
- Ran into git issue... Re-added missing_modules. 

**Version 0.0.13**
- Updated node_modules. 

**Version 0.0.12**
- Copied LB110 and LB120 drivers. 

**Version 0.0.11**
- Rewritten based on new tplink-smarthome API. 

**Version 0.0.9**
- Added fix for emetering change in API (for HS110 and HS200)

**Version 0.0.8:**
- Bugfixes for bulbs, added app to 'lights' category.

**Version 0.0.7:**
- Bumping version number to workaround an app store issue...

**Version 0.0.6:**
- Changed name of the app to reflect the wider support for TP-Link devices.

**Version 0.0.5:**
- Added support for TP-Link light bulbs LB100, LB110, LB120 and LB130, including 'wake-up light' feature.

**Version 0.0.4:**
- Bugfixes. Added check on model type in autodiscovery. Autodiscovery can now detect both new and existing plugs.

**Version 0.0.3:**
- Bugfixes, added autodiscovery feature.

**Version 0.0.2:**
- Bugfixes, added capabilities.

**Version 0.0.1:**
- Initial version
