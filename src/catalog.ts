import { getConfig, type AppConfig } from "./config.js";
import type { SourceId, SourceStatus } from "./types.js";

export type AccessTier = "T0" | "T1" | "T2" | "T3" | "X";

export interface SourceDefinition {
  id: SourceId;
  name: string;
  tier: AccessTier;
  envKeys: (keyof AppConfig)[];
  ttlSeconds: number;
  docsUrl?: string;
  notes?: string;
}

export const SOURCES: SourceDefinition[] = [
  {
    id: "adressevaelger",
    name: "Adressevælgeren",
    tier: "T0",
    envKeys: [],
    ttlSeconds: 60 * 60 * 24,
    docsUrl: "https://confluence.kds.dk/pages/viewpage.action?pageId=234782998",
    notes: "Public token defaults to adressevaelger123 until KDS user management ships.",
  },
  {
    id: "dar",
    name: "DAR (addresses)",
    tier: "T1",
    envKeys: ["datafordelerApiKey"],
    ttlSeconds: 60 * 60 * 24,
    docsUrl: "https://confluence.kds.dk/pages/viewpage.action?pageId=187105434",
  },
  {
    id: "matrikel",
    name: "Matriklen",
    tier: "T1",
    envKeys: ["datafordelerApiKey"],
    ttlSeconds: 60 * 60 * 24,
    docsUrl: "https://confluence.kds.dk/pages/viewpage.action?pageId=187105434",
  },
  {
    id: "bbr",
    name: "BBR",
    tier: "T1",
    envKeys: ["datafordelerApiKey"],
    ttlSeconds: 60 * 60 * 24,
    docsUrl: "https://confluence.kds.dk/pages/viewpage.action?pageId=187105434",
  },
  {
    id: "dagi",
    name: "DAGI",
    tier: "T1",
    envKeys: ["datafordelerApiKey"],
    ttlSeconds: 60 * 60 * 24 * 7,
    docsUrl: "https://confluence.kds.dk/pages/viewpage.action?pageId=187105434",
  },
  {
    id: "vur",
    name: "Ejendomsvurdering (VUR)",
    tier: "T1",
    envKeys: ["datafordelerApiKey"],
    ttlSeconds: 60 * 60 * 24 * 7,
    docsUrl: "https://confluence.kds.dk/pages/viewpage.action?pageId=187105434",
  },
  {
    id: "ejf",
    name: "EJF (non-protected)",
    tier: "T1",
    envKeys: ["datafordelerApiKey"],
    ttlSeconds: 60 * 60 * 24 * 7,
    docsUrl: "https://confluence.kds.dk/pages/viewpage.action?pageId=187105434",
    notes: "Owner names of private individuals are out of scope.",
  },
  {
    id: "plandata",
    name: "Plandata.dk",
    tier: "T0",
    envKeys: [],
    ttlSeconds: 60 * 60 * 24,
    docsUrl: "https://www.plandata.dk/webservices/introduktion-til-webservices/wfs",
  },
  {
    id: "miljoportal",
    name: "Danmarks Miljøportal (Arealinfo)",
    tier: "T0",
    envKeys: [],
    ttlSeconds: 60 * 60 * 24,
    docsUrl: "https://arealdata.miljoeportal.dk/",
  },
  {
    id: "dst",
    name: "Danmarks Statistik",
    tier: "T0",
    envKeys: [],
    ttlSeconds: 60 * 60 * 24 * 7,
    docsUrl: "https://www.dst.dk/da/Statistik/brug-statistikken/muligheder-i-statistikbanken/api",
  },
  {
    id: "emodata",
    name: "Energimærke (EMOData)",
    tier: "T2",
    envKeys: ["emodataUser", "emodataPassword"],
    ttlSeconds: 60 * 60 * 24 * 7,
    docsUrl: "https://emoweb.dk/",
  },
  {
    id: "dataforsyningen",
    name: "Dataforsyningen imagery",
    tier: "T1",
    envKeys: ["dataforsyningenToken"],
    ttlSeconds: 60 * 60 * 24 * 7,
    docsUrl: "https://dataforsyningen.dk/",
    notes: "Stretch: skråfoto / orthophoto / terrain. Not used by core tools yet.",
  },
];

const ENV_LABEL: Record<keyof AppConfig, string> = {
  datafordelerApiKey: "DATAFORDELER_API_KEY",
  adressevaelgerToken: "ADRESSEVAELGER_TOKEN",
  dataforsyningenToken: "DATAFORSYNINGEN_TOKEN",
  emodataUser: "EMODATA_USER",
  emodataPassword: "EMODATA_PASSWORD",
  cachePath: "CACHE_PATH",
};

export function isSourceConfigured(id: SourceId, config = getConfig()): boolean {
  const source = SOURCES.find((item) => item.id === id);
  if (!source) return false;
  return source.envKeys.every((key) => Boolean(config[key]));
}

export function listSourceStatus(config = getConfig()): SourceStatus[] {
  return SOURCES.map((source) => {
    const missingEnv = source.envKeys
      .filter((key) => !config[key])
      .map((key) => ENV_LABEL[key]);
    return {
      id: source.id,
      name: source.name,
      tier: source.tier,
      configured: missingEnv.length === 0,
      envKeys: source.envKeys.map((key) => ENV_LABEL[key]),
      missingEnv,
      docsUrl: source.docsUrl,
      ttlSeconds: source.ttlSeconds,
    };
  });
}

export function ttlFor(id: SourceId): number {
  return SOURCES.find((source) => source.id === id)?.ttlSeconds ?? 3600;
}
