import { ttlFor } from "../catalog.js";
import { cached } from "../lib/cache.js";
import { bboxAround, pointWkt } from "../lib/geo.js";
import { fetchJson } from "../lib/http.js";
import { repairMojibake } from "../lib/text.js";
import {
  ok,
  unavailable,
  type PlanInfo,
  type PlanItem,
  type SiteCondition,
  type SiteConditions,
  type SourceResult,
} from "../types.js";

const WFS = "https://geoserver.plandata.dk/geoserver/wfs";

type LookupPoint = "building" | "address" | "parcel";

const PLAN_LAYERS: { typeName: string; type: PlanItem["type"] }[] = [
  { typeName: "pdk:theme_pdk_lokalplan_vedtaget", type: "local_plan" },
  { typeName: "pdk:theme_pdk_lokalplandelomraade_vedtaget", type: "local_plan_subarea" },
  { typeName: "pdk:theme_pdk_kommuneplanramme_vedtaget_v", type: "municipal_framework" },
  { typeName: "pdk:theme_pdk_zonekort_v", type: "zone" },
  { typeName: "pdk:theme_pdk_lokalplan_forslag", type: "local_plan_proposal" },
  { typeName: "pdk:theme_pdk_kommuneplanramme_forslag_v", type: "municipal_framework_proposal" },
];

/** Plans within this distance that do not cover the point are reported as `nearby`. */
const NEARBY_RADIUS_M = 40;

interface GeoJsonFeature {
  properties?: Record<string, unknown>;
}

interface GeoJson {
  features?: GeoJsonFeature[];
}

function prop(props: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!props) return undefined;
  for (const key of keys) {
    const value = props[key];
    if (value !== undefined && value !== null && String(value).trim()) return repairMojibake(String(value).trim());
  }
  return undefined;
}

function numProp(props: Record<string, unknown> | undefined, key: string): number | null {
  const value = props?.[key];
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Plandata dates are yyyymmdd integers. */
export function planDate(value: unknown): string | undefined {
  const text = value === undefined || value === null ? "" : String(value);
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

type Codelist = Map<number, string>;

async function codelist(name: string): Promise<Codelist> {
  try {
    const params = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: `pdk:theme_pdk_codelist_${name}_v`,
      outputFormat: "application/json",
      count: "500",
    });
    const geo = await cached(`plandata:codelist:${name}`, 60 * 60 * 24 * 30, () =>
      fetchJson<GeoJson>(`${WFS}?${params.toString()}`),
    );
    const map: Codelist = new Map();
    for (const feature of geo.features ?? []) {
      const code = numProp(feature.properties, "code");
      const text = prop(feature.properties, "text");
      if (code !== null && text) map.set(code, text);
    }
    return map;
  } catch {
    return new Map();
  }
}

export function mapPlanFeature(
  feature: GeoJsonFeature,
  type: PlanItem["type"],
  lists: { specific: Codelist; zone: Codelist } = { specific: new Map(), zone: new Map() },
): PlanItem {
  const p = feature.properties;
  const specificUsages: NonNullable<PlanItem["specificUsages"]> = [];
  // Frameworks carry up to ten numbered specific-usage slots with their own building rights.
  for (let i = 1; i <= 10; i += 1) {
    const code = numProp(p, `anvspec${i}`);
    if (code === null) continue;
    specificUsages.push({
      code,
      label: lists.specific.get(code),
      maxPlotRatioPct: numProp(p, `bygpct${i}`),
      maxFloors: numProp(p, `maxetage${i}`),
      maxHeightM: numProp(p, `maxbhjd${i}`),
    });
  }
  const zoneCode = numProp(p, "zone");
  return {
    planId: prop(p, "planid", "planId", "lokalplanid"),
    planNumber: prop(p, "plannr"),
    name:
      type === "zone"
        ? (prop(p, "zonestatus") ?? (zoneCode !== null ? lists.zone.get(zoneCode) : undefined))
        : prop(p, "plannavn", "plan_navn", "navn", "anvendelsegenerel"),
    type,
    status: prop(p, "planstatus", "status") ?? (type === "zone" ? "current" : undefined),
    usage: prop(p, "anvendelsegenerel", "anvendelse", "spec_anv"),
    zoneStatus: prop(p, "zonestatus") ?? (zoneCode !== null ? lists.zone.get(zoneCode) : undefined),
    pdfUrl: prop(p, "doklink", "pdf", "dokumentlink", "url"),
    municipalityName: prop(p, "kommunenavn", "komnavn"),
    adoptedOn: planDate(p?.datovedt),
    proposedOn: planDate(p?.datoforsl),
    consultationEndsOn: planDate(p?.datoslut),
    maxPlotRatioPct: numProp(p, "bebygpct"),
    maxFloors: numProp(p, "maxetager"),
    maxHeightM: numProp(p, "maxbygnhjd"),
    specificUsages: specificUsages.length ? specificUsages : undefined,
    buildingNotes: prop(p, "notbebygom"),
    notes: prop(p, "notat")?.slice(0, 600),
  };
}

async function wfs(typeName: string, filter: { cql?: string; bbox?: number[] }, cacheKey: string): Promise<GeoJsonFeature[]> {
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: typeName,
    outputFormat: "application/json",
    srsName: "EPSG:25832",
    count: "20",
  });
  if (filter.cql) params.set("CQL_FILTER", filter.cql);
  if (filter.bbox) params.set("bbox", `${filter.bbox.join(",")},EPSG:25832`);
  const geo = await cached(cacheKey, ttlFor("plandata"), () => fetchJson<GeoJson>(`${WFS}?${params.toString()}`));
  return geo.features ?? [];
}

function pointFilter(x: number, y: number): string {
  return `INTERSECTS(geometri,${pointWkt(x, y)})`;
}

async function pointFeatures(typeName: string, x: number, y: number): Promise<GeoJsonFeature[]> {
  return wfs(typeName, { cql: pointFilter(x, y) }, `plandata:pt:${typeName}:${x.toFixed(1)}:${y.toFixed(1)}`);
}

async function bboxFeatures(typeName: string, x: number, y: number, radius: number): Promise<GeoJsonFeature[]> {
  return wfs(
    typeName,
    { bbox: bboxAround(x, y, radius) },
    `plandata:bbox${radius}:${typeName}:${x.toFixed(1)}:${y.toFixed(1)}`,
  );
}

export async function getPlansAt(
  x: number,
  y: number,
  options: { lookupPoint?: LookupPoint } = {},
): Promise<SourceResult<PlanInfo>> {
  try {
    const [specific, zone] = await Promise.all([codelist("specifikanvendelse"), codelist("zonestatus")]);
    const lists = { specific, zone };
    const groups = await Promise.all(
      PLAN_LAYERS.map(async (layer) => {
        const covering = (await pointFeatures(layer.typeName, x, y)).map((f) => mapPlanFeature(f, layer.type, lists));
        let nearby: PlanItem[] = [];
        if (layer.type === "local_plan" || layer.type === "local_plan_proposal") {
          const ids = new Set(covering.map((item) => item.planId));
          nearby = (await bboxFeatures(layer.typeName, x, y, NEARBY_RADIUS_M))
            .map((f) => mapPlanFeature(f, layer.type, lists))
            .filter((item) => !ids.has(item.planId))
            .map((item) => ({ ...item, withinM: NEARBY_RADIUS_M }));
        }
        return { covering, nearby };
      }),
    );
    // The zone map only has polygons for byzone and sommerhusområde; everything outside them is landzone.
    const zoneGroup = groups[PLAN_LAYERS.findIndex((layer) => layer.type === "zone")];
    if (zoneGroup && zoneGroup.covering.length === 0) {
      zoneGroup.covering.push({
        name: "Landzone",
        type: "zone",
        status: "current",
        zoneStatus: "Landzone",
        notes: "Udledt: hverken by- eller sommerhuszone dækker punktet i Plandatas zonekort.",
      });
    }
    return ok("plandata", {
      items: groups.flatMap((group) => group.covering),
      nearby: groups.flatMap((group) => group.nearby),
      lookupPoint: options.lookupPoint,
    });
  } catch (error) {
    return unavailable("plandata", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

interface SiteLayer {
  typeName: string;
  category: SiteCondition["category"];
  label: string;
  /** Search radius for features that matter even when they only come close (roads, facilities). */
  radiusM?: number;
  value: (p: Record<string, unknown> | undefined) => string | undefined;
  details?: (p: Record<string, unknown> | undefined) => string | undefined;
}

/** "23er058": a plan's own reference code, not something a reader can use as the value. */
const isBareCode = (text: string) => !/\s/.test(text) && /\d/.test(text) && text.length <= 16;

/** The remark, or the plan it comes from when the remark is only a code (the code then goes in details). */
const generic = (p: Record<string, unknown> | undefined) => {
  const remark = prop(p, "bem");
  if (remark && !isBareCode(remark)) return remark;
  return prop(p, "plannavn", "plangrund", "temanavn") ?? remark ?? prop(p, "plannr");
};

const genericCode = (p: Record<string, unknown> | undefined) => {
  const remark = prop(p, "bem");
  return remark && isBareCode(remark) && prop(p, "plannavn", "plangrund", "temanavn") ? `kode ${remark}` : undefined;
};

export const SITE_LAYERS: SiteLayer[] = [
  {
    typeName: "pdk:theme_pdk_forsyningomraade_vedtaget_v",
    category: "heat_supply_area",
    label: "Varmeforsyningsområde",
    value: (p) => prop(p, "vaerdi1203"),
    details: (p) => prop(p, "forsytekst", "navn1203"),
  },
  {
    typeName: "pdk:theme_pdk_varmeplansomraade_vedtaget_v",
    category: "heat_plan_area",
    label: "Varmeplan",
    value: (p) => prop(p, "vaerdi1207"),
    details: (p) => {
      const start = prop(p, "konvstartaar");
      const end = prop(p, "konvslutaar");
      const period = start ? `konvertering ${start}${end && end !== start ? `–${end}` : ""}` : undefined;
      return [prop(p, "plannavn"), prop(p, "delnavn"), period].filter(Boolean).join(" · ") || undefined;
    },
  },
  {
    typeName: "pdk:theme_pdk_tilslutningspligtomraade_vedtaget_v",
    category: "connection_obligation",
    label: "Tilslutningspligt (varme)",
    value: (p) => prop(p, "vaerd1204b", "vaerd1204a"),
    details: (p) => prop(p, "navn1204"),
  },
  {
    typeName: "pdk:theme_pdk_kloakopland_vedtaget_v",
    category: "sewer_catchment",
    label: "Kloakopland",
    value: (p) => prop(p, "vaerd1201a"),
    details: (p) => {
      const current = prop(p, "vaerd1201a");
      const planned = prop(p, "vaerd1201b");
      const parts = [prop(p, "navn1201")];
      if (planned && planned !== current) parts.push(`planlagt: ${planned}`);
      // 1900 is used as a placeholder for "no deadline".
      const year = numProp(p, "sluaar1201");
      if (year !== null && year > 1900) parts.push(`slutår ${year}`);
      return parts.filter(Boolean).join(" · ") || undefined;
    },
  },
  {
    typeName: "pdk:theme_pdk_spildevandsplan_vedtaget",
    category: "wastewater_plan",
    label: "Spildevandsplan",
    value: (p) => prop(p, "plannavn"),
  },
  { typeName: "pdk:theme_pdk_oversvoemerosion_vedtaget", category: "flood_or_erosion_risk", label: "Risiko for oversvømmelse eller erosion", value: generic, details: genericCode },
  { typeName: "pdk:theme_pdk_terraennaertgrundvand_vedtaget", category: "near_surface_groundwater", label: "Terrænnært grundvand", value: generic, details: genericCode },
  { typeName: "pdk:theme_pdk_lavbundsareal_vedtaget", category: "low_lying_land", label: "Lavbundsareal", value: generic, details: genericCode },
  { typeName: "pdk:theme_pdk_stoejbelastetareal_vedtaget", category: "noise_affected_area", label: "Støjbelastet areal", value: generic, details: genericCode },
  { typeName: "pdk:theme_pdk_storehusdyrbrug_vedtaget", category: "large_livestock_farm_area", label: "Område til store husdyrbrug", value: generic, details: genericCode },
  {
    typeName: "pdk:theme_pdk_planlagttrafikanlaeg_vedtaget",
    category: "planned_road_or_rail",
    label: "Planlagt trafikanlæg",
    radiusM: 150,
    value: generic,
  },
  {
    typeName: "pdk:theme_pdk_planlagttekniskanlaeg_vedtaget",
    category: "planned_technical_facility",
    label: "Planlagt teknisk anlæg",
    radiusM: 300,
    value: generic,
  },
  { typeName: "pdk:theme_pdk_tekniskanlaegkonsekvensomraade_vedtaget", category: "technical_facility_buffer", label: "Konsekvensområde om teknisk anlæg", value: generic, details: genericCode },
  { typeName: "pdk:theme_pdk_transformationsomraade_vedtaget", category: "transformation_area", label: "Transformationsområde", value: generic, details: genericCode },
  { typeName: "pdk:theme_pdk_kulturhistoriskbevaringsvaerdi_vedtaget", category: "cultural_heritage_value", label: "Kulturhistorisk bevaringsværdi", value: generic, details: genericCode },
  { typeName: "pdk:theme_pdk_vaerdifuldtkulturmiljoe_vedtaget", category: "valuable_cultural_environment", label: "Værdifuldt kulturmiljø", value: generic, details: genericCode },
];

export async function getSiteConditionsAt(
  x: number,
  y: number,
  options: { lookupPoint?: LookupPoint } = {},
): Promise<SourceResult<SiteConditions>> {
  const failedLayers: string[] = [];
  const groups = await Promise.all(
    SITE_LAYERS.map(async (layer) => {
      try {
        const features = layer.radiusM
          ? await bboxFeatures(layer.typeName, x, y, layer.radiusM)
          : await pointFeatures(layer.typeName, x, y);
        return features.map((feature): SiteCondition => {
          const p = feature.properties;
          const details = layer.details?.(p);
          const within = layer.radiusM ? `inden for ca. ${layer.radiusM} m` : undefined;
          return {
            category: layer.category,
            label: layer.label,
            value: layer.value(p)?.slice(0, 300),
            details: [details, within].filter(Boolean).join(" · ") || undefined,
            pdfUrl: prop(p, "doklink"),
          };
        });
      } catch {
        failedLayers.push(layer.typeName);
        return [];
      }
    }),
  );
  if (failedLayers.length === SITE_LAYERS.length) {
    return unavailable("plandata", "upstream_error", "No Plandata site layers answered");
  }
  // Two plan objects can carry the same remark (Hvide Sande has two noise areas coded 23er058): list it once.
  const seen = new Set<string>();
  const items = groups.flat().filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return ok("plandata", {
    items,
    checkedLayers: SITE_LAYERS.length - failedLayers.length,
    failedLayers,
    lookupPoint: options.lookupPoint,
  });
}
