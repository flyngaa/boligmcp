import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { resetConfigForTests } from "../src/config.js";
import { extractNodes } from "../src/sources/datafordeler/client.js";
import { resolveFromAddressId } from "../src/sources/datafordeler/registers.js";

afterEach(() => {
  resetConfigForTests(undefined);
});

describe("Datafordeleren GraphQL helpers", () => {
  it("extracts nodes from the official connection payload", () => {
    const payload = JSON.parse(
      readFileSync(new URL("./fixtures/datafordeler/dar-adresse.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const nodes = extractNodes(payload, "DAR_Adresse");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.husnummer).toBe("0a3f507a-eedb-32b8-e044-0003ba298018");
  });

  it("returns missing_credentials without a key", async () => {
    resetConfigForTests({
      adressevaelgerToken: "adressevaelger123",
      cachePath: ":memory:",
    });
    const result = await resolveFromAddressId("0ef9e32f-5541-49b5-805b-4af2b4d4bd38");
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("missing_credentials");
    }
  });
});
