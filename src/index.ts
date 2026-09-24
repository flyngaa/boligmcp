import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listSourceStatus, SETUP_COMMAND } from "./catalog.js";
import { resolveProperty } from "./resolve.js";
import { lookupAddress, searchAddresses } from "./sources/adressevaelger.js";
import { getAreaStatsForMunicipality } from "./sources/dst.js";
import { getEnergyLabel } from "./sources/emodata.js";
import { getEnvironmentAt } from "./sources/miljoportal.js";
import { getPlansAt, getSiteConditionsAt } from "./sources/plandata.js";
import { getTerrainAt } from "./sources/datafordeler/dhm.js";
import {
  getAdminAreasAt,
  getBuildingsAndUnits,
  getParcels,
  getTrades,
  getValuation,
} from "./sources/datafordeler/registers.js";
import { asText } from "./tools/json.js";
import { buildPropertyReport, lookupPointFor, parcelRefs } from "./tools/property-report.js";
import { SCREEN_MAX_ADDRESSES, screenProperties } from "./tools/screen.js";
import { checkWatchlist, listWatchlist, unwatchProperty, watchProperty } from "./tools/watch.js";
import { getNearbyServices } from "./sources/datafordeler/nearby.js";
import { getParishStats, getRegionalMarket, marketCategoryFor } from "./sources/dst.js";
import { unavailable } from "./types.js";

/** The main building's coordinate when BBR has one, else the address point. */
async function lookupPoint(addressId: string) {
  const resolved = await resolveProperty({ addressId });
  if (resolved.status !== "ok") return undefined;
  const buildings = await getBuildingsAndUnits({ bfe: resolved.data.bfe, addressId });
  return lookupPointFor(resolved.data, buildings);
}

const INSTRUCTIONS = `Public Danish property data for an address. Start with property_report or screen_properties.

Credentials: every user brings their own. When a result has reason "missing_credentials", tell the user which source is missing and how to get their own access (the result's detail says how), and that they add it with \`${SETUP_COMMAND}\` in a terminal or as an env var in their MCP client config. Never ask the user to paste an API key, password or token into the chat, and never put one in a tool argument. Call list_sources to see what is configured.`;

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "boligmcp",
      version: "0.2.0",
    },
    { instructions: INSTRUCTIONS },
  );

  server.tool(
    "list_sources",
    "List data sources, their access tier, whether the user's own credentials are configured (and from where: env or credentials file), and how to set up the missing ones. Never returns credential values.",
    {},
    async () => asText({ sources: listSourceStatus() }),
  );

  server.tool(
    "search_address",
    "Search Danish addresses by free text using Adressevælgeren (DAWA replacement). Use before any property lookup.",
    { query: z.string().min(2).describe("Free-text Danish address"), limit: z.number().int().min(1).max(20).optional() },
    async ({ query, limit }) => asText(await searchAddresses(query, limit ?? 10)),
  );

  server.tool(
    "resolve_property",
    "Resolve a Danish address to DAR IDs, coordinates, cadastral IDs and BFE. Requires Datafordeleren for BFE.",
    {
      addressId: z.string().optional().describe("DAR address UUID"),
      query: z.string().optional().describe("Free-text address if addressId is unknown"),
    },
    async ({ addressId, query }) => {
      if (!addressId && !query) {
        return asText(unavailable("adressevaelger", "not_found", "Provide addressId or query"));
      }
      return asText(await resolveProperty({ addressId, query }));
    },
  );

  server.tool(
    "get_buildings",
    "Get BBR buildings (incl. outbuildings on the same ground), floors with attic/basement areas, units with tenure and facilities, and water/drainage. Labels use the official Danish BBR code lists.",
    {
      bfe: z.string().optional(),
      addressId: z.string().optional(),
    },
    async ({ bfe, addressId }) => {
      if (!bfe && !addressId) {
        return asText(unavailable("bbr", "not_found", "Provide bfe or addressId"));
      }
      return asText(await getBuildingsAndUnits({ bfe, addressId }));
    },
  );

  server.tool(
    "get_parcel",
    "Get cadastral parcels (matrikel) for a BFE number.",
    { bfe: z.string().describe("BFE number") },
    async ({ bfe }) => asText(await getParcels(bfe)),
  );

  server.tool(
    "get_valuation",
    "Get official property and land valuation (VUR) for a BFE: full history, with the latest valuation from the new system (2020+) and the old system kept apart.",
    { bfe: z.string() },
    async ({ bfe }) => asText(await getValuation(bfe)),
  );

  server.tool(
    "get_trades",
    "Get recorded sales for a BFE from EJF: takeover and agreement dates, total and cash price, movables and transfer type. Needs the user's own approved EJF OAuth access. Never returns buyers, sellers or owner names.",
    { bfe: z.string() },
    async ({ bfe }) => asText(await getTrades(bfe)),
  );

  server.tool(
    "get_admin_areas",
    "Get municipality, region, parish, court and police districts for an address.",
    { addressId: z.string() },
    async ({ addressId }) => {
      const resolved = await resolveProperty({ addressId });
      if (resolved.status !== "ok" || !resolved.data.coordinate) {
        return asText(unavailable("dagi", "not_found", "Could not get coordinates for address"));
      }
      return asText(
        await getAdminAreasAt(resolved.data.coordinate.epsg25832.x, resolved.data.coordinate.epsg25832.y),
      );
    },
  );

  server.tool(
    "get_plans",
    "Get local plans, local plan subareas, municipal plan frameworks (with max plot ratio, floors and height), zone status and plan proposals covering the property. Nearby local plans that do not cover it are listed separately.",
    { addressId: z.string() },
    async ({ addressId }) => {
      const point = await lookupPoint(addressId);
      if (!point) return asText(unavailable("plandata", "not_found", "Could not get coordinates for address"));
      return asText(await getPlansAt(point.x, point.y, { lookupPoint: point.kind }));
    },
  );

  server.tool(
    "get_site_conditions",
    "Get site conditions from municipal plans at the property: heat supply and heat plan areas, sewer catchment, flood/erosion risk, near-surface groundwater, low-lying land, noise, large livestock farm areas, planned roads and technical facilities nearby, and cultural heritage designations.",
    { addressId: z.string() },
    async ({ addressId }) => {
      const point = await lookupPoint(addressId);
      if (!point) return asText(unavailable("plandata", "not_found", "Could not get coordinates for address"));
      return asText(await getSiteConditionsAt(point.x, point.y, { lookupPoint: point.kind }));
    },
  );

  server.tool(
    "get_terrain",
    "Get terrain height (m DVR90, about mean sea level) at the property from Danmarks Højdemodel, the highest surface nearby (roof/trees) and how the plot lies relative to the terrain within 250 m.",
    { addressId: z.string() },
    async ({ addressId }) => {
      const point = await lookupPoint(addressId);
      if (!point) return asText(unavailable("dhm", "not_found", "Could not get coordinates for address"));
      return asText(await getTerrainAt(point.x, point.y, { lookupPoint: point.kind }));
    },
  );

  server.tool(
    "get_environment",
    "Get mapped soil contamination (V1/V2) and the coastal proximity zone at the property. Each locality says whether it is on the property (point inside or parcel listed) or only nearby (~80 m).",
    { addressId: z.string() },
    async ({ addressId }) => {
      const point = await lookupPoint(addressId);
      if (!point) return asText(unavailable("miljoportal", "not_found", "Could not get coordinates for address"));
      const resolved = await resolveProperty({ addressId });
      const ids = resolved.status === "ok" ? resolved.data : undefined;
      const parcels = ids?.bfe ? await getParcels(ids.bfe) : undefined;
      return asText(await getEnvironmentAt(point.x, point.y, parcelRefs(ids, parcels)));
    },
  );

  server.tool(
    "get_energy_label",
    "Get the official energy label (energimærke) when EMOData credentials are configured.",
    {
      addressId: z.string().optional(),
      query: z.string().optional(),
    },
    async ({ addressId, query }) => {
      const resolved = addressId || query ? await resolveProperty({ addressId, query }) : undefined;
      const designation =
        resolved?.status === "ok" ? resolved.data.designation : query;
      return asText(
        await getEnergyLabel({
          address: designation,
          bfe: resolved?.status === "ok" ? resolved.data.bfe : undefined,
        }),
      );
    },
  );

  server.tool(
    "get_area_stats",
    "Get municipality statistics from Danmarks Statistik: population and 5-year change, disposable income, share of rented and vacant dwellings, unemployment and net migration.",
    { addressId: z.string() },
    async ({ addressId }) => {
      const lookup = await lookupAddress(addressId);
      const resolved = await resolveProperty({ addressId });
      let code = lookup.status === "ok" ? lookup.data.municipalityCode : undefined;
      if (!code && resolved.status === "ok" && resolved.data.coordinate) {
        const admin = await getAdminAreasAt(
          resolved.data.coordinate.epsg25832.x,
          resolved.data.coordinate.epsg25832.y,
        );
        if (admin.status === "ok") code = admin.data.municipalityCode;
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
      return asText(await getAreaStatsForMunicipality(code));
    },
  );

  server.tool(
    "property_report",
    "Build a combined report for a Danish address with investor flags (asbestos, fossil heating, area composition, building rights headroom, plan proposals, flood/noise/groundwater, tenancy, drainage). Marks missing sources.",
    {
      query: z.string().optional(),
      addressId: z.string().optional(),
    },
    async ({ query, addressId }) => {
      if (!query && !addressId) {
        return asText({ error: "Provide query or addressId" });
      }
      return asText(await buildPropertyReport({ query, addressId }));
    },
  );

  server.tool(
    "get_nearby_services",
    "Get straight-line distance to the nearest primary school, daycare, shop, doctor/health centre and sports hall from BBR, and how many lie within 1 km.",
    { addressId: z.string() },
    async ({ addressId }) => {
      const point = await lookupPoint(addressId);
      if (!point) return asText(unavailable("bbr", "not_found", "Could not get coordinates for address"));
      return asText(await getNearbyServices(point.x, point.y));
    },
  );

  server.tool(
    "get_local_statistics",
    "Get parish (sogn) statistics — population and 5-year change, average age, net migration, employment and education — plus the regional price index and average sale price for the property type (landsdel level, Statistikbanken).",
    { addressId: z.string() },
    async ({ addressId }) => {
      const resolved = await resolveProperty({ addressId });
      const coord = resolved.status === "ok" ? resolved.data.coordinate?.epsg25832 : undefined;
      if (!coord) return asText(unavailable("dagi", "not_found", "Could not get coordinates for address"));
      const admin = await getAdminAreasAt(coord.x, coord.y);
      if (admin.status !== "ok") return asText(admin);
      const buildings = await getBuildingsAndUnits({ bfe: resolved.status === "ok" ? resolved.data.bfe : undefined, addressId });
      const usage = buildings.status === "ok" ? buildings.data.buildings[0]?.usageCode : undefined;
      const [parish, market] = await Promise.all([
        admin.data.parishCode ? getParishStats(admin.data.parishCode, admin.data.parishName) : Promise.resolve(undefined),
        admin.data.landsdelName
          ? getRegionalMarket(admin.data.landsdelName, marketCategoryFor(usage, resolved.status === "ok" ? resolved.data.isCondominium : false))
          : Promise.resolve(undefined),
      ]);
      return asText({ parish, market });
    },
  );

  server.tool(
    "watch_property",
    "Add a Danish address to the user's watchlist and save a snapshot (valuation, plans and proposals, BBR buildings, last sale, flags). Later, check_watchlist reports what changed.",
    { query: z.string().min(2).describe("Free-text Danish address"), note: z.string().max(200).optional() },
    async ({ query, note }) => asText(await watchProperty(query, note)),
  );

  server.tool(
    "check_watchlist",
    "Re-check every watched property and report changes since the last check: new valuation, new sale, plans or proposals covering it, BBR building changes and new or resolved flags.",
    { update: z.boolean().optional().describe("Save the new state as the baseline (default true)") },
    async ({ update }) => asText(await checkWatchlist({ update })),
  );

  server.tool(
    "list_watchlist",
    "List the properties on the user's watchlist and when each was last checked.",
    {},
    async () => asText({ entries: listWatchlist() }),
  );

  server.tool(
    "unwatch_property",
    "Remove a property from the watchlist by BFE, address id or the address text used when adding it.",
    { id: z.string().min(1) },
    async ({ id }) => asText(unwatchProperty(id)),
  );

  server.tool(
    "screen_properties",
    `Screen up to ${SCREEN_MAX_ADDRESSES} Danish addresses at once and return one comparable row per address: size, plot, heating, zone, new public valuation, valuation per m², building rights headroom and high/medium flags.`,
    {
      addresses: z
        .array(z.string().min(2))
        .min(1)
        .max(SCREEN_MAX_ADDRESSES)
        .describe("Free-text Danish addresses"),
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
