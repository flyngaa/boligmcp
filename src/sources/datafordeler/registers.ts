import { bbrFuel, bbrHeating, bbrRoof, bbrUsage, bbrWall, ownershipLabel } from "../../lib/bbr-codes.js";
import { coordinateFromEtrs89 } from "../../lib/geo.js";
import {
  ok,
  unavailable,
  type AdminAreas,
  type Building,
  type Parcel,
  type PropertyIds,
  type SourceResult,
  type Trade,
  type Unit,
  type Valuation,
} from "../../types.js";
import { datafordelerUnavailable, graphql } from "./client.js";
import { getConfig } from "../../config.js";

function hasKey(): boolean {
  return Boolean(getConfig().datafordelerApiKey);
}

function asList<T>(value: T | T[] | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function num(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

export async function resolveFromAddressId(addressId: string): Promise<SourceResult<PropertyIds>> {
  if (!hasKey()) return datafordelerUnavailable("dar");
  try {
    const query = `
      query ($id: String!) {
        Adresse(id: $id) {
          id_lokalId
          adressebetegnelse
          etagebetegnelse
          doerbetegnelse
          husnummer {
            id_lokalId
            husnummertekst
            adgangsadressebetegnelse
            adgangspunkt { position { x y } }
            jordstykke {
              matrikelnummer
              ejerlav { kode navn }
              samletFastEjendom { bestemtFastEjendomBFENummer }
            }
            kommune { kommunekode }
          }
        }
      }
    `;
    const data = await graphql<{
      Adresse?: Array<Record<string, unknown>> | Record<string, unknown>;
    }>("DAR", query, { id: addressId }, `daf:dar:${addressId}`);

    const adresse = asList(data.Adresse)[0];
    if (!adresse) return unavailable("dar", "not_found", `DAR address ${addressId} not found`);

    const husnummer = (adresse.husnummer ?? {}) as Record<string, unknown>;
    const jordstykke = (husnummer.jordstykke ?? {}) as Record<string, unknown>;
    const ejerlav = (jordstykke.ejerlav ?? {}) as Record<string, unknown>;
    const sfe = (jordstykke.samletFastEjendom ?? {}) as Record<string, unknown>;
    const punkt = ((husnummer.adgangspunkt as Record<string, unknown> | undefined)?.position ??
      {}) as Record<string, unknown>;
    const x = num(punkt.x);
    const y = num(punkt.y);

    return ok("dar", {
      addressId: str(adresse.id_lokalId) ?? addressId,
      houseNumberId: str(husnummer.id_lokalId),
      accessAddressId: str(husnummer.id_lokalId),
      designation: str(adresse.adressebetegnelse) ?? str(husnummer.adgangsadressebetegnelse),
      bfe: str(sfe.bestemtFastEjendomBFENummer),
      cadastralDistrictCode: str(ejerlav.kode),
      cadastralNumber: str(jordstykke.matrikelnummer),
      coordinate: x !== null && y !== null ? coordinateFromEtrs89(x, y) : undefined,
    });
  } catch (error) {
    return unavailable("dar", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

export async function getParcels(bfe: string): Promise<SourceResult<Parcel[]>> {
  if (!hasKey()) return datafordelerUnavailable("matrikel");
  try {
    const query = `
      query ($bfe: String!) {
        Jordstykke(bestemtFastEjendomBFENummer: $bfe) {
          matrikelnummer
          registreretAreal
          ejerlav { kode navn }
          kommune { kommunekode }
          samletFastEjendom { bestemtFastEjendomBFENummer }
        }
      }
    `;
    const data = await graphql<{
      Jordstykke?: Array<Record<string, unknown>>;
    }>("MAT", query, { bfe }, `daf:mat:${bfe}`);
    const parcels = asList(data.Jordstykke).map((item) => {
      const ejerlav = (item.ejerlav ?? {}) as Record<string, unknown>;
      const kommune = (item.kommune ?? {}) as Record<string, unknown>;
      const sfe = (item.samletFastEjendom ?? {}) as Record<string, unknown>;
      return {
        cadastralDistrictCode: str(ejerlav.kode),
        cadastralDistrictName: str(ejerlav.navn),
        cadastralNumber: str(item.matrikelnummer),
        bfe: str(sfe.bestemtFastEjendomBFENummer) ?? bfe,
        registeredArea: num(item.registreretAreal),
        municipalityCode: str(kommune.kommunekode),
      };
    });
    if (parcels.length === 0) return unavailable("matrikel", "not_found", `No parcel for BFE ${bfe}`);
    return ok("matrikel", parcels);
  } catch (error) {
    return unavailable("matrikel", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

export async function getBuildingsAndUnits(
  args: { bfe?: string; addressId?: string },
): Promise<SourceResult<{ buildings: Building[]; units: Unit[] }>> {
  if (!hasKey()) return datafordelerUnavailable("bbr");
  try {
    const query = `
      query ($bfe: String, $addressId: String) {
        Bygning(bestemtFastEjendomBFENummer: $bfe) {
          id_lokalId
          byg007Bygningsnummer
          byg021BygningensAnvendelse
          byg026Opfoerelsesaar
          byg027Ombygningaar
          byg038SamletBygningsareal
          byg041BebyggetAreal
          byg054AntalEtager
          byg032YdervaeggensMateriale
          byg033Tagdaekningsmateriale
          byg056Varmeinstallation
          byg058SupplerendeVarme
          bygningPaaFremmedGrund { bestemtFastEjendomBFENummer }
        }
        Enhed(adresseIdentificerer: $addressId) {
          id_lokalId
          enh020EnhedensAnvendelse
          enh026EnhedensSamledeAreal
          enh031AntalVaerelser
          enh032Toiletforhold
          enh033Badeforhold
          enh034Koekkenforhold
          bygning { id_lokalId }
        }
      }
    `;
    const data = await graphql<{
      Bygning?: Array<Record<string, unknown>>;
      Enhed?: Array<Record<string, unknown>>;
    }>("BBR", query, { bfe: args.bfe ?? null, addressId: args.addressId ?? null }, `daf:bbr:${args.bfe}:${args.addressId}`);

    const buildings = asList(data.Bygning).map((item) => {
      const usageCode = str(item.byg021BygningensAnvendelse);
      const roof = str(item.byg033Tagdaekningsmateriale);
      const wall = str(item.byg032YdervaeggensMateriale);
      const heat = str(item.byg056Varmeinstallation);
      const fuel = str(item.byg058SupplerendeVarme);
      return {
        buildingId: str(item.id_lokalId),
        bfe: args.bfe,
        usageCode,
        usage: bbrUsage(usageCode),
        constructionYear: num(item.byg026Opfoerelsesaar),
        reconstructionYear: num(item.byg027Ombygningaar),
        builtArea: num(item.byg041BebyggetAreal),
        totalArea: num(item.byg038SamletBygningsareal),
        floors: num(item.byg054AntalEtager),
        roofMaterialCode: roof,
        roofMaterial: bbrRoof(roof),
        outerWallCode: wall,
        outerWall: bbrWall(wall),
        heatingCode: heat,
        heating: bbrHeating(heat),
        heatingFuelCode: fuel,
        heatingFuel: bbrFuel(fuel),
      };
    });

    const units = asList(data.Enhed).map((item) => {
      const building = (item.bygning ?? {}) as Record<string, unknown>;
      return {
        unitId: str(item.id_lokalId),
        buildingId: str(building.id_lokalId),
        addressId: args.addressId,
        dwellingArea: num(item.enh026EnhedensSamledeAreal),
        rooms: num(item.enh031AntalVaerelser),
        kitchen: item.enh034Koekkenforhold ? true : null,
        toilet: item.enh032Toiletforhold ? true : null,
        bathroom: item.enh033Badeforhold ? true : null,
        usage: bbrUsage(str(item.enh020EnhedensAnvendelse)),
      };
    });

    if (buildings.length === 0 && units.length === 0) {
      return unavailable("bbr", "not_found", "No BBR buildings or units found");
    }
    return ok("bbr", { buildings, units });
  } catch (error) {
    return unavailable("bbr", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

export async function getValuation(bfe: string): Promise<SourceResult<Valuation>> {
  if (!hasKey()) return datafordelerUnavailable("vur");
  try {
    const query = `
      query ($bfe: String!) {
        Ejendomsvurdering(bestemtFastEjendomBFENummer: $bfe) {
          vurderingsaar
          ejendomsvaerdi
          grundvaerdi
        }
      }
    `;
    const data = await graphql<{
      Ejendomsvurdering?: Array<Record<string, unknown>>;
    }>("VUR", query, { bfe }, `daf:vur:${bfe}`);
    const history = asList(data.Ejendomsvurdering)
      .map((item) => ({
        year: num(item.vurderingsaar) ?? undefined,
        propertyValue: num(item.ejendomsvaerdi),
        landValue: num(item.grundvaerdi),
      }))
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    if (history.length === 0) return unavailable("vur", "not_found", `No valuation for BFE ${bfe}`);
    return ok("vur", { bfe, latest: history[0], history });
  } catch (error) {
    return unavailable("vur", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

export async function getTrades(bfe: string): Promise<SourceResult<Trade[]>> {
  if (!hasKey()) return datafordelerUnavailable("ejf");
  try {
    const query = `
      query ($bfe: String!) {
        Handelsoplysning(bestemtFastEjendomBFENummer: $bfe) {
          handelsdato
          kontantKoebesum
          overdragelsesaarsag
        }
        Ejerskifte(bestemtFastEjendomBFENummer: $bfe) {
          overdragelsesdato
        }
        Ejerforhold(bestemtFastEjendomBFENummer: $bfe) {
          ejerforholdskode
        }
      }
    `;
    const data = await graphql<{
      Handelsoplysning?: Array<Record<string, unknown>>;
      Ejerforhold?: Array<Record<string, unknown>>;
    }>("EJF", query, { bfe }, `daf:ejf:${bfe}`);
    const ownership = asList(data.Ejerforhold)[0];
    const ownershipCode = str(ownership?.ejerforholdskode);
    const trades = asList(data.Handelsoplysning).map((item) => ({
      bfe,
      date: str(item.handelsdato),
      price: num(item.kontantKoebesum),
      transferType: str(item.overdragelsesaarsag),
      ownershipCode,
      ownership: ownershipLabel(ownershipCode),
    }));
    if (trades.length === 0) {
      return ok("ejf", [
        {
          bfe,
          ownershipCode,
          ownership: ownershipLabel(ownershipCode),
        },
      ]);
    }
    return ok("ejf", trades);
  } catch (error) {
    return unavailable("ejf", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

export async function getAdminAreasAt(x: number, y: number): Promise<SourceResult<AdminAreas>> {
  if (!hasKey()) return datafordelerUnavailable("dagi");
  try {
    const query = `
      query ($x: Float!, $y: Float!) {
        KommuneInddeling(punkt: {x: $x, y: $y}) { kommunekode navn }
        Regionsinddeling(punkt: {x: $x, y: $y}) { regionskode navn }
        Sogneinddeling(punkt: {x: $x, y: $y}) { sognekode navn }
        Postnummerinddeling(punkt: {x: $x, y: $y}) { postnummer navn }
        Retskreds(punkt: {x: $x, y: $y}) { navn }
        Politikreds(punkt: {x: $x, y: $y}) { navn }
        Opstillingskreds(punkt: {x: $x, y: $y}) { navn }
      }
    `;
    const data = await graphql<Record<string, unknown>>(
      "DAGI",
      query,
      { x, y },
      `daf:dagi:${x.toFixed(0)}:${y.toFixed(0)}`,
    );
    const first = (value: unknown): Record<string, unknown> | undefined => {
      if (!value) return undefined;
      const list = asList(value as Record<string, unknown>);
      const item = list[0];
      return item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
    };
    const kommune = first(data.KommuneInddeling);
    const region = first(data.Regionsinddeling);
    const sogn = first(data.Sogneinddeling);
    const post = first(data.Postnummerinddeling);
    return ok("dagi", {
      municipalityCode: str(kommune?.kommunekode),
      municipalityName: str(kommune?.navn),
      regionCode: str(region?.regionskode),
      regionName: str(region?.navn),
      parishCode: str(sogn?.sognekode),
      parishName: str(sogn?.navn),
      postalCode: str(post?.postnummer),
      postalName: str(post?.navn),
      courtDistrict: str(first(data.Retskreds)?.navn),
      policeDistrict: str(first(data.Politikreds)?.navn),
      constituency: str(first(data.Opstillingskreds)?.navn),
    });
  } catch (error) {
    return unavailable("dagi", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}
