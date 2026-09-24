import { lookupAddress } from "../sources/adressevaelger.js";
import { getAreaStatsForMunicipality } from "../sources/dst.js";
import { getEnergyLabel } from "../sources/emodata.js";
import { getEnvironmentAt } from "../sources/miljoportal.js";
import { getPlansAt } from "../sources/plandata.js";
import {
  getAdminAreasAt,
  getBuildingsAndUnits,
  getParcels,
  getTrades,
  getValuation,
} from "../sources/datafordeler/registers.js";
import { resolveProperty } from "../resolve.js";
import type {
  AdminAreas,
  AreaStats,
  Building,
  EnergyLabel,
  EnvironmentInfo,
  Parcel,
  PlanInfo,
  PlanItem,
  PropertyIds,
  SourceResult,
  Trade,
  Unit,
  Valuation,
} from "../types.js";

const TOKEN_BUDGET = 4000;

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

function unwrap<T>(settled: PromiseSettledResult<T | undefined>): T | undefined {
  return settled.status === "fulfilled" ? settled.value : undefined;
}

export async function buildPropertyReport(input: {
  query?: string;
  addressId?: string;
}): Promise<unknown> {
  const idsResult = await resolveProperty(input);
  const ids: PropertyIds | undefined = idsResult.status === "ok" ? idsResult.data : undefined;

  let municipalityCode: string | undefined;
  if (ids?.addressId) {
    const lookup = await lookupAddress(ids.addressId);
    if (lookup.status === "ok") municipalityCode = lookup.data.municipalityCode;
  }

  const coord = ids?.coordinate?.epsg25832;
  const settled = await Promise.allSettled([
    ids?.bfe
      ? getBuildingsAndUnits({ bfe: ids.bfe, addressId: ids.addressId })
      : Promise.resolve(undefined),
    ids?.bfe ? getParcels(ids.bfe) : Promise.resolve(undefined),
    ids?.bfe ? getValuation(ids.bfe) : Promise.resolve(undefined),
    ids?.bfe ? getTrades(ids.bfe) : Promise.resolve(undefined),
    coord ? getAdminAreasAt(coord.x, coord.y) : Promise.resolve(undefined),
    coord ? getPlansAt(coord.x, coord.y) : Promise.resolve(undefined),
    coord ? getEnvironmentAt(coord.x, coord.y) : Promise.resolve(undefined),
    municipalityCode ? getAreaStatsForMunicipality(municipalityCode) : Promise.resolve(undefined),
    getEnergyLabel({ address: ids?.designation, bfe: ids?.bfe }),
  ]);

  const buildings = unwrap(settled[0]) as
    | SourceResult<{ buildings: Building[]; units: Unit[] }>
    | undefined;
  const parcel = unwrap(settled[1]) as SourceResult<Parcel[]> | undefined;
  const valuation = unwrap(settled[2]) as SourceResult<Valuation> | undefined;
  const trades = unwrap(settled[3]) as SourceResult<Trade[]> | undefined;
  const admin = unwrap(settled[4]) as SourceResult<AdminAreas> | undefined;
  const plans = unwrap(settled[5]) as SourceResult<PlanInfo> | undefined;
  const environment = unwrap(settled[6]) as SourceResult<EnvironmentInfo> | undefined;
  const stats = unwrap(settled[7]) as SourceResult<AreaStats> | undefined;
  const energy = unwrap(settled[8]) as SourceResult<EnergyLabel> | undefined;

  if (admin?.status === "ok") {
    municipalityCode = admin.data.municipalityCode ?? municipalityCode;
  }

  const missing: Array<{ source: string; reason: string; detail?: string }> = [];
  const collect = (result: SourceResult<unknown> | undefined) => {
    if (!result) return;
    if (result.status === "unavailable") {
      missing.push({ source: result.source, reason: result.reason, detail: result.detail });
    }
  };
  collect(idsResult);
  for (const result of [buildings, parcel, valuation, trades, admin, plans, environment, stats, energy]) {
    collect(result);
  }
  if (!ids?.bfe) {
    missing.push({
      source: "matrikel",
      reason: "missing_credentials",
      detail: "BFE is unavailable until DATAFORDELER_API_KEY is set.",
    });
  }

  const buildingData = buildings?.status === "ok" ? buildings.data : undefined;
  const latestTrade = trades?.status === "ok" ? trades.data[0] : undefined;
  const latestValuation = valuation?.status === "ok" ? valuation.data.latest : undefined;
  const planItems: PlanItem[] = plans?.status === "ok" ? plans.data.items : [];
  const envItems = environment?.status === "ok" ? environment.data.items : [];

  const summary = {
    designation: ids?.designation,
    addressId: ids?.addressId,
    bfe: ids?.bfe,
    municipality: admin?.status === "ok" ? admin.data.municipalityName : undefined,
    constructionYear: buildingData?.buildings[0]?.constructionYear,
    usage: buildingData?.buildings[0]?.usage,
    dwellingArea: buildingData?.units[0]?.dwellingArea,
    valuation: latestValuation?.propertyValue,
    lastTrade: latestTrade?.price,
    lastTradeDate: latestTrade?.date,
    localPlans: planItems.filter((item) => item.type === "local_plan").length,
    environmentalHits: envItems.length,
    energyLabel: energy?.status === "ok" ? energy.data.rating : undefined,
  };

  const report = {
    summary,
    ids: idsResult,
    buildings: buildings ? compact(buildings, 8) : undefined,
    parcel: parcel ? compact(parcel, 8) : undefined,
    valuation,
    trades: trades ? compact(trades, 5) : undefined,
    admin,
    plans: plans ? compact(plans, 8) : undefined,
    environment: environment ? compact(environment, 10) : undefined,
    areaStats: stats,
    energy,
    missing,
  };

  if (estimateTokens(report) > TOKEN_BUDGET) {
    return {
      summary,
      ids: idsResult.status === "ok" ? { status: "ok", data: ids } : idsResult,
      missing,
      note: "Report truncated to stay under ~4,000 tokens. Call individual tools for full fields.",
    };
  }
  return report;
}
