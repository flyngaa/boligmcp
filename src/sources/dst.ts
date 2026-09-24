import { ttlFor } from "../catalog.js";
import { cached } from "../lib/cache.js";
import { fetchJson } from "../lib/http.js";
import { ok, unavailable, type AreaStat, type AreaStats, type SourceResult } from "../types.js";

const BASE = "https://api.statbank.dk/v1/data";

interface DstTableResponse {
  dataset?: {
    dimension?: Record<string, { category?: { label?: Record<string, string> } }>;
    value?: Array<number | null>;
    label?: string;
  };
  value?: Array<number | null>;
}

async function tableValue(
  table: string,
  municipalityCode: string,
  extra: Record<string, string> = {},
): Promise<DstTableResponse> {
  const params = new URLSearchParams({
    OMRÅDE: municipalityCode,
    lang: "en",
    ...extra,
  });
  const url = `${BASE}/${table}/JSONSTAT?${params.toString()}`;
  return cached(`dst:${table}:${municipalityCode}:${JSON.stringify(extra)}`, ttlFor("dst"), () =>
    fetchJson<DstTableResponse>(url),
  );
}

function firstValue(response: DstTableResponse): number | null {
  const values = response.dataset?.value ?? response.value ?? [];
  const found = values.find((value) => value !== null && value !== undefined);
  return found ?? null;
}

function kommuneLabel(response: DstTableResponse, code: string): string | undefined {
  const labels = response.dataset?.dimension?.OMRÅDE?.category?.label;
  return labels?.[code];
}

export async function getAreaStatsForMunicipality(
  municipalityCode: string,
): Promise<SourceResult<AreaStats>> {
  const code = municipalityCode.padStart(3, "0");
  try {
    const [folk, income, homes] = await Promise.allSettled([
      tableValue("FOLK1A", code),
      tableValue("INDKP101", code, { ENHED: "121" }),
      tableValue("BOL101", code),
    ]);

    const stats: AreaStat[] = [];
    let municipalityName: string | undefined;

    if (folk.status === "fulfilled") {
      municipalityName = kommuneLabel(folk.value, code);
      stats.push({
        key: "population",
        label: "Population (latest)",
        value: firstValue(folk.value),
        table: "FOLK1A",
      });
    }
    if (income.status === "fulfilled") {
      stats.push({
        key: "avg_income",
        label: "Average disposable income",
        value: firstValue(income.value),
        unit: "DKK",
        table: "INDKP101",
      });
    }
    if (homes.status === "fulfilled") {
      stats.push({
        key: "dwellings",
        label: "Number of dwellings",
        value: firstValue(homes.value),
        table: "BOL101",
      });
    }

    if (stats.length === 0) {
      return unavailable("dst", "upstream_error", "No Statbank tables returned data");
    }
    return ok("dst", { municipalityCode: code, municipalityName, stats });
  } catch (error) {
    return unavailable(
      "dst",
      "upstream_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}
