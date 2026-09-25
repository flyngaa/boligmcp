import { buildFlags, flagInputFrom, lastSale } from "../analysis/flags.js";
import { isOutbuilding } from "../lib/bbr-codes.js";
import { lookupAddress } from "../sources/adressevaelger.js";
import { getAreaStatsForMunicipality, getParishStats, getRegionalMarket, marketCategoryFor } from "../sources/dst.js";
import { getFootprints } from "../sources/datafordeler/geodanmark.js";
import { getNearbyServices } from "../sources/datafordeler/nearby.js";
import { getPropertyLocation, type PropertyLocation } from "../sources/datafordeler/ebr.js";
import { getEnergyLabel } from "../sources/emodata.js";
import { getHeritageAt } from "../sources/fbb.js";
import { getEnvironmentAt } from "../sources/miljoportal.js";
import { getPlansAt, getSiteConditionsAt } from "../sources/plandata.js";
import { getTerrainAt } from "../sources/datafordeler/dhm.js";
import {
  getAdminAreasAt,
  getBuildingsAndUnits,
  getParcels,
  getTrades,
  getValuation,
} from "../sources/datafordeler/registers.js";
import { getConfig } from "../config.js";
import { resolveProperty } from "../resolve.js";
import { unavailable } from "../types.js";
import type {
  AdminAreas,
  AreaStats,
  Building,
  EnergyLabel,
  EnvironmentInfo,
  Footprint,
  HeritageInfo,
  Ground,
  NearbyServices,
  Parcel,
  PlanInfo,
  PlanItem,
  PropertyIds,
  SiteConditions,
  SourceResult,
  TerrainInfo,
  Trade,
  Unit,
  Valuation,
} from "../types.js";

const TOKEN_BUDGET = 10000;

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function compact<T>(result: SourceResult<T>, maxItems?: number): SourceResult<unknown> {
  if (result.status !== "ok") return result;
  const data = result.data as unknown;
  if (Array.isArray(data) && maxItems !== undefined && data.length > maxItems) {
    return {
      ...result,
      data: {
        items: data.slice(0, maxItems),
        truncated: data.length - maxItems,
        total: data.length,
      },
    };
  }
  if (data && typeof data === "object" && "items" in data) {
    const items = (data as { items: unknown[] }).items;
    if (Array.isArray(items) && maxItems !== undefined && items.length > maxItems) {
      return {
        ...result,
        data: {
          ...(data as object),
          items: items.slice(0, maxItems),
          truncated: items.length - maxItems,
          total: items.length,
        },
      };
    }
  }
  return result;
}

/** Estates and blocks of flats can have dozens of buildings and units; the report keeps the first (main) ones. */
function compactBbr(result: BbrResult, maxBuildings: number, maxUnits: number): SourceResult<unknown> {
  if (result.status !== "ok") return result;
  const { buildings, units, ...rest } = result.data;
  return {
    ...result,
    data: {
      ...rest,
      buildings: buildings.slice(0, maxBuildings),
      units: units.slice(0, maxUnits),
      ...(buildings.length > maxBuildings ? { buildingsTotal: buildings.length } : {}),
      ...(units.length > maxUnits && !rest.unitsTotal ? { unitsTotal: units.length } : {}),
    },
  };
}

function unwrap<T>(settled: PromiseSettledResult<T | undefined>): T | undefined {
  return settled.status === "fulfilled" ? settled.value : undefined;
}

type BbrResult = SourceResult<{ buildings: Building[]; units: Unit[]; ground?: Ground; unitsTotal?: number }>;

/**
 * Plans and overlays are looked up at the main building's BBR coordinate, which lies inside the plot.
 * The address point sits by the road and can fall outside the parcel polygon.
 */
export function lookupPointFor(
  ids: PropertyIds | undefined,
  buildings: BbrResult | undefined,
): { x: number; y: number; kind: "building" | "address" } | undefined {
  if (buildings?.status === "ok") {
    const main =
      buildings.data.buildings.find((b) => !isOutbuilding(b.usageCode) && b.coordinate) ??
      buildings.data.buildings.find((b) => b.coordinate);
    if (main?.coordinate) return { ...main.coordinate.epsg25832, kind: "building" };
  }
  const coord = ids?.coordinate?.epsg25832;
  return coord ? { ...coord, kind: "address" } : undefined;
}

/** Positions of the property's buildings, for lookups that must cover a whole estate. */
export function buildingPoints(buildings: BbrResult | undefined): Array<{ x: number; y: number }> {
  if (buildings?.status !== "ok") return [];
  return buildings.data.buildings.flatMap((b) => (b.coordinate ? [b.coordinate.epsg25832] : []));
}

export function parcelRefs(ids: PropertyIds | undefined, parcel: SourceResult<Parcel[]> | undefined) {
  const refs = parcel?.status === "ok" ? parcel.data.map((item) => ({ ...item })) : [];
  if (ids?.cadastralDistrictCode && ids.cadastralNumber) {
    refs.push({ cadastralDistrictCode: ids.cadastralDistrictCode, cadastralNumber: ids.cadastralNumber });
  }
  return refs;
}

export interface PropertyData {
  idsResult: SourceResult<PropertyIds>;
  ids?: PropertyIds;
  buildings?: BbrResult;
  parcel?: SourceResult<Parcel[]>;
  valuation?: SourceResult<Valuation>;
  trades?: SourceResult<Trade[]>;
  admin?: SourceResult<AdminAreas>;
  plans?: SourceResult<PlanInfo>;
  site?: SourceResult<SiteConditions>;
  environment?: SourceResult<EnvironmentInfo>;
  stats?: SourceResult<AreaStats>;
  energy?: SourceResult<EnergyLabel>;
  location?: SourceResult<PropertyLocation>;
  terrain?: SourceResult<TerrainInfo>;
  nearby?: SourceResult<NearbyServices>;
  footprints?: SourceResult<Footprint[]>;
  parish?: SourceResult<AreaStats>;
  market?: SourceResult<AreaStats>;
  heritage?: SourceResult<HeritageInfo>;
}

/** Statistics are context, not core data: after this long the report goes out without them. */
const STATS_DEADLINE_MS = 15_000;

/** Resolves to `fallback` if `work` is not done in time. The work keeps running and still fills the cache. */
export function withDeadline<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), ms);
    timer.unref();
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const statsTimeout = () =>
  unavailable<AreaStats>("dst", "upstream_error", `Statistikbanken did not answer within ${STATS_DEADLINE_MS / 1000} s`);

/** Fetches every source for one address. `skip` leaves out sources a caller does not need. */
export async function collectPropertyData(
  input: { query?: string; addressId?: string; bfe?: string },
  skip: { stats?: boolean; energy?: boolean; trades?: boolean; nearby?: boolean } = {},
): Promise<PropertyData> {
  const idsResult = await resolveProperty(input);
  const ids: PropertyIds | undefined = idsResult.status === "ok" ? idsResult.data : undefined;

  let municipalityCode: string | undefined;
  if (ids?.addressId) {
    const lookup = await lookupAddress(ids.addressId);
    if (lookup.status === "ok") municipalityCode = lookup.data.municipalityCode;
  }

  const addressCoord = ids?.coordinate?.epsg25832;
  // A condominium's land and parcels belong to the main property.
  const landBfe = ids?.mainBfe ?? ids?.bfe;
  const first = await Promise.allSettled([
    ids?.bfe || ids?.addressId || ids?.houseNumberId
      ? getBuildingsAndUnits({ bfe: ids.bfe, addressId: ids.addressId, houseNumberId: ids.houseNumberId, mainBfe: ids.mainBfe })
      : Promise.resolve(undefined),
    landBfe ? getParcels(landBfe) : Promise.resolve(undefined),
    ids?.bfe ? getValuation(ids.bfe) : Promise.resolve(undefined),
    ids?.bfe && !skip.trades ? getTrades(ids.bfe) : Promise.resolve(undefined),
    addressCoord ? getAdminAreasAt(addressCoord.x, addressCoord.y) : Promise.resolve(undefined),
    skip.energy ? Promise.resolve(undefined) : getEnergyLabel({ bfe: ids?.bfe }),
    ids?.bfe ? getPropertyLocation(ids.bfe) : Promise.resolve(undefined),
  ]);
  const buildings = unwrap(first[0]) as BbrResult | undefined;
  const parcel = unwrap(first[1]) as SourceResult<Parcel[]> | undefined;
  const valuation = unwrap(first[2]) as SourceResult<Valuation> | undefined;
  const trades = unwrap(first[3]) as SourceResult<Trade[]> | undefined;
  const admin = unwrap(first[4]) as SourceResult<AdminAreas> | undefined;
  const energy = unwrap(first[5]) as SourceResult<EnergyLabel> | undefined;
  const location = unwrap(first[6]) as SourceResult<PropertyLocation> | undefined;

  if (admin?.status === "ok") municipalityCode = admin.data.municipalityCode ?? municipalityCode;

  const point = lookupPointFor(ids, buildings);
  const adminData = admin?.status === "ok" ? admin.data : undefined;
  const mainBuilding = buildings?.status === "ok" ? buildings.data.buildings.find((b) => !isOutbuilding(b.usageCode)) : undefined;
  const second = await Promise.allSettled([
    point ? getPlansAt(point.x, point.y, { lookupPoint: point.kind }) : Promise.resolve(undefined),
    point ? getSiteConditionsAt(point.x, point.y, { lookupPoint: point.kind }) : Promise.resolve(undefined),
    point ? getEnvironmentAt(point.x, point.y, parcelRefs(ids, parcel)) : Promise.resolve(undefined),
    municipalityCode && !skip.stats
      ? withDeadline(getAreaStatsForMunicipality(municipalityCode), STATS_DEADLINE_MS, statsTimeout)
      : Promise.resolve(undefined),
    point ? getTerrainAt(point.x, point.y, { lookupPoint: point.kind }) : Promise.resolve(undefined),
    point && !skip.nearby ? getNearbyServices(point.x, point.y) : Promise.resolve(undefined),
    buildings?.status === "ok" ? getFootprints(buildings.data.buildings) : Promise.resolve(undefined),
    adminData?.parishCode && !skip.stats
      ? withDeadline(getParishStats(adminData.parishCode, adminData.parishName), STATS_DEADLINE_MS, statsTimeout)
      : Promise.resolve(undefined),
    adminData?.landsdelName && !skip.stats
      ? withDeadline(
          getRegionalMarket(adminData.landsdelName, marketCategoryFor(mainBuilding?.usageCode, ids?.isCondominium)),
          STATS_DEADLINE_MS,
          statsTimeout,
        )
      : Promise.resolve(undefined),
    point
      ? getHeritageAt(point.x, point.y, { addresses: ids?.designation ? [ids.designation] : [], buildings: buildingPoints(buildings) })
      : Promise.resolve(undefined),
  ]);

  return {
    idsResult,
    ids,
    buildings,
    parcel,
    valuation,
    trades,
    admin,
    energy,
    location,
    plans: unwrap(second[0]) as SourceResult<PlanInfo> | undefined,
    site: unwrap(second[1]) as SourceResult<SiteConditions> | undefined,
    environment: unwrap(second[2]) as SourceResult<EnvironmentInfo> | undefined,
    stats: unwrap(second[3]) as SourceResult<AreaStats> | undefined,
    terrain: unwrap(second[4]) as SourceResult<TerrainInfo> | undefined,
    nearby: unwrap(second[5]) as SourceResult<NearbyServices> | undefined,
    footprints: unwrap(second[6]) as SourceResult<Footprint[]> | undefined,
    parish: unwrap(second[7]) as SourceResult<AreaStats> | undefined,
    market: unwrap(second[8]) as SourceResult<AreaStats> | undefined,
    heritage: unwrap(second[9]) as SourceResult<HeritageInfo> | undefined,
  };
}

export { lastSale };

export function summarize(data: PropertyData) {
  const { ids, buildings, valuation, trades, admin, plans, environment, energy, parcel, site } = data;
  // Nothing resolved: no zeros that would read as "no plans" or "no contamination".
  if (data.idsResult.status !== "ok") return {};
  const buildingData = buildings?.status === "ok" ? buildings.data : undefined;
  const main = buildingData?.buildings.find((b) => !isOutbuilding(b.usageCode)) ?? buildingData?.buildings[0];
  const latestTrade = lastSale(trades?.status === "ok" ? trades.data : undefined);
  // One unit describes the address; several belong to a whole building, where the building's totals apply.
  const unit = buildingData?.units.length === 1 ? buildingData.units[0] : undefined;
  const val = valuation?.status === "ok" ? valuation.data : undefined;
  const planItems: PlanItem[] = plans?.status === "ok" ? plans.data.items : [];
  const envItems = environment?.status === "ok" ? environment.data.items : [];
  const framework = planItems.find((item) => item.type === "municipal_framework");
  const plotArea =
    parcel?.status === "ok" ? parcel.data.reduce((sum, item) => sum + (item.registeredArea ?? 0), 0) : undefined;

  return {
    designation: ids?.designation,
    matchWarning: ids?.matchWarning,
    addressId: ids?.addressId,
    bfe: ids?.bfe,
    mainBfe: ids?.mainBfe,
    municipality: admin?.status === "ok" ? admin.data.municipalityName : undefined,
    constructionYear: main?.constructionYear,
    usage: main?.usage,
    dwellingArea: unit?.dwellingArea ?? main?.dwellingArea,
    rooms: unit?.rooms,
    plotArea,
    heating: main ? [main.heating, main.heatingFuel].filter(Boolean).join(" · ") || undefined : undefined,
    tenure: unit?.tenure,
    valuation: (val?.latestNew ?? val?.latest)?.propertyValue,
    valuationYear: (val?.latestNew ?? val?.latest)?.year,
    landValue: (val?.latestNew ?? val?.latest)?.landValue,
    lastTrade: latestTrade?.price,
    lastTradeDate: latestTrade?.date,
    lastTradeType: latestTrade?.transferType,
    zone: planItems.find((item) => item.type === "zone")?.zoneStatus,
    localPlans: plans?.status === "ok" ? planItems.filter((item) => item.type === "local_plan").length : undefined,
    // Some municipalities repeat the plan number in the name ("R24.B.4.16 - B4").
    framework: framework
      ? framework.planNumber && !framework.name?.startsWith(framework.planNumber)
        ? `${framework.planNumber} ${framework.name ?? ""}`.trim()
        : framework.name ?? framework.planNumber
      : undefined,
    environmentalHits: environment?.status === "ok" ? envItems.filter((item) => item.onProperty).length : undefined,
    environmentalNearby: environment?.status === "ok" ? envItems.filter((item) => !item.onProperty).length : undefined,
    siteConditions: site?.status === "ok" ? site.data.items.length : undefined,
    terrainM: data.terrain?.status === "ok" ? data.terrain.data.terrainM : undefined,
    energyLabel: energy?.status === "ok" ? energy.data.rating : undefined,
    hasStreetAddress: data.location?.status === "ok" ? data.location.data.hasStreetAddress : undefined,
    locationDesignation: data.location?.status === "ok" ? data.location.data.designation : undefined,
  };
}

export function missingSources(data: PropertyData): Array<{ source: string; reason: string; detail?: string }> {
  const missing: Array<{ source: string; reason: string; detail?: string }> = [];
  const seen = new Set<string>();
  const collect = (result: SourceResult<unknown> | undefined) => {
    if (result?.status !== "unavailable") return;
    const key = `${result.source}:${result.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    missing.push({ source: result.source, reason: result.reason, detail: result.detail });
  };
  collect(data.idsResult);
  for (const result of [
    data.buildings,
    data.parcel,
    data.valuation,
    data.trades,
    data.admin,
    data.plans,
    data.site,
    data.environment,
    data.stats,
    data.energy,
    data.location,
    data.terrain,
    data.nearby,
    data.footprints,
    data.parish,
    data.market,
    data.heritage,
  ]) {
    collect(result);
  }
  // Without a Datafordeleren key the address still resolves, but no BFE and nothing keyed on it.
  if (data.ids && !data.ids.bfe && !getConfig().datafordelerApiKey && !seen.has("dar:missing_credentials")) {
    missing.push({
      source: "matrikel",
      reason: "missing_credentials",
      detail: "BFE is unavailable until DATAFORDELER_API_KEY is set.",
    });
  }
  return missing;
}

export async function buildPropertyReport(input: {
  query?: string;
  addressId?: string;
  bfe?: string;
}): Promise<unknown> {
  const data = await collectPropertyData(input);
  const summary = summarize(data);
  const flags = buildFlags(flagInputFrom(data));
  const missing = missingSources(data);

  const report = {
    summary,
    flags,
    ids: data.idsResult,
    buildings: data.buildings ? compactBbr(data.buildings, 8, 5) : undefined,
    parcel: data.parcel ? compact(data.parcel, 8) : undefined,
    valuation: data.valuation,
    trades: data.trades ? compact(data.trades, 5) : undefined,
    admin: data.admin,
    plans: data.plans ? compact(data.plans, 10) : undefined,
    site: data.site ? compact(data.site, 15) : undefined,
    environment: data.environment ? compact(data.environment, 10) : undefined,
    areaStats: data.stats,
    energy: data.energy,
    location: data.location,
    terrain: data.terrain,
    nearby: data.nearby,
    footprints: data.footprints,
    parishStats: data.parish,
    market: data.market,
    heritage: data.heritage,
    missing,
  };

  if (estimateTokens(report) > TOKEN_BUDGET) {
    return {
      summary,
      flags,
      ids: data.idsResult.status === "ok" ? { status: "ok", data: data.ids } : data.idsResult,
      missing,
      note: `Report truncated to stay under ~${TOKEN_BUDGET.toLocaleString("en")} tokens. Call individual tools for full fields.`,
    };
  }
  return report;
}
