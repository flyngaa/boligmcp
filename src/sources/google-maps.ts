import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setupHint } from "../catalog.js";
import { getConfig } from "../config.js";
import { etrs89ToWgs84 } from "../lib/geo.js";
import { getTerrainAt } from "./datafordeler/dhm.js";
import { outlineContaining } from "./datafordeler/geodanmark.js";
import { ok, unavailable, type SourceResult } from "../types.js";

/** Local port the 3D page is served on. A website-restricted key must allow this origin. */
export const MAP_PORT = 47321;

export interface MapView {
  url: string;
  label: string;
  lat: number;
  lon: number;
  /** Shown to the model. The page itself holds the API key and must not be read back. */
  open: string;
}

const OPEN =
  "Photorealistic 3D view of the building, with a white outline. For an HTML report, use this URL as an iframe src. Give the user the URL when they want this view instead of the government aerial. Do not fetch, read or quote the page: it contains the API key.";

/** WGS84 exterior ring, extruded up from the ground by heightM. */
export interface BuildingOutline {
  path: Array<{ lat: number; lon: number }>;
  heightM: number;
}

const pages = new Map<string, string>();
let server: Server | undefined;
let boundPort: number | undefined;
let starting: Promise<number> | undefined;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Photorealistic 3D page. The key is in the script URL because the Maps JavaScript API runs in the browser. */
export function mapPage(input: { label: string; lat: number; lon: number; apiKey: string; outline?: BuildingOutline }): string {
  const label = escapeHtml(input.label);
  const lat = input.lat.toFixed(6);
  const lon = input.lon.toFixed(6);
  const key = encodeURIComponent(input.apiKey);
  const camera = JSON.stringify({ lat: input.lat, lon: input.lon, outline: input.outline ?? null });
  return `<!DOCTYPE html>
<html lang="da">
<head>
  <meta charset="utf-8">
  <title>${label}</title>
  <style>
    html, body { height: 100%; margin: 0; background: #111; color: #f4f4f4; font-family: ui-sans-serif, system-ui, sans-serif; }
    gmp-map-3d { display: block; height: 100%; width: 100%; }
    .bar { position: fixed; z-index: 2; top: 16px; left: 16px; max-width: 380px; padding: 12px 14px; background: #161616; }
    h1 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
    p { margin: 0; font-size: 12px; line-height: 1.4; color: #bdbdbd; }
    .err { display: none; position: fixed; inset: 0; z-index: 3; place-items: center; padding: 24px; background: #111; }
    .err.show { display: grid; }
    .err p { max-width: 420px; font-size: 14px; color: #f4f4f4; }
  </style>
  <script async src="https://maps.googleapis.com/maps/api/js?key=${key}&v=beta&libraries=maps3d&language=da&region=DK" onerror="document.getElementById('err').classList.add('show')"></script>
</head>
<body>
  <gmp-map-3d id="map" mode="hybrid" center="${lat},${lon}" range="4500" tilt="28" heading="210" description="${label}"></gmp-map-3d>
  <div class="bar">
    <h1>${label}</h1>
    <p>Træk for at se dig omkring. Rul for at komme tættere på. Skift-træk vipper, ctrl-træk drejer.</p>
  </div>
  <div class="err" id="err">
    <p>Kortet kunne ikke indlæses. Slå Maps JavaScript API til på nøglen, og tillad http://127.0.0.1:${MAP_PORT}/* hvis den er begrænset til websites.</p>
  </div>
  <script type="module">
    const camera = ${camera};
    const map = document.querySelector("gmp-map-3d");
    const fail = () => document.getElementById("err").classList.add("show");
    let started = false;
    let orbited = false;
    const focus = { lat: camera.lat, lng: camera.lon, altitude: camera.outline ? camera.outline.heightM / 2 : 28 };
    const orbit = () => {
      if (orbited) return;
      orbited = true;
      map.flyCameraAround({
        camera: { center: focus, range: 180, tilt: 67, heading: typeof map.heading === "number" ? map.heading : 40 },
        durationMillis: 50000,
        repeatCount: Infinity,
      });
    };
    const approach = () => {
      if (started) return;
      started = true;
      map.flyCameraTo({
        endCamera: { center: focus, range: 160, tilt: 72, heading: 40 },
        durationMillis: 7000,
      });
      setTimeout(orbit, 7600);
    };
    customElements.whenDefined("gmp-map-3d").then(async () => {
      if (camera.outline) {
        const { Polygon3DElement } = await google.maps.importLibrary("maps3d");
        const polygon = new Polygon3DElement({
          strokeColor: "#ffffff",
          strokeWidth: 8,
          fillColor: "#ffffff55",
          extruded: true,
          altitudeMode: "RELATIVE_TO_GROUND",
          drawsOccludedSegments: true,
        });
        polygon.path = camera.outline.path.map((point) => ({ lat: point.lat, lng: point.lon, altitude: camera.outline.heightM }));
        map.append(polygon);
      }
      setTimeout(approach, 800);
    }).catch(fail);
    map.addEventListener("gmp-error", fail);
    map.addEventListener("gmp-animationend", (event) => {
      if (event.detail?.type === "flyCameraTo") orbit();
    });
    map.addEventListener("gmp-steadychange", (event) => {
      if (event.isSteady) approach();
    });
  </script>
</body>
</html>
`;
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const token = /^\/map\/([a-f0-9]{32})$/.exec(path)?.[1];
  const page = token ? pages.get(token) : undefined;
  if (!page) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Unknown map");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(page);
}

function listen(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const next = createServer(handle);
    next.once("error", reject);
    next.listen(port, "127.0.0.1", () => {
      server = next;
      boundPort = port;
      resolve(port);
    });
  });
}

async function ensureServer(): Promise<number> {
  if (boundPort) return boundPort;
  starting ??= listen(MAP_PORT).finally(() => {
    starting = undefined;
  });
  return starting;
}

/** Stops the local map server. Tests use this; the MCP process keeps it for the session. */
export function closeMapServer(): Promise<void> {
  pages.clear();
  const current = server;
  server = undefined;
  boundPort = undefined;
  starting = undefined;
  if (!current) return Promise.resolve();
  return new Promise((resolve) => current.close(() => resolve()));
}

async function publish(html: string): Promise<string> {
  const port = await ensureServer();
  const token = randomBytes(16).toString("hex");
  pages.set(token, html);
  return `http://127.0.0.1:${port}/map/${token}`;
}

/** BBR building whose coordinate is closest to the lookup point. Its id prefers that outline when several contain the point. */
export function nearestBuildingId(
  point: { x: number; y: number },
  buildings: Array<{ buildingId?: string; coordinate?: { epsg25832: { x: number; y: number } } }>,
): string | undefined {
  return buildings
    .filter((item) => item.buildingId && item.coordinate)
    .sort((a, b) => {
      const da = (a.coordinate!.epsg25832.x - point.x) ** 2 + (a.coordinate!.epsg25832.y - point.y) ** 2;
      const db = (b.coordinate!.epsg25832.x - point.x) ** 2 + (b.coordinate!.epsg25832.y - point.y) ** 2;
      return da - db;
    })[0]?.buildingId;
}

/** Extrusion height. A missing or implausible DHM height falls back to a low building. */
export function extrusionHeight(measured: number | undefined): number {
  return measured !== undefined && measured >= 4 && measured <= 120 ? measured : 18;
}

/** GeoDanmark footprint at the point, in WGS84, extruded from the ground. */
export async function buildingOutlineAt(x: number, y: number, buildingId?: string): Promise<BuildingOutline | undefined> {
  const ring = await outlineContaining(x, y, buildingId).catch(() => undefined);
  if (!ring) return undefined;
  const terrain = await getTerrainAt(x, y).catch(() => undefined);
  const measured = terrain?.status === "ok" ? terrain.data.heightAboveTerrainM : undefined;
  return {
    heightM: extrusionHeight(measured),
    path: ring.map(([east, north]) => {
      const wgs = etrs89ToWgs84(east, north);
      return { lat: wgs.lat, lon: wgs.lon };
    }),
  };
}

/** Local photorealistic 3D view for a property coordinate. The result URL does not contain the API key. */
export async function viewForPoint(
  label: string,
  x: number,
  y: number,
  buildingId?: string,
): Promise<SourceResult<MapView>> {
  const { lat, lon } = etrs89ToWgs84(x, y);
  return getMapView(label, lat, lon, await buildingOutlineAt(x, y, buildingId));
}

/** Local photorealistic 3D view. The result URL does not contain the API key. */
export async function getMapView(label: string, lat: number, lon: number, outline?: BuildingOutline): Promise<SourceResult<MapView>> {
  const apiKey = getConfig().googleMapsApiKey;
  if (!apiKey) {
    return unavailable(
      "google_maps",
      "missing_credentials",
      `A Google Maps API key is not set. ${setupHint("google_maps") ?? ""}`.trim(),
    );
  }
  try {
    const url = await publish(mapPage({ label, lat, lon, apiKey, outline }));
    return ok("google_maps", {
      url,
      label,
      lat,
      lon,
      open: OPEN,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailable("google_maps", "upstream_error", `Could not open a local map page (${message}).`);
  }
}
