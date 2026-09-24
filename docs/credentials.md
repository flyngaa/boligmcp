# Credentials you need to add

Bolig-MCP starts without keys, and every user brings their own. `list_sources` shows what is still missing and how to get it. Add keys with `npx -y boligmcp setup` (saved to `~/.config/boligmcp/credentials.json`, mode 600), as env vars in the MCP client config, or via the Claude Desktop bundle prompt. Never paste keys into a chat.

## Add now (unlocks most of the product)

### 1. `DATAFORDELER_API_KEY` — T1, free, required from Phase 3

Unlocks: DAR, Matriklen, BBR, DAGI, VUR (`resolve_property` BFE, `get_buildings`, `get_parcel`, `get_valuation`, `get_admin_areas`). Not EJF; see the note below.

1. Create a web user at [datafordeler.dk](https://datafordeler.dk).
2. Open Selvbetjening and create an **IT-system**.
3. Add authentication method **API-key** (not username/password).
4. Run `npx -y boligmcp setup` and paste the key there (or set `DATAFORDELER_API_KEY` in the client config).

Notes:

- GraphQL is `https://graphql.datafordeler.dk/{REGISTER}/{version}?apiKey=...`
- A tjenestebruger username/password does **not** work for GraphQL and is retired 15 January 2027.
- An API key only returns non-protected data, which is the intended scope. Private owner names are never requested.
- EJF (ownership type and trades) returns 403 with an API key. Level 1 (no CPR, no protected names) is open to private actors with MitID Erhverv, an OAuth IT-system and an approved request to Geodatastyrelsen via Datafordeler Administration, using the form "Bilag Anmodning om adgang til Ejerfortegnelsen". Private actors may only request `EJF_Ejerskabsskifte`, `EJF_Ejerskifte`, `EJF_Ejerskifte_bilagsbankRef`, `EJF_Handelsoplysninger` and `EJF_PersonVirksomhedsoplys`. Data is CC BY 4.0 with attribution to Ejerfortegnelsen. Bolig-MCP only uses `EJF_Ejerskifte` and `EJF_Handelsoplysninger` (dates and prices), so request just those two; owner names (`EJF_PersonVirksomhedsoplys`) are never read. After approval, run `npx -y boligmcp setup` and enter the IT-system's **OAuth Client ID** and **Shared Secret** (not the API key). `get_trades` says `requires_agreement` until Geodatastyrelsen has approved, and `missing_credentials` if the Client ID or secret is wrong.

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

1. Run `npx -y boligmcp setup` (or set env vars in the client config).
2. Restart the MCP client or start a new session.
3. Call `list_sources` — Datafordeleren rows should flip to `configured: true`.
4. Re-run `property_report` on one of the addresses in `tests/addresses.json`.
