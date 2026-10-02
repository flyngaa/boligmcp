import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../src/config.js";
import { resetCacheForTests } from "../src/lib/cache.js";
import * as http from "../src/lib/http.js";
import { assertNoPersonData, graphql, queryNodes } from "../src/sources/datafordeler/client.js";

afterEach(() => {
  resetConfigForTests(undefined);
  resetCacheForTests();
  vi.restoreAllMocks();
});

describe("person data is never queried", () => {
  it.each([
    ["CVR's people", "query { CVRPerson(first: 1) { nodes { id } } }"],
    ["EJF ownership with CPR numbers", "query { EJF_Ejerskab(first: 1) { nodes { id } } }"],
    ["owner names", "query { EJF_PersonVirksomhedsoplys(first: 1) { nodes { navn } } }"],
    ["the person object of an ownership", "query { EJFCustom_EjerskabBegraenset { nodes { ejendePersonBegraenset { id } } } }"],
    ["owner details", "query { EJF_Ejeroplysninger { nodes { id } } }"],
    ["a CPR field", "query { X { nodes { cprNummer } } }"],
    ["a person number field", "query { X { nodes { ejendePersonPersonNr personnummer } } }"],
  ])("refuses %s before anything is sent", async (_label, query) => {
    resetConfigForTests({ adressevaelgerToken: "t", cachePath: ":memory:", datafordelerApiKey: "api-key" });
    const fetch = vi.spyOn(http, "fetchJson");
    expect(() => assertNoPersonData(query)).toThrow(/PRIVACY_BLOCKED/);
    await expect(graphql("CVR", query)).rejects.toThrow(/PRIVACY_BLOCKED/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a person field asked for through queryNodes", async () => {
    resetConfigForTests({ adressevaelgerToken: "t", cachePath: ":memory:", datafordelerApiKey: "api-key" });
    const fetch = vi.spyOn(http, "fetchJson");
    await expect(queryNodes("FLEX", "EJFCustom_EjerskabBegraenset", "ejendePersonBegraenset { id }", {})).rejects.toThrow(/PRIVACY_BLOCKED/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lets the entities Bolig-MCP uses through", () => {
    for (const query of [
      "query { EJFCustom_EjerskabBegraenset { nodes { ejendeVirksomhedCVRNr ejerforholdskode } } }",
      "query { EJF_Ejerskifte { nodes { id } } }",
      "query { EJF_Ejerskabsskifte { nodes { id } } }",
      "query { EJF_Handelsoplysninger { nodes { samletKoebesum } } }",
      "query { CVR_Navn { nodes { vaerdi } } }",
      "query { CVR_FuldtAnsvarligDeltagerRelation { nodes { deltagendeEnhedsId } } }",
      "query { DAR_NavngivenVej { nodes { vejnavn } } }",
    ]) {
      expect(() => assertNoPersonData(query)).not.toThrow();
    }
  });
});
