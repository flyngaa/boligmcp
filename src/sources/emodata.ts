import { setupHint, ttlFor } from "../catalog.js";
import { getConfig } from "../config.js";
import { cacheGet, cacheSet } from "../lib/cache.js";
import { fetchJson, HttpError } from "../lib/http.js";
import { ok, unavailable, type EnergyLabel, type SourceResult } from "../types.js";

const BASE = "https://emoweb.dk/emodata/emodata.svc/SearchEnergyLabelBFE";

interface EmoLabel {
  EnergyLabelClassification?: string;
  ValidFrom?: string;
  ValidTo?: string;
  DEMOLink?: string;
}

interface EmoResponse {
  EnergyLabels?: EmoLabel[] | EmoLabel | null;
  ResponseStatus?: { Status?: string; StatusMessage?: string };
}

function labelsOf(body: EmoResponse): EmoLabel[] {
  const raw = body.EnergyLabels;
  if (Array.isArray(raw)) return raw;
  return raw ? [raw] : [];
}

function currentLabel(labels: EmoLabel[]): EmoLabel | undefined {
  return [...labels].sort((a, b) => (b.ValidFrom ?? "").localeCompare(a.ValidFrom ?? ""))[0];
}

function missingLogin(detail?: string): SourceResult<never> {
  const how = setupHint("emodata");
  const base = detail ?? `No EMOData credentials are configured. ${how ?? ""}`;
  return unavailable(
    "emodata",
    "missing_credentials",
    `${base} Do not ask the user to paste them into the chat.`.replace(/\s+/g, " ").trim(),
  );
}

export async function getEnergyLabel(query: { bfe?: string }): Promise<SourceResult<EnergyLabel>> {
  const { emodataUser, emodataPassword } = getConfig();
  if (!emodataUser || !emodataPassword) return missingLogin();
  if (!query.bfe) {
    return unavailable("emodata", "not_found", "Need a BFE number for the energy label lookup.");
  }

  const key = `emo:bfe:${query.bfe}`;
  const hit = cacheGet<SourceResult<EnergyLabel>>(key);
  if (hit?.status === "ok") return hit;

  try {
    const auth = Buffer.from(`${emodataUser}:${emodataPassword}`).toString("base64");
    const body = await fetchJson<EmoResponse>(`${BASE}/${encodeURIComponent(query.bfe)}`, {
      headers: { authorization: `Basic ${auth}` },
    });
    const status = body.ResponseStatus?.Status ?? "";
    if (/ACCESS_DENIED|UNAUTHORIZED/i.test(status)) {
      return missingLogin(`Energistyrelsen rejected the EMOData login. ${setupHint("emodata") ?? ""}`);
    }
    const labels = labelsOf(body);
    const label = currentLabel(labels);
    if (!label?.EnergyLabelClassification) {
      return unavailable("emodata", "not_found", `No energy label for BFE ${query.bfe}.`);
    }
    const reportUrl = label.DEMOLink?.startsWith("http") ? label.DEMOLink : undefined;
    const result = ok("emodata", {
      rating: label.EnergyLabelClassification,
      validFrom: label.ValidFrom,
      validTo: label.ValidTo,
      reportUrl,
      improvements: [],
      sharedLabel: labels.length > 1,
    });
    cacheSet(key, result, ttlFor("emodata"));
    return result;
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      return missingLogin(
        `Energistyrelsen rejected the EMOData login (${error.status}). ${setupHint("emodata") ?? ""}`,
      );
    }
    return unavailable("emodata", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}
