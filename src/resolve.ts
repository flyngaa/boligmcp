import { lookupAddress, parseDesignation, searchAddresses } from "./sources/adressevaelger.js";
import { resolveFromAddressId, resolveFromHouseNumberId } from "./sources/datafordeler/registers.js";
import { ok, unavailable, type AddressMatch, type PropertyIds, type SourceResult } from "./types.js";

/** DAR ids are lowercase UUIDs. Clients paste them with spaces or in upper case. */
export function normalizeId(id: string | undefined): string | undefined {
  const trimmed = id?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

const sameText = (a: string | undefined, b: string | undefined) =>
  (a ?? "").replace(/\s+/g, "").toLowerCase() === (b ?? "").replace(/\s+/g, "").toLowerCase();

/**
 * Says what differs between the query and the address found, so a caller never takes a neighbouring flat,
 * another house number or a same-named street in another town for the one asked about.
 */
export function matchWarning(query: string, found: string | undefined, hits: AddressMatch[] = []): string | undefined {
  if (!found) return undefined;
  const asked = parseDesignation(query);
  const got = parseDesignation(found);
  const differences: string[] = [];
  if (asked.houseNumber && got.houseNumber && !sameText(asked.houseNumber, got.houseNumber)) {
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
  // No postcode in the query and the same street and number exists in other towns.
  const namesTown = got.postalName && query.toLowerCase().includes(got.postalName.toLowerCase().split(" ")[0]!);
  if (!asked.postalCode && !namesTown) {
    const others = hits
      .map((hit) => ({ hit, parsed: parseDesignation(hit.designation) }))
      .filter(
        ({ parsed }) =>
          parsed.postalCode &&
          parsed.postalCode !== got.postalCode &&
          sameText(parsed.street, got.street) &&
          sameText(parsed.houseNumber, got.houseNumber),
      )
      .map(({ parsed }) => `${parsed.postalCode} ${parsed.postalName ?? ""}`.trim());
    const unique = [...new Set(others)];
    if (unique.length) {
      differences.push(`samme adresse findes også i ${unique.slice(0, 3).join(", ")}; angiv postnummer for at være sikker`);
    }
  }
  return differences.length ? `Ikke et eksakt match for "${query}": ${differences.join("; ")}.` : undefined;
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

export async function resolveProperty(input: {
  query?: string;
  addressId?: string;
}): Promise<SourceResult<PropertyIds>> {
  const addressId = normalizeId(input.addressId);
  const query = input.query?.trim();

  if (addressId) {
    const byId = await resolveId(addressId);
    // A stale or mistyped id should not win over a usable address text.
    if (byId.status === "ok" || !query) return byId;
  }

  if (!query) return unavailable("adressevaelger", "not_found", "Provide addressId or query");

  const search = await searchAddresses(query, 5);
  if (search.status !== "ok") return search as SourceResult<PropertyIds>;
  const best = search.data[0];
  if (!best) return unavailable("adressevaelger", "not_found", `No match for "${query}"`);
  const resolved = await resolveHit(best, query);
  if (resolved.status !== "ok") return resolved;
  const warning = matchWarning(query, resolved.data.designation ?? best.designation, search.data);
  return warning ? { ...resolved, data: { ...resolved.data, matchWarning: warning } } : resolved;
}
