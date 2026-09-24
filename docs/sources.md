# Source verification

Verified 24 September 2026. DAWA is **not** used. DAWA closes 1 October 2026 10:00.

| Source | Endpoint | Auth | CRS | Notes |
|---|---|---|---|---|
| Adressevælgeren | `https://adressevaelger.dk/adresser/soeg` and `/adresser/{id}`, `/husnumre/{id}` | `token` query param, default `adressevaelger123` | ETRS89 / EPSG:25832 | Phonetic search. User management later. |
| Datafordeleren GraphQL | `DAR/v3`, `BBR/v3`, `MAT/v3`, `DAGI/v2`, `VUR/v2`, `EJF/v1` | IT-system API-key. New keys can take 15 minutes. Introspection is disabled. | EPSG:25832 | Chain: `DAR_Adresse` → `DAR_Husnummer` → `DAR_Adressepunkt` (`position { wkt }`) and `MAT_Jordstykke.samletFastEjendomLokalId` → `MAT_SamletFastEjendom.BFEnummer`. VUR via `VUR_BFEKrydsreference`. EJF returns 403 with an API key (needs approved OAuth access). |
| Plandata.dk | `https://geoserver.plandata.dk/geoserver/wfs` | None | EPSG:25832 | Plans: `lokalplan_vedtaget`, `lokalplandelomraade_vedtaget`, `kommuneplanramme_vedtaget_v`, `zonekort_v`, `lokalplan_forslag`, `kommuneplanramme_forslag_v`. Query with `CQL_FILTER=INTERSECTS(geometri,POINT(x y))` at the BBR building coordinate (`byg404Koordinat`); a 40 m bbox reports neighbouring plans as covering. Framework building rights are in `bygpctN`/`maxetageN`/`maxbhjdN` per `anvspecN`; labels from `pdk:theme_pdk_codelist_*_v`. Site layers: see `SITE_LAYERS` in `src/sources/plandata.ts`. Energy zoning uses "Negative/Neutrale områder"; those are not planned facilities. |
| Miljøportal / DKJord | `https://jord.miljoeportal.dk/geo/wfs` | None | EPSG:25832 | Soil V1/V2 (`DKJord:View_V1Flader`, `View_V2Flader`, geometry `Fladegeometri`). Features carry `Lokalitetsejerlavkode` and `Lokalitetsmatrikler`, used to tell on-property from nearby (80 m bbox). Old Azure GeoServer host was retired May 2026. DAI WFS currently redirects to a web app. Coastal zone from Plandata `knz:theme-knz-kystnaerhedszone-polygon` (geometry `the_geom`). |
| Danmarks Statistik | `https://api.statbank.dk/v1/data/{table}/JSONSTAT` | None | n/a | Three-digit municipality codes (`791`, not DAGI's `0791`). FOLK1A (omit `Tid=latest`), INDKP101 (needs `INDKOMSTTYPE`), BOL101 (needs `BEBO`), AULP01, BEV107. EJEN77 sales are only by landsdel, so not used. |
| EMOData | Energistyrelsen EMOData service | Basic auth (T2) | n/a | Implemented; stays unavailable until credentials exist. |

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
- §3 nature, fredninger and forest building line are not on the public DKJord WFS. `get_environment` returns soil + coastal zone today; other overlays are skipped until DAI WFS is available again.
