import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfigForTests } from "../src/config.js";
import { getEnergyLabel } from "../src/sources/emodata.js";
import { getValuation } from "../src/sources/datafordeler/registers.js";
import { getPlansAt } from "../src/sources/plandata.js";
import { getAreaStatsForMunicipality } from "../src/sources/dst.js";
import { readFileSync } from "node:fs";
import * as http from "../src/lib/http.js";

const planFixture = JSON.parse(
  readFileSync(new URL("./fixtures/plandata/lokalplan.json", import.meta.url), "utf8"),
);
const folkFixture = JSON.parse(
  readFileSync(new URL("./fixtures/dst/folk1a.json", import.meta.url), "utf8"),
);

afterEach(() => {
  resetConfigForTests(undefined);
  vi.restoreAllMocks();
});

describe("gated sources", () => {
  it("returns missing_credentials for VUR without a Datafordeleren key", async () => {
    resetConfigForTests({
      adressevaelgerToken: "adressevaelger123",
      cachePath: ":memory:",
    });
    const result = await getValuation("10000000");
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("missing_credentials");
    }
  });

  it("returns missing_credentials for energy labels without EMOData", async () => {
    resetConfigForTests({
      adressevaelgerToken: "adressevaelger123",
      cachePath: ":memory:",
    });
    const result = await getEnergyLabel({ address: "Nørrebrogade 52, 2200 København N" });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("missing_credentials");
    }
  });
});

describe("plandata mapper", () => {
  it("parses a WFS fixture", async () => {
    vi.spyOn(http, "fetchJson").mockResolvedValue(planFixture);
    const result = await getPlansAt(724000, 6178000);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.items[0]?.name).toContain("Lokalplan");
      expect(result.data.items[0]?.pdfUrl).toMatch(/^https:/);
    }
  });
});

describe("dst", () => {
  it("never writes mocked responses to the user's cache", () => {
    resetConfigForTests(undefined);
    expect(getConfig().cachePath).toBe(":memory:");
  });

  it("parses Statbank JSON-stat", async () => {
    vi.spyOn(http, "fetchJson").mockResolvedValue(folkFixture);
    const result = await getAreaStatsForMunicipality("101");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.stats[0]?.value).toBe(661000);
      expect(result.data.municipalityName).toBe("Copenhagen");
    }
  });
});
