import { ttlFor } from "../catalog.js";
import { cached } from "../lib/cache.js";
import { bboxAround } from "../lib/geo.js";
import { fetchJson } from "../lib/http.js";
import { parseDesignation } from "./adressevaelger.js";
import { ok, unavailable, type HeritageBuilding, type HeritageInfo, type SourceResult } from "../types.js";

const ENDPOINT = "https://www.kulturarv.dk/geoserver/wfs";
/** Listed buildings are only on the fredede view; SAVE values for the rest are on view_bygning_alle. */
const LAYERS = ["fbb:view_bygning_alle", "fbb:view_bygning_fredede"] as const;
/** Margin around the property's buildings. The FBB point sits on the building, not on the address. */
const HALF_M = 50;
/** On an estate, the FBB point nearest one of the property's buildings, and this close, is that building. */
const NEAR_M = 25;
/** Buildings spread wider than this make an estate or campus, where FBB files buildings under other numbers. */
const ESTATE_SPAN_M = 60;
/** Wider than this (a big estate far apart), only the main building's surroundings are searched. */
const MAX_SPAN_M = 1500;

interface GeoJson {
  features?: Array<{ properties?: Record<string, unknown>; geometry?: { coordinates?: unknown } }>;
}

type Point = { x: number; y: number };

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

function pointOf(geometry: { coordinates?: unknown } | undefined): Point | undefined {
  const coords = geometry?.coordinates;
  if (!Array.isArray(coords)) return undefined;
  // Points are [x, y]; multipoints [[x, y], ...].
  const pair = Array.isArray(coords[0]) ? (coords[0] as unknown[]) : coords;
  const x = Number(pair[0]);
  const y = Number(pair[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

/** The box around every building of the property, or around the main point when the buildings lie far apart. */
export function lookupBox(main: Point, buildings: Point[] = []): [number, number, number, number] {
  const points = [main, ...buildings];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (span > MAX_SPAN_M) return bboxAround(main.x, main.y, HALF_M);
  return [Math.min(...xs) - HALF_M, Math.min(...ys) - HALF_M, Math.max(...xs) + HALF_M, Math.max(...ys) + HALF_M];
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
    maxFeatures: "50",
  });
  return fetchJson<GeoJson>(`${ENDPOINT}?${query}`);
}

/** "Nyhavn 18" and "Nyhavn 18A, 1051 København K" name the same building: street and number digits. */
function buildingKey(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const parsed = parseDesignation(address);
  const digits = parsed.houseNumber?.match(/\d+/)?.[0];
  return parsed.street && digits ? `${parsed.street.toLowerCase().replace(/\s+/g, " ")}|${digits}` : undefined;
}

/**
 * Marks which FBB buildings are at the property. The lookup box also catches neighbours; when none of the
 * buildings carries the property's address, nothing is marked because the box cannot tell them apart.
 */
export function markAtProperty(
  items: Array<HeritageBuilding & { point?: Point }>,
  addresses: string[],
  buildings: Point[] = [],
): HeritageBuilding[] {
  const own = new Set(addresses.map(buildingKey).filter(Boolean));
  const byAddress = (item: HeritageBuilding) => own.has(buildingKey(item.address));
  const strip = ({ point: _point, ...item }: HeritageBuilding & { point?: Point }) => item;
  if (!own.size && !buildings.length) return items.map(strip);
  // In a town the address decides: terraced houses stand within metres of their neighbours.
  const xs = buildings.map((b) => b.x);
  const ys = buildings.map((b) => b.y);
  const spread = buildings.length > 1 ? Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) : 0;
  const nearest = new Set<number>();
  if (spread > ESTATE_SPAN_M) {
    // On an estate FBB files buildings under other numbers: each building claims its nearest FBB point.
    for (const building of buildings) {
      let best = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      items.forEach((item, index) => {
        if (!item.point) return;
        const distance = Math.hypot(item.point.x - building.x, item.point.y - building.y);
        if (distance < bestDistance) {
          best = index;
          bestDistance = distance;
        }
      });
      if (best >= 0 && bestDistance <= NEAR_M) nearest.add(best);
    }
  }
  return items.map((item, index) => ({ ...strip(item), atProperty: byAddress(item) || nearest.has(index) }));
}

export async function getHeritageAt(
  x: number,
  y: number,
  options: { addresses?: string[]; buildings?: Point[] } = {},
): Promise<SourceResult<HeritageInfo>> {
  try {
    const box = lookupBox({ x, y }, options.buildings);
    const bbox = box.join(",");
    const layers = await cached(`fbb:v3:${box.map((value) => value.toFixed(0)).join(":")}`, ttlFor("fbb"), async () => {
      const settled = await Promise.allSettled(LAYERS.map((layer) => featuresIn(layer, bbox)));
      const okLayers = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      if (okLayers.length === 0) {
        const failed = settled.find((result) => result.status === "rejected");
        throw failed?.status === "rejected" ? failed.reason : new Error("FBB returned no layers");
      }
      return okLayers;
    });
    const seen = new Set<string>();
    const items: Array<HeritageBuilding & { point?: Point }> = [];
    for (const geo of layers) {
      for (const feature of geo.features ?? []) {
        const item = mapHeritageFeature(feature.properties);
        if (!item) continue;
        const key = `${item.address ?? ""}:${item.saveValue ?? ""}:${item.listed ?? false}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ ...item, point: pointOf(feature.geometry) });
      }
    }
    const marked = markAtProperty(items, options.addresses ?? [], options.buildings ?? []);
    // The property's own buildings first.
    marked.sort((a, b) => Number(b.atProperty === true) - Number(a.atProperty === true));
    return ok("fbb", { items: marked });
  } catch (error) {
    return unavailable("fbb", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}
