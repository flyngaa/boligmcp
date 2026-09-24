import { isSourceConfigured } from "../../catalog.js";
import { getConfig } from "../../config.js";
import { cached } from "../../lib/cache.js";
import { fetchJson } from "../../lib/http.js";
import { unavailable, type SourceId, type SourceResult } from "../../types.js";

const REGISTER_PATH: Record<string, string> = {
  DAR: "DAR/3.0.0",
  BBR: "BBR/3.0.0",
  MAT: "MAT/3.0.0",
  DAGI: "DAGI/3.0.0",
  EJF: "EJF/3.0.0",
  VUR: "VUR/1.0.0",
  EBR: "EBR/1.0.0",
};

export type DatafordelerRegister = keyof typeof REGISTER_PATH;

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export function datafordelerUnavailable<T>(
  source: SourceId,
  detail = "Set DATAFORDELER_API_KEY. Create a web user and IT-system API key at https://datafordeler.dk (GraphQL does not accept tjenestebruger passwords).",
): SourceResult<T> {
  return unavailable(source, "missing_credentials", detail);
}

export async function graphql<T>(
  register: DatafordelerRegister,
  query: string,
  variables: Record<string, unknown> = {},
  cacheKey?: string,
  ttlSeconds = 86_400,
): Promise<T> {
  const key = getConfig().datafordelerApiKey;
  if (!key) {
    throw new Error("DATAFORDELER_API_KEY is not set");
  }
  const path = REGISTER_PATH[register];
  const url = `https://graphql.datafordeler.dk/${path}?apiKey=${encodeURIComponent(key)}`;
  const loader = async () => {
    const response = await fetchJson<GraphQlResponse<T>>(url, {
      method: "POST",
      body: { query, variables },
    });
    if (response.errors?.length) {
      throw new Error(response.errors.map((error) => error.message).join("; "));
    }
    if (!response.data) {
      throw new Error(`Empty GraphQL data from ${register}`);
    }
    return response.data;
  };
  if (cacheKey) return cached(cacheKey, ttlSeconds, loader);
  return loader();
}

export function requireDatafordeler<T>(source: SourceId): SourceResult<T> | undefined {
  if (!isSourceConfigured(source === "dar" ? "dar" : source)) {
    return datafordelerUnavailable(source);
  }
  return undefined;
}
