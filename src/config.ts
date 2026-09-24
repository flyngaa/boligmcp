import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

export interface AppConfig {
  datafordelerApiKey?: string;
  adressevaelgerToken: string;
  dataforsyningenToken?: string;
  emodataUser?: string;
  emodataPassword?: string;
  cachePath: string;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(): AppConfig {
  return {
    datafordelerApiKey: emptyToUndefined(process.env.DATAFORDELER_API_KEY),
    adressevaelgerToken:
      emptyToUndefined(process.env.ADRESSEVAELGER_TOKEN) ?? "adressevaelger123",
    dataforsyningenToken: emptyToUndefined(process.env.DATAFORSYNINGEN_TOKEN),
    emodataUser: emptyToUndefined(process.env.EMODATA_USER),
    emodataPassword: emptyToUndefined(process.env.EMODATA_PASSWORD),
    cachePath: emptyToUndefined(process.env.CACHE_PATH) ?? "./cache.db",
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
