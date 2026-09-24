import {
  bbrAsbestos,
  bbrBath,
  bbrDrainage,
  bbrFloodCompensation,
  bbrFloorType,
  bbrFuel,
  bbrHeating,
  bbrHousingType,
  bbrKitchen,
  bbrListing,
  bbrRoof,
  bbrSupplementaryHeat,
  bbrTenure,
  bbrToilet,
  bbrUnitUsage,
  bbrUsage,
  bbrWall,
  bbrWaterSupply,
  isOutbuilding,
} from "../../lib/bbr-codes.js";
import { coordinateFromEtrs89 } from "../../lib/geo.js";
import {
  ok,
  unavailable,
  type AdminAreas,
  type Building,
  type Floor,
  type Ground,
  type Parcel,
  type PropertyIds,
  type SourceResult,
  type Trade,
  type Unit,
  type Valuation,
  type ValuationEntry,
} from "../../types.js";
import { datafordelerUnavailable, queryNodes } from "./client.js";
import { getConfig } from "../../config.js";
import { SETUP_COMMAND, setupHint } from "../../catalog.js";

function hasKey(): boolean {
  return Boolean(getConfig().datafordelerApiKey);
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

function parseWktPoint(value: unknown): { x: number; y: number } | undefined {
  if (!value) return undefined;
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const fromWkt = parseWktPoint(rec.wkt);
    if (fromWkt) return fromWkt;
    const x = num(rec.x);
    const y = num(rec.y);
    if (x !== null && y !== null) return { x, y };
  }
  if (typeof value === "string") {
    const match = value.match(/POINT\s*\(\s*([0-9.]+)[,\s]+([0-9.]+)\s*\)/i);
    if (match) return { x: Number(match[1]), y: Number(match[2]) };
  }
  return undefined;
}

export async function resolveFromAddressId(addressId: string): Promise<SourceResult<PropertyIds>> {
  if (!hasKey()) return datafordelerUnavailable("dar");
  try {
    const addresses = await queryNodes(
      "DAR",
      "DAR_Adresse",
      "id_lokalId adressebetegnelse etagebetegnelse doerbetegnelse husnummer status",
      { id_lokalId: { eq: addressId } },
      1,
    );
    const adresse = addresses[0];
    if (!adresse) return unavailable("dar", "not_found", `DAR address ${addressId} not found`);

    const houseNumberId = str(adresse.husnummer);
    let house: Record<string, unknown> | undefined;
    if (houseNumberId) {
      house = (
        await queryNodes(
          "DAR",
          "DAR_Husnummer",
          "id_lokalId husnummertekst adgangsadressebetegnelse adgangspunkt jordstykke kommuneinddeling postnummer",
          { id_lokalId: { eq: houseNumberId } },
          1,
        )
      )[0];
    }

    let coordinate;
    const adgangspunktId = str(house?.adgangspunkt);
    if (adgangspunktId) {
      const point = (
        await queryNodes(
          "DAR",
          "DAR_Adressepunkt",
          "id_lokalId position { wkt crs }",
          { id_lokalId: { eq: adgangspunktId } },
          1,
        )
      )[0];
      const xy = parseWktPoint(point?.position);
      if (xy) coordinate = coordinateFromEtrs89(xy.x, xy.y);
    }

    let bfe: string | undefined;
    let isCondominium = false;
    let cadastralDistrictCode: string | undefined;
    let cadastralNumber: string | undefined;
    const jordstykkeId = str(house?.jordstykke);
    if (jordstykkeId) {
      const parcel = (
        await queryNodes(
          "MAT",
          "MAT_Jordstykke",
          "id_lokalId matrikelnummer registreretAreal samletFastEjendomLokalId ejerlavLokalId kommuneLokalId",
          { id_lokalId: { eq: jordstykkeId } },
          1,
        )
      )[0];
      cadastralNumber = str(parcel?.matrikelnummer);
      const ejerlavId = str(parcel?.ejerlavLokalId);
      if (ejerlavId) {
        const ejerlav = (
          await queryNodes(
            "MAT",
            "MAT_Ejerlav",
            "id_lokalId ejerlavskode ejerlavsnavn",
            { id_lokalId: { eq: ejerlavId } },
            1,
          )
        )[0];
        cadastralDistrictCode = str(ejerlav?.ejerlavskode);
      }
      const sfeId = str(parcel?.samletFastEjendomLokalId);
      if (sfeId) {
        const sfe = (
          await queryNodes(
            "MAT",
            "MAT_SamletFastEjendom",
            "id_lokalId BFEnummer hovedejendomOpdeltIEjerlejligh",
            { id_lokalId: { eq: sfeId } },
            1,
          )
        )[0];
        bfe = str(sfe?.BFEnummer) ?? sfeId;
        isCondominium = Boolean(sfe?.hovedejendomOpdeltIEjerlejligh);
      }
    }

    return ok("dar", {
      addressId: str(adresse.id_lokalId) ?? addressId,
      houseNumberId,
      accessAddressId: houseNumberId,
      designation: str(adresse.adressebetegnelse) ?? str(house?.adgangsadressebetegnelse),
      bfe,
      isCondominium,
      cadastralDistrictCode,
      cadastralNumber,
      coordinate,
    });
  } catch (error) {
    return unavailable("dar", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

export async function getParcels(bfe: string): Promise<SourceResult<Parcel[]>> {
  if (!hasKey()) return datafordelerUnavailable("matrikel");
  try {
    const sfe = (
      await queryNodes(
        "MAT",
        "MAT_SamletFastEjendom",
        "id_lokalId BFEnummer",
        { BFEnummer: { eq: Number(bfe) || bfe } },
        1,
      )
    )[0];
    const sfeId = str(sfe?.id_lokalId) ?? bfe;
    const parcels = await queryNodes(
      "MAT",
      "MAT_Jordstykke",
      "id_lokalId matrikelnummer registreretAreal samletFastEjendomLokalId ejerlavLokalId kommuneLokalId",
      { samletFastEjendomLokalId: { eq: sfeId } },
    );
    const mapped = [];
    for (const item of parcels) {
      let district: string | undefined;
      const ejerlavId = str(item.ejerlavLokalId);
      if (ejerlavId) {
        const ejerlav = (
          await queryNodes(
            "MAT",
            "MAT_Ejerlav",
            "ejerlavskode ejerlavsnavn",
            { id_lokalId: { eq: ejerlavId } },
            1,
          )
        )[0];
        district = str(ejerlav?.ejerlavskode);
      }
      mapped.push({
        cadastralDistrictCode: district,
        cadastralDistrictName: undefined,
        cadastralNumber: str(item.matrikelnummer),
        bfe,
        registeredArea: num(item.registreretAreal),
        municipalityCode: str(item.kommuneLokalId),
      });
    }
    if (mapped.length === 0) return unavailable("matrikel", "not_found", `No parcel for BFE ${bfe}`);
    return ok("matrikel", mapped);
  } catch (error) {
    return unavailable("matrikel", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

const BUILDING_FIELDS = [
  "id_lokalId",
  "status",
  "husnummer",
  "grund",
  "byg007Bygningsnummer",
  "byg021BygningensAnvendelse",
  "byg026Opfoerelsesaar",
  "byg027OmTilbygningsaar",
  "byg032YdervaeggensMateriale",
  "byg033Tagdaekningsmateriale",
  "byg036AsbestholdigtMateriale",
  "byg038SamletBygningsareal",
  "byg039BygningensSamledeBoligAreal",
  "byg040BygningensSamledeErhvervsAreal",
  "byg041BebyggetAreal",
  "byg054AntalEtager",
  "byg056Varmeinstallation",
  "byg057Opvarmningsmiddel",
  "byg058SupplerendeVarme",
  "byg070Fredning",
  "byg094Revisionsdato",
  "byg111StormraadetsOversvoemmelsesSelvrisiko",
  "byg404Koordinat { wkt }",
].join(" ");

const UNIT_FIELDS = [
  "id_lokalId",
  "bygning",
  "enh020EnhedensAnvendelse",
  "enh023Boligtype",
  "enh026EnhedensSamledeAreal",
  "enh027ArealTilBeboelse",
  "enh028ArealTilErhverv",
  "enh031AntalVaerelser",
  "enh032Toiletforhold",
  "enh033Badeforhold",
  "enh034Koekkenforhold",
  "enh045Udlejningsforhold",
  "enh065AntalVandskylledeToiletter",
  "enh066AntalBadevaerelser",
].join(" ");

const FLOOR_FIELDS =
  "eta006BygningensEtagebetegnelse eta020SamletArealAfEtage eta021ArealAfUdnyttetDelAfTagetage eta022Kaelderareal eta023ArealAfLovligBeboelseIKaelder eta025Etagetype";

function mapFloor(item: Record<string, unknown>): Floor {
  const typeCode = str(item.eta025Etagetype);
  return {
    designation: str(item.eta006BygningensEtagebetegnelse),
    typeCode,
    type: bbrFloorType(typeCode),
    totalArea: num(item.eta020SamletArealAfEtage),
    usedAtticArea: num(item.eta021ArealAfUdnyttetDelAfTagetage),
    basementArea: num(item.eta022Kaelderareal),
    legalBasementDwellingArea: num(item.eta023ArealAfLovligBeboelseIKaelder),
  };
}

function mapBuilding(item: Record<string, unknown>, bfe: string | undefined, floors: Floor[]): Building {
  const usageCode = str(item.byg021BygningensAnvendelse);
  const roof = str(item.byg033Tagdaekningsmateriale);
  const wall = str(item.byg032YdervaeggensMateriale);
  const heat = str(item.byg056Varmeinstallation);
  const fuel = str(item.byg057Opvarmningsmiddel);
  const supplementary = str(item.byg058SupplerendeVarme);
  const asbestos = str(item.byg036AsbestholdigtMateriale);
  const listing = str(item.byg070Fredning);
  const flood = str(item.byg111StormraadetsOversvoemmelsesSelvrisiko);
  const xy = parseWktPoint(item.byg404Koordinat);
  return {
    buildingId: str(item.id_lokalId),
    bfe,
    usageCode,
    usage: bbrUsage(usageCode),
    constructionYear: num(item.byg026Opfoerelsesaar),
    reconstructionYear: num(item.byg027OmTilbygningsaar),
    builtArea: num(item.byg041BebyggetAreal),
    totalArea: num(item.byg038SamletBygningsareal),
    dwellingArea: num(item.byg039BygningensSamledeBoligAreal),
    commercialArea: num(item.byg040BygningensSamledeErhvervsAreal),
    floors: num(item.byg054AntalEtager),
    roofMaterialCode: roof,
    roofMaterial: bbrRoof(roof),
    outerWallCode: wall,
    outerWall: bbrWall(wall),
    heatingCode: heat,
    heating: bbrHeating(heat),
    heatingFuelCode: fuel,
    heatingFuel: bbrFuel(fuel),
    supplementaryHeatCode: supplementary,
    supplementaryHeat: bbrSupplementaryHeat(supplementary),
    asbestosCode: asbestos,
    asbestos: bbrAsbestos(asbestos),
    listingCode: listing,
    listing: bbrListing(listing),
    floodCompensationCode: flood,
    floodCompensation: bbrFloodCompensation(flood),
    lastRevised: str(item.byg094Revisionsdato)?.slice(0, 10),
    coordinate: xy ? coordinateFromEtrs89(xy.x, xy.y) : undefined,
    floorDetails: floors.length ? floors : undefined,
  };
}

function mapUnit(item: Record<string, unknown>, addressId: string | undefined): Unit {
  const usageCode = str(item.enh020EnhedensAnvendelse);
  const housingTypeCode = str(item.enh023Boligtype);
  const tenureCode = str(item.enh045Udlejningsforhold);
  const toiletCode = str(item.enh032Toiletforhold);
  const bathCode = str(item.enh033Badeforhold);
  const kitchenCode = str(item.enh034Koekkenforhold);
  return {
    unitId: str(item.id_lokalId),
    buildingId: str(item.bygning),
    addressId,
    dwellingArea: num(item.enh027ArealTilBeboelse) ?? num(item.enh026EnhedensSamledeAreal),
    residentialArea: num(item.enh027ArealTilBeboelse),
    commercialArea: num(item.enh028ArealTilErhverv),
    rooms: num(item.enh031AntalVaerelser),
    kitchen: kitchenCode ? kitchenCode === "E" : null,
    toilet: toiletCode ? toiletCode === "T" : null,
    bathroom: bathCode ? bathCode === "V" : null,
    usageCode,
    usage: bbrUnitUsage(usageCode),
    housingTypeCode,
    housingType: bbrHousingType(housingTypeCode),
    tenureCode,
    tenure: bbrTenure(tenureCode),
    toiletCode,
    toilets: bbrToilet(toiletCode),
    bathCode,
    bath: bbrBath(bathCode),
    kitchenCode,
    kitchenType: bbrKitchen(kitchenCode),
    toiletCount: num(item.enh065AntalVandskylledeToiletter),
    bathroomCount: num(item.enh066AntalBadevaerelser),
  };
}

export async function getBuildingsAndUnits(
  args: { bfe?: string; addressId?: string },
): Promise<SourceResult<{ buildings: Building[]; units: Unit[]; ground?: Ground }>> {
  if (!hasKey()) return datafordelerUnavailable("bbr");
  try {
    let buildingRows: Array<Record<string, unknown>> = [];
    if (args.addressId) {
      const addresses = await queryNodes(
        "DAR",
        "DAR_Adresse",
        "husnummer",
        { id_lokalId: { eq: args.addressId } },
        1,
      );
      const houseNumberId = str(addresses[0]?.husnummer);
      if (houseNumberId) {
        buildingRows = await queryNodes("BBR", "BBR_Bygning", BUILDING_FIELDS, {
          husnummer: { eq: houseNumberId },
        });
      }
    }

    // Outbuildings often have no address of their own, so also collect every building on the same BBR ground.
    const groundId = buildingRows.map((row) => str(row.grund)).find(Boolean);
    if (groundId) {
      const onGround = await queryNodes("BBR", "BBR_Bygning", BUILDING_FIELDS, { grund: { eq: groundId } });
      const seen = new Set(buildingRows.map((row) => str(row.id_lokalId)));
      for (const row of onGround) {
        if (!seen.has(str(row.id_lokalId))) buildingRows.push(row);
      }
    }

    // Lifecycle 10 = historisk, 11 = fejlregistreret (BBR code list "Livscyklus").
    buildingRows = buildingRows.filter((row) => !["10", "11"].includes(str(row.status) ?? ""));

    const unitRows = args.addressId
      ? await queryNodes("BBR", "BBR_Enhed", UNIT_FIELDS, { adresseIdentificerer: { eq: args.addressId } })
      : [];

    const buildings = await Promise.all(
      buildingRows.map(async (item) => {
        const id = str(item.id_lokalId);
        const floorRows = id ? await queryNodes("BBR", "BBR_Etage", FLOOR_FIELDS, { bygning: { eq: id } }) : [];
        return mapBuilding(item, args.bfe, floorRows.map(mapFloor));
      }),
    );
    // Main buildings first, outbuildings after, oldest first within each group.
    buildings.sort(
      (a, b) =>
        Number(isOutbuilding(a.usageCode)) - Number(isOutbuilding(b.usageCode)) ||
        (a.constructionYear ?? 9999) - (b.constructionYear ?? 9999),
    );

    const units = unitRows.map((item) => mapUnit(item, args.addressId));

    let ground: Ground | undefined;
    if (groundId) {
      const row = (
        await queryNodes("BBR", "BBR_Grund", "id_lokalId gru009Vandforsyning gru010Afloebsforhold", {
          id_lokalId: { eq: groundId },
        }, 1)
      )[0];
      if (row) {
        const water = str(row.gru009Vandforsyning);
        const drain = str(row.gru010Afloebsforhold);
        ground = {
          groundId,
          waterSupplyCode: water,
          waterSupply: bbrWaterSupply(water),
          drainageCode: drain,
          drainage: bbrDrainage(drain),
        };
      }
    }

    if (buildings.length === 0 && units.length === 0) {
      return unavailable("bbr", "not_found", "No BBR buildings or units found");
    }
    return ok("bbr", { buildings, units, ground });
  } catch (error) {
    return unavailable("bbr", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

// VUR ids from the new valuation system (2020 onward) start at 3e14; the old system used 965... ids.
const NEW_SYSTEM_ID_MIN = 300_000_000_000_000;
const NEW_SYSTEM_ID_MAX = 900_000_000_000_000;

export function mapValuationRows(bfe: string, rows: Array<Record<string, unknown>>): Valuation {
  const byKey = new Map<string, ValuationEntry>();
  for (const item of rows) {
    const id = num(item.id);
    const system: ValuationEntry["system"] =
      id !== null && id >= NEW_SYSTEM_ID_MIN && id < NEW_SYSTEM_ID_MAX ? "new" : "old";
    const entry: ValuationEntry = {
      year: num(item.aar) ?? undefined,
      propertyValue: num(item.ejendomvaerdiBeloeb),
      landValue: num(item.grundvaerdiBeloeb),
      system,
      valuedArea: num(item.vurderetAreal),
      category: str(item.juridiskKategoriTekst)?.replace(/\s+/g, " "),
      changedOn: str(item.aendringDato),
    };
    // The register sometimes holds identical rows for the same year (corrections); keep one.
    const key = `${entry.year}:${system}:${entry.propertyValue}:${entry.landValue}`;
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  const history = [...byKey.values()].sort(
    (a, b) => (b.year ?? 0) - (a.year ?? 0) || Number(b.system === "new") - Number(a.system === "new"),
  );
  // A zero valuation (e.g. the parent property of condominiums) is kept in history but never reported as latest.
  const valued = history.filter((item) => (item.propertyValue ?? 0) > 0 || (item.landValue ?? 0) > 0);
  return {
    bfe,
    latest: valued[0] ?? history[0],
    latestNew: valued.find((item) => item.system === "new"),
    latestOld: valued.find((item) => item.system === "old"),
    history,
  };
}

export async function getValuation(bfe: string): Promise<SourceResult<Valuation>> {
  if (!hasKey()) return datafordelerUnavailable("vur");
  try {
    const refs = await queryNodes(
      "VUR",
      "VUR_BFEKrydsreference",
      "BFEnummer fkEjendomsvurderingID",
      { BFEnummer: { eq: Number(bfe) || bfe } },
      200,
      { temporal: false },
    );
    const ids = [...new Set(refs.map((ref) => num(ref.fkEjendomsvurderingID)).filter((id): id is number => id !== null))];
    const rows = (
      await Promise.all(
        ids.map(async (id) =>
          (
            await queryNodes(
              "VUR",
              "VUR_Ejendomsvurdering",
              "id aar ejendomvaerdiBeloeb grundvaerdiBeloeb vurderetAreal juridiskKategoriTekst aendringDato",
              { id: { eq: id } },
              1,
              { temporal: false },
            )
          )[0],
        ),
      )
    ).filter((row): row is Record<string, unknown> => Boolean(row));
    if (rows.length === 0) return unavailable("vur", "not_found", `No valuation for BFE ${bfe}`);
    return ok("vur", mapValuationRows(bfe, rows));
  } catch (error) {
    return unavailable("vur", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

const EJF_ATTRIBUTION = "Kilde: Ejerfortegnelsen, Geodatastyrelsen (CC BY 4.0)";

/**
 * Sale prices and dates from EJF. Only EJF_Ejerskifte and EJF_Handelsoplysninger are queried:
 * no owner, buyer or seller identities, and no deed text, which can contain names.
 */
export async function getTrades(bfe: string): Promise<SourceResult<Trade[]>> {
  const config = getConfig();
  if (!config.datafordelerOAuthClientId || !config.datafordelerOAuthClientSecret) {
    return unavailable(
      "ejf",
      "missing_credentials",
      `No EJF access is configured. ${setupHint("ejf")} Do not ask the user to paste credentials into the chat.`,
    );
  }
  try {
    const transfers = await queryNodes(
      "EJF",
      "EJF_Ejerskifte",
      "id_lokalId overtagelsesdato overdragelsesmaade handelsoplysningerLokalId bestemtFastEjendomBFENr",
      { bestemtFastEjendomBFENr: { eq: Number(bfe) || bfe } },
      50,
      { auth: "oauth" },
    );
    const trades = await Promise.all(
      transfers.map(async (item): Promise<Trade> => {
        const tradeId = str(item.handelsoplysningerLokalId);
        const sale = tradeId
          ? (
              await queryNodes(
                "EJF",
                "EJF_Handelsoplysninger",
                "id_lokalId samletKoebesum kontantKoebesum koebsaftaleDato bygningerOmfattet loesoeresum entreprisesum valutakode",
                { id_lokalId: { eq: tradeId } },
                1,
                { auth: "oauth" },
              )
            )[0]
          : undefined;
        return {
          bfe,
          date: str(item.overtagelsesdato)?.slice(0, 10),
          agreementDate: str(sale?.koebsaftaleDato)?.slice(0, 10),
          price: num(sale?.samletKoebesum),
          cashPrice: num(sale?.kontantKoebesum),
          movablesAmount: num(sale?.loesoeresum),
          contractorAmount: num(sale?.entreprisesum),
          buildingsIncluded: typeof sale?.bygningerOmfattet === "boolean" ? sale.bygningerOmfattet : null,
          currency: str(sale?.valutakode),
          transferType: str(item.overdragelsesmaade),
          attribution: EJF_ATTRIBUTION,
        };
      }),
    );
    trades.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    if (trades.length === 0) return unavailable("ejf", "not_found", `No recorded ownership changes for BFE ${bfe}`);
    return ok("ejf", trades);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("OAUTH_REJECTED")) {
      return unavailable("ejf", "missing_credentials", `${message.replace(/^OAUTH_REJECTED:\s*/, "")} Run \`${SETUP_COMMAND}\` to enter them again.`);
    }
    if (message.startsWith("FORBIDDEN")) {
      return unavailable(
        "ejf",
        "requires_agreement",
        "The OAuth IT-system works but has no approved EJF access yet. Geodatastyrelsen must approve the request for EJF_Ejerskifte and EJF_Handelsoplysninger in Datafordeler Administration.",
      );
    }
    return unavailable("ejf", "upstream_error", message);
  }
}

export async function getAdminAreasAt(x: number, y: number): Promise<SourceResult<AdminAreas>> {
  if (!hasKey()) return datafordelerUnavailable("dagi");
  try {
    const point = {
      intersects: {
        crs: 25832,
        wkt: `POINT(${x} ${y})`,
      },
    };
    const [kommune, region, sogn, post, landsdel] = await Promise.all([
      queryNodes("DAGI", "DAGI_Kommuneinddeling", "kommunekode navn", { geometri: point }, 1),
      queryNodes("DAGI", "DAGI_Regionsinddeling", "regionskode navn", { geometri: point }, 1),
      queryNodes("DAGI", "DAGI_Sogneinddeling", "sognekode navn", { geometri: point }, 1),
      queryNodes("DAGI", "DAGI_Postnummerinddeling", "postnummer navn", { geometri: point }, 1),
      queryNodes("DAGI", "DAGI_Landsdel", "navn", { geometri: point }, 1).catch(() => []),
    ]);
    return ok("dagi", {
      municipalityCode: str(kommune[0]?.kommunekode),
      municipalityName: str(kommune[0]?.navn),
      regionCode: str(region[0]?.regionskode),
      regionName: str(region[0]?.navn),
      parishCode: str(sogn[0]?.sognekode),
      parishName: str(sogn[0]?.navn),
      postalCode: str(post[0]?.postnummer),
      postalName: str(post[0]?.navn),
      landsdelName: str(landsdel[0]?.navn),
    });
  } catch (error) {
    return unavailable("dagi", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}
