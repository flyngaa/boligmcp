# Test plan

Every tool is tested on its own against live registers, one tool at a time, core first. Each case written here
becomes a case in the live regression suite, so the plan and the safety net are the same thing.

## Principles

1. **Never silently wrong.** A result is right, carries a warning (`matchWarning`, `note`, `notChecked`, `missing`),
   or is left out. A wrong number without a warning is the worst outcome and blocks a release.
2. **Invariants over snapshots.** Registers change (new valuations, sales, plans). Cases assert what must hold
   ("the BFE is the flat's own", "plot area equals the sum of current parcels") and pin exact values only where they
   cannot change (ids, construction year, historic sales).
3. **Real data only.** Mocked unit tests stay for parsing and rules; this plan is about what the registers actually return.
4. **One tool at a time.** A bug is found where it lives, fixed with a unit test and a live case, and the tool's group
   is rerun before moving on.

## Severity

| Level | Meaning | Release |
|---|---|---|
| S1 | Wrong answer without warning (wrong property, wrong figure, false flag, missed flag) | Blocks |
| S2 | Wrong answer with a warning, or no answer where one exists | Blocks unless documented |
| S3 | Missing data explained correctly, unclear text, slow, large output | Fix or log |
| S4 | Cosmetic | Log |

## The live regression suite

- `tests/live/cases/<tool>.json` holds the cases for one tool; `scripts/live-regression.ts` runs them through the
  real MCP server over stdio, as a client would.
- `pnpm live` runs everything, `pnpm live get_valuation` one tool, `pnpm live --group core` one group.
- Needs the user's own credentials (`.env`), so it runs locally and before every release, not in public CI.
- A case is `{ id, tool, args, expect, stable }`. Assertions:
  - `equals` / `matches` (regex) / `oneOf` on a JSON path, e.g. `data.bfe`, `summary.lastTradeType`
  - `present` / `absent`, e.g. `summary.matchWarning` absent for an exact match
  - `range` for numbers, e.g. plot area 800–820
  - `sameAs` another case's path, for consistency across tools and input forms
  - `contains` (an array has an element equal to, or matching, the value) and `notMatches`
  - `maxTokens` for output size, `maxMs` for time
- Paths: `data.buildings[0].usage`, `data.length`, `data[*].price` (all elements). `$text` is the raw output, `$isError`
  the MCP error flag (argument validation), `$images` the number of images, `$watchlist` the watchlist file after the call.
- `env: "no_credentials"` runs a case on a server with no credentials at all (C5).
- `sequence` runs stateful cases (the watchlist) one after another in file order on their own server and temporary
  watchlist file; `setup.watchlist` writes the file first, `setup.editWatchlist` changes one path in it.
- `pnpm live <tool or case file>`, `--group <name>` (repeatable), `--case <id>`, `--concurrency <n>`, `--verbose`,
  `--dist` (the built server, as published) and `--credentials-file` (no `.env`, only the user's setup file).
  Every result is written to `tests/live/.last-run.json`.
- `stable: false` values are reported as **drift** (warning, not failure) with old and new value, so a new valuation
  is reviewed rather than failing the run.
- Output: pass/fail/drift per case, grouped by tool, and a summary line that release checks read.

## Fixture properties

Reused across tools; each exercises something specific. Facts were verified live in test rounds 1–4.

| Key | Query or id | What it exercises | Known facts |
|---|---|---|---|
| villa | Egeskovvej 41, 8800 Viborg | Ordinary house, new valuation, gas heating | BFE 3451459, built 1952, 144 m², plot 811 m², sale 550.000 kr. 1990 (a rolled-back 275.000 kr. row is not a sale) |
| condo_1 | Frederiksberg Allé 10, 1., 1820 Frederiksberg C | Condominium with its own BFE | BFE 189290, main BFE 100025920, sale 28.400.000 kr. 2022-10-14 |
| condo_main | Frederiksberg Allé 10, 1820 Frederiksberg C | Main property of condominiums | BFE 100025920, all valuations 0 kr. |
| condo_floors | Frederiksberg Allé 10, st./1./2./3./4. | One BFE per floor | 189289, 189290, 189291, 189292, 189293 |
| rental_doors | Istedgade 60, 2. tv / th / mf, 1650 København V | Rental flats, doors | All BFE 6024040, units 68 / 119 / 62 m² |
| no_floor | Istedgade 50, 3. th, 1650 København V | Floor and door that do not exist | Resolves to st. with matchWarning |
| house_number | Nyhavn 18 | Hit with only a house-number id; no floorless address | BFE 6033799, listed (FBB), plot 500 m² |
| sibling | Nyhavn 18A, 1051 København K | Flats in a building registered at another number | Building b04f6855… at Nyhavn 18 |
| estate | Egeskov Gade 18, 5772 Kværndrup | Estate, valuation in two parts, fredskov | BFE 9519007, 2020: 73.120.700 kr. (2 parts), 20 buildings |
| castle | Egeskov Gade 26, 5772 Kværndrup | Listed building, separate property | BFE 9426462, listed |
| pending_parcel | Lodbergsvej 10, Søndervig, 6950 Ringkøbing | Pending parcel version, zero valuation, buildings via parcel | BFE 10229320, plot 1.640 m², sale 3.500.000 kr. 2008-01-14 |
| empty_bbr | Store Torv 1, 3700 Rønne | BBR buildings with no data | BFE 5405841, no building-rights estimate |
| no_address | BFE 1329894 | Forest without street address | "Haundrupvej 3X", fredskov, family transfer 153.000 kr. 2009 |
| no_bfe | Christiansø 1, 3760 Gudhjem | Address without BFE | missing: matrikel not_found |
| school | Levantkaj 4, 2150 Nordhavn | Commercial/public, soil contamination | BFE 100074116, no market statistics |
| big_block | Gudrunsvej 8, 8220 Brabrand | 1.155 units in 13 blocks, 3 under construction | Units sampled, tenure counts marked as sample |
| multi_unit_sale | Dortesvej 1, 8220 Brabrand | Sale of property with several units | No price per m² |
| rural | Grønbjergvej 28, Grøntoft, 6971 Spjald | Private water, septic, landzone | Water code 2, drainage 29 |
| summer_house | Klitrosevej 3, 6950 Ringkøbing | BBR usage 510, summer-house zone | Market category summer_house |
| noise_code | Vesterhavsvej 5, 6960 Hvide Sande | Site condition with only a plan code | Code 23er058 shown once |
| town_heritage | Torvet 1, 6760 Ribe | Listed, dense neighbours | Only Torvet 1 atProperty |
| town_no_entry | Slotsgade 5, Møgeltønder, 6270 Tønder | No FBB entry for the property | No neighbour counted |
| soil_nearby | Borgergade 1, 7200 Grindsted | V1/V2 nearby, not on property | onProperty false |
| coast | Fyrvej 36, 9990 Skagen | Coast, flood risk, low terrain, landzone inferred | Terrain ≈ 2.2 m |
| ambiguous | Rådhuspladsen 1 | Same address in several towns | København V + matchWarning |
| town_no_postcode | Boulevarden 1 Aalborg; Torvet 1 Ærøskøbing | Town without postcode | Aalborg; Ærøskøbing via DAGI retry |
| not_found | Vestergade 1, 8000 Aarhus | Number that does not exist | Suggests 1B, 1C, 2A |
| foreign | Aqqusinersuaq 1, 3900 Nuuk | Outside Denmark | "Only addresses in Denmark" |

## Groups and tools

Each tool lists its guarantees and cases. Every tool also gets the **common cases**:

- C1 each accepted input form (query, addressId, houseNumberId, bfe as string and number) gives the same result
- C2 empty input, wrong type and unknown parameter give a clear error
- C3 not-found and foreign input give the right message
- C4 output under the tool's token limit, compact JSON
- C5 without credentials: `missing_credentials` with a setup hint, never an empty "clean" result

### Group 1 — resolution

Also in this group: find out whether Adressevælgeren has structured lookups (by postcode or street) that could
replace free-text guesses.

**search_address** — finds candidates in a sensible order; never claims a match it did not make.

| Case | Input | Expect |
|---|---|---|
| exact | villa | first hit is the address, floor/door/postcode parsed |
| typo | Egskovvej 41 Viborg; Strandvejen 100 Helerup | right address first |
| ascii | Noerrebrogade 1, 2200 Koebenhavn N; HC Andersens Blvd 2 Copenhagen | Danish spelling found |
| town_first | Boulevarden 1 Aalborg | Aalborg first |
| building_before_flat | Nørrebrogade 1, 2200 København N | floorless address first |
| suggestions | not_found | `suggestions` near number 1 |
| limits | limit 1, 20, 21, 0; 3000-character query; emoji | validated, no upstream error |

**resolve_property** — the one address and property meant, or a warning saying what differs.

| Case | Input | Expect |
|---|---|---|
| exact | villa, condo_1, house_number | right BFE, no matchWarning |
| condo | condo_floors | own BFE per floor, mainBfe 100025920 |
| ambiguous | ambiguous | København V + warning naming other towns |
| mismatch_unit | no_floor; Istedgade 50 3 th; Istedgade 60, 2.tv | warning or exact door |
| mismatch_street_town | Bassin 7, Aarhus; Sankt Knuds Torv 1, Odense; Havnen 1, 9990 Skagen | warning names street and town |
| town_retry | town_no_postcode | right town without warning |
| no_number | Egeskovvej, 8800 Viborg | asks for a number, suggests some |
| cleanup | c/o Hansen, …; egeskovvej41 viborg; the house at Nyhavn 18 in Copenhagen | resolves, no false warning |
| ids | house-number id; uppercase id; id with spaces; bad id + valid query | resolves; falls back to query |
| bfe | no_address; condo_1 BFE | EBR designation / the flat |
| foreign / no_bfe | foreign; no_bfe | out-of-scope message; resolves without BFE |

#### Group 1 results (round 5, 2026-09-26)

Cases: `tests/live/cases/search_address.json` (22), `tests/live/cases/resolve_property.json` (62). All pass.

| Finding | Severity | Fix |
|---|---|---|
| "Egeskovvej 41 A, 8800 Viborg" resolved to no. 41 without warning; the lone letter was read as a town | S1 | `cleanQuery` joins it to the number; not found now suggests no. 41 |
| "Egeskovvej 41, 8800 Aarhus": postcode and town disagree, no warning | S1 | `matchWarning`: "8800 er Viborg, ikke Aarhus" |
| "Slotsgaden 5, Møgeltønder" (village, no postcode) resolved to Slotsgade 5, København N, with warning | S2 | Town retry falls back to DAR supplementary town names; in the town asked for, a street differing only by its ending wins |
| Query over 73 characters: `upstream_error` HTTP 400 from the search | S2 | Cut at a whole word within 73 |
| "41 Egeskovvej, 8800 Viborg" asked for a house number | S2 | Number typed first is moved after the street |
| Without credentials `resolve_property` returned the address with no BFE and no reason | S2 | `missing: [{ field: "bfe", reason: "missing_credentials" }]`; `not_found` when DAR has none (Christiansø) |
| Unknown arguments silently ignored | S3 | Every tool's arguments are strict; the error names the key |
| `search_address` gave a plain "No matches" for Nuuk | S3 | Out-of-scope message as in `resolve_property` |
| Empty `resolve_property` did not mention `bfe` | S4 | "Provide query, addressId or bfe" |

**Adressevælgeren structured lookups.** Probed live: there is no postcode or street filter parameter (`postnr`,
`postnummer` and `filter` are ignored) and no `/postnumre` or `/vejnavne` endpoint. What exists: `kommunekode` on
`/adresser/soeg` does filter (Slotsgade 5 + 0550 gives only Tønder municipality); a postcode inside the text acts as a
filter ("Slotsgade 5 6270" finds only Slotsgaden 5, Møgeltønder); `/husnumre/soeg` searches house numbers only;
`/adresser?id_lokalids=…` looks up several ids at once. So postcode-in-text stays the retry, with DAGI postcodes and DAR
supplementary town names to find the postcode. `kommunekode` could narrow a search once the municipality is known.

### Group 2 — property registers

**get_buildings** — the property's buildings with the main one first; the address's own units.

| Case | Input | Expect |
|---|---|---|
| house | villa | main 120, carports after, 1 unit 144 m² |
| by_bfe | house_number BFE 6033799 | buildings found |
| sibling | sibling | building at Nyhavn 18 found |
| via_parcel | pending_parcel | buildings from parcel |
| estate | estate | residence first, 20 buildings |
| block | big_block | units sampled with unitsTotal |
| empty | empty_bbr | buildings with no areas, no invented figures |
| ended | a property with demolished buildings | lifecycle 9/10/11/14 dropped |

**get_parcel** — current parcels only; a condominium's BFE gives its main property's land.

| Case | Input | Expect |
|---|---|---|
| single | villa | 811 m² |
| pending | pending_parcel | one parcel, 1.640 m² |
| multi | estate | several parcels, fredskov notes |
| condo | condo_1 BFE 189290 | parcel 76f, 1.182 m² |
| unknown | BFE 999999999 | not_found |

**get_valuation** — latest valuation, systems apart, parts added, zero explained.

| Case | Input | Expect |
|---|---|---|
| new_system | villa | latestNew 2022, latestOld 2020 |
| parts | estate | 2020 parts 2, 73.120.700 kr. |
| zero_newer | pending_parcel | latest 2007, note on 2020 = 0 |
| all_zero | condo_main | note "Alle vurderinger er 0 kr." |
| condo | condo_1 | the flat's own valuation |
| commercial | school | old system only |

**get_trades** — sales newest first, market sales identifiable, no placeholder dates, no identities.

**get_owners** — a company owner by CVR with its CVR data; a private owner only as `private_person` with a share; never a CPR number or a private person's name, and the query never asks for `ejendePersonBegraenset`. `requires_agreement` until `CustomEjerskabBegraenset` is approved.

**get_company** — name, form, status and address for a CVR number; people in an I/S or K/S counted, never named; no head count older than two years (Datafordeleren's copy stopped in 2019).

| Case | Input | Expect |
|---|---|---|
| sale | villa | 550.000 kr. 1990-07-31; the rolled-back 275.000 kr. row is left out |
| placeholder | house_number | no 1969-12-31 date |
| unpriced | pending_parcel | "Ikke oplyst" entries without price, 2008 sale present |
| family | no_address | Familieoverdragelse flagged by transferType |
| privacy | any | query never touches owner or deed fields |
| no_oauth | without EJF credentials | missing_credentials / requires_agreement |

**get_property_location** — EBR location for a BFE.

| Case | Input | Expect |
|---|---|---|
| address | villa BFE | hasStreetAddress true |
| condo | condo_1 BFE | addressId, hasStreetAddress true |
| none | no_address | designation "Haundrupvej 3X", hasStreetAddress false |

#### Group 2 results (round 5, 2026-09-26)

Cases: `get_buildings` (18), `get_parcel` (10), `get_valuation` (10), `get_trades` (7), `get_owners` (3), `get_company` (6), `get_property_location` (5). All pass.

| Finding | Severity | Fix |
|---|---|---|
| Egeskovvej 41's 1990 sale shown as 275.000 kr.: EJF keeps a rolled-back row (`status: tilbagerullet`) next to the current 550.000 kr. The fixture and the report's last sale had the rolled-back figure | S1 | Rolled-back, annulled and deleted ownership changes are dropped |
| Egeskov 2003 valuation 80.5M kr. "3 parts": the January valuation and its October revision (area 2 % larger) were added up | S1 (history) | Same-year rows with areas within 5 % are one valuation, newest wins |
| A school unit (Levantkaj 4) had `dwellingArea` 25.443 m², its total commercial area; the report summary used it | S1 | Total area is dwelling area only for a home (usage 1xx, 51x, 54x) without commercial area; units get `totalArea` |
| Gudrunsvej 8 `unitsTotal` 390: counted from 5 of 13 blocks, 100 units each. There are 1.155 | S1 | When the sample is partial, every main building's current units are counted |
| Istedgade 60 listed two empty copies of its building (BBR lifecycle 12, "midlertidig afsluttet") | S2 | Lifecycle 12 dropped with 9, 10, 11, 14 |
| Levantkaj 2015 valuation "2 parts": a later all-zero row without area counted as a part | S3 | Ignored when the year has a real valuation |
| `get_trades` said unpriced entries are never sales; Lodbergsvej's 2008 sale has an unpriced second record | S3 | Description says transferType tells them apart |
| A condominium's valuation has `valuedArea: 0` (the register's value) | S3 | Logged |
| Buildings under construction (lifecycle 3) are listed with no areas | S3 | Logged; correct, not yet labelled |

### Group 3 — land and surroundings

Each tool is looked up at the main building (not the road point); the response says which.

**get_plans** — plans covering the property, zone, framework limits, proposals.

| Case | Input | Expect |
|---|---|---|
| framework | villa | HALD.B1.01, byzone, no local plan |
| local_plans | condo_1 | 3 local plans |
| rural | rural | landzone inferred |
| summer | summer_house | sommerhusområde |
| text | pending_parcel | no mojibake |

**get_site_conditions**

| Case | Input | Expect |
|---|---|---|
| coast | coast | flood/erosion risk, cultural environment |
| heat | villa | heat supply area named |
| code_only | noise_code | code once, readable text |
| failed_layer | a layer that errors | listed in failedLayers, not silently dropped |

**get_environment**

| Case | Input | Expect |
|---|---|---|
| on_property | estate; school | onProperty true |
| nearby | soil_nearby | onProperty false |
| coastal | coast | coastal protection zone |
| condo | condo_1 | parcel refs from the main property |

**get_heritage**

| Case | Input | Expect |
|---|---|---|
| own | house_number; town_heritage | own address atProperty, neighbours false |
| no_entry | town_no_entry | no neighbour atProperty |
| estate | castle | listed, atProperty |
| none | villa | empty |

**get_terrain**

| Case | Input | Expect |
|---|---|---|
| low | coast | ≈ 2.2 m, low-terrain flag in report |
| normal | villa | ≈ 29.8 m |
| no_address | no_address | from parcel centroid |

#### Group 3 results (round 5, 2026-09-26)

Cases: `get_plans` (8), `get_site_conditions` (5), `get_environment` (8), `get_heritage` (5), `get_terrain` (5). All pass.

| Finding | Severity | Fix |
|---|---|---|
| Without a Datafordeleren key, Levantkaj 4's own V1/V2 locality came back `onProperty: false`, with nothing saying the parcels were not checked | S1 | `parcelsChecked: false` and a note that onProperty then rests on the lookup point alone |
| A soil layer that failed was dropped silently, so the result looked clean | S2 | `failedLayers` and a note; all layers failing is `upstream_error` |
| The location tools took no `bfe`, so a property without a street address (Haundrupvej 3X) could not be looked up | S2 | Every address tool accepts `bfe` |
| A parcel centroid was labelled `lookupPoint: address` | S3 | `lookupPoint: parcel` |
| Hvide Sande's noise area listed twice, as the bare code "23er058" | S3 | Identical items merged; a bare code shows the plan's name as value and `kode 23er058` in details |
| A soil locality over 21 parcels listed 21 certificate links; a name ended in a newline | S3 | Three links and a count; text trimmed |

### Group 4 — area and extras

**get_admin_areas** — municipality, region, parish, court, police for villa, no_address (centroid), no_bfe (Christiansø municipality).

**get_area_stats** — municipality level labelled `level: municipality`; codes match DAGI; timeout gives `upstream_error`, not zeros.

**get_local_statistics** — parish labelled `level: parish`; market only for residential (villa house, condo_1 apartment,
summer_house summer_house, school none).

**get_nearby_services** — distances plausible (school in Grindsted 250 m); rural summer house with none within 1 km
gives nulls, not zeros.

**get_energy_label** — without EMOData: missing_credentials with setup text; accepts BFE and address; never asks for
credentials in chat.

**get_aerial_photo** — image returned, token never in any URL, facade optional, no_address uses the centroid.

#### Group 4 results (round 5, 2026-09-26)

Cases: `get_admin_areas` (4), `get_area_stats` (3), `get_local_statistics` (5), `get_nearby_services` (3),
`get_energy_label` (3), `get_aerial_photo` (3). All pass.

| Finding | Severity | Fix |
|---|---|---|
| `get_area_stats` gave `municipalityCode: "791"`, DAGI and `get_admin_areas` "0791" | S3 | DAGI's form; `areaCode` keeps Statistikbanken's |
| A Statistikbanken table that failed left its figure out without saying so | S3 | `failedTables` |
| `get_local_statistics` left `market` out for a school without saying why | S3 | `market.reason` |
| `get_local_statistics` takes 15–22 s on a cold cache; the time is Statistikbanken's | S3 | Logged; `property_report` keeps its 15 s deadline |
| The aerial photo of a property without buildings still crops a "facade" | S4 | Logged |

### Group 5 — combined tools

**property_report** — the summary agrees with the single tools.

| Case | Input | Expect |
|---|---|---|
| consistency | villa, condo_1, estate, pending_parcel | summary BFE, valuation, plot, last sale, main usage, local plans `sameAs` the single tools |
| input_forms | villa by query / addressId / houseNumberId / BFE | identical reports |
| not_found | foreign; Christiansø 3 | empty summary, no false credential hint |
| size | estate; big_block; Tivoli (Vesterbrogade 3) | ≤ 10.000 tokens, trimmed with totals |
| flags | each fixture | expected flags present, no flag from a neighbour or a sample presented as total |
| load | 10 reports in parallel, cold cache | no statistics lost, < 20 s |

**screen_properties** — one comparable row per address.

| Case | Input | Expect |
|---|---|---|
| mixed | villa, condo_1, school, no_address (as BFE), foreign | rows in order, errors inline |
| same_property | two addresses of one BFE | sameProperty |
| mismatch | no_floor | matchWarning in row |
| no_credentials | without key | notChecked listed |
| limits | 25 ok, 26 rejected, single string accepted | validated |

#### Group 5 results (round 5, 2026-09-26)

Cases: `property_report` (19), `screen_properties` (7), `property_report_load` (10 reports; run with
`pnpm live property_report_load --concurrency 10`). All pass; the report's summary is checked `sameAs` the single tools.

| Finding | Severity | Fix |
|---|---|---|
| Gudrunsvej 8's summary `dwellingArea` was 10.850 m², the first of 13 blocks, for the whole property | S1 | Without a unit of its own the address gets all main buildings' dwelling area (≈100.600 m²) |
| Valuation per m² (screening) and sale price per m² (last-sale flag) divided the whole BFE's figure by one rental flat's area when the address was a flat | S1 | Divided by the area the BFE covers: the flat's only for a condominium, else the property's |
| Without a key, `missing` / `notChecked` named parcels but not valuation or sales, so they read as "none" | S2 | `vur` and `ejf` listed with `missing_credentials` |
| Statistics lost in 7 of 10 parallel reports, and now and then in single ones: one stalled Statistikbanken request waited 8 s and its retry 8 s more, past the 15 s deadline | S2 | 4 s timeout, three tries; 10 cold reports in parallel now take 8 s with every statistic |
| Ten reports started together fetched ten EJF OAuth tokens (up to 4 s each) | S3 | One token request shared |
| A not-found or foreign address listed "EMOData missing credentials" | S3 | Only the resolution failure is listed |
| Frederiksberg Allé 10: plot ratio uses dwelling + commercial area (2.152 m²), BBR's total is 1.812 m²; both are over the 150 % limit | S3 | Logged: BBR's own figures disagree |
| Lodbergsvej 10: a flood-risk item reads "Terrlnnert grundvand v3", the municipality's text | S4 | Logged |

### Group 6 — watchlist and sources

**watch_property / check_watchlist / list_watchlist / unwatch_property** — in a temporary watchlist file.

| Case | Expect |
|---|---|
| add and change | a changed baseline is reported once, then not again |
| rewatch | baseline kept, note updated |
| mismatch | refused without allowMismatch |
| no_key_then_key | one entry, id becomes the BFE |
| corrupt file | error, file untouched |
| unwatch | by id, address id, query or designation, any case |

**list_sources** — every source listed with tier and configured state; no credential values in the output.

#### Group 6 results (round 5, 2026-09-26)

Cases: `watchlist.json` (21, one sequence covering all four watchlist tools), `list_sources` (3). All pass.

| Finding | Severity | Fix |
|---|---|---|
| A check where a source failed (or, without a key, was never asked) reported plans, buildings and flags as removed, saved that as the baseline, and reported everything as new at the next check | S1 | Parts whose source failed or was not asked are `notChecked`, not compared, and keep their old values |
| A property that could not be looked up during a check showed `changes: []`, i.e. "nothing changed" | S2 | Reported as an error: not checked |
| Terrain cached the caller's `lookupPoint`, so the aerial photo's unlabelled lookup left `get_terrain` without one | S3 | The label is set after the cache |
| A failed soil point query was read as "no locality here" | S2 | The layer is listed in `failedLayers` |
| A watched property with no BFE (Christiansø) never compares flags, since some flag sources are never asked | S3 | Logged |

## Cross-tool checks

- The same property through every input form gives the same ids and summary.
- The report's summary equals the single tools' values (`sameAs`).
- Plot area equals the sum of current parcels; the last sale is the latest market sale in `get_trades`.
- Every figure in a flag can be traced to a field in the report.

## Working method, per tool

1. Write the tool's cases into `tests/live/cases/<tool>.json`.
2. Run them. Record each finding with its severity.
3. Fix S1 and S2: unit test for the rule, live case for the data, change.
4. Rerun the tool and every earlier tool in its group; move on when all pass.

## Status after round 5 (2026-09-26)

All six groups have cases: 246 in `tests/live/cases/`, all passing; `pnpm test` (130) and `pnpm lint` pass. Cross-tool
checks covered: every input form of the villa gives the same report summary; the report's BFE, valuation, plot, last
sale, usage and dwelling area are `sameAs` the single tools; the estate's plot is the sum of its parcels; the last
sale is the rolled-back-free market sale; the sale and valuation per m² flags are checked against their areas.
Open S3/S4 items are logged in each group's table.

## Release checks beyond the fixtures (2026-09-26)

**The published build.** `pnpm live --dist` runs every case against `node dist/index.js` started from an empty
directory, as under npx; `--credentials-file` gives it no `.env`, only the user's own credentials file from
`boligmcp setup`. Both pass all cases. (Found on the way: the runner used to let the user's credentials file fill in
for missing `.env` keys silently; each mode now says which credentials it uses.)

**Random addresses.** `pnpm live:sample [count] [seed]` draws addresses from DAR across the country (a random postal
town, postcode, house number and sometimes a flat) and checks every `property_report` against rules that hold for any
property: resolves without a warning for the register's own text, BFE or a reason, plot = sum of parcels, plausible
areas, years, heights and prices per m², no placeholder dates, a high soil flag only with a locality on the
property, no upstream errors, ≤ 10.000 tokens.

| Finding | Severity | Fix |
|---|---|---|
| Statistikbanken throttles to about two requests a second under steady load; with 4 reports at a time 79 of 100 lost their statistics | S2 | 12 requests per report instead of 17 (one BOL101 request, every period of FOLK1A, SOGN1 and EJ56 at once, EJ56 and EJEN77 in parallel); 6 s timeout and one retry, so throttled answers arrive instead of being aborted and asked again |
| "Baunehøjvej 2, 4242 Boeslunde" warned "4242 er Boeslunde, ikke Boeslunde": the town was respelled ("oe" → "ø") on one side only. It also made watch_property refuse the address | S1 (false warning, introduced in round 5) | Both sides respelled alike; a town is looked up as typed before respelling |
| BBR Fredning code 5 (medieval building parts, nothing registered) raised the high "listed building" flag | S3 | Codes 5, 8, 9 are "worth preserving" (medium); 1–4, 6, 7 stay high |
| Statistikbanken's HTTP 400 for an area a table does not cover (Christiansø has no income figures) was listed as a failed table | S3 | Not listed |
| Nine addresses (e.g. Lille Istedgade 4, Radisehaven 59) have no BBR buildings; Polititorvet 1 only empty and shelved rows | – | Checked by house number, parcel, grund and unit: BBR has none; "No BBR buildings" is right |
| Even with fewer requests, statistics are lost when several reports run in parallel continuously across different areas (82 of 100 at 4 at a time); one report at a time, 40 of 40 were complete | S2, documented | Known limit of Statistikbanken's throttling. The report lists `dst: upstream_error` under `missing`, never zeros |

Sweeps run: seed 1 (100, before the fixes: 81 flagged; after: 100 clean), seed 2 (100, 4 at a time: 82 lost statistics,
nothing else), seed 3 (40, one at a time: 40 clean).

## Exit criteria for release

- All cases pass; drift reviewed and accepted or turned into a fix.
- One full rerun of all groups with no S1 and no undocumented S2.
- `pnpm test`, `pnpm lint` and `pnpm live` green on the release commit.

## Out of scope

- EMOData energy labels with real credentials: only the missing-credentials path is tested until an agreement exists.
- Exact statistics values from Danmarks Statistik: only labels, levels and that numbers are present.
