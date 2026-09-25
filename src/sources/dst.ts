import { ttlFor } from "../catalog.js";
import { cached, limiter } from "../lib/cache.js";
import { fetchJson as rawFetchJson, type FetchJsonOptions } from "../lib/http.js";

/** Statistikbanken slows down sharply under parallel load; a few requests at a time finish sooner. */
const statbankSlot = limiter(4);
const fetchJson = <T>(url: string, options?: FetchJsonOptions) => statbankSlot(() => rawFetchJson<T>(url, options));
import { ok, unavailable, type AreaStat, type AreaStats, type SourceResult } from "../types.js";

const BASE = "https://api.statbank.dk/v1/data";

// Statbank normally answers in well under a second; a slow reply means it is struggling, so give up early.
const HTTP = { timeoutMs: 8_000, retries: 1 };

interface DstTableResponse {
  dataset?: {
    dimension?: Record<
      string,
      { category?: { label?: Record<string, string>; index?: Record<string, number> } }
    >;
    value?: Array<number | null>;
    label?: string;
  };
  value?: Array<number | null>;
}

/** DAGI and DAR use four digits ("0791"); Statistikbanken wants three ("791"). */
export function dstMunicipalityCode(code: string): string {
  const n = Number(code);
  return Number.isFinite(n) ? String(n).padStart(3, "0") : code;
}

async function table(
  name: string,
  municipalityCode: string,
  extra: Record<string, string> = {},
): Promise<DstTableResponse> {
  const params = new URLSearchParams({ OMRÅDE: municipalityCode, lang: "da", ...extra });
  const url = `${BASE}/${name}/JSONSTAT?${params.toString()}`;
  return cached(`dst:${name}:${municipalityCode}:${JSON.stringify(extra)}`, ttlFor("dst"), () =>
    fetchJson<DstTableResponse>(url, HTTP),
  );
}

function values(response: DstTableResponse): Array<number | null> {
  return response.dataset?.value ?? response.value ?? [];
}

function firstValue(response: DstTableResponse): number | null {
  const found = values(response).find((value) => value !== null && value !== undefined);
  return found ?? null;
}

/** Periods in dimension order, e.g. ["2021K3", "2026K3"]. */
function periods(response: DstTableResponse): string[] {
  const index = response.dataset?.dimension?.Tid?.category?.index;
  if (!index) return [];
  return Object.entries(index)
    .sort((a, b) => a[1] - b[1])
    .map(([period]) => period);
}

function kommuneLabel(response: DstTableResponse, code: string): string | undefined {
  return response.dataset?.dimension?.OMRÅDE?.category?.label?.[code];
}

/** Picks the same quarter five years before the latest one, e.g. 2026K2 → 2021K2. */
function fiveYearsBefore(period: string): string | undefined {
  const match = period.match(/^(\d{4})(K\d|M\d{2})?$/);
  if (!match) return undefined;
  return `${Number(match[1]) - 5}${match[2] ?? ""}`;
}

export async function getAreaStatsForMunicipality(
  municipalityCode: string,
): Promise<SourceResult<AreaStats>> {
  const code = dstMunicipalityCode(municipalityCode);
  try {
    const stats: AreaStat[] = [];
    let municipalityName: string | undefined;

    const [folk, income, owners, renters, empty, unemployment, migration] = await Promise.allSettled([
      table("FOLK1A", code),
      table("INDKP101", code, { INDKOMSTTYPE: "100", KOEN: "MOK", ENHED: "116" }),
      table("BOL101", code, { BEBO: "1000", UDLFORH: "EJ" }),
      table("BOL101", code, { BEBO: "1000", UDLFORH: "LEJ" }),
      table("BOL101", code, { BEBO: "2000" }),
      table("AULP01", code),
      table("BEV107", code, { BEVÆGELSE: "B07", KØN: "M,K" }),
    ]);

    if (folk.status === "fulfilled") {
      municipalityName = kommuneLabel(folk.value, code);
      const latest = firstValue(folk.value);
      const period = periods(folk.value)[0];
      stats.push({ key: "population", label: `Befolkning (${period ?? "seneste"})`, value: latest, table: "FOLK1A" });
      const earlier = period ? fiveYearsBefore(period) : undefined;
      if (latest !== null && earlier) {
        try {
          const old = firstValue(await table("FOLK1A", code, { Tid: earlier }));
          if (old) {
            stats.push({
              key: "population_change_5y",
              label: `Befolkningsudvikling ${earlier}–${period}`,
              value: Math.round(((latest - old) / old) * 1000) / 10,
              unit: "%",
              table: "FOLK1A",
            });
          }
        } catch {
          // The comparison is a bonus; the latest figure stands on its own.
        }
      }
    }
    if (income.status === "fulfilled") {
      const period = periods(income.value)[0];
      stats.push({
        key: "avg_disposable_income",
        label: `Gns. disponibel indkomst pr. person (${period ?? "seneste"})`,
        value: firstValue(income.value),
        unit: "kr.",
        table: "INDKP101",
      });
    }
    if (owners.status === "fulfilled" && renters.status === "fulfilled") {
      const own = firstValue(owners.value) ?? 0;
      const rent = firstValue(renters.value) ?? 0;
      if (own + rent > 0) {
        stats.push({
          key: "rented_share",
          label: `Andel beboede boliger beboet af lejer (${periods(owners.value)[0] ?? "seneste"})`,
          value: Math.round((rent / (own + rent)) * 1000) / 10,
          unit: "%",
          table: "BOL101",
        });
      }
      if (empty.status === "fulfilled") {
        const vacant = firstValue(empty.value) ?? 0;
        stats.push({
          key: "vacant_share",
          label: "Andel boliger uden CPR-tilmeldte (ubeboede)",
          value: own + rent + vacant > 0 ? Math.round((vacant / (own + rent + vacant)) * 1000) / 10 : null,
          unit: "%",
          table: "BOL101",
        });
      }
    }
    if (unemployment.status === "fulfilled") {
      stats.push({
        key: "unemployment_rate",
        label: `Fuldtidsledige i pct. af arbejdsstyrken (${periods(unemployment.value)[0] ?? "seneste"})`,
        value: firstValue(unemployment.value),
        unit: "%",
        table: "AULP01",
      });
    }
    if (migration.status === "fulfilled") {
      const net = values(migration.value).reduce<number>((sum, value) => sum + (value ?? 0), 0);
      stats.push({
        key: "net_migration",
        label: `Nettotilflyttede (${periods(migration.value)[0] ?? "seneste"})`,
        value: net,
        table: "BEV107",
      });
    }

    if (stats.length === 0) {
      const reasons = [folk, income, owners, unemployment]
        .filter((item): item is PromiseRejectedResult => item.status === "rejected")
        .map((item) => String(item.reason).slice(0, 160));
      return unavailable("dst", "upstream_error", `No Statbank tables returned data. ${reasons.join(" | ")}`);
    }
    return ok("dst", { level: "municipality", areaCode: code, areaName: municipalityName, municipalityCode: code, municipalityName, stats });
  } catch (error) {
    return unavailable("dst", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

interface JsonStat {
  dataset?: {
    dimension?: Record<string, unknown> & {
      id?: string[];
      size?: number[];
    };
    value?: Array<number | null>;
  };
}

/** Reads one cell from a JSON-stat dataset by category keys, e.g. { TAL: "100", Tid: "2026K1" }. */
export function jsonStatCell(response: JsonStat, where: Record<string, string>): number | null {
  const ds = response.dataset;
  const ids = ds?.dimension?.id;
  const sizes = ds?.dimension?.size;
  if (!ds || !ids || !sizes) return null;
  let index = 0;
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i]!;
    const category = (ds.dimension?.[id] as { category?: { index?: Record<string, number> } } | undefined)?.category;
    const keys = category?.index ?? {};
    const wanted = where[id];
    const position = wanted !== undefined ? keys[wanted] : Object.keys(keys).length === 1 ? 0 : undefined;
    if (position === undefined) return null;
    index = index * sizes[i]! + position;
  }
  return ds.value?.[index] ?? null;
}

function categoryKeys(response: JsonStat, dimension: string): string[] {
  const category = (response.dataset?.dimension?.[dimension] as { category?: { index?: Record<string, number> } } | undefined)
    ?.category;
  return Object.entries(category?.index ?? {})
    .sort((a, b) => a[1] - b[1])
    .map(([key]) => key);
}

async function statbank(table: string, params: Record<string, string>): Promise<JsonStat> {
  const query = new URLSearchParams({ lang: "da", ...params });
  return cached(`dst:${table}:${query.toString()}`, ttlFor("dst"), () =>
    fetchJson<JsonStat>(`${BASE}/${table}/JSONSTAT?${query.toString()}`, HTTP),
  );
}

const pct = (now: number | null, then: number | null) =>
  now !== null && then ? Math.round(((now - then) / then) * 1000) / 10 : null;

/** Population, age, migration, employment and education for one parish (sogn). */
export async function getParishStats(parishCode: string, parishName?: string): Promise<SourceResult<AreaStats>> {
  const code = String(Number(parishCode));
  try {
    const stats: AreaStat[] = [];
    const [population, age, migration, socio, education] = await Promise.allSettled([
      statbank("SOGN1", { SOGN: code }),
      statbank("KMGALDER", { SOGN: code, KØN: "TOT" }),
      statbank("KMSTA003", { SOGN: code, KIRKEBEV: "B05,B06,B07" }),
      statbank("KMSTA005", { SOGN: code, SOCIO: "*" }),
      statbank("KMST007A", { SOGN: code, UDDANNELSEF: "*" }),
    ]);

    if (population.status === "fulfilled") {
      const latest = categoryKeys(population.value, "Tid")[0];
      const value = jsonStatCell(population.value, {});
      stats.push({ key: "parish_population", label: `Indbyggere i sognet (${latest})`, value, table: "SOGN1" });
      if (latest && value !== null) {
        try {
          const earlier = String(Number(latest) - 5);
          const old = jsonStatCell(await statbank("SOGN1", { SOGN: code, Tid: earlier }), {});
          stats.push({ key: "parish_population_change_5y", label: `Befolkningsudvikling ${earlier}–${latest}`, value: pct(value, old), unit: "%", table: "SOGN1" });
        } catch {
          // The latest figure stands on its own.
        }
      }
    }
    if (age.status === "fulfilled") {
      stats.push({ key: "parish_average_age", label: `Gennemsnitsalder (${categoryKeys(age.value, "Tid")[0]})`, value: jsonStatCell(age.value, {}), unit: "år", table: "KMGALDER" });
    }
    if (migration.status === "fulfilled") {
      const year = categoryKeys(migration.value, "Tid")[0];
      stats.push({ key: "parish_net_migration", label: `Nettotilflyttede (${year})`, value: jsonStatCell(migration.value, { KIRKEBEV: "B07" }), table: "KMSTA003" });
    }
    if (socio.status === "fulfilled") {
      const employed = jsonStatCell(socio.value, { SOCIO: "001" }) ?? 0;
      const total = ["001", "002", "003", "004"].reduce((sum, key) => sum + (jsonStatCell(socio.value, { SOCIO: key }) ?? 0), 0);
      stats.push({
        key: "parish_employment_share",
        label: `Andel beskæftigede af befolkningen over 15 år (${categoryKeys(socio.value, "Tid")[0]})`,
        value: total ? Math.round((employed / total) * 1000) / 10 : null,
        unit: "%",
        table: "KMSTA005",
      });
    }
    if (education.status === "fulfilled") {
      const levels = categoryKeys(education.value, "UDDANNELSEF");
      const known = levels.filter((key) => key !== "H90");
      const higher = known.filter((key) => ["H40", "H50", "H60", "H70", "H80"].includes(key));
      const sum = (keys: string[]) => keys.reduce((total, key) => total + (jsonStatCell(education.value, { UDDANNELSEF: key }) ?? 0), 0);
      const all = sum(known);
      stats.push({
        key: "parish_higher_education_share",
        label: `Andel med videregående uddannelse (${categoryKeys(education.value, "Tid")[0]})`,
        value: all ? Math.round((sum(higher) / all) * 1000) / 10 : null,
        unit: "%",
        table: "KMST007A",
      });
    }
    if (stats.length === 0) return unavailable("dst", "upstream_error", `No parish statistics for sogn ${code}`);
    return ok("dst", { level: "parish", areaCode: code, areaName: parishName, stats });
  } catch (error) {
    return unavailable("dst", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

export type MarketCategory = "house" | "apartment" | "summer_house";

const MARKET_CATEGORY: Record<MarketCategory, { index: string; sales: string; label: string }> = {
  house: { index: "0111", sales: "0111", label: "enfamiliehuse" },
  apartment: { index: "2103", sales: "2103", label: "ejerlejligheder" },
  summer_house: { index: "0801", sales: "0801", label: "sommerhuse" },
};

/** Maps a BBR usage code (and condominium flag) to Statistikbanken's property category. */
export function marketCategoryFor(usageCode: string | undefined, isCondominium = false): MarketCategory {
  if (isCondominium || usageCode === "140") return "apartment";
  if (usageCode === "510") return "summer_house";
  return "house";
}

/**
 * Regional price index and average sale price from Statistikbanken (EJ56, EJEN77).
 * Only published per landsdel, so it describes the region, not the street.
 */
export async function getRegionalMarket(landsdelName: string, category: MarketCategory): Promise<SourceResult<AreaStats>> {
  try {
    const info = await cached(`dst:tableinfo:EJ56`, ttlFor("dst"), () =>
      fetchJson<{ variables: Array<{ id: string; values: Array<{ id: string; text: string }> }> }>(
        "https://api.statbank.dk/v1/tableinfo/EJ56?format=JSON&lang=da",
        HTTP,
      ),
    );
    const area = info.variables
      .find((variable) => variable.id === "OMRÅDE")
      ?.values.find((value) => value.text.toLowerCase() === `landsdel ${landsdelName}`.toLowerCase());
    if (!area) return unavailable("dst", "not_found", `No landsdel called ${landsdelName} in Statistikbanken`);
    const kind = MARKET_CATEGORY[category];

    const latestIndex = await statbank("EJ56", { OMRÅDE: area.id, EJENDOMSKATE: kind.index, TAL: "100,310" });
    const latest = categoryKeys(latestIndex, "Tid")[0];
    const stats: AreaStat[] = [];
    if (latest) {
      const earlier = `${Number(latest.slice(0, 4)) - 5}${latest.slice(4)}`;
      const both = await statbank("EJ56", { OMRÅDE: area.id, EJENDOMSKATE: kind.index, TAL: "100,310", Tid: `${earlier},${latest}` });
      stats.push({
        key: "price_index_change_1y",
        label: `Prisudvikling ${kind.label}, ${area.text.replace(/^Landsdel /, "")}, seneste år (${latest})`,
        value: jsonStatCell(both, { TAL: "310", Tid: latest }),
        unit: "%",
        table: "EJ56",
      });
      stats.push({
        key: "price_index_change_5y",
        label: `Prisudvikling ${kind.label} ${earlier}–${latest}`,
        value: pct(jsonStatCell(both, { TAL: "100", Tid: latest }), jsonStatCell(both, { TAL: "100", Tid: earlier })),
        unit: "%",
        table: "EJ56",
      });
    }
    const sales = await statbank("EJEN77", { OMRÅDE: area.id, EJENDOMSKATE: kind.sales, BNØGLE: "3,1", OVERDRAG: "1" });
    const salesPeriod = categoryKeys(sales, "Tid")[0];
    const avg = jsonStatCell(sales, { BNØGLE: "3" });
    stats.push({
      key: "average_sale_price",
      label: `Gns. salgspris ${kind.label}, fri handel (${salesPeriod})`,
      value: avg !== null ? avg * 1000 : null,
      unit: "kr.",
      table: "EJEN77",
    });
    stats.push({ key: "sales_count", label: `Antal salg ${kind.label} (${salesPeriod})`, value: jsonStatCell(sales, { BNØGLE: "1" }), table: "EJEN77" });
    return ok("dst", { level: "landsdel", areaCode: area.id, areaName: area.text, stats });
  } catch (error) {
    return unavailable("dst", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}
