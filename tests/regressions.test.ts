import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFlags } from "../src/analysis/flags.js";
import { resetConfigForTests } from "../src/config.js";
import { safeUrl } from "../src/lib/http.js";
import { repairMojibake } from "../src/lib/text.js";
import { looksForeign, matchWarning, normalizeId } from "../src/resolve.js";
import { marketCategoryFor } from "../src/sources/dst.js";
import { cleanQuery, danishSpelling, mapSearchHit, parseDesignation, rerank, spellingVariants } from "../src/sources/adressevaelger.js";
import { graphqlLiteral } from "../src/sources/datafordeler/client.js";
import { mapValuationRows, realDate, sortBuildings } from "../src/sources/datafordeler/registers.js";
import { markAtProperty } from "../src/sources/fbb.js";
import * as report from "../src/tools/property-report.js";
import { listWatchlist, watchProperty } from "../src/tools/watch.js";
import type { AddressMatch, Building } from "../src/types.js";

afterEach(() => {
  resetConfigForTests(undefined);
  delete process.env.BOLIGMCP_WATCHLIST_FILE;
  vi.restoreAllMocks();
});

const hit = (designation: string, type: AddressMatch["type"] = "address"): AddressMatch => ({
  ...parseDesignation(designation),
  designation,
  type,
  floor: parseDesignation(designation).floor ?? null,
});

describe("address search", () => {
  it("reads floor, door and postcode from the designation, since the API sends only the title", () => {
    expect(parseDesignation("Istedgade 50, 3. th, 1650 København V")).toMatchObject({
      street: "Istedgade",
      houseNumber: "50",
      floor: "3",
      door: "th",
      postalCode: "1650",
      postalName: "København V",
    });
    expect(parseDesignation("Egeskovvej 41, Hald Ege, 8800 Viborg")).toEqual({
      street: "Egeskovvej",
      houseNumber: "41",
      locality: "Hald Ege",
      postalCode: "8800",
      postalName: "Viborg",
    });
    expect(parseDesignation("Nyhavn 18, kl., 1051 København K").floor).toBe("kl");
    const mapped = mapSearchHit({ type: "adresse", id: "a1", titel: "Istedgade 50, 1., 1650 København V", husnummerId: "h1" });
    expect(mapped).toMatchObject({ addressId: "a1", houseNumberId: "h1", floor: "1", door: null, houseNumber: "50", postalCode: "1650" });
  });

  it("puts a town named without postcode first", () => {
    const ranked = rerank("Boulevarden 1 Aalborg", [
      hit("Boulevarden 1, Balka, 3730 Nexø"),
      hit("Boulevarden 1, Ø. Kippinge, 4840 Nørre Alslev"),
      hit("Boulevarden 1, 9000 Aalborg", "house_number"),
    ]);
    expect(ranked[0]?.designation).toBe("Boulevarden 1, 9000 Aalborg");
  });

  it("prefers the building's own address over a flat when no floor was asked for", () => {
    const ranked = rerank("Nørrebrogade 1, 2200 København N", [
      hit("Nørrebrogade 1, 1., 2200 København N"),
      hit("Nørrebrogade 1, 2200 København N"),
    ]);
    expect(ranked[0]?.designation).toBe("Nørrebrogade 1, 2200 København N");
  });

  it("respells ASCII Danish and English names, and strips symbols", () => {
    expect(danishSpelling("Noerrebrogade 1, 2200 Koebenhavn N")).toBe("Nørrebrogade 1, 2200 København N");
    expect(danishSpelling("HC Andersens Blvd 2 Copenhagen")).toBe("H.C. Andersens Boulevard 2 København");
    expect(danishSpelling("Boulevarden 1 Aalborg")).toBe("Boulevarden 1 Aalborg");
    expect(cleanQuery("🏠🏠 Nyhavn 18")).toBe("Nyhavn 18");
    // The search answers HTTP 400 above 73 characters; the text is cut at a whole word.
    expect(cleanQuery("a".repeat(3000))).toHaveLength(73);
    expect(cleanQuery(`Egeskovvej 41, 8800 Viborg ${"X".repeat(3000)}`)).toBe("Egeskovvej 41, 8800 Viborg");
  });

  it("keeps a house letter typed apart with its number, and takes the number first as in English", () => {
    expect(cleanQuery("Egeskovvej 41 A, 8800 Viborg")).toBe("Egeskovvej 41A, 8800 Viborg");
    expect(cleanQuery("Nyhavn 18 a")).toBe("Nyhavn 18a");
    expect(cleanQuery("Hovedgaden 1 A 2 th")).toBe("Hovedgaden 1A 2 th");
    expect(cleanQuery("Istedgade 60 2 TV 1650")).toBe("Istedgade 60 2 TV 1650");
    expect(cleanQuery("41 Egeskovvej, 8800 Viborg")).toBe("Egeskovvej 41, 8800 Viborg");
    expect(cleanQuery("8800 Viborg")).toBe("8800 Viborg");
  });
});

describe("address resolution", () => {
  it("normalises pasted ids", () => {
    expect(normalizeId(" 0A3F50C6-588F-32B8-E044-0003BA298018 ")).toBe("0a3f50c6-588f-32b8-e044-0003ba298018");
    expect(normalizeId("  ")).toBeUndefined();
  });

  it("warns when the floor, door or town is not the one asked for", () => {
    expect(matchWarning("Istedgade 50, 3. th, 1650 København V", "Istedgade 50, st., 1650 København V")).toMatch(
      /etage 3 findes ikke, fandt st; dør th findes ikke/,
    );
    expect(matchWarning("Rådhuspladsen 1", "Rådhuspladsen 1, 1550 København V", [
      hit("Rådhuspladsen 1, 1550 København V", "house_number"),
      hit("Rådhuspladsen 1, 3300 Frederiksværk"),
    ])).toMatch(/3300 Frederiksværk/);
    expect(matchWarning("Strandvejen 100 hellerup", "Strandvejen 100, 2900 Hellerup", [
      hit("Strandvejen 100, 2900 Hellerup", "house_number"),
      hit("Strandvejen 100, 3300 Frederiksværk"),
    ])).toBeUndefined();
    expect(matchWarning("Egeskovvej 41, 8800 Viborg", "Egeskovvej 41, Hald Ege, 8800 Viborg")).toBeUndefined();
  });

  it("warns when the postcode and the town asked for disagree", () => {
    expect(matchWarning("Egeskovvej 41, 8800 Aarhus", "Egeskovvej 41, Hald Ege, 8800 Viborg")).toMatch(/8800 er Viborg, ikke Aarhus/);
    expect(matchWarning("Nyhavn 18, 1051 Kbh K", "Nyhavn 18, 1051 København K")).toBeUndefined();
    expect(matchWarning("Slotsgaden 5, 6270 Møgeltønder", "Slotsgaden 5, Møgeltønder, 6270 Tønder")).toBeUndefined();
    expect(matchWarning("Frederiksberg Allé 10, 1820 Frederiksb", "Frederiksberg Alle 10, 1820 Frederiksberg C")).toBeUndefined();
    // "oe" is part of the real name here, not ASCII for "ø".
    expect(matchWarning("Baunehøjvej 2, 4242 Boeslunde", "Baunehøjvej 2, 4242 Boeslunde")).toBeUndefined();
    expect(matchWarning("Torvet 1 Boeslunde", "Torvet 1, 4242 Boeslunde")).toBeUndefined();
    expect(matchWarning("Nørrebrogade 1 Koebenhavn N", "Nørrebrogade 1, 2200 København N")).toBeUndefined();
  });

  it("warns about a house letter typed apart that does not exist", () => {
    expect(matchWarning("Egeskovvej 41 A, 8800 Viborg", "Egeskovvej 41, Hald Ege, 8800 Viborg")).toMatch(/husnummer 41A blev til 41/);
  });
});

describe("GraphQL filters", () => {
  it("escapes values so input cannot break out of a string", () => {
    expect(graphqlLiteral({ BFEnummer: { eq: 6033799 } })).toBe("{ BFEnummer: { eq: 6033799 } }");
    expect(graphqlLiteral({ id_lokalId: { eq: 'x": 1} OR {a: "' } })).toBe('{ id_lokalId: { eq: "x\\": 1} OR {a: \\"" } }');
    expect(() => graphqlLiteral({ "bad key": 1 })).toThrow(/field name/);
    expect(() => graphqlLiteral({ BFEnummer: { eq: Number.NaN } })).toThrow(/Invalid number/);
  });

  it("keeps tokens and user input out of error messages", () => {
    expect(safeUrl("https://adressevaelger.dk/adresser/soeg?tekst=aaa&token=secret")).toBe("https://adressevaelger.dk/adresser/soeg");
  });
});

describe("valuation", () => {
  it("adds up a property valued in parts in the same year", () => {
    // Egeskov Gade 18: the estate and a small part are valued separately.
    const valuation = mapValuationRows("9519007", [
      { id: 965000000000001, aar: 2020, ejendomvaerdiBeloeb: 73000000, grundvaerdiBeloeb: 21567700, vurderetAreal: 4830678 },
      { id: 965000000000002, aar: 2020, ejendomvaerdiBeloeb: 120700, grundvaerdiBeloeb: 120700, vurderetAreal: 33832 },
    ]);
    expect(valuation.latest).toMatchObject({ year: 2020, propertyValue: 73120700, landValue: 21688400, valuedArea: 4864510, parts: 2 });
  });

  it("keeps the newest correction for the same valued area", () => {
    const valuation = mapValuationRows("1", [
      { id: 965000000000001, aar: 2020, ejendomvaerdiBeloeb: 1000000, grundvaerdiBeloeb: 200000, vurderetAreal: 800, aendringDato: "2020-10-01" },
      { id: 965000000000002, aar: 2020, ejendomvaerdiBeloeb: 1100000, grundvaerdiBeloeb: 200000, vurderetAreal: 800, aendringDato: "2021-03-01" },
    ]);
    expect(valuation.latest).toMatchObject({ propertyValue: 1100000 });
    expect(valuation.latest?.parts).toBeUndefined();
  });

  it("explains a newer zero valuation instead of skipping it silently", () => {
    const valuation = mapValuationRows("10229320", [
      { id: 965000000000001, aar: 2020, ejendomvaerdiBeloeb: 0, grundvaerdiBeloeb: 0, vurderetAreal: 1640 },
      { id: 965000000000002, aar: 2007, ejendomvaerdiBeloeb: 1500000, grundvaerdiBeloeb: 66200, vurderetAreal: 740 },
    ]);
    expect(valuation.latest?.year).toBe(2007);
    expect(valuation.note).toMatch(/2020 er 0 kr/);
  });
});

describe("sales", () => {
  it("drops EJF's epoch placeholder dates", () => {
    expect(realDate("1969-12-31T23:00:00Z")).toBeUndefined();
    expect(realDate("1970-01-01")).toBeUndefined();
    expect(realDate("2019-03-15T00:00:00Z")).toBe("2019-03-15");
  });

  it("takes the latest priced sale, not an unpriced transfer", () => {
    const sale = report.lastSale([
      { bfe: "1", date: "2023-10-31", price: null, transferType: "Ikke oplyst" },
      { bfe: "1", date: "2008-01-14", price: 3500000, transferType: "Almindelig fri handel" },
    ]);
    expect(sale).toMatchObject({ date: "2008-01-14", price: 3500000 });
  });
});

describe("main building", () => {
  const building = (usageCode: string, totalArea: number, extra: Partial<Building> = {}): Building => ({ usageCode, totalArea, ...extra });

  it("puts the dwelling before a larger barn, and the largest dwelling first", () => {
    const sorted = sortBuildings([building("219", 929), building("920", 42), building("120", 460), building("310", 1864)]);
    expect(sorted.map((b) => b.usageCode)).toEqual(["120", "310", "219", "920"]);
  });

  it("prefers the building at the address among equals", () => {
    const sorted = sortBuildings([building("140", 900, { houseNumberId: "other" }), building("140", 800, { houseNumberId: "mine" })], "mine");
    expect(sorted[0]?.houseNumberId).toBe("mine");
  });
});

describe("flags", () => {
  const framework = { type: "municipal_framework" as const, maxPlotRatioPct: 40 };

  it("does not invent building rights when BBR has no floor areas", () => {
    const flags = buildFlags({
      buildings: [{ usageCode: undefined, totalArea: null, builtArea: null }],
      parcels: [{ registeredArea: 664 }],
      plans: { items: [framework], nearby: [] },
    });
    expect(flags.find((flag) => flag.id === "building_rights")).toBeUndefined();
  });

  it("ignores neighbouring listed buildings", () => {
    const heritage = markAtProperty(
      [
        { address: "Nyhavn 18", saveValue: 1, listed: true },
        { address: "Nyhavn 20", listed: true },
      ],
      ["Nyhavn 18A, 1051 København K"],
    );
    expect(heritage.map((item) => item.atProperty)).toEqual([true, false]);
    const flags = buildFlags({ heritage: { items: heritage } });
    expect(flags.find((flag) => flag.id === "listed_building")?.detail).toBe("Nyhavn 18");
  });

  it("does not count neighbours in a town when FBB has no entry for the property's address", () => {
    // Slotsgaden 5, Møgeltønder: the listed houses around it are not the property.
    const items = markAtProperty(
      [
        { address: "Slotsgaden 8", listed: true, point: { x: 480010, y: 6093010 } } as never,
        { address: "Slotsgaden 6A", listed: true, point: { x: 480005, y: 6092995 } } as never,
      ],
      ["Slotsgaden 5, Møgeltønder, 6270 Tønder"],
      [{ x: 480000, y: 6093000 }],
    );
    expect(items.map((item) => item.atProperty)).toEqual([false, false]);
  });

  it("leaves heritage unmarked only when nothing is known about the property", () => {
    expect(markAtProperty([{ address: "Nyhavn 20", listed: true }], [])[0]?.atProperty).toBeUndefined();
  });
});

describe("plan texts", () => {
  it("repairs double-encoded UTF-8 and leaves correct text alone", () => {
    expect(repairMojibake("OmrÃ¥de til centerformÃ¥l i SÃ¸ndervig")).toBe("Område til centerformål i Søndervig");
    expect(repairMojibake("Ringkøbing-Skjern")).toBe("Ringkøbing-Skjern");
  });
});

describe("report for an address that does not exist", () => {
  it("returns no summary numbers and no false credential hint", () => {
    resetConfigForTests({ adressevaelgerToken: "t", cachePath: ":memory:", datafordelerApiKey: "key" });
    const data: report.PropertyData = {
      idsResult: { status: "unavailable", source: "adressevaelger", reason: "not_found", detail: "No matches" },
    };
    expect(report.summarize(data)).toEqual({});
    expect(report.missingSources(data).map((item) => item.source)).toEqual(["adressevaelger"]);
  });
});

describe("watchlist file", () => {
  const collected = () =>
    vi.spyOn(report, "collectPropertyData").mockImplementation(async () => ({
      idsResult: { status: "ok", source: "dar", fetchedAt: "", data: { bfe: "3451459", designation: "Egeskovvej 41, 8800 Viborg" } },
      ids: { bfe: "3451459", designation: "Egeskovvej 41, 8800 Viborg" },
    }));

  it("never overwrites a file it cannot read", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "boligmcp-watch-")), "watchlist.json");
    process.env.BOLIGMCP_WATCHLIST_FILE = path;
    writeFileSync(path, '{"entries": [ {broken');
    collected();
    expect(await watchProperty("Egeskovvej 41, 8800 Viborg")).toMatchObject({ error: expect.stringMatching(/not valid JSON/) });
    expect(listWatchlist()).toMatchObject({ error: expect.stringMatching(/left untouched/) });
    expect(readFileSync(path, "utf8")).toBe('{"entries": [ {broken');
  });

  it("keeps the baseline when a property is watched again", async () => {
    process.env.BOLIGMCP_WATCHLIST_FILE = join(mkdtempSync(join(tmpdir(), "boligmcp-watch-")), "watchlist.json");
    collected();
    const first = await watchProperty("Egeskovvej 41, 8800 Viborg", "first");
    const again = await watchProperty("Egeskovvej 41, 8800 Viborg");
    expect(again).toMatchObject({ alreadyWatched: true });
    expect("snapshot" in again && "snapshot" in first ? again.snapshot.takenAt : "").toBe("snapshot" in first ? first.snapshot.takenAt : "x");
    expect(listWatchlist()).toEqual([expect.objectContaining({ note: "first" })]);
  });
});

describe("heritage on an estate", () => {
  it("counts a listed building filed under another number when it stands among the property's buildings", () => {
    // Egeskov Gade 18: the castle is filed in FBB as Egeskov Gade 26, ~150 m from the address point.
    const items = markAtProperty(
      [
        { address: "Egeskov Gade 26", listed: true, point: { x: 594901, y: 6115396 } } as never,
        { address: "Egeskov Gade 4", saveValue: 4, point: { x: 594722, y: 6114700 } } as never,
      ],
      ["Egeskov Gade 18, 5772 Kværndrup"],
      [{ x: 594905, y: 6115380 }, { x: 594798, y: 6115492 }, { x: 594650, y: 6115600 }],
    );
    expect(items).toEqual([
      { address: "Egeskov Gade 26", listed: true, atProperty: true },
      { address: "Egeskov Gade 4", saveValue: 4, atProperty: false },
    ]);
  });
});

describe("addresses as people type them", () => {
  it("reads floor and door without commas, 'sal', ranges and a town without postcode", () => {
    expect(parseDesignation("Istedgade 50 3 th")).toMatchObject({ street: "Istedgade", houseNumber: "50", floor: "3", door: "th" });
    expect(parseDesignation("Istedgade 50, 1 sal")).toEqual({ street: "Istedgade", houseNumber: "50", floor: "1" });
    expect(parseDesignation("Egeskovvej 41-43, 8800 Viborg")).toMatchObject({ houseNumber: "41", houseNumberRange: "41-43" });
    expect(parseDesignation("Bassin 7, Aarhus")).toMatchObject({ street: "Bassin", houseNumber: "7", locality: "Aarhus" });
    expect(parseDesignation("Strandvejen 100 hellerup")).toEqual({ street: "Strandvejen", houseNumber: "100", locality: "hellerup" });
    expect(parseDesignation("Nørrebrogade 1, kl. 2, 2200 København N")).toMatchObject({ floor: "kl", door: "2", postalCode: "2200" });
  });

  it("warns about another street, a town not found and a range", () => {
    expect(matchWarning("Bassin 7, Aarhus", "Bassinvej 7, Bredfjed, 4970 Rødby")).toMatch(/vejnavnet Bassin blev til Bassinvej.*Aarhus blev ikke fundet/);
    expect(matchWarning("Sankt Knuds Torv 1, Odense", "Skt. Knuds Torv 13, 8000 Aarhus C")).toMatch(/husnummer 1 blev til 13; Odense blev ikke fundet/);
    expect(matchWarning("Egeskovvej 41-43, 8800 Viborg", "Egeskovvej 41, Hald Ege, 8800 Viborg")).toMatch(/41-43 er et interval/);
    expect(matchWarning("Istedgade 50 3 th", "Istedgade 50, 1650 København V")).toMatch(/etage 3 findes ikke/);
  });

  it("accepts spelling variants of the same street and town", () => {
    expect(matchWarning("Frederiksberg Allé 10, 1820 Frederiksberg C", "Frederiksberg Alle 10, 1820 Frederiksberg C")).toBeUndefined();
    expect(matchWarning("Skt. Nicolaj Gade 1 Aabenraa", "Skt. Nicolaj Gade 1, 6200 Aabenraa")).toBeUndefined();
    expect(matchWarning("Nyhavn 18 kbh", "Nyhavn 18, 1051 København K")).toBeUndefined();
    expect(matchWarning("Lodbergsvej 10, Søndervig", "Lodbergsvej 10, Søndervig, 6950 Ringkøbing")).toBeUndefined();
    expect(matchWarning("Noerrebrogade 1, 2200 Koebenhavn N", "Nørrebrogade 1, 2200 København N")).toBeUndefined();
  });

  it("keeps 'aa' town names and tries å as a second spelling", () => {
    expect(danishSpelling("Oestergade 1, 9440 Aabybro")).toBe("Østergade 1, 9440 Aabybro");
    expect(spellingVariants("Baadehavnsgade 1")).toEqual(["Bådehavnsgade 1"]);
  });
});

describe("sale and flags on multi-unit properties", () => {
  it("prefers a market sale over a later family transfer", () => {
    expect(
      report.lastSale([
        { bfe: "1", date: "2020-01-01", price: 153000, transferType: "Familieoverdragelse" },
        { bfe: "1", date: "2009-04-29", price: 900000, transferType: "Almindelig fri handel" },
      ]),
    ).toMatchObject({ price: 900000 });
  });

  it("does not divide a whole property's price by one unit's area", () => {
    const flags = buildFlags({
      trades: [{ bfe: "1", date: "2025-09-30", price: 73_476_618, transferType: "Almindelig fri handel" }],
      buildings: [{ usageCode: "590", dwellingArea: null }],
      units: [{ dwellingArea: 64 }, { dwellingArea: 80 }],
    });
    expect(flags.find((flag) => flag.id === "last_sale")?.detail).not.toMatch(/pr\. m²/);
  });

  it("merges area composition into one flag", () => {
    const building = { usageCode: "140", floorDetails: [{ basementArea: 976 }] };
    const flags = buildFlags({ buildings: Array.from({ length: 13 }, () => building) });
    const composition = flags.filter((flag) => flag.id === "area_composition");
    expect(composition).toHaveLength(1);
    expect(composition[0]?.detail).toMatch(/Og 10 bygning\(er\) mere/);
  });

  it("explains a property valued at 0 kr. in every year", () => {
    const valuation = mapValuationRows("100025920", [{ id: 965000000000001, aar: 2020, ejendomvaerdiBeloeb: 0, grundvaerdiBeloeb: 0 }]);
    expect(valuation.note).toMatch(/Alle vurderinger er 0 kr/);
    expect(buildFlags({ valuation }).find((flag) => flag.id === "valuation_zero")).toBeDefined();
  });

  it("does not rank an old valuation as medium for commercial property", () => {
    const valuation = mapValuationRows("1", [{ id: 965000000000001, aar: 2020, ejendomvaerdiBeloeb: 463000000, grundvaerdiBeloeb: 1 }]);
    const flag = buildFlags({ valuation, buildings: [{ usageCode: "420" }] }).find((item) => item.id === "valuation_old_only");
    expect(flag?.severity).toBe("info");
  });
});

describe("round 4", () => {
  it("cleans queries people paste", () => {
    expect(cleanQuery("c/o Hansen, Egeskovvej 41, 8800 Viborg")).toBe("Egeskovvej 41, 8800 Viborg");
    expect(cleanQuery("the house at Nyhavn 18 in Copenhagen")).toBe("Nyhavn 18, Copenhagen");
    expect(cleanQuery("egeskovvej41 viborg")).toBe("egeskovvej 41 viborg");
    expect(cleanQuery("Istedgade 60, 2.tv, 1650 København V")).toBe("Istedgade 60, 2. tv, 1650 København V");
    expect(cleanQuery("H.C. Andersens Boulevard 2")).toBe("H.C. Andersens Boulevard 2");
  });

  it("reads a postcode after a comma, before a town or at the end as a postcode, not a house number", () => {
    expect(parseDesignation("Egeskovvej, 8800 Viborg")).toEqual({ street: "Egeskovvej", postalCode: "8800", postalName: "Viborg" });
    expect(parseDesignation("Skernvej 8000 Aarhus C")).toEqual({ street: "Skernvej", postalCode: "8000", postalName: "Aarhus C" });
    expect(parseDesignation("Vesterhavsvej 12 6960")).toEqual({ street: "Vesterhavsvej", houseNumber: "12", postalCode: "6960" });
  });

  it("recognises addresses outside Denmark", () => {
    for (const query of ["Aqqusinersuaq 1, 3900 Nuuk", "Tinghúsvegur 1, 100 Tórshavn", "Große Straße 1, 24937 Flensburg", "Stortorget 1, 211 22 Malmö"]) {
      expect(looksForeign(query)).toBe(true);
    }
    for (const query of ["Nyhavn 18, 1051 København K", "Istedgade 50, 3. th, 1650 København V", "Nyhavn 180"]) {
      expect(looksForeign(query)).toBe(false);
    }
  });

  it("has no house-price series for commercial and public buildings", () => {
    expect(marketCategoryFor("420")).toBeUndefined();
    expect(marketCategoryFor("320", true)).toBeUndefined();
    expect(marketCategoryFor("120")).toBe("house");
    expect(marketCategoryFor(undefined, true)).toBe("apartment");
    expect(marketCategoryFor("510")).toBe("summer_house");
  });

  it("writes a plan code once, next to a readable text", () => {
    const flags = buildFlags({
      site: {
        items: [
          { category: "noise_affected_area", label: "Støjbelastet areal", value: "23er058" },
          { category: "noise_affected_area", label: "Støjbelastet areal", value: "23er058" },
        ],
        checkedLayers: 1,
        failedLayers: [],
      },
    } as never);
    expect(flags.find((flag) => flag.id === "noise_affected_area")?.detail).toBe("Udpeget i kommuneplanen (støjbelastet areal) [23er058]");
  });

  it("finds an entry added without a BFE again and gives it the BFE", async () => {
    process.env.BOLIGMCP_WATCHLIST_FILE = join(mkdtempSync(join(tmpdir(), "boligmcp-watch-")), "watchlist.json");
    let bfe: string | undefined;
    vi.spyOn(report, "collectPropertyData").mockImplementation(async () => ({
      idsResult: { status: "ok", source: "dar", fetchedAt: "", data: { bfe, addressId: "a1", designation: "Egeskovvej 41, 8800 Viborg" } },
      ids: { bfe, addressId: "a1", designation: "Egeskovvej 41, 8800 Viborg" },
    }));
    await watchProperty("Egeskovvej 41, 8800 Viborg");
    bfe = "3451459";
    expect(await watchProperty("Egeskovvej 41, 8800 Viborg")).toMatchObject({ alreadyWatched: true, id: "3451459" });
    expect(listWatchlist()).toEqual([expect.objectContaining({ id: "3451459" })]);
  });
});
