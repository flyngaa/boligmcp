# Bolig-MCP

MCP server that takes a Danish address and gathers **public** property data from official registers.

It does **not** use DAWA (`dawa.aws.dk` closes 1 October 2026). Address search goes through [Adressevælgeren](https://confluence.kds.dk/pages/viewpage.action?pageId=234782998); register lookups go through [Datafordeleren GraphQL](https://confluence.kds.dk/pages/viewpage.action?pageId=187105434).

Protected owner names of private individuals are never requested.

## Install

Bolig-MCP is not on npm yet, so install it from source. You need Node.js 20 or newer and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/flyngaa/boligmcp.git
cd boligmcp
pnpm install
pnpm build
node dist/index.js setup   # add your own keys, see below
```

Then point your MCP client at the built server, using the full path to your clone:

- **Claude Code:**

  ```bash
  claude mcp add --scope user boligmcp -- node /path/to/boligmcp/dist/index.js
  ```

- **Claude Desktop, Cursor and other clients:** add it to the client's MCP config, e.g. `claude_desktop_config.json`:

  ```json
  { "mcpServers": { "boligmcp": { "command": "node", "args": ["/path/to/boligmcp/dist/index.js"] } } }
  ```

Restart the client and ask about a Danish address, e.g. "Lav en rapport om Egeskovvej 41, 8800 Viborg".

Once Bolig-MCP is published to npm, `npx -y boligmcp` replaces the clone and the path. The tools' messages already say
`npx -y boligmcp setup`; from source, run `node dist/index.js setup` in your clone instead.

### Credentials: bring your own

Bolig-MCP never ships with keys. Each user adds their own, outside the chat:

- **Any client:** run once in a terminal, in your clone:

  ```bash
  node dist/index.js setup
  ```

  It asks for each key with hidden input, checks the Datafordeleren key against the API and saves it to `~/.config/boligmcp/credentials.json` (mode 600). `node dist/index.js setup --show` shows what is set, masked.
- **Or** set env vars in the client config. Env wins over the credentials file.

  ```bash
  claude mcp add --scope user boligmcp -e DATAFORDELER_API_KEY=<your key> -- node /path/to/boligmcp/dist/index.js
  ```
- **Claude Desktop (MCP bundle):** `npx -y @anthropic-ai/mcpb pack` in your clone (after `pnpm build`) makes a `.mcpb` file. Installing it in Claude Desktop asks for the keys and masks them (see `manifest.json`).

When a key is missing, the tools say which source is affected and how to get access, and the server instructs the model never to ask for keys in the chat. A `.env` file is only read when `BOLIGMCP_ENV_FILE` points to it (used by `pnpm dev`). The cache lives in `~/.cache/boligmcp/` unless `CACHE_PATH` is set.

## Tools

| Tool | When to use |
|---|---|
| `search_address` | Free-text Danish address → DAR ids |
| `resolve_property` | Address id → BFE, cadastral ids, coordinate |
| `get_buildings` | BBR buildings and units |
| `get_parcel` | Matrikel parcels for a BFE, including fredskov, strandbeskyttelse and klitfredning |
| `get_valuation` | Official VUR values and history |
| `get_trades` | Sale prices and dates from EJF (your own approved OAuth access; no names) |
| `get_admin_areas` | Municipality, region, parish, court and police districts |
| `get_plans` | Local plans, subareas, frameworks with building rights, zone, plan proposals |
| `get_site_conditions` | Heat supply, sewer, flood/erosion, groundwater, noise, livestock, planned roads/facilities, heritage |
| `get_environment` | Soil contamination on the property vs nearby, coastal zone |
| `get_heritage` | SAVE value 1–9 and listed status (FBB) |
| `get_terrain` | Terrain height (DVR90), highest surface nearby, and whether the plot lies in a hollow |
| `get_property_location` | EBR location for a BFE: street address, or a text designation when there is no address |
| `get_aerial_photo` | Spring orthophoto and a cropped skråfoto facade (needs a Dataforsyningen token) |
| `get_nearby_services` | Distance to nearest school, daycare, shop, doctor and sports hall (BBR) |
| `get_local_statistics` | Parish statistics and regional price index / average sale price |
| `watch_property` / `check_watchlist` / `list_watchlist` / `unwatch_property` | Watch properties and report what changed since the last check |
| `get_energy_label` | Energimærke (needs EMOData) |
| `get_area_stats` | Municipality statistics from DST |
| `property_report` | Combined report with investor flags (~4–8k tokens) |
| `screen_properties` | Up to 25 addresses side by side |
| `list_sources` | Which sources are configured |

BBR labels come from the official Danish code lists (`pnpm codes:update` regenerates them). Plans and overlays are looked up at the main building's BBR coordinate, which lies inside the plot, not at the address point by the road.

### Investor flags

`property_report` and `screen_properties` add `flags`, each with `severity` (`high`, `medium`, `info`), a Danish `title` and `detail`, and the sources behind it. They are signals for further checks, not advice. The building rights headroom is an estimate: it compares BBR floor area (basement and outbuildings excluded) with the framework's max plot ratio for the matching usage.

Every tool returns a `SourceResult`: either `{ status: "ok", source, fetchedAt, data }` or `{ status: "unavailable", source, reason, detail }`.

## Access tiers

| Tier | Meaning | Examples |
|---|---|---|
| T0 | Open | Adressevælgeren, Plandata, Miljøportal, FBB, DST |
| T1 | Free key | Datafordeleren GraphQL, Dataforsyningen |
| T2 | Agreement | EMOData energy labels |
| T3 / X | Not built | Tingbog; private owner names |

See [docs/credentials.md](docs/credentials.md) for how to get each key.

## Environment

| Variable | Required for |
|---|---|
| `DATAFORDELER_API_KEY` | BFE chain, BBR, VUR, DAGI |
| `DATAFORDELER_OAUTH_CLIENT_ID` / `_SECRET` | Sale prices from EJF, after Geodatastyrelsen approves your own request. Never owner names |
| `ADRESSEVAELGER_TOKEN` | Optional; defaults to `adressevaelger123` |
| `EMODATA_USER` / `EMODATA_PASSWORD` | Energy labels |
| `DATAFORSYNINGEN_TOKEN` | `get_aerial_photo` |
| `CACHE_PATH` | SQLite cache file (default `~/.cache/boligmcp/cache.db`) |
| `BOLIGMCP_CREDENTIALS_FILE` | Override the credentials file path |
| `BOLIGMCP_ENV_FILE` | Development only: load this `.env` file |

## Development

```bash
pnpm install
pnpm test
pnpm dev
```

After you have a Datafordeleren key:

```bash
pnpm smoke "Egeskovvej 41, 8800 Viborg"   # live property_report
pnpm live                                  # live regression suite (docs/test-plan.md); pnpm live resolve_property, pnpm live --group core
pnpm exec tsx scripts/probe-fields.ts BBR BBR_Bygning '{"id_lokalId":{"eq":"<id>"}}' byg057Opvarmningsmiddel
```

Introspection is disabled on Datafordeleren, so `probe-fields.ts` asks for one field at a time and reports which exist.

## Licence

MIT
