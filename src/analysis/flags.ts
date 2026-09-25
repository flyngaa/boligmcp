import { ASBESTOS_MATERIAL_CODES, isOutbuilding } from "../lib/bbr-codes.js";
import type {
  Building,
  EnvironmentInfo,
  Flag,
  Footprint,
  Ground,
  HeritageInfo,
  Parcel,
  PlanInfo,
  PlanItem,
  SiteConditions,
  SourceResult,
  TerrainInfo,
  Trade,
  Unit,
  Valuation,
} from "../types.js";

/** Everything the rules look at. Each part is optional so flags work with whatever sources answered. */
export interface FlagInput {
  trades?: Trade[];
  terrain?: TerrainInfo;
  footprints?: Footprint[];
  buildings?: Building[];
  units?: Unit[];
  ground?: Ground;
  parcels?: Parcel[];
  valuation?: Valuation;
  plans?: PlanInfo;
  site?: SiteConditions;
  environment?: EnvironmentInfo;
  heritage?: HeritageInfo;
}

export function flagInputFrom(results: {
  buildings?: SourceResult<{ buildings: Building[]; units: Unit[]; ground?: Ground }>;
  parcel?: SourceResult<Parcel[]>;
  valuation?: SourceResult<Valuation>;
  plans?: SourceResult<PlanInfo>;
  site?: SourceResult<SiteConditions>;
  environment?: SourceResult<EnvironmentInfo>;
  heritage?: SourceResult<HeritageInfo>;
  trades?: SourceResult<Trade[]>;
  terrain?: SourceResult<TerrainInfo>;
  footprints?: SourceResult<Footprint[]>;
}): FlagInput {
  const data = <T>(result?: SourceResult<T>) => (result?.status === "ok" ? result.data : undefined);
  const bbr = data(results.buildings);
  return {
    buildings: bbr?.buildings,
    units: bbr?.units,
    ground: bbr?.ground,
    parcels: data(results.parcel),
    valuation: data(results.valuation),
    plans: data(results.plans),
    site: data(results.site),
    environment: data(results.environment),
    heritage: data(results.heritage),
    trades: data(results.trades),
    terrain: data(results.terrain),
    footprints: data(results.footprints),
  };
}

const kr = (value: number) => `${Math.round(value).toLocaleString("da-DK")} kr.`;
const m2 = (value: number) => `${Math.round(value).toLocaleString("da-DK")} m²`;
const pct = (value: number) => `${value.toLocaleString("da-DK", { maximumFractionDigits: 1 })} %`;

// Municipal energy zoning marks areas as negative (not allowed), neutral or positive for wind and solar.
// Only positive zones and actual facilities say something may be built near the property.
const isExclusionZone = (text: string | undefined) => /^(negativ|neutral)/i.test(text?.trim() ?? "");

// Terrain thresholds in metres DVR90. Danish 100-year storm surges reach roughly 1.5–2.5 m.
const LOW_TERRAIN_HIGH_M = 1.5;
const LOW_TERRAIN_M = 2.5;
/** Outline minus BBR built area must exceed both to be flagged (overhang is 10–20 %). */
const FOOTPRINT_EXTRA_M2 = 20;
const FOOTPRINT_EXTRA_SHARE = 0.3;
/** How far below the surrounding median terrain counts as a hollow. */
const DEPRESSION_M = -1.5;

// Asbestos was banned in Danish building materials from 1986.
const ASBESTOS_BAN_YEAR = 1986;

// Plandata specific-usage codes that match a BBR main-building usage.
const USAGE_TO_PLAN: Array<{ bbr: RegExp; plan: number[] }> = [
  { bbr: /^(110|120|121|122)$/, plan: [1110, 1100] },
  { bbr: /^(130|131|132)$/, plan: [1120, 1100] },
  { bbr: /^(140)$/, plan: [1130, 1100] },
];

/** Floor area that counts towards the plot ratio: main buildings only, basements excluded. */
export function countedFloorArea(buildings: Building[]): number {
  return buildings
    .filter((building) => !isOutbuilding(building.usageCode))
    .reduce((sum, building) => {
      // BBR's total building area can leave out a used attic, while dwelling area includes it; take the larger.
      const direct = Math.max(building.totalArea ?? 0, (building.dwellingArea ?? 0) + (building.commercialArea ?? 0));
      const fallback = (building.builtArea ?? 0) * (building.floors ?? 1);
      return sum + (direct || fallback);
    }, 0);
}

export function applicablePlotRatio(
  framework: PlanItem | undefined,
  mainUsageCode: string | undefined,
): { pct: number; basis: string } | undefined {
  if (!framework) return undefined;
  const wanted = USAGE_TO_PLAN.find((rule) => mainUsageCode && rule.bbr.test(mainUsageCode))?.plan ?? [];
  for (const code of wanted) {
    const match = framework.specificUsages?.find((usage) => usage.code === code && usage.maxPlotRatioPct);
    if (match?.maxPlotRatioPct) return { pct: match.maxPlotRatioPct, basis: match.label ?? `anvendelse ${code}` };
  }
  if (framework.maxPlotRatioPct) return { pct: framework.maxPlotRatioPct, basis: "rammens generelle bestemmelse" };
  const first = framework.specificUsages?.find((usage) => usage.maxPlotRatioPct);
  return first?.maxPlotRatioPct ? { pct: first.maxPlotRatioPct, basis: first.label ?? "første anvendelse" } : undefined;
}

export function buildFlags(input: FlagInput): Flag[] {
  const flags: Flag[] = [];
  const add = (flag: Flag) => flags.push(flag);
  const buildings = input.buildings ?? [];
  const main = buildings.find((building) => !isOutbuilding(building.usageCode)) ?? buildings[0];
  const site = input.site?.items ?? [];

  // Asbestos
  const asbestos = buildings.filter(
    (b) =>
      ASBESTOS_MATERIAL_CODES.has(b.roofMaterialCode ?? "") ||
      ASBESTOS_MATERIAL_CODES.has(b.outerWallCode ?? "") ||
      ["1", "2", "3", "4"].includes(b.asbestosCode ?? ""),
  );
  if (asbestos.length) {
    add({
      id: "asbestos_registered",
      severity: "high",
      title: "Mulig asbest i bygningsmaterialer",
      detail: asbestos
        .map((b) => `${b.usage ?? "Bygning"} (${b.constructionYear ?? "?"}): ${b.asbestos ?? [b.roofMaterial, b.outerWall].filter(Boolean).join(" / ")}`)
        .join("; "),
      sources: ["bbr"],
    });
  } else {
    const old = buildings.filter((b) => (b.constructionYear ?? 9999) < ASBESTOS_BAN_YEAR && b.asbestosCode !== "5");
    if (old.length) {
      add({
        id: "asbestos_era",
        severity: "info",
        title: `Opført før ${ASBESTOS_BAN_YEAR}`,
        detail: `${old.length} bygning(er) er fra før asbestforbuddet, og BBR har ingen asbestregistrering. Asbest kan findes i fx gulvbelægning, rør og eternit, som BBR ikke registrerer.`,
        sources: ["bbr"],
      });
    }
  }

  // Heating
  if (main) {
    const heatArea = site.find((item) => item.category === "heat_supply_area" || item.category === "heat_plan_area");
    const districtHeat = heatArea && /fjernvarme/i.test(heatArea.value ?? "");
    const areaNote = districtHeat
      ? ` Grunden ligger i et område udlagt til fjernvarme${heatArea.details ? ` (${heatArea.details})` : ""}.`
      : "";
    if (main.heatingFuelCode === "3") {
      add({
        id: "oil_heating",
        severity: "high",
        title: "Opvarmning med flydende brændsel (olie)",
        detail: `${main.heating ?? "Varmeanlæg"} med ${main.heatingFuel}. Regn med udskiftning og tjek for nedgravet olietank.${areaNote}`,
        sources: districtHeat ? ["bbr", "plandata"] : ["bbr"],
      });
    } else if (main.heatingFuelCode === "7" || main.heatingFuelCode === "2") {
      add({
        id: "gas_heating",
        severity: "medium",
        title: "Gasopvarmning",
        detail: `${main.heating ?? "Varmeanlæg"} med ${main.heatingFuel?.toLowerCase()}. Staten arbejder på at udfase gas til opvarmning; budgettér en konvertering.${areaNote}`,
        sources: districtHeat ? ["bbr", "plandata"] : ["bbr"],
      });
    } else if (main.heatingCode === "7") {
      add({
        id: "electric_heating",
        severity: "medium",
        title: "Elvarme",
        detail: `Direkte elvarme er dyr i drift.${areaNote}`,
        sources: ["bbr"],
      });
    }
  }

  // Area composition
  for (const building of buildings.filter((b) => !isOutbuilding(b.usageCode))) {
    const floors = building.floorDetails ?? [];
    const attic = floors.reduce((sum, floor) => sum + (floor.usedAtticArea ?? 0), 0);
    // Some basements only carry their area in the floor total, not in the basement field.
    const basement = floors.reduce(
      (sum, floor) => sum + (floor.basementArea ?? (floor.typeCode === "2" ? (floor.totalArea ?? 0) : 0)),
      0,
    );
    const legalBasement = floors.reduce((sum, floor) => sum + (floor.legalBasementDwellingArea ?? 0), 0);
    const parts: string[] = [];
    if (attic > 0) parts.push(`boligarealet omfatter ${m2(attic)} udnyttet tagetage`);
    if (basement > 0) {
      parts.push(
        legalBasement > 0
          ? `kælder på ${m2(basement)}, heraf ${m2(legalBasement)} lovlig beboelse`
          : `kælder på ${m2(basement)}, som ikke tæller med i boligarealet`,
      );
    }
    if (parts.length) {
      add({
        id: "area_composition",
        severity: "info",
        title: "Sammensætning af arealet",
        detail: `${building.usage ?? "Bygning"}: ${parts.join("; ")}.`,
        sources: ["bbr"],
      });
    }
  }

  // Listed / worth preserving
  const listed = buildings.filter((b) => b.listingCode && Number(b.listingCode) <= 7);
  const preserve = buildings.filter((b) => b.listingCode === "8" || b.listingCode === "9");
  if (listed.length) {
    add({
      id: "listed_building",
      severity: "high",
      title: "Fredet bygning eller tinglyst bevaring",
      detail: listed.map((b) => `${b.usage}: ${b.listing}`).join("; "),
      sources: ["bbr"],
    });
  }
  if (preserve.length) {
    add({
      id: "worth_preserving",
      severity: "medium",
      title: "Bevaringsværdig bygning",
      detail: `${preserve.map((b) => `${b.usage}: ${b.listing}`).join("; ")}. Ændringer af facade og nedrivning kan kræve tilladelse.`,
      sources: ["bbr"],
    });
  }

  // Neighbours caught by the lookup box are not this property's buildings.
  const heritageItems = (input.heritage?.items ?? []).filter((item) => item.atProperty !== false);
  const fbbListed = heritageItems.filter((item) => item.listed);
  if (fbbListed.length && !listed.length) {
    add({
      id: "listed_building",
      severity: "high",
      title: "Fredet bygning",
      detail: fbbListed.map((item) => item.address ?? "Bygning").join("; "),
      sources: ["fbb"],
    });
  }
  const assessed = heritageItems.filter((item) => item.saveValue);
  if (assessed.length) {
    const best = Math.min(...assessed.map((item) => item.saveValue!));
    const severity = best <= 3 ? "high" : best <= 6 ? "medium" : "info";
    const rank = best <= 3 ? "høj" : best <= 6 ? "middel" : "lav";
    add({
      id: "save_value",
      severity,
      title: `SAVE-bevaringsværdi ${best}`,
      detail: `${assessed.map((item) => `${item.address ?? "Bygning"}: SAVE ${item.saveValue}`).join("; ")}. ${rank} bevaringsværdi (1 er højest, 9 er lavest). Ændringer kan kræve kommunens tilladelse.`,
      sources: ["fbb"],
    });
  }

  const themeFlags: Record<string, { id: string; title: string; detail: string }> = {
    Fredskov: {
      id: "forest_reserve",
      title: "Fredskov",
      detail: "Matriklen har fredskov på grunden. Rydning og byggeri kræver dispensation.",
    },
    Strandbeskyttelse: {
      id: "beach_protection",
      title: "Strandbeskyttelse",
      detail: "Matriklen har strandbeskyttelse på grunden. Ændringer og nyt byggeri inden for linjen kræver dispensation.",
    },
    Klitfredning: {
      id: "dune_protection",
      title: "Klitfredning",
      detail: "Matriklen har klitfredning på grunden. Ændringer kræver dispensation.",
    },
  };
  const seenThemes = new Set<string>();
  const otherThemes: string[] = [];
  for (const parcel of input.parcels ?? []) {
    for (const note of parcel.notes ?? []) {
      if (seenThemes.has(note)) continue;
      seenThemes.add(note);
      const known = themeFlags[note];
      if (known) add({ ...known, severity: "high", sources: ["matrikel"] });
      else otherThemes.push(note);
    }
  }
  if (otherThemes.length) {
    add({
      id: "cadastral_note",
      severity: "info",
      title: "Matrikelnotering",
      detail: otherThemes.join(", "),
      sources: ["matrikel"],
    });
  }

  // Flood compensation paid
  const flooded = buildings.filter((b) => ["1", "2", "3"].includes(b.floodCompensationCode ?? ""));
  if (flooded.length) {
    add({
      id: "flood_compensation",
      severity: "high",
      title: "Tidligere naturskade",
      detail: flooded.map((b) => `${b.usage}: ${b.floodCompensation}`).join("; "),
      sources: ["bbr"],
    });
  }

  // Tenure
  const rented = (input.units ?? []).filter((unit) => unit.tenureCode === "1");
  if (rented.length) {
    add({
      id: "existing_tenancy",
      severity: "medium",
      title: "Enhed registreret som udlejet",
      detail: `${rented.length} enhed(er) står som udlejet i BBR. Et køb overtager normalt de eksisterende lejeaftaler.`,
      sources: ["bbr"],
    });
  }
  const unused = (input.units ?? []).filter((unit) => unit.tenureCode === "3");
  if (unused.length) {
    add({
      id: "unused_unit",
      severity: "info",
      title: "Enhed registreret som ikke benyttet",
      detail: `${unused.length} enhed(er) står som ikke benyttet i BBR.`,
      sources: ["bbr"],
    });
  }

  // Water and drainage
  const drain = Number(input.ground?.drainageCode);
  if (Number.isFinite(drain) && drain >= 20 && drain !== 75) {
    add({
      id: "private_drainage",
      severity: "medium",
      title: "Ikke tilsluttet offentlig kloak",
      detail: `Afløb: ${input.ground?.drainage}. Private anlæg kan få påbud om forbedret rensning.`,
      sources: ["bbr"],
    });
  }
  const water = input.ground?.waterSupplyCode ?? "";
  if (["2", "3", "4", "6"].includes(water)) {
    add({
      id: "private_water",
      // Own well or single-property abstraction is the owner's responsibility; a private waterworks usually is not.
      severity: water === "3" || water === "4" ? "medium" : "info",
      title: water === "3" || water === "4" ? "Egen vandforsyning" : "Privat vandforsyning",
      detail: `Vandforsyning: ${input.ground?.waterSupply}. ${
        water === "3" || water === "4"
          ? "Ejeren har selv ansvaret for boring eller brønd og for vandkvaliteten. Bed om nye vandprøver."
          : water === "2"
            ? "Typisk et forbrugerejet vandværk, ikke en egen boring. Se værkets seneste vandanalyser."
            : "Tjek hvem der driver anlægget, og se de seneste vandanalyser."
      }`,
      sources: ["bbr"],
    });
  }

  // Soil contamination
  const soil = (input.environment?.items ?? []).filter((item) => item.category === "soil_v1" || item.category === "soil_v2");
  const soilLabel = (item: (typeof soil)[number]) =>
    `${item.category === "soil_v2" ? "V2 (konstateret forurening)" : "V1 (mulig forurening)"}${item.name ? `: ${item.name}` : ""}${
      item.localityNumber ? ` (lokalitet ${item.localityNumber}${item.address ? `, ${item.address}` : ""})` : ""
    }`;
  const soilOn = soil.filter((item) => item.onProperty);
  const soilNear = soil.filter((item) => !item.onProperty);
  if (soilOn.length) {
    add({
      id: "soil_contamination",
      severity: "high",
      title: "Kortlagt jordforurening på ejendommen",
      detail: soilOn.map(soilLabel).join("; "),
      sources: ["miljoportal"],
    });
  }
  if (soilNear.length) {
    add({
      id: "soil_contamination_nearby",
      severity: "info",
      title: "Kortlagt jordforurening i nærheden",
      detail: `${soilNear.length} lokalitet(er) inden for ca. 80 m: ${soilNear.slice(0, 4).map(soilLabel).join("; ")}${soilNear.length > 4 ? " …" : ""}`,
      sources: ["miljoportal"],
    });
  }

  // Site conditions from municipal plans
  const siteRules: Array<{ category: string; severity: Flag["severity"]; title: string }> = [
    { category: "flood_or_erosion_risk", severity: "medium", title: "Udpeget risiko for oversvømmelse eller erosion" },
    { category: "near_surface_groundwater", severity: "medium", title: "Terrænnært grundvand" },
    { category: "low_lying_land", severity: "medium", title: "Lavbundsareal" },
    { category: "noise_affected_area", severity: "medium", title: "Støjbelastet areal" },
    { category: "large_livestock_farm_area", severity: "info", title: "Område udlagt til store husdyrbrug" },
    { category: "planned_road_or_rail", severity: "medium", title: "Planlagt trafikanlæg i nærheden" },
    { category: "planned_technical_facility", severity: "medium", title: "Planlagt teknisk anlæg i nærheden" },
    { category: "technical_facility_buffer", severity: "info", title: "Konsekvensområde om teknisk anlæg" },
    { category: "transformation_area", severity: "info", title: "Transformationsområde" },
    { category: "cultural_heritage_value", severity: "info", title: "Kulturhistorisk bevaringsværdi" },
    { category: "valuable_cultural_environment", severity: "info", title: "Værdifuldt kulturmiljø" },
  ];
  for (const rule of siteRules) {
    const hits = site.filter((item) => item.category === rule.category && !isExclusionZone(item.value));
    if (!hits.length) continue;
    add({
      id: rule.category,
      severity: rule.severity,
      title: rule.title,
      detail: hits.map((item) => [item.value, item.details].filter(Boolean).join(" · ") || item.label).join("; "),
      sources: ["plandata"],
    });
  }
  const sewer = site.find((item) => item.category === "sewer_catchment" && /planlagt:/.test(item.details ?? ""));
  if (sewer) {
    const planned = sewer.details?.match(/planlagt: ([^·]+)/)?.[1]?.trim() ?? "";
    const deadline = Number(sewer.details?.match(/slutår (\d{4})/)?.[1]) || undefined;
    // The wastewater plan lags behind BBR: if the ground is already drained the planned way, the change is done.
    const kind = (text: string | undefined) => text?.match(/^(Separat|Fælles|Spildevands)kloakeret/i)?.[1]?.toLowerCase();
    const alreadyDone = kind(planned) !== undefined && kind(planned) === kind(input.ground?.drainage);
    if (alreadyDone) {
      add({
        id: "planned_sewer_change",
        severity: "info",
        title: "Spildevandsplanen er ikke opdateret",
        detail: `Plandata: ${sewer.value} · ${sewer.details}. BBR registrerer allerede afløbet som ${input.ground?.drainage}, så omlægningen er formentlig gennemført. Bekræft hos kommunen.`,
        sources: ["plandata", "bbr"],
      });
    } else {
      const overdue = deadline !== undefined && deadline < new Date().getFullYear() ? " Slutåret er passeret, så spørg kommunen om status." : "";
      add({
        id: "planned_sewer_change",
        severity: "medium",
        title: "Planlagt ændring af kloakering",
        detail: `${sewer.value} · ${sewer.details}. Separatkloakering kan kræve arbejde på egen grund.${overdue}`,
        sources: ["plandata"],
      });
    }
  }

  // Plans
  const items = input.plans?.items ?? [];
  const zone = items.find((item) => item.type === "zone");
  if (zone?.zoneStatus && /landzone/i.test(zone.zoneStatus)) {
    add({
      id: "rural_zone",
      severity: "medium",
      title: "Landzone",
      detail: "Udstykning, ny bebyggelse og ændret anvendelse kræver som udgangspunkt landzonetilladelse.",
      sources: ["plandata"],
    });
  }
  const localPlans = items.filter((item) => item.type === "local_plan");
  if (input.plans && localPlans.length === 0) {
    const nearby = (input.plans.nearby ?? []).filter((item) => item.type === "local_plan");
    add({
      id: "no_local_plan",
      severity: "info",
      title: "Ingen lokalplan dækker grunden",
      detail: `${
        items.some((item) => item.type === "municipal_framework")
          ? "Byggeretten følger kommuneplanrammen og bygningsreglementet."
          : "Heller ingen kommuneplanramme dækker grunden, så byggeretten følger bygningsreglementet og, i landzone, landzonereglerne."
      }${nearby.length ? ` Nærliggende lokalplan(er) inden for ${nearby[0]?.withinM ?? 40} m: ${nearby.map((item) => item.name).join("; ")}.` : ""}`,
      sources: ["plandata"],
    });
  }
  for (const proposal of items.filter((item) => item.type === "local_plan_proposal" || item.type === "municipal_framework_proposal")) {
    add({
      id: "plan_proposal",
      severity: "medium",
      title: proposal.type === "local_plan_proposal" ? "Lokalplanforslag dækker grunden" : "Forslag til ny kommuneplanramme",
      detail: `${proposal.name ?? proposal.planId}${proposal.consultationEndsOn ? `, høring til ${proposal.consultationEndsOn}` : ""}.`,
      sources: ["plandata"],
    });
  }

  // Building rights headroom
  const framework = items.find((item) => item.type === "municipal_framework");
  const plotArea = (input.parcels ?? []).reduce((sum, parcel) => sum + (parcel.registeredArea ?? 0), 0);
  const ratio = applicablePlotRatio(framework, main?.usageCode);
  const used = countedFloorArea(buildings);
  // With no floor areas in BBR the whole plot would look unbuilt; say nothing rather than invent headroom.
  if (ratio && plotArea > 0 && used > 0) {
    const allowed = (plotArea * ratio.pct) / 100;
    const current = Math.round((used / plotArea) * 1000) / 10;
    const headroom = allowed - used;
    add({
      id: "building_rights",
      severity: "info",
      title: headroom > 0 ? `Indikativ restbyggeret ca. ${m2(headroom)}` : "Byggeretten ser udnyttet ud",
      detail: `Bebyggelsesprocent ca. ${pct(current)} (${m2(used)} etageareal på ${m2(plotArea)} grund) mod maks. ${pct(ratio.pct)} (${ratio.basis}) = ${m2(allowed)}. Estimat: kælder og garager/carporte er ikke medregnet. Lokalplan, servitutter og kommunens praksis kan ændre billedet.`,
      sources: ["bbr", "matrikel", "plandata"],
    });
  }

  // Terrain (screening only: height alone does not say whether water can reach the plot)
  const terrain = input.terrain;
  if (terrain) {
    const height = terrain.terrainM.toLocaleString("da-DK", { maximumFractionDigits: 1 });
    if (terrain.terrainM < LOW_TERRAIN_HIGH_M) {
      add({
        id: "very_low_terrain",
        severity: "high",
        title: `Terræn kun ca. ${height} m over havniveau`,
        detail: "Så lavt terræn kan blive oversvømmet ved stormflod. Tjek kommunens klimatilpasningsplan og Kystdirektoratets stormflodsstatistik.",
        sources: ["dhm"],
      });
    } else if (terrain.terrainM < LOW_TERRAIN_M) {
      add({
        id: "low_terrain",
        severity: "medium",
        title: `Lavt terræn: ca. ${height} m over havniveau`,
        detail: "Under ca. 2,5 m kan en kraftig stormflod nå grunden, hvis den ligger ved kysten eller et lavtliggende område med forbindelse til havet.",
        sources: ["dhm"],
      });
    }
    if (terrain.relativeToSurroundingsM <= DEPRESSION_M) {
      const below = Math.abs(terrain.relativeToSurroundingsM).toLocaleString("da-DK", { maximumFractionDigits: 1 });
      add({
        id: "terrain_depression",
        severity: "medium",
        title: "Grunden ligger lavere end omgivelserne",
        detail: `Ca. ${below} m under medianterrænet inden for ${terrain.surroundings.radiusM} m. Regnvand kan samle sig ved skybrud.`,
        sources: ["dhm"],
      });
    }
  }

  // Measured outline vs registered built area. Roof overhang alone explains 10–20 %.
  const larger = (input.footprints ?? []).filter(
    (item) =>
      item.bbrBuiltAreaM2 &&
      item.differenceM2 !== null &&
      item.differenceM2 !== undefined &&
      item.differenceM2 > FOOTPRINT_EXTRA_M2 &&
      item.differenceM2 / item.bbrBuiltAreaM2 > FOOTPRINT_EXTRA_SHARE,
  );
  if (larger.length) {
    const names = new Map(buildings.map((b) => [b.buildingId, b.usage ?? "Bygning"]));
    add({
      id: "footprint_larger_than_bbr",
      severity: "medium",
      title: "Bygning større på kortet end i BBR",
      detail: `${larger
        .map((item) => `${names.get(item.buildingId) ?? "Bygning"}: målt ca. ${m2(item.footprintM2)} mod ${m2(item.bbrBuiltAreaM2!)} i BBR`)
        .join("; ")}. Tagudhæng forklarer typisk 10–20 %; en større forskel kan være en tilbygning, der ikke er registreret eller godkendt.`,
      sources: ["geodanmark", "bbr"],
    });
  }

  // Last sale
  const sale = (input.trades ?? []).find((trade) => (trade.price ?? 0) > 0);
  if (sale?.price) {
    const area = input.units?.[0]?.dwellingArea ?? main?.dwellingArea;
    add({
      id: "last_sale",
      severity: "info",
      title: `Seneste handel ${sale.date ?? ""}`.trim(),
      detail: `Samlet købesum ${kr(sale.price)}${area ? ` (${kr(sale.price / area)} pr. m² bolig)` : ""}${sale.transferType ? `, ${sale.transferType}` : ""}. ${sale.attribution ?? ""}`.trim(),
      sources: ["ejf"],
    });
  }

  // Valuation
  const valuation = input.valuation;
  if (valuation?.latestNew) {
    const v = valuation.latestNew;
    const area = v.valuedArea ?? plotArea;
    add({
      id: "valuation_new",
      severity: "info",
      title: `Ny offentlig vurdering ${v.year}`,
      detail: `Ejendomsværdi ${v.propertyValue ? kr(v.propertyValue) : "ukendt"}, grundværdi ${v.landValue ? kr(v.landValue) : "ukendt"}${v.landValue && area ? ` (${kr(v.landValue / area)} pr. m² grund)` : ""}.`,
      sources: ["vur"],
    });
  } else if (valuation?.latestOld) {
    add({
      id: "valuation_old_only",
      severity: "medium",
      title: "Kun vurdering fra det gamle system",
      detail: `Seneste vurdering er fra ${valuation.latestOld.year}. Den siger lidt om dagens markedspris.${valuation.note ? ` ${valuation.note}` : ""}`,
      sources: ["vur"],
    });
  }

  const order = { high: 0, medium: 1, info: 2 } as const;
  return flags.sort((a, b) => order[a.severity] - order[b.severity]);
}
