import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getConfig } from "../config.js";

interface CacheRow {
  key: string;
  value: string;
  expires_at: number;
}

let db: Database.Database | undefined;

function getDb(): Database.Database {
  if (db) return db;
  const path = getConfig().cachePath;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function cacheGet<T>(key: string): T | undefined {
  const row = getDb()
    .prepare("SELECT key, value, expires_at FROM cache WHERE key = ?")
    .get(key) as CacheRow | undefined;
  if (!row) return undefined;
  if (row.expires_at <= Date.now()) {
    getDb().prepare("DELETE FROM cache WHERE key = ?").run(key);
    return undefined;
  }
  return JSON.parse(row.value) as T;
}

export function cacheSet(key: string, value: unknown, ttlSeconds: number): void {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  getDb()
    .prepare(
      "INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
    )
    .run(key, JSON.stringify(value), expiresAt);
}

/** Loads in progress. Parallel reports ask for the same statistics and registers; one request serves them all. */
const pending = new Map<string, Promise<unknown>>();

export async function cached<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight as Promise<T>;
  const load = (async () => {
    const value = await loader();
    cacheSet(key, value, ttlSeconds);
    return value;
  })().finally(() => pending.delete(key));
  pending.set(key, load);
  return load;
}

/** Runs at most `max` tasks at a time; the rest wait their turn. */
export function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active -= 1;
    queue.shift()?.();
  };
  return async <T>(task: () => Promise<T>) => {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      next();
    }
  };
}

export function resetCacheForTests(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}
