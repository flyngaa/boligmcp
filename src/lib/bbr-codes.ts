const USAGE: Record<string, string> = {
  "110": "Stuehus til landbrugsejendom",
  "120": "Fritliggende enfamiliehus",
  "121": "Sammenbygget enfamiliehus",
  "122": "Fritliggende enfamiliehus i tæt-lav bebyggelse",
  "130": "Række-, kæde- eller dobbelthus",
  "131": "Række-, kæde- eller dobbelthus (lodret adskillelse)",
  "132": "Række-, kæde- eller dobbelthus (vandret adskillelse)",
  "140": "Etageboligbebyggelse",
  "150": "Kollegium",
  "160": "Døgninstitution",
  "190": "Anden bygning til helårsbeboelse",
  "210": "Bygning til erhvervsmæssig produktion vedrørende landbrug",
  "310": "Transport- og garageanlæg",
  "320": "Bygning til kontor, handel, lager, herunder offentlig administration",
  "330": "Hotel, restaurant, konferencecenter",
  "510": "Sommerhus",
};

const ROOF: Record<string, string> = {
  "1": "Built-up roof",
  "2": "Tagpap with gravel",
  "3": "Tagpap without gravel",
  "4": "Cement tile",
  "5": "Clay tile",
  "6": "Fibre cement",
  "7": "Cement stone",
  "10": "Metal",
  "11": "Thatch",
  "12": "Plastic",
  "20": "Other",
};

const WALL: Record<string, string> = {
  "1": "Brick",
  "2": "Lightweight concrete",
  "3": "Prefabricated concrete",
  "4": "Timber",
  "5": "Half-timbered",
  "6": "Fibre cement",
  "8": "Metal",
  "10": "Wood",
  "80": "Other",
};

const HEATING: Record<string, string> = {
  "1": "District heating",
  "2": "Central heating from own boiler",
  "3": "Electric heating",
  "5": "Heat pump",
  "6": "Stove / fireplace",
  "7": "None",
  "9": "Other",
};

const FUEL: Record<string, string> = {
  "1": "Gas",
  "2": "Fuel oil",
  "3": "Electricity",
  "4": "Solid fuel",
  "6": "Straw",
  "7": "Natural gas",
  "9": "Other",
};

const OWNERSHIP: Record<string, string> = {
  "10": "Private individual",
  "20": "Company / A/S / ApS",
  "30": "Housing association / andelsbolig",
  "40": "Public limited housing",
  "50": "Municipality",
  "60": "Region",
  "70": "State",
  "80": "Other public",
  "90": "Other",
};

function lookup(table: Record<string, string>, code: string | undefined): string | undefined {
  if (!code) return undefined;
  return table[code] ?? table[String(Number(code))] ?? `Code ${code}`;
}

export function bbrUsage(code?: string): string | undefined {
  return lookup(USAGE, code);
}

export function bbrRoof(code?: string): string | undefined {
  return lookup(ROOF, code);
}

export function bbrWall(code?: string): string | undefined {
  return lookup(WALL, code);
}

export function bbrHeating(code?: string): string | undefined {
  return lookup(HEATING, code);
}

export function bbrFuel(code?: string): string | undefined {
  return lookup(FUEL, code);
}

export function ownershipLabel(code?: string): string | undefined {
  return lookup(OWNERSHIP, code);
}
