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
    const result = await getEnergyLabel({ bfe: "3451115" });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("missing_credentials");
    }
  });

  it("reads the current energy label from SearchEnergyLabelBFE", async () => {
    resetConfigForTests({
      adressevaelgerToken: "adressevaelger123",
      cachePath: ":memory:",
      emodataUser: "user",
      emodataPassword: "secret",
    });
    const fetch = vi.spyOn(http, "fetchJson").mockResolvedValue({
      ResponseStatus: { Status: "RESULT_OK" },
      EnergyLabels: [
        { EnergyLabelClassification: "D", ValidFrom: "2014-01-01", ValidTo: "2024-01-01" },
        { EnergyLabelClassification: "C", ValidFrom: "2024-06-01", ValidTo: "2034-06-01", DEMOLink: "https://emoweb.dk/example" },
      ],
    });
    const result = await getEnergyLabel({ bfe: "3451115" });
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://emoweb.dk/emodata/emodata.svc/SearchEnergyLabelBFE/3451115");
    const headers = fetch.mock.calls[0]?.[1]?.headers;
    expect(headers?.authorization).toBe(`Basic ${Buffer.from("user:secret").toString("base64")}`);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.rating).toBe("C");
      expect(result.data.sharedLabel).toBe(true);
      expect(result.data.reportUrl).toBe("https://emoweb.dk/example");
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
