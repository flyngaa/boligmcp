import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applicablePlotRatio, buildFlags, countedFloorArea, type FlagInput } from "../src/analysis/flags.js";
import { resetCacheForTests } from "../src/lib/cache.js";
import { resetConfigForTests } from "../src/config.js";
import {
  bbrFuel,
  bbrLabel,
  bbrRoof,
  bbrSupplementaryHeat,
  bbrWall,
  isOutbuilding,
  ownershipLabel,
} from "../src/lib/bbr-codes.js";
import * as http from "../src/lib/http.js";
import { getBuildingsAndUnits, mapValuationRows } from "../src/sources/datafordeler/registers.js";
import { dstMunicipalityCode } from "../src/sources/dst.js";
import { getEnvironmentAt } from "../src/sources/miljoportal.js";
import { getPlansAt, getSiteConditionsAt, mapPlanFeature, planDate } from "../src/sources/plandata.js";
import * as report from "../src/tools/property-report.js";
import { screenProperties } from "../src/tools/screen.js";
import type { Building, PlanItem } from "../src/types.js";

const fixture = (path: string) => JSON.parse(readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8"));

const vurRows = fixture("vur/egeskovvej-41.json") as Array<Record<string, unknown>>;
const frameworkGeo = fixture("plandata/kommuneplanramme-hald-ege.json") as {
  features: Array<{ properties: Record<string, unknown> }>;
};
const soilGeo = fixture("miljoportal/v1-oerum.json");

const memoryConfig = { adressevaelgerToken: "adressevaelger123", cachePath: ":memory:", datafordelerApiKey: "test-key" };

afterEach(() => {
  resetConfigForTests(undefined);
  resetCacheForTests();
  vi.restoreAllMocks();
});

// Egeskovvej 41, 8800 Viborg as the registers returned it on 24 September 2026.
const house: Building = {
  buildingId: "7aa1f380",
  usageCode: "120",
  usage: "Fritliggende enfamiliehus",
  constructionYear: 1952,
  builtArea: 85,
  totalArea: 85,
  dwellingArea: 144,
  floors: 1,
  roofMaterialCode: "5",
  outerWallCode: "1",
  heatingCode: "2",
  heating: "Centralvarme med én fyringsenhed",
  heatingFuelCode: "7",
  heatingFuel: "Naturgas",
  floorDetails: [
    { designation: "st", typeCode: "0", totalArea: null },
    { designation: "kl", typeCode: "2", totalArea: 81, basementArea: 81 },
    { designation: "01", typeCode: "1", totalArea: 59, usedAtticArea: 59 },
  ],
};
const carport: Building = { buildingId: "8ae5b802", usageCode: "920", usage: "Carport", constructionYear: 2005, builtArea: 42 };

function frameworkItem(): PlanItem {
  return mapPlanFeature(frameworkGeo.features[0]!, "municipal_framework", {
    specific: new Map([[1110, "Åben-lav boligbebyggelse"]]),
    zone: new Map(),
  });
}

function egeskovInput(overrides: Partial<FlagInput> = {}): FlagInput {
  return {
    buildings: [house, carport],
    units: [{ unitId: "u1", dwellingArea: 144, tenureCode: "2" }],
    ground: { waterSupplyCode: "1", drainageCode: "9" },
    parcels: [{ cadastralDistrictCode: "750353", cadastralNumber: "1gf", registeredArea: 811 }],
    valuation: mapValuationRows("3451459", vurRows),
    plans: {
      items: [frameworkItem(), { type: "zone", zoneStatus: "Byzone" }],
      nearby: [{ type: "local_plan", name: "Område til boligformål og almen service ved Egevænget i Hald Ege", withinM: 40 }],
    },
    site: {
      items: [
        { category: "heat_supply_area", label: "Varmeforsyningsområde", value: "Fjernvarme", details: "Viborg Varme A.m.b.a." },
        { category: "planned_technical_facility", label: "Planlagt teknisk anlæg", value: "Negativt område for vindmøller" },
        { category: "planned_technical_facility", label: "Planlagt teknisk anlæg", value: "Neutrale områder solenergi" },
      ],
      checkedLayers: 16,
      failedLayers: [],
    },
    environment: { items: [] },
    ...overrides,
  };
}

describe("BBR code lists", () => {
  it("uses the official Danish labels", () => {
    expect(bbrRoof("2")).toBe("Tagpap med stor hældning");
    expect(bbrRoof("3")).toMatch(/asbest/);
    expect(bbrWall("5")).toBe("Træ");
    expect(bbrFuel("7")).toBe("Naturgas");
    expect(ownershipLabel("30")).toMatch(/selskab/);
  });

  it("strips the UDFASES marker and reports unknown codes plainly", () => {
    expect(bbrSupplementaryHeat("90")).toBe("Bygningen har ingen supplerende varme");
    expect(bbrLabel("Tagdaekningsmateriale", "999")).toBe("Ukendt kode 999");
    expect(bbrLabel("BygAnvendelse", "0120")).toBe("Fritliggende enfamiliehus");
  });

  it("recognises outbuildings", () => {
    expect(isOutbuilding("920")).toBe(true);
    expect(isOutbuilding("120")).toBe(false);
  });
});

describe("VUR history", () => {
  it("keeps the full history, drops duplicate years and separates the new system", () => {
    const valuation = mapValuationRows("3451459", vurRows);
    expect(valuation.history).toHaveLength(22); // 23 rows, one identical 2003 duplicate
    expect(valuation.latest).toMatchObject({ year: 2022, propertyValue: 2419000, system: "new" });
    expect(valuation.latestNew?.valuedArea).toBe(811);
    expect(valuation.latestOld).toMatchObject({ year: 2020, propertyValue: 1750000, system: "old" });
  });

  it("never reports a zero valuation as latest", () => {
    const valuation = mapValuationRows("1", [
      { id: 300000000000002, aar: 2022, ejendomvaerdiBeloeb: 0, grundvaerdiBeloeb: 0 },
      { id: 965000000000001, aar: 2019, ejendomvaerdiBeloeb: 900000, grundvaerdiBeloeb: 200000 },
    ]);
    expect(valuation.latestNew).toBeUndefined();
    expect(valuation.latest?.year).toBe(2019);
    expect(valuation.history).toHaveLength(2);
  });
});

describe("VUR systems", () => {
  it("tells new-system ids from old ones with another prefix", () => {
    // Brandelev Stationsvej 10, 4700 Næstved: old-system ids start with 386 and 403.
    const valuation = mapValuationRows("2564655", [
      { id: 403005860015631, aar: 2001, ejendomvaerdiBeloeb: 560000, grundvaerdiBeloeb: 122100 },
      { id: 386202818985623, aar: 2020, ejendomvaerdiBeloeb: 720000, grundvaerdiBeloeb: 340100 },
      { id: 600000000444014, aar: 2020, ejendomvaerdiBeloeb: 751000, grundvaerdiBeloeb: 292000 },
      { id: 600000000857918, aar: 2022, ejendomvaerdiBeloeb: 1065000, grundvaerdiBeloeb: 424000 },
    ]);
    expect(valuation.history.map((item) => `${item.year}:${item.system}`)).toEqual(["2022:new", "2020:new", "2020:old", "2001:old"]);
    expect(valuation.latestOld?.propertyValue).toBe(720000);
  });
});

describe("Plandata", () => {
  it("parses dates and structured building rights from a real framework", () => {
    expect(planDate(20250521)).toBe("2025-05-21");
    expect(planDate(null)).toBeUndefined();
    const framework = frameworkItem();
    expect(framework.planNumber).toBe("HALD.B1.01");
    expect(framework.specificUsages?.[0]).toMatchObject({ code: 1110, maxPlotRatioPct: 30, maxFloors: 2, maxHeightM: 8.5 });
    expect(framework.buildingNotes).toMatch(/40 %/);
  });

  it("reports only plans covering the point as items and the rest as nearby", async () => {
    resetConfigForTests(memoryConfig);
    const localPlan = { features: [{ properties: { planid: 9639958, plannavn: "Egevænget" } }] };
    vi.spyOn(http, "fetchJson").mockImplementation(async (url: string) => {
      const u = decodeURIComponent(url);
      if (u.includes("lokalplan_vedtaget") && u.includes("bbox=")) return localPlan;
      if (u.includes("kommuneplanramme_vedtaget_v") && u.includes("CQL_FILTER")) return frameworkGeo;
      return { features: [] };
    });
    const result = await getPlansAt(521752.91, 6251216.77, { lookupPoint: "building" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // No zone polygon covers the point, so it is landzone.
    expect(result.data.items.map((item) => item.type)).toEqual(["municipal_framework", "zone"]);
    expect(result.data.items[1]).toMatchObject({ zoneStatus: "Landzone" });
    expect(buildFlags({ plans: result.data }).map((flag) => flag.id)).toContain("rural_zone");
    expect(result.data.nearby).toEqual([expect.objectContaining({ planId: "9639958", withinM: 40 })]);
    expect(result.data.lookupPoint).toBe("building");
  });

  it("maps site layers and records layers that fail", async () => {
    resetConfigForTests(memoryConfig);
    vi.spyOn(http, "fetchJson").mockImplementation(async (url: string) => {
      if (url.includes("forsyningomraade")) {
        return { features: [{ properties: { vaerdi1203: "Fjernvarme", forsytekst: "Viborg Varme A.m.b.a." } }] };
      }
      if (url.includes("stoejbelastetareal")) throw new Error("HTTP 500");
      return { features: [] };
    });
    const result = await getSiteConditionsAt(1, 2);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.items).toEqual([
      expect.objectContaining({ category: "heat_supply_area", value: "Fjernvarme", details: "Viborg Varme A.m.b.a." }),
    ]);
    expect(result.data.failedLayers).toEqual(["pdk:theme_pdk_stoejbelastetareal_vedtaget"]);
  });
});

describe("Miljøportal soil", () => {
  it("marks a locality nearby unless the point is inside it or it lists the parcel", async () => {
    resetConfigForTests(memoryConfig);
    vi.spyOn(http, "fetchJson").mockImplementation(async (url: string) =>
      url.includes("View_V1Flader") && url.includes("bbox=") ? soilGeo : { features: [] },
    );
    const nearby = await getEnvironmentAt(538435.91, 6259867.64, [{ cadastralDistrictCode: "771654", cadastralNumber: "12a" }]);
    expect(nearby.status === "ok" && nearby.data.items[0]).toMatchObject({ name: "DK BENZIN", onProperty: false });

    resetCacheForTests();
    const listed = await getEnvironmentAt(538435.91, 6259867.64, [{ cadastralDistrictCode: "771654", cadastralNumber: "7N" }]);
    expect(listed.status === "ok" && listed.data.items[0]?.onProperty).toBe(true);
  });
});

describe("investor flags", () => {
  it("reads Egeskovvej 41 correctly", () => {
    const flags = buildFlags(egeskovInput());
    const byId = Object.fromEntries(flags.map((flag) => [flag.id, flag]));
    expect(byId.gas_heating?.severity).toBe("medium");
    expect(byId.gas_heating?.detail).toMatch(/fjernvarme.*Viborg Varme/);
    expect(byId.area_composition?.detail).toMatch(/59 m² udnyttet tagetage.*kælder på 81 m²/);
    expect(byId.no_local_plan?.detail).toMatch(/Egevænget/);
    expect(byId.building_rights?.title).toBe("Indikativ restbyggeret ca. 99 m²");
    expect(byId.building_rights?.detail).toMatch(/17,8 %/);
    expect(byId.valuation_new?.title).toBe("Ny offentlig vurdering 2022");
    expect(byId.asbestos_era?.severity).toBe("info");
    // "Negativt område for vindmøller" means turbines are not allowed there: not a risk.
    expect(byId.planned_technical_facility).toBeUndefined();
    expect(flags.some((flag) => flag.severity === "high")).toBe(false);
  });

  it("orders flags high, medium, info and raises the hard risks", () => {
    const flags = buildFlags(
      egeskovInput({
        buildings: [{ ...house, roofMaterialCode: "3", roofMaterial: "Fibercement herunder asbest", heatingFuelCode: "3", heatingFuel: "Flydende brændsel", listingCode: "8", listing: "Bygningen bevaringsværdig", floodCompensationCode: "3" }],
        units: [{ unitId: "u1", tenureCode: "1" }],
        ground: { waterSupplyCode: "4", waterSupply: "Brønd", drainageCode: "20", drainage: "Afløb til samletank" },
        environment: {
          items: [
            { category: "soil_v2", name: "Tidligere smedje", onProperty: true },
            { category: "soil_v1", name: "Tankstation", onProperty: false },
          ],
        },
      }),
    );
    const ids = flags.map((flag) => flag.id);
    for (const id of ["asbestos_registered", "oil_heating", "flood_compensation", "soil_contamination"]) {
      expect(flags.find((flag) => flag.id === id)?.severity).toBe("high");
    }
    for (const id of ["worth_preserving", "existing_tenancy", "private_water", "private_drainage"]) {
      expect(flags.find((flag) => flag.id === id)?.severity).toBe("medium");
    }
    expect(flags.find((flag) => flag.id === "soil_contamination_nearby")?.severity).toBe("info");
    const rank = { high: 0, medium: 1, info: 2 };
    const severities = flags.map((flag) => rank[flag.severity]);
    expect(severities).toEqual([...severities].sort((a, b) => a - b));
    expect(ids).not.toContain("asbestos_era");
  });

  it("tones the sewer flag down when BBR already has the planned drainage", () => {
    const site = (details: string) => ({
      items: [{ category: "sewer_catchment" as const, label: "Kloakopland", value: "Ukloakeret", details }],
      checkedLayers: 1,
      failedLayers: [],
    });
    const separat = { drainageCode: "5", drainage: "Separatkloakeret: spildevand + tag- og overfladevand" };
    const done = buildFlags({ site: site("Opland · planlagt: Separatkloakeret · slutår 2025"), ground: separat });
    expect(done.find((flag) => flag.id === "planned_sewer_change")).toMatchObject({ severity: "info", title: "Spildevandsplanen er ikke opdateret" });

    const pending = buildFlags({
      site: site("Opland · planlagt: Separatkloakeret · slutår 2020"),
      ground: { drainageCode: "1", drainage: "Fælleskloakeret: spildevand + tag- og overfladevand" },
    });
    const flag = pending.find((item) => item.id === "planned_sewer_change");
    expect(flag?.severity).toBe("medium");
    expect(flag?.detail).toMatch(/Slutåret er passeret/);
  });

  it("describes a private waterworks differently from an own well", () => {
    const works = buildFlags({ ground: { waterSupplyCode: "2", waterSupply: "Privat vandforsyningsanlæg" } });
    expect(works.find((flag) => flag.id === "private_water")).toMatchObject({ severity: "info", title: "Privat vandforsyning" });
    expect(works.find((flag) => flag.id === "private_water")?.detail).toMatch(/forbrugerejet vandværk/);
    const well = buildFlags({ ground: { waterSupplyCode: "4", waterSupply: "Brønd" } });
    expect(well.find((flag) => flag.id === "private_water")).toMatchObject({ severity: "medium", title: "Egen vandforsyning" });
  });

  it("finds a basement whose area is only in the floor total", () => {
    const building = { ...house, floorDetails: [{ designation: "kl", typeCode: "2", totalArea: 22, basementArea: null }] };
    const flag = buildFlags({ buildings: [building] }).find((item) => item.id === "area_composition");
    expect(flag?.detail).toMatch(/kælder på 22 m²/);
  });

  it("counts used attic space and ignores outbuildings in the plot ratio", () => {
    expect(countedFloorArea([house, carport])).toBe(144);
    expect(applicablePlotRatio(frameworkItem(), "120")).toEqual({ pct: 30, basis: "Åben-lav boligbebyggelse" });
    expect(applicablePlotRatio(undefined, "120")).toBeUndefined();
  });
});

describe("BBR fetch", () => {
  it("adds outbuildings on the same ground, drops historic rows and maps floors", async () => {
    resetConfigForTests(memoryConfig);
    const nodes: Record<string, Array<Record<string, unknown>>> = {
      DAR_Adresse: [{ husnummer: "hn1" }],
      BBR_Bygning_husnummer: [{ id_lokalId: "b1", status: "6", grund: "g1", byg021BygningensAnvendelse: "120", byg026Opfoerelsesaar: 1952, byg057Opvarmningsmiddel: "7", byg058SupplerendeVarme: "90", byg404Koordinat: { wkt: "POINT (521752.91 6251216.77)" } }],
      BBR_Bygning_grund: [
        { id_lokalId: "b1", status: "6", grund: "g1", byg021BygningensAnvendelse: "120" },
        { id_lokalId: "b2", status: "6", grund: "g1", byg021BygningensAnvendelse: "920", byg026Opfoerelsesaar: 2005, byg032YdervaeggensMateriale: "5" },
        { id_lokalId: "b3", status: "10", grund: "g1", byg021BygningensAnvendelse: "930" },
      ],
      BBR_Etage: [{ eta006BygningensEtagebetegnelse: "01", eta021ArealAfUdnyttetDelAfTagetage: 59, eta025Etagetype: "1" }],
      BBR_Enhed: [
        { id_lokalId: "u1", status: "6", enh027ArealTilBeboelse: 144, enh045Udlejningsforhold: "2", enh032Toiletforhold: "T", enh034Koekkenforhold: "E" },
        { id_lokalId: "u0", status: "11", enh027ArealTilBeboelse: 144, enh045Udlejningsforhold: "1" },
      ],
      BBR_Grund: [{ id_lokalId: "g1", gru009Vandforsyning: "1", gru010Afloebsforhold: "9" }],
    };
    vi.spyOn(http, "fetchJson").mockImplementation(async (_url: string, options?: http.FetchJsonOptions) => {
      const query = (options?.body as { query: string }).query;
      const entity = query.match(/(DAR_Adresse|BBR_Bygning|BBR_Etage|BBR_Enhed|BBR_Grund)\(/)?.[1] ?? "";
      const key = entity === "BBR_Bygning" ? (query.includes("where: {grund:") ? "BBR_Bygning_grund" : "BBR_Bygning_husnummer") : entity;
      const rows = entity === "BBR_Etage" && !query.includes('"b1"') ? [] : nodes[key] ?? [];
      return { data: { [entity]: { nodes: rows } } };
    });

    const result = await getBuildingsAndUnits({ bfe: "3451459", addressId: "a1" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const [main, outbuilding, ...rest] = result.data.buildings;
    expect(rest).toHaveLength(0);
    expect(main).toMatchObject({ usage: "Fritliggende enfamiliehus", heatingFuel: "Naturgas", supplementaryHeat: "Bygningen har ingen supplerende varme" });
    expect(main?.coordinate?.epsg25832).toEqual({ x: 521752.91, y: 6251216.77 });
    expect(main?.floorDetails?.[0]).toMatchObject({ type: "Tagetage", usedAtticArea: 59 });
    expect(outbuilding).toMatchObject({ usage: "Carport", outerWall: "Træ" });
    expect(result.data.units).toHaveLength(1);
    expect(result.data.units[0]).toMatchObject({ dwellingArea: 144, tenure: "Benyttet af ejeren", toilet: true, kitchen: true });
    expect(result.data.ground).toMatchObject({ waterSupply: "Alment vandforsyningsanlæg", drainage: "Spildevandskloakeret: Spildevand" });
  });
});

describe("Danmarks Statistik", () => {
  it("gives up on slow statistics after the deadline", async () => {
    vi.useFakeTimers();
    try {
      const slow = new Promise<string>(() => {});
      const result = report.withDeadline(slow, 15_000, () => "timeout");
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(result).resolves.toBe("timeout");
      await expect(report.withDeadline(Promise.resolve("ok"), 15_000, () => "timeout")).resolves.toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalises four-digit municipality codes", () => {
    expect(dstMunicipalityCode("0791")).toBe("791");
    expect(dstMunicipalityCode("101")).toBe("101");
  });
});

describe("screen_properties", () => {
  it("dedupes, keeps input order and reports failures per row", async () => {
    vi.spyOn(report, "collectPropertyData").mockImplementation(async (input) => {
      if (input.query === "Findes ikke 1") {
        return { idsResult: { status: "unavailable", source: "adressevaelger", reason: "not_found", detail: "No match" } };
      }
      return {
        idsResult: { status: "ok", source: "dar", fetchedAt: "", data: { designation: input.query, bfe: "1" } },
        ids: { designation: input.query, bfe: "1" },
        buildings: { status: "ok", source: "bbr", fetchedAt: "", data: { buildings: [house], units: [{ dwellingArea: 144 }] } },
        valuation: { status: "ok", source: "vur", fetchedAt: "", data: mapValuationRows("1", vurRows) },
      };
    });
    const result = await screenProperties(["Egeskovvej 41, 8800 Viborg", "Findes ikke 1", " Egeskovvej 41, 8800 Viborg "]);
    expect(result.screened).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.rows[0]).toMatchObject({ designation: "Egeskovvej 41, 8800 Viborg", valuationPerDwellingM2: 16799 });
    expect(result.rows[0]).toHaveProperty("flags", ["medium: Gasopvarmning"]);
    expect(result.rows[1]).toEqual({ query: "Findes ikke 1", error: "No match" });
  });
});
