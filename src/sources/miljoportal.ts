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
    if (match && match[1] !== undefined && match[1] !== null) return String(match[1]).trim() || undefined;
  }
  return undefined;
}

/** A locality spanning many parcels lists a soil certificate link per parcel (21 at Nordhavn); keep a few. */
function certificateLinks(text: string | undefined, max = 3): string | undefined {
  const links = text?.split(";").map((link) => link.trim()).filter(Boolean);
  if (!links?.length) return undefined;
  const more = links.length - max;
  return `${links.slice(0, max).join(";")}${more > 0 ? ` (+${more} flere matrikler)` : ""}`;
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
    details: certificateLinks(pick(p, "Jordforureningsattester", "beskrivelse")),
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
    // Not swallowed: without the point test a locality under the property would read as "nearby"; the layer is
    // reported in failedLayers instead.
    cached(`miljo:pt:${key}`, ttlFor("miljoportal"), () =>
      fetchJson<GeoJson>(`${layer.endpoint}?${params(layer, { cql: `INTERSECTS(${layer.geometryField},POINT(${x} ${y}))` })}`),
    ),
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
    const failedLayers = LAYERS.filter((_, index) => groups[index]?.status === "rejected").map((layer) => layer.typeName);
    if (failedLayers.length === LAYERS.length) {
      return unavailable("miljoportal", "upstream_error", "No Miljøportal layer answered");
    }
    const notes: string[] = [];
    // Without the parcels (no Datafordeleren key) a locality on the property can look like a neighbour's:
    // Levantkaj 4's own V1/V2 locality is found only through its parcel list.
    if (!parcels.length) {
      notes.push(
        "Ejendommens matrikler er ukendte, så onProperty bygger kun på opslagspunktet; en lokalitet i nærheden kan ligge på ejendommen.",
      );
    }
    if (failedLayers.length) notes.push(`Lag uden svar: ${failedLayers.join(", ")}.`);
    return ok("miljoportal", {
      items,
      ...(failedLayers.length ? { failedLayers } : {}),
      parcelsChecked: parcels.length > 0,
      ...(notes.length ? { note: notes.join(" ") } : {}),
    });
  } catch (error) {
    return unavailable(
      "miljoportal",
      "upstream_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}
