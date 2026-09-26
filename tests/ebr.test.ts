import { afterEach, describe, expect, it } from "vitest";
import { resetConfigForTests } from "../src/config.js";
import { resetCacheForTests } from "../src/lib/cache.js";
import { getPropertyLocation, mapPropertyLocation } from "../src/sources/datafordeler/ebr.js";

afterEach(() => {
  resetConfigForTests(undefined);
  resetCacheForTests();
});

describe("EBR", () => {
  it("uses the text designation when there is no street address", () => {
    expect(
      mapPropertyLocation({
        bestemtFastEjendomBFENr: "100",
        betegnelse: "Mark ved Dollerup",
        husnummerLokalId: null,
        kommuneinddelingKommunekode: "0791",
        status: "gældende",
      }),
    ).toEqual({
      bfe: "100",
      designation: "Mark ved Dollerup",
      hasStreetAddress: false,
      houseNumberId: undefined,
      addressId: undefined,
      municipalityCode: "0791",
      status: "gældende",
    });
  });

  it("keeps the husnummer when the property has a street address", () => {
    const location = mapPropertyLocation({
      bestemtFastEjendomBFENr: "3451115",
      betegnelse: null,
      husnummerLokalId: "0a3f5098-d61d-32b8-e044-0003ba298018",
    });
    expect(location.hasStreetAddress).toBe(true);
    expect(location.designation).toBeUndefined();
    expect(location.houseNumberId).toBe("0a3f5098-d61d-32b8-e044-0003ba298018");
  });

  it("says how to add the Datafordeleren key when it is missing", async () => {
    resetConfigForTests({ adressevaelgerToken: "adressevaelger123", cachePath: ":memory:" });
    const result = await getPropertyLocation("3451115");
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("missing_credentials");
      expect(result.detail).toContain("npx -y boligmcp setup");
    }
  });
});
