import { config as loadEnv } from "dotenv";
import { defaultCachePath, readStoredCredentials, type CredentialKey } from "./credentials.js";

// A .env file is only read when asked for (development). The published server takes credentials
// from the MCP client's env or from the user's own credentials file, never from the directory it runs in.
if (process.env.BOLIGMCP_ENV_FILE) {
  loadEnv({ path: process.env.BOLIGMCP_ENV_FILE, quiet: true });
}

export interface AppConfig {
  datafordelerApiKey?: string;
  /** OAuth client for registers an API key cannot open (EJF). */
  datafordelerOAuthClientId?: string;
  datafordelerOAuthClientSecret?: string;
  adressevaelgerToken: string;
  dataforsyningenToken?: string;
  emodataUser?: string;
  emodataPassword?: string;
  cachePath: string;
  /** Where each credential came from. Values are never included. */
  credentialSources?: Partial<Record<CredentialKey, CredentialSource>>;
}

export type CredentialSource = "env" | "credentials_file";

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  // An MCP bundle can pass an unfilled optional field through as its literal placeholder.
  if (!trimmed || /^\$\{user_config\.[^}]+\}$/.test(trimmed)) return undefined;
  return trimmed;
}

export function loadConfig(): AppConfig {
  const stored = readStoredCredentials();
  const sources: Partial<Record<CredentialKey, CredentialSource>> = {};
  // The client's env wins over the file, so a per-client config can override the saved setup.
  const pick = (key: CredentialKey): string | undefined => {
    const fromEnv = emptyToUndefined(process.env[key]);
    if (fromEnv) {
      sources[key] = "env";
      return fromEnv;
    }
    const fromFile = emptyToUndefined(stored[key]);
    if (fromFile) sources[key] = "credentials_file";
    return fromFile;
  };
  return {
    datafordelerApiKey: pick("DATAFORDELER_API_KEY"),
    datafordelerOAuthClientId: pick("DATAFORDELER_OAUTH_CLIENT_ID"),
    datafordelerOAuthClientSecret: pick("DATAFORDELER_OAUTH_CLIENT_SECRET"),
    // The public token is the official KDS recommendation until user management ships.
    adressevaelgerToken: pick("ADRESSEVAELGER_TOKEN") ?? "adressevaelger123",
    dataforsyningenToken: pick("DATAFORSYNINGEN_TOKEN"),
    emodataUser: pick("EMODATA_USER"),
    emodataPassword: pick("EMODATA_PASSWORD"),
    cachePath: emptyToUndefined(process.env.CACHE_PATH) ?? defaultCachePath(),
    credentialSources: sources,
  };
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

export function resetConfigForTests(next?: AppConfig): void {
  cached = next;
}
