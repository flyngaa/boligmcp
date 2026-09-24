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
}

const LAYERS: Layer[] = [
  {
    endpoint: "https://jord.miljoeportal.dk/geo/wfs",
    typeName: "DKJord:View_V1Flader",
    category: "soil_v1",
  },
  {
    endpoint: "https://jord.miljoeportal.dk/geo/wfs",
    typeName: "DKJord:View_V2Flader",
    category: "soil_v2",
  },
  {
    endpoint: "https://geoserver.plandata.dk/geoserver/wfs",
    typeName: "knz:theme-knz-kystnaerhedszone-polygon",
    category: "coastal_protection",
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
  return {
    category,
    name: pick(p, "Lokalitetsnavn", "navn", "lokalitetsnavn", "plannavn"),
    status: pick(p, "Lokalitetetsforureningsstatus", "status", "kortlaegningsstatus"),
    localityNumber: pick(p, "Lokalitetsnr", "lokalitetsnr", "Id"),
    details: pick(p, "Lokalitetsadresse", "Jordforureningsattester", "beskrivelse"),
  };
}

async function queryLayer(layer: Layer, x: number, y: number): Promise<EnvironmentItem[]> {
  const [minx, miny, maxx, maxy] = bboxAround(x, y, 80);
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: layer.typeName,
    outputFormat: "application/json",
    srsName: "EPSG:25832",
    count: "20",
    bbox: `${minx},${miny},${maxx},${maxy},EPSG:25832`,
  });
  const geo = await cached(
    `miljo:${layer.typeName}:${x.toFixed(0)}:${y.toFixed(0)}`,
    ttlFor("miljoportal"),
    () => fetchJson<GeoJson>(`${layer.endpoint}?${params.toString()}`),
  );
  return (geo.features ?? []).map((feature) => mapFeature(feature, layer.category));
}

export async function getEnvironmentAt(
  x: number,
  y: number,
): Promise<SourceResult<EnvironmentInfo>> {
  try {
    const groups = await Promise.allSettled(LAYERS.map((layer) => queryLayer(layer, x, y)));
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
