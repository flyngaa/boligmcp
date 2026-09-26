import { bfeDwellingArea, buildFlags, flagInputFrom } from "../analysis/flags.js";
import { collectPropertyData, missingSources, summarize } from "./property-report.js";

export const SCREEN_MAX_ADDRESSES = 25;
const CONCURRENCY = 3;

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * One compact row per address, so a portfolio of candidates can be compared side by side.
 * Area statistics and energy labels are skipped: they are per-municipality or gated. Sales are
 * included when the user has configured their own EJF access.
 */
export async function screenProperties(addresses: string[]) {
  const unique = [...new Set(addresses.map((item) => item.trim()).filter(Boolean))].slice(0, SCREEN_MAX_ADDRESSES);
  const rows = await mapLimited(unique, CONCURRENCY, async (query) => {
    try {
      // A bare number is a BFE: properties without a street address can be screened too.
      const input = /^\d{1,12}$/.test(query) ? { bfe: query } : { query };
      const data = await collectPropertyData(input, { stats: true, energy: true });
      if (data.idsResult.status !== "ok") {
        return { query, error: data.idsResult.detail ?? data.idsResult.reason };
      }
      const summary = summarize(data);
      const flags = buildFlags(flagInputFrom(data));
      const valuation = data.valuation?.status === "ok" ? data.valuation.data.latestNew : undefined;
      const oldValuation = data.valuation?.status === "ok" && !valuation ? data.valuation.data.latestOld : undefined;
      // The valuation is the BFE's: divide by the area the BFE covers, not one rental flat's.
      const valuedArea = bfeDwellingArea(flagInputFrom(data));
      const perM2 = valuation?.propertyValue && valuedArea ? Math.round(valuation.propertyValue / valuedArea) : undefined;
      const rights = flags.find((flag) => flag.id === "building_rights");
      const unchecked = [
        ...new Set(
          missingSources(data)
            .filter((item) => item.source !== "emodata" && item.reason !== "not_found")
            .map((item) => `${item.source}: ${item.reason}`),
        ),
      ];
      return {
        query,
        designation: summary.designation,
        ...(summary.matchWarning ? { matchWarning: summary.matchWarning } : {}),
        bfe: summary.bfe,
        ...(summary.mainBfe ? { mainBfe: summary.mainBfe } : {}),
        usage: summary.usage,
        constructionYear: summary.constructionYear,
        dwellingArea: summary.dwellingArea,
        rooms: summary.rooms,
        plotArea: summary.plotArea,
        heating: summary.heating,
        tenure: summary.tenure,
        zone: summary.zone,
        localPlans: summary.localPlans,
        lastSale: summary.lastTrade ? { price: summary.lastTrade, date: summary.lastTradeDate } : undefined,
        newValuation: valuation
          ? { year: valuation.year, propertyValue: valuation.propertyValue, landValue: valuation.landValue }
          : undefined,
        oldValuation: oldValuation
          ? { year: oldValuation.year, propertyValue: oldValuation.propertyValue, landValue: oldValuation.landValue }
          : undefined,
        valuationPerDwellingM2: perM2,
        buildingRights: rights?.title,
        flagCounts: {
          high: flags.filter((flag) => flag.severity === "high").length,
          medium: flags.filter((flag) => flag.severity === "medium").length,
          info: flags.filter((flag) => flag.severity === "info").length,
        },
        flags: flags.filter((flag) => flag.severity !== "info").map((flag) => `${flag.severity}: ${flag.title}`),
        // Few flags can mean a clean property or missing data; this tells them apart.
        ...(unchecked.length ? { notChecked: unchecked } : {}),
      };
    } catch (error) {
      return { query, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // Two addresses can be one property (a corner house, a farm with two entrances).
  const firstQueryFor = new Map<string, string>();
  const marked = rows.map((row) => {
    const bfe = "bfe" in row ? row.bfe : undefined;
    if (!bfe) return row;
    const first = firstQueryFor.get(bfe);
    if (!first) {
      firstQueryFor.set(bfe, row.query);
      return row;
    }
    return { ...row, sameProperty: `Samme ejendom (BFE ${bfe}) som "${first}"` };
  });
  return {
    screened: rows.length,
    skipped: Math.max(0, addresses.length - unique.length),
    rows: marked,
    note: "Flags are signals for further checks, not advice. Area statistics and energy labels are left out; call property_report for one address.",
  };
}
