import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("test address set", () => {
  it("covers 10 representative Danish property types", () => {
    const addresses = JSON.parse(
      readFileSync(new URL("./addresses.json", import.meta.url), "utf8"),
    ) as Array<{ id: string; query: string }>;
    expect(addresses).toHaveLength(10);
    expect(new Set(addresses.map((item) => item.id)).size).toBe(10);
  });
});
