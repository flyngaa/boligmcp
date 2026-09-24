import { ttlFor } from "../catalog.js";
import { cached } from "../lib/cache.js";
import { bboxAround } from "../lib/geo.js";
import { fetchJson } from "../lib/http.js";
import {
  ok,
  unavailable,
  type EnvironmentInfo,
  type EnvironmentItem,
  type SourceResult,
} from "../types.js";

interface Layer {
  endpoint: string;
  typeName: string;
  category: EnvironmentItem["category"];
  geometryField: string;
}

const LAYERS: Layer[] = [
  {
    endpoint: "https://jord.miljoeportal.dk/geo/wfs",
    typeName: "DKJord:View_V1Flader",
    category: "soil_v1",
    geometryField: "Fladegeometri",
  },
  {
    endpoint: "https://jord.miljoeportal.dk/geo/wfs",
    typeName: "DKJord:View_V2Flader",
    category: "soil_v2",
    geometryField: "Fladegeometri",
  },
  {
    endpoint: "https://geoserver.plandata.dk/geoserver/wfs",
    typeName: "knz:theme-knz-kystnaerhedszone-polygon",
    category: "coastal_protection",
    geometryField: "the_geom",
  },
];

interface GeoJsonFeature {
  properties?: Record<string, unknown>;
}

interface GeoJson {
  features?: GeoJsonFeature[];
}

function pick(props: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!props) return undefined;
  for (const key of keys) {
    const match = Object.entries(props).find(([k]) => k.toLowerCase() === key.toLowerCase());
    if (match && match[1] !== undefined && match[1] !== null) return String(match[1]);
  }
  return undefined;
}

function mapFeature(
  feature: GeoJsonFeature,
  category: EnvironmentItem["category"],
): EnvironmentItem {
  const p = feature.properties;
  const matrikler = pick(p, "Lokalitetsmatrikler");
  return {
    category,
    name: pick(p, "Lokalitetsnavn", "navn", "lokalitetsnavn", "plannavn"),
    status: pick(p, "Lokalitetetsforureningsstatus", "status", "kortlaegningsstatus"),
    localityNumber: pick(p, "Lokalitetsnr", "lokalitetsnr", "Id"),
    details: pick(p, "Jordforureningsattester", "beskrivelse"),
    address: pick(p, "Lokalitetetsadresse", "Lokalitetsadresse"),
    cadastralDistrictCode: pick(p, "Lokalitetsejerlavkode"),
    cadastralNumbers: matrikler
      ?.split(/[,;]/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  };
}

function params(layer: Layer, filter: { cql?: string; bbox?: number[] }): string {
  const query = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: layer.typeName,
    outputFormat: "application/json",
    srsName: "EPSG:25832",
    count: "20",
  });
  if (filter.cql) query.set("CQL_FILTER", filter.cql);
  if (filter.bbox) query.set("bbox", `${filter.bbox.join(",")},EPSG:25832`);
  return query.toString();
}

/** Radius for localities reported as nearby rather than on the property. */
const NEARBY_RADIUS_M = 80;

async function queryLayer(
  layer: Layer,
  x: number,
  y: number,
  parcels: ParcelRef[],
): Promise<EnvironmentItem[]> {
  const key = `${layer.typeName}:${x.toFixed(0)}:${y.toFixed(0)}`;
  const [inside, around] = await Promise.all([
    cached(`miljo:pt:${key}`, ttlFor("miljoportal"), () =>
      fetchJson<GeoJson>(`${layer.endpoint}?${params(layer, { cql: `INTERSECTS(${layer.geometryField},POINT(${x} ${y}))` })}`),
    ).catch(() => ({ features: [] }) as GeoJson),
    cached(`miljo:${key}`, ttlFor("miljoportal"), () =>
      fetchJson<GeoJson>(`${layer.endpoint}?${params(layer, { bbox: bboxAround(x, y, NEARBY_RADIUS_M) })}`),
    ),
  ]);
  const insideIds = new Set((inside.features ?? []).map((feature) => mapFeature(feature, layer.category).localityNumber));
  const items = new Map<string, EnvironmentItem>();
  for (const feature of [...(inside.features ?? []), ...(around.features ?? [])]) {
    const item = mapFeature(feature, layer.category);
    const key = item.localityNumber ?? item.name ?? JSON.stringify(item);
    if (items.has(key)) continue;
    const listsParcel = parcels.some(
      (parcel) =>
        parcel.cadastralDistrictCode &&
        parcel.cadastralDistrictCode === item.cadastralDistrictCode &&
        item.cadastralNumbers?.includes(parcel.cadastralNumber?.toLowerCase() ?? ""),
    );
    items.set(key, { ...item, onProperty: insideIds.has(item.localityNumber) || listsParcel });
  }
  return [...items.values()];
}

export interface ParcelRef {
  cadastralDistrictCode?: string;
  cadastralNumber?: string;
}

export async function getEnvironmentAt(
  x: number,
  y: number,
  parcels: ParcelRef[] = [],
): Promise<SourceResult<EnvironmentInfo>> {
  try {
    const groups = await Promise.allSettled(LAYERS.map((layer) => queryLayer(layer, x, y, parcels)));
    const items = groups.flatMap((group) => (group.status === "fulfilled" ? group.value : []));
    return ok("miljoportal", { items });
  } catch (error) {
    return unavailable(
      "miljoportal",
      "upstream_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}
