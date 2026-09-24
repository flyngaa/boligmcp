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

export function mapSearchHit(hit: SearchHit): AddressMatch {
  const id = hit.id_lokalid ?? hit.id;
  const type = inferType(hit);
  return {
    addressId: type === "address" ? id : undefined,
    houseNumberId: hit.husnummerId ?? (type === "house_number" ? id : undefined),
    accessAddressId: hit.husnummerId ?? (type === "house_number" ? id : undefined),
    designation:
      hit.titel ??
      hit.adressebetegnelse ??
      hit.adgangsadressebetegnelse ??
      [hit.vejnavn, hit.husnummertekst].filter(Boolean).join(" "),
    streetName: hit.vejnavn,
    houseNumber: hit.husnummertekst,
    floor: hit.etagebetegnelse ?? null,
    door: hit.doerbetegnelse ?? null,
    postalCode: hit.postnr ?? hit.postnummer?.postnr,
    postalName: hit.postnummernavn ?? hit.postnummer?.navn,
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

export async function searchAddresses(
  query: string,
  limit = 10,
): Promise<SourceResult<AddressMatch[]>> {
  try {
    const url = `${BASE}/adresser/soeg?tekst=${encodeURIComponent(query)}&maksimum=${limit}&token=${encodeURIComponent(token())}`;
    const data = await cached(`adv:search:${query}:${limit}`, ttlFor("adressevaelger"), () =>
      fetchJson<SearchResponse>(url),
    );
    const hits = hitsFrom(data).slice(0, limit).map(mapSearchHit);
    if (hits.length === 0) {
      return unavailable("adressevaelger", "not_found", `No matches for "${query}"`);
    }
    return ok("adressevaelger", hits);
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
