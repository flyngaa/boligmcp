import { lookupAddress, searchAddresses } from "./sources/adressevaelger.js";
import { resolveFromAddressId } from "./sources/datafordeler/registers.js";
import { ok, unavailable, type PropertyIds, type SourceResult } from "./types.js";

export async function resolveProperty(input: {
  query?: string;
  addressId?: string;
}): Promise<SourceResult<PropertyIds>> {
  let addressId = input.addressId;
  let designation: string | undefined;
  let houseNumberId: string | undefined;
  let coordinate = undefined;

  if (!addressId && input.query) {
    const search = await searchAddresses(input.query, 5);
    if (search.status !== "ok") return search as SourceResult<PropertyIds>;
    const best =
      search.data.find((item) => item.addressId) ??
      search.data.find((item) => item.houseNumberId) ??
      search.data[0];
    if (!best) return unavailable("adressevaelger", "not_found", `No match for "${input.query}"`);
    addressId = best.addressId;
    houseNumberId = best.houseNumberId;
    designation = best.designation;
  }

  if (addressId) {
    const lookup = await lookupAddress(addressId);
    if (lookup.status === "ok") {
      designation = lookup.data.designation ?? designation;
      houseNumberId = lookup.data.houseNumberId ?? houseNumberId;
      coordinate = lookup.data.coordinate;
    }
    const dar = await resolveFromAddressId(addressId);
    if (dar.status === "ok") {
      return ok("dar", {
        ...dar.data,
        designation: dar.data.designation ?? designation,
        coordinate: dar.data.coordinate ?? coordinate,
      });
    }
    if (dar.status === "unavailable" && dar.reason !== "missing_credentials") {
      return dar;
    }
    return ok("adressevaelger", {
      addressId,
      houseNumberId,
      accessAddressId: houseNumberId,
      designation,
      coordinate,
    });
  }

  if (houseNumberId) {
    return ok("adressevaelger", {
      houseNumberId,
      accessAddressId: houseNumberId,
      designation,
      coordinate,
    });
  }

  return unavailable(
    "adressevaelger",
    "not_found",
    "Could not resolve an address-id. Try a more specific query.",
  );
}
