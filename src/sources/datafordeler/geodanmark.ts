import { getConfig } from "../../config.js";
import { ttlFor } from "../../catalog.js";
import { cached } from "../../lib/cache.js";
import { fetchText } from "../../lib/http.js";
import { ok, unavailable, type Building, type Footprint, type SourceResult } from "../../types.js";
import { datafordelerUnavailable } from "./client.js";

const WFS = "https://wfs.datafordeler.dk/GeoDanmarkVektor/GeoDanmark60_NOHIST_GML3/1.0.0/WFS";

interface Outline {
  bbrId?: string;
  measuredAt?: string;
  area: number;
  /** Exterior ring in EPSG:25832, metres. The closing point is kept when the source repeats it. */
  ring: Array<[number, number]>;
}

/** Easting/northing pairs from a GML posList. A 3D list stores height as every third number, which is dropped. */
export function ringPoints(posList: string, dimension: number): Array<[number, number]> {
  const numbers = posList.trim().split(/\s+/).map(Number);
  const points: Array<[number, number]> = [];
  for (let i = 0; i + 1 < numbers.length; i += dimension) points.push([numbers[i]!, numbers[i + 1]!]);
  return points;
}

/** Shoelace area of the first ring in a GML posList with 2D or 3D coordinates. */
export function ringArea(posList: string, dimension: number): number {
  const points = ringPoints(posList, dimension);
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % points.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** Even-odd test. The ring may repeat its first point at the end. */
export function pointInRing(x: number, y: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Pulls each Bygning's BBR id and outline area out of the GML3 response. */
export function parseOutlines(gml: string): Outline[] {
  const outlines: Outline[] = [];
  for (const match of gml.matchAll(/<gdk60:Bygning\b[\s\S]*?<\/gdk60:Bygning>/g)) {
    const feature = match[0];
    const exterior = feature.match(/<gml:exterior>[\s\S]*?<gml:posList[^>]*?(?:srsDimension="(\d)")?[^>]*>([^<]+)<\/gml:posList>/);
    if (!exterior) continue;
    const dimension = Number(exterior[1] ?? feature.match(/srsDimension="(\d)"/)?.[1] ?? 2);
    const ring = ringPoints(exterior[2]!, dimension);
    outlines.push({
      bbrId: feature.match(/<gdk60:BBRUUID>([^<]+)</)?.[1]?.trim(),
      measuredAt: feature.match(/<gdk60:maalestedBygning>([^<]+)</)?.[1]?.trim(),
      area: ringArea(exterior[2]!, dimension),
      ring,
    });
  }
  return outlines;
}

async function outlinesNear(x: number, y: number): Promise<Outline[]> {
  const params = new URLSearchParams({
    service: "WFS",
    request: "GetFeature",
    version: "2.0.0",
    typenames: "gdk60:Bygning",
    count: "30",
    srsName: "EPSG:25832",
    bbox: `${x - 25},${y - 25},${x + 25},${y + 25},EPSG:25832`,
    apikey: getConfig().datafordelerApiKey!,
  });
  return cached(`gdk:bygning:ring:${x.toFixed(1)}:${y.toFixed(1)}`, ttlFor("geodanmark"), async () =>
    parseOutlines(await fetchText(`${WFS}?${params.toString()}`, { accept: "application/gml+xml" })),
  );
}

/**
 * The measured outline that contains the point, preferring a BBR id match when several do.
 * Used to draw the building on the 3D map. Returns undefined when none contain the point.
 */
export async function outlineContaining(x: number, y: number, buildingId?: string): Promise<Array<[number, number]> | undefined> {
  if (!getConfig().datafordelerApiKey) return undefined;
  const outlines = (await outlinesNear(x, y)).filter((outline) => pointInRing(x, y, outline.ring));
  const match = outlines.find((outline) => buildingId && outline.bbrId === buildingId) ?? outlines.sort((a, b) => a.area - b.area)[0];
  return match && match.ring.length >= 4 ? match.ring : undefined;
}

/**
 * Measured building outlines from GeoDanmark, matched to BBR buildings by BBRUUID.
 * A large gap to BBR's registered built area can mean an unregistered extension or an outdated BBR.
 */
export async function getFootprints(buildings: Building[]): Promise<SourceResult<Footprint[]>> {
  if (!getConfig().datafordelerApiKey) return datafordelerUnavailable("geodanmark");
  try {
    const located = buildings.filter((building) => building.buildingId && building.coordinate);
    const found = await Promise.all(
      located.map(async (building) => {
        const { x, y } = building.coordinate!.epsg25832;
        const match = (await outlinesNear(x, y)).find((outline) => outline.bbrId === building.buildingId);
        if (!match) return undefined;
        const footprint = Math.round(match.area);
        const registered = building.builtArea ?? null;
        const result: Footprint = {
          buildingId: building.buildingId!,
          footprintM2: footprint,
          bbrBuiltAreaM2: registered,
          differenceM2: registered !== null ? footprint - registered : null,
          measuredAt: match.measuredAt,
        };
        return result;
      }),
    );
    const footprints = found.filter((item): item is Footprint => Boolean(item));
    if (footprints.length === 0) return unavailable("geodanmark", "not_found", "No GeoDanmark outline matched the BBR buildings");
    return ok("geodanmark", footprints);
  } catch (error) {
    return unavailable("geodanmark", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}
