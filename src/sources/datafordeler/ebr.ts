import { ok, unavailable, type SourceResult } from "../../types.js";
import { datafordelerUnavailable, queryNodes } from "./client.js";
import { getConfig } from "../../config.js";

const FIELDS =
  "betegnelse status husnummerLokalId adresseLokalId bestemtFastEjendomBFENr kommuneinddelingKommunekode";

export interface PropertyLocation {
  bfe: string;
  /** Text used when the property has no street address. */
  designation?: string;
  hasStreetAddress: boolean;
  houseNumberId?: string;
  addressId?: string;
  municipalityCode?: string;
  status?: string;
}

function str(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function mapPropertyLocation(row: Record<string, unknown>): PropertyLocation {
  const houseNumberId = str(row.husnummerLokalId);
  return {
    bfe: str(row.bestemtFastEjendomBFENr) ?? "",
    designation: str(row.betegnelse),
    hasStreetAddress: Boolean(houseNumberId),
    houseNumberId,
    addressId: str(row.adresseLokalId),
    municipalityCode: str(row.kommuneinddelingKommunekode),
    status: str(row.status),
  };
}

/** Beliggenhedsadresse for a BFE, or the text designation when there is no street address. */
export async function getPropertyLocation(bfe: string): Promise<SourceResult<PropertyLocation>> {
  if (!getConfig().datafordelerApiKey) return datafordelerUnavailable("ebr");
  try {
    const rows = await queryNodes(
      "EBR",
      "EBR_Ejendomsbeliggenhed",
      FIELDS,
      { bestemtFastEjendomBFENr: { eq: bfe }, status: { eq: "gældende" } },
      5,
    );
    const row = rows[0];
    if (!row) return unavailable("ebr", "not_found", `No property location for BFE ${bfe}.`);
    return ok("ebr", mapPropertyLocation(row));
  } catch (error) {
    return unavailable("ebr", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}
