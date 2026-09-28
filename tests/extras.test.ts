import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFlags } from "../src/analysis/flags.js";
import { parseOutlines, ringArea } from "../src/sources/datafordeler/geodanmark.js";
import { summarizeNearby } from "../src/sources/datafordeler/nearby.js";
import { jsonStatCell, marketCategoryFor } from "../src/sources/dst.js";
import * as report from "../src/tools/property-report.js";
import { checkWatchlist, diffSnapshots, listWatchlist, mergeSnapshots, unwatchProperty, watchProperty, type WatchSnapshot } from "../src/tools/watch.js";

afterEach(() => {
  delete process.env.BOLIGMCP_WATCHLIST_FILE;
  vi.restoreAllMocks();
});

describe("JSON-stat cells", () => {
  // Shape of Statistikbanken's EJ56 answer for Vestjylland houses, TAL × Tid.
  const ej56 = {
    dataset: {
      dimension: {
        id: ["OMRÅDE", "EJENDOMSKATE", "TAL", "Tid"],
        size: [1, 1, 2, 2],
        OMRÅDE: { category: { index: { "10": 0 } } },
        EJENDOMSKATE: { category: { index: { "0111": 0 } } },
        TAL: { category: { index: { "100": 0, "310": 1 } } },
        Tid: { category: { index: { "2021K1": 0, "2026K1": 1 } } },
      },
      value: [98.7, 103.8, 7.9, 2.5],
    },
  };
  it("finds values by category, not by position", () => {
    expect(jsonStatCell(ej56, { TAL: "100", Tid: "2026K1" })).toBe(103.8);
    expect(jsonStatCell(ej56, { TAL: "310", Tid: "2026K1" })).toBe(2.5);
    expect(jsonStatCell(ej56, { TAL: "310" })).toBeNull(); // Tid is ambiguous
  });
  it("maps BBR usage to the market category", () => {
    expect(marketCategoryFor("120")).toBe("house");
    expect(marketCategoryFor("140")).toBe("apartment");
    expect(marketCategoryFor("120", true)).toBe("apartment");
    expect(marketCategoryFor("510")).toBe("summer_house");
  });
});

describe("nearby services", () => {
  it("takes the nearest per category and skips ended buildings", () => {
    const at = (x: number, code: string, status = "6") => ({ status, byg021BygningensAnvendelse: code, byg404Koordinat: { wkt: `POINT (${x} 0)` } });
    const result = summarizeNearby(
      0,
      0,
      [at(700, "421"), at(240, "421"), at(90, "441", "10"), at(120, "441", "9"), at(1500, "441"), at(2600, "322")],
      false,
    );
    const byCategory = Object.fromEntries(result.items.map((item) => [item.category, item]));
    expect(byCategory.school).toMatchObject({ nearestM: 240, within1km: 2 });
    expect(byCategory.daycare).toMatchObject({ nearestM: 1500, within1km: 0 });
    expect(byCategory.retail?.nearestM).toBeNull(); // beyond the 2 km radius
  });
});

describe("GeoDanmark outlines", () => {
  it("computes area from 3D rings and reads the BBR link", () => {
    expect(ringArea("0 0 5 10 0 5 10 8 5 0 8 5 0 0 5", 3)).toBe(80);
    const gml = `<wfs:member><gdk60:Bygning gml:id="a"><gdk60:BBRUUID>b1</gdk60:BBRUUID><gdk60:maalestedBygning>Tag</gdk60:maalestedBygning>
      <gml:Polygon srsDimension="3"><gml:exterior><gml:LinearRing><gml:posList srsDimension="3">0 0 1 12 0 1 12 8 1 0 8 1 0 0 1</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gdk60:Bygning></wfs:member>`;
    expect(parseOutlines(gml)).toEqual([{ bbrId: "b1", measuredAt: "Tag", area: 96, ring: [[0, 0], [12, 0], [12, 8], [0, 8], [0, 0]] }]);
  });
  it("flags only differences roof overhang cannot explain", () => {
    const buildings = [{ buildingId: "h", usage: "Fritliggende enfamiliehus" }, { buildingId: "c", usage: "Carport" }];
    const flags = (footprints: Array<{ buildingId: string; footprintM2: number; bbrBuiltAreaM2: number; differenceM2: number }>) =>
      buildFlags({ buildings, footprints }).filter((flag) => flag.id === "footprint_larger_than_bbr");
    expect(flags([{ buildingId: "h", footprintM2: 96, bbrBuiltAreaM2: 85, differenceM2: 11 }])).toHaveLength(0);
    const hit = flags([{ buildingId: "h", footprintM2: 150, bbrBuiltAreaM2: 85, differenceM2: 65 }]);
    expect(hit[0]?.detail).toMatch(/Fritliggende enfamiliehus: målt ca\. 150 m² mod 85 m²/);
  });
});

describe("watchlist", () => {
  const base: WatchSnapshot = {
    takenAt: "2026-01-01T00:00:00Z",
    valuation: { year: 2020, propertyValue: 2_028_000, landValue: 867_000, system: "new" },
    plans: ["municipal_framework:11336342", "zone:Byzone"],
    proposals: [],
    buildings: [{ id: "b1", usage: "Fritliggende enfamiliehus", builtArea: 85, lastRevised: "2017-05-08" }],
    dwellingArea: 144,
    tenure: "Benyttet af ejeren",
    flags: ["medium: Gasopvarmning"],
  };

  it("never reads a source that failed as a removal, and keeps the old values for it", () => {
    // Plandata and BBR timed out during the check: their parts came back empty.
    const failed: WatchSnapshot = { ...base, plans: [], buildings: [], flags: [], dwellingArea: null, unknown: ["plans", "buildings", "flags"] };
    expect(diffSnapshots(base, failed)).toEqual([]);
    const merged = mergeSnapshots(base, failed);
    expect(merged).toMatchObject({ plans: base.plans, buildings: base.buildings, flags: base.flags, dwellingArea: 144 });
    expect(merged.unknown).toBeUndefined();
    // A real change in a part that answered is still reported.
    expect(diffSnapshots(base, { ...failed, valuation: { ...base.valuation!, year: 2022, propertyValue: 2_419_000 } })).toEqual([
      expect.stringMatching(/Ny offentlig vurdering 2022/),
    ]);
  });

  it("describes changes in plain Danish and nothing when nothing changed", () => {
    expect(diffSnapshots(base, { ...base, takenAt: "later" })).toEqual([]);
    const changes = diffSnapshots(base, {
      ...base,
      valuation: { year: 2022, propertyValue: 2_419_000, landValue: 998_000, system: "new" },
      proposals: ["local_plan_proposal:1|Lokalplan for Egevænget"],
      buildings: [...base.buildings, { id: "b9", usage: "Carport", builtArea: 30 }],
      tenure: "Udlejet",
      flags: [],
    });
    expect(changes).toEqual([
      "Ny offentlig vurdering 2022: 2.419.000 kr. (grund 998.000 kr.), før 2020: 2.028.000 kr.",
      "Nyt planforslag: Lokalplan for Egevænget",
      "Ny bygning i BBR: Carport (30 m²)",
      "Benyttelse ændret: Benyttet af ejeren → Udlejet",
      "Signal forsvundet: medium: Gasopvarmning",
    ]);
  });

  it("adds, checks, updates and removes entries in the user's file", async () => {
    process.env.BOLIGMCP_WATCHLIST_FILE = join(mkdtempSync(join(tmpdir(), "boligmcp-watch-")), "watchlist.json");
    let valuation = 2_028_000;
    vi.spyOn(report, "collectPropertyData").mockImplementation(async () => ({
      idsResult: { status: "ok", source: "dar", fetchedAt: "", data: { bfe: "3451459", designation: "Egeskovvej 41, 8800 Viborg" } },
      ids: { bfe: "3451459", designation: "Egeskovvej 41, 8800 Viborg" },
      valuation: { status: "ok", source: "vur", fetchedAt: "", data: { bfe: "3451459", history: [], latestNew: { year: 2020, propertyValue: valuation, system: "new" } } },
    }));
    expect(await watchProperty("Egeskovvej 41, 8800 Viborg", "test")).toMatchObject({ id: "3451459", alreadyWatched: false });
    expect(listWatchlist()).toEqual([expect.objectContaining({ id: "3451459", note: "test" })]);

    valuation = 2_419_000;
    const first = await checkWatchlist();
    expect(first.changed).toBe(1);
    expect(first.results[0]?.changes?.[0]).toMatch(/2\.419\.000 kr\./);
    expect((await checkWatchlist()).changed).toBe(0); // baseline was updated

    expect(unwatchProperty("3451459")).toEqual({ removed: 1, remaining: 0 });
  });
});
