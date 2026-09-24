import { queryNodes, type DatafordelerRegister } from "../src/sources/datafordeler/client.js";

// Usage: tsx scripts/probe-fields.ts REGISTER ENTITY '<where json>' field1 field2 ...
// Queries each field on its own so one unknown field does not hide the others.
const [register, entity, whereJson, ...fields] = process.argv.slice(2);
const where = JSON.parse(whereJson ?? "{}");
const temporal = process.env.TEMPORAL !== "0";
for (const field of fields) {
  try {
    const rows = await queryNodes(register as DatafordelerRegister, entity!, field, where, 3, { temporal });
    console.log(`OK   ${field}: ${JSON.stringify(rows.map((r) => r[field.split(" ")[0]!]))}`);
  } catch (error) {
    console.log(`FAIL ${field}: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`);
  }
}
