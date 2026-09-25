import { z } from "zod";

export const SourceIdSchema = z.enum([
  "adressevaelger",
  "dar",
  "ebr",
  "matrikel",
  "bbr",
  "dagi",
  "vur",
  "ejf",
  "plandata",
  "miljoportal",
  "dst",
  "dhm",
  "geodanmark",
  "emodata",
  "dataforsyningen",
  "fbb",
]);
export type SourceId = z.infer<typeof SourceIdSchema>;

export const UnavailableReasonSchema = z.enum([
  "missing_credentials",
  "requires_agreement",
  "not_found",
  "upstream_error",
]);
export type UnavailableReason = z.infer<typeof UnavailableReasonSchema>;

export const SourceResultOkSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    status: z.literal("ok"),
    source: SourceIdSchema,
    fetchedAt: z.string(),
    data,
  });

export const SourceResultUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  source: SourceIdSchema,
  reason: UnavailableReasonSchema,
  detail: z.string().optional(),
});

export type SourceResult<T> =
  | { status: "ok"; source: SourceId; fetchedAt: string; data: T }
  | {
      status: "unavailable";
      source: SourceId;
      reason: UnavailableReason;
      detail?: string;
    };

export function ok<T>(source: SourceId, data: T): SourceResult<T> {
  return {
    status: "ok",
    source,
    fetchedAt: new Date().toISOString(),
    data,
  };
}

export function unavailable<T = never>(
  source: SourceId,
  reason: UnavailableReason,
  detail?: string,
): SourceResult<T> {
  return { status: "unavailable", source, reason, detail };
}

export const CoordinateSchema = z.object({
  epsg25832: z.object({
    x: z.number(),
    y: z.number(),
  }),
  wgs84: z.object({
    lat: z.number(),
    lon: z.number(),
  }),
});
export type Coordinate = z.infer<typeof CoordinateSchema>;

export const AddressMatchSchema = z.object({
  addressId: z.string().optional(),
  accessAddressId: z.string().optional(),
  houseNumberId: z.string().optional(),
  designation: z.string(),
  streetName: z.string().optional(),
  houseNumber: z.string().optional(),
  floor: z.string().nullable().optional(),
  door: z.string().nullable().optional(),
  postalCode: z.string().optional(),
  postalName: z.string().optional(),
  municipalityCode: z.string().optional(),
  type: z.enum(["address", "house_number", "street", "other"]),
  coordinate: CoordinateSchema.optional(),
});
export type AddressMatch = z.infer<typeof AddressMatchSchema>;

export const PropertyIdsSchema = z.object({
  addressId: z.string().optional(),
  accessAddressId: z.string().optional(),
  houseNumberId: z.string().optional(),
  designation: z.string().optional(),
  bfe: z.string().optional(),
  mainBfe: z.string().optional(),
  isCondominium: z.boolean().optional(),
  cadastralDistrictCode: z.string().optional(),
  cadastralNumber: z.string().optional(),
  coordinate: CoordinateSchema.optional(),
});
export type PropertyIds = z.infer<typeof PropertyIdsSchema>;

export const FloorSchema = z.object({
  designation: z.string().optional(),
  typeCode: z.string().optional(),
  type: z.string().optional(),
  totalArea: z.number().nullable().optional(),
  usedAtticArea: z.number().nullable().optional(),
  basementArea: z.number().nullable().optional(),
  legalBasementDwellingArea: z.number().nullable().optional(),
});
export type Floor = z.infer<typeof FloorSchema>;

export const BuildingSchema = z.object({
  buildingId: z.string().optional(),
  bfe: z.string().optional(),
  usageCode: z.string().optional(),
  usage: z.string().optional(),
  constructionYear: z.number().nullable().optional(),
  reconstructionYear: z.number().nullable().optional(),
  builtArea: z.number().nullable().optional(),
  totalArea: z.number().nullable().optional(),
  floors: z.number().nullable().optional(),
  roofMaterialCode: z.string().optional(),
  roofMaterial: z.string().optional(),
  outerWallCode: z.string().optional(),
  outerWall: z.string().optional(),
  heatingCode: z.string().optional(),
  heating: z.string().optional(),
  heatingFuelCode: z.string().optional(),
  heatingFuel: z.string().optional(),
  supplementaryHeatCode: z.string().optional(),
  supplementaryHeat: z.string().optional(),
  dwellingArea: z.number().nullable().optional(),
  commercialArea: z.number().nullable().optional(),
  asbestosCode: z.string().optional(),
  asbestos: z.string().optional(),
  listingCode: z.string().optional(),
  listing: z.string().optional(),
  floodCompensationCode: z.string().optional(),
  floodCompensation: z.string().optional(),
  lastRevised: z.string().optional(),
  coordinate: CoordinateSchema.optional(),
  floorDetails: z.array(FloorSchema).optional(),
});
export type Building = z.infer<typeof BuildingSchema>;


export const GroundSchema = z.object({
  groundId: z.string().optional(),
  waterSupplyCode: z.string().optional(),
  waterSupply: z.string().optional(),
  drainageCode: z.string().optional(),
  drainage: z.string().optional(),
});
export type Ground = z.infer<typeof GroundSchema>;

export const UnitSchema = z.object({
  unitId: z.string().optional(),
  buildingId: z.string().optional(),
  addressId: z.string().optional(),
  dwellingArea: z.number().nullable().optional(),
  rooms: z.number().nullable().optional(),
  kitchen: z.boolean().nullable().optional(),
  toilet: z.boolean().nullable().optional(),
  bathroom: z.boolean().nullable().optional(),
  usage: z.string().optional(),
  usageCode: z.string().optional(),
  housingTypeCode: z.string().optional(),
  housingType: z.string().optional(),
  residentialArea: z.number().nullable().optional(),
  commercialArea: z.number().nullable().optional(),
  tenureCode: z.string().optional(),
  tenure: z.string().optional(),
  toiletCode: z.string().optional(),
  toilets: z.string().optional(),
  bathCode: z.string().optional(),
  bath: z.string().optional(),
  kitchenCode: z.string().optional(),
  kitchenType: z.string().optional(),
  toiletCount: z.number().nullable().optional(),
  bathroomCount: z.number().nullable().optional(),
});
export type Unit = z.infer<typeof UnitSchema>;

export const ParcelSchema = z.object({
  cadastralDistrictCode: z.string().optional(),
  cadastralDistrictName: z.string().optional(),
  cadastralNumber: z.string().optional(),
  bfe: z.string().optional(),
  registeredArea: z.number().nullable().optional(),
  municipalityCode: z.string().optional(),
  /** Cadastral theme areas on the parcel, e.g. Fredskov, Strandbeskyttelse, Klitfredning. */
  notes: z.array(z.string()).optional(),
});
export type Parcel = z.infer<typeof ParcelSchema>;

export const ValuationEntrySchema = z.object({
  year: z.number().optional(),
  propertyValue: z.number().nullable().optional(),
  landValue: z.number().nullable().optional(),
  system: z.enum(["new", "old"]).optional(),
  valuedArea: z.number().nullable().optional(),
  category: z.string().optional(),
  changedOn: z.string().optional(),
});
export type ValuationEntry = z.infer<typeof ValuationEntrySchema>;

export const ValuationSchema = z.object({
  bfe: z.string().optional(),
  latest: ValuationEntrySchema.optional(),
  latestNew: ValuationEntrySchema.optional(),
  latestOld: ValuationEntrySchema.optional(),
  history: z.array(ValuationEntrySchema).default([]),
});
export type Valuation = z.infer<typeof ValuationSchema>;

/** A recorded sale. Never carries buyer or seller identities. */
export const TradeSchema = z.object({
  bfe: z.string().optional(),
  /** Takeover date (overtagelsesdato). */
  date: z.string().optional(),
  agreementDate: z.string().optional(),
  /** Total purchase price (samletKoebesum). */
  price: z.number().nullable().optional(),
  cashPrice: z.number().nullable().optional(),
  movablesAmount: z.number().nullable().optional(),
  contractorAmount: z.number().nullable().optional(),
  buildingsIncluded: z.boolean().nullable().optional(),
  currency: z.string().optional(),
  transferType: z.string().optional(),
  attribution: z.string().optional(),
});
export type Trade = z.infer<typeof TradeSchema>;

export const AdminAreasSchema = z.object({
  municipalityCode: z.string().optional(),
  municipalityName: z.string().optional(),
  regionCode: z.string().optional(),
  regionName: z.string().optional(),
  parishCode: z.string().optional(),
  parishName: z.string().optional(),
  postalCode: z.string().optional(),
  postalName: z.string().optional(),
  /** Statistics Denmark's landsdel (NUTS 3), e.g. "Vestjylland". */
  landsdelName: z.string().optional(),
  courtDistrict: z.string().optional(),
  policeDistrict: z.string().optional(),
  constituency: z.string().optional(),
});
export type AdminAreas = z.infer<typeof AdminAreasSchema>;

/** One building from Slots- og Kulturstyrelsens FBB. SAVE 1 is the highest value. */
export const HeritageBuildingSchema = z.object({
  address: z.string().optional(),
  saveValue: z.number().int().optional(),
  listed: z.boolean().optional(),
  listingStatus: z.number().int().optional(),
});
export type HeritageBuilding = z.infer<typeof HeritageBuildingSchema>;

export const HeritageInfoSchema = z.object({
  items: z.array(HeritageBuildingSchema),
});
export type HeritageInfo = z.infer<typeof HeritageInfoSchema>;

export const PlanItemSchema = z.object({
  planId: z.string().optional(),
  name: z.string().optional(),
  type: z.enum([
    "local_plan",
    "local_plan_subarea",
    "municipal_framework",
    "zone",
    "local_plan_proposal",
    "municipal_framework_proposal",
  ]),
  status: z.string().optional(),
  usage: z.string().optional(),
  zoneStatus: z.string().optional(),
  pdfUrl: z.string().optional(),
  municipalityName: z.string().optional(),
  planNumber: z.string().optional(),
  adoptedOn: z.string().optional(),
  proposedOn: z.string().optional(),
  consultationEndsOn: z.string().optional(),
  maxPlotRatioPct: z.number().nullable().optional(),
  maxFloors: z.number().nullable().optional(),
  maxHeightM: z.number().nullable().optional(),
  specificUsages: z
    .array(
      z.object({
        code: z.number().optional(),
        label: z.string().optional(),
        maxPlotRatioPct: z.number().nullable().optional(),
        maxFloors: z.number().nullable().optional(),
        maxHeightM: z.number().nullable().optional(),
      }),
    )
    .optional(),
  buildingNotes: z.string().optional(),
  notes: z.string().optional(),
  /** Set on `nearby` plans: they lie within this many metres but do not cover the point. */
  withinM: z.number().optional(),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

export const PlanInfoSchema = z.object({
  items: z.array(PlanItemSchema),
  /** Plans within ~40 m that do not cover the lookup point. */
  nearby: z.array(PlanItemSchema).optional(),
  lookupPoint: z.enum(["building", "address"]).optional(),
});
export type PlanInfo = z.infer<typeof PlanInfoSchema>;

export const EnvironmentItemSchema = z.object({
  category: z.enum([
    "soil_v1",
    "soil_v2",
    "section3_nature",
    "conservation",
    "coastal_protection",
    "forest_building_line",
  ]),
  name: z.string().optional(),
  status: z.string().optional(),
  localityNumber: z.string().optional(),
  details: z.string().optional(),
  address: z.string().optional(),
  cadastralDistrictCode: z.string().optional(),
  cadastralNumbers: z.array(z.string()).optional(),
  /** True when the lookup point lies inside the polygon or the locality lists the property's parcel. */
  onProperty: z.boolean().optional(),
});
export type EnvironmentItem = z.infer<typeof EnvironmentItemSchema>;

export const EnvironmentInfoSchema = z.object({
  items: z.array(EnvironmentItemSchema),
});
export type EnvironmentInfo = z.infer<typeof EnvironmentInfoSchema>;

export const SiteConditionSchema = z.object({
  category: z.enum([
    "heat_supply_area",
    "heat_plan_area",
    "connection_obligation",
    "sewer_catchment",
    "wastewater_plan",
    "flood_or_erosion_risk",
    "near_surface_groundwater",
    "low_lying_land",
    "noise_affected_area",
    "large_livestock_farm_area",
    "planned_road_or_rail",
    "planned_technical_facility",
    "technical_facility_buffer",
    "transformation_area",
    "cultural_heritage_value",
    "valuable_cultural_environment",
  ]),
  label: z.string(),
  value: z.string().optional(),
  details: z.string().optional(),
  pdfUrl: z.string().optional(),
});
export type SiteCondition = z.infer<typeof SiteConditionSchema>;

export const SiteConditionsSchema = z.object({
  items: z.array(SiteConditionSchema),
  checkedLayers: z.number(),
  failedLayers: z.array(z.string()),
  lookupPoint: z.enum(["building", "address"]).optional(),
});
export type SiteConditions = z.infer<typeof SiteConditionsSchema>;

export const NearbyServiceSchema = z.object({
  category: z.enum(["school", "daycare", "retail", "health", "sports"]),
  label: z.string(),
  /** Straight-line distance to the nearest such building, not walking distance. */
  nearestM: z.number().nullable(),
  within1km: z.number(),
});
export type NearbyService = z.infer<typeof NearbyServiceSchema>;

export const NearbyServicesSchema = z.object({
  radiusM: z.number(),
  items: z.array(NearbyServiceSchema),
  truncated: z.boolean(),
});
export type NearbyServices = z.infer<typeof NearbyServicesSchema>;

export const FootprintSchema = z.object({
  buildingId: z.string(),
  /** Area of the photogrammetric outline (measured at the roof/eaves), in m². */
  footprintM2: z.number(),
  bbrBuiltAreaM2: z.number().nullable().optional(),
  /** Measured minus registered, in m². Positive means larger on the map than in BBR. */
  differenceM2: z.number().nullable().optional(),
  measuredAt: z.string().optional(),
});
export type Footprint = z.infer<typeof FootprintSchema>;

export const TerrainInfoSchema = z.object({
  /** Heights are metres in DVR90, Denmark's vertical datum (close to mean sea level). */
  datum: z.literal("DVR90"),
  lookupPoint: z.enum(["building", "address"]).optional(),
  terrainM: z.number(),
  /** Highest surface (roof, trees) within a few metres of the lookup point. */
  surfaceMaxM: z.number().optional(),
  heightAboveTerrainM: z.number().optional(),
  surroundings: z.object({
    radiusM: z.number(),
    medianM: z.number(),
    p10M: z.number(),
    minM: z.number(),
    maxM: z.number(),
  }),
  /** Negative when the point lies below the surrounding median terrain. */
  relativeToSurroundingsM: z.number(),
});
export type TerrainInfo = z.infer<typeof TerrainInfoSchema>;

export const FlagSchema = z.object({
  id: z.string(),
  severity: z.enum(["high", "medium", "info"]),
  title: z.string(),
  detail: z.string(),
  sources: z.array(z.string()),
});
export type Flag = z.infer<typeof FlagSchema>;

export const EnergyLabelSchema = z.object({
  rating: z.string().optional(),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  reportUrl: z.string().optional(),
  improvements: z.array(z.string()).default([]),
  sharedLabel: z.boolean().optional(),
});
export type EnergyLabel = z.infer<typeof EnergyLabelSchema>;

export const AreaStatSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.union([z.number(), z.string(), z.null()]),
  unit: z.string().optional(),
  table: z.string().optional(),
});
export type AreaStat = z.infer<typeof AreaStatSchema>;

export const AreaStatsSchema = z.object({
  municipalityCode: z.string().optional(),
  municipalityName: z.string().optional(),
  stats: z.array(AreaStatSchema),
});
export type AreaStats = z.infer<typeof AreaStatsSchema>;

export const SourceStatusSchema = z.object({
  id: SourceIdSchema,
  name: z.string(),
  tier: z.enum(["T0", "T1", "T2", "T3", "X"]),
  configured: z.boolean(),
  envKeys: z.array(z.string()),
  missingEnv: z.array(z.string()),
  docsUrl: z.string().optional(),
  ttlSeconds: z.number(),
  credentialSource: z.enum(["env", "credentials_file"]).optional(),
  setup: z.string().optional(),
});
export type SourceStatus = z.infer<typeof SourceStatusSchema>;
