# Bolig-MCP

MCP server that takes a Danish address and gathers **public** property data from official registers.

It does **not** use DAWA (`dawa.aws.dk` closes 1 October 2026). Address search goes through [Adressevælgeren](https://confluence.kds.dk/pages/viewpage.action?pageId=234782998); register lookups go through [Datafordeleren GraphQL](https://confluence.kds.dk/pages/viewpage.action?pageId=187105434).

Protected owner names of private individuals are never requested.

## Install

```bash
npx boligmcp
```

Or clone and run locally:

```bash
pnpm install
pnpm build
node dist/index.js
```

### Claude Desktop / Cursor / Claude Code

```json
{
  "mcpServers": {
    "boligmcp": {
      "command": "npx",
      "args": ["-y", "boligmcp"],
      "env": {
        "DATAFORDELER_API_KEY": "your-key"
      }
    }
  }
}
```

Local checkout:

```json
{
  "mcpServers": {
    "boligmcp": {
      "command": "node",
      "args": ["/absolute/path/to/boligmcp/dist/index.js"],
      "env": {
        "DATAFORDELER_API_KEY": "your-key"
      }
    }
  }
}
```

Copy `.env.example` to `.env` when running from a checkout. Missing keys never crash the server; the matching source returns `unavailable`.

## Tools

| Tool | When to use |
|---|---|
| `search_address` | Free-text Danish address → DAR ids |
| `resolve_property` | Address id → BFE, cadastral ids, coordinate |
| `get_buildings` | BBR buildings and units |
| `get_parcel` | Matrikel parcels for a BFE |
| `get_valuation` | Official VUR values and history |
| `get_trades` | Non-protected EJF trades / ownership type |
| `get_admin_areas` | Municipality, region, parish, districts |
| `get_plans` | Local plans, municipal frameworks, zone |
| `get_environment` | Soil, §3 nature, conservation, coastal/forest lines |
| `get_energy_label` | Energimærke (needs EMOData) |
| `get_area_stats` | Municipality statistics from DST |
| `property_report` | Parallel combined report (~4k tokens) |
| `list_sources` | Which sources are configured |

Every tool returns a `SourceResult`: either `{ status: "ok", source, fetchedAt, data }` or `{ status: "unavailable", source, reason, detail }`.

## Access tiers

| Tier | Meaning | Examples |
|---|---|---|
| T0 | Open | Adressevælgeren, Plandata, Miljøportal, DST |
| T1 | Free key | Datafordeleren GraphQL, Dataforsyningen |
| T2 | Agreement | EMOData energy labels |
| T3 / X | Not built | Tingbog; private owner names |

See [docs/credentials.md](docs/credentials.md) for how to get each key.

## Environment

| Variable | Required for |
|---|---|
| `DATAFORDELER_API_KEY` | BFE chain, BBR, VUR, EJF, DAGI |
| `ADRESSEVAELGER_TOKEN` | Optional; defaults to `adressevaelger123` |
| `EMODATA_USER` / `EMODATA_PASSWORD` | Energy labels |
| `DATAFORSYNINGEN_TOKEN` | Optional imagery (not in core tools) |
| `CACHE_PATH` | SQLite cache file (default `./cache.db`) |

## Development

```bash
pnpm install
pnpm test
pnpm dev
```

After you have a Datafordeleren key:

```bash
pnpm exec tsx scripts/introspect-datafordeler.ts
```

## Licence

MIT
