import { isSourceConfigured } from "../catalog.js";
import { getConfig } from "../config.js";
import { ttlFor } from "../catalog.js";
import { cached } from "../lib/cache.js";
import { fetchJson } from "../lib/http.js";
import { ok, unavailable, type EnergyLabel, type SourceResult } from "../types.js";

const SEARCH_URL = "https://emoweb.dk/EMODataService/EMODataService.svc/SearchBuildings";

interface EmoBuilding {
  EnergyLabelClassification?: string;
  ValidFrom?: string;
  ValidTo?: string;
  ReportUrl?: string;
  PdfUrl?: string;
  Improvements?: string[] | string;
  Address?: string;
}

export async function getEnergyLabel(query: {
  address?: string;
  bfe?: string;
}): Promise<SourceResult<EnergyLabel>> {
  if (!isSourceConfigured("emodata")) {
    return unavailable(
      "emodata",
      "missing_credentials",
      "Set EMODATA_USER and EMODATA_PASSWORD after registering with Energistyrelsen.",
    );
  }

  const config = getConfig();
  const search = query.address ?? query.bfe;
  if (!search) {
    return unavailable("emodata", "not_found", "Need address or BFE for energy label lookup");
  }

  try {
    const auth = Buffer.from(`${config.emodataUser}:${config.emodataPassword}`).toString("base64");
    const url = `${SEARCH_URL}?search=${encodeURIComponent(search)}`;
    const data = await cached(`emo:${search}`, ttlFor("emodata"), () =>
      fetchJson<EmoBuilding[] | { buildings?: EmoBuilding[] }>(url, {
        headers: { authorization: `Basic ${auth}` },
      }),
    );
    const buildings = Array.isArray(data) ? data : (data.buildings ?? []);
    const first = buildings[0];
    if (!first) {
      return unavailable("emodata", "not_found", `No energy label for ${search}`);
    }
    const improvements = Array.isArray(first.Improvements)
      ? first.Improvements
      : first.Improvements
        ? [first.Improvements]
        : [];
    return ok("emodata", {
      rating: first.EnergyLabelClassification,
      validFrom: first.ValidFrom,
      validTo: first.ValidTo,
      reportUrl: first.ReportUrl ?? first.PdfUrl,
      improvements,
      sharedLabel: buildings.length > 1,
    });
  } catch (error) {
    return unavailable(
      "emodata",
      "upstream_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}
