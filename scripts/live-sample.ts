/**
 * Random-address sweep (docs/test-plan.md): property_report for addresses drawn from DAR across the country, checked
 * against rules that must hold for any property. The fixtures in tests/live/cases cover known cases; this finds unknown ones.
 *
 *   pnpm live:sample [count=100] [seed=1] [concurrency=4]
 *
 * Draws a random postal town, one of its postcodes, one of its house numbers and, a third of the time, one of the flats there, then reports on
 * the exact registered address text. Every report and every broken rule is written to tests/live/.last-sample.json.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { queryAllNodes, queryNodes } from "../src/sources/datafordeler/client.js";
import { buildPropertyReport } from "../src/tools/property-report.js";

const ROOT = join(import.meta.dirname, "..");
const count = Number(process.argv[2] ?? 100);
let seed = Number(process.argv[3] ?? 1);
const concurrency = Math.max(1, Number(process.argv[4] ?? 4));

/** Small seeded generator (mulberry32), so a failing sample can be drawn again. */
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(items: T[]): T | undefined => items[Math.floor(random() * items.length)];

const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

async function drawAddresses(): Promise<string[]> {
  const rows = (await queryAllNodes("DAR", "DAR_Postnummer", "id_lokalId postnr navn")).filter(
    // 0800–0999 and a few others are business-only postcodes with few or no addresses.
    (row) => Number(row.postnr) >= 1000,
  );
  // A town first, then one of its postcodes: København K alone has some 200 postcodes and would fill the sample.
  const towns = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) towns.set(String(row.navn), [...(towns.get(String(row.navn)) ?? []), row]);
  const townList = [...towns.values()];
  const picked: string[] = [];
  let tries = 0;
  while (picked.length < count && tries < count * 3) {
    tries += 1;
    const postcode = pick(pick(townList) ?? []);
    if (!postcode) break;
    const houses = (
      await queryNodes("DAR", "DAR_Husnummer", "id_lokalId adgangsadressebetegnelse status", { postnummer: { eq: postcode.id_lokalId } }, 50)
    ).filter((row) => row.status === "3");
    const house = pick(houses);
    if (!house) continue;
    let designation = str(house.adgangsadressebetegnelse);
    if (random() < 1 / 3) {
      const flats = (
        await queryNodes("DAR", "DAR_Adresse", "adressebetegnelse etagebetegnelse status", { husnummer: { eq: house.id_lokalId } }, 30)
      ).filter((row) => row.status === "3" && row.etagebetegnelse);
      designation = str(pick(flats)?.adressebetegnelse) ?? designation;
    }
    if (designation && !picked.includes(designation)) picked.push(designation);
  }
  return picked;
}

type Report = {
  summary: Record<string, unknown>;
  flags: Array<{ id: string; severity: string; detail?: string }>;
  parcel?: { status: string; data?: Array<{ registeredArea?: number | null }> | { items: unknown[] } };
  trades?: { status: string; data?: Array<{ date?: string; price?: number | null }> };
  environment?: { status: string; data?: { items: Array<{ onProperty?: boolean }> } };
  missing: Array<{ source: string; reason: string; detail?: string }>;
  note?: string;
};

const YEAR = new Date().getFullYear();

/** Rules every report must keep. Each broken rule is a finding to triage, not automatically a bug. */
function check(query: string, report: Report, ms: number): string[] {
  const broken: string[] = [];
  const s = report.summary;
  const n = (key: string) => (typeof s[key] === "number" ? (s[key] as number) : undefined);
  const text = JSON.stringify(report);
  if (!s.designation) return [`not resolved: ${report.missing[0]?.detail ?? "?"}`];
  if (s.matchWarning) broken.push(`matchWarning for the register's own text: ${s.matchWarning}`);
  if (!s.bfe && !report.missing.some((m) => m.source === "matrikel")) broken.push("no BFE and no reason under missing");
  // Over 8 parcels the report lists a sample ({ items, total }), so the sum can only be checked on a full list.
  const parcelData = report.parcel?.status === "ok" ? report.parcel.data : undefined;
  const parcels = Array.isArray(parcelData) ? parcelData : [];
  const parcelSum = parcels.reduce((sum, p) => sum + (p.registeredArea ?? 0), 0);
  if (!report.note && parcels.length && n("plotArea") !== parcelSum) {
    broken.push(`plotArea ${n("plotArea")} ≠ sum of parcels ${parcelSum}`);
  }
  const dwelling = n("dwellingArea");
  // 0 is the register's own figure for a unit with no dwelling area (an office, a shop).
  if (dwelling !== undefined && (dwelling < 0 || dwelling > 300_000)) broken.push(`dwellingArea ${dwelling}`);
  const year = n("constructionYear");
  if (year !== undefined && (year < 1000 || year > YEAR + 1)) broken.push(`constructionYear ${year}`);
  const terrain = n("terrainM");
  if (terrain !== undefined && (terrain < -10 || terrain > 200)) broken.push(`terrainM ${terrain}`);
  const valuationYear = n("valuationYear");
  if (valuationYear !== undefined && (valuationYear < 1990 || valuationYear > YEAR)) broken.push(`valuationYear ${valuationYear}`);
  const saleDate = s.lastTradeDate as string | undefined;
  // A sale can be registered before its takeover date, so a few months ahead is real.
  if (saleDate && (saleDate < "1971" || saleDate > `${YEAR + 1}-12-31`)) broken.push(`lastTradeDate ${saleDate}`);
  if (/1969-12-31|1970-01-01/.test(text)) broken.push("placeholder date 1969/1970 in output");
  // Per-m² figures in flags: a sale or a valuation per m² of dwelling outside anything Danish property costs.
  for (const flag of report.flags) {
    const perM2 = flag.detail?.match(/\(([\d.]+) kr\. pr\. m² bolig\)/)?.[1];
    if (perM2) {
      const value = Number(perM2.replace(/\./g, ""));
      // Old sales can be cheap; a price per m² above 250.000 kr. is not a real Danish home.
      if (value > 250_000 || value < 50) broken.push(`${flag.id}: ${value} kr. pr. m²`);
    }
  }
  const valuation = n("valuation");
  if (valuation && dwelling && !s.mainBfe && s.tenure === "Benyttet af ejeren" && valuation / dwelling > 250_000) {
    broken.push(`valuation ${valuation} over ${dwelling} m² = ${Math.round(valuation / dwelling)} kr./m²`);
  }
  // A high soil flag needs a locality on the property.
  if (report.flags.some((f) => f.id === "soil_contamination")) {
    const items = report.environment?.status === "ok" ? report.environment.data?.items ?? [] : [];
    if (!items.some((item) => item.onProperty)) broken.push("soil_contamination flag without a locality on the property");
  }
  for (const m of report.missing) {
    if (m.reason === "upstream_error") broken.push(`upstream_error ${m.source}: ${m.detail?.slice(0, 120)}`);
  }
  const tokens = Math.ceil(text.length / 4);
  if (tokens > 10_000) broken.push(`${tokens} tokens`);
  if (ms > 30_000) broken.push(`${ms} ms`);
  return broken;
}

async function mapLimited<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await run(items[index]!);
      }
    }),
  );
  return out;
}

async function main(): Promise<void> {
  const started = Date.now();
  const addresses = await drawAddresses();
  console.log(`Drew ${addresses.length} addresses (seed ${process.argv[3] ?? 1}), ${concurrency} at a time.`);
  const results = await mapLimited(addresses, concurrency, async (query) => {
    const t = Date.now();
    try {
      const report = (await buildPropertyReport({ query })) as Report;
      const ms = Date.now() - t;
      return { query, ms, broken: check(query, report, ms), summary: report.summary, report };
    } catch (error) {
      return { query, ms: Date.now() - t, broken: [`threw: ${error instanceof Error ? error.stack : String(error)}`] };
    }
  });
  writeFileSync(join(ROOT, "tests", "live", ".last-sample.json"), JSON.stringify(results, null, 1));
  const failing = results.filter((result) => result.broken.length);
  for (const result of failing) {
    console.log(`\n✗ ${result.query} (${result.ms} ms)`);
    for (const rule of result.broken) console.log(`    ${rule}`);
  }
  console.log(
    `\nLIVE SAMPLE addresses=${results.length} clean=${results.length - failing.length} flagged=${failing.length} time=${Math.round((Date.now() - started) / 1000)}s`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(2);
});
