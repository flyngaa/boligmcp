import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Credentials the user supplies themselves. They live in the MCP client's config (env vars)
 * or in a per-user file written by `boligmcp setup`. The server never ships with keys.
 */
export const CREDENTIAL_KEYS = [
  "DATAFORDELER_API_KEY",
  "DATAFORDELER_OAUTH_CLIENT_ID",
  "DATAFORDELER_OAUTH_CLIENT_SECRET",
  "EMODATA_USER",
  "EMODATA_PASSWORD",
  "DATAFORSYNINGEN_TOKEN",
  "ADRESSEVAELGER_TOKEN",
] as const;
export type CredentialKey = (typeof CREDENTIAL_KEYS)[number];

export type StoredCredentials = Partial<Record<CredentialKey, string>>;

function configHome(): string {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  if (process.platform === "win32" && process.env.APPDATA) return process.env.APPDATA;
  return join(homedir(), ".config");
}

function cacheHome(): string {
  if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  return join(homedir(), ".cache");
}

export function credentialsPath(): string {
  return process.env.BOLIGMCP_CREDENTIALS_FILE ?? join(configHome(), "boligmcp", "credentials.json");
}

/** Default cache location, outside whatever project directory the client starts the server in. */
export function defaultCachePath(): string {
  return join(cacheHome(), "boligmcp", "cache.db");
}

export function readStoredCredentials(path = credentialsPath()): StoredCredentials {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const result: StoredCredentials = {};
    for (const key of CREDENTIAL_KEYS) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) result[key] = value.trim();
    }
    return result;
  } catch {
    // A broken file must not stop the server; the affected sources report missing credentials.
    return {};
  }
}

export function writeStoredCredentials(values: StoredCredentials, path = credentialsPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const clean: StoredCredentials = {};
  for (const key of CREDENTIAL_KEYS) {
    const value = values[key]?.trim();
    if (value) clean[key] = value;
  }
  writeFileSync(path, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync keeps the old mode when the file already exists.
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

/** Shows that a secret is set without revealing it. */
export function mask(value: string | undefined): string {
  if (!value) return "(ikke sat)";
  return value.length <= 8 ? "••••" : `${value.slice(0, 2)}••••${value.slice(-2)}`;
}
