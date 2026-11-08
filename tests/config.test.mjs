import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../dist/config.js';

const config = options => parseConfig({ demo: true, ...options }, {});
test('power services default on with no assumed meter direction or ID', () => {
  const parsed = config();
  assert.equal(parsed.powerMeters, true);
  assert.equal(parsed.gridPowerDirection, 'unconfigured');
  assert.equal(parsed.gridMeterId, undefined);
});
test('explicit power settings preserve exact decimal IDs', () => {
  for (const gridPowerDirection of ['unconfigured', 'positiveImport', 'positiveExport']) {
    for (const gridMeterId of ['0', '-1002', '9223372036854775807', '1'.repeat(128)]) {
      const parsed = config({ powerMeters: false, gridPowerDirection, gridMeterId });
      assert.equal(parsed.powerMeters, false);
      assert.equal(parsed.gridPowerDirection, gridPowerDirection);
      assert.equal(parsed.gridMeterId, gridMeterId);
    }
  }
});
test('power settings reject invalid types, unknown directions and inexact meter IDs', () => {
  for (const powerMeters of [null, 0, 1, 'true', {}]) assert.throws(() => config({ powerMeters }), /powerMeters/);
  for (const gridPowerDirection of [null, '', true, 1, {}, 'import', 'positiveimport']) assert.throws(() => config({ gridPowerDirection }), /gridPowerDirection/);
  for (const gridMeterId of [null, 1002, {}, '', ' ', ' 1002', '1002 ', '+1002', '01', '1.0', '1e3', '1\n', '1'.repeat(129)]) assert.throws(() => config({ gridMeterId }), /gridMeterId/);
});

test('detailed diagnostic telemetry defaults off and accepts explicit booleans', () => {
  assert.equal(config().advancedTelemetry, false);
  for (const advancedTelemetry of [false, true]) {
    assert.equal(config({ advancedTelemetry }).advancedTelemetry, advancedTelemetry);
  }
});
test('detailed diagnostic telemetry rejects null and nonboolean values', () => {
  for (const advancedTelemetry of [null, 0, 1, '', 'true', 'false', {}, []]) {
    assert.throws(() => config({ advancedTelemetry }), /advancedTelemetry must be true or false/);
  }
});
