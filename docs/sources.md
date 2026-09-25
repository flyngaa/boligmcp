# Source verification

Verified 25 September 2026. DAWA is **not** used. DAWA closes 1 October 2026 10:00.

| Source | Endpoint | Auth | CRS | Notes |
|---|---|---|---|---|
| Adressevælgeren | `https://adressevaelger.dk/adresser/soeg` and `/adresser/{id}`, `/husnumre/{id}` | `token` query param, default `adressevaelger123` | ETRS89 / EPSG:25832 | Phonetic search. User management later. |
| Datafordeleren GraphQL | `DAR/v3`, `BBR/v3`, `MAT/v3`, `DAGI/v2`, `VUR/v2`, `EJF/v1` | IT-system API-key. New keys can take 15 minutes. Introspection is disabled. | EPSG:25832 | Chain: `DAR_Adresse` → `DAR_Husnummer` → `DAR_Adressepunkt` (`position { wkt }`) and `MAT_Jordstykke.samletFastEjendomLokalId` → `MAT_SamletFastEjendom.BFEnummer`. VUR via `VUR_BFEKrydsreference`. EJF returns 403 with an API key (needs approved OAuth access). |
| Plandata.dk | `https://geoserver.plandata.dk/geoserver/wfs` | None | EPSG:25832 | Plans: `lokalplan_vedtaget`, `lokalplandelomraade_vedtaget`, `kommuneplanramme_vedtaget_v`, `zonekort_v`, `lokalplan_forslag`, `kommuneplanramme_forslag_v`. Query with `CQL_FILTER=INTERSECTS(geometri,POINT(x y))` at the BBR building coordinate (`byg404Koordinat`); a 40 m bbox reports neighbouring plans as covering. Framework building rights are in `bygpctN`/`maxetageN`/`maxbhjdN` per `anvspecN`; labels from `pdk:theme_pdk_codelist_*_v`. Site layers: see `SITE_LAYERS` in `src/sources/plandata.ts`. Energy zoning uses "Negative/Neutrale områder"; those are not planned facilities. |
| Miljøportal / DKJord | `https://jord.miljoeportal.dk/geo/wfs` | None | EPSG:25832 | Soil V1/V2 (`DKJord:View_V1Flader`, `View_V2Flader`, geometry `Fladegeometri`). Features carry `Lokalitetsejerlavkode` and `Lokalitetsmatrikler`, used to tell on-property from nearby (80 m bbox). Old Azure GeoServer host was retired May 2026. DAI WFS currently redirects to a web app. Coastal zone from Plandata `knz:theme-knz-kystnaerhedszone-polygon` (geometry `the_geom`). |
| FBB | `https://www.kulturarv.dk/geoserver/wfs` | None | EPSG:25832 | `fbb:view_bygning_alle` plus `fbb:view_bygning_fredede` (listed buildings are only on the second). WFS 1.1.0, bbox without a CRS suffix. `bevaringsvaerdi` 1–9 (1 is highest); -1 means not assessed. |
| Danmarks Statistik | `https://api.statbank.dk/v1/data/{table}/JSONSTAT` | None | n/a | Three-digit municipality codes (`791`, not DAGI's `0791`). FOLK1A (omit `Tid=latest`), INDKP101 (needs `INDKOMSTTYPE`), BOL101 (needs `BEBO`), AULP01, BEV107. EJEN77 sales are only by landsdel, so not used. |
| EMOData | `https://emoweb.dk/emodata/emodata.svc/SearchEnergyLabelBFE/{bfe}` | Basic auth (T2) | n/a | Official classification, validity and report link. Stays unavailable until the user has an EMOData agreement. |
| Dataforsyningen | `https://api.dataforsyningen.dk/orto_foraar_DAF` (WMS 1.1.1) and `rest/skraafoto_api/v1.0` | `token` header | EPSG:25832 for the orthophoto; WGS84 bbox for skråfoto search | `get_aerial_photo` returns the spring orthophoto JPEG (100 m window) and an 800×600 skråfoto crop. The crop uses the published `pers:rotation_matrix` formula and reads the public COG. The cogtiler thumbnail service returns 404. |
| EBR | `https://graphql.datafordeler.dk/EBR/v1` | API key | n/a | `EBR_Ejendomsbeliggenhed` by `bestemtFastEjendomBFENr`. `betegnelse` is set when there is no husnummer. |

## ID chain

```
address text
  → Adressevælgeren address-id + house-number-id + ETRS89 coordinate
  → Datafordeleren DAR → jordstykke → BFE
  → BBR / VUR / EJF on BFE
  → DAGI / plans / environment on coordinate
  → DST on municipality code
```

## Known pitfalls

- Condominiums (ejerlejlighed) have their own BFE; the BBR building belongs to the parent property. `mainBfe` is reserved for that case.
- One address can map to several buildings; one building can have several addresses.
- Energy labels are often shared on terraces and apartment blocks — fall back to the access address.
- Convert EPSG:25832 to WGS84 only at output.
- BBR usage / materials / heating are numeric codes. Labels are generated from https://teknik.bbr.dk/kodelister into `src/lib/bbr-codelists.ts`; do not hand-edit.
- Heating fuel is `byg057Opvarmningsmiddel`. `byg058SupplerendeVarme` is supplementary heating (90 = none).
- BBR `byg038SamletBygningsareal` can leave out a used attic; `byg039` / `enh027` include it. Floors (`BBR_Etage`) hold `eta021` used attic and `eta022` basement.
- Outbuildings often have no address; collect them via `BBR_Bygning.grund`. Drop lifecycle `status` 10 (historisk) and 11 (fejlregistreret).
- VUR: fetch every `VUR_BFEKrydsreference`, not the first few (they come oldest first). New-system valuation ids start at 3e14; both systems can hold a 2020 row. The parent property of condominiums can have 0 kr. valuations.
- The Datafordeleren cache key must include fields, page size and temporality.
- Matriklen `MAT_JordstykkeTemaflade` with `status: Gældende` is filtered by `jordstykkeLokalId` (`tematype` is not a filter field). Live theme areas are Strandbeskyttelse, Klitfredning and Fredskov. DAGI `Retskreds` and `Politikreds` use the field `navn` and need the usual temporal arguments.
- Kirkebyggelinje, skovbyggelinje, fortidsmindebeskyttelse, sø- og åbeskyttelse and the current §3 map have no public WFS that answers; DAI still redirects to a web app. `natur:ais_par3` on `wfs2-miljoegis.mim.dk` is the historical AIS layer. GEUS' public WFS is Jupiter groundwater; the 1:25.000 soil map and radon classes have no point service that answered. Storm-surge and cloudburst water depth has no open point service either. `get_environment` stays soil contamination plus the coastal proximity zone, which is separate from strandbeskyttelse.
