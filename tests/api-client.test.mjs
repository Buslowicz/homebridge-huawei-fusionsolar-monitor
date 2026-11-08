import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { FusionSolarClient, ApiError } from '../dist/api-client.js';

const cert = await readFile(new URL('./fixtures/localhost-cert.pem', import.meta.url));
const key = await readFile(new URL('./fixtures/localhost-key.pem', import.meta.url));
const success = data => ({ success: true, failCode: 0, data });
const failure = failCode => ({ success: false, failCode, message: 'SECRET server body username password', params: { personal: 'SECRET' } });
const plantPage = (list = [], pageNo = 1, pageCount = 1) => ({ list, pageNo, pageCount, pageSize: 100, total: list.length * pageCount });
const device = overrides => ({ id: '1', stationCode: 'P', devName: 'Inverter', devTypeId: 38, esnCode: null, model: null, softwareVersion: null, ...overrides });
const kpi = (dataItemMap = {}, overrides = {}) => ({ stationCode: 'P', dataItemMap, ...overrides });
const errorKind = (kind, check = () => true) => error => error instanceof ApiError && error.kind === kind && check(error);

async function fixture(t, handler = () => ({ data: [] }), options = {}) {
  const calls = [];
  const sockets = new Set();
  const server = createServer({ key, cert }, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const call = { path: request.url, method: request.method, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
    calls.push(call);
    const result = await handler(call, calls);
    if (result?.hang) return;
    const value = result ?? {};
    const headers = { 'content-type': 'application/json', ...(call.path === '/thirdData/login' ? { 'XsRf-ToKeN': 'fixture-token' } : {}), ...value.headers };
    response.writeHead(value.status ?? 200, headers);
    if (value.chunks) { for (const part of value.chunks) response.write(part); response.end(); }
    else response.end(value.raw ?? JSON.stringify(value.envelope ?? success(Object.hasOwn(value, 'data') ? value.data : [])));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let now = 1_800_000_000_000;
  const { port } = server.address();
  const transport = (url, requestOptions, callback) => {
    assert.equal(url.hostname, 'eu5.fusionsolar.huawei.com');
    assert.equal(url.protocol, 'https:');
    assert.equal(requestOptions.rejectUnauthorized, true);
    return httpsRequest(new URL(`https://localhost:${port}${url.pathname}`), { ...requestOptions, ca: cert, agent: false, family: 4 }, callback);
  };
  const client = new FusionSolarClient({ baseUrl: 'https://eu5.fusionsolar.huawei.com/thirdData/', username: 'fixture-user', password: ' secret password ', ...options }, { now: () => now, request: transport });
  t.after(async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { client, calls, advance: milliseconds => { now += milliseconds; }, get now() { return now; }, transport };
}

test('only strict Huawei HTTPS base URLs and bounded options are accepted', () => {
  for (const baseUrl of ['http://eu5.fusionsolar.huawei.com', 'https://localhost', 'https://fusionsolar.huawei.com', 'https://evilfusionsolar.huawei.com', 'https://eu5.fusionsolar.huawei.com.evil.test', 'https://eu5.fusionsolar.huawei.com:8443', 'https://user:pass@eu5.fusionsolar.huawei.com', 'https://eu5.fusionsolar.huawei.com/control', 'https://eu5.fusionsolar.huawei.com/?secret=1', 'https://eu5.fusionsolar.huawei.com/#fragment']) {
    assert.throws(() => new FusionSolarClient({ baseUrl, username: 'u', password: 'p' }), errorKind('invalid-response'));
  }
  for (const timeoutMs of [0, -1, 120001, Infinity, NaN]) assert.throws(() => new FusionSolarClient({ baseUrl: 'https://eu5.fusionsolar.huawei.com', username: 'u', password: 'p', timeoutMs }), errorKind('invalid-response'));
});

test('session login is singleflight, reused, then renewed after 30 minutes', async t => {
  const f = await fixture(t);
  await Promise.all([f.client.listDevices(['P']), f.client.plantKpis(['P']), f.client.activeAlarms(['P'])]);
  assert.equal(f.calls.filter(call => call.path.endsWith('/login')).length, 1);
  assert.deepEqual(f.calls[0].body, { userName: 'fixture-user', systemCode: ' secret password ' });
  for (const call of f.calls.slice(1)) assert.equal(call.headers['xsrf-token'], 'fixture-token');
  f.advance(30 * 60_000 - 1); await f.client.listDevices(['P']);
  assert.equal(f.calls.filter(call => call.path.endsWith('/login')).length, 1);
  f.advance(1); await f.client.plantKpis(['P']);
  assert.equal(f.calls.filter(call => call.path.endsWith('/login')).length, 2);
});

test('read-only endpoint bodies, pagination, PII stripping, all scalar KPIs and active alarms', async t => {
  const f = await fixture(t, call => {
    if (call.path.endsWith('/stations')) return { data: plantPage([{ plantCode: `P${call.body.pageNo}`, plantName: `Plant ${call.body.pageNo}`, capacity: '5.4', address: 'PRIVATE', contact: 'PRIVATE' }], call.body.pageNo, 2) };
    if (call.path.endsWith('/getDevList')) return { data: [device({ stationCode: 'P1' })] };
    if (call.path.endsWith('/getStationRealKpi')) return { data: [kpi({ power: '12.50', connected: true, status: 'RUNNING', absent: 'N/A', blank: null }, { stationCode: 'P1' })] };
    if (call.path.endsWith('/getDevRealKpi')) return { data: [{ devId: '1', sn: null, dataItemMap: { temperature: -7.3 } }] };
    if (call.path.endsWith('/getAlarmList')) return { data: [{ stationCode: 'P1', esnCode: null, alarmName: 'Grid alarm', alarmId: 2032, lev: 2, raiseTime: 1, alarmCause: null, repairSuggestion: null }] };
    return {};
  });
  assert.deepEqual(await f.client.listPlants(), [{ code: 'P1', name: 'Plant 1', capacityKwP: 5.4 }, { code: 'P2', name: 'Plant 2', capacityKwP: 5.4 }]);
  assert.deepEqual(await f.client.listDevices(['P1']), [{ id: '1', stationCode: 'P1', name: 'Inverter', typeId: 38, serial: '', model: '', softwareVersion: '' }]);
  assert.deepEqual(await f.client.plantKpis(['P1']), [{ id: 'P1', values: { power: 12.5, connected: true, status: 'RUNNING', absent: null, blank: null } }]);
  assert.deepEqual(await f.client.deviceKpis(38, ['1']), [{ id: '1', values: { temperature: -7.3 } }]);
  assert.deepEqual(await f.client.activeAlarms(['P1']), [{ stationCode: 'P1', serial: '', name: 'Grid alarm', id: 2032, severity: 2, raisedAt: 1, cause: '', suggestion: '' }]);
  assert.deepEqual(f.calls.map(call => call.path), ['/thirdData/login', '/thirdData/stations', '/thirdData/stations', '/thirdData/getDevList', '/thirdData/getStationRealKpi', '/thirdData/getDevRealKpi', '/thirdData/getAlarmList']);
  assert.deepEqual(f.calls.slice(1).map(call => call.body), [{ pageNo: 1 }, { pageNo: 2 }, { stationCodes: 'P1' }, { stationCodes: 'P1' }, { devTypeId: 38, devIds: '1' }, { stationCodes: 'P1', beginTime: 0, endTime: f.now, language: 'pl_PL' }]);
  assert.ok(f.calls.every(call => call.method === 'POST'));
  f.client.close(); assert.equal(f.calls.length, 7, 'close never logs out or invalidates shared session');
});

test('Huawei signed Long literal device IDs retain every digit, strings remain untouched', async t => {
  const rawDevices = '{"success":true,"failCode":0,"data":[{"id":9223372036854775807,"stationCode":"P","devName":"text 9223372036854775807 \\\" escaped","devTypeId":38},{"id":-9223372036854775808,"stationCode":"P","devName":"negative","devTypeId":17}]}';
  const f = await fixture(t, call => call.path.endsWith('/getDevList') ? { raw: rawDevices } : call.path.endsWith('/getDevRealKpi') ? { raw: '{"success":true,"failCode":0,"data":[{"devId":-9223372036854775808,"sn":null,"dataItemMap":{"power":0.001}}]}' } : {});
  const devices = await f.client.listDevices(['P']);
  assert.deepEqual(devices.map(item => item.id), ['9223372036854775807', '-9223372036854775808']);
  assert.equal(devices[0].name, 'text 9223372036854775807 " escaped');
  assert.deepEqual(await f.client.deviceKpis(17, ['-9223372036854775808']), [{ id: '-9223372036854775808', values: { power: 0.001 } }]);
  assert.deepEqual(f.calls.at(-1).body, { devTypeId: 17, devIds: '-9223372036854775808' });
});

test('305 renews once and reserves failed endpoint quota; API401 is permission without login retry', async t => {
  let responseCode = 0;
  const f = await fixture(t, call => call.path.endsWith('/getStationRealKpi') && responseCode ? { envelope: failure(responseCode) } : {});
  await f.client.plantKpis(['P']); f.advance(5 * 60_000); responseCode = 305;
  await assert.rejects(f.client.plantKpis(['P']), errorKind('rate-limit', error => error.retryAfterMs === 300_000));
  assert.equal(f.calls.filter(call => call.path.endsWith('/login')).length, 2);
  assert.equal(f.calls.filter(call => call.path.endsWith('/getStationRealKpi')).length, 2);
  await assert.rejects(f.client.plantKpis(['P']), errorKind('rate-limit'));
  assert.equal(f.calls.length, 4);
  f.advance(300_000); responseCode = 401;
  await assert.rejects(f.client.plantKpis(['P']), errorKind('permission', error => error.code === 401));
  assert.equal(f.calls.filter(call => call.path.endsWith('/login')).length, 2);
});

test('failed credentials have 30 minute cooldown and errors never contain server or credential content', async t => {
  const f = await fixture(t, () => ({ envelope: failure(20400) }));
  await assert.rejects(f.client.plantKpis(['P']), errorKind('authentication', error => !JSON.stringify(error).includes('SECRET') && !error.message.includes('fixture')));
  await assert.rejects(f.client.plantKpis(['P']), errorKind('rate-limit', error => error.retryAfterMs === 1_800_000));
  assert.equal(f.calls.length, 1);
  f.advance(1_800_000); await assert.rejects(f.client.plantKpis(['P']), errorKind('authentication'));
  assert.equal(f.calls.length, 2);
});

test('network login failures have at least 120 second login cooldown', async t => {
  const f = await fixture(t, () => ({ raw: 'invalid json SECRET' }));
  await assert.rejects(f.client.plantKpis(['P']), errorKind('invalid-response'));
  await assert.rejects(f.client.plantKpis(['P']), errorKind('rate-limit', error => error.retryAfterMs === 120_000));
  assert.equal(f.calls.length, 1);
  f.advance(120_000); await assert.rejects(f.client.plantKpis(['P']), errorKind('invalid-response'));
  assert.equal(f.calls.length, 2);
});

for (const failCode of [407, 429]) test(`envelope ${failCode} observes Retry-After and endpoint cooldown`, async t => {
  const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { envelope: failure(failCode), headers: { 'Retry-After': '600' } });
  await assert.rejects(f.client.plantKpis(['P']), errorKind('rate-limit', error => error.code === failCode && error.retryAfterMs === 600_000));
  await assert.rejects(f.client.plantKpis(['P']), errorKind('rate-limit', error => error.retryAfterMs === 600_000));
  assert.equal(f.calls.length, 2);
  f.advance(600_000); await assert.rejects(f.client.plantKpis(['P']), errorKind('rate-limit'));
  assert.equal(f.calls.length, 3);
});

test('alarm quota floor is 30 minutes and HTTP date Retry-After is respected', async t => {
  let date = '';
  const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { status: 429, headers: { 'Retry-After': date } });
  date = new Date(f.now + 10_000).toUTCString();
  await assert.rejects(f.client.activeAlarms(['P']), errorKind('rate-limit'));
  await assert.rejects(f.client.activeAlarms(['P']), errorKind('rate-limit', error => error.retryAfterMs === 1_800_000));
  assert.equal(f.calls.length, 2);
});

for (const [status, kind] of [[401, 'rate-limit'], [403, 'permission'], [429, 'rate-limit'], [302, 'invalid-response'], [500, 'network']]) test(`HTTP ${status} is classified safely without redirect or retry`, async t => {
  const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { status, headers: { location: 'https://evil.invalid/SECRET' }, raw: 'SECRET' });
  await assert.rejects(f.client.plantKpis(['P']), errorKind(kind, error => error.code === status && !error.message.includes('SECRET')));
  assert.equal(f.calls.length, 2);
});

test('explicit null query data is unavailable for every collection', async t => {
  const f = await fixture(t, () => ({ envelope: { success: true, failCode: 0, data: null } }));
  await assert.rejects(f.client.listPlants(), errorKind('invalid-response'));
  await assert.rejects(f.client.listDevices(['P']), errorKind('invalid-response'));
  await assert.rejects(f.client.plantKpis(['P']), errorKind('invalid-response'));
  await assert.rejects(f.client.deviceKpis(1, ['1']), errorKind('invalid-response'));
  await assert.rejects(f.client.activeAlarms(['P']), errorKind('invalid-response'));
});

for (const raw of ['{}', '{"success":"true","failCode":0}', '{"success":true,"failCode":401}', '{"success":false,"failCode":0}', '{"success":true,"failCode":0,"data":{9223372036854775807:1}}', '{"success":true,"failCode":0,"data": [01]}']) test(`malformed envelope or JSON is rejected: ${raw}`, async t => {
  const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { raw });
  await assert.rejects(f.client.plantKpis(['P']), errorKind('invalid-response'));
});

for (const dataItemMap of [{ nested: {} }, { nested: [] }, { value: '9007199254740993' }, { value: 1e300 }, { value: '1e500' }, { ['x'.repeat(161)]: 1 }, Object.fromEntries(Array.from({ length: 513 }, (_, i) => [String(i), 1]))]) test('invalid, oversized or unsafe KPI map is rejected', async t => {
  const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { data: [kpi(dataItemMap)] });
  await assert.rejects(f.client.plantKpis(['P']), errorKind('invalid-response'));
});

test('unsafe numeric JSON KPI literal is rejected rather than rounded', async t => {
  const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { raw: '{"success":true,"failCode":0,"data":[{"stationCode":"P","dataItemMap":{"x":9007199254740993}}]}' });
  await assert.rejects(f.client.plantKpis(['P']), errorKind('invalid-response'));
});

test('foreign records, malformed devices, IDs and duplicate records are rejected', async t => {
  for (const item of [device({ stationCode: 'FOREIGN' }), device({ id: '9223372036854775808' }), device({ id: 1.2 }), device({ devName: '' }), device({ devTypeId: '38' })]) {
    const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { data: [item] });
    await assert.rejects(f.client.listDevices(['P']), errorKind('invalid-response'));
  }
  const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { data: [kpi({}, { stationCode: 'FOREIGN', devId: '2' })] });
  await assert.rejects(f.client.plantKpis(['P']), errorKind('invalid-response'));
  await assert.rejects(f.client.deviceKpis(1, ['1']), errorKind('invalid-response'));
  const d = await fixture(t, call => call.path.endsWith('/login') ? {} : { data: [kpi(), kpi()] });
  await assert.rejects(d.client.plantKpis(['P']), errorKind('invalid-response'));
});

test('input validation prevents empty, oversized, delimiter, control and unsupported device requests', async t => {
  const f = await fixture(t);
  for (const values of [[], ['P,P2'], ['P\n'], Array(101).fill('P'), ['P', 'P']]) await assert.rejects(f.client.plantKpis(values), errorKind('invalid-response'));
  await assert.rejects(f.client.deviceKpis(999, ['1']), errorKind('invalid-response'));
  await assert.rejects(f.client.deviceKpis(1, ['1.3']), errorKind('invalid-response'));
  assert.equal(f.calls.length, 0);
});

test('pagination refuses truncation above max10 and malformed page sequence', async t => {
  for (const data of [plantPage([], 1, 11), plantPage([], 2, 2), plantPage([{ plantCode: 'P', plantName: 'Plant' }], 1, 0)]) {
    const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { data });
    await assert.rejects(f.client.listPlants(), errorKind('invalid-response'));
  }
});

test('response size is bounded by declared length and streaming bytes', async t => {
  for (const response of [{ headers: { 'content-length': String(4 * 1024 * 1024 + 1) }, raw: '{}' }, { chunks: [' '.repeat(2 * 1024 * 1024), ' '.repeat(2 * 1024 * 1024 + 1)] }]) {
    const f = await fixture(t, call => call.path.endsWith('/login') ? {} : response);
    await assert.rejects(f.client.plantKpis(['P']), errorKind('invalid-response'));
  }
});

test('hard request deadline and close abort pending HTTPS requests', async t => {
  const f = await fixture(t, () => ({ hang: true }), { timeoutMs: 40 });
  await assert.rejects(f.client.plantKpis(['P']), errorKind('network'));
  const g = await fixture(t, () => ({ hang: true }));
  const pending = g.client.plantKpis(['P']);
  while (g.calls.length === 0) await new Promise(resolve => setImmediate(resolve));
  g.client.close(); await assert.rejects(pending, errorKind('closed'));
  await assert.rejects(g.client.plantKpis(['P']), errorKind('closed'));
  assert.equal(g.calls.length, 1);
});

test('untrusted TLS certificate is rejected with generic network error', async t => {
  // A second HTTPS server is deliberately not in Node's public trust store.
  const server = createServer({ key, cert }, (_request, response) => response.end('{}'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const client = new FusionSolarClient({ baseUrl: 'https://eu5.fusionsolar.huawei.com', username: 'u', password: 'p' }, {
    request: (url, options, callback) => httpsRequest(new URL(`https://localhost:${port}${url.pathname}`), { ...options, family: 4, agent: false }, callback),
  });
  t.after(() => client.close());
  await assert.rejects(client.plantKpis(['P']), errorKind('network', error => !error.message.includes('certificate')));
});


test('pagination rejects inconsistent pages, missing later data and incomplete totals', async t => {
  for (const second of [plantPage([], 2, 1), null, { ...plantPage([], 2, 2), total: 2 }]) {
    const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { data: call.body.pageNo === 1 ? plantPage([], 1, 2) : second });
    await assert.rejects(f.client.listPlants(), errorKind('invalid-response'));
  }
  const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { data: { ...plantPage([], 1, 1), total: 1 } });
  await assert.rejects(f.client.listPlants(), errorKind('invalid-response'));
});

test('login API permission errors do not masquerade as bad credentials', async t => {
  const f = await fixture(t, () => ({ envelope: failure(401) }));
  await assert.rejects(f.client.plantKpis(['P']), errorKind('permission', error => error.code === 401));
  await assert.rejects(f.client.plantKpis(['P']), errorKind('rate-limit', error => error.retryAfterMs === 120_000));
  assert.equal(f.calls.length, 1);
});

test('login flow control honors server cooldown and missing token is rejected', async t => {
  const limited = await fixture(t, () => ({ envelope: failure(407), headers: { 'Retry-After': '1000' } }));
  await assert.rejects(limited.client.plantKpis(['P']), errorKind('rate-limit', error => error.retryAfterMs === 1_000_000));
  await assert.rejects(limited.client.plantKpis(['P']), errorKind('rate-limit', error => error.retryAfterMs === 1_000_000));
  assert.equal(limited.calls.length, 1);
  const missingToken = await fixture(t, () => ({ headers: { 'XsRf-ToKeN': '' } }));
  await assert.rejects(missingToken.client.plantKpis(['P']), errorKind('invalid-response'));
  assert.equal(missingToken.calls.length, 1);
});


test('missing success data never falsely reports an empty alarm list', async t => {
  const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { envelope: { success: true, failCode: 0 } });
  await assert.rejects(f.client.activeAlarms(['P']), errorKind('invalid-response'));
});

test('each endpoint attempt reserves quota, including success, permission, invalid response and network failure', async t => {
  for (const result of [{ data: [] }, { status: 403 }, { raw: 'bad JSON' }, { status: 500 }]) {
    const f = await fixture(t, call => call.path.endsWith('/login') ? {} : result);
    try { await f.client.plantKpis(['P']); } catch (error) { assert.ok(error instanceof ApiError); }
    await assert.rejects(f.client.plantKpis(['P']), errorKind('rate-limit', error => error.retryAfterMs === 300_000));
    assert.equal(f.calls.length, 2);
  }
});

test('HTTP401 invalidates the session, renews once and never repeats the endpoint inside quota', async t => {
  let status = 200;
  const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { status });
  await f.client.plantKpis(['P']); f.advance(300_000); status = 401;
  await assert.rejects(f.client.plantKpis(['P']), errorKind('rate-limit', error => error.code === 401 && error.retryAfterMs === 300_000));
  assert.equal(f.calls.filter(call => call.path.endsWith('/login')).length, 2);
  assert.equal(f.calls.filter(call => call.path.endsWith('/getStationRealKpi')).length, 2);
  f.advance(300_000); status = 200; await f.client.plantKpis(['P']);
  assert.equal(f.calls.filter(call => call.path.endsWith('/login')).length, 2);
});

test('unknown alarm levels and out-of-range JavaScript dates are rejected', async t => {
  for (const overrides of [{ lev: 0 }, { lev: 5 }, { raiseTime: 8_640_000_000_000_001 }]) {
    const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { data: [{ stationCode: 'P', alarmName: 'Alarm', alarmId: 1, lev: 1, raiseTime: 1, ...overrides }] });
    await assert.rejects(f.client.activeAlarms(['P']), errorKind('invalid-response'));
  }
});

test('station pages reject non-array lists and more than100 plants', async t => {
  for (const data of [{ ...plantPage(), list: null }, plantPage(Array.from({ length: 101 }, (_, i) => ({ plantCode: String(i), plantName: 'Plant' })))]) {
    const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { data });
    await assert.rejects(f.client.listPlants(), errorKind('invalid-response'));
  }
});


test('Retry-After longer than one day is not shortened', async t => {
  const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { status: 429, headers: { 'Retry-After': '172800' } });
  await assert.rejects(f.client.plantKpis(['P']), errorKind('rate-limit', error => error.retryAfterMs === 172_800_000));
  f.advance(86_400_000);
  await assert.rejects(f.client.plantKpis(['P']), errorKind('rate-limit', error => error.retryAfterMs === 86_400_000));
  assert.equal(f.calls.length, 2);
});

test('simultaneous calls to the same endpoint cannot burst quota', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.client.plantKpis(['P']), f.client.plantKpis(['P'])]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected && errorKind('rate-limit')(rejected.reason));
  assert.equal(f.calls.filter(call => call.path.endsWith('/login')).length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/getStationRealKpi')).length, 1);
});


test('empty alarm array is a valid zero-alarms response and null remains unavailable', async t => {
  let data = [];
  const f = await fixture(t, call => call.path.endsWith('/login') ? {} : { data });
  assert.deepEqual(await f.client.activeAlarms(['P']), []);
  f.advance(30 * 60_000); data = null;
  await assert.rejects(f.client.activeAlarms(['P']), errorKind('invalid-response'));
});

test('discovery retries reuse validated pages for24h and resume only the failed page', async t => {
  let failing = true;
  const f = await fixture(t, call => {
    if (call.path.endsWith('/login')) return {};
    if (call.body.pageNo === 2 && failing) return { status: 500 };
    return { data: plantPage([{ plantCode: `P${call.body.pageNo}`, plantName: `Plant${call.body.pageNo}` }], call.body.pageNo, 3) };
  });
  await assert.rejects(f.client.listPlants(), errorKind('network'));
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('/stations')).map(call => call.body.pageNo), [1, 2]);
  f.advance(60 * 60_000); failing = false;
  assert.deepEqual((await f.client.listPlants()).map(plant => plant.code), ['P1', 'P2', 'P3']);
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('/stations')).map(call => call.body.pageNo), [1, 2, 2, 3]);
  const requests = f.calls.length;
  assert.deepEqual((await f.client.listPlants()).map(plant => plant.code), ['P1', 'P2', 'P3']);
  assert.equal(f.calls.length, requests);
  f.advance(23 * 60 * 60_000);
  assert.deepEqual((await f.client.listPlants()).map(plant => plant.code), ['P1', 'P2', 'P3']);
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('/stations')).map(call => call.body.pageNo), [1, 2, 2, 3, 1]);
  f.advance(60 * 60_000);
  assert.deepEqual((await f.client.listPlants()).map(plant => plant.code), ['P1', 'P2', 'P3']);
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('/stations')).map(call => call.body.pageNo), [1, 2, 2, 3, 1, 2, 3]);
});

test('malformed discovery pages are not cached, while earlier validated pages survive retry', async t => {
  let malformed = true;
  const f = await fixture(t, call => {
    if (call.path.endsWith('/login')) return {};
    if (call.body.pageNo === 2 && malformed) return { data: plantPage([{ plantCode: 'P2', plantName: null }], 2, 2) };
    return { data: plantPage([{ plantCode: `P${call.body.pageNo}`, plantName: 'Plant' }], call.body.pageNo, 2) };
  });
  await assert.rejects(f.client.listPlants(), errorKind('invalid-response'));
  f.advance(60 * 60_000); malformed = false;
  assert.equal((await f.client.listPlants()).length, 2);
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('/stations')).map(call => call.body.pageNo), [1, 2, 2]);
});

test('inconsistent discovery metadata invalidates partial cache for the next retry', async t => {
  let changed = false;
  const f = await fixture(t, call => {
    if (call.path.endsWith('/login')) return {};
    const count = changed || call.body.pageNo === 2 ? 3 : 2;
    return { data: plantPage([{ plantCode: `P${call.body.pageNo}`, plantName: 'Plant' }], call.body.pageNo, count) };
  });
  await assert.rejects(f.client.listPlants(), errorKind('invalid-response'));
  f.advance(60 * 60_000); changed = true;
  assert.equal((await f.client.listPlants()).length, 3);
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('/stations')).map(call => call.body.pageNo), [1, 2, 1, 2, 3]);
});
