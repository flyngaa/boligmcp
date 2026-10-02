import { getConfig } from "../../config.js";
import { ok, unavailable, type Company, type SourceResult } from "../../types.js";
import { datafordelerUnavailable, queryNodes } from "./client.js";

export const CVR_ATTRIBUTION = "Kilde: Det Centrale Virksomhedsregister (CVR), Erhvervsstyrelsen";

// CVR answers only with virkningstid, one root field per query, and needs a filter on the entity's id.
const current = { temporal: "virkning" as const };

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const bySequence = (a: Record<string, unknown>, b: Record<string, unknown>) => (num(a.sekvens) ?? 0) - (num(b.sekvens) ?? 0);

export function formatCvrAddress(row: Record<string, unknown>): string | undefined {
  const free = str(row.CVRAdresse_adresseFritekst);
  const street = str(row.CVRAdresse_vejnavn);
  if (!street) return free;
  const from = str(row.CVRAdresse_husnummerFra);
  const to = str(row.CVRAdresse_husnummerTil);
  const number = from && to && to !== from ? `${from}-${to}` : from;
  const unit = [str(row.CVRAdresse_etagebetegnelse), str(row.CVRAdresse_doerbetegnelse)].filter(Boolean).join(". ");
  const line = [street, number].filter(Boolean).join(" ") + (unit ? `, ${unit}.` : "");
  const postal = [str(row.CVRAdresse_postnummer), str(row.CVRAdresse_postdistrikt)].filter(Boolean).join(" ");
  const country = str(row.CVRAdresse_landekode);
  return [line, postal, country && country !== "DK" ? country : undefined].filter(Boolean).join(", ");
}

/** Older head counts are left out: Datafordeleren's CVR copy stopped updating them in September 2019. */
const EMPLOYMENT_MAX_AGE_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/**
 * The newest head count. CVR keeps monthly, quarterly and yearly series side by side, in no order; employees
 * (AntalAnsatte) are preferred over full-time equivalents (Aarsvaerk), and a published count over an interval.
 */
export function latestEmployment(rows: Array<Record<string, unknown>>, now = Date.now()): Company["employees"] {
  const usable = rows.filter((row) => num(row.antal) !== undefined || num(row.intervalFra) !== undefined);
  const staff = usable.filter((row) => /AntalAnsatte/i.test(str(row.beskaeftigelsestalstype) ?? ""));
  const pool = staff.length ? staff : usable;
  const newest = [...pool].sort(
    (a, b) =>
      (str(b.datoTil) ?? "").localeCompare(str(a.datoTil) ?? "") ||
      Number(num(b.antal) !== undefined) - Number(num(a.antal) !== undefined),
  )[0];
  if (!newest) return undefined;
  const periodEnd = Date.parse(str(newest.datoTil) ?? "");
  if (!Number.isFinite(periodEnd) || now - periodEnd > EMPLOYMENT_MAX_AGE_MS) return undefined;
  const count = num(newest.antal);
  const from = str(newest.datoFra);
  const to = str(newest.datoTil);
  return {
    ...(count !== undefined ? { count } : { min: num(newest.intervalFra), max: num(newest.intervalTil) }),
    period: from && to ? `${from}–${to}` : from ?? to,
  };
}

async function unitName(unitId: string): Promise<string | undefined> {
  const names = await queryNodes("CVR", "CVR_Navn", "vaerdi sekvens", { CVREnhedsId: { eq: unitId } }, 5, current);
  return str([...names].sort(bySequence)[0]?.vaerdi);
}

/** Fully liable participants of an I/S or K/S: companies by CVR and name, people only counted. */
async function liableParticipants(unitId: string): Promise<Company["liableParticipants"]> {
  const relations = await queryNodes(
    "CVR",
    "CVR_FuldtAnsvarligDeltagerRelation",
    "deltagendeEnhedsId",
    { CVREnhedsId: { eq: unitId } },
    50,
    current,
  );
  if (relations.length === 0) return undefined;
  const companies: Array<{ cvr?: string; name?: string }> = [];
  let people = 0;
  for (const relation of relations) {
    const participantId = str(relation.deltagendeEnhedsId);
    if (!participantId) continue;
    const unit = (
      await queryNodes("CVR", "CVR_CVREnhed", "enhedsType forretningsnoegle", { id: { eq: participantId } }, 1, { temporal: false })
    )[0];
    // A person's name sits in CVRPerson, which is confidential and never asked for.
    if (/virksomhed/i.test(str(unit?.enhedsType) ?? "")) {
      companies.push({ cvr: str(unit?.forretningsnoegle), name: await unitName(participantId) });
    } else {
      people += 1;
    }
  }
  return { companies, people };
}

/** Public company data for a CVR number: name, status, form, address, industry, head count. No people's names. */
export async function getCompany(cvrNumber: string): Promise<SourceResult<Company>> {
  if (!getConfig().datafordelerApiKey) return datafordelerUnavailable("cvr");
  const cvr = cvrNumber.replace(/\s/g, "");
  if (!/^\d{8}$/.test(cvr)) return unavailable("cvr", "not_found", `A CVR number has 8 digits, got "${cvrNumber}".`);
  try {
    const company = (
      await queryNodes(
        "CVR",
        "CVR_Virksomhed",
        "id CVRNummer status virksomhedStartdato virksomhedOphoersdato",
        { CVRNummer: { eq: Number(cvr) } },
        1,
        current,
      )
    )[0];
    const unitId = str(company?.id);
    if (!company || !unitId) return unavailable("cvr", "not_found", `No company with CVR ${cvr}.`);
    const byUnit = { CVREnhedsId: { eq: unitId } };
    const [names, addresses, forms, industries, protection, employment, participants] = await Promise.all([
      queryNodes("CVR", "CVR_Navn", "vaerdi sekvens", byUnit, 5, current),
      queryNodes(
        "CVR",
        "CVR_Adressering",
        "AdresseringAnvendelse Adresse CVRAdresse_vejnavn CVRAdresse_husnummerFra CVRAdresse_husnummerTil CVRAdresse_etagebetegnelse CVRAdresse_doerbetegnelse CVRAdresse_postnummer CVRAdresse_postdistrikt CVRAdresse_kommunenavn CVRAdresse_landekode CVRAdresse_adresseFritekst",
        byUnit,
        5,
        current,
      ),
      queryNodes("CVR", "CVR_Virksomhedsform", "vaerdi vaerdiTekst", byUnit, 1, current),
      queryNodes("CVR", "CVR_Branche", "vaerdi vaerdiTekst sekvens", byUnit, 10, current),
      queryNodes("CVR", "CVR_Reklamebeskyttelse", "vaerdi", byUnit, 1, current),
      // The whole history, unordered and without temporality: the newest period is picked here.
      queryNodes(
        "CVR",
        "CVR_Beskaeftigelse",
        "antal beskaeftigelsestalstype datoFra datoTil intervalFra intervalTil",
        byUnit,
        1000,
        { temporal: false },
      ).catch(() => []),
      liableParticipants(unitId).catch(() => undefined),
    ]);
    const address =
      addresses.find((row) => /beliggenhed/i.test(str(row.AdresseringAnvendelse) ?? "")) ?? addresses[0];
    const sortedIndustries = [...industries].sort(bySequence);
    const mainIndustry = sortedIndustries[0];
    const protectedFlag = protection[0]?.vaerdi;
    return ok("cvr", {
      cvr,
      name: str([...names].sort(bySequence)[0]?.vaerdi),
      status: str(company.status),
      form: str(forms[0]?.vaerdiTekst),
      formCode: str(forms[0]?.vaerdi),
      startDate: str(company.virksomhedStartdato),
      endDate: str(company.virksomhedOphoersdato),
      address: address ? formatCvrAddress(address) : undefined,
      addressId: address ? str(address.Adresse) : undefined,
      municipality: str(address?.CVRAdresse_kommunenavn),
      industry: str(mainIndustry?.vaerdiTekst),
      industryCode: str(mainIndustry?.vaerdi),
      secondaryIndustries: sortedIndustries.slice(1).map((row) => str(row.vaerdiTekst)).filter((text): text is string => Boolean(text)),
      employees: latestEmployment(employment),
      advertisingProtected: typeof protectedFlag === "boolean" ? protectedFlag : undefined,
      liableParticipants: participants,
      attribution: CVR_ATTRIBUTION,
    });
  } catch (error) {
    return unavailable("cvr", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}
