import { getConfig } from "../../config.js";
import { isCurrentBbrRow } from "../../lib/bbr-codes.js";
import { ok, unavailable, type NearbyService, type NearbyServices, type SourceResult } from "../../types.js";
import { datafordelerUnavailable, queryNodes } from "./client.js";

/**
 * BBR building usage codes per service category (official list "BygAnvendelse").
 * Stations are left out: many are underground or not registered as buildings, so BBR misleads.
 */
const CATEGORIES: Array<{ category: NearbyService["category"]; label: string; codes: string[] }> = [
  { category: "school", label: "Grundskole", codes: ["421", "420"] },
  { category: "daycare", label: "Daginstitution", codes: ["441", "440"] },
  { category: "retail", label: "Detailhandel eller butikscenter", codes: ["322", "324"] },
  { category: "health", label: "Lægehus eller sundhedscenter", codes: ["433"] },
  { category: "sports", label: "Idrætshal eller svømmehal", codes: ["533", "532"] },
];

const RADIUS_M = 2000;
const PAGE = 300;

function point(value: unknown): { x: number; y: number } | undefined {
  const wkt = typeof value === "object" && value ? (value as { wkt?: unknown }).wkt : value;
  const match = typeof wkt === "string" ? wkt.match(/POINT\s*\(\s*([0-9.]+)\s+([0-9.]+)\s*\)/i) : null;
  return match ? { x: Number(match[1]), y: Number(match[2]) } : undefined;
}

export function summarizeNearby(x: number, y: number, rows: Array<Record<string, unknown>>, truncated: boolean): NearbyServices {
  const items = CATEGORIES.map(({ category, label, codes }) => {
    const distances = rows
      .filter((row) => codes.includes(String(row.byg021BygningensAnvendelse)) && isCurrentBbrRow(row))
      .map((row) => point(row.byg404Koordinat))
      .filter((p): p is { x: number; y: number } => Boolean(p))
      .map((p) => Math.hypot(p.x - x, p.y - y))
      .filter((distance) => distance <= RADIUS_M)
      .sort((a, b) => a - b);
    return {
      category,
      label,
      nearestM: distances.length ? Math.round(distances[0]! / 10) * 10 : null,
      within1km: distances.filter((distance) => distance <= 1000).length,
    };
  });
  return { radiusM: RADIUS_M, items, truncated };
}

/** Nearest schools, daycare, shops, health, transit and sports buildings from BBR, as the crow flies. */
export async function getNearbyServices(x: number, y: number): Promise<SourceResult<NearbyServices>> {
  if (!getConfig().datafordelerApiKey) return datafordelerUnavailable("bbr");
  try {
    const r = RADIUS_M;
    const square = `POLYGON((${x - r} ${y - r},${x + r} ${y - r},${x + r} ${y + r},${x - r} ${y + r},${x - r} ${y - r}))`;
    // One query per category, so dense city areas cannot crowd out a whole category.
    const pages = await Promise.all(
      CATEGORIES.map((item) =>
        queryNodes(
          "BBR",
          "BBR_Bygning",
          "id_lokalId status byg021BygningensAnvendelse byg404Koordinat { wkt }",
          {
            byg404Koordinat: { intersects: { crs: 25832, wkt: square } },
            byg021BygningensAnvendelse: { in: item.codes },
          },
          PAGE,
        ),
      ),
    );
    return ok("bbr", summarizeNearby(x, y, pages.flat(), pages.some((page) => page.length >= PAGE)));
  } catch (error) {
    return unavailable("bbr", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}
