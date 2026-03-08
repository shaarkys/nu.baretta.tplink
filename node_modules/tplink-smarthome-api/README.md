<!-- markdownlint-disable MD007 MD012 MD033 -->

# tplink-smarthome-api

[![NPM Version](https://img.shields.io/npm/v/tplink-smarthome-api.svg)](https://www.npmjs.com/package/tplink-smarthome-api)
[![Build Status](https://github.com/plasticrake/tplink-smarthome-api/workflows/CI/badge.svg?branch=main)](https://github.com/plasticrake/tplink-smarthome-api/actions?query=workflow%3ACI+branch%3Amain)
[![Coverage Status](https://coveralls.io/repos/github/plasticrake/tplink-smarthome-api/badge.svg?branch=master)](https://coveralls.io/github/plasticrake/tplink-smarthome-api?branch=master)

TP-Link Smarthome API

**[Changelog](https://github.com/plasticrake/tplink-smarthome-api/tree/main/CHANGELOG.md)**

## Known Supported Devices

| Model                                                                                                    | Type               |
| -------------------------------------------------------------------------------------------------------- | ------------------ |
| HS100, HS103, HS105, HS107, HS110,<br/>HS200, HS210, HS220, HS300, KP303, KP400<br/>ES20M, EP40, ...etc. | Plug               |
| KS240, KS225, S500D<br/>...etc.                                                                          | Plug (SMART, experimental) |
| LB100, LB110, LB120, LB130, LB200, LB230, KL50, KL120, KL125<br/>...etc.                                 | Bulb               |
| KL430<br/>...etc.                                                                                        | Bulb (light strip) |

Many other TP-Link Plug and Bulb models may work as well. Note that Tapo devices are not supported.

### Notes on Child Devices and Protocol Support

- Child-scoped operations (`childId`) are supported for plug modules such as `away`, `schedule`, `timer`, `emeter`, and `dimmer`.
- For child channels that expose brightness in child sysinfo (for example dimmer + fan combinations), dimmer capability is detected from child data when a `childId` is selected.
- This project primarily targets the legacy TP-Link Smart Home protocol (`IOT.*` on port `9999`), and now includes experimental authenticated HTTP transports: `klap` and `aes` (credential or `credentialsHash` based).
- If `sysInfo` includes encryption metadata (`mgt_encrypt_schm.encrypt_type` and optional `http_port`), device defaults are inferred automatically (`klap`/`aes` transport and port) unless you explicitly override them.
- For SMART requests over authenticated transports, use `client.sendSmart(...)`, `device.sendSmartCommand(...)`, and `device.sendSmartRequests(...)` (including child-scoped `control_child` wrapping).
- Initial SMART switch support includes SMART power/LED paths and high-level helpers for `fan`, `lightPreset`, `lightTransition`, and `overheatProtection` (including child-scoped KS240 channels).
- SMART switch support now also includes:
  - dimmer brightness/switch-state (`set_device_info`)
  - timer mapping to SMART `auto_off`
  - away/schedule mapping (`get_antitheft_rules`, `get_schedule_rules`, `get_next_event`, plus SMART write/delete/enable calls)
  - SMART emeter realtime mapping (`get_emeter_data` with `get_energy_usage` fallback)
  - SMART emeter periodic stats compatibility (`get_runtime_stat` when available, fallback synthesis from `get_energy_usage`)
  - SMART time/cloud read paths (`get_device_time`, `get_connect_cloud_state`)
  - SMART cloud admin/write attempts (`bind`, `unbind`, `getFirmwareList`, `setServerUrl`) using method candidates for device-family differences
- Some SMART write/admin methods vary by firmware/model; this library uses best-effort SMART method candidates and throws when the device does not expose a compatible method.
- SMART switch capabilities now use component negotiation (`component_nego`, child component lists) for module gating. You can call `await plug.negotiateSmartComponents()` explicitly; `getSysInfo()` over SMART transport performs this lazily on first use.
- Full python-kasa parity is still in progress; not every SMART component has a dedicated module yet.

## Related Projects

- [TP-Link Smarthome Device Simulator](https://github.com/plasticrake/tplink-smarthome-simulator) - Useful for automated testing
- [TP-Link Smarthome Crypto](https://github.com/plasticrake/tplink-smarthome-crypto)
- [TP-Link Smarthome Homebridge Plugin](https://github.com/plasticrake/homebridge-tplink-smarthome)

## Examples

See more [examples](https://github.com/plasticrake/tplink-smarthome-api/tree/main/examples).

```javascript
const { Client } = require('tplink-smarthome-api');

const client = new Client();
const plug = client.getDevice({ host: '10.0.1.2' }).then((device) => {
  device.getSysInfo().then(console.log);
  device.setPowerState(true);
});

// Look for devices, log to console, and turn them on
client.startDiscovery().on('device-new', (device) => {
  device.getSysInfo().then(console.log);
  device.setPowerState(true);
});
```

## CLI

Install the command line utility with `npm install -g tplink-smarthome-api`. Run `tplink-smarthome-api --help` for help.

## API

[API docs can be found here.](https://plasticrake.github.io/tplink-smarthome-api/)

For functions that send commands, the last argument is `SendOptions` where you can set the `transport` (`'tcp'`, `'udp'`, `'klap'`, `'aes'`) and `timeout`, etc.

Functions that take more than 3 arguments are passed a single options object as the first argument (and if its a network command, SendOptions as the second.)

Example SMART over KLAP:

```javascript
const client = new Client({
  credentials: { username: 'user@example.com', password: 'secret' },
});

const device = client.getPlug({ host: '10.0.1.2', sysInfo });
const info = await device.sendSmartCommand('get_device_info');
const multi = await device.sendSmartRequests([
  { method: 'get_device_info' },
  { method: 'get_device_time' },
]);
```

## Credits

Thanks to George Georgovassilis and Thomas Baust for [figuring out the HS1XX encryption](https://blog.georgovassilis.com/2016/05/07/controlling-the-tp-link-hs100-wi-fi-smart-plug/).

Some design cues for Client based on [node-lifx](https://github.com/MariusRumpf/node-lifx/)
