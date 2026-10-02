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
  isCurrentBbrRow,
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
import { datafordelerUnavailable, queryAllNodes, queryNodes } from "./client.js";
import { cached } from "../../lib/cache.js";
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

/** DAR lifecycle codes for addresses in use: 2 proposed, 3 current. 4 and 5 are retired or dropped. */
const LIVE_DAR_STATUS = new Set(["2", "3"]);

/** Parcel, cadastral ids, BFE and access point for one house number. The property's ids, not a flat's. */
async function houseNumberIds(houseNumberId: string): Promise<(PropertyIds & { found: boolean }) | undefined> {
  const house = (
    await queryNodes(
      "DAR",
      "DAR_Husnummer",
      "id_lokalId husnummertekst adgangsadressebetegnelse adgangspunkt jordstykke kommuneinddeling postnummer",
      { id_lokalId: { eq: houseNumberId } },
      1,
    )
  )[0];
  if (!house) return undefined;

  let coordinate;
  const adgangspunktId = str(house.adgangspunkt);
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
  const jordstykkeId = str(house.jordstykke);
  if (jordstykkeId) {
    const parcel = (
      await queryNodes(
        "MAT",
        "MAT_Jordstykke",
        "id_lokalId matrikelnummer registreretAreal samletFastEjendomLokalId ejerlavLokalId kommuneLokalId",
        { id_lokalId: { eq: jordstykkeId }, status: { eq: "Gældende" } },
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

  return {
    found: true,
    houseNumberId,
    accessAddressId: houseNumberId,
    designation: str(house.adgangsadressebetegnelse),
    bfe,
    isCondominium,
    cadastralDistrictCode,
    cadastralNumber,
    coordinate,
  };
}

/**
 * The condominium (ejerlejlighed) an address belongs to. EBR links each condominium's BFE to its unit address;
 * the parcel only knows the main property.
 */
export async function condominiumBfeFor(addressId: string): Promise<string | undefined> {
  const rows = await queryNodes(
    "EBR",
    "EBR_Ejendomsbeliggenhed",
    "bestemtFastEjendomBFENr status",
    { adresseLokalId: { eq: addressId }, status: { eq: "gældende" } },
    5,
  );
  return rows.map((row) => str(row.bestemtFastEjendomBFENr)).find(Boolean);
}

function withoutFound(ids: PropertyIds & { found?: boolean }): PropertyIds {
  const { found: _found, ...rest } = ids;
  return rest;
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
    // Search hits for a whole building carry only a house-number id; accept that in place of an address id.
    if (!adresse) return resolveFromHouseNumberId(addressId);

    const houseNumberId = str(adresse.husnummer);
    const house = houseNumberId ? await houseNumberIds(houseNumberId) : undefined;
    const ids: PropertyIds = {
      ...(house ? withoutFound(house) : {}),
      addressId: str(adresse.id_lokalId) ?? addressId,
      houseNumberId,
      accessAddressId: houseNumberId,
      designation: str(adresse.adressebetegnelse) ?? house?.designation,
    };

    // A flat that is its own condominium has its own BFE, valuation and sales.
    if (house?.isCondominium) {
      const condoBfe = await condominiumBfeFor(ids.addressId!).catch(() => undefined);
      if (condoBfe && condoBfe !== house.bfe) {
        ids.mainBfe = house.bfe;
        ids.bfe = condoBfe;
      }
    }
    return ok("dar", ids);
  } catch (error) {
    return unavailable("dar", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

/** Resolves a house number (a whole building entrance). Uses its own floorless address when it has one. */
export async function resolveFromHouseNumberId(houseNumberId: string): Promise<SourceResult<PropertyIds>> {
  if (!hasKey()) return datafordelerUnavailable("dar");
  try {
    const house = await houseNumberIds(houseNumberId);
    if (!house) return unavailable("dar", "not_found", `DAR address or house number ${houseNumberId} not found`);
    const addresses = (
      await queryNodes(
        "DAR",
        "DAR_Adresse",
        "id_lokalId adressebetegnelse etagebetegnelse doerbetegnelse status",
        { husnummer: { eq: houseNumberId } },
        100,
      )
    ).filter((row) => LIVE_DAR_STATUS.has(String(row.status ?? "3")));
    const plain = addresses.find((row) => !str(row.etagebetegnelse) && !str(row.doerbetegnelse));
    return ok("dar", {
      ...withoutFound(house),
      addressId: str(plain?.id_lokalId),
      designation: str(plain?.adressebetegnelse) ?? house.designation,
    });
  } catch (error) {
    return unavailable("dar", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

/** Theme areas registered on one parcel. tematype is data, not a filter field. */
async function cadastralNotes(jordstykkeId: string): Promise<string[]> {
  const rows = await queryNodes(
    "MAT",
    "MAT_JordstykkeTemaflade",
    "tematype",
    { jordstykkeLokalId: { eq: jordstykkeId }, status: { eq: "Gældende" } },
    50,
  );
  return [...new Set(rows.map((row) => str(row.tematype)).filter((value): value is string => Boolean(value)))];
}

/**
 * The main property (samlet fast ejendom) that owns the land for a BFE. A condominium's BFE has no parcels of
 * its own, so it is followed to the property it is part of.
 */
export async function mainPropertyIdFor(bfe: string): Promise<string | undefined> {
  const sfe = (
    await queryNodes("MAT", "MAT_SamletFastEjendom", "id_lokalId BFEnummer", { BFEnummer: { eq: Number(bfe) } }, 1)
  )[0];
  if (sfe) return str(sfe.id_lokalId);
  const condo = (
    await queryNodes(
      "MAT",
      "MAT_Ejerlejlighed",
      "samletFastEjendomLokalId status",
      { BFEnummer: { eq: Number(bfe) }, status: { eq: "Gældende" } },
      1,
    )
  )[0];
  return str(condo?.samletFastEjendomLokalId);
}

/** Current parcels of a main property. Pending changes ("Ikke gennemført") are left out. */
async function parcelRowsFor(sfeId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await queryNodes(
    "MAT",
    "MAT_Jordstykke",
    "id_lokalId matrikelnummer registreretAreal samletFastEjendomLokalId ejerlavLokalId kommuneLokalId status",
    { samletFastEjendomLokalId: { eq: sfeId }, status: { eq: "Gældende" } },
  );
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = str(row.id_lokalId);
    if (id && !byId.has(id)) byId.set(id, row);
  }
  return [...byId.values()];
}

/** A point inside the property's land: the centroid of its first current parcel. For properties without buildings. */
export async function parcelCentroidFor(bfe: string): Promise<{ x: number; y: number } | undefined> {
  if (!hasKey()) return undefined;
  const sfeId = await mainPropertyIdFor(bfe);
  if (!sfeId) return undefined;
  for (const parcel of (await parcelRowsFor(sfeId)).slice(0, 3)) {
    const id = str(parcel.id_lokalId);
    if (!id) continue;
    const row = (await queryNodes("MAT", "MAT_Centroide", "geometri { wkt }", { jordstykkeLokalId: { eq: id } }, 1))[0];
    const point = parseWktPoint(row?.geometri);
    if (point) return point;
  }
  return undefined;
}

let postcodeList: Promise<Array<{ code: string; name: string }>> | undefined;

/** Every Danish postcode with its name, from DAGI. Fetched once per process; it changes a few times a year. */
async function postcodes(): Promise<Array<{ code: string; name: string }>> {
  postcodeList ??= cached("dagi:postcodes:v1", 30 * 86_400, () =>
    queryAllNodes("DAGI", "DAGI_Postnummerinddeling", "postnummer navn"),
  )
    .then((rows) =>
      rows.flatMap((row) => {
        const code = str(row.postnummer);
        const name = str(row.navn);
        return code && name ? [{ code, name }] : [];
      }),
    )
    .catch((error) => {
      postcodeList = undefined;
      throw error;
    });
  return postcodeList;
}

/**
 * Postcodes whose name is the town or starts with it: "Ærøskøbing" -> 5970, "Aarhus" -> 8000 Aarhus C, 8200 Aarhus N, ...
 * The address search ignores a town given without its postcode, so the resolver retries with these.
 */
export async function postcodesForTown(town: string): Promise<Array<{ code: string; name: string }>> {
  if (!hasKey()) return [];
  const wanted = town.trim().toLowerCase();
  if (wanted.length < 2) return [];
  const all = await postcodes();
  const exact = all.filter((item) => item.name.toLowerCase() === wanted);
  if (exact.length) return exact;
  const prefixed = all
    .filter((item) => item.name.toLowerCase().startsWith(`${wanted} `))
    .sort((a, b) => a.code.localeCompare(b.code));
  if (prefixed.length) return prefixed;
  return postcodesForLocality(town.trim(), all);
}

/**
 * Villages that are not postal towns ("Møgeltønder" lies in 6270 Tønder) are DAR supplementary town names.
 * Each name's postcode is read from one of its house numbers; several villages can share a name.
 */
async function postcodesForLocality(
  name: string,
  all: Array<{ code: string; name: string }>,
): Promise<Array<{ code: string; name: string }>> {
  const localities = await queryNodes("DAR", "DAR_SupplerendeBynavn", "id_lokalId", { navn: { eq: name } }, 6);
  const postcodeIds = await Promise.all(
    localities.map(async (locality) => {
      const id = str(locality.id_lokalId);
      if (!id) return undefined;
      const house = (await queryNodes("DAR", "DAR_Husnummer", "postnummer", { supplerendeBynavn: { eq: id } }, 1))[0];
      return str(house?.postnummer);
    }),
  );
  const codes = await Promise.all(
    [...new Set(postcodeIds.filter((id): id is string => Boolean(id)))].map(async (id) => {
      const row = (await queryNodes("DAR", "DAR_Postnummer", "postnr", { id_lokalId: { eq: id } }, 1))[0];
      return str(row?.postnr);
    }),
  );
  return [...new Set(codes.filter((code): code is string => Boolean(code)))]
    .sort()
    .map((code) => all.find((item) => item.code === code) ?? { code, name });
}

export async function getParcels(bfe: string): Promise<SourceResult<Parcel[]>> {
  if (!hasKey()) return datafordelerUnavailable("matrikel");
  try {
    const sfeId = await mainPropertyIdFor(bfe);
    if (!sfeId) return unavailable("matrikel", "not_found", `No parcel for BFE ${bfe}`);
    const parcels = await parcelRowsFor(sfeId);
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
      const parcelId = str(item.id_lokalId);
      mapped.push({
        cadastralDistrictCode: district,
        cadastralDistrictName: undefined,
        cadastralNumber: str(item.matrikelnummer),
        bfe,
        registeredArea: num(item.registreretAreal),
        municipalityCode: str(item.kommuneLokalId),
        notes: parcelId ? await cadastralNotes(parcelId) : [],
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
  "status",
  "bygning",
  "adresseIdentificerer",
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

/** BBR unit usages that are homes: 1xx dwellings, 510 summer house, 540 allotment house. */
const isDwellingUsage = (code: string | undefined) => Boolean(code && /^(1\d\d|51\d|54\d)$/.test(code));

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
    houseNumberId: str(item.husnummer),
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
    addressId: str(item.adresseIdentificerer) ?? addressId,
    // The unit's total area is its dwelling area only for a home; a school or shop without enh027 has none.
    dwellingArea:
      num(item.enh027ArealTilBeboelse) ??
      (isDwellingUsage(usageCode) && !num(item.enh028ArealTilErhverv) ? num(item.enh026EnhedensSamledeAreal) : null),
    residentialArea: num(item.enh027ArealTilBeboelse),
    totalArea: num(item.enh026EnhedensSamledeAreal),
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

/** Units listed for a whole building or property; a block of flats can have hundreds. */
const MAX_UNITS = 20;
/** Units fetched with full fields per building; beyond this only a count is taken. */
const UNIT_PAGE = 100;

/**
 * Main buildings first: dwellings before other uses, then the building at the address itself, then the largest.
 * A farm's house beats its bigger barn, and a castle estate's residence is not a random 1743 barn.
 */
export function sortBuildings(buildings: Building[], houseNumberId?: string): Building[] {
  const rank = (b: Building) => [
    Number(isOutbuilding(b.usageCode)),
    Number(!/^1\d\d$/.test(b.usageCode ?? "")),
    Number(!(houseNumberId && b.houseNumberId === houseNumberId)),
    -(b.totalArea ?? b.builtArea ?? 0),
    b.constructionYear ?? 9999,
  ];
  return [...buildings].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
    return 0;
  });
}

async function buildingRowsById(ids: string[]): Promise<Array<Record<string, unknown>>> {
  const rows = await Promise.all(
    ids.map((id) => queryNodes("BBR", "BBR_Bygning", BUILDING_FIELDS, { id_lokalId: { eq: id } }, 1)),
  );
  return rows.flat();
}

export async function getBuildingsAndUnits(args: {
  bfe?: string;
  addressId?: string;
  houseNumberId?: string;
  /** The main property when `bfe` is a condominium; its parcels hold the buildings. */
  mainBfe?: string;
}): Promise<SourceResult<{ buildings: Building[]; units: Unit[]; ground?: Ground; unitsTotal?: number }>> {
  if (!hasKey()) return datafordelerUnavailable("bbr");
  try {
    let buildingRows: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const addRows = (rows: Array<Record<string, unknown>>) => {
      for (const row of rows) {
        const id = str(row.id_lokalId);
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        buildingRows.push(row);
      }
    };

    let houseNumberId = args.houseNumberId;
    if (args.addressId && !houseNumberId) {
      const addresses = await queryNodes("DAR", "DAR_Adresse", "husnummer", { id_lokalId: { eq: args.addressId } }, 1);
      houseNumberId = str(addresses[0]?.husnummer);
    }
    if (houseNumberId) {
      addRows(await queryNodes("BBR", "BBR_Bygning", BUILDING_FIELDS, { husnummer: { eq: houseNumberId } }));
    }

    // A flat's building can be registered at a sibling house number (Nyhavn 18A's flats sit in Nyhavn 18's building).
    const addressUnitRows = args.addressId
      ? (await queryNodes("BBR", "BBR_Enhed", UNIT_FIELDS, { adresseIdentificerer: { eq: args.addressId } })).filter(
          isCurrentBbrRow,
        )
      : [];
    const unitBuildingIds = [...new Set(addressUnitRows.map((row) => str(row.bygning)).filter((id): id is string => Boolean(id)))];
    addRows(await buildingRowsById(unitBuildingIds.filter((id) => !seen.has(id))));

    // Nothing at the address: take the buildings standing on the property's parcels.
    if (buildingRows.filter(isCurrentBbrRow).length === 0) {
      const propertyBfe = args.mainBfe ?? args.bfe;
      const sfeId = propertyBfe ? await mainPropertyIdFor(propertyBfe) : undefined;
      const parcelIds = sfeId ? (await parcelRowsFor(sfeId)).map((row) => str(row.id_lokalId)).filter(Boolean) : [];
      for (const parcelId of parcelIds.slice(0, 10)) {
        addRows(await queryNodes("BBR", "BBR_Bygning", BUILDING_FIELDS, { jordstykke: { eq: parcelId } }));
      }
    }

    // Outbuildings often have no address of their own, so also collect every building on the same BBR ground.
    const groundId = buildingRows.map((row) => str(row.grund)).find(Boolean);
    if (groundId) {
      addRows(await queryNodes("BBR", "BBR_Bygning", BUILDING_FIELDS, { grund: { eq: groundId } }));
    }

    buildingRows = buildingRows.filter(isCurrentBbrRow);

    // For a flat, its own units. For a whole building or property, or a building's street address that has
    // no unit of its own (the flats hang on their floor addresses), the units in its main buildings.
    let unitRows = addressUnitRows;
    let unitsTotal: number | undefined;
    if (unitRows.length === 0) {
      const mainIds = buildingRows
        .filter((row) => !isOutbuilding(str(row.byg021BygningensAnvendelse)))
        .map((row) => str(row.id_lokalId))
        .filter((id): id is string => Boolean(id))
        .slice(0, 5);
      const allMainIds = buildingRows
        .filter((row) => !isOutbuilding(str(row.byg021BygningensAnvendelse)))
        .map((row) => str(row.id_lokalId))
        .filter((id): id is string => Boolean(id));
      const pages = await Promise.all(
        mainIds.map((id) => queryNodes("BBR", "BBR_Enhed", UNIT_FIELDS, { bygning: { eq: id } }, UNIT_PAGE)),
      );
      const rows = pages.flat().filter(isCurrentBbrRow);
      unitRows = rows.slice(0, MAX_UNITS);
      // The rows above are a sample when a building has more than one page or there are more buildings.
      // Gudrunsvej 8 has 1,155 units in 13 blocks; counting only the sample said 390.
      const partial = allMainIds.length > mainIds.length || pages.some((page) => page.length >= UNIT_PAGE);
      if (partial) {
        const counts = await Promise.all(
          allMainIds.map(async (id) =>
            (await queryAllNodes("BBR", "BBR_Enhed", "id_lokalId status", { bygning: { eq: id } })).filter(isCurrentBbrRow).length,
          ),
        );
        unitsTotal = counts.reduce((sum, count) => sum + count, 0);
      } else if (rows.length > MAX_UNITS) {
        unitsTotal = rows.length;
      }
    }

    const buildings = await Promise.all(
      buildingRows.map(async (item) => {
        const id = str(item.id_lokalId);
        const floorRows = id ? await queryNodes("BBR", "BBR_Etage", FLOOR_FIELDS, { bygning: { eq: id } }) : [];
        return mapBuilding(item, args.bfe, floorRows.map(mapFloor));
      }),
    );
    const sorted = sortBuildings(buildings, houseNumberId);

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

    if (sorted.length === 0 && units.length === 0) {
      return unavailable("bbr", "not_found", "No BBR buildings or units found");
    }
    return ok("bbr", { buildings: sorted, units, ground, ...(unitsTotal ? { unitsTotal } : {}) });
  } catch (error) {
    return unavailable("bbr", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

// VUR ids from the new valuation system (2020 onward) are one digit followed by zeros and a running number
// (300000000888869, 600000000444014). Old-system ids carry a varying prefix (965…, 386…, 403…).
const isNewSystemId = (id: number | null) => id !== null && /^[1-9]0{6}/.test(String(id));

export function mapValuationRows(bfe: string, rows: Array<Record<string, unknown>>): Valuation {
  const byKey = new Map<string, ValuationEntry>();
  for (const item of rows) {
    const id = num(item.id);
    const system: ValuationEntry["system"] = isNewSystemId(id) ? "new" : "old";
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

  // One year can hold several valuations of the same property: parts with their own valued area (an estate valued
  // as farm and forest) are added together; rows for the same area are corrections, and the newest one counts.
  const byYear = new Map<string, ValuationEntry[]>();
  for (const entry of byKey.values()) {
    const key = `${entry.year}:${entry.system}`;
    byYear.set(key, [...(byYear.get(key) ?? []), entry]);
  }
  const history: ValuationEntry[] = [];
  for (const entries of byYear.values()) {
    // A revision within the year can change the area a little (Egeskov 2003: 4,673,916 m² in January, 4,762,821 m²
    // in October); areas within 5 % are the same valuation, not two parts to add up.
    const sameArea = (a: number | null | undefined, b: number | null | undefined) =>
      a === b || (Boolean(a) && Boolean(b) && Math.abs(a! - b!) <= 0.05 * Math.max(a!, b!));
    const clusters: ValuationEntry[] = [];
    for (const entry of [...entries].sort((a, b) => (a.changedOn ?? "").localeCompare(b.changedOn ?? ""))) {
      const index = clusters.findIndex((kept) => sameArea(kept.valuedArea, entry.valuedArea));
      if (index === -1) clusters.push(entry);
      else clusters[index] = entry;
    }
    // A later row of zeros with no area (Levantkaj 2015) is a placeholder, not a second part.
    const empty = (entry: ValuationEntry) => !entry.valuedArea && !entry.propertyValue && !entry.landValue;
    const parts = clusters.some((entry) => !empty(entry)) ? clusters.filter((entry) => !empty(entry)) : clusters;
    if (parts.length === 1 || parts.some((part) => part.valuedArea === null || part.valuedArea === undefined)) {
      history.push(...parts);
      continue;
    }
    const sum = (pick: (entry: ValuationEntry) => number | null | undefined) =>
      parts.reduce((total, part) => total + (pick(part) ?? 0), 0);
    history.push({
      ...parts[0]!,
      propertyValue: sum((part) => part.propertyValue),
      landValue: sum((part) => part.landValue),
      valuedArea: sum((part) => part.valuedArea),
      changedOn: parts.map((part) => part.changedOn ?? "").sort().at(-1) || undefined,
      parts: parts.length,
    });
  }
  history.sort(
    (a, b) => (b.year ?? 0) - (a.year ?? 0) || Number(b.system === "new") - Number(a.system === "new"),
  );

  // A zero valuation (e.g. the parent property of condominiums) is kept in history but never reported as latest.
  const valued = history.filter((item) => (item.propertyValue ?? 0) > 0 || (item.landValue ?? 0) > 0);
  const latest = valued[0] ?? history[0];
  const newestZero = history.find((item) => (item.year ?? 0) > (latest?.year ?? 0) && !valued.includes(item));
  const allZero = history.length > 0 && valued.length === 0;
  return {
    bfe,
    latest,
    latestNew: valued.find((item) => item.system === "new"),
    latestOld: valued.find((item) => item.system === "old"),
    ...(allZero
      ? {
          note: "Alle vurderinger er 0 kr. Det ses typisk for en hovedejendom opdelt i ejerlejligheder, hvor hver lejlighed vurderes for sig, eller en ejendom uden selvstændig vurdering.",
        }
      : newestZero
      ? {
          note: `Vurderingen for ${newestZero.year} er 0 kr., typisk for en hovedejendom opdelt i ejerlejligheder eller en ejendom uden selvstændig vurdering. ${latest?.year ?? "Ingen"} er seneste vurdering med et beløb.`,
        }
      : {}),
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

/** EJF stores unknown dates of old transfers as the Unix epoch (shown as 1969-12-31 or 1970-01-01). */
export function realDate(value: unknown): string | undefined {
  const date = str(value)?.slice(0, 10);
  return date && date !== "1969-12-31" && date !== "1970-01-01" ? date : undefined;
}

export const EJF_ATTRIBUTION = "Kilde: Ejerfortegnelsen, Geodatastyrelsen (CC BY 4.0)";

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
      "id_lokalId overtagelsesdato overdragelsesmaade handelsoplysningerLokalId bestemtFastEjendomBFENr status",
      { bestemtFastEjendomBFENr: { eq: Number(bfe) || bfe } },
      50,
      { auth: "oauth" },
    );
    // A rolled-back change stays in the register next to its correction: Egeskovvej 41 has 275.000 kr. rolled back
    // and 550.000 kr. current for the same 1990 sale.
    const current = transfers.filter((item) => !/tilbagerul|annul|slettet/i.test(str(item.status) ?? ""));
    const trades = await Promise.all(
      current.map(async (item): Promise<Trade> => {
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
          date: realDate(item.overtagelsesdato),
          agreementDate: realDate(sale?.koebsaftaleDato),
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
    const [kommune, region, sogn, post, landsdel, court, police] = await Promise.all([
      queryNodes("DAGI", "DAGI_Kommuneinddeling", "kommunekode navn", { geometri: point }, 1),
      queryNodes("DAGI", "DAGI_Regionsinddeling", "regionskode navn", { geometri: point }, 1),
      queryNodes("DAGI", "DAGI_Sogneinddeling", "sognekode navn", { geometri: point }, 1),
      queryNodes("DAGI", "DAGI_Postnummerinddeling", "postnummer navn", { geometri: point }, 1),
      queryNodes("DAGI", "DAGI_Landsdel", "navn", { geometri: point }, 1).catch(() => []),
      queryNodes("DAGI", "DAGI_Retskreds", "navn", { geometri: point }, 1).catch(() => []),
      queryNodes("DAGI", "DAGI_Politikreds", "navn", { geometri: point }, 1).catch(() => []),
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
      courtDistrict: str(court[0]?.navn),
      policeDistrict: str(police[0]?.navn),
    });
  } catch (error) {
    return unavailable("dagi", "upstream_error", error instanceof Error ? error.message : String(error));
  }
}
