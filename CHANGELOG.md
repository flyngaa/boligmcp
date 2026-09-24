# Changelog

## 0.1.0 — 2026-09-24

- Initial public MCP server for Danish property data.
- Tools: `search_address`, `resolve_property`, `get_buildings`, `get_parcel`, `get_valuation`, `get_trades`, `get_admin_areas`, `get_plans`, `get_environment`, `get_energy_label`, `get_area_stats`, `property_report`, `list_sources`.
- T0 sources work without keys. Datafordeleren and EMOData degrade to `SourceResult.unavailable`.
- DAWA is not used (closes 1 October 2026).
