import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapIdLookup, mapSearchHit } from "../src/sources/adressevaelger.js";

describe("live Adressevælgeren fixtures", () => {
  it("maps the official fund/titel search payload", () => {
    const payload = JSON.parse(
      readFileSync(new URL("./fixtures/adressevaelger/search-live.json", import.meta.url), "utf8"),
    ) as { fund: Array<Parameters<typeof mapSearchHit>[0]> };
    const hits = payload.fund.map(mapSearchHit);
    expect(hits[0]?.type).toBe("address");
    expect(hits[0]?.designation).toContain("Rådhuspladsen 2");
    expect(hits[0]?.addressId).toMatch(/^[0-9a-f-]{36}$/);
    expect(hits[0]?.houseNumberId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("maps id lookup coordinates and municipality", () => {
    const payload = JSON.parse(
      readFileSync(new URL("./fixtures/adressevaelger/lookup-live.json", import.meta.url), "utf8"),
    ) as Parameters<typeof mapIdLookup>[0];
    const match = mapIdLookup(payload);
    expect(match.designation).toBe("Rådhuspladsen 2, 8000 Aarhus C");
    expect(match.municipalityCode).toBe("0751");
    expect(match.coordinate?.epsg25832.x).toBeCloseTo(574743.25);
    expect(match.coordinate?.wgs84.lat).toBeGreaterThan(56);
  });
});
