import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { SUPPORTED_DEVICE_TYPES } from './contracts.js';
import type { Alarm, Device, FusionSolarApi, KpiRecord, MetricMap, MetricValue, Plant } from './contracts.js';

export type ApiErrorKind = 'authentication' | 'permission' | 'rate-limit' | 'network' | 'invalid-response' | 'closed';
const MESSAGES: Record<ApiErrorKind, string> = {
  authentication: 'FusionSolar authentication is unavailable.', permission: 'FusionSolar API permission is unavailable.',
  'rate-limit': 'FusionSolar API requests are temporarily limited.', network: 'FusionSolar could not be reached securely.',
  'invalid-response': 'FusionSolar returned an invalid response.', closed: 'FusionSolar client is closed.',
};
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly code?: number;
  readonly retryAfterMs?: number;
  constructor(kind: ApiErrorKind, code?: number, retryAfterMs?: number) {
    super(MESSAGES[kind]); this.name = 'ApiError'; this.kind = kind;
    if (code !== undefined) this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}
export interface ClientOptions {
  readonly baseUrl: string; readonly username: string; readonly password: string; readonly timeoutMs?: number;
}
/** Tests may supply a trusted HTTPS fixture transport; URL validation is always enforced. */
export interface ClientDependencies { readonly now?: () => number; readonly request?: typeof httpsRequest }
type QueryEndpoint = 'stations' | 'getDevList' | 'getStationRealKpi' | 'getDevRealKpi' | 'getAlarmList';
type Endpoint = QueryEndpoint | 'login';
interface Response { readonly body: unknown; readonly headers: IncomingHttpHeaders }
interface Envelope { readonly success: boolean; readonly failCode: number; readonly data: unknown }
interface PlantPage {
  readonly plants: readonly Plant[];
  readonly pageCount: number;
  readonly total: number | undefined;
  readonly validatedAt: number;
}
const MINUTE = 60_000;
const MAX_BODY = 4 * 1024 * 1024;
const LONG_MIN = -9223372036854775808n;
const LONG_MAX = 9223372036854775807n;
function invalid(): never { throw new ApiError('invalid-response'); }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256, empty = false): string {
  if (typeof value !== 'string' || value.length > max || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) invalid();
  const result = value.trim();
  if (!empty && result.length === 0) invalid();
  return result;
}
function optionalText(value: unknown, max = 256): string { return value === null || value === undefined ? '' : text(value, max, true); }
function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) invalid();
  return value;
}
function code(value: unknown): string {
  const result = text(value);
  if (result.includes(',')) invalid();
  return result;
}
function id(value: unknown): string {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value, 21);
  if (!/^-?(?:0|[1-9]\d*)$/u.test(result)) invalid();
  const number = BigInt(result);
  if (number < LONG_MIN || number > LONG_MAX) invalid();
  return String(number);
}
function inputs(values: readonly string[], isId = false): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) invalid();
  const parsed = values.map(value => isId ? id(value) : code(value));
  if (new Set(parsed).size !== parsed.length) invalid();
  return parsed;
}
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) invalid();
  return value;
}
function metrics(value: unknown): MetricMap {
  const entries = Object.entries(object(value));
  if (entries.length > 512) invalid();
  return Object.fromEntries(entries.map(([key, raw]): [string, MetricValue] => {
    text(key, 160);
    if (raw === null || typeof raw === 'boolean') return [key, raw];
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw) || (Number.isInteger(raw) && !Number.isSafeInteger(raw))) invalid();
      return [key, raw];
    }
    if (typeof raw !== 'string') invalid();
    const value = text(raw, 512, true);
    if (value === '' || /^(?:n\/?a|nan|null|undefined|--|-)$/iu.test(value)) return [key, null];
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)) {
      const number = Number(value);
      if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) invalid();
      return [key, number];
    }
    return [key, value];
  }));
}
/** Preserve unsafe JSON integer literals without changing digits or escapes inside strings. */
function parseJson(source: string): unknown {
  // Validate original grammar first: quoting Long values must never repair invalid JSON.
  try { JSON.parse(source) as unknown; } catch { return invalid(); }
  let output = '';
  let position = 0;
  while (position < source.length) {
    const start = position;
    const char = source[position];
    if (char === '"') {
      position++;
      while (position < source.length) {
        if (source[position] === '\\') { position += 2; continue; }
        if (source[position++] === '"') break;
      }
      output += source.slice(start, position);
    } else if (char !== undefined && /[-0-9]/u.test(char)) {
      while (position < source.length && /[-+0-9.eE]/u.test(source[position] ?? '')) position++;
      const token = source.slice(start, position);
      output += /^-?(?:0|[1-9]\d*)$/u.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token;
    } else { output += char; position++; }
  }
  try { return JSON.parse(output) as unknown; } catch { return invalid(); }
}
function envelope(value: unknown): Envelope {
  const result = object(value);
  if (typeof result.success !== 'boolean') invalid();
  const failCode = integer(result.failCode);
  if (result.success !== (failCode === 0) || (result.success && !Object.hasOwn(result, 'data'))) invalid();
  return { success: result.success, failCode, data: result.data };
}
function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]; return typeof value === 'string' ? value : undefined;
}

export class FusionSolarClient implements FusionSolarApi {
  private readonly baseUrl: URL;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly request: typeof httpsRequest;
  private token: string | undefined;
  private tokenUntil = 0;
  private loginAfter = 0;
  private loginPromise: Promise<void> | undefined;
  private closed = false;
  private readonly controllers = new Set<AbortController>();
  private readonly cooldowns = new Map<string, number>();
  private readonly plantPages = new Map<number, PlantPage>();

  constructor(options: ClientOptions, dependencies: ClientDependencies = {}) {
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw new ApiError('invalid-response'); }
    if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)+fusionsolar\.huawei\.com$/u.test(url.hostname)
      || url.port !== '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
      || !['/', '/thirdData', '/thirdData/'].includes(url.pathname)) invalid();
    url.pathname = '/thirdData/'; this.baseUrl = url;
    this.username = text(options.username, 256); text(options.password, 1024); this.password = options.password;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) invalid();
    this.now = dependencies.now ?? Date.now; this.request = dependencies.request ?? httpsRequest;
  }

  async listPlants(): Promise<readonly Plant[]> {
    this.assertOpen();
    for (const [pageNo, page] of this.plantPages) {
      if (this.now() - page.validatedAt >= 24 * 60 * MINUTE || this.now() < page.validatedAt) this.plantPages.delete(pageNo);
    }
    const plants: Plant[] = [];
    const seen = new Set<string>();
    let pageCount = 1;
    let expectedPages: number | undefined;
    let expectedTotal: number | undefined;
    for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
      // Successful pages consume daily quota even if a later page fails. Reuse each validated page for 24 hours.
      const page = this.plantPages.get(pageNo) ?? await this.fetchPlantPage(pageNo);
      if (expectedPages !== undefined && page.pageCount !== expectedPages) this.invalidatePlantPages();
      expectedPages = page.pageCount;
      pageCount = page.pageCount;
      if (page.total !== undefined) {
        if (expectedTotal !== undefined && page.total !== expectedTotal) this.invalidatePlantPages();
        expectedTotal = page.total;
      }
      for (const plant of page.plants) {
        if (seen.has(plant.code)) this.invalidatePlantPages();
        seen.add(plant.code);
        plants.push(plant);
      }
      this.plantPages.set(pageNo, page);
    }
    if (expectedTotal !== undefined && plants.length !== expectedTotal) this.invalidatePlantPages();
    return plants;
  }

  private async fetchPlantPage(pageNo: number): Promise<PlantPage> {
    const page = object(await this.query('stations', { pageNo }));
    const pageCount = integer(page.pageCount);
    if (pageCount > 10 || integer(page.pageNo, 1) !== pageNo || (pageCount !== 0 && pageCount < pageNo)) invalid();
    if (!Array.isArray(page.list) || page.list.length > 100 || (pageCount === 0 && page.list.length !== 0)) invalid();
    if (page.pageSize !== undefined && integer(page.pageSize, 1) > 100) invalid();
    const total = page.total === undefined ? undefined : integer(page.total);
    if (total !== undefined && (total < page.list.length || total > pageCount * 100)) invalid();
    const seen = new Set<string>();
    const plants = list(page.list).map((raw): Plant => {
      const item = object(raw);
      const plantCode = code(item.plantCode);
      if (seen.has(plantCode)) invalid();
      seen.add(plantCode);
      const plant: Plant = { code: plantCode, name: text(item.plantName) };
      if (item.capacity !== null && item.capacity !== undefined) {
        const capacity = metrics({ capacity: item.capacity }).capacity;
        if (typeof capacity !== 'number' || capacity < 0) invalid();
        return Object.freeze({ ...plant, capacityKwP: capacity });
      }
      return Object.freeze(plant);
    });
    return { plants: Object.freeze(plants), pageCount, total, validatedAt: this.now() };
  }

  private invalidatePlantPages(): never {
    this.plantPages.clear();
    return invalid();
  }

  async listDevices(stationCodes: readonly string[]): Promise<readonly Device[]> {
    const requested = inputs(stationCodes);
    const data = await this.query('getDevList', { stationCodes: requested.join(',') });
    const seen = new Set<string>();
    return list(data).map(raw => {
      const item = object(raw); const stationCode = code(item.stationCode); const deviceId = id(item.id);
      if (!requested.includes(stationCode) || seen.has(deviceId)) invalid(); seen.add(deviceId);
      return { id: deviceId, stationCode, name: text(item.devName), typeId: integer(item.devTypeId, 1),
        serial: optionalText(item.esnCode), model: optionalText(item.model), softwareVersion: optionalText(item.softwareVersion) };
    });
  }
  async plantKpis(stationCodes: readonly string[]): Promise<readonly KpiRecord[]> {
    const requested = inputs(stationCodes);
    return this.kpiRecords(await this.query('getStationRealKpi', { stationCodes: requested.join(',') }), requested, false);
  }
  async deviceKpis(typeId: number, ids: readonly string[]): Promise<readonly KpiRecord[]> {
    integer(typeId, 1); if (!SUPPORTED_DEVICE_TYPES.includes(typeId)) invalid();
    const requested = inputs(ids, true);
    return this.kpiRecords(await this.query('getDevRealKpi', { devTypeId: typeId, devIds: requested.join(',') }), requested, true);
  }
  async activeAlarms(stationCodes: readonly string[]): Promise<readonly Alarm[]> {
    const requested = inputs(stationCodes);
    const data = await this.query('getAlarmList', { stationCodes: requested.join(','), beginTime: 0, endTime: this.now(), language: 'en_US' });
    return list(data).map(raw => {
      const item = object(raw); const stationCode = code(item.stationCode); if (!requested.includes(stationCode)) invalid();
      const severity = integer(item.lev, 1);
      const raisedAt = integer(item.raiseTime);
      if (severity > 4 || raisedAt > 8_640_000_000_000_000) invalid();
      return { stationCode, serial: optionalText(item.esnCode), name: text(item.alarmName), id: integer(item.alarmId),
        severity, raisedAt, cause: optionalText(item.alarmCause, 4096), suggestion: optionalText(item.repairSuggestion, 4096) };
    });
  }
  close(): void {
    this.closed = true; this.token = undefined; this.plantPages.clear();
    for (const controller of this.controllers) controller.abort(); this.controllers.clear();
  }
  private kpiRecords(data: unknown, requested: readonly string[], device: boolean): readonly KpiRecord[] {
    const seen = new Set<string>();
    return list(data).map(raw => {
      const item = object(raw); const recordId = device ? id(item.devId) : code(item.stationCode);
      if (!requested.includes(recordId) || seen.has(recordId)) invalid(); seen.add(recordId);
      return { id: recordId, values: metrics(item.dataItemMap) };
    });
  }
  private async query(endpoint: QueryEndpoint, body: Record<string, unknown>): Promise<unknown> {
    this.assertOpen();
    const quotaKey = endpoint === 'getDevRealKpi' ? `${endpoint}:${String(body.devTypeId)}` : endpoint === 'stations' ? `${endpoint}:${String(body.pageNo)}` : endpoint;
    this.assertCooldown(quotaKey); await this.login(); this.assertCooldown(quotaKey);
    this.setCooldown(quotaKey, endpoint);
    let response: Response;
    try { response = await this.post(endpoint, body); } catch (error: unknown) {
      if (error instanceof ApiError && error.kind === 'authentication' && error.code === 401) return this.renewAfterExpiry(quotaKey, 401);
      if (error instanceof ApiError && error.kind === 'rate-limit') {
        const retry = Math.max(this.interval(endpoint), error.retryAfterMs ?? 0);
        this.setCooldown(quotaKey, endpoint, retry);
        throw new ApiError('rate-limit', error.code, retry);
      }
      throw error;
    }
    const result = envelope(response.body); if (result.success) return result.data;
    if (result.failCode === 305) {
      // Failed calls also consume quota. Renew once, then let the next scheduled poll retry.
      return this.renewAfterExpiry(quotaKey, 305);
    }
    if (result.failCode === 407 || result.failCode === 429) {
      const retry = this.retryAfter(response.headers); this.setCooldown(quotaKey, endpoint, retry);
      throw new ApiError('rate-limit', result.failCode, Math.max(this.interval(endpoint), retry));
    }
    if (result.failCode === 401) throw new ApiError('permission', result.failCode);
    throw new ApiError('invalid-response', result.failCode);
  }
  private async renewAfterExpiry(quotaKey: string, code: number): Promise<never> {
    this.token = undefined; this.tokenUntil = 0;
    try { await this.login(); } catch (error: unknown) {
      if (error instanceof ApiError && error.kind === 'rate-limit') {
        throw new ApiError('rate-limit', code, Math.max(error.retryAfterMs ?? 0, (this.cooldowns.get(quotaKey) ?? 0) - this.now()));
      }
      throw error;
    }
    throw new ApiError('rate-limit', code, Math.max(0, (this.cooldowns.get(quotaKey) ?? 0) - this.now()));
  }
  private async login(): Promise<void> {
    this.assertOpen(); if (this.token !== undefined && this.now() < this.tokenUntil) return;
    if (this.loginPromise !== undefined) return this.loginPromise;
    if (this.now() < this.loginAfter) throw new ApiError('rate-limit', undefined, this.loginAfter - this.now());
    this.loginAfter = this.now() + 2 * MINUTE; this.loginPromise = this.performLogin();
    try { await this.loginPromise; } finally { this.loginPromise = undefined; }
  }
  private async performLogin(): Promise<void> {
    try {
      const response = await this.post('login', { userName: this.username, systemCode: this.password }); const result = envelope(response.body);
      if (!result.success) {
        if (result.failCode === 401) throw new ApiError('permission', result.failCode);
        if (result.failCode === 407 || result.failCode === 429) {
          const retry = Math.max(5 * MINUTE, this.retryAfter(response.headers)); this.loginAfter = this.now() + retry;
          throw new ApiError('rate-limit', result.failCode, retry);
        }
        this.loginAfter = this.now() + 30 * MINUTE; throw new ApiError('authentication', result.failCode);
      }
      const token = header(response.headers, 'xsrf-token');
      if (token === undefined || token.length < 1 || token.length > 4096 || /[^\x21-\x7e]/u.test(token)) invalid();
      this.assertOpen(); this.token = token; this.tokenUntil = this.now() + 30 * MINUTE;
    } catch (error: unknown) {
      if (error instanceof ApiError && error.kind === 'authentication') this.loginAfter = this.now() + 30 * MINUTE;
      if (error instanceof ApiError && error.kind === 'rate-limit') this.loginAfter = this.now() + Math.max(5 * MINUTE, error.retryAfterMs ?? 0);
      throw error;
    }
  }
  private interval(endpoint: Endpoint): number { return endpoint === 'getAlarmList' ? 30 * MINUTE : 5 * MINUTE; }
  private assertOpen(): void { if (this.closed) throw new ApiError('closed'); }
  private assertCooldown(key: string): void {
    const remaining = (this.cooldowns.get(key) ?? 0) - this.now(); if (remaining > 0) throw new ApiError('rate-limit', undefined, remaining);
  }
  private setCooldown(key: string, endpoint: Endpoint, retry = 0): void { this.cooldowns.set(key, this.now() + Math.max(this.interval(endpoint), retry)); }
  private retryAfter(headers: IncomingHttpHeaders): number {
    const value = header(headers, 'retry-after'); if (value === undefined) return 0;
    const seconds = Number(value); const duration = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - this.now();
    return Number.isFinite(duration) ? Math.max(0, Math.min(duration, Number.MAX_SAFE_INTEGER - this.now())) : 0;
  }
  private async post(endpoint: Endpoint, body: Record<string, unknown>): Promise<Response> {
    this.assertOpen(); const controller = new AbortController(); this.controllers.add(controller); const payload = JSON.stringify(body);
    try {
      return await new Promise<Response>((resolve, reject: (error: ApiError) => void) => {
        let settled = false;
        const finish = (error?: ApiError, response?: Response): void => {
          if (settled) return; settled = true; clearTimeout(timer);
          if (error !== undefined) reject(error); else if (response !== undefined) resolve(response);
        };
        const timer = setTimeout(() => { finish(new ApiError('network')); controller.abort(); }, this.timeoutMs);
        try {
          const request = this.request(new URL(endpoint, this.baseUrl), {
            method: 'POST', signal: controller.signal, rejectUnauthorized: true, maxHeaderSize: 16 * 1024,
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), accept: 'application/json',
              ...(endpoint !== 'login' && this.token !== undefined ? { 'XSRF-TOKEN': this.token } : {}) },
          }, response => {
            const status = response.statusCode ?? 0;
            if (status !== 200) {
              const kind: ApiErrorKind = status === 401 ? 'authentication' : status === 403 ? 'permission' : status === 429 || status === 407 ? 'rate-limit' : status >= 300 && status < 400 ? 'invalid-response' : 'network';
              finish(new ApiError(kind, status, kind === 'rate-limit' ? this.retryAfter(response.headers) : undefined)); response.destroy(); return;
            }
            const declaredLength = Number(header(response.headers, 'content-length'));
            if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY) { finish(new ApiError('invalid-response')); response.destroy(); return; }
            const chunks: Buffer[] = []; let length = 0;
            response.on('data', (chunk: unknown) => {
              if (!Buffer.isBuffer(chunk)) { finish(new ApiError('invalid-response')); response.destroy(); return; }
              length += chunk.length; if (length > MAX_BODY) { finish(new ApiError('invalid-response')); response.destroy(); return; } chunks.push(chunk);
            });
            response.on('error', () => finish(new ApiError(this.closed ? 'closed' : 'network')));
            response.on('end', () => {
              try { finish(undefined, { body: parseJson(Buffer.concat(chunks).toString('utf8')), headers: response.headers }); }
              catch { finish(new ApiError('invalid-response')); }
            });
          });
          request.on('error', () => finish(new ApiError(this.closed ? 'closed' : 'network'))); request.end(payload);
        } catch { finish(new ApiError(this.closed ? 'closed' : 'network')); }
      });
    } finally { this.controllers.delete(controller); }
  }
}
