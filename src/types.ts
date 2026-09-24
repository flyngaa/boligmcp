import { z } from "zod";

export const SourceIdSchema = z.enum([
  "adressevaelger",
  "dar",
  "matrikel",
  "bbr",
  "dagi",
  "vur",
  "ejf",
  "plandata",
  "miljoportal",
  "dst",
  "emodata",
  "dataforsyningen",
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
});
export type Building = z.infer<typeof BuildingSchema>;

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
});
export type Unit = z.infer<typeof UnitSchema>;

export const ParcelSchema = z.object({
  cadastralDistrictCode: z.string().optional(),
  cadastralDistrictName: z.string().optional(),
  cadastralNumber: z.string().optional(),
  bfe: z.string().optional(),
  registeredArea: z.number().nullable().optional(),
  municipalityCode: z.string().optional(),
});
export type Parcel = z.infer<typeof ParcelSchema>;

export const ValuationEntrySchema = z.object({
  year: z.number().optional(),
  propertyValue: z.number().nullable().optional(),
  landValue: z.number().nullable().optional(),
});
export type ValuationEntry = z.infer<typeof ValuationEntrySchema>;

export const ValuationSchema = z.object({
  bfe: z.string().optional(),
  latest: ValuationEntrySchema.optional(),
  history: z.array(ValuationEntrySchema).default([]),
});
export type Valuation = z.infer<typeof ValuationSchema>;

export const TradeSchema = z.object({
  bfe: z.string().optional(),
  date: z.string().optional(),
  price: z.number().nullable().optional(),
  transferType: z.string().optional(),
  ownershipCode: z.string().optional(),
  ownership: z.string().optional(),
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
  courtDistrict: z.string().optional(),
  policeDistrict: z.string().optional(),
  constituency: z.string().optional(),
});
export type AdminAreas = z.infer<typeof AdminAreasSchema>;

export const PlanItemSchema = z.object({
  planId: z.string().optional(),
  name: z.string().optional(),
  type: z.enum(["local_plan", "municipal_framework", "zone"]),
  status: z.string().optional(),
  usage: z.string().optional(),
  zoneStatus: z.string().optional(),
  pdfUrl: z.string().optional(),
  municipalityName: z.string().optional(),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

export const PlanInfoSchema = z.object({
  items: z.array(PlanItemSchema),
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
});
export type EnvironmentItem = z.infer<typeof EnvironmentItemSchema>;

export const EnvironmentInfoSchema = z.object({
  items: z.array(EnvironmentItemSchema),
});
export type EnvironmentInfo = z.infer<typeof EnvironmentInfoSchema>;

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
});
export type SourceStatus = z.infer<typeof SourceStatusSchema>;
