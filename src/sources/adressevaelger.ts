import { ttlFor } from "../catalog.js";
import { getConfig } from "../config.js";
import { cached } from "../lib/cache.js";
import { coordinateFromEtrs89 } from "../lib/geo.js";
import { fetchJson } from "../lib/http.js";
import {
  ok,
  unavailable,
  type AddressMatch,
  type Coordinate,
  type SourceResult,
} from "../types.js";

const BASE = "https://adressevaelger.dk";

interface SearchHit {
  type?: string;
  id?: string;
  id_lokalid?: string;
  husnummerId?: string;
  titel?: string;
  adressebetegnelse?: string;
  adgangsadressebetegnelse?: string;
  vejnavn?: string;
  husnummertekst?: string;
  husnummer?: string;
  etagebetegnelse?: string | null;
  doerbetegnelse?: string | null;
  postnr?: string;
  postnummer?: { postnr?: string; navn?: string };
  postnummernavn?: string;
}

interface SearchResponse {
  status?: string;
  fund?: SearchHit[];
  resultater?: SearchHit[];
  adresser?: SearchHit[];
  husnumre?: SearchHit[];
}

interface IdLookupResponse {
  status?: string;
  adresse?: Record<string, unknown>;
  husnummer?: Record<string, unknown>;
  adgangspunkt?: Record<string, unknown>;
  postnummer?: Record<string, unknown>;
  kommune?: Record<string, unknown>;
  vejnavn?: string;
  husnummertekst?: string;
  adressebetegnelse?: string;
  adgangsadressebetegnelse?: string;
  id_lokalid?: string;
  etagebetegnelse?: string | null;
  doerbetegnelse?: string | null;
}

function token(): string {
  return getConfig().adressevaelgerToken;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function coordinateFromUnknown(value: unknown): Coordinate | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const coords = rec.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) {
    const x = Number(coords[0]);
    const y = Number(coords[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) return coordinateFromEtrs89(x, y);
  }
  const nested = asRecord(rec.koordinater) ?? asRecord(rec.geometri) ?? asRecord(rec.position);
  if (nested && nested !== rec) {
    const fromNested = coordinateFromUnknown(nested);
    if (fromNested) return fromNested;
  }
  const x = Number(rec.x ?? rec.oest ?? rec.east ?? rec.easting);
  const y = Number(rec.y ?? rec.nord ?? rec.north ?? rec.northing);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return coordinateFromEtrs89(x, y);
}

function inferType(hit: SearchHit): AddressMatch["type"] {
  const raw = (hit.type ?? "").toLowerCase();
  if (raw.includes("adresse") && !raw.includes("hus")) return "address";
  if (raw.includes("husnummer") || raw.includes("adgang")) return "house_number";
  if (raw.includes("vej")) return "street";
  if (hit.etagebetegnelse || hit.doerbetegnelse || hit.adressebetegnelse) return "address";
  if (hit.adgangsadressebetegnelse || hit.husnummertekst) return "house_number";
  return "other";
}

/**
 * Splits a designation such as "Istedgade 50, 1. th, 1650 København V" or "Egeskovvej 41, Hald Ege, 8800 Viborg".
 * The search API returns only this text for most hits, so floor, door and postcode come from here.
 */
export function parseDesignation(text: string): {
  street?: string;
  houseNumber?: string;
  floor?: string;
  door?: string;
  postalCode?: string;
  postalName?: string;
} {
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  const head = parts[0]?.match(/^(.*?)\s+(\d+\s*[A-Za-zÆØÅæøå]?)$/);
  const tail = parts.length > 1 ? parts[parts.length - 1]!.match(/^(\d{4})\s+(.+)$/) : null;
  const unit = parts.slice(1, tail ? -1 : undefined).find((part) => FLOOR_RE.test(part));
  const unitMatch = unit?.match(FLOOR_RE);
  return {
    street: head?.[1] ?? parts[0],
    houseNumber: head?.[2]?.replace(/\s+/g, "").toUpperCase(),
    floor: unitMatch?.[1]?.replace(/\.$/, "").toLowerCase(),
    door: unitMatch?.[2]?.replace(/\.$/, "").toLowerCase() || undefined,
    postalCode: tail?.[1],
    postalName: tail?.[2],
  };
}

/** "st", "kl", "1.", "12. th", "st. mf", "2. 3" */
const FLOOR_RE = /^(st\.?|kl\d?\.?|k\d\.?|\d{1,2}\.?)(?:\s+(\S+))?$/i;

export function mapSearchHit(hit: SearchHit): AddressMatch {
  const id = hit.id_lokalid ?? hit.id;
  const type = inferType(hit);
  const parsed = parseDesignation(hit.titel ?? hit.adressebetegnelse ?? hit.adgangsadressebetegnelse ?? "");
  return {
    addressId: type === "address" ? id : undefined,
    houseNumberId: hit.husnummerId ?? (type === "house_number" ? id : undefined),
    accessAddressId: hit.husnummerId ?? (type === "house_number" ? id : undefined),
    designation:
      hit.titel ??
      hit.adressebetegnelse ??
      hit.adgangsadressebetegnelse ??
      [hit.vejnavn, hit.husnummertekst].filter(Boolean).join(" "),
    streetName: hit.vejnavn ?? parsed.street,
    houseNumber: hit.husnummertekst ?? hit.husnummer ?? parsed.houseNumber,
    floor: hit.etagebetegnelse ?? (type === "address" ? parsed.floor : undefined) ?? null,
    door: hit.doerbetegnelse ?? (type === "address" ? parsed.door : undefined) ?? null,
    postalCode: hit.postnr ?? hit.postnummer?.postnr ?? parsed.postalCode,
    postalName: hit.postnummernavn ?? hit.postnummer?.navn ?? parsed.postalName,
    type,
  };
}

export function mapIdLookup(data: IdLookupResponse): AddressMatch {
  const adresse = asRecord(data.adresse) ?? asRecord(data) ?? {};
  const husnummer = asRecord(data.husnummer) ?? asRecord(adresse.husnummer);
  const postnummer =
    asRecord(data.postnummer) ?? asRecord(adresse.postnummer) ?? asRecord(husnummer?.postnummer);
  const kommune =
    asRecord(data.kommune) ??
    asRecord(adresse.kommune) ??
    asRecord(husnummer?.navngivenvejkommunedel);
  const adgangspunkt =
    asRecord(data.adgangspunkt) ??
    asRecord(husnummer?.adgangspunkt) ??
    asRecord(adresse.adgangspunkt);

  const addressId = pickString(adresse.id_lokalid, adresse["id"], data.id_lokalid);
  const houseNumberId = pickString(
    husnummer?.id_lokalid,
    husnummer?.id,
    asRecord(adresse.husnummer)?.id_lokalid,
  );

  return {
    addressId,
    houseNumberId,
    accessAddressId: houseNumberId,
    designation: pickString(
      adresse.adressebetegnelse,
      data.adressebetegnelse,
      husnummer?.adgangsadressebetegnelse,
      data.adgangsadressebetegnelse,
    ) ?? "",
    streetName: pickString(adresse.vejnavn, husnummer?.vejnavn, data.vejnavn),
    houseNumber: pickString(
      adresse.husnummertekst,
      husnummer?.husnummertekst,
      data.husnummertekst,
    ),
    floor: (pickString(adresse.etagebetegnelse, data.etagebetegnelse) ?? null) as string | null,
    door: (pickString(adresse.doerbetegnelse, data.doerbetegnelse) ?? null) as string | null,
    postalCode: pickString(postnummer?.postnr, adresse["postnr"]),
    postalName: pickString(postnummer?.navn, postnummer?.postnummernavn),
    municipalityCode: pickString(
      kommune?.kommunekode,
      kommune?.kode,
      kommune?.kommune,
      asRecord(adresse.kommune)?.kommunekode,
      asRecord(asRecord(adresse.husnummer)?.navngivenvejkommunedel)?.kommune,
    ),
    type: addressId ? "address" : "house_number",
    coordinate: coordinateFromUnknown(adgangspunkt) ?? coordinateFromUnknown(asRecord(adgangspunkt?.position)),
  };
}

function hitsFrom(response: SearchResponse): SearchHit[] {
  return response.fund ?? response.resultater ?? response.adresser ?? response.husnumre ?? [];
}

/** The search API rejects very long text; no Danish address comes close to this. */
const MAX_QUERY_LENGTH = 200;
/** Hits fetched before re-ranking, so a town named without its postcode can still win. */
const CANDIDATES = 20;

const CITY_ALIASES: Array<[RegExp, string]> = [
  [/\bcopenhagen\b/gi, "København"],
  [/\bkobenhavn\b/gi, "København"],
  [/\bkbh\.?(?=\s|,|$)/gi, "København"],
  [/\baarhus\b/gi, "Aarhus"],
  [/\belsinore\b/gi, "Helsingør"],
  [/\bblvd\.?(?=\s|,|$)/gi, "Boulevard"],
  [/\bH\.?\s?C\.?\s+(?=[A-ZÆØÅ])/g, "H.C. "],
];

/** ASCII spellings of Danish letters: "Noerrebrogade" -> "Nørrebrogade", "Koebenhavn" -> "København". */
export function danishSpelling(query: string): string {
  let text = query;
  for (const [pattern, replacement] of CITY_ALIASES) text = text.replace(pattern, replacement);
  return text
    .replace(/oe/g, "ø")
    .replace(/Oe/g, "Ø")
    .replace(/ae/g, "æ")
    .replace(/Ae/g, "Æ")
    .replace(/(?<!A)aa/g, "å")
    .replace(/\bAa(?!rhus|lborg|benraa)/g, "Å");
}

/** Keeps letters, digits and the separators the search understands. Emoji and symbols only make it miss. */
export function cleanQuery(query: string): string {
  return query
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s.,\-/']/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/\baa/g, "å")
    .split(/[\s,.]+/)
    .filter((word) => word.length > 1 || /\d/.test(word));

/**
 * The search ranks by street and number first and can drop a town given without a postcode
 * ("Boulevarden 1 Aalborg" ranks Nexø first). Hits that contain more of the query's words move up;
 * the API's own order breaks ties.
 */
export function rerank(query: string, hits: AddressMatch[]): AddressMatch[] {
  const wanted = new Set([...words(query), ...words(danishSpelling(query))]);
  const score = (hit: AddressMatch) => [...new Set(words(hit.designation))].filter((word) => wanted.has(word)).length;
  // Without a floor in the query, the building's own address beats a flat in it.
  const wantedFloor = parseDesignation(query).floor;
  const unitPenalty = (hit: AddressMatch) => (!wantedFloor && hit.floor ? 1 : 0);
  return hits
    .map((hit, index) => ({ hit, index, score: score(hit) }))
    .sort((a, b) => b.score - a.score || unitPenalty(a.hit) - unitPenalty(b.hit) || a.index - b.index)
    .map((item) => item.hit);
}

async function searchOnce(query: string): Promise<AddressMatch[]> {
  const url = `${BASE}/adresser/soeg?tekst=${encodeURIComponent(query)}&maksimum=${CANDIDATES}&token=${encodeURIComponent(token())}`;
  const data = await cached(`adv:search:${query}:${CANDIDATES}`, ttlFor("adressevaelger"), () =>
    fetchJson<SearchResponse>(url),
  );
  return hitsFrom(data).map(mapSearchHit);
}

export async function searchAddresses(
  query: string,
  limit = 10,
): Promise<SourceResult<AddressMatch[]>> {
  try {
    const cleaned = cleanQuery(query);
    if (cleaned.length < 2) return unavailable("adressevaelger", "not_found", `No matches for "${query}"`);
    let hits = await searchOnce(cleaned);
    if (hits.length === 0) {
      const respelled = danishSpelling(cleaned);
      if (respelled !== cleaned) hits = await searchOnce(respelled);
    }
    if (hits.length === 0) {
      return unavailable("adressevaelger", "not_found", `No matches for "${query}"`);
    }
    return ok("adressevaelger", rerank(cleaned, hits).slice(0, limit));
  } catch (error) {
    return unavailable(
      "adressevaelger",
      "upstream_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function lookupAddress(addressId: string): Promise<SourceResult<AddressMatch>> {
  try {
    const url = `${BASE}/adresser/${encodeURIComponent(addressId)}?token=${encodeURIComponent(token())}`;
    const data = await cached(`adv:addr:${addressId}`, ttlFor("adressevaelger"), () =>
      fetchJson<IdLookupResponse>(url),
    );
    const match = mapIdLookup(data);
    if (!match.designation && !match.addressId) {
      return unavailable("adressevaelger", "not_found", `Address ${addressId} not found`);
    }
    return ok("adressevaelger", match);
  } catch (error) {
    return unavailable(
      "adressevaelger",
      "upstream_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}
