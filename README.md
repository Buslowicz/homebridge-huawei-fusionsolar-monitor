# Huawei FusionSolar Monitor for Homebridge

Read-only Huawei FusionSolar cloud telemetry for HomeKit, primarily for domestic SUN2000 inverters and power meters. A battery is not required. The plugin never switches equipment or changes plant settings.

The full measurement set is intended for **Controller for HomeKit**; Eve is not required. Apple Home shows selected standard sensors. Custom characteristics are not a separate graphical dashboard in Apple Home. Check their presentation and automation support in your installed Controller/iOS version.

## Requirements

- Homebridge 1.11.4 or 2.x; local compatibility tests cover exactly 1.11.4 and 2.5.0.
- Node.js 22.12+, 24.x or 26.x as supported by your Homebridge version. Use Node 22/24 with Homebridge 1; 1.11.4 does not declare Node 26 support.
- A separate **Northbound/OpenAPI** account with Basic APIs permission and assigned plants. A normal FusionSolar app login is insufficient.
- Your account's regional FusionSolar HTTPS server. The `eu5` example is not automatic region selection.
- Internet access from Homebridge. This is a cloud integration, not local Modbus.

## Automated releases

Every push to `main` runs [Build and release](https://github.com/Buslowicz/homebridge-huawei-fusionsolar-monitor/actions/workflows/release.yml): locked dependency installation, type checking, lint, build, all tests and dependency audit. A successful build publishes a [GitHub Release](https://github.com/Buslowicz/homebridge-huawei-fusionsolar-monitor/releases) containing a ready-to-install `.tgz` and `SHA256SUMS`. The same verified archive is then published as `@buslowicz/homebridge-huawei-fusionsolar-monitor` to GitHub Packages. The workflow does not change repository or package visibility. A new GitHub npm package starts private; its package settings control access independently of repository visibility.

The first release uses the source `package.json` baseline (currently `0.1.1`). Subsequent releases increment the highest stable patch tag, for example `0.1.2`, `0.1.3`. Raising the source baseline starts a new minor/major series. Package versions are assigned only during the build; no version commits are added to `main`.

Tags identify the exact verified commit. Rerunning the same commit reuses its version and checks published files rather than overwriting them. Publication follows complete asset upload; a failed attempt may leave a tag or draft that a retry can finish. Releases run sequentially, with up to 100 queued runs under GitHub Actions limits.

Manual execution is available under **Actions → Build and release → Run workflow** on `main`. The built-in `GITHUB_TOKEN` is sufficient. Tests have read-only repository permission. Separate publication jobs use the completed archive: one can write releases, and one can write GitHub Packages. No personal token or additional repository secret is needed for publication. The package job runs after the release job and verifies an actual registry installation before succeeding.

## Install from GitHub Packages (recommended)

The npm package is **`@buslowicz/homebridge-huawei-fusionsolar-monitor`**. Its registry is `https://npm.pkg.github.com`; it is not published to npmjs.org. GitHub requires authentication to install npm packages, including public ones. See [GitHub npm registry authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages).

On the Homebridge machine, create a GitHub **personal access token (classic)** with `read:packages` and an account that can read this package. Authenticate in the same operating-system user and Node/npm environment used to install your Homebridge plugins:

```sh
npm login --scope=@buslowicz --auth-type=legacy --registry=https://npm.pkg.github.com
```

Enter your GitHub username and use the token as the password. Enter the token only in the terminal prompt; do not put it in commands, this repository, Homebridge configuration or issue reports. npm stores registry credentials in that operating-system user's npm configuration. A login under a different account, container or `sudo` context may not be visible to the installer.

Install the latest published package:

```sh
npm install -g @buslowicz/homebridge-huawei-fusionsolar-monitor@latest
```

The scoped registry mapping created by `npm login --scope` routes only `@buslowicz` packages to GitHub. Other packages continue to use their usual registry. The archive already contains `dist`; registry installation requires no compiler or development dependencies. Restart Homebridge after installing.

Use `-g` only for a standard global Homebridge plugin installation. For a custom plugin directory, install locally in that directory, omitting `-g`. For Docker, log in and install inside the container or its configured persistent plugin environment. The Homebridge dashboard's default npmjs.org search may not list this GitHub-hosted package; use its terminal for the command above.

To update later, repeat the same install command and restart Homebridge. To select a specific published version, replace `@latest` with, for example, `@0.1.4`.

### Migrate from the original unscoped package

Stop Homebridge before replacing the plugin. In the same environment and installation scope where the original plugin was installed:

```sh
npm uninstall -g homebridge-huawei-fusionsolar-monitor
npm install -g @buslowicz/homebridge-huawei-fusionsolar-monitor@latest
```

For an earlier local install, omit `-g` and run in its original plugin directory. Keep your platform configuration, Child Bridge settings, accessory cache and HomeKit pairing. The alias remains `HuaweiFusionSolarMonitor`, and accessory UUID seeds are unchanged. Homebridge 1.11.4 and 2.5.0 migrate the cached plugin association by this platform alias; both paths are tested.

Install only one package identity at a time. If your configuration explicitly filters `plugins`, replace `homebridge-huawei-fusionsolar-monitor` there with `@buslowicz/homebridge-huawei-fusionsolar-monitor`. If `platform` uses the fully qualified old identifier, change it to `HuaweiFusionSolarMonitor` (or the new scoped qualified identifier). Then restart Homebridge. The usual unqualified platform entry shown below needs no change.

## Alternative: install a release archive


Download the `.tgz` from the [latest release](https://github.com/Buslowicz/homebridge-huawei-fusionsolar-monitor/releases/latest), transfer it to the Homebridge device, and run in its environment:

```sh
npm install -g /full/path/buslowicz-homebridge-huawei-fusionsolar-monitor-0.1.4.tgz
```

The archive includes compiled runtime files and needs no build tools on Raspberry Pi. `-g` installs into the location searched by a standard global Homebridge installation. Use the same Node/npm environment and installation method as your other plugins. For a service with a custom plugin directory, install there according to that service's configuration.

If you previously installed 0.1.0 locally from GitHub, run this **in the same directory used for that installation**:

```sh
npm uninstall homebridge-huawei-fusionsolar-monitor
```

Install the release archive and restart Homebridge in its dashboard. Keep the Huawei configuration and accessory pairing.

### Alternative: local installation from GitHub sources

The Git install also uses the scoped package identity. For a private repository, Git on the Homebridge device needs read access. Run in the project directory whose `node_modules` is configured as your service's plugin directory:

```sh
npm install github:Buslowicz/homebridge-huawei-fusionsolar-monitor
```

Installing in an arbitrary home directory does not make Homebridge discover it. If you do not know the service's plugin directory, use the global release archive installation above.

Version 0.1.1 adds automatic compilation with `prepare` for Git installs. Do not use `--ignore-scripts`: the repository does not store `dist`, and this script creates the entry point. Build tools are temporary; the runtime installation contains no copy of Homebridge or development dependencies.

Global `npm install -g github:...` is not recommended: tests with npm 11.6.2 and 11.16.0 found global mode forwarded into Git dependency preparation, leaving a link to a deleted temporary directory. Use `.tgz` for global installs. This affects Git installation, not operation after correct installation.

In Docker, the archive and command must be inside the Homebridge container or an accessible volume. Use the same environment and method as other plugins; development/test dependencies are unnecessary.

Enter the API server and credentials in Homebridge, save, and restart. A separate Child Bridge is recommended; pair it with Apple Home using Homebridge's instructions.

Example `platforms` entry in `config.json`:

```json
{
  "platform": "HuaweiFusionSolarMonitor",
  "name": "Huawei FusionSolar",
  "baseUrl": "https://eu5.fusionsolar.huawei.com",
  "username": "YOUR_NORTHBOUND_LOGIN",
  "password": "ENTER_LOCALLY",
  "pollIntervalSeconds": 300,
  "alarms": true,
  "statusSensors": true,
  "powerMeters": true,
  "gridPowerDirection": "unconfigured",
  "writeSnapshot": true
}
```

Homebridge stores UI-entered credentials in its configuration file. Alternatively omit `username` and `password`, and set `FUSIONSOLAR_USERNAME` and `FUSIONSOLAR_PASSWORD` in the **Homebridge service** environment. Variables in a separate terminal may not reach the service. Never share credentials in chats or issue reports.

## Measurements

The plugin discovers assigned plants/devices and creates plant, inverter, meter and optional active-alarm accessories. Custom metrics appear in `Huawei metrics 1` and subsequent groups. Group numbers are HomeKit subdivisions, not phase or panel numbers. In Controller, open accessory details and characteristics; aliases may be needed in some app versions. Labels include units, for example `Active power [kW]` and `Voltage phase A [V]`. Missing values produce read errors/unavailability rather than invented zero readings.

| Source | Available data when returned by Huawei |
| --- | --- |
| Plant | Daily/monthly/total production, daily consumption, exported energy, income, health |
| SUN2000 type 38 or 1 | AC/DC/reactive power, phase/PV voltages and currents, frequency, efficiency, internal temperature, daily/total/MPPT energy, states and start/stop times |
| Meter type 17 or 47 | Total/phase power, voltages/currents, power factor, positive/negative energy counters and other KPIs |
| Alarms | Count, severity counts, names, IDs, times, causes and suggestions for up to 20 current alarms in HomeKit |
| Other supported types | Scalar API KPIs for EMI 10, battery 39, ESS 41 and SmartAssistant 23070; not every field has a known label/unit |

Unknown scalar fields retain names based on API keys; units are never guessed. Firmware/model support varies. `null`, empty and `N/A` values remain unavailable. Physically absent PV inputs may be omitted or reported as zero by Huawei; that distinction is preserved. Inverter `active_power` is **kW**, while meter type 17/47 `active_power` is **W**. Original signed meter values are preserved. Positive/negative energy counters are not relabeled import/export without wiring confirmation. `day_use_energy` is Huawei's daily consumption; income currency is configured in FusionSolar, not assumed.

### Power services in existing accessories

With `powerMeters: true` (default), these services are added inside existing accessories:

- **PV Production**: inverter AC active power converted from kW to W.
- **Grid Power**: the meter's original signed active power in W, unchanged.
- **Grid Import** and **Grid Export**: nonnegative W after explicitly configuring the sign convention.
- **Home Consumption (plant)**: estimated W, calculated as the sum of all inverter AC power plus signed grid import. It is not a synchronized device measurement.

`gridPowerDirection` defaults to `unconfigured`: no import/export direction or household consumption is guessed. Set `positiveImport` only if positive meter power means import; set `positiveExport` if positive means export. Configuring either value explicitly confirms that the selected meter measures the **grid connection**, rather than a subcircuit. Verify the direction against FusionSolar both at night/during import and during export before using derived readings in automations. This global setting applies to selected meters across all selected plants; select only compatible plants.

When a plant has multiple meters, set optional `gridMeterId` to the exact device ID string, for example `"1002"`. It must be a signed decimal string of up to 128 characters; numbers, whitespace and empty strings are rejected. Omit it to select the plant's unique meter automatically. An explicit ID limits meter selection; an ambiguous or missing selection is unavailable.

Home Consumption is available only for plants without a battery, with all required sources connected and successfully read in the current polling cycle. Missing/failed data, ambiguous meters, disconnected sources and a negative derived result remain unavailable; no zero is inferred. Cloud measurements usually refresh about every five minutes and may not be synchronized. Setting `powerMeters: false` disables these added services and leaves the original metrics available. There is no fake switch.

### Selected data in Apple Home

- Inverter internal temperature: device temperature, not room temperature.
- Optional virtual `Huawei PV Production` contact sensor: open means positive AC production; closed means no positive power.
- Optional virtual `Huawei Plant Fault` contact sensor: open means Huawei reports a fault/disconnection; closed means healthy. It does not replace the alarm list.

All readings are read-only. Automations may control other home accessories based on readings; they do not control the inverter.

## Refresh, connection loss and alarms

- Current data: at least 300 seconds after the previous cycle **finishes**, configurable up to 3600 seconds. Huawei collects device data at intervals of at least five minutes; this is unsuitable for second-level reactions.
- Active alarms: every 30 minutes, queried from Unix epoch to now to retain old still-active alarms. Cleared-alarm history is not retrieved. API alarm language is English (`en_US`).
- Discovery: at startup, then every 24 hours. Failed discovery retries after at least one hour. Permission/configuration changes may require a restart.
- A shared API session lasts up to 30 minutes. Invalid credentials cause a 30-minute cooldown.
- Every attempted query reserves local quota, including failures. API 305/HTTP 401 invalidate the session; it may renew, but the query waits for its next allowed cycle. API 401 means permission failure, not repeated login.
- 407/429 and `Retry-After` extend delays. Multiple integrations share account limits. Daily quotas depend on account resources; avoid repeated restarts.
- A failed source becomes unavailable while other sources may continue. Current values expire after `2 × interval + 60 seconds`; alarms after 61 minutes. Saved values are not restored as current after restart.
- Explicit device/meter disconnection makes its electrical values unavailable while connection state remains visible.

`API received at` records response receipt, not a confirmed physical measurement timestamp.

## Local snapshot

With `writeSnapshot: true`, the latest JSON is stored at:

```text
<Homebridge storage>/huawei-fusionsolar-monitor/<identifier>.json
```

It includes device metadata, all validated KPIs, full alarm descriptions, and each source's last read time/status. `available` means the last API query succeeded, not guaranteed physical connectivity. A failed query retains previous values with `available: false` and their original receipt date.

Passwords, session tokens, plant addresses/geolocation and account contacts are excluded. Plant names, IDs and serial numbers remain private: review before sharing. Directory permissions are 700 and file permissions 600. No additional web server runs. Only the latest snapshot is retained, not long-term history.

HomeKit alarm text is limited to 256 UTF-8 bytes; full validated descriptions remain in the snapshot. Up to 20 alarms are sorted by severity then newest first. Their numbers are positions in the current list, not stable event IDs. Additional alarms remain in the snapshot.

## Demo

```json
{
  "platform": "HuaweiFusionSolarMonitor",
  "name": "Huawei DEMO",
  "demo": true,
  "writeSnapshot": true
}
```

Demo names identify synthetic devices; no Huawei connection or credentials are used. The default direction remains `unconfigured`. To demonstrate derived power, add `"gridPowerDirection": "positiveImport"`: 3900 W PV plus -1100 W grid import gives 2800 W home consumption. Never use demo data for real automations. Switching to a real account creates different accessories; successful discovery removes demo accessories.

## Troubleshooting

| Message | Check |
| --- | --- |
| `authentication`, 20400 | Northbound credentials, lock/expiry, regional server; avoid repeated attempts |
| `permission (401)` | Basic APIs, assigned plants and alarm API permissions |
| `rate-limit`, 407/429 | Wait; stop duplicate integrations or use a separate API account |
| `network` | Internet, DNS, HTTPS certificate, region; certificate validation remains enabled |
| `invalid-response` | Unexpected types/ranges, unsupported API code/version; inspect local state without sharing credentials |
| `No plugin was found for the platform "HuaweiFusionSolarMonitor"` | Earlier `ERROR LOADING PLUGIN`, version 0.1.1+ for Git installs and service plugin directory. `npm list -g --depth=0 @buslowicz/homebridge-huawei-fusionsolar-monitor` checks the current npm environment's global copy. |
| Empty values | Device KPI support, permissions and actual FusionSolar data |
| Missing W/kWh in Apple Home | Use Controller characteristics; the plugin cannot redesign Apple Home |
| Unavailable derived consumption | Confirm meter ID/sign, absence of batteries, all inverter/meter connectivity and current-cycle data |

For multiple plants, optionally set `stationCodes: ["NE=..."]` using API IDs, which may differ from UI IDs. Limits: 100 selected plants, 100 devices per type and 1000 account plants during discovery (10 pages). This is a domestic integration, not fleet management.

## Build and verification

```sh
npm ci
npm run verify
npm audit
npm pack
```

API tests run a real local HTTPS server with a localhost-only fixture key/certificate, excluded from packages. Homebridge tests run isolated local demo bridges without Huawei access. Local listening permission may be required.

Installation tests require Git/npm and exercise a real local Git dependency and global archive install. They use `FUSIONSOLAR_TEST_NPM_CACHE` or `npm_config_cache`; an empty cache needs npm registry access. See the historical [0.1.1 installation report](docs/installation-fix.md).

There are no runtime npm dependencies. TypeScript/ESLint and two Homebridge versions are build/test dependencies only. The `minimatch` 11.0.3 override addresses a development-tool vulnerability; tool behavior is covered by verification.

Contracts use the supplied **SmartPVMS 26.1.0 NBI Reference, Issue 01, 2026-03-30**, sections 3.2, 4.2, 5.1.1–5.1.3 and 6.1. The Huawei document is not distributed. HomeKit references: [Homebridge template](https://github.com/homebridge/homebridge-plugin-template), [HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS), [Controller custom characteristics](https://controllerforhomekit.wordpress.com/features/vendor-characteristics/).

GitHub Packages publication uses the built-in `GITHUB_TOKEN` with `packages: write` only in the registry job. Exact-version SHA-512 integrity is checked before/after publishing; reruns accept an existing version only when its archive matches. Registry authentication/network errors fail the job rather than being treated as a missing package. Publication success includes an isolated global `npm install` from the registry. A package may already exist if a later installation check fails; rerunning verifies it without overwriting it. GitHub Releases remain an authenticated-registry-free installation alternative.

Local tests do not verify your real Huawei account, specific SUN2000-10KTL-M1-HC firmware or physical Controller/iOS presentation. Check these after installation, including meter direction. Native Controller/Apple Home AXE/VoiceOver and whole-application WCAG audits have not been performed. No control, OAuth, Modbus or historical time-series retrieval is implemented; current counters do not reproduce all FusionSolar functionality. Historical reports describe their original tested packages, not automatic verification of later source changes.
