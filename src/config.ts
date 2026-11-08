export interface MonitorConfig {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly stationCodes: readonly string[];
  readonly pollIntervalSeconds: number;
  readonly alarms: boolean;
  readonly statusSensors: boolean;
  readonly writeSnapshot: boolean;
  readonly demo: boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Konfiguracja FusionSolar musi być obiektem.');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 1024): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error(`Nieprawidłowe pole konfiguracji: ${label}.`);
  }
  return value;
}

function flag(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Pole ${label} musi mieć wartość true albo false.`);
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
    throw new Error('Nieprawidłowy adres serwera FusionSolar.');
  }
  if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)+fusionsolar\.huawei\.com$/iu.test(url.hostname)
    || url.port || url.username || url.password || url.search || url.hash || !['/', '/thirdData', '/thirdData/'].includes(url.pathname)) {
    throw new Error('Podaj adres HTTPS serwera *.fusionsolar.huawei.com, bez danych logowania i parametrów.');
  }
  const username = demo ? '' : text(raw.username ?? env.FUSIONSOLAR_USERNAME, 'username', 256);
  const password = demo ? '' : text(raw.password ?? env.FUSIONSOLAR_PASSWORD, 'password');
  const poll = raw.pollIntervalSeconds ?? 300;
  if (typeof poll !== 'number' || !Number.isInteger(poll) || poll < 300 || poll > 3600) {
    throw new Error('pollIntervalSeconds musi być liczbą całkowitą od 300 do 3600.');
  }
  const codes = raw.stationCodes ?? [];
  if (!Array.isArray(codes) || codes.length > 100) {
    throw new Error('stationCodes musi być listą maksymalnie 100 identyfikatorów instalacji.');
  }
  const stationCodes = codes.map((entry: unknown) => {
    const code = text(entry, 'stationCodes', 128);
    if (code.trim() !== code || code.includes(',')) {
      throw new Error('Nieprawidłowy identyfikator instalacji w stationCodes.');
    }
    return code;
  });
  if (new Set(stationCodes).size !== stationCodes.length) {
    throw new Error('stationCodes zawiera powtórzone identyfikatory.');
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
    demo
  };
}
