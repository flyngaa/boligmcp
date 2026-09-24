import { describe, expect, it } from "vitest";
import { listSourceStatus } from "../src/catalog.js";
import { resetConfigForTests, type AppConfig } from "../src/config.js";
import { bbrUsage, ownershipLabel } from "../src/lib/bbr-codes.js";
import { coordinateFromEtrs89, etrs89ToWgs84 } from "../src/lib/geo.js";
import { readFileSync } from "node:fs";
import { mapIdLookup, mapSearchHit } from "../src/sources/adressevaelger.js";

const searchFixture = JSON.parse(
  readFileSync(new URL("./fixtures/adressevaelger/search.json", import.meta.url), "utf8"),
) as { resultater: Array<Parameters<typeof mapSearchHit>[0]> };
const lookupFixture = JSON.parse(
  readFileSync(new URL("./fixtures/adressevaelger/lookup.json", import.meta.url), "utf8"),
) as Parameters<typeof mapIdLookup>[0];

const emptyConfig: AppConfig = {
  adressevaelgerToken: "adressevaelger123",
  cachePath: ":memory:",
};

describe("geo", () => {
  it("converts ETRS89/UTM32 to WGS84 near Copenhagen", () => {
    const { lat, lon } = etrs89ToWgs84(724568, 6175731);
    expect(lat).toBeGreaterThan(55);
    expect(lat).toBeLessThan(56);
    expect(lon).toBeGreaterThan(12);
    expect(lon).toBeLessThan(13);
    const coord = coordinateFromEtrs89(724568, 6175731);
    expect(coord.wgs84.lat).toBe(lat);
  });
});

describe("catalog", () => {
  it("marks Datafordeleren sources unconfigured without a key", () => {
    resetConfigForTests(emptyConfig);
    const status = listSourceStatus(emptyConfig);
    const dar = status.find((item) => item.id === "dar");
    expect(dar?.configured).toBe(false);
    expect(dar?.missingEnv).toContain("DATAFORDELER_API_KEY");
    const adv = status.find((item) => item.id === "adressevaelger");
    expect(adv?.configured).toBe(true);
    expect(status.find((item) => item.id === "plandata")?.configured).toBe(true);
    expect(status.find((item) => item.id === "emodata")?.configured).toBe(false);
  });
});

describe("adressevaelger fixtures", () => {
  it("maps search hits", () => {
    const hits = searchFixture.resultater.map(mapSearchHit);
    expect(hits[0]?.type).toBe("address");
    expect(hits[0]?.addressId).toBe("0a3f50b8-aaaa-bbbb-cccc-000000000001");
    expect(hits[0]?.floor).toBe("4");
    expect(hits[1]?.type).toBe("house_number");
  });

  it("maps id lookup including coordinates and kommune", () => {
    const match = mapIdLookup(lookupFixture);
    expect(match.addressId).toBe("0a3f50b8-aaaa-bbbb-cccc-000000000001");
    expect(match.municipalityCode).toBe("101");
    expect(match.coordinate?.epsg25832.x).toBeCloseTo(724000.12);
    expect(match.coordinate?.wgs84.lat).toBeGreaterThan(55);
  });
});

describe("bbr codes", () => {
  it("translates common codes", () => {
    expect(bbrUsage("140")).toMatch(/Etage/i);
    expect(ownershipLabel("50")).toMatch(/kommune/i);
  });
});
