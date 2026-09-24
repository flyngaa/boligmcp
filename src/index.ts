import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listSourceStatus } from "./catalog.js";
import { resolveProperty } from "./resolve.js";
import { lookupAddress, searchAddresses } from "./sources/adressevaelger.js";
import { getAreaStatsForMunicipality } from "./sources/dst.js";
import { getEnergyLabel } from "./sources/emodata.js";
import { getEnvironmentAt } from "./sources/miljoportal.js";
import { getPlansAt } from "./sources/plandata.js";
import {
  getAdminAreasAt,
  getBuildingsAndUnits,
  getParcels,
  getTrades,
  getValuation,
} from "./sources/datafordeler/registers.js";
import { asText } from "./tools/json.js";
import { buildPropertyReport } from "./tools/property-report.js";
import { unavailable } from "./types.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "boligmcp",
    version: "0.1.0",
  });

  server.tool(
    "list_sources",
    "List official Danish property data sources, their access tier, and whether credentials are configured.",
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
    "Get BBR buildings and units for a BFE or address-id.",
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
    "Get official property and land valuation (VUR) for a BFE, including history.",
    { bfe: z.string() },
    async ({ bfe }) => asText(await getValuation(bfe)),
  );

  server.tool(
    "get_trades",
    "Get non-protected ownership type and recorded trade prices (EJF). Never returns private owner names.",
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
    "Get local plans, municipal plan frameworks and zone status from Plandata.dk at the address coordinate.",
    { addressId: z.string() },
    async ({ addressId }) => {
      const resolved = await resolveProperty({ addressId });
      if (resolved.status !== "ok" || !resolved.data.coordinate) {
        return asText(unavailable("plandata", "not_found", "Could not get coordinates for address"));
      }
      return asText(await getPlansAt(resolved.data.coordinate.epsg25832.x, resolved.data.coordinate.epsg25832.y));
    },
  );

  server.tool(
    "get_environment",
    "Get soil contamination, §3 nature, conservation and coastal/forest protection overlays at the address.",
    { addressId: z.string() },
    async ({ addressId }) => {
      const resolved = await resolveProperty({ addressId });
      if (resolved.status !== "ok" || !resolved.data.coordinate) {
        return asText(unavailable("miljoportal", "not_found", "Could not get coordinates for address"));
      }
      return asText(
        await getEnvironmentAt(resolved.data.coordinate.epsg25832.x, resolved.data.coordinate.epsg25832.y),
      );
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
    "Get municipality-level population, income and dwelling statistics from Danmarks Statistik.",
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
    "Build a compact combined report for a Danish address. Calls all sources in parallel and marks missing ones.",
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

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("boligmcp listening on stdio");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
