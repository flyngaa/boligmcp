import { setupHint, ttlFor } from "../catalog.js";
import { getConfig } from "../config.js";
import { cacheGet, cacheSet } from "../lib/cache.js";
import { etrs89ToWgs84 } from "../lib/geo.js";
import { getTerrainAt } from "./datafordeler/dhm.js";
import { projectToPixel, readFacadeJpeg, type ObliqueCamera } from "./skraafoto.js";
import { ok, unavailable, type SourceResult } from "../types.js";

const ORTHO_URL = "https://api.dataforsyningen.dk/orto_foraar_DAF";
const STAC_URL = "https://api.dataforsyningen.dk/rest/skraafoto_api/v1.0";
const VIEWER_URL = "https://skraafoto.dataforsyningen.dk/";
const DIRECTIONS = ["north", "east", "south", "west", "nadir"] as const;
const HALF_METERS = 50;
const PIXELS = 640;

export interface ObliqueShot {
  direction: string;
  itemId: string;
  collection: string;
  takenAt?: string;
}

export interface FacadeView {
  direction: string;
  itemId: string;
  takenAt?: string;
  widthPx: number;
  heightPx: number;
}

export interface AerialPhoto {
  layer: string;
  widthM: number;
  attribution: string;
  viewerUrl: string;
  obliques: ObliqueShot[];
  facade: FacadeView | null;
}

interface InteriorOrientation {
  focal_length?: number;
  pixel_spacing?: number[];
  principal_point_offset?: number[];
  sensor_array_dimensions?: number[];
}

interface StacFeature {
  id?: string;
  bbox?: number[];
  collection?: string;
  assets?: { data?: { href?: string } };
  properties?: {
    direction?: string;
    datetime?: string;
    "pers:rotation_matrix"?: number[];
    "pers:perspective_center"?: number[];
    "pers:interior_orientation"?: InteriorOrientation;
  };
}

/** WMS 1.1.1 GetMap. The token is sent as a header, never in this URL. */
export function orthophotoUrl(x: number, y: number): string {
  const params = new URLSearchParams({
    service: "WMS",
    version: "1.1.1",
    request: "GetMap",
    layers: "orto_foraar_12_5",
    styles: "",
    srs: "EPSG:25832",
    bbox: `${x - HALF_METERS},${y - HALF_METERS},${x + HALF_METERS},${y + HALF_METERS}`,
    width: String(PIXELS),
    height: String(PIXELS),
    format: "image/jpeg",
  });
  return `${ORTHO_URL}?${params.toString()}`;
}

export function latestSkaafotoCollection(ids: string[]): string | undefined {
  let best: { id: string; year: number } | undefined;
  for (const id of ids) {
    const year = Number(/skraafotos(\d{4})$/.exec(id)?.[1]);
    if (!year) continue;
    if (!best || year > best.year) best = { id, year };
  }
  return best?.id;
}

/** One shot per direction: a photo whose footprint contains the point, else the nearest. */
export function pickObliques(features: StacFeature[], lon: number, lat: number): ObliqueShot[] {
  const best = new Map<string, { rank: number; shot: ObliqueShot }>();
  for (const feature of features) {
    const direction = feature.properties?.direction;
    if (!direction || !DIRECTIONS.includes(direction as (typeof DIRECTIONS)[number])) continue;
    const box = feature.bbox;
    const minLon = box?.[0];
    const minLat = box?.[1];
    const maxLon = box?.[2];
    const maxLat = box?.[3];
    if (minLon === undefined || minLat === undefined || maxLon === undefined || maxLat === undefined || !feature.id) {
      continue;
    }
    const inside = lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
    const cx = (minLon + maxLon) / 2;
    const cy = (minLat + maxLat) / 2;
    const rank = (inside ? 0 : 1) + (cx - lon) ** 2 + (cy - lat) ** 2;
    const current = best.get(direction);
    if (current && current.rank <= rank) continue;
    best.set(direction, {
      rank,
      shot: {
        direction,
        itemId: feature.id,
        collection: feature.collection ?? "",
        takenAt: feature.properties?.datetime,
      },
    });
  }
  return DIRECTIONS.flatMap((direction) => {
    const shot = best.get(direction)?.shot;
    return shot ? [shot] : [];
  });
}

async function fetchWithToken(url: string, token: string): Promise<Response> {
  return fetch(url, { headers: { "user-agent": "boligmcp", token } });
}

function cameraFrom(feature: StacFeature): ObliqueCamera | undefined {
  const rotation = feature.properties?.["pers:rotation_matrix"];
  const center = feature.properties?.["pers:perspective_center"];
  const interior = feature.properties?.["pers:interior_orientation"];
  const spacing = interior?.pixel_spacing?.[0];
  const columns = interior?.sensor_array_dimensions?.[0];
  const rows = interior?.sensor_array_dimensions?.[1];
  const cx = center?.[0];
  const cy = center?.[1];
  const cz = center?.[2];
  if (!rotation || rotation.length !== 9 || cx === undefined || cy === undefined || cz === undefined) return undefined;
  if (!interior?.focal_length || !spacing || !columns || !rows) return undefined;
  return {
    rotation,
    center: [cx, cy, cz],
    focalLengthMm: interior.focal_length,
    pixelSpacingMm: spacing,
    principalPointMm: [interior.principal_point_offset?.[0] ?? 0, interior.principal_point_offset?.[1] ?? 0],
    columns,
    rows,
  };
}

/** The oblique whose frame contains the point and places it nearest the middle. Nadir is the orthophoto's job. */
function chooseFacade(features: StacFeature[], x: number, y: number, z: number): {
  feature: StacFeature;
  camera: ObliqueCamera;
  href: string;
} | undefined {
  let best: { feature: StacFeature; camera: ObliqueCamera; href: string; rank: number } | undefined;
  for (const feature of features) {
    if (!feature.id || feature.properties?.direction === "nadir") continue;
    const href = feature.assets?.data?.href;
    const camera = cameraFrom(feature);
    if (!href || !camera) continue;
    const pixel = projectToPixel(camera, x, y, z);
    if (!pixel) continue;
    const rank = (pixel.column - camera.columns / 2) ** 2 + (pixel.row - camera.rows / 2) ** 2;
    if (best && best.rank <= rank) continue;
    best = { feature, camera, href, rank };
  }
  return best;
}

async function latestObliques(
  x: number,
  y: number,
  token: string,
): Promise<{ features: StacFeature[]; lon: number; lat: number }> {
  const { lon, lat } = etrs89ToWgs84(x, y);
  const collections = await fetchWithToken(`${STAC_URL}/collections?limit=100`, token);
  if (!collections.ok) return { features: [], lon, lat };
  const body = (await collections.json()) as { collections?: { id?: string }[] };
  const collection = latestSkaafotoCollection((body.collections ?? []).map((item) => item.id ?? ""));
  if (!collection) return { features: [], lon, lat };
  const pad = 0.002;
  const search = new URL(`${STAC_URL}/search`);
  search.searchParams.set("collections", collection);
  search.searchParams.set("bbox", `${lon - pad},${lat - pad},${lon + pad},${lat + pad}`);
  search.searchParams.set("limit", "100");
  const response = await fetchWithToken(search.toString(), token);
  if (!response.ok) return { features: [], lon, lat };
  const result = (await response.json()) as { features?: StacFeature[] };
  return { features: result.features ?? [], lon, lat };
}

function missingToken(detail?: string): SourceResult<never> {
  const how = setupHint("dataforsyningen");
  const base = detail ?? `No Dataforsyningen token is configured. ${how ?? ""}`;
  return unavailable(
    "dataforsyningen",
    "missing_credentials",
    `${base} Do not ask the user to paste the token into the chat.`.replace(/\s+/g, " ").trim(),
  );
}

export async function getAerialPhoto(
  x: number,
  y: number,
): Promise<SourceResult<{ photo: AerialPhoto; jpeg: string; facadeJpeg: string | null }>> {
  const token = getConfig().dataforsyningenToken;
  if (!token) return missingToken();
  const key = `aerial:2:${Math.round(x)}:${Math.round(y)}`;
  const hit = cacheGet<SourceResult<{ photo: AerialPhoto; jpeg: string; facadeJpeg: string | null }>>(key);
  if (hit?.status === "ok") return hit;
  try {
    const url = orthophotoUrl(x, y);
    const image = await fetchWithToken(url, token);
    if (image.status === 401 || image.status === 403) {
      return missingToken(`Dataforsyningen rejected the token (${image.status}).`);
    }
    if (!image.ok) {
      return unavailable("dataforsyningen", "upstream_error", `Orthophoto returned HTTP ${image.status}.`);
    }
    const bytes = new Uint8Array(await image.arrayBuffer());
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      return unavailable("dataforsyningen", "upstream_error", "Orthophoto response was not a JPEG.");
    }
    const { features, lon, lat } = await latestObliques(x, y, token).catch(() => {
      const wgs = etrs89ToWgs84(x, y);
      return { features: [] as StacFeature[], lon: wgs.lon, lat: wgs.lat };
    });
    const terrain = features.length ? await getTerrainAt(x, y).catch(() => undefined) : undefined;
    const groundZ = terrain?.status === "ok" ? terrain.data.terrainM : 25;
    const chosen = chooseFacade(features, x, y, groundZ);
    const facadeImage = chosen ? await readFacadeJpeg(chosen.href, chosen.camera, x, y, groundZ).catch(() => undefined) : undefined;
    const result = ok("dataforsyningen", {
      photo: {
        layer: "orto_foraar_12_5",
        widthM: HALF_METERS * 2,
        attribution: "Ortofoto: GeoDanmark. Skråfoto: Klimadatastyrelsen.",
        viewerUrl: VIEWER_URL,
        obliques: pickObliques(features, lon, lat),
        facade: facadeImage && chosen?.feature.id
          ? {
              direction: chosen.feature.properties?.direction ?? "",
              itemId: chosen.feature.id,
              takenAt: chosen.feature.properties?.datetime,
              widthPx: facadeImage.width,
              heightPx: facadeImage.height,
            }
          : null,
      },
      jpeg: Buffer.from(bytes).toString("base64"),
      facadeJpeg: facadeImage?.jpeg ?? null,
    });
    cacheSet(key, result, ttlFor("dataforsyningen"));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return unavailable("dataforsyningen", "upstream_error", message);
  }
}
