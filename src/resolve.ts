import {
  cleanQuery,
  danishSpelling,
  lookupAddress,
  parseDesignation,
  searchAddresses,
  type ParsedAddress,
} from "./sources/adressevaelger.js";
import { getPropertyLocation } from "./sources/datafordeler/ebr.js";
import {
  parcelCentroidFor,
  postcodesForTown,
  resolveFromAddressId,
  resolveFromHouseNumberId,
} from "./sources/datafordeler/registers.js";
import { coordinateFromEtrs89 } from "./lib/geo.js";
import { ok, unavailable, type AddressMatch, type PropertyIds, type SourceResult } from "./types.js";

/** DAR ids are lowercase UUIDs. Clients paste them with spaces or in upper case. */
export function normalizeId(id: string | undefined): string | undefined {
  const trimmed = id?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

const sameText = (a: string | undefined, b: string | undefined) =>
  (a ?? "").replace(/\s+/g, "").toLowerCase() === (b ?? "").replace(/\s+/g, "").toLowerCase();

/** Street names as the registers spell them: "Frederiksberg Allé" = "Frederiksberg Alle", "Sankt" = "Skt." = "Sct.". */
export function streetKey(street: string | undefined): string {
  return danishSpelling(street ?? "")
    .toLowerCase()
    .replace(/é/g, "e")
    .replace(/\b(sankt|skt\.?|sct\.?)\s*/g, "skt ")
    .replace(/\bgl\.\s*/g, "gammel ")
    .replace(/\bh\.\s*c\.\s*/g, "hc ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Place names the way people type them: "Kbh", "Copenhagen" and "København" are one town. */
function townKey(town: string): string {
  return danishSpelling(town).toLowerCase().replace(/\baa/g, "å").split(/\s+/)[0] ?? "";
}

/** Whether a town named in the query is the found address's postal town or place name. */
function townMatches(town: string, found: ParsedAddress): boolean {
  const wanted = townKey(town);
  if (!wanted) return true;
  return [found.postalName, found.locality].some((name) =>
    (name ?? "")
      .toLowerCase()
      .replace(/\baa/g, "å")
      .split(/[\s,]+/)
      .some((word) => word === wanted),
  );
}

/**
 * Says what differs between the query and the address found, so a caller never takes a neighbouring flat,
 * another house number, another street or a same-named street in another town for the one asked about.
 */
export function matchWarning(query: string, found: string | undefined, hits: AddressMatch[] = []): string | undefined {
  if (!found) return undefined;
  const asked = parseDesignation(query);
  const got = parseDesignation(found);
  const differences: string[] = [];
  if (asked.street && got.street && streetKey(asked.street) !== streetKey(got.street)) {
    differences.push(`vejnavnet ${asked.street} blev til ${got.street}`);
  }
  if (asked.houseNumberRange) {
    differences.push(`${asked.houseNumberRange} er et interval; viser ${got.houseNumber ?? asked.houseNumber}`);
  } else if (asked.houseNumber && got.houseNumber && !sameText(asked.houseNumber, got.houseNumber)) {
    differences.push(`husnummer ${asked.houseNumber} blev til ${got.houseNumber}`);
  }
  if (asked.floor && !sameText(asked.floor, got.floor)) {
    differences.push(`etage ${asked.floor} findes ikke, fandt ${got.floor ?? "adressen uden etage"}`);
  }
  if (asked.door && !sameText(asked.door, got.door)) {
    differences.push(`dør ${asked.door} findes ikke${got.door ? `, fandt ${got.door}` : ""}`);
  }
  if (asked.postalCode && got.postalCode && asked.postalCode !== got.postalCode) {
    differences.push(`postnummer ${asked.postalCode} blev til ${got.postalCode}`);
  }
  const askedTown = !asked.postalCode ? asked.locality : undefined;
  if (askedTown && !townMatches(askedTown, got)) {
    differences.push(`${askedTown} blev ikke fundet; adressen ligger i ${`${got.postalCode ?? ""} ${got.postalName ?? ""}`.trim()}`);
  }
  // No postcode or town in the query, and the same street and number exists in other towns.
  if (!asked.postalCode && !askedTown) {
    const others = hits
      .map((hit) => parseDesignation(hit.designation))
      .filter(
        (parsed) =>
          parsed.postalCode &&
          parsed.postalCode !== got.postalCode &&
          streetKey(parsed.street) === streetKey(got.street) &&
          sameText(parsed.houseNumber, got.houseNumber),
      )
      .map((parsed) => `${parsed.postalCode} ${parsed.postalName ?? ""}`.trim());
    const unique = [...new Set(others)];
    if (unique.length) {
      differences.push(`samme adresse findes også i ${unique.slice(0, 3).join(", ")}; angiv postnummer for at være sikker`);
    }
  }
  return differences.length ? `Ikke et eksakt match for "${query}": ${differences.join("; ")}.` : undefined;
}

/** "Istedgade 50, 3. th, 1650" from its parts, for a second search with a postcode the first one lacked. */
function withPostcode(asked: ParsedAddress, postcode: string): string {
  const unit = [asked.floor ? `${asked.floor}.` : "", asked.door ?? ""].filter(Boolean).join(" ");
  return [`${asked.street} ${asked.houseNumber}`, unit, postcode].filter(Boolean).join(", ");
}

/** Beyond this many postcodes (København K alone has hundreds) a retry per postcode is not worth it. */
const MAX_TOWN_POSTCODES = 12;

/**
 * The search ignores a town given without a postcode ("Torvet 1 Ærøskøbing" finds Frederiksværk first).
 * Looks up the town's postcodes and searches again with each.
 */
async function searchInTown(asked: ParsedAddress): Promise<AddressMatch | undefined> {
  if (!asked.street || !asked.houseNumber || !asked.locality || asked.postalCode) return undefined;
  const codes = await postcodesForTown(danishSpelling(asked.locality)).catch(() => []);
  if (!codes.length || codes.length > MAX_TOWN_POSTCODES) return undefined;
  const results = await Promise.all(codes.map((code) => searchAddresses(withPostcode(asked, code.code), 5)));
  for (const result of results) {
    if (result.status !== "ok") continue;
    const hit = result.data.find((item) => {
      const parsed = parseDesignation(item.designation);
      return streetKey(parsed.street) === streetKey(asked.street) && sameText(parsed.houseNumber, asked.houseNumber);
    });
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Other numbers on the same street in the same postcode or town, for a query that found nothing
 * ("Vestergade 1, 8000 Aarhus" -> 1B, 1C, 2A).
 */
export async function suggestionsFor(query: string): Promise<string[]> {
  const asked = parseDesignation(cleanQuery(query));
  if (!asked.street) return [];
  let codes = asked.postalCode ? [asked.postalCode] : [];
  if (!codes.length && asked.locality) {
    codes = (await postcodesForTown(danishSpelling(asked.locality)).catch(() => []))
      .slice(0, MAX_TOWN_POSTCODES)
      .map((item) => item.code);
  }
  const searches = codes.length ? codes.map((code) => `${asked.street}, ${code}`) : [asked.street];
  const results = await Promise.all(searches.slice(0, 4).map((text) => searchAddresses(text, 20)));
  const designations = results.flatMap((result) => (result.status === "ok" ? result.data : [])).map((hit) => hit.designation);
  const sameStreet = designations.filter(
    (text) => streetKey(parseDesignation(text).street) === streetKey(asked.street) && parseDesignation(text).houseNumber,
  );
  // Closest numbers first, buildings before their flats.
  const wanted = Number.parseInt(asked.houseNumber ?? "", 10);
  const distance = (text: string) => {
    const parsed = parseDesignation(text);
    const number = Number.parseInt(parsed.houseNumber ?? "", 10);
    const gap = Number.isFinite(wanted) && Number.isFinite(number) ? Math.abs(number - wanted) : 0;
    return gap * 2 + (parsed.floor ? 1 : 0);
  };
  return [...new Set(sameStreet)].sort((a, b) => distance(a) - distance(b)).slice(0, 5);
}

async function notFound(query: string): Promise<SourceResult<PropertyIds>> {
  const suggestions = await suggestionsFor(query).catch(() => []);
  const hint = suggestions.length
    ? ` Did you mean: ${suggestions.join("; ")}?`
    : " A property without a street address can be looked up by its BFE number (bfe).";
  return unavailable("adressevaelger", "not_found", `No matches for "${query}".${hint}`);
}

async function resolveId(id: string): Promise<SourceResult<PropertyIds>> {
  const dar = await resolveFromAddressId(id);
  if (dar.status === "ok" || dar.reason !== "missing_credentials") return dar;
  // No Datafordeleren key: Adressevælgeren still gives the address, coordinate and house number.
  const lookup = await lookupAddress(id);
  if (lookup.status !== "ok") return lookup as SourceResult<PropertyIds>;
  return ok("adressevaelger", {
    addressId: lookup.data.addressId ?? id,
    houseNumberId: lookup.data.houseNumberId,
    accessAddressId: lookup.data.houseNumberId,
    designation: lookup.data.designation,
    coordinate: lookup.data.coordinate,
  });
}

async function resolveHit(hit: AddressMatch, query: string): Promise<SourceResult<PropertyIds>> {
  // "Borgergade 1" can come back only as its basement flat; without a floor in the query, take the whole building.
  const wantsUnit = Boolean(parseDesignation(query).floor);
  if (hit.addressId && (wantsUnit || !hit.floor || !hit.houseNumberId)) return resolveId(hit.addressId);
  if (!hit.houseNumberId) {
    return unavailable("adressevaelger", "not_found", `"${hit.designation}" is a street, not an address. Add a house number.`);
  }
  const dar = await resolveFromHouseNumberId(hit.houseNumberId);
  if (dar.status === "ok" || dar.reason !== "missing_credentials") return dar;
  return ok("adressevaelger", {
    houseNumberId: hit.houseNumberId,
    accessAddressId: hit.houseNumberId,
    designation: hit.designation,
    coordinate: hit.coordinate,
  });
}

/**
 * A property by its BFE: through its EBR location to the address when it has one, else the text designation
 * and a point on its land, so properties without a street address (fields, forest) can still be reported on.
 */
export async function resolveBfe(bfe: string): Promise<SourceResult<PropertyIds>> {
  const location = await getPropertyLocation(bfe);
  if (location.status !== "ok") return location as SourceResult<PropertyIds>;
  const { addressId, houseNumberId, designation } = location.data;
  if (addressId || houseNumberId) {
    const resolved = addressId ? await resolveId(addressId) : await resolveFromHouseNumberId(houseNumberId!);
    if (resolved.status === "ok") return resolved;
  }
  const centroid = await parcelCentroidFor(bfe).catch(() => undefined);
  return ok("ebr", {
    bfe,
    designation: designation ?? `BFE ${bfe}`,
    coordinate: centroid ? coordinateFromEtrs89(centroid.x, centroid.y) : undefined,
  });
}

export async function resolveProperty(input: {
  query?: string;
  addressId?: string;
  bfe?: string;
}): Promise<SourceResult<PropertyIds>> {
  const addressId = normalizeId(input.addressId);
  const query = input.query?.trim();
  const bfe = input.bfe?.trim();

  if (addressId) {
    const byId = await resolveId(addressId);
    // A stale or mistyped id should not win over a usable address text or BFE.
    if (byId.status === "ok" || (!query && !bfe)) return byId;
  }
  if (!query && bfe) return resolveBfe(bfe);
  if (!query) return unavailable("adressevaelger", "not_found", "Provide addressId, query or bfe");

  const search = await searchAddresses(query, 5);
  if (search.status === "unavailable" && search.reason !== "not_found") return search as SourceResult<PropertyIds>;
  const asked = parseDesignation(cleanQuery(query));
  let best = search.status === "ok" ? search.data[0] : undefined;
  let hits = search.status === "ok" ? search.data : [];
  // A town named without its postcode that the first search ignored.
  if (!best || (asked.locality && !asked.postalCode && !townMatches(asked.locality, parseDesignation(best.designation)))) {
    const inTown = await searchInTown(asked);
    if (inTown) {
      best = inTown;
      hits = [inTown];
    }
  }
  if (!best) return notFound(query);
  const resolved = await resolveHit(best, query);
  if (resolved.status !== "ok") return resolved;
  const warning = matchWarning(query, resolved.data.designation ?? best.designation, hits);
  return warning ? { ...resolved, data: { ...resolved.data, matchWarning: warning } } : resolved;
}
