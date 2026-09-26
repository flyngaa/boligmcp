import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFlags } from "../src/analysis/flags.js";
import { resetConfigForTests } from "../src/config.js";
import { resetCacheForTests } from "../src/lib/cache.js";
import * as http from "../src/lib/http.js";
import { getHeritageAt, mapHeritageFeature } from "../src/sources/fbb.js";

afterEach(() => {
  resetConfigForTests(undefined);
  resetCacheForTests();
  vi.restoreAllMocks();
});

describe("FBB", () => {
  it("keeps SAVE 1–9 and listed buildings, and drops unassessed ones", () => {
    expect(mapHeritageFeature({ adresse: "Rådhuspladsen 59", bevaringsvaerdi: -1, fredet: false })).toBeUndefined();
    expect(
      mapHeritageFeature({ adresse: "Rådhuspladsen 57", bevaringsvaerdi: 1, fredet: true, fredningsstatus: 1 }),
    ).toEqual({
      address: "Rådhuspladsen 57",
      saveValue: 1,
      listed: true,
      listingStatus: 1,
    });
  });

  it("queries FBB with a WFS 1.1.0 box and no CRS suffix on the bbox", async () => {
    resetConfigForTests({ adressevaelgerToken: "adressevaelger123", cachePath: ":memory:" });
    const fetch = vi.spyOn(http, "fetchJson").mockResolvedValue({
      features: [
        { properties: { adresse: "Rådhuspladsen 59", bevaringsvaerdi: "-1", fredet: false } },
        { properties: { adresse: "Rådhuspladsen 57", bevaringsvaerdi: "1", fredet: "true", fredningsstatus: "1" } },
      ],
    });
    const result = await getHeritageAt(724448, 6175717);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.items).toEqual([
        { address: "Rådhuspladsen 57", saveValue: 1, listed: true, listingStatus: 1 },
      ]);
    }
    const urls = fetch.mock.calls.map((call) => String(call[0]));
    const layers = urls.map((url) => new URL(url).searchParams.get("typeName"));
    expect(layers).toEqual(["fbb:view_bygning_alle", "fbb:view_bygning_fredede"]);
    expect(new URL(urls[0]!).searchParams.get("VERSION")).toBe("1.1.0");
    expect(new URL(urls[0]!).searchParams.get("bbox")).toBe("724398,6175667,724498,6175767");
  });
});

describe("cadastral and SAVE flags", () => {
  it("flags fredskov and a high SAVE value", () => {
    const flags = buildFlags({
      parcels: [{ notes: ["Fredskov", "Majoratskov"] }],
      heritage: { items: [{ address: "Strandvejen 1", saveValue: 2 }] },
    });
    expect(flags.find((flag) => flag.id === "forest_reserve")).toMatchObject({ severity: "high", sources: ["matrikel"] });
    expect(flags.find((flag) => flag.id === "cadastral_note")?.detail).toBe("Majoratskov");
    expect(flags.find((flag) => flag.id === "save_value")).toMatchObject({
      severity: "high",
      title: "SAVE-bevaringsværdi 2",
      sources: ["fbb"],
    });
  });
});

describe("BBR listing codes", () => {
  it("flags listings and registered declarations as high, medieval parts and preservation value as medium", () => {
    const flag = (code: string) =>
      buildFlags({ buildings: [{ buildingId: "b", usage: "Hus", listingCode: code, listing: `kode ${code}` }] }).map((item) => `${item.id}:${item.severity}`);
    for (const code of ["1", "2", "3", "4", "6", "7"]) expect(flag(code)).toContain("listed_building:high");
    for (const code of ["5", "8", "9"]) {
      expect(flag(code)).toContain("worth_preserving:medium");
      expect(flag(code)).not.toContain("listed_building:high");
    }
  });
});
