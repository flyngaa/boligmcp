import { getConfig } from "../../config.js";
import { ttlFor } from "../../catalog.js";
import { cached } from "../../lib/cache.js";
import { centreValue, percentile, readFloat32Tiff, validValues, type RasterGrid } from "../../lib/tiff.js";
import { ok, unavailable, type SourceResult, type TerrainInfo } from "../../types.js";
import { datafordelerUnavailable } from "./client.js";

const WCS = "https://wcs.datafordeler.dk/DHMNedboer/dhm_wcs/1.0.0/WCS";

/** Half-width of the window around the point, and the surroundings compared against. */
const POINT_HALF_M = 4;
const SURROUNDINGS_RADIUS_M = 250;

async function coverage(name: "dhm_terraen" | "dhm_overflade", x: number, y: number, half: number, pixels: number): Promise<RasterGrid> {
  const key = getConfig().datafordelerApiKey!;
  const params = new URLSearchParams({
    service: "WCS",
    version: "1.0.0",
    request: "GetCoverage",
    coverage: name,
    crs: "EPSG:25832",
    bbox: [x - half, y - half, x + half, y + half].join(","),
    width: String(pixels),
    height: String(pixels),
    format: "GTiff",
    apikey: key,
  });
  const response = await fetch(`${WCS}?${params.toString()}`, {
    headers: { "user-agent": "boligmcp (https://github.com/flyngaa/boligmcp)" },
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 200);
    if (response.status === 401 || response.status === 403) throw new Error(`FORBIDDEN: DHM WCS answered ${response.status}`);
    throw new Error(`DHM WCS answered HTTP ${response.status}: ${text}`);
  }
  return readFloat32Tiff(await response.arrayBuffer());
}

const round = (value: number) => Math.round(value * 100) / 100;

export function summarizeTerrain(
  terrain: RasterGrid,
  surface: RasterGrid | undefined,
  wide: RasterGrid,
  lookupPoint?: "building" | "address",
): TerrainInfo | undefined {
  const terrainM = centreValue(terrain);
  const around = validValues(wide).sort((a, b) => a - b);
  if (terrainM === undefined || around.length === 0) return undefined;
  const surfaceValues = surface ? validValues(surface).sort((a, b) => a - b) : [];
  // The 95th percentile catches the roof ridge without letting one stray pixel decide.
  const surfaceMaxM = percentile(surfaceValues, 95);
  const medianM = percentile(around, 50)!;
  return {
    datum: "DVR90",
    lookupPoint,
    terrainM: round(terrainM),
    surfaceMaxM: surfaceMaxM !== undefined ? round(surfaceMaxM) : undefined,
    heightAboveTerrainM: surfaceMaxM !== undefined ? round(surfaceMaxM - terrainM) : undefined,
    surroundings: {
      radiusM: SURROUNDINGS_RADIUS_M,
      medianM: round(medianM),
      p10M: round(percentile(around, 10)!),
      minM: round(around[0]!),
      maxM: round(around[around.length - 1]!),
    },
    relativeToSurroundingsM: round(terrainM - medianM),
  };
}

export async function getTerrainAt(
  x: number,
  y: number,
  options: { lookupPoint?: "building" | "address" } = {},
): Promise<SourceResult<TerrainInfo>> {
  if (!getConfig().datafordelerApiKey) return datafordelerUnavailable("dhm");
  try {
    const result = await cached(`dhm:${x.toFixed(1)}:${y.toFixed(1)}`, ttlFor("dhm"), async () => {
      const [terrain, surface, wide] = await Promise.all([
        coverage("dhm_terraen", x, y, POINT_HALF_M, 20),
        coverage("dhm_overflade", x, y, POINT_HALF_M, 20).catch(() => undefined),
        // 5 m pixels are plenty for the surroundings and keep the download small.
        coverage("dhm_terraen", x, y, SURROUNDINGS_RADIUS_M, 100),
      ]);
      return summarizeTerrain(terrain, surface, wide, options.lookupPoint) ?? null;
    });
    if (!result) return unavailable("dhm", "not_found", "No terrain data at this point (outside Denmark or at sea)");
    return ok("dhm", result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("FORBIDDEN")) {
      return unavailable("dhm", "missing_credentials", "Datafordeleren refused the DHM request for this API key. Check that the key is active.");
    }
    return unavailable("dhm", "upstream_error", message);
  }
}
