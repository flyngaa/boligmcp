import { setupHint } from "../../catalog.js";
import { getConfig } from "../../config.js";
import { cached } from "../../lib/cache.js";
import { fetchJson, HttpError } from "../../lib/http.js";
import { unavailable, type SourceId, type SourceResult } from "../../types.js";

const REGISTER_PATH: Record<string, string> = {
  DAR: "DAR/v3",
  BBR: "BBR/v3",
  MAT: "MAT/v3",
  DAGI: "DAGI/v2",
  EJF: "EJF/v1",
  VUR: "VUR/v2",
  EBR: "EBR/v1",
  CVR: "CVR/v2",
  // Combined services across registers, e.g. EJFCustom_EjerskabBegraenset (owners without CPR numbers).
  FLEX: "flexibleCurrent/v1",
};

export type DatafordelerRegister = keyof typeof REGISTER_PATH;

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export function datafordelerUnavailable<T>(
  source: SourceId,
  detail = `No Datafordeleren API key is configured. Ask the user to add their own: ${setupHint("bbr")} Do not ask the user to paste the key into the chat.`,
): SourceResult<T> {
  return unavailable(source, "missing_credentials", detail);
}

export type DatafordelerAuth = "apiKey" | "oauth";

const TOKEN_URL = "https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token";
let token: { value: string; expiresAt: number; clientId: string } | undefined;

export function resetOAuthTokenForTests(): void {
  token = undefined;
  tokenRequest = undefined;
}

/** Client-credentials token for the user's own OAuth IT-system, reused until shortly before it expires. */
/** One token request at a time: ten reports started together asked for ten tokens (up to 4 s each). */
let tokenRequest: { clientId: string; promise: Promise<string> } | undefined;

export async function getOAuthToken(): Promise<string> {
  const { datafordelerOAuthClientId: clientId, datafordelerOAuthClientSecret: secret } = getConfig();
  if (!clientId || !secret) throw new Error("MISSING_OAUTH: DATAFORDELER_OAUTH_CLIENT_ID and _SECRET are not set");
  if (token && token.clientId === clientId && token.expiresAt > Date.now() + 60_000) return token.value;
  if (tokenRequest?.clientId === clientId) return tokenRequest.promise;
  const promise = requestToken(clientId, secret).finally(() => {
    if (tokenRequest?.promise === promise) tokenRequest = undefined;
  });
  tokenRequest = { clientId, promise };
  return promise;
}

async function requestToken(clientId: string, secret: string): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret }),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 400
        ? "OAUTH_REJECTED: Datafordeleren rejected the OAuth Client ID or Shared Secret."
        : `OAuth token request failed with HTTP ${response.status}.`,
    );
  }
  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("OAuth token response had no access_token.");
  token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000, clientId };
  return token.value;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function extractNodes<T extends Record<string, unknown>>(
  data: T | undefined,
  entity: string,
): Array<Record<string, unknown>> {
  if (!data) return [];
  const block = data[entity];
  if (Array.isArray(block)) return block as Array<Record<string, unknown>>;
  if (block && typeof block === "object") {
    const nodes = (block as { nodes?: unknown }).nodes;
    if (Array.isArray(nodes)) return nodes as Array<Record<string, unknown>>;
  }
  return [];
}

/**
 * Entities and fields that identify private people: CPR numbers, names and person objects. Bolig-MCP never asks for
 * them, so a query that mentions one is refused here, before anything is sent. A test guards every pattern.
 */
const PERSON_DATA = [
  /\bCVRPerson\b/, // CVR's people, confidential
  /\bEJF_Ejerskab\b/, // owners with CPR numbers, for public authorities only
  /PersonVirksomhedsoplys/i, // owner names and addresses
  /ejendePerson/i, // the person object of an ownership
  /Ejeroplys/i, // owner details
  /\bcpr/i,
  /personn(umme)?r/i,
];

export function assertNoPersonData(query: string): void {
  const hit = PERSON_DATA.find((pattern) => pattern.test(query));
  if (hit) throw new Error(`PRIVACY_BLOCKED: Bolig-MCP never queries data about private people (${hit.source}).`);
}

export async function graphql<T>(
  register: DatafordelerRegister,
  query: string,
  variables: Record<string, unknown> = {},
  cacheKey?: string,
  ttlSeconds = 86_400,
  auth: DatafordelerAuth = "apiKey",
): Promise<T> {
  assertNoPersonData(query);
  const path = REGISTER_PATH[register];
  let url = `https://graphql.datafordeler.dk/${path}`;
  if (auth === "apiKey") {
    const key = getConfig().datafordelerApiKey;
    if (!key) throw new Error("DATAFORDELER_API_KEY is not set");
    url += `?apiKey=${encodeURIComponent(key)}`;
  }
  const loader = async () => {
    let response: GraphQlResponse<T>;
    try {
      const headers: Record<string, string> = auth === "oauth" ? { authorization: `Bearer ${await getOAuthToken()}` } : {};
      response = await fetchJson<GraphQlResponse<T>>(url, {
        method: "POST",
        headers,
        body: { query, variables },
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        throw new Error(
          "Datafordeleren rejected the API key (401). Confirm it is an IT-system API-key (not ClientId) and that at least 15 minutes have passed since it was created.",
        );
      }
      if (error instanceof HttpError && error.status === 403) {
        throw new Error(`FORBIDDEN: Datafordeleren denied this register for the current ${auth === "oauth" ? "OAuth IT-system" : "API key"}.`);
      }
      throw error;
    }
    if (response.errors?.length) {
      const message = response.errors.map((item) => item.message).join("; ");
      if (/not authorized|DAF-AUTH/i.test(message)) {
        throw new Error(`FORBIDDEN: ${message}`);
      }
      throw new Error(message);
    }
    if (!response.data) {
      throw new Error(`Empty GraphQL data from ${register}`);
    }
    return response.data;
  };
  if (cacheKey) return cached(cacheKey, ttlSeconds, loader);
  return loader();
}

/**
 * Writes a filter as a GraphQL input literal. Keys must be plain names; every string value is JSON-escaped,
 * so user input can never close a string or add filter fields.
 */
export function graphqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Invalid number in GraphQL filter: ${value}`);
    return String(value);
  }
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(graphqlLiteral).join(", ")}]`;
  if (typeof value === "object") {
    const fields = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid GraphQL field name: ${key}`);
      return `${key}: ${graphqlLiteral(item)}`;
    });
    return `{ ${fields.join(", ")} }`;
  }
  throw new Error(`Unsupported value in GraphQL filter: ${typeof value}`);
}

export async function queryNodes(
  register: DatafordelerRegister,
  entity: string,
  fields: string,
  where: Record<string, unknown>,
  first = 20,
  /** `"virkning"`: only virkningstid, for registers such as CVR that reject registreringstid. */
  options: { temporal?: boolean | "virkning"; auth?: DatafordelerAuth } = {},
): Promise<Array<Record<string, unknown>>> {
  const whereLiteral = graphqlLiteral(where);
  const temporal =
    options.temporal === false
      ? ""
      : options.temporal === "virkning"
        ? `virkningstid: "${nowIso()}"`
        : `virkningstid: "${nowIso()}"\n        registreringstid: "${nowIso()}"`;
  const query = `
    query {
      ${entity}(
        first: ${first}
        ${temporal}
        where: ${whereLiteral}
      ) {
        nodes { ${fields} }
      }
    }
  `;
  // Fields, page size and temporality change the answer, so they belong in the key.
  const cacheKey = `daf:${register}:${entity}:${JSON.stringify(where)}:${first}:${options.temporal === false ? "nt" : options.temporal === "virkning" ? "v" : "t"}:${fields}`;
  const data = await graphql<Record<string, unknown>>(register, query, {}, cacheKey, 86_400, options.auth);
  return extractNodes(data, entity);
}

/** Every row of an entity, page by page (the service returns at most 1000 per request). */
export async function queryAllNodes(
  register: DatafordelerRegister,
  entity: string,
  fields: string,
  where: Record<string, unknown> = {},
  maxPages = 10,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const query = `
      query {
        ${entity}(
          first: 1000
          virkningstid: "${nowIso()}"
          registreringstid: "${nowIso()}"
          ${Object.keys(where).length ? `where: ${graphqlLiteral(where)}` : ""}
          ${after ? `after: ${JSON.stringify(after)}` : ""}
        ) {
          pageInfo { hasNextPage endCursor }
          nodes { ${fields} }
        }
      }
    `;
    const data = await graphql<Record<string, { pageInfo?: { hasNextPage?: boolean; endCursor?: string } }>>(register, query);
    rows.push(...extractNodes(data, entity));
    const info = data[entity]?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  return rows;
}
