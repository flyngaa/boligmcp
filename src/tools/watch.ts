import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildFlags, flagInputFrom } from "../analysis/flags.js";
import { collectPropertyData, lastSale, type PropertyData } from "./property-report.js";

export const WATCH_MAX = 50;

/** What a check compares. Kept small and stable so changes are meaningful, not noise. */
export interface WatchSnapshot {
  takenAt: string;
  valuation?: { year?: number; propertyValue?: number | null; landValue?: number | null; system?: string };
  lastSale?: { date?: string; price?: number | null };
  plans: string[];
  proposals: string[];
  buildings: Array<{ id: string; usage?: string; builtArea?: number | null; lastRevised?: string }>;
  dwellingArea?: number | null;
  tenure?: string;
  flags: string[];
}

export interface WatchEntry {
  id: string;
  designation?: string;
  query: string;
  note?: string;
  addedAt: string;
  snapshot: WatchSnapshot;
}

function watchlistPath(): string {
  if (process.env.BOLIGMCP_WATCHLIST_FILE) return process.env.BOLIGMCP_WATCHLIST_FILE;
  const base = process.env.XDG_CONFIG_HOME ?? (process.platform === "win32" && process.env.APPDATA ? process.env.APPDATA : join(homedir(), ".config"));
  return join(base, "boligmcp", "watchlist.json");
}

export class WatchlistUnreadableError extends Error {}

/** A file that exists but cannot be read is an error, never an empty list: the next write would erase it. */
export function readWatchlist(): WatchEntry[] {
  const path = watchlistPath();
  if (!existsSync(path)) return [];
  let parsed: { entries?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown };
  } catch (error) {
    throw new WatchlistUnreadableError(
      `The watchlist at ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). It was left untouched; fix or remove the file.`,
    );
  }
  if (!Array.isArray(parsed.entries)) {
    throw new WatchlistUnreadableError(`The watchlist at ${path} has no "entries" list. It was left untouched; fix or remove the file.`);
  }
  return parsed.entries as WatchEntry[];
}

/** Writes via a temporary file, so a crash mid-write cannot leave half a watchlist. */
function writeWatchlist(entries: WatchEntry[]): void {
  const path = watchlistPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ entries }, null, 2)}\n`);
  renameSync(temp, path);
}

function unreadable(error: unknown): { error: string } {
  if (error instanceof WatchlistUnreadableError) return { error: error.message };
  throw error;
}

export function snapshotOf(data: PropertyData): WatchSnapshot {
  const bbr = data.buildings?.status === "ok" ? data.buildings.data : undefined;
  const valuation = data.valuation?.status === "ok" ? (data.valuation.data.latestNew ?? data.valuation.data.latest) : undefined;
  const sale = lastSale(data.trades?.status === "ok" ? data.trades.data : undefined);
  const plans = data.plans?.status === "ok" ? data.plans.data.items : [];
  const planKey = (item: { type: string; planId?: string; name?: string }) => `${item.type}:${item.planId ?? item.name ?? "?"}`;
  return {
    takenAt: new Date().toISOString(),
    valuation: valuation
      ? { year: valuation.year, propertyValue: valuation.propertyValue, landValue: valuation.landValue, system: valuation.system }
      : undefined,
    lastSale: sale ? { date: sale.date, price: sale.price } : undefined,
    plans: plans.filter((item) => !item.type.endsWith("proposal")).map(planKey).sort(),
    proposals: plans.filter((item) => item.type.endsWith("proposal")).map((item) => `${planKey(item)}|${item.name ?? ""}`).sort(),
    buildings: (bbr?.buildings ?? [])
      .map((b) => ({ id: b.buildingId ?? "?", usage: b.usage, builtArea: b.builtArea, lastRevised: b.lastRevised }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    dwellingArea: bbr?.units.length === 1 ? (bbr.units[0]?.dwellingArea ?? null) : null,
    tenure: bbr?.units.length === 1 ? bbr.units[0]?.tenure : undefined,
    flags: buildFlags(flagInputFrom(data))
      .filter((flag) => flag.severity !== "info")
      .map((flag) => `${flag.severity}: ${flag.title}`)
      .sort(),
  };
}

const kr = (value: number | null | undefined) => (value ? `${Math.round(value).toLocaleString("da-DK")} kr.` : "ukendt");

/** Human-readable (Danish) list of what changed between two snapshots. */
export function diffSnapshots(before: WatchSnapshot, after: WatchSnapshot): string[] {
  const changes: string[] = [];
  const b = before.valuation;
  const a = after.valuation;
  if (a && (!b || a.year !== b.year || a.propertyValue !== b.propertyValue || a.landValue !== b.landValue)) {
    changes.push(
      `Ny offentlig vurdering ${a.year}: ${kr(a.propertyValue)} (grund ${kr(a.landValue)})${b ? `, før ${b.year}: ${kr(b.propertyValue)}` : ""}`,
    );
  }
  if (after.lastSale?.date && after.lastSale.date !== before.lastSale?.date) {
    changes.push(`Ny handel ${after.lastSale.date}: ${kr(after.lastSale.price)}`);
  }
  const added = (x: string[], y: string[]) => y.filter((item) => !x.includes(item));
  for (const plan of added(before.plans, after.plans)) changes.push(`Ny plan dækker ejendommen: ${plan}`);
  for (const plan of added(after.plans, before.plans)) changes.push(`Plan dækker ikke længere ejendommen: ${plan}`);
  for (const proposal of added(before.proposals, after.proposals)) changes.push(`Nyt planforslag: ${proposal.split("|")[1] || proposal}`);
  const ids = (list: WatchSnapshot["buildings"]) => list.map((item) => item.id);
  for (const building of after.buildings.filter((item) => !ids(before.buildings).includes(item.id))) {
    changes.push(`Ny bygning i BBR: ${building.usage ?? building.id}${building.builtArea ? ` (${building.builtArea} m²)` : ""}`);
  }
  for (const building of before.buildings.filter((item) => !ids(after.buildings).includes(item.id))) {
    changes.push(`Bygning fjernet fra BBR: ${building.usage ?? building.id}`);
  }
  for (const building of after.buildings) {
    const old = before.buildings.find((item) => item.id === building.id);
    if (old && old.lastRevised !== building.lastRevised && building.lastRevised) {
      changes.push(`BBR-oplysninger ændret for ${building.usage ?? building.id} (${building.lastRevised})`);
    }
  }
  if ((before.dwellingArea ?? null) !== (after.dwellingArea ?? null)) {
    changes.push(`Boligareal ændret: ${before.dwellingArea ?? "ukendt"} → ${after.dwellingArea ?? "ukendt"} m²`);
  }
  if (before.tenure !== after.tenure && after.tenure) changes.push(`Benyttelse ændret: ${before.tenure ?? "ukendt"} → ${after.tenure}`);
  for (const flag of added(before.flags, after.flags)) changes.push(`Nyt signal: ${flag}`);
  for (const flag of added(after.flags, before.flags)) changes.push(`Signal forsvundet: ${flag}`);
  return changes;
}

async function collect(query: string) {
  return collectPropertyData({ query }, { stats: true, energy: true });
}

export async function watchProperty(query: string, note?: string) {
  let entries: WatchEntry[];
  try {
    entries = readWatchlist();
  } catch (error) {
    return unreadable(error);
  }
  const data = await collect(query);
  if (data.idsResult.status !== "ok") return { error: data.idsResult.detail ?? "Address not found" };
  const id = data.ids?.bfe ?? data.ids?.addressId ?? data.ids?.houseNumberId ?? query;
  const existing = entries.find((entry) => entry.id === id);
  if (existing) {
    // Watching again must not move the baseline, or changes since then would never be reported.
    const updated = { ...existing, note: note ?? existing.note };
    if (note !== undefined) writeWatchlist(entries.map((item) => (item.id === id ? updated : item)));
    return {
      watching: existing.designation ?? query,
      id,
      alreadyWatched: true,
      note: "Already on the watchlist; the baseline from the last check was kept. Call check_watchlist to see changes.",
      snapshot: existing.snapshot,
    };
  }
  if (entries.length >= WATCH_MAX) return { error: `The watchlist is full (${WATCH_MAX}). Remove one with unwatch_property.` };
  const entry: WatchEntry = {
    id,
    designation: data.ids?.designation,
    query,
    note,
    addedAt: new Date().toISOString(),
    snapshot: snapshotOf(data),
  };
  writeWatchlist([...entries, entry]);
  return {
    watching: entry.designation ?? query,
    id,
    alreadyWatched: false,
    ...(data.ids?.matchWarning ? { matchWarning: data.ids.matchWarning } : {}),
    snapshot: entry.snapshot,
  };
}

export function unwatchProperty(idOrQuery: string) {
  let entries: WatchEntry[];
  try {
    entries = readWatchlist();
  } catch (error) {
    return unreadable(error);
  }
  const needle = idOrQuery.trim().toLowerCase();
  const keep = entries.filter(
    (entry) => entry.id !== idOrQuery && entry.query.toLowerCase() !== needle && entry.designation?.toLowerCase() !== needle,
  );
  writeWatchlist(keep);
  return { removed: entries.length - keep.length, remaining: keep.length };
}

export function listWatchlist() {
  let entries: WatchEntry[];
  try {
    entries = readWatchlist();
  } catch (error) {
    return unreadable(error);
  }
  return entries.map((entry) => ({
    id: entry.id,
    designation: entry.designation,
    note: entry.note,
    addedAt: entry.addedAt,
    lastChecked: entry.snapshot.takenAt,
  }));
}

/** Re-fetches every watched property and reports what changed since the last check. */
export async function checkWatchlist(options: { update?: boolean } = {}) {
  const update = options.update ?? true;
  let entries: WatchEntry[];
  try {
    entries = readWatchlist();
  } catch (error) {
    return unreadable(error);
  }
  const results = [];
  const next: WatchEntry[] = [];
  for (const entry of entries) {
    try {
      const data = await collect(entry.query);
      const snapshot = snapshotOf(data);
      const changes = data.idsResult.status === "ok" ? diffSnapshots(entry.snapshot, snapshot) : [];
      results.push({ designation: entry.designation ?? entry.query, since: entry.snapshot.takenAt, changes });
      next.push(update && data.idsResult.status === "ok" ? { ...entry, snapshot } : entry);
    } catch (error) {
      results.push({ designation: entry.designation ?? entry.query, since: entry.snapshot.takenAt, error: error instanceof Error ? error.message : String(error) });
      next.push(entry);
    }
  }
  if (update) writeWatchlist(next);
  return {
    checked: results.length,
    changed: results.filter((item) => (item.changes?.length ?? 0) > 0).length,
    results,
    note: update ? "Snapshots were updated; the next check compares with now." : "Snapshots were kept.",
  };
}
