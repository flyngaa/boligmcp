import proj4 from "proj4";
import type { Coordinate } from "../types.js";

const ETRS89 =
  "+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs";
const WGS84 = "EPSG:4326";

proj4.defs("EPSG:25832", ETRS89);

export function etrs89ToWgs84(x: number, y: number): { lat: number; lon: number } {
  const [lon, lat] = proj4("EPSG:25832", WGS84, [x, y]);
  return { lat, lon };
}

export function wgs84ToEtrs89(lat: number, lon: number): { x: number; y: number } {
  const [x, y] = proj4(WGS84, "EPSG:25832", [lon, lat]);
  return { x, y };
}

export function coordinateFromEtrs89(x: number, y: number): Coordinate {
  return {
    epsg25832: { x, y },
    wgs84: etrs89ToWgs84(x, y),
  };
}

export function pointWkt(x: number, y: number): string {
  return `POINT(${x} ${y})`;
}

export function bboxAround(x: number, y: number, meters = 5): [number, number, number, number] {
  return [x - meters, y - meters, x + meters, y + meters];
}

export function parsePostnr(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value).padStart(4, "0");
}
