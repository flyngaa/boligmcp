import {
  getAdminAreasAt,
  getBuildingsAndUnits,
  getParcels,
  getTrades,
  getValuation,
  resolveFromAddressId,
} from "../src/sources/datafordeler/registers.js";

const addressId = process.argv[2] ?? "9b9a6a18-ffb7-4ece-a7f1-5368812e4719";

async function main(): Promise<void> {
  const ids = await resolveFromAddressId(addressId);
  console.log("resolve", JSON.stringify(ids, null, 2));
  if (ids.status !== "ok" || !ids.data.bfe) process.exit(1);
  const bfe = ids.data.bfe;
  const [parcels, buildings, val, trades] = await Promise.all([
    getParcels(bfe),
    getBuildingsAndUnits({ addressId, bfe }),
    getValuation(bfe),
    getTrades(bfe),
  ]);
  const admin = ids.data.coordinate
    ? await getAdminAreasAt(ids.data.coordinate.epsg25832.x, ids.data.coordinate.epsg25832.y)
    : null;
  console.log("parcel", JSON.stringify(parcels, null, 2));
  console.log(
    "buildings",
    buildings.status === "ok"
      ? `${buildings.data.buildings.length} buildings, ${buildings.data.units.length} units`
      : buildings,
  );
  console.log("valuation", JSON.stringify(val, null, 2));
  console.log("trades", JSON.stringify(trades, null, 2));
  console.log("admin", JSON.stringify(admin, null, 2));
}

void main();
