# Credentials you need to add

Bolig-MCP starts without keys. `list_sources` shows what is still missing. Copy `.env.example` to `.env` and fill the values below.

## Add now (unlocks most of the product)

### 1. `DATAFORDELER_API_KEY` — T1, free, required from Phase 3

Unlocks: DAR, Matriklen, BBR, DAGI, VUR, EJF (`resolve_property` BFE, `get_buildings`, `get_parcel`, `get_valuation`, `get_trades`, `get_admin_areas`).

1. Create a web user at [datafordeler.dk](https://datafordeler.dk).
2. Open Selvbetjening and create an **IT-system**.
3. Add authentication method **API-key** (not username/password).
4. Put the key in `DATAFORDELER_API_KEY`.

Notes:

- GraphQL is `https://graphql.datafordeler.dk/{REGISTER}/{version}?apiKey=...`
- A tjenestebruger username/password does **not** work for GraphQL and is retired 15 January 2027.
- An API key only returns non-protected data, which is the intended scope. Private owner names are never requested.

### 2. `ADRESSEVAELGER_TOKEN` — T0, already works

Default is `adressevaelger123` (the official KDS recommendation). No registration today.

Subscribe to the [KDS notification service](https://confluence.kds.dk/pages/viewpage.action?pageId=234782998) so you hear when user management arrives (late 2026 / early 2027). Then replace the token.

## Add later

### 3. `EMODATA_USER` / `EMODATA_PASSWORD` — T2

Required for `get_energy_label`. Register with Energistyrelsen EMOData (typically a business or research agreement). Until then the tool returns `unavailable / missing_credentials`.

### 4. `DATAFORSYNINGEN_TOKEN` — T1, optional

Create a user at [dataforsyningen.dk](https://dataforsyningen.dk) and mint a token. Only needed for skråfoto / orthophoto / terrain (not in the core tool list).

## No key required

| Source | Used by |
|---|---|
| Adressevælgeren | `search_address` |
| Plandata.dk WFS | `get_plans` |
| Danmarks Miljøportal Arealinfo | `get_environment` |
| Danmarks Statistik (`api.statbank.dk`) | `get_area_stats` |

## Out of scope (do not register)

- Tinglysning / Tingbogen (T3) — servitutter, pant, skøde
- Protected EJF owner names of private individuals (GDPR)

## After you add keys

1. Put them in `.env` (never commit it).
2. Restart the MCP server.
3. Call `list_sources` — Datafordeleren rows should flip to `configured: true`.
4. Re-run `property_report` on one of the addresses in `tests/addresses.json`.
