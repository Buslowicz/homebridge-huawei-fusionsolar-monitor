export interface MonitorConfig {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly stationCodes: readonly string[];
  readonly pollIntervalSeconds: number;
  readonly alarms: boolean;
  readonly statusSensors: boolean;
  readonly writeSnapshot: boolean;
  readonly powerMeters: boolean;
  readonly advancedTelemetry: boolean;
  readonly gridPowerDirection: 'unconfigured' | 'positiveImport' | 'positiveExport';
  readonly gridMeterId: string | undefined;
  readonly demo: boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('FusionSolar configuration must be an object.');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 1024): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error(`Invalid configuration field: ${label}.`);
  }
  return value;
}

function flag(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be true or false.`);
  }
  return value;
}

export function parseConfig(value: unknown, env: Readonly<Record<string, string | undefined>> = process.env): MonitorConfig {
  const raw = record(value);
  const demo = flag(raw.demo, false, 'demo');
  const baseUrl = demo ? 'https://demo.fusionsolar.huawei.com' : text(raw.baseUrl, 'baseUrl');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Invalid FusionSolar server URL.');
  }
  if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)+fusionsolar\.huawei\.com$/iu.test(url.hostname)
    || url.port || url.username || url.password || url.search || url.hash || !['/', '/thirdData', '/thirdData/'].includes(url.pathname)) {
    throw new Error('Provide an HTTPS *.fusionsolar.huawei.com URL without credentials or parameters.');
  }
  const username = demo ? '' : text(raw.username ?? env.FUSIONSOLAR_USERNAME, 'username', 256);
  const password = demo ? '' : text(raw.password ?? env.FUSIONSOLAR_PASSWORD, 'password');
  const poll = raw.pollIntervalSeconds ?? 300;
  if (typeof poll !== 'number' || !Number.isInteger(poll) || poll < 300 || poll > 3600) {
    throw new Error('pollIntervalSeconds must be an integer from 300 to 3600.');
  }
  const codes = raw.stationCodes ?? [];
  if (!Array.isArray(codes) || codes.length > 100) {
    throw new Error('stationCodes must be a list of up to 100 plant identifiers.');
  }
  const stationCodes = codes.map((entry: unknown) => {
    const code = text(entry, 'stationCodes', 128);
    if (code.trim() !== code || code.includes(',')) {
      throw new Error('Invalid plant identifier in stationCodes.');
    }
    return code;
  });
  if (new Set(stationCodes).size !== stationCodes.length) {
    throw new Error('stationCodes contains duplicate identifiers.');
  }
  const gridPowerDirection = raw.gridPowerDirection === undefined ? 'unconfigured' : raw.gridPowerDirection;
  if (gridPowerDirection !== 'unconfigured' && gridPowerDirection !== 'positiveImport' && gridPowerDirection !== 'positiveExport') {
    throw new Error('gridPowerDirection must be unconfigured, positiveImport or positiveExport.');
  }
  const gridMeterId = raw.gridMeterId;
  if (gridMeterId !== undefined && (typeof gridMeterId !== 'string' || gridMeterId.length > 128 || !/^-?(?:0|[1-9]\d*)$/u.test(gridMeterId))) {
    throw new Error('gridMeterId must be an exact signed decimal string of up to 128 characters.');
  }
  return {
    baseUrl: url.origin,
    username,
    password,
    stationCodes,
    pollIntervalSeconds: poll,
    alarms: flag(raw.alarms, true, 'alarms'),
    statusSensors: flag(raw.statusSensors, true, 'statusSensors'),
    writeSnapshot: flag(raw.writeSnapshot, true, 'writeSnapshot'),
    powerMeters: flag(raw.powerMeters, true, 'powerMeters'),
    advancedTelemetry: flag(raw.advancedTelemetry, false, 'advancedTelemetry'),
    gridPowerDirection,
    gridMeterId,
    demo
  };
}
