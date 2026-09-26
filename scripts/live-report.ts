import { buildPropertyReport } from "../src/tools/property-report.js";
const t = Date.now();
const r = await buildPropertyReport({ query: process.argv[2] ?? "Egeskovvej 41, 8800 Viborg" });
const text = JSON.stringify(r, null, 1);
console.error(`ms=${Date.now() - t} tokens≈${Math.ceil(JSON.stringify(r).length / 4)}`);
console.log(text);
