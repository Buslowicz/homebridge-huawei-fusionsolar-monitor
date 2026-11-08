# Historical installation fix: 0.1.1

A Raspberry Pi user reported missing HuaweiFusionSolarMonitor after `npm install github:Buslowicz/homebridge-huawei-fusionsolar-monitor` with Homebridge 2.5.0 and Node 26.13.0.

The plugin-side regression was reproduced: a local Git dependency install using the original 0.1.0 manifest succeeded but omitted `dist/index.js`. The repository stores TypeScript sources. `prepack` built npm pack archives, whereas npm Git dependency preparation invokes `prepare`.

Version 0.1.1 replaces `prepack` with `prepare: npm run build`. Telemetry/accessory logic was unchanged. Release archives still contain compiled files and need no development tools on the Homebridge device.

## Regression before the fix

Real local Git dependency installation from original sources, without dist/node_modules:

```text
tests 1
pass 0
fail 1
ENOENT: consumer/node_modules/homebridge-huawei-fusionsolar-monitor/dist/index.js
```

npm itself exited 0; the test detected the missing runtime entry point.

## Recorded final verification

Clean sources in /private/tmp, Node.js 24.11.1 / npm 11.6.2, locked dependencies:

```text
npm run verify
> npm run typecheck && npm run lint && npm run build && npm test

tsc -p tsconfig.json --noEmit
exit 0
eslint src
exit 0
tsc -p tsconfig.json
exit 0

✔ a clean local Git dependency install builds the runtime and registers its platform without bundled development dependencies
✔ the prebuilt archive installs globally and registers its platform without installing build tools
✔ installable archive loads in real Homebridge 1/2, publishes precise read-only data, then restores cache
tests 72
pass 72
fail 0
cancelled 0
skipped 0
```

Both installation paths were also checked with Node.js 26.3.1 / npm 11.16.0:

```text
node --test tests/git-install.test.mjs
tests 2
pass 2
fail 0
cancelled 0
skipped 0
```

This was not a physical Raspberry Pi test or a test of the user's exact Node 26.13.0 runtime.

The Git test creates a real temporary repository, runs npm install, imports the installed entry point and checks platform registration through Homebridge's API. The second test globally installs a real archive into an isolated prefix. Both check that runtime directories contain no Homebridge, TypeScript or other build dependencies. Neither contacts Huawei.

Audit of the unchanged dependency tree:

```text
npm audit --json --cache /private/tmp/fusionsolar-npm-cache
"vulnerabilities": {}
"total": 0
```

## Why global archive installation is recommended

Additional `npm install -g git+file://...` trials with npm 11.6.2 and 11.16.0 found global mode/prefix forwarded into internal Git preparation. This caused missing local tsc; diagnostically forcing local npm ci then left a link to a temporary clone deleted after installation. npm could report success for a broken install. The forced-ci workaround was not added to the plugin.

Direct global Git installation is not claimed fixed. Verified paths are local Git-source installation into a Homebridge-searched plugin directory and global installation of a prebuilt .tgz; the latter is recommended on Raspberry Pi. Final tests did not skip specs or count the failed global Git path as passing.

This historical report covers the installation fix only. Physical Raspberry Pi/iPhone presentation and real Huawei account access remain user-environment checks. Its results do not automatically verify later source changes.
