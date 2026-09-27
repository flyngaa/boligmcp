import { setupHint, SETUP_COMMAND } from "../../catalog.js";
import { getConfig } from "../../config.js";
import { bbrLabel } from "../../lib/bbr-codes.js";
import { ok, unavailable, type Company, type Owner, type SourceResult } from "../../types.js";
import { queryNodes } from "./client.js";
import { getCompany } from "./cvr.js";
import { EJF_ATTRIBUTION } from "./registers.js";

/** Private individuals (ejerforholdskode 10) and interessentskaber. */
const PRIVATE_CODE = "10";

// EJFCustom_EjerskabBegraenset is the ownership entity private actors may be granted (EJF_Ejerskab carries CPR
// numbers and is for public authorities). Only the owning company's CVR number, the ownership code and the share
// are asked for: never ejendePersonBegraenset, administrators or owner details, which name private people.
const OWNER_FIELDS = "ejendeVirksomhedCVRNr ejerforholdskode faktiskEjerandel_taeller faktiskEjerandel_naevner virkningFra status";

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

export function mapOwner(row: Record<string, unknown>): Owner {
  const cvr = str(row.ejendeVirksomhedCVRNr)?.padStart(8, "0");
  const code = str(row.ejerforholdskode);
  const numerator = Number(row.faktiskEjerandel_taeller);
  const denominator = Number(row.faktiskEjerandel_naevner);
  return {
    kind: cvr ? "company" : code === PRIVATE_CODE ? "private_person" : "other",
    ownershipCode: code,
    ownershipType: code ? bbrLabel("Ejerforholdskode", code) : undefined,
    share: numerator > 0 && denominator > 0 ? numerator / denominator : undefined,
    since: str(row.virkningFra)?.slice(0, 10),
    cvr,
    attribution: EJF_ATTRIBUTION,
  };
}

/**
 * Current owners of a BFE from EJF. A company owner is looked up in CVR; a private person is only reported as
 * such, with the share. Needs the user's own EJF access, approved for CustomEjerskabBegraenset.
 */
export async function getOwners(bfe: string): Promise<SourceResult<Owner[]>> {
  const config = getConfig();
  if (!config.datafordelerOAuthClientId || !config.datafordelerOAuthClientSecret) {
    return unavailable("ejf", "missing_credentials", `No EJF access is configured. ${setupHint("ejf")} Do not ask the user to paste credentials into the chat.`);
  }
  try {
    const rows = await queryNodes("FLEX", "EJFCustom_EjerskabBegraenset", OWNER_FIELDS, { bestemtFastEjendomBFENr: { eq: Number(bfe) || bfe } }, 50, {
      auth: "oauth",
      temporal: "virkning",
    });
    const owners = rows.filter((row) => !/tilbagerul|annul|slettet|historisk/i.test(str(row.status) ?? "")).map(mapOwner);
    if (owners.length === 0) return unavailable("ejf", "not_found", `No current owners recorded for BFE ${bfe}.`);
    const companies = new Map<string, Promise<Company | undefined>>();
    for (const owner of owners) {
      if (owner.cvr && !companies.has(owner.cvr)) {
        companies.set(owner.cvr, getCompany(owner.cvr).then((result) => (result.status === "ok" ? result.data : undefined)));
      }
    }
    return ok(
      "ejf",
      await Promise.all(
        owners.map(async (owner) => {
          const company = owner.cvr ? await companies.get(owner.cvr) : undefined;
          return company ? { ...owner, company } : owner;
        }),
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("OAUTH_REJECTED")) {
      return unavailable("ejf", "missing_credentials", `${message.replace(/^OAUTH_REJECTED:\s*/, "")} Run \`${SETUP_COMMAND}\` to enter them again.`);
    }
    if (message.startsWith("FORBIDDEN")) {
      return unavailable(
        "ejf",
        "requires_agreement",
        "The OAuth IT-system has no approved access to CustomEjerskabBegraenset. Owners need it added to the EJF request to Geodatastyrelsen in Datafordeler Administration (access to sale prices does not include it). Company data by CVR number works without it: get_company.",
      );
    }
    return unavailable("ejf", "upstream_error", message);
  }
}
