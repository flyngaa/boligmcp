import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFlags } from "../src/analysis/flags.js";
import { listSourceStatus } from "../src/catalog.js";
import { resetConfigForTests, type AppConfig } from "../src/config.js";
import { resetCacheForTests } from "../src/lib/cache.js";
import * as http from "../src/lib/http.js";
import { getOAuthToken, resetOAuthTokenForTests } from "../src/sources/datafordeler/client.js";
import { getTrades } from "../src/sources/datafordeler/registers.js";

const base: AppConfig = { adressevaelgerToken: "adressevaelger123", cachePath: ":memory:" };
const withOAuth: AppConfig = { ...base, datafordelerOAuthClientId: "client-1", datafordelerOAuthClientSecret: "s3cret" };

function tokenResponse() {
  return new Response(JSON.stringify({ access_token: "tok-123", expires_in: 3600 }), { status: 200 });
}

afterEach(() => {
  resetConfigForTests(undefined);
  resetCacheForTests();
  resetOAuthTokenForTests();
  vi.restoreAllMocks();
});

describe("EJF OAuth", () => {
  it("asks the user for their own access when no OAuth client is configured", async () => {
    resetConfigForTests({ ...base, datafordelerApiKey: "api-key" });
    const result = await getTrades("3451459");
    expect(result).toMatchObject({ status: "unavailable", reason: "missing_credentials" });
    expect(result.status === "unavailable" && result.detail).toMatch(/Geodatastyrelsen.*boligmcp setup.*Do not ask/s);
    expect(listSourceStatus({ ...base, datafordelerApiKey: "api-key" }).find((s) => s.id === "ejf")?.configured).toBe(false);
    expect(listSourceStatus(withOAuth).find((s) => s.id === "ejf")?.configured).toBe(true);
  });

  it("uses client credentials and reuses the token until it nears expiry", async () => {
    resetConfigForTests(withOAuth);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => tokenResponse());
    expect(await getOAuthToken()).toBe("tok-123");
    expect(await getOAuthToken()).toBe("tok-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token");
    const body = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(body)).toEqual({ grant_type: "client_credentials", client_id: "client-1", client_secret: "s3cret" });
  });
});

describe("get_trades", () => {
  it("returns prices and dates, newest first, and never asks for identities", async () => {
    resetConfigForTests(withOAuth);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => tokenResponse());
    const queries: string[] = [];
    const graphql = vi.spyOn(http, "fetchJson").mockImplementation(async (url: string, options?: http.FetchJsonOptions) => {
      expect(url).toBe("https://graphql.datafordeler.dk/EJF/v1");
      expect(options?.headers?.authorization).toBe("Bearer tok-123");
      const query = (options?.body as { query: string }).query;
      queries.push(query);
      if (query.includes("EJF_Ejerskifte(")) {
        return {
          data: {
            EJF_Ejerskifte: {
              nodes: [
                { id_lokalId: "e1", overtagelsesdato: "2012-06-01T00:00:00Z", overdragelsesmaade: "Almindelig fri handel", handelsoplysningerLokalId: "h1" },
                { id_lokalId: "e2", overtagelsesdato: "2019-03-15T00:00:00Z", overdragelsesmaade: "Almindelig fri handel", handelsoplysningerLokalId: "h2" },
                { id_lokalId: "e3", overtagelsesdato: "1998-01-01T00:00:00Z", overdragelsesmaade: "Arv" },
              ],
            },
          },
        };
      }
      const id = query.match(/eq:"(h\d)"/)?.[1];
      const prices: Record<string, number> = { h1: 1_650_000, h2: 2_150_000 };
      return {
        data: {
          EJF_Handelsoplysninger: {
            nodes: [{ id_lokalId: id, samletKoebesum: prices[id ?? ""], kontantKoebesum: prices[id ?? ""], koebsaftaleDato: "2019-02-01", bygningerOmfattet: true }],
          },
        },
      };
    });

    const result = await getTrades("3451459");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.map((trade) => [trade.date, trade.price])).toEqual([
      ["2019-03-15", 2_150_000],
      ["2012-06-01", 1_650_000],
      ["1998-01-01", null],
    ]);
    expect(result.data[0]).toMatchObject({ transferType: "Almindelig fri handel", buildingsIncluded: true, attribution: expect.stringMatching(/Ejerfortegnelsen/) });
    expect(graphql).toHaveBeenCalledTimes(3);
    for (const query of queries) {
      expect(query).not.toMatch(/EJF_Ejerskab\(|PersonVirksomhed|Ejeroplys|skoedetekst|cpr|navn/i);
    }
  });

  it("explains a missing approval separately from wrong credentials", async () => {
    resetConfigForTests(withOAuth);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => tokenResponse());
    vi.spyOn(http, "fetchJson").mockRejectedValue(new http.HttpError("HTTP 403", 403));
    expect(await getTrades("1")).toMatchObject({ status: "unavailable", reason: "requires_agreement" });

    resetOAuthTokenForTests();
    resetCacheForTests();
    fetchMock.mockImplementation(async () => new Response("", { status: 401 }));
    const rejected = await getTrades("1");
    expect(rejected).toMatchObject({ status: "unavailable", reason: "missing_credentials" });
    expect(rejected.status === "unavailable" && rejected.detail).toMatch(/rejected the OAuth/);
  });
});

describe("last sale flag", () => {
  it("adds price per m² and the attribution", () => {
    const flags = buildFlags({
      units: [{ dwellingArea: 144 }],
      trades: [{ date: "2019-03-15", price: 2_150_000, transferType: "Almindelig fri handel", attribution: "Kilde: Ejerfortegnelsen, Geodatastyrelsen (CC BY 4.0)" }],
    });
    const sale = flags.find((flag) => flag.id === "last_sale");
    expect(sale?.title).toBe("Seneste handel 2019-03-15");
    expect(sale?.detail).toMatch(/2\.150\.000 kr\. \(14\.931 kr\. pr\. m² bolig\).*Ejerfortegnelsen/);
  });
});
