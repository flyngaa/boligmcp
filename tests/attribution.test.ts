import { describe, expect, it } from "vitest";
import { ATTRIBUTION } from "../src/attribution.js";
import { sourcesUsed, type PropertyData } from "../src/tools/property-report.js";
import { ok, SourceIdSchema, unavailable } from "../src/types.js";

describe("source credits", () => {
  it("credits every source on every ok result", () => {
    for (const source of SourceIdSchema.options) {
      expect(ATTRIBUTION[source], source).toMatch(/\S/);
      expect(ok(source, {})).toMatchObject({ status: "ok", attribution: ATTRIBUTION[source] });
    }
  });

  it("names the licence for the CC BY 4.0 registers", () => {
    for (const source of ["dar", "ebr", "matrikel", "bbr", "dagi", "vur", "ejf", "dst", "dhm", "geodanmark", "cvr"] as const) {
      expect(ATTRIBUTION[source], source).toContain("CC BY 4.0");
    }
  });

  it("lists each source a report used once, and none it could not use", () => {
    const data = {
      idsResult: ok("dar", {}),
      buildings: ok("bbr", {}),
      nearby: ok("bbr", {}),
      valuation: ok("vur", {}),
      trades: unavailable("ejf", "missing_credentials"),
    } as unknown as PropertyData;
    expect(sourcesUsed(data)).toEqual([ATTRIBUTION.dar, ATTRIBUTION.bbr, ATTRIBUTION.vur]);
  });
});
