import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../src/config.js";
import { mapIdLookup } from "../src/sources/adressevaelger.js";
import * as adv from "../src/sources/adressevaelger.js";
import * as dst from "../src/sources/dst.js";
import * as emo from "../src/sources/emodata.js";
import * as fbb from "../src/sources/fbb.js";
import * as miljo from "../src/sources/miljoportal.js";
import * as plan from "../src/sources/plandata.js";
import * as daf from "../src/sources/datafordeler/registers.js";
import { buildPropertyReport } from "../src/tools/property-report.js";

const lookupFixture = JSON.parse(
  readFileSync(new URL("./fixtures/adressevaelger/lookup.json", import.meta.url), "utf8"),
) as Parameters<typeof mapIdLookup>[0];

afterEach(() => {
  resetConfigForTests(undefined);
  vi.restoreAllMocks();
});

describe("property_report", () => {
  it("returns a summary and marks missing T1/T2 sources", async () => {
    resetConfigForTests({
      adressevaelgerToken: "adressevaelger123",
      cachePath: ":memory:",
    });
    const match = mapIdLookup(lookupFixture);
    vi.spyOn(adv, "searchAddresses").mockResolvedValue({
      status: "ok",
      source: "adressevaelger",
      fetchedAt: new Date().toISOString(),
      data: [match],
    });
    vi.spyOn(adv, "lookupAddress").mockResolvedValue({
      status: "ok",
      source: "adressevaelger",
      fetchedAt: new Date().toISOString(),
      data: match,
    });
    vi.spyOn(daf, "resolveFromAddressId").mockResolvedValue({
      status: "unavailable",
      source: "dar",
      reason: "missing_credentials",
    });
    vi.spyOn(daf, "getBuildingsAndUnits").mockResolvedValue({
      status: "unavailable",
      source: "bbr",
      reason: "missing_credentials",
    });
    vi.spyOn(daf, "getParcels").mockResolvedValue({
      status: "unavailable",
      source: "matrikel",
      reason: "missing_credentials",
    });
    vi.spyOn(daf, "getValuation").mockResolvedValue({
      status: "unavailable",
      source: "vur",
      reason: "missing_credentials",
    });
    vi.spyOn(daf, "getTrades").mockResolvedValue({
      status: "unavailable",
      source: "ejf",
      reason: "missing_credentials",
    });
    vi.spyOn(daf, "getAdminAreasAt").mockResolvedValue({
      status: "unavailable",
      source: "dagi",
      reason: "missing_credentials",
    });
    vi.spyOn(plan, "getPlansAt").mockResolvedValue({
      status: "ok",
      source: "plandata",
      fetchedAt: new Date().toISOString(),
      data: { items: [] },
    });
    vi.spyOn(plan, "getSiteConditionsAt").mockResolvedValue({
      status: "ok",
      source: "plandata",
      fetchedAt: new Date().toISOString(),
      data: { items: [], checkedLayers: 16, failedLayers: [] },
    });
    vi.spyOn(fbb, "getHeritageAt").mockResolvedValue({
      status: "ok",
      source: "fbb",
      fetchedAt: new Date().toISOString(),
      data: { items: [] },
    });
    vi.spyOn(miljo, "getEnvironmentAt").mockResolvedValue({
      status: "ok",
      source: "miljoportal",
      fetchedAt: new Date().toISOString(),
      data: { items: [] },
    });
    vi.spyOn(dst, "getAreaStatsForMunicipality").mockResolvedValue({
      status: "ok",
      source: "dst",
      fetchedAt: new Date().toISOString(),
      data: { municipalityCode: "101", stats: [] },
    });
    vi.spyOn(emo, "getEnergyLabel").mockResolvedValue({
      status: "unavailable",
      source: "emodata",
      reason: "missing_credentials",
    });

    const report = (await buildPropertyReport({
      query: "Nørrebrogade 52, 4. tv, 2200 København N",
    })) as { summary: { designation?: string }; missing: Array<{ source: string }> };

    expect(report.summary.designation).toContain("Nørrebrogade");
    const missingSources = report.missing.map((item) => item.source);
    expect(missingSources).toContain("emodata");
  });
});
