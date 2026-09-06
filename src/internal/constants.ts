export const SDK_VERSION = "0.1.1";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_BASE_URL = "https://haven.chitmark.com";

type EnvMap = Record<string, string | undefined>;

/**
 * Node `process.env` when available; empty object in browsers/Workers.
 * Avoids a hard dependency on `@types/node`.
 */
export function readProcessEnv(): EnvMap {
  const g = globalThis as typeof globalThis & { process?: { env?: EnvMap } };
  return g.process?.env ?? {};
}

/**
 * Resolve base URL: explicit option, else HAVEN_API_URL / HAVEN_BASE_URL, else production.
 */
export function resolveBaseUrl(explicit?: string, fromEnv?: string | null): string {
  const raw = (explicit ?? fromEnv ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  return raw.length > 0 ? raw : DEFAULT_BASE_URL;
}

export function envBaseUrl(env: EnvMap = readProcessEnv()): string | null {
  const v = env.HAVEN_API_URL?.trim() || env.HAVEN_BASE_URL?.trim();
  return v && v.length > 0 ? v : null;
}
