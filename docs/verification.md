# Historical verification: Huawei FusionSolar Monitor 0.1.0

This report describes the original package prepared on 7 November 2026, not verification of subsequent changes. Scope: read-only SUN2000, meter, scalar plant/device KPIs and active alarms. Controller for HomeKit is the intended extended-data view; no separate graphical app was built.

## Recorded commands and results

Full verification on Node.js 24.11.1, exit 0:

```text
npm run verify
> npm run typecheck && npm run lint && npm run build && npm test

npm run typecheck
> tsc -p tsconfig.json --noEmit
exit 0

npm run lint
> eslint src
exit 0

npm run build
> tsc -p tsconfig.json
exit 0

npm test
> node --test tests/*.test.mjs
ℹ tests 70
ℹ pass 70
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

Repeated on the oldest declared Node.js 22.12.0, exit 0:

```text
node --test tests/*.test.mjs
# tests 70
# pass 70
# fail 0
# cancelled 0
# skipped 0
```

Audit of all installed dependencies, including development dependencies, exit 0:

```text
npm audit --json --cache /private/tmp/fusionsolar-npm-cache
"vulnerabilities": {}
"total": 0
```

Packaging, exit 0:

```text
npm pack --json --cache /private/tmp/fusionsolar-npm-cache --pack-destination ../../outputs
"filename": "homebridge-huawei-fusionsolar-monitor-0.1.0.tgz"
"size": 25855
"entryCount": 22
"bundled": []
```

All 22 archive files were compared byte-for-byte with project files. The archive excluded runtime npm dependencies, tests, fixture certificates/keys, account data and node_modules. Package SHA-256: `1ecd3963648bd00a1e2acf457c2ccf8d35b9846930d2fe369fef607083ebdc7d`.

## Coverage and resolved failures

- 50 real-local-HTTPS API tests cover TLS, allowed hosts/read-only paths, session lifetime, API 305/401 versus HTTP 401, invalid credentials, 407/429 and long Retry-After, size/deadline limits, cancellation, strict validation, exact Long IDs, pagination and 24-hour valid-page caching.
- 19 tests cover configuration, units, missing/stale/offline readings, alarms, local files and platform behavior using real Homebridge/HAP classes.
- One packaged integration test starts Homebridge 1.11.4 and 2.5.0 twice each, checks precise 3.9 kW, -1100 W and 18.4 kWh through HTTP/HAP, rejects writes with -70404, checks snapshots and stable accessory IDs after restart.
- All 70 tests passed on Node 24.11.1 and 22.12.0. Other Homebridge 2.x releases and Node 26 were not individually tested in this report.

Initial dependency installation reported 10 moderate minimatch vulnerabilities. Applying 11.0.3 and rerunning lint/tests resolved them; the recorded final audit was clean. Integration tests initially exposed minStep rounding and a service-name overload used instead of UUID; exact-value and cache-restoration tests passed after fixes without weakening expected readings.

Shutdown testing was corrected to each runtime's contract: Homebridge 1.11.4 exits 143; 2.5.0 exits 0 after graceful shutdown. Both must log SIGTERM handling. A test-server null-to-empty-array conversion was fixed; the production adapter rejects null or missing data rather than inventing zero alarms/removing devices.

Local listening was initially blocked by environment permissions. Final HTTPS/HAP tests ran with local-port access; production TLS verification remained enabled. Initial npm pack failed with EPERM in the default npm cache; an isolated /private/tmp cache succeeded without changing user-directory permissions.

## Remaining limitations

No real Huawei account, specific SUN2000-10KTL-M1-HC response or physical iPhone presentation in Controller/Apple Home was verified. No real credentials were supplied or retrieved. Test locally after installation with the correct regional server.

Native Controller/Apple Home AXE and VoiceOver audits were not performed. The plugin provides a configuration schema to Homebridge; this does not establish whole-application WCAG compliance for external apps.

Cloud readings generally refresh about every five minutes; alarms every 30 minutes. HomeKit exposes up to 20 current alarms with 256-byte text; the local snapshot retains the full validated set. There is no control, OAuth, Modbus or historical time-series database. Meter direction is never guessed.

At this historical verification, the directory was not yet a Git repository and was not published to npm/GitHub. Later private GitHub source publication was a separate request. The user's running Homebridge installation was not modified.
