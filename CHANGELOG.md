# Changelog

## Unreleased

### New
- `get_property_location`: EBR beliggenhed for a BFE. A street address when one exists, otherwise the text designation used for a property with no address. Same Datafordeleren API key as BBR.
- `get_aerial_photo`: GeoDanmark spring orthophoto plus a cropped skråfoto facade. The crop uses Klimadatastyrelsen's published camera formula and the public COG. The token is sent as a header and never put in an image URL.
- `get_energy_label` calls Energistyrelsen's `SearchEnergyLabelBFE` endpoint. It still needs the user's own EMOData agreement.

### Fixes
- BBR units with lifecycle status historic (10) or misregistered (11) are dropped, as buildings already were. A misregistered unit could add a phantom dwelling to the address.
- A slow Statistikbanken no longer holds up `property_report`: 8 s per request with one retry, and area, parish and market statistics are left out after 15 s. One report took 194 s before this change.
- `planned_sewer_change` is info, not medium, when BBR already has the planned drainage type (the wastewater plan lags behind). Otherwise it says so when the deadline year has passed.
- `private_water` explains a private waterworks (BBR code 2) separately from an own well or borehole.
- Landzone is inferred when no zone polygon covers the point: Plandata's zone map only has byzone and sommerhusområde, so `rural_zone` never fired before.
- `no_local_plan` no longer says a municipal framework applies when there is none.
- Tests no longer write mocked responses to the user's cache. `tests/sources.test.ts` used the real cache file, so after `pnpm test` Copenhagen's municipality statistics showed the fixture's 661,000 for every figure for up to a week. Vitest now always sets `CACHE_PATH=:memory:`.
- BBR also drops buildings and units with lifecycle 9 (afsluttet) and 14 (henlagt), in the property data and in nearby services. A demolished building with no data showed up as a second building on the plot.
- The summary no longer repeats a plan number the framework name already starts with ("R24.B.4.16 R24.B.4.16 - B4").
- A missing GeoDanmark outline is now listed under `missing`.
- VUR tells the new valuation system apart by its id pattern (one digit, then zeros). Old-system ids starting with 386 or 403 were counted as new.

## 0.2.0 — 2026-09-24

Built for investors screening many properties.

### New
- `screen_properties`: up to 25 addresses in one call, one comparable row each (size, plot, heating, zone, new valuation, valuation per m², building rights headroom, high/medium flags).
- `get_site_conditions`: 16 Plandata layers at the property — heat supply and heat plan areas, connection obligation, sewer catchment, wastewater plan, flood/erosion risk, near-surface groundwater, low-lying land, noise, large livestock farms, planned roads and technical facilities nearby, transformation areas and cultural heritage.
- Investor flags in `property_report` (asbestos, oil/gas/electric heating, attic and basement areas, listed or worth-preserving buildings, flood compensation, existing tenancy, private water or drainage, soil contamination on the property vs nearby, rural zone, plan proposals, building rights headroom, valuation age).
- BBR: outbuildings on the same ground, floors with used attic and basement areas, asbestos, listing, flood compensation, revision date, building coordinate; units with tenure, housing type, residential/commercial area and toilet/bath counts; ground water supply and drainage.
- Plans: local plan subareas, plan proposals, framework building rights (max plot ratio, floors, height per specific usage) and framework notes.
- Area statistics: 5-year population change, disposable income, rented and vacant share, unemployment, net migration.
- `scripts/update-bbr-codes.ts` regenerates the BBR code lists from teknik.bbr.dk; `scripts/probe-fields.ts` checks Datafordeleren field names one by one (introspection is disabled).

### Credentials: bring your own
- `boligmcp setup` asks for each user's own keys in the terminal (hidden input), checks the Datafordeleren key and saves them to `~/.config/boligmcp/credentials.json` with mode 600. `setup --show` prints them masked.
- `manifest.json` (MCP bundle 0.3) with sensitive `user_config` fields, so Claude Desktop asks for keys at install.
- Server instructions tell the model to point users to setup and never ask for keys in chat. Missing-credential results say how to get access.
- `list_sources` shows where each credential came from (env or credentials file) and setup steps for missing ones; never values. EJF is no longer shown as configured just because an API key exists.
- `.env` is no longer read from the working directory; only when `BOLIGMCP_ENV_FILE` is set. The cache moved from `./cache.db` to `~/.cache/boligmcp/cache.db`.

### Sale prices (EJF)
- OAuth client-credentials support (`DATAFORDELER_OAUTH_CLIENT_ID` / `DATAFORDELER_OAUTH_CLIENT_SECRET`, asked for by `setup` and the bundle). Tokens are reused until shortly before expiry.
- `get_trades` rewritten to use only `EJF_Ejerskifte` and `EJF_Handelsoplysninger`, the entities private actors can be approved for: takeover and agreement dates, total and cash price, movables, contractor sum, transfer type, with CC BY attribution. It never queries owners, persons or deed text. `EJF_Ejerskab` (public authorities only) is no longer used.
- Field names were confirmed against the live schema: Datafordeleren validates fields before checking access.
- `screen_properties` and flags show the last sale when EJF access is configured.

### More data without new applications
All use the existing Datafordeleren API key or need no key.
- Terrain (`get_terrain`): Danmarks Højdemodel via Datafordeleren WCS. Terrain height in DVR90, highest surface near the building, and position relative to the terrain within 250 m. Flags for low terrain (storm surge screening) and hollows (cloudburst). A small float32 GeoTIFF reader avoids a dependency.
- Building outlines: GeoDanmark photogrammetric outlines matched to BBR by `BBRUUID`. Flags buildings much larger on the map than in BBR (beyond roof overhang), a hint of unregistered extensions.
- Nearby services (`get_nearby_services`): straight-line distance to school, daycare, shop, doctor and sports hall from BBR's spatial search. Stations are left out because BBR does not register most of them.
- Local statistics (`get_local_statistics`): parish population and 5-year change, average age, net migration, employment and education (SOGN1, KMGALDER, KMSTA003, KMSTA005, KMST007A), and the regional price index and average sale price for the property type (EJ56, EJEN77) via `DAGI_Landsdel`.
- Watchlist (`watch_property`, `check_watchlist`, `list_watchlist`, `unwatch_property`): snapshots in `~/.config/boligmcp/watchlist.json`; checks report new valuations, sales, plans, proposals, BBR changes and flags in Danish.

### Fixed
- Datafordeleren cache key ignored the requested fields, so two queries on the same entity with different fields shared one cached answer.
- VUR history stopped at 8 entries from the oldest end (2001–2007). It now returns the full history and keeps the new (2020+) and old systems apart; zero valuations are never reported as latest.
- Plans were matched with a 40 m box and reported neighbouring local plans as covering the property. Plans and overlays now use a point-in-polygon lookup at the main building's coordinate; nearby local plans are listed separately.
- Soil contamination within 80 m was reported as on the property. Localities are now marked `onProperty` only when the point is inside or the locality lists the property's parcel.
- Heating fuel was read from the supplementary-heating field (`byg058`); it now comes from `byg057Opvarmningsmiddel`.
- BBR code tables had wrong labels for roof, wall, heating and ownership codes. All labels now come from the official Danish lists.
- Danmarks Statistik returned nothing: four-digit municipality codes ("0791") and missing required variables for INDKP101 and BOL101.
- Historic and erroneous BBR buildings (lifecycle 10/11) are dropped.

## 0.1.0 — 2026-09-24

- Initial public MCP server for Danish property data.
- Tools: `search_address`, `resolve_property`, `get_buildings`, `get_parcel`, `get_valuation`, `get_trades`, `get_admin_areas`, `get_plans`, `get_environment`, `get_energy_label`, `get_area_stats`, `property_report`, `list_sources`.
- T0 sources work without keys. Datafordeleren and EMOData degrade to `SourceResult.unavailable`.
- DAWA is not used (closes 1 October 2026).
