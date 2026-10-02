# Changelog

## Unreleased

### Privacy
- Every Datafordeleren query is checked before it is sent: one that mentions CVR's people, `EJF_Ejerskab`, owner names or details, or a CPR field is refused (`PRIVACY_BLOCKED`).
- The server instructions tell the agent that Bolig-MCP never returns data about private people, and never to try to identify a private owner by other means.
- `AGENTS.md` sets the same rules for contributors and their coding agents, and the README has a Privacy section.

### New
- `get_map`: a photorealistic 3D view of the property in the browser (Maps JavaScript API, preview), with a white outline of the building and a slow orbit. The user's own `GOOGLE_MAPS_API_KEY` stays in the local page; the tool returns only a localhost URL. `property_report` includes the same view as `map`, so an HTML report can embed it instead of using only the government aerial.
- `get_company`: public CVR data for a CVR number (name, status, form, address, industry, head count, reklamebeskyttelse, fully liable participants of an I/S or K/S). Same Datafordeleren API key; people in CVR are counted, never named.
- `get_owners`: current owners from EJF's `CustomEjerskabBegraenset`, the ownership service private actors may be granted. A company owner comes with its CVR data; a private owner is only "privatperson" and a share, with no name or CPR number. Needs that entity approved on top of the EJF access for sale prices.
- `property_report` lists owners in `summary.owners` and flags a company owner that is not active in CVR (`owner_company_inactive`), plus `owner_company` for company-owned property.

## 0.2.0 (2026-09-27)

First release on npm: `npx -y boligmcp`.

### New
- Live regression suite: `pnpm live` runs the cases in `tests/live/cases/` through the real server against the live registers, also as built (`--dist`); `pnpm live:sample` checks reports for random addresses (see docs/test-plan.md).
- `get_property_location`: EBR beliggenhed for a BFE. A street address when one exists, otherwise the text designation used for a property with no address. Same Datafordeleren API key as BBR.
- `get_aerial_photo`: GeoDanmark spring orthophoto plus a cropped skråfoto facade. The crop uses Klimadatastyrelsen's published camera formula and the public COG. The token is sent as a header and never put in an image URL.
- `get_energy_label` calls Energistyrelsen's `SearchEnergyLabelBFE` endpoint. It still needs the user's own EMOData agreement.

### Fixes
- Statistics hold up when several reports run: 12 Statistikbanken requests per report instead of 17, and throttled answers are waited for rather than aborted.
- A town with "oe" in its real name (Boeslunde) no longer gets a false `matchWarning`.
- BBR code 5 (medieval building parts) is "worth preserving", not a listed building.
- `check_watchlist` never reports a source that failed, or was not asked without a key, as removed plans, buildings or flags, and keeps the old values for it (`notChecked`); a property that could not be looked up is an error, not "no changes".
- A failed soil lookup is listed in `failedLayers` instead of reading as "no contamination"; `get_terrain` always carries its own `lookupPoint`.
- A street address without a unit of its own reports the whole property's dwelling area, not the first building's (Gudrunsvej 8: ≈100.600 m², not 10.850 m²).
- Price and valuation per m² use the area the BFE covers: a rental flat's own area only divides a condominium's figures.
- Without a Datafordeleren key the report and screening say valuation and sales were not looked up.
- Statistikbanken requests give up after 4 s and retry, so one stalled request no longer drops a report's statistics; parallel reports share one EJF token request.
- A report for an address that was not found lists only why, not credential hints for sources it never asked.
- `get_area_stats` gives the DAGI municipality code ("0791") and lists Statistikbanken tables that failed; `get_local_statistics` says why there is no market series.
- `get_environment` says when the property's parcels were unknown (`parcelsChecked: false`), because a locality on the property can then look like a neighbour's, and lists soil layers that did not answer.
- Every address tool accepts `bfe`, so plans, terrain, heritage and the rest work for a property without a street address; the lookup point is then `parcel`.
- Site conditions list an item once, and a bare plan code ("23er058") is shown with the plan's name.
- A rolled-back EJF ownership change is no longer shown as a sale: Egeskovvej 41 sold for 550.000 kr. in 1990, not 275.000 kr.
- A valuation revised within the year is not added to its original as a second part (Egeskov 2003 showed 80.5M kr.).
- A unit that is not a home (a school, a shop) has no dwelling area; its total area is `totalArea`.
- `unitsTotal` counts every building's units, not a capped sample of five (Gudrunsvej 8: 1.155, not 390).
- BBR buildings in lifecycle 12 ("midlertidig afsluttet") are dropped like demolished ones.
- A house letter typed apart ("Egeskovvej 41 A") is part of the number. It was dropped and no. 41 returned without a warning.
- `matchWarning` says when the postcode and town disagree ("Egeskovvej 41, 8800 Aarhus": 8800 is Viborg).
- A village that is not a postal town ("Slotsgaden 5, Møgeltønder") is found through DAR's supplementary town names; it resolved to Copenhagen before. In that town a street differing only by its ending wins, with a warning.
- Queries longer than the search's 73-character limit are cut at a whole word instead of failing with HTTP 400. A number typed first ("41 Egeskovvej") is moved after the street.
- `resolve_property` without a Datafordeleren key says under `missing` that the BFE needs one, instead of leaving it out silently; an address with no registered BFE says that too.
- Unknown tool arguments ("adress", "maxResults") are an error naming them instead of being ignored. `search_address` says when an address is outside Denmark.
- Heritage in towns counts only the property's own address; neighbours are `atProperty: false`. Distance is used only on spread-out estates, where each building claims its nearest FBB point within 25 m. Møgeltønder and Ribe flagged the listed houses next door.
- A postcode after a comma, before a town or at the end is a postcode, not a house number: "Egeskovvej, 8800 Viborg" was read as no. 8800 and resolved to no. 1. A street without a number now asks for one and suggests some.
- Queries are cleaned before searching and matching: "c/o …" lines, "the house at … in …", "egeskovvej41" and "2.tv".
- Addresses outside Denmark (Greenland, the Faroes, abroad) are said to be out of scope instead of pointing to a BFE lookup.
- Suggestions search around the requested number, not just the first 20 on the street.
- `screen_properties` rows list `notChecked` sources, so a missing key no longer looks like a clean property.
- `bfe` is accepted as a number, `screen_properties` accepts a single address string, and `resolve_property` takes `bfe`. Every tool parameter has a description.
- No regional house-price statistics for commercial and public buildings, which have no such series.
- An address with no BFE (state land such as Christiansø) says so under `missing`.
- Site-condition flags write a plan code once, next to readable text ("23er058; 23er058" before).
- A watchlist entry added without a Datafordeleren key is found again and takes the BFE as id once there is one, instead of being added twice.
- `matchWarning` also catches another street ("Bassin 7, Aarhus" found Bassinvej 7, Rødby), a town that was not found ("Sankt Knuds Torv 1, Odense" is in Aarhus) and a range of numbers ("41-43").
- A town given without postcode is looked up in DAGI and searched again with its postcodes: "Torvet 1 Ærøskøbing" found Frederiksværk before.
- Addresses are parsed as people type them: floor and door without commas ("Istedgade 50 3 th"), "1 sal", ranges and towns. "aa" is kept in town names (Aabybro) and "å" tried second.
- A query that finds nothing suggests the nearest numbers on the same street ("Did you mean: Vestergade 1B, 8000 Aarhus C; …"), in `search_address` too.
- `property_report` and `screen_properties` take a BFE, so properties without a street address get a report; their position is the parcel centroid.
- The last sale prefers a market sale ("fri handel") over family transfers and similar; the summary carries `lastTradeType`. The price per m² is only given for a single unit or the property's dwelling area, not one unit of many.
- Area composition is one flag for the property, not one per building (13 at Gudrunsvej 8).
- A street address with no units of its own (a block of flats) shows its buildings' units, and tenure counts say when they are a sample.
- A property valued at 0 kr. in every year gets a note and an info flag; the old-valuation flag is info, not medium, for commercial property, which the new system has not reached.
- `watch_property` refuses an address that is not an exact match unless `allowMismatch` is set.
- Parallel reports share identical requests while they are in flight, and Statistikbanken gets at most four at a time: 7 of 10 parallel reports lost their statistics before, none now.
- Address lookups take the best search match. The resolver skipped house-number hits, so "Strandvejen 100 Hellerup" and "Rådhuspladsen 1" landed in Frederiksværk and "Nyhavn 18" in its basement flat.
- A town given without a postcode ("Boulevarden 1 Aalborg") now ranks first, and ASCII or English spellings ("Noerrebrogade", "Koebenhavn", "Copenhagen", "HC Andersens Blvd") are tried when nothing matches. Emoji and symbols are stripped; queries are capped at 200 characters.
- `matchWarning` says when the address found is not the one asked for: a floor or door that does not exist, another number, or the same address in other towns when no postcode was given. It used to swap in another flat silently.
- Search hits carry floor, door, house number and postcode, read from the title.
- Every address tool takes `query` or `addressId`, and `addressId` also accepts a house-number id (the only id many search hits have). Ids are trimmed and lower-cased; a bad id falls back to `query` when both are given. BFE inputs must be whole numbers.
- A flat that is a condominium gets its own BFE (from EBR), with the land-holding property as `mainBfe`. Valuation, sales and reports described the whole building before. `get_parcel` follows a condominium BFE to its property's parcels.
- `get_buildings` uses `bfe` (it was ignored) and finds a flat's building through its units, and a property's buildings on its parcels when nothing is registered at the address. Nyhavn 18A and Søndervig summer-house plots had no buildings.
- The main building is a dwelling before other uses, then the building at the address, then the largest. A 1743 barn was Egeskov's main building.
- Building rights headroom is only estimated when BBR has floor areas. Store Torv 1, Rønne showed 730 m² headroom with no area data.
- Parcels with pending changes ("Ikke gennemført") no longer count, which doubled some plot areas.
- The last sale is the latest sale with a price, in the summary, screen and watchlist alike; unpriced transfers were shown as sales. EJF's 1969-12-31 placeholder date is dropped.
- A property valued in parts in one year is added up (`parts`): Egeskov showed 120,700 kr. instead of 73,120,700 kr. A newer 0 kr. valuation is explained in `note` instead of silently skipped.
- Heritage marks `atProperty` and flags only the property's own buildings; neighbours on Nyhavn were flagged as listed. The lookup covers all of a property's buildings.
- Double-encoded plan texts from Plandata are repaired ("OmrÃ¥de" → "Område").
- Statistics say their level (`municipality`, `parish`, `landsdel`); parish figures were labelled as a municipality.
- A report for an address that is not found has an empty summary and no false "missing DATAFORDELER_API_KEY" hint.
- The report trims large estates to 8 buildings and 5 units with totals, and tool output is compact JSON (about a third fewer tokens).
- `screen_properties` marks rows that are the same property, shows the old-system valuation when there is no new one, and carries `matchWarning`.
- The watchlist is never overwritten when the file cannot be read, is written atomically, and watching a property again keeps its baseline.
- Error messages no longer include request query strings. The Adressevælgeren token could appear in an error.
- GraphQL filters are serialised field by field with escaped strings; a value containing `":` broke the query.

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
