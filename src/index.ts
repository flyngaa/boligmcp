import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listSourceStatus, SETUP_COMMAND } from "./catalog.js";
import { looksForeign, resolveProperty, suggestionsFor } from "./resolve.js";
import { lookupAddress, searchAddresses } from "./sources/adressevaelger.js";
import {
  getAreaStatsForMunicipality,
  getParishStats,
  getRegionalMarket,
  marketCategoryFor,
} from "./sources/dst.js";
import { getEnergyLabel } from "./sources/emodata.js";
import { getHeritageAt } from "./sources/fbb.js";
import { getEnvironmentAt } from "./sources/miljoportal.js";
import { getPlansAt, getSiteConditionsAt } from "./sources/plandata.js";
import { getTerrainAt } from "./sources/datafordeler/dhm.js";
import { getAerialPhoto } from "./sources/dataforsyningen.js";
import { nearestBuildingId, viewForPoint } from "./sources/google-maps.js";
import { getCompany } from "./sources/datafordeler/cvr.js";
import { getPropertyLocation } from "./sources/datafordeler/ebr.js";
import { getOwners } from "./sources/datafordeler/owners.js";
import {
  getAdminAreasAt,
  getBuildingsAndUnits,
  getParcels,
  getTrades,
  getValuation,
} from "./sources/datafordeler/registers.js";
import { asText } from "./tools/json.js";
import { buildingPoints, buildPropertyReport, lookupPointFor, parcelRefs } from "./tools/property-report.js";
import { SCREEN_MAX_ADDRESSES, screenProperties } from "./tools/screen.js";
import { checkWatchlist, listWatchlist, unwatchProperty, watchProperty } from "./tools/watch.js";
import { getNearbyServices } from "./sources/datafordeler/nearby.js";
import { unavailable, type PropertyIds, type SourceId, type SourceResult } from "./types.js";
import { VERSION } from "./version.js";

/** Models often send the BFE as a number; both are accepted. */
const bfeInput = z
  .preprocess(
    (value) => (typeof value === "number" && Number.isInteger(value) ? String(value) : value),
    z.string().trim().regex(/^\d{1,12}$/, "BFE must be a whole number, e.g. 3451459"),
  )
  .describe("BFE number (bestemt fast ejendom), e.g. 3451459");

/**
 * Every address tool takes the same input: free text, an id from search_address, or a BFE for a property
 * without a street address (a field or forest is then looked up at its parcel).
 */
const addressInput = {
  query: z.string().optional().describe("Free-text Danish address, e.g. \"Egeskovvej 41, 8800 Viborg\""),
  addressId: z
    .string()
    .optional()
    .describe("DAR address id or house-number id (houseNumberId) from search_address or resolve_property"),
  bfe: bfeInput.optional().describe("BFE number, e.g. 3451459; use it for a property without a street address"),
};

async function resolveTarget(input: { query?: string; addressId?: string; bfe?: string }): Promise<SourceResult<PropertyIds>> {
  if (!input.query?.trim() && !input.addressId?.trim() && !input.bfe) {
    return unavailable("adressevaelger", "not_found", "Provide query, addressId or bfe");
  }
  return resolveProperty(input);
}

/** Says which address a result is for, and whether it was an exact match. */
function forAddress<T extends object>(result: T, ids: PropertyIds): T & { address?: string; matchWarning?: string } {
  return { ...result, address: ids.designation, ...(ids.matchWarning ? { matchWarning: ids.matchWarning } : {}) };
}

function buildingsFor(ids: PropertyIds) {
  return getBuildingsAndUnits({ bfe: ids.bfe, addressId: ids.addressId, houseNumberId: ids.houseNumberId, mainBfe: ids.mainBfe });
}

/** Resolves the address and finds the main building's coordinate when BBR has one, else the address point. */
async function locate(input: { query?: string; addressId?: string; bfe?: string }) {
  const resolved = await resolveTarget(input);
  if (resolved.status !== "ok") return { resolved };
  const buildings = await buildingsFor(resolved.data);
  return { resolved, ids: resolved.data, point: lookupPointFor(resolved.data, buildings), buildings };
}

const noPoint = (source: SourceId) => unavailable(source, "not_found", "Could not get coordinates for address");

const INSTRUCTIONS = `Public Danish property data for an address. Start with property_report or screen_properties. property_report.map is a photorealistic 3D view: for an HTML report, embed map.data.url in an iframe. When the user wants a picture of the building rather than only the government aerial from get_aerial_photo, give them that same URL. Never fetch, read or quote the page: it contains their API key.

Privacy: Bolig-MCP never returns names, CPR numbers or other details of private people. A private owner is only "privatperson" with a share, and people in CVR are only counted. Do not try to find out who a private owner or person is, by combining tools or through any other source, and tell the user that this is not something Bolig-MCP does.

Credentials: every user brings their own. When a result has reason "missing_credentials", tell the user which source is missing and how to get their own access (the result's detail says how), and that they add it with \`${SETUP_COMMAND}\` in a terminal or as an env var in their MCP client config. Never ask the user to paste an API key, password or token into the chat, and never put one in a tool argument. Call list_sources to see what is configured.`;

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "boligmcp",
      version: VERSION,
    },
    { instructions: INSTRUCTIONS },
  );

  /**
   * Registers a tool whose arguments are checked strictly: a misspelt or unknown argument ("adress", "maxResults")
   * is an error naming it, not silently dropped so the call looks like one without input.
   */
  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    callback: ToolCallback<z.ZodObject<Shape, "strict">>,
  ) => server.registerTool(name, { description, inputSchema: z.object(shape).strict() }, callback);

  tool(
    "list_sources",
    "List data sources, their access tier, whether the user's own credentials are configured (and from where: env or credentials file), and how to set up the missing ones. Never returns credential values.",
    {},
    async () => asText({ sources: listSourceStatus() }),
  );

  tool(
    "search_address",
    "Search Danish addresses by free text using Adressevælgeren (DAWA replacement). Use before any property lookup.",
    {
      query: z.string().min(2).describe("Free-text Danish address"),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum number of hits (1–20, default 10)"),
    },
    async ({ query, limit }) => {
      const result = await searchAddresses(query, limit ?? 10);
      if (result.status !== "unavailable" || result.reason !== "not_found") return asText(result);
      if (looksForeign(query)) {
        return asText({ ...result, detail: `${result.detail}. Only addresses in Denmark are covered, not Greenland, the Faroe Islands or other countries.` });
      }
      const suggestions = await suggestionsFor(query).catch(() => []);
      return asText(suggestions.length ? { ...result, suggestions } : result);
    },
  );

  tool(
    "resolve_property",
    "Resolve a Danish address (or a BFE) to DAR IDs, coordinates, cadastral IDs and BFE. For a flat that is a condominium, bfe is the flat's own and mainBfe the property holding the land. matchWarning says when the address found is not exactly the one asked for. Requires Datafordeleren for BFE.",
    addressInput,
    async (input) => asText(await resolveTarget(input)),
  );

  tool(
    "get_buildings",
    "Get BBR buildings (incl. outbuildings on the same ground), floors with attic/basement areas, units with tenure and facilities, and water/drainage. Give an address for its own unit, or a BFE for the whole property. Labels use the official Danish BBR code lists.",
    addressInput,
    async ({ bfe, ...input }) => {
      if (!input.query?.trim() && !input.addressId?.trim()) {
        if (!bfe) return asText(unavailable("bbr", "not_found", "Provide bfe, query or addressId"));
        return asText(await getBuildingsAndUnits({ bfe }));
      }
      const resolved = await resolveTarget(input);
      if (resolved.status !== "ok") return asText(resolved);
      return asText(forAddress(await buildingsFor(resolved.data), resolved.data));
    },
  );

  tool(
    "get_parcel",
    "Get cadastral parcels (matrikel) for a BFE number, including theme notes such as fredskov, strandbeskyttelse and klitfredning. A condominium's BFE gives the parcels of the property it is part of.",
    { bfe: bfeInput },
    async ({ bfe }) => asText(await getParcels(bfe)),
  );

  tool(
    "get_valuation",
    "Get official property and land valuation (VUR) for a BFE: full history, with the latest valuation from the new system (2020+) and the old system kept apart. Valuations of one property in several parts in the same year are added together (parts).",
    { bfe: bfeInput },
    async ({ bfe }) => asText(await getValuation(bfe)),
  );

  tool(
    "get_trades",
    "Get recorded ownership changes for a BFE from EJF, newest first: takeover and agreement dates, total and cash price, movables and transfer type. Entries without a price have no recorded price: usually transfers such as inheritance, sometimes a second record of a sale on the same date; transferType tells them apart. Needs the user's own approved EJF OAuth access. Never returns buyers, sellers or owner names.",
    { bfe: bfeInput },
    async ({ bfe }) => asText(await getTrades(bfe)),
  );

  tool(
    "get_owners",
    "Get the current owners of a property from EJF: for each owner the kind (company, private person, other), ownership type and share. A company owner comes with its CVR data (name, form, status, address, industry). A private person is only reported as such: no name and no CPR number, ever. Needs the user's own EJF OAuth access approved for CustomEjerskabBegraenset, which is a separate approval from sale prices.",
    addressInput,
    async ({ bfe, ...input }) => {
      if (bfe && !input.query?.trim() && !input.addressId?.trim()) return asText(await getOwners(bfe));
      const resolved = await resolveTarget({ ...input, bfe });
      if (resolved.status !== "ok") return asText(resolved);
      if (!resolved.data.bfe) return asText(unavailable("ejf", "not_found", "The address has no BFE, so no owners are recorded."));
      return asText(forAddress(await getOwners(resolved.data.bfe), resolved.data));
    },
  );

  tool(
    "get_company",
    "Get public CVR data for a Danish company by its 8-digit CVR number: name, status, company form, start and end date, registered address, industry, head count when CVR has a recent one, and whether it is reklamebeskyttet. For an I/S or K/S, fully liable participants that are companies are listed; people are only counted. Owners and management of a company are not in this source.",
    {
      cvr: z
        .preprocess((value) => (typeof value === "number" && Number.isInteger(value) ? String(value).padStart(8, "0") : value), z.string().trim())
        .describe("CVR number, 8 digits, e.g. 24256790"),
    },
    async ({ cvr }) => asText(await getCompany(cvr)),
  );

  tool(
    "get_admin_areas",
    "Get municipality, region, parish, court and police districts for an address.",
    addressInput,
    async (input) => {
      const resolved = await resolveTarget(input);
      if (resolved.status !== "ok") return asText(resolved);
      const coord = resolved.data.coordinate?.epsg25832;
      if (!coord) return asText(noPoint("dagi"));
      return asText(forAddress(await getAdminAreasAt(coord.x, coord.y), resolved.data));
    },
  );

  tool(
    "get_plans",
    "Get local plans, local plan subareas, municipal plan frameworks (with max plot ratio, floors and height), zone status and plan proposals covering the property. Nearby local plans that do not cover it are listed separately.",
    addressInput,
    async (input) => {
      const { resolved, ids, point } = await locate(input);
      if (!ids) return asText(resolved);
      if (!point) return asText(noPoint("plandata"));
      return asText(forAddress(await getPlansAt(point.x, point.y, { lookupPoint: point.kind }), ids));
    },
  );

  tool(
    "get_site_conditions",
    "Get site conditions from municipal plans at the property: heat supply and heat plan areas, sewer catchment, flood/erosion risk, near-surface groundwater, low-lying land, noise, large livestock farm areas, planned roads and technical facilities nearby, and cultural heritage designations.",
    addressInput,
    async (input) => {
      const { resolved, ids, point } = await locate(input);
      if (!ids) return asText(resolved);
      if (!point) return asText(noPoint("plandata"));
      return asText(forAddress(await getSiteConditionsAt(point.x, point.y, { lookupPoint: point.kind }), ids));
    },
  );

  tool(
    "get_terrain",
    "Get terrain height (m DVR90, about mean sea level) at the property from Danmarks Højdemodel, the highest surface nearby (roof/trees) and how the plot lies relative to the terrain within 250 m.",
    addressInput,
    async (input) => {
      const { resolved, ids, point } = await locate(input);
      if (!ids) return asText(resolved);
      if (!point) return asText(noPoint("dhm"));
      return asText(forAddress(await getTerrainAt(point.x, point.y, { lookupPoint: point.kind }), ids));
    },
  );

  tool(
    "get_aerial_photo",
    "Get a GeoDanmark spring orthophoto (straight down) and a cropped skråfoto facade of the property. Needs the user's own Dataforsyningen token. The token is never included in an image URL.",
    addressInput,
    async (input) => {
      const { resolved, ids, point } = await locate(input);
      if (!ids) return asText(resolved);
      if (!point) return asText(noPoint("dataforsyningen"));
      const result = await getAerialPhoto(point.x, point.y);
      if (result.status !== "ok") return asText(result);
      const { jpeg, facadeJpeg, photo } = result.data;
      const content: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [
        {
          type: "text",
          text: JSON.stringify({
            status: result.status,
            source: result.source,
            fetchedAt: result.fetchedAt,
            designation: ids.designation,
            ...(ids.matchWarning ? { matchWarning: ids.matchWarning } : {}),
            lookupPoint: point.kind,
            photo,
          }),
        },
        { type: "image", data: jpeg, mimeType: "image/jpeg" },
      ];
      if (facadeJpeg) content.push({ type: "image", data: facadeJpeg, mimeType: "image/jpeg" });
      return { content };
    },
  );

  tool(
    "get_map",
    "Photorealistic 3D view of the property on localhost, with a white outline of the building. Same view as property_report.map. For an HTML report, embed data.url in an iframe. Give the user the URL when they want this instead of the government aerial from get_aerial_photo. Never fetch, read or quote the page: it contains their API key, which is not in this result. Needs the user's own GOOGLE_MAPS_API_KEY with the Maps JavaScript API enabled.",
    addressInput,
    async (input) => {
      const { resolved, ids, point, buildings } = await locate(input);
      if (!ids) return asText(resolved);
      if (!point) return asText(noPoint("google_maps"));
      const label = ids.designation ?? input.query ?? "Ejendom";
      const buildingId = buildings?.status === "ok" ? nearestBuildingId(point, buildings.data.buildings) : undefined;
      return asText(forAddress(await viewForPoint(label, point.x, point.y, buildingId), ids));
    },
  );

  tool(
    "get_environment",
    "Get mapped soil contamination (V1/V2) and the coastal proximity zone at the property. Each locality says whether it is on the property (point inside or parcel listed) or only nearby (~80 m).",
    addressInput,
    async (input) => {
      const { resolved, ids, point } = await locate(input);
      if (!ids) return asText(resolved);
      if (!point) return asText(noPoint("miljoportal"));
      const landBfe = ids.mainBfe ?? ids.bfe;
      const parcels = landBfe ? await getParcels(landBfe) : undefined;
      return asText(forAddress(await getEnvironmentAt(point.x, point.y, parcelRefs(ids, parcels)), ids));
    },
  );

  tool(
    "get_heritage",
    "Get SAVE preservation value (1–9, 1 is highest) and listed status from Slots- og Kulturstyrelsen (FBB) for buildings at the property. atProperty is false for neighbouring buildings the ~50 m lookup also found.",
    addressInput,
    async (input) => {
      const { resolved, ids, point, buildings } = await locate(input);
      if (!ids) return asText(resolved);
      if (!point) return asText(noPoint("fbb"));
      const addresses = ids.designation ? [ids.designation] : [];
      return asText(forAddress(await getHeritageAt(point.x, point.y, { addresses, buildings: buildingPoints(buildings) }), ids));
    },
  );

  tool(
    "get_property_location",
    "Get the property's location from EBR: the street address linked to the BFE, or the text designation used when the property has no street address. Same Datafordeleren API key as BBR. No owner names.",
    { bfe: bfeInput },
    async ({ bfe }) => asText(await getPropertyLocation(bfe)),
  );

  tool(
    "get_energy_label",
    "Get the official energy label (energimærke) for an address or BFE from Energistyrelsen's EMOData service. Needs the user's own EMOData agreement. Also included in property_report.",
    addressInput,
    async ({ bfe, ...input }) => {
      if (bfe && !input.query?.trim() && !input.addressId?.trim()) return asText(await getEnergyLabel({ bfe }));
      const resolved = await resolveTarget(input);
      if (resolved.status !== "ok") return asText(resolved);
      return asText(forAddress(await getEnergyLabel({ bfe: resolved.data.bfe }), resolved.data));
    },
  );

  tool(
    "get_area_stats",
    "Get municipality statistics from Danmarks Statistik: population and 5-year change, disposable income, share of rented and vacant dwellings, unemployment and net migration.",
    addressInput,
    async (input) => {
      const resolved = await resolveTarget(input);
      if (resolved.status !== "ok") return asText(resolved);
      const coord = resolved.data.coordinate?.epsg25832;
      let code: string | undefined;
      if (coord) {
        const admin = await getAdminAreasAt(coord.x, coord.y);
        if (admin.status === "ok") code = admin.data.municipalityCode;
      }
      if (!code && resolved.data.addressId) {
        const lookup = await lookupAddress(resolved.data.addressId);
        if (lookup.status === "ok") code = lookup.data.municipalityCode;
      }
      if (!code) {
        return asText(
          unavailable(
            "dst",
            "not_found",
            "Municipality code unavailable. Set DATAFORDELER_API_KEY or use an address with kommune in Adressevælgeren.",
          ),
        );
      }
      return asText(forAddress(await getAreaStatsForMunicipality(code), resolved.data));
    },
  );

  tool(
    "property_report",
    "Build a combined report for a Danish address or BFE with investor flags (asbestos, fossil heating, area composition, building rights headroom, plan proposals, flood/noise/groundwater, tenancy, drainage). Marks missing sources. summary.matchWarning says when the address found is not exactly the one asked for. Use bfe for a property without a street address. map is a photorealistic 3D view: embed map.data.url in an iframe for an HTML report, or give the user that URL instead of only the government aerial. Never fetch the page.",
    addressInput,
    async (input) => {
      if (!input.query?.trim() && !input.addressId?.trim() && !input.bfe) {
        return asText({ error: "Provide query, addressId or bfe" });
      }
      return asText(await buildPropertyReport(input));
    },
  );

  tool(
    "get_nearby_services",
    "Get straight-line distance to the nearest primary school, daycare, shop, doctor/health centre and sports hall from BBR, and how many lie within 1 km.",
    addressInput,
    async (input) => {
      const { resolved, ids, point } = await locate(input);
      if (!ids) return asText(resolved);
      if (!point) return asText(noPoint("bbr"));
      return asText(forAddress(await getNearbyServices(point.x, point.y), ids));
    },
  );

  tool(
    "get_local_statistics",
    "Get parish (sogn) statistics — population and 5-year change, average age, net migration, employment and education — plus the regional price index and average sale price for the property type (landsdel level, Statistikbanken). Each block says its level and area.",
    addressInput,
    async (input) => {
      const resolved = await resolveTarget(input);
      if (resolved.status !== "ok") return asText(resolved);
      const coord = resolved.data.coordinate?.epsg25832;
      if (!coord) return asText(noPoint("dagi"));
      const admin = await getAdminAreasAt(coord.x, coord.y);
      if (admin.status !== "ok") return asText(admin);
      const buildings = await buildingsFor(resolved.data);
      const usage = buildings.status === "ok" ? buildings.data.buildings[0]?.usageCode : undefined;
      const category = marketCategoryFor(usage, resolved.data.isCondominium);
      const [parish, market] = await Promise.all([
        admin.data.parishCode ? getParishStats(admin.data.parishCode, admin.data.parishName) : Promise.resolve(undefined),
        admin.data.landsdelName && category ? getRegionalMarket(admin.data.landsdelName, category) : Promise.resolve(undefined),
      ]);
      const noMarket = !category
        ? { reason: "Ingen prisstatistik for ejendomstypen; Danmarks Statistik dækker enfamiliehuse, ejerlejligheder og sommerhuse." }
        : undefined;
      return asText(forAddress({ parish, market: market ?? noMarket }, resolved.data));
    },
  );

  tool(
    "watch_property",
    "Add a Danish address to the user's watchlist and save a snapshot (valuation, plans and proposals, BBR buildings, last sale, flags). Later, check_watchlist reports what changed. Watching a property again keeps its baseline.",
    {
      query: z.string().min(2).describe("Free-text Danish address"),
      note: z.string().max(200).optional().describe("Your own note for the entry, e.g. why it is watched"),
      allowMismatch: z
        .boolean()
        .optional()
        .describe("Watch the address found even when it is not exactly the one asked for (another floor, door or town)"),
    },
    async ({ query, note, allowMismatch }) => asText(await watchProperty(query, note, { allowMismatch })),
  );

  tool(
    "check_watchlist",
    "Re-check every watched property and report changes since the last check: new valuation, new sale, plans or proposals covering it, BBR building changes and new or resolved flags.",
    { update: z.boolean().optional().describe("Save the new state as the baseline (default true)") },
    async ({ update }) => asText(await checkWatchlist({ update })),
  );

  tool(
    "list_watchlist",
    "List the properties on the user's watchlist and when each was last checked.",
    {},
    async () => {
      const list = listWatchlist();
      return asText(Array.isArray(list) ? { entries: list } : list);
    },
  );

  tool(
    "unwatch_property",
    "Remove a property from the watchlist by its id from list_watchlist (BFE or address id) or the address text used when adding it.",
    { id: z.string().min(1).describe("The entry's id from list_watchlist (BFE or address id), or the address text used when adding it") },
    async ({ id }) => asText(unwatchProperty(id)),
  );

  tool(
    "screen_properties",
    `Screen up to ${SCREEN_MAX_ADDRESSES} Danish addresses at once and return one comparable row per address: size, plot, heating, zone, new public valuation, valuation per m², building rights headroom and high/medium flags.`,
    {
      addresses: z
        .preprocess(
          (value) => (typeof value === "string" ? [value] : Array.isArray(value) ? value.map((item) => (typeof item === "number" ? String(item) : item)) : value),
          z.array(z.string().min(2)).min(1).max(SCREEN_MAX_ADDRESSES),
        )
        .describe("Free-text Danish addresses, or BFE numbers for properties without a street address"),
    },
    async ({ addresses }) => asText(await screenProperties(addresses)),
  );

  return server;
}

async function main(): Promise<void> {
  if (process.argv[2] === "setup") {
    const { runSetup } = await import("./setup.js");
    await runSetup(process.argv.slice(3));
    return;
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("boligmcp listening on stdio");
  // Only the free key most users need; EJF needs an agreement and Dataforsyningen is optional.
  const missing = listSourceStatus().filter(
    (source) => !source.configured && source.missingEnv.includes("DATAFORDELER_API_KEY") && source.id !== "ejf",
  );
  if (missing.length) {
    console.error(
      `boligmcp: no credentials for ${missing.map((source) => source.id).join(", ")}. Run \`${SETUP_COMMAND}\` to add your own.`,
    );
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
