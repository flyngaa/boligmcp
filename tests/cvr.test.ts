import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFlags } from "../src/analysis/flags.js";
import { listSourceStatus } from "../src/catalog.js";
import { resetConfigForTests, type AppConfig } from "../src/config.js";
import { resetCacheForTests } from "../src/lib/cache.js";
import * as http from "../src/lib/http.js";
import { resetOAuthTokenForTests } from "../src/sources/datafordeler/client.js";
import { formatCvrAddress, getCompany, latestEmployment } from "../src/sources/datafordeler/cvr.js";
import { getOwners, mapOwner } from "../src/sources/datafordeler/owners.js";
import { ownerSummary } from "../src/tools/property-report.js";
import { ok, type Owner } from "../src/types.js";

const base: AppConfig = { adressevaelgerToken: "adressevaelger123", cachePath: ":memory:", datafordelerApiKey: "api-key" };
const withOAuth: AppConfig = { ...base, datafordelerOAuthClientId: "client-1", datafordelerOAuthClientSecret: "s3cret" };

afterEach(() => {
  resetConfigForTests(undefined);
  resetCacheForTests();
  resetOAuthTokenForTests();
  vi.restoreAllMocks();
});

const entityOf = (query: string) => query.match(/(CVR_\w+|EJF\w*_\w+)\(/)?.[1] ?? "";

/** Answers each CVR entity from a table, as Datafordeleren would for one company. */
function mockCvr(rows: Record<string, Array<Record<string, unknown>>>, queries: string[] = []) {
  return vi.spyOn(http, "fetchJson").mockImplementation(async (_url: string, options?: http.FetchJsonOptions) => {
    const query = (options?.body as { query: string }).query;
    queries.push(query);
    const entity = entityOf(query);
    if (entity === "CVR_Navn" || entity === "CVR_CVREnhed") {
      const id = query.match(/eq: "([^"]+)"/)?.[1] ?? "";
      return { data: { [entity]: { nodes: rows[`${entity}:${id}`] ?? [] } } };
    }
    return { data: { [entity]: { nodes: rows[entity] ?? [] } } };
  });
}

describe("get_company", () => {
  it("maps CVR's entities into one company and never asks for people", async () => {
    resetConfigForTests(base);
    const queries: string[] = [];
    mockCvr(
      {
        CVR_Virksomhed: [{ id: "900", CVRNummer: 12345678, status: "aktiv", virksomhedStartdato: "2015-03-02" }],
        "CVR_Navn:900": [
          { vaerdi: "Andet Navn I/S", sekvens: 1 },
          { vaerdi: "Vestervang 52 I/S", sekvens: 0 },
        ],
        CVR_Adressering: [
          { AdresseringAnvendelse: "postadresse", CVRAdresse_vejnavn: "Postboks", CVRAdresse_postnummer: "1000" },
          {
            AdresseringAnvendelse: "beliggenhedsadresse",
            Adresse: "dar-1",
            CVRAdresse_vejnavn: "Vestervang",
            CVRAdresse_husnummerFra: "52",
            CVRAdresse_etagebetegnelse: "2",
            CVRAdresse_doerbetegnelse: "tv",
            CVRAdresse_postnummer: "8000",
            CVRAdresse_postdistrikt: "Aarhus C",
            CVRAdresse_kommunenavn: "AARHUS",
            CVRAdresse_landekode: "DK",
          },
        ],
        CVR_Virksomhedsform: [{ vaerdi: "30", vaerdiTekst: "Interessentskab" }],
        CVR_Branche: [
          { vaerdi: "683210", vaerdiTekst: "Administration af fast ejendom", sekvens: 1 },
          { vaerdi: "682040", vaerdiTekst: "Udlejning af erhvervsejendomme", sekvens: 0 },
        ],
        CVR_Reklamebeskyttelse: [{ vaerdi: true }],
        CVR_Beskaeftigelse: [],
        CVR_FuldtAnsvarligDeltagerRelation: [{ deltagendeEnhedsId: "p1" }, { deltagendeEnhedsId: "c1" }, { deltagendeEnhedsId: "p2" }],
        "CVR_CVREnhed:p1": [{ enhedsType: "CVRPerson", forretningsnoegle: "p1" }],
        "CVR_CVREnhed:p2": [{ enhedsType: "CVRPerson", forretningsnoegle: "p2" }],
        "CVR_CVREnhed:c1": [{ enhedsType: "Virksomhed", forretningsnoegle: "87654321" }],
        "CVR_Navn:c1": [{ vaerdi: "Holding ApS", sekvens: 0 }],
      },
      queries,
    );

    const result = await getCompany("1234 5678");
    expect(result).toMatchObject({
      status: "ok",
      source: "cvr",
      data: {
        cvr: "12345678",
        name: "Vestervang 52 I/S",
        status: "aktiv",
        form: "Interessentskab",
        address: "Vestervang 52, 2. tv., 8000 Aarhus C",
        addressId: "dar-1",
        industry: "Udlejning af erhvervsejendomme",
        secondaryIndustries: ["Administration af fast ejendom"],
        advertisingProtected: true,
        liableParticipants: { companies: [{ cvr: "87654321", name: "Holding ApS" }], people: 2 },
      },
    });
    if (result.status === "ok") expect(result.data.employees).toBeUndefined();
    for (const query of queries) {
      // CVR allows one root field per query, no aliases and no registreringstid; CVRPerson is confidential.
      expect(query.match(/\w+\(/g)).toHaveLength(1);
      expect(query).not.toMatch(/registreringstid|CVRPerson\(|CPR/);
    }
  });

  it("checks the number before asking and needs the Datafordeleren key", async () => {
    resetConfigForTests(base);
    const graphql = mockCvr({});
    expect(await getCompany("1234")).toMatchObject({ status: "unavailable", reason: "not_found" });
    expect(graphql).not.toHaveBeenCalled();
    expect(await getCompany("12345678")).toMatchObject({ status: "unavailable", reason: "not_found", detail: "No company with CVR 12345678." });

    resetConfigForTests({ adressevaelgerToken: "adressevaelger123", cachePath: ":memory:" });
    expect(await getCompany("12345678")).toMatchObject({ status: "unavailable", reason: "missing_credentials" });
    expect(listSourceStatus(base).find((s) => s.id === "cvr")?.configured).toBe(true);
  });
});

describe("CVR helpers", () => {
  const now = Date.parse("2026-09-27");

  it("prefers a recent employee count, and drops one older than two years", () => {
    const rows = [
      { beskaeftigelsestalstype: "MaanedsbeskaeftigelseAntalAarsvaerk", antal: 40, datoFra: "2026-06-01", datoTil: "2026-06-30" },
      { beskaeftigelsestalstype: "MaanedsbeskaeftigelseAntalAnsatteInterval", intervalFra: 20, intervalTil: 49, datoFra: "2026-06-01", datoTil: "2026-06-30" },
      { beskaeftigelsestalstype: "MaanedsbeskaeftigelseAntalAnsatte", antal: 45, datoFra: "2026-06-01", datoTil: "2026-06-30" },
      { beskaeftigelsestalstype: "MaanedsbeskaeftigelseAntalAnsatte", antal: 30, datoFra: "2026-05-01", datoTil: "2026-05-31" },
    ];
    expect(latestEmployment(rows, now)).toEqual({ count: 45, period: "2026-06-01–2026-06-30" });
    expect(latestEmployment([rows[1]!], now)).toEqual({ min: 20, max: 49, period: "2026-06-01–2026-06-30" });
    // Datafordeleren's copy stopped in 2019: Novo Nordisk's 16.098 is not today's head count.
    expect(latestEmployment([{ beskaeftigelsestalstype: "MaanedsbeskaeftigelseAntalAnsatte", antal: 16098, datoTil: "2019-09-30" }], now)).toBeUndefined();
  });

  it("writes addresses with a house number range and a foreign country", () => {
    expect(formatCvrAddress({ CVRAdresse_vejnavn: "Novo Alle", CVRAdresse_husnummerFra: "1", CVRAdresse_postnummer: "2880", CVRAdresse_postdistrikt: "Bagsværd", CVRAdresse_landekode: "DK" })).toBe("Novo Alle 1, 2880 Bagsværd");
    expect(formatCvrAddress({ CVRAdresse_vejnavn: "Havnegade", CVRAdresse_husnummerFra: "2", CVRAdresse_husnummerTil: "6" })).toBe("Havnegade 2-6");
    expect(formatCvrAddress({ CVRAdresse_adresseFritekst: "Box 12, Stockholm", CVRAdresse_landekode: "SE" })).toBe("Box 12, Stockholm");
  });
});

describe("get_owners", () => {
  const tokenResponse = () => new Response(JSON.stringify({ access_token: "tok-123", expires_in: 3600 }), { status: 200 });

  it("names a company owner from CVR and a private owner only as such", async () => {
    resetConfigForTests(withOAuth);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => tokenResponse());
    const queries: string[] = [];
    vi.spyOn(http, "fetchJson").mockImplementation(async (url: string, options?: http.FetchJsonOptions) => {
      const query = (options?.body as { query: string }).query;
      queries.push(query);
      const entity = entityOf(query);
      if (entity === "EJFCustom_EjerskabBegraenset") {
        // EJF_Ejerskab carries CPR numbers and is for public authorities; private actors get this one.
        expect(url).toBe("https://graphql.datafordeler.dk/flexibleCurrent/v1");
        expect(query).not.toMatch(/registreringstid/);
        return {
          data: {
            EJFCustom_EjerskabBegraenset: {
              nodes: [
                { ejendeVirksomhedCVRNr: 24256790, ejerforholdskode: "30", faktiskEjerandel_taeller: 1, faktiskEjerandel_naevner: 2, virkningFra: "2021-04-01T00:00:00Z", status: "gældende" },
                { ejerforholdskode: "10", faktiskEjerandel_taeller: 1, faktiskEjerandel_naevner: 2, virkningFra: "2021-04-01T00:00:00Z", status: "gældende" },
              ],
            },
          },
        };
      }
      if (entity === "CVR_Virksomhed") return { data: { CVR_Virksomhed: { nodes: [{ id: "312108", CVRNummer: 24256790, status: "under konkurs" }] } } };
      if (entity === "CVR_Navn") return { data: { CVR_Navn: { nodes: [{ vaerdi: "NOVO NORDISK A/S", sekvens: 0 }] } } };
      if (entity === "CVR_Virksomhedsform") return { data: { CVR_Virksomhedsform: { nodes: [{ vaerdi: "60", vaerdiTekst: "Aktieselskab" }] } } };
      return { data: { [entity]: { nodes: [] } } };
    });

    const result = await getOwners("3451166");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data).toEqual([
      expect.objectContaining({ kind: "company", cvr: "24256790", share: 0.5, since: "2021-04-01", company: expect.objectContaining({ name: "NOVO NORDISK A/S", form: "Aktieselskab" }) }),
      { kind: "private_person", ownershipCode: "10", ownershipType: "Privatpersoner eller interessentskab", share: 0.5, since: "2021-04-01", cvr: undefined, attribution: "Kilde: Ejerfortegnelsen, Geodatastyrelsen (CC BY 4.0)" },
    ]);
    for (const query of queries) {
      expect(query).not.toMatch(/PersonNr|PersonBegraenset|Ejeroplys|PersonVirksomhed|oplysninger|administr|CVRPerson/i);
    }

    expect(ownerSummary(result)).toEqual(["NOVO NORDISK A/S, CVR 24256790 (50 %)", "Privatperson (50 %)"]);
    const flags = buildFlags({ owners: result.data });
    expect(flags.find((flag) => flag.id === "owner_company_inactive")).toMatchObject({ severity: "high", detail: expect.stringContaining('status "under konkurs"') });
    expect(flags.find((flag) => flag.id === "owner_company")?.detail).toBe(
      "NOVO NORDISK A/S (CVR 24256790, Aktieselskab), 50 %. Kilde: Ejerfortegnelsen, Geodatastyrelsen (CC BY 4.0); Det Centrale Virksomhedsregister (CVR), Erhvervsstyrelsen.",
    );
    // CC BY 4.0: both registers are credited wherever their data is shown.
    expect(result.data.every((owner) => owner.attribution?.includes("Ejerfortegnelsen"))).toBe(true);
    expect(result.data[0]?.company?.attribution).toMatch(/Det Centrale Virksomhedsregister/);
    expect(JSON.stringify(flags)).not.toMatch(/Privatperson/);
  });

  it("says owners need their own approval, apart from sale prices", async () => {
    resetConfigForTests(base);
    expect(await getOwners("1")).toMatchObject({ status: "unavailable", source: "ejf", reason: "missing_credentials" });

    resetConfigForTests(withOAuth);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => tokenResponse());
    vi.spyOn(http, "fetchJson").mockRejectedValue(new http.HttpError("HTTP 403", 403));
    const denied = await getOwners("1");
    expect(denied).toMatchObject({ status: "unavailable", reason: "requires_agreement" });
    expect(denied.status === "unavailable" && denied.detail).toMatch(/CustomEjerskabBegraenset.*get_company/s);
  });

  it("pads a CVR number EJF stores without its leading zero", () => {
    const owner: Owner = mapOwner({ ejendeVirksomhedCVRNr: 1234567, ejerforholdskode: "30" });
    expect(owner).toMatchObject({ kind: "company", cvr: "01234567", ownershipType: expect.stringMatching(/selskab/) });
    expect(mapOwner({ ejerforholdskode: "80" })).toMatchObject({ kind: "other", ownershipType: "Staten" });
    expect(ownerSummary(ok("ejf", [mapOwner({ ejerforholdskode: "80" })]))).toEqual(["Staten"]);
  });
});
