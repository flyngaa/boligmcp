import { BBR_CODELISTS, type BbrCodelistName } from "./bbr-codelists.js";

// The official text for code 3 is a sentence about the register, not a label.
const OVERRIDES: Partial<Record<BbrCodelistName, Record<string, string>>> = {
  Oversvoemmelsesselvrisiko: {
    "3": "Der er udbetalt erstatning fra Naturskaderådet (stormflod, oversvømmelse eller tørke)",
  },
};

export function bbrLabel(list: BbrCodelistName, code: string | undefined): string | undefined {
  if (!code) return undefined;
  const table = BBR_CODELISTS[list] as Record<string, string>;
  const key = table[code] !== undefined ? code : String(Number(code));
  const label = OVERRIDES[list]?.[key] ?? table[key];
  // "(UDFASES)" marks codes that are still valid but no longer used for new registrations.
  return label ? label.replace(/^\(UDFASES\)\s*/, "") : `Ukendt kode ${code}`;
}

export const bbrUsage = (code?: string) => bbrLabel("BygAnvendelse", code);
export const bbrUnitUsage = (code?: string) => bbrLabel("EnhAnvendelse", code);
export const bbrRoof = (code?: string) => bbrLabel("Tagdaekningsmateriale", code);
export const bbrWall = (code?: string) => bbrLabel("YdervaeggenesMateriale", code);
export const bbrHeating = (code?: string) => bbrLabel("BygVarmeinstallation", code);
export const bbrFuel = (code?: string) => bbrLabel("Opvarmningsmiddel", code);
export const bbrSupplementaryHeat = (code?: string) => bbrLabel("BygSupplerendeVarme", code);
export const bbrAsbestos = (code?: string) => bbrLabel("AsbestholdigtMateriale", code);
export const bbrListing = (code?: string) => bbrLabel("Fredning", code);
export const bbrFloodCompensation = (code?: string) => bbrLabel("Oversvoemmelsesselvrisiko", code);
export const bbrHousingType = (code?: string) => bbrLabel("Boligtype", code);
export const bbrTenure = (code?: string) => bbrLabel("Udlejningsforhold", code);
export const bbrToilet = (code?: string) => bbrLabel("Toiletforhold", code);
export const bbrBath = (code?: string) => bbrLabel("Badeforhold", code);
export const bbrKitchen = (code?: string) => bbrLabel("Koekkenforhold", code);
export const bbrFloorType = (code?: string) => bbrLabel("EtageType", code);
export const bbrDrainage = (code?: string) => bbrLabel("GruAfloebsforhold", code);
export const bbrWaterSupply = (code?: string) => bbrLabel("GruVandforsyning", code);
export const ownershipLabel = (code?: string) => bbrLabel("Ejerforholdskode", code);

/** Roof or wall codes whose official label says the material may contain asbestos. */
export const ASBESTOS_MATERIAL_CODES = new Set(["3"]);

/** Usage codes for garages, carports, sheds and other outbuildings (9xx). */
export function isOutbuilding(usageCode?: string): boolean {
  return Boolean(usageCode && /^9\d\d$/.test(usageCode));
}
