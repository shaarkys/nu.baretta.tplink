# TP-Link KASA LAN for Homey

TP-Link KASA LAN connects supported TP-Link Kasa plugs, outlets, power strips, wall switches, dimmers, bulbs, and light strips to Homey Pro. Communication and everyday control take place over the local network, so supported devices can be used from the Homey app and in Flows without relying on cloud control for each command.

The app supports automatic LAN discovery, manual-IP pairing, recovery after an IP-address change, device controls, status polling, lighting controls, energy measurements on compatible models, and model-specific Flow actions.

## Requirements

- Homey Pro running Homey software 5.0.0 or newer.
- A supported TP-Link device reachable from Homey on the local network.
- TP-Link account credentials for authenticated SMART models such as KS225, S500D, and KS240. These credentials authenticate the encrypted local connection; they are stored in masked device settings and are not written to application logs.
- Third-Party Compatibility enabled in the Kasa app when required by a legacy Kasa device or firmware version.

## Supported devices

Features vary by model and hardware or firmware revision.

| Category | Models | Main Homey features |
| --- | --- | --- |
| Plugs and outlets | HS100, HS103, HS105, HS110, EP10, EP25, KP105, KP115, KP200, KP303 | On/off, LED control, and energy measurements on supported models |
| Power strips and outdoor outlets | HS300, EP40, KP400 | Separately paired outlets where supported, on/off, LED control, and energy measurements on supported models |
| Dimmable outdoor plug | KP405 | On/off, dimming, and LED control |
| Wall switches and dimmers | ES20M, HS200, HS210, HS220, KS225, KS230, S500D | On/off, dimming where supported, LED control, and model-specific measurements |
| Motion and ambient-light switch | KS200M | On/off, LED control, motion alarm, and ambient-light measurement |
| Fan and light controller | KS240 | Fan and light channels paired as separate Homey devices, with on/off and level control |
| Bulbs | LB100, LB110, LB120, LB130, KL50, KL60, KL110, KL120, KL125, KL130 | On/off, dimming, color temperature, color, and lighting modes where supported |
| Light strips | KL400, KL430 | On/off, dimming, color temperature, color, and lighting modes |

The driver list represents the models recognized by the current app manifest. Similar-looking regional variants are not automatically supported unless their model identifier matches one of the listed drivers.

## Authenticated SMART devices

Newer TP-Link devices no longer accept the original unencrypted Kasa protocol. The app includes authenticated local support for:

- KS225 using the KLAP transport.
- S500D using the AES transport.
- KS240 using the AES transport, including separate fan and light child devices.

Enter the same TP-Link account email address and password used to provision the device when pairing. Existing devices from these families may require the credentials to be added in their Advanced Settings after updating the app.

This support has passed API fixtures, automated tests, dependency checks, and Homey package validation. Physical testing across the different hardware and firmware revisions still depends on feedback from device owners, so these drivers should be treated as community-tested until more real-device results are available.

## Pairing

1. Ensure Homey and the TP-Link device can reach each other on the local network.
2. In Homey, add a device and select the driver matching the exact model.
3. Try automatic discovery first.
4. If discovery is blocked by a VLAN, Wi-Fi isolation, firewall, or router configuration, enter the device IP address manually.
5. For KS225, S500D, or KS240, provide the TP-Link account credentials during pairing.
6. Select all discovered devices or channels that you want to add.

Reserving an IP address in the router's DHCP configuration is recommended. If that is not possible, enable the dynamic-IP option in the device settings so the app can attempt rediscovery when the address changes.

## Homey capabilities and Flows

Depending on the device, the app exposes:

- On/off and toggle control.
- Dimming, color, saturation, and color-temperature control.
- Circadian and normal lighting modes.
- LED or night-mode control.
- Power, current, voltage, and accumulated-energy measurements.
- Motion and ambient-light information for KS200M.
- Power-meter reset and undo actions.
- Transition-based bulb on/off actions.

Standard Homey capability triggers and conditions remain available for compatible devices. Existing driver IDs, capability IDs, paired-device identities, and Flow contracts are preserved by the authenticated-device update.

## Troubleshooting and diagnostic reports

If a device stops responding after an update, do not remove it immediately because removing it can affect existing Flows.

1. Confirm that the device still works in the Kasa app and is online on the same local network as Homey.
2. For a legacy Kasa device, verify that Third-Party Compatibility is still enabled in the Kasa app.
3. Check the stored IP address and try manual-IP pairing or the dynamic-IP option when discovery cannot reach the device.
4. For KS225, S500D, or KS240, verify the TP-Link credentials in the device's Advanced Settings.
5. Restart the TP-Link KASA LAN app once, reproduce the problem, and create a Homey app diagnostic report as soon as possible.

When reporting a problem, include the diagnostic-report ID, exact TP-Link model, hardware and firmware version, Homey model and firmware version, app version, whether the device was newly paired or already installed, the pairing method, the failed action, and the approximate time of the failure.

Never publish TP-Link or Homey credentials, access tokens, public IP addresses, or remote-access details. Use a private message only when additional coordination is necessary.

## Community testing and contributions

Reports from owners of KS225, S500D, KS240, ES20M, HS110, HS220, and KS230 devices are especially helpful. Please test pairing, controls, status updates, app restart recovery, and existing Flows. Both successful results and failures accompanied by a diagnostic-report ID help improve compatibility.

Source code and issue tracking:

- Homey app: https://github.com/shaarkys/nu.baretta.tplink
- TP-Link API fork: https://github.com/shaarkys/tplink-smarthome-api
- Homey community discussion: https://community.homey.app/t/app-pro-tp-link-kasa-lan-smart-plugs-and-bulbs-wifi/1045

The app uses a maintained fork of Patrick Seal's `tplink-smarthome-api` and builds on earlier TP-Link protocol research by the open-source community. This is a community integration and is not affiliated with or endorsed by TP-Link or Athom.
