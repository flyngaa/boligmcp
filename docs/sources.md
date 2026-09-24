# Source verification

Verified 24 September 2026. DAWA is **not** used. DAWA closes 1 October 2026 10:00.

| Source | Endpoint | Auth | CRS | Notes |
|---|---|---|---|---|
| Adressevælgeren | `https://adressevaelger.dk/adresser/soeg` and `/adresser/{id}`, `/husnumre/{id}` | `token` query param, default `adressevaelger123` | ETRS89 / EPSG:25832 | Phonetic search. User management later. |
| Datafordeleren GraphQL | `https://graphql.datafordeler.dk/{DAR\|BBR\|MAT\|DAGI\|EJF\|VUR}/{version}?apiKey=` | IT-system API key. No tjenestebruger. | EPSG:25832 | Required for BFE chain. |
| Plandata.dk | `https://geoserver.plandata.dk/geoserver/wfs` | None | EPSG:25832 | Layers `pdk:theme_pdk_lokalplan_vedtaget`, `pdk:theme_pdk_kommuneplanramme_vedtaget_v`, `pdk:theme_pdk_zonekort_v`. Use a ~40 m bbox; 2 m often misses polygons. |
| Miljøportal / DKJord | `https://jord.miljoeportal.dk/geo/wfs` | None | EPSG:25832 | Soil V1/V2 (`DKJord:View_V1Flader`, `View_V2Flader`). Old Azure GeoServer host was retired May 2026. DAI WFS currently redirects to a web app. Coastal zone from Plandata `knz:theme-knz-kystnaerhedszone-polygon`. |
| Danmarks Statistik | `https://api.statbank.dk/v1/data/{table}/JSONSTAT` | None | n/a | FOLK1A (omit `Tid=latest` — that value does not exist). Also INDKP101, BOL101. |
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
- BBR usage / materials / heating are numeric codes; see `src/lib/bbr-codes.ts`.
- §3 nature, fredninger and forest building line are not on the public DKJord WFS. `get_environment` returns soil + coastal zone today; other overlays are skipped until DAI WFS is available again.
