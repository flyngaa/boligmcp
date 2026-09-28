import { getConfig, type AppConfig } from "./config.js";
import type { SourceId, SourceStatus } from "./types.js";

export type AccessTier = "T0" | "T1" | "T2" | "T3" | "X";

export interface SourceDefinition {
  id: SourceId;
  name: string;
  tier: AccessTier;
  envKeys: Exclude<keyof AppConfig, "credentialSources" | "cachePath">[];
  ttlSeconds: number;
  docsUrl?: string;
  notes?: string;
  /** How a user gets their own credential. Shown when it is missing. */
  setup?: string;
}

export const SETUP_COMMAND = "npx -y boligmcp setup";

const DATAFORDELER_SETUP =
  "Free. Create your own web user at https://datafordeler.dk, add an IT-system with API-key authentication, then run `" +
  SETUP_COMMAND +
  "` or set DATAFORDELER_API_KEY in your MCP client config. New keys can take 15 minutes to activate.";

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
    setup: DATAFORDELER_SETUP,
    name: "DAR (addresses)",
    tier: "T1",
    envKeys: ["datafordelerApiKey"],
    ttlSeconds: 60 * 60 * 24,
    docsUrl: "https://confluence.kds.dk/pages/viewpage.action?pageId=187105434",
  },
  {
    id: "ebr",
    setup: DATAFORDELER_SETUP,
    name: "Ejendomsbeliggenhed (EBR)",
    tier: "T1",
    envKeys: ["datafordelerApiKey"],
    ttlSeconds: 60 * 60 * 24,
    docsUrl: "https://datafordeler.dk/dataoversigt/ejendomsbeliggenhedsregistret-ebr/ebr-graphql/",
    notes: "Street address for a BFE, or a text designation when the property has no address.",
  },
  {
    id: "matrikel",
    setup: DATAFORDELER_SETUP,
    name: "Matriklen",
    tier: "T1",
    envKeys: ["datafordelerApiKey"],
    ttlSeconds: 60 * 60 * 24,
    docsUrl: "https://confluence.kds.dk/pages/viewpage.action?pageId=187105434",
  },
  {
    id: "bbr",
    setup: DATAFORDELER_SETUP,
    name: "BBR",
    tier: "T1",
    envKeys: ["datafordelerApiKey"],
    ttlSeconds: 60 * 60 * 24,
    docsUrl: "https://confluence.kds.dk/pages/viewpage.action?pageId=187105434",
  },
  {
    id: "dagi",
    setup: DATAFORDELER_SETUP,
    name: "DAGI",
    tier: "T1",
    envKeys: ["datafordelerApiKey"],
    ttlSeconds: 60 * 60 * 24 * 7,
    docsUrl: "https://confluence.kds.dk/pages/viewpage.action?pageId=187105434",
  },
  {
    id: "vur",
    setup: DATAFORDELER_SETUP,
    name: "Ejendomsvurdering (VUR)",
    tier: "T1",
    envKeys: ["datafordelerApiKey"],
    ttlSeconds: 60 * 60 * 24 * 7,
    docsUrl: "https://confluence.kds.dk/pages/viewpage.action?pageId=187105434",
  },
  {
    id: "ejf",
    name: "EJF sale prices and owners (no names of private people)",
    tier: "T2",
    envKeys: ["datafordelerOAuthClientId", "datafordelerOAuthClientSecret"],
    ttlSeconds: 60 * 60 * 24 * 7,
    docsUrl: "https://confluence.kds.dk/pages/viewpage.action?pageId=187105434",
    notes: "Owner names and CPR numbers of private individuals are never requested. Owners need CustomEjerskabBegraenset approved as well.",
    setup:
      "Needs your own approved EJF access: MitID Erhverv, an IT-system with OAuth Shared Secret, and a request to Geodatastyrelsen via Datafordeler Administration for EJF_Ejerskifte and EJF_Handelsoplysninger, plus CustomEjerskabBegraenset for owners (see docs/credentials.md). Then run `" +
      SETUP_COMMAND +
      "` and enter the OAuth Client ID and Shared Secret.",
  },
  {
    id: "cvr",
    setup: DATAFORDELER_SETUP,
    name: "CVR (companies)",
    tier: "T1",
    envKeys: ["datafordelerApiKey"],
    ttlSeconds: 60 * 60 * 24,
    docsUrl: "https://datafordeler.dk/dataoversigt/det-centrale-virksomhedsregister-cvr/cvr-graphql/",
    notes: "Company name, status, form, address, industry and head count. Owners and management of a company are not in this API; CVRPerson is never requested.",
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
    id: "fbb",
    name: "Fredede og bevaringsværdige bygninger (FBB)",
    tier: "T0",
    envKeys: [],
    ttlSeconds: 60 * 60 * 24,
    docsUrl: "https://www.kulturarv.dk/fbb/",
    notes: "SAVE 1–9 and listed status from Slots- og Kulturstyrelsen. No key.",
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
    id: "dhm",
    name: "Danmarks Højdemodel (terrain and surface)",
    tier: "T1",
    envKeys: ["datafordelerApiKey"],
    ttlSeconds: 60 * 60 * 24 * 30,
    docsUrl: "https://datafordeler.dk/dataoversigt/danmarks-hoejdemodel-dhm/dhm-wcs/",
    setup: DATAFORDELER_SETUP,
  },
  {
    id: "geodanmark",
    name: "GeoDanmark building outlines",
    tier: "T1",
    envKeys: ["datafordelerApiKey"],
    ttlSeconds: 60 * 60 * 24 * 30,
    docsUrl: "https://datafordeler.dk/dataoversigt/geodanmark-vektor/geodanmark-vektor-wfs/",
    setup: DATAFORDELER_SETUP,
  },
  {
    id: "emodata",
    name: "Energimærke (EMOData)",
    tier: "T2",
    envKeys: ["emodataUser", "emodataPassword"],
    setup:
      "Needs your own EMOData agreement with Energistyrelsen (https://emoweb.dk). Then run `" +
      SETUP_COMMAND +
      "` or set EMODATA_USER and EMODATA_PASSWORD in your MCP client config.",
    ttlSeconds: 60 * 60 * 24 * 7,
    docsUrl: "https://emoweb.dk/",
  },
  {
    id: "dataforsyningen",
    name: "Dataforsyningen imagery",
    tier: "T1",
    envKeys: ["dataforsyningenToken"],
    setup: "Create a user and token at https://dataforsyningen.dk, then run `" + SETUP_COMMAND + "`.",
    ttlSeconds: 60 * 60 * 24 * 7,
    docsUrl: "https://dataforsyningen.dk/",
    notes: "Used by get_aerial_photo: spring orthophoto and a cropped skråfoto facade.",
  },
  {
    id: "google_maps",
    name: "Google Maps 3D",
    tier: "T1",
    envKeys: ["googleMapsApiKey"],
    setup:
      "Create your own key in Google Cloud Console with the Maps JavaScript API enabled (https://console.cloud.google.com/google/maps-apis), then run `" +
      SETUP_COMMAND +
      "` or set GOOGLE_MAPS_API_KEY. If the key is restricted by website, allow http://127.0.0.1:47321/*. The key is only used to open a local 3D map and is never returned by a tool.",
    ttlSeconds: 0,
    docsUrl: "https://developers.google.com/maps/documentation/javascript/3d/overview",
    notes: "Photorealistic 3D map in the browser. Preview of Maps JavaScript API; billed when Google makes it generally available.",
  },
];

const ENV_LABEL: Record<Exclude<keyof AppConfig, "credentialSources">, string> = {
  datafordelerApiKey: "DATAFORDELER_API_KEY",
  datafordelerOAuthClientId: "DATAFORDELER_OAUTH_CLIENT_ID",
  datafordelerOAuthClientSecret: "DATAFORDELER_OAUTH_CLIENT_SECRET",
  adressevaelgerToken: "ADRESSEVAELGER_TOKEN",
  dataforsyningenToken: "DATAFORSYNINGEN_TOKEN",
  emodataUser: "EMODATA_USER",
  emodataPassword: "EMODATA_PASSWORD",
  googleMapsApiKey: "GOOGLE_MAPS_API_KEY",
  cachePath: "CACHE_PATH",
};

export function setupHint(id: SourceId): string | undefined {
  return SOURCES.find((source) => source.id === id)?.setup;
}

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
    const firstKey = source.envKeys[0];
    const available = missingEnv.length === 0;
    const credentialSource = firstKey
      ? config.credentialSources?.[ENV_LABEL[firstKey] as keyof NonNullable<AppConfig["credentialSources"]>]
      : undefined;
    return {
      id: source.id,
      name: source.name,
      tier: source.tier,
      configured: available,
      envKeys: source.envKeys.map((key) => ENV_LABEL[key]),
      missingEnv,
      docsUrl: source.docsUrl,
      ttlSeconds: source.ttlSeconds,
      credentialSource: available ? credentialSource : undefined,
      setup: available ? undefined : source.setup,
    };
  });
}

export function ttlFor(id: SourceId): number {
  return SOURCES.find((source) => source.id === id)?.ttlSeconds ?? 3600;
}
