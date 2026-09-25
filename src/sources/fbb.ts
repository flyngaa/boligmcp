import { ttlFor } from "../catalog.js";
import { cached } from "../lib/cache.js";
import { bboxAround } from "../lib/geo.js";
import { fetchJson } from "../lib/http.js";
import { ok, unavailable, type HeritageBuilding, type HeritageInfo, type SourceResult } from "../types.js";

const ENDPOINT = "https://www.kulturarv.dk/geoserver/wfs";
/** Listed buildings are only on the fredede view; SAVE values for the rest are on view_bygning_alle. */
const LAYERS = ["fbb:view_bygning_alle", "fbb:view_bygning_fredede"] as const;
/** Half-width of the lookup box. The FBB point can sit on the building, not on the address. */
const HALF_M = 50;

interface GeoJson {
  features?: Array<{ properties?: Record<string, unknown> }>;
}

function integer(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) ? parsed : undefined;
}

/** Keep assessed SAVE values (1–9) and listed buildings. -1 means not assessed. */
export function mapHeritageFeature(properties: Record<string, unknown> | undefined): HeritageBuilding | undefined {
  if (!properties) return undefined;
  const save = integer(properties.bevaringsvaerdi);
  const saveValue = save !== undefined && save >= 1 && save <= 9 ? save : undefined;
  const listed = properties.fredet === true || properties.fredet === "true";
  if (!saveValue && !listed) return undefined;
  const listingStatus = integer(properties.fredningsstatus);
  const address = typeof properties.adresse === "string" ? properties.adresse.trim() : undefined;
  return {
    address: address || undefined,
    saveValue,
    listed: listed || undefined,
    listingStatus,
  };
}

async function featuresIn(layer: string, bbox: string): Promise<GeoJson> {
  const query = new URLSearchParams({
    SERVICE: "WFS",
    VERSION: "1.1.0",
    REQUEST: "GetFeature",
    typeName: layer,
    outputFormat: "application/json",
    srsName: "EPSG:25832",
    bbox,
    maxFeatures: "20",
  });
  return fetchJson<GeoJson>(`${ENDPOINT}?${query}`);
}

export async function getHeritageAt(x: number, y: number): Promise<SourceResult<HeritageInfo>> {
  try {
    const bbox = bboxAround(x, y, HALF_M).join(",");
    const layers = await cached(`fbb:v2:${x.toFixed(0)}:${y.toFixed(0)}`, ttlFor("fbb"), async () => {
      const settled = await Promise.allSettled(LAYERS.map((layer) => featuresIn(layer, bbox)));
      const okLayers = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      if (okLayers.length === 0) {
        const failed = settled.find((result) => result.status === "rejected");
        throw failed?.status === "rejected" ? failed.reason : new Error("FBB returned no layers");
      }
      return okLayers;
    });
    const seen = new Set<string>();
    const items: HeritageBuilding[] = [];
    for (const geo of layers) {
      for (const feature of geo.features ?? []) {
        const item = mapHeritageFeature(feature.properties);
        if (!item) continue;
        const key = `${item.address ?? ""}:${item.saveValue ?? ""}:${item.listed ?? false}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
    }
    return ok("fbb", { items });
  } catch (error) {
    return unavailable("fbb", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}
