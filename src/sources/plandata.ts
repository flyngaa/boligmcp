import { ttlFor } from "../catalog.js";
import { cached } from "../lib/cache.js";
import { bboxAround, pointWkt } from "../lib/geo.js";
import { fetchJson } from "../lib/http.js";
import { ok, unavailable, type PlanInfo, type PlanItem, type SourceResult } from "../types.js";

const WFS = "https://geoserver.plandata.dk/geoserver/wfs";

const LAYERS: { typeName: string; type: PlanItem["type"] }[] = [
  { typeName: "pdk:theme_pdk_lokalplan_vedtaget", type: "local_plan" },
  { typeName: "pdk:theme_pdk_kommuneplanramme_vedtaget_v", type: "municipal_framework" },
  { typeName: "pdk:theme_pdk_zonekort_v", type: "zone" },
];

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
    if (value !== undefined && value !== null && String(value).trim()) return String(value);
  }
  return undefined;
}

function mapFeature(feature: GeoJsonFeature, type: PlanItem["type"]): PlanItem {
  const p = feature.properties;
  return {
    planId: prop(p, "planid", "planId", "lokalplanid"),
    name: prop(p, "plannavn", "plan_navn", "navn", "anvendelsegenerel", "komnr"),
    type,
    status: prop(p, "status", "planstatus") ?? (type === "zone" ? "current" : "vedtaget"),
    usage: prop(p, "anvendelsegenerel", "anvendelse", "spec_anv"),
    zoneStatus: prop(p, "zonestatus", "zone"),
    pdfUrl: prop(p, "doklink", "pdf", "dokumentlink", "url"),
    municipalityName: prop(p, "kommunenavn", "komnavn"),
  };
}

async function queryLayer(
  typeName: string,
  type: PlanItem["type"],
  x: number,
  y: number,
): Promise<PlanItem[]> {
  const [minx, miny, maxx, maxy] = bboxAround(x, y, 40);
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeName,
    outputFormat: "application/json",
    srsName: "EPSG:25832",
    count: "20",
    bbox: `${minx},${miny},${maxx},${maxy},EPSG:25832`,
  });
  const url = `${WFS}?${params.toString()}`;
  try {
    const geo = await cached(`plandata:${typeName}:${x.toFixed(1)}:${y.toFixed(1)}`, ttlFor("plandata"), () =>
      fetchJson<GeoJson>(url),
    );
    return (geo.features ?? []).map((feature) => mapFeature(feature, type));
  } catch {
    const cql = `INTERSECTS(geometri,${pointWkt(x, y)})`;
    const fallback = new URLSearchParams({
      service: "WFS",
      version: "1.1.0",
      request: "GetFeature",
      typeName,
      outputFormat: "application/json",
      srsName: "EPSG:25832",
      CQL_FILTER: cql,
    });
    const geo = await fetchJson<GeoJson>(`${WFS}?${fallback.toString()}`);
    return (geo.features ?? []).map((feature) => mapFeature(feature, type));
  }
}

export async function getPlansAt(x: number, y: number): Promise<SourceResult<PlanInfo>> {
  try {
    const groups = await Promise.all(
      LAYERS.map((layer) => queryLayer(layer.typeName, layer.type, x, y)),
    );
    return ok("plandata", { items: groups.flat() });
  } catch (error) {
    return unavailable(
      "plandata",
      "upstream_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}
