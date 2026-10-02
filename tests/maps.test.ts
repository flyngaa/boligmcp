import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigForTests } from "../src/config.js";
import { closeMapServer, extrusionHeight, getMapView, mapPage, nearestBuildingId, MAP_PORT } from "../src/sources/google-maps.js";

afterEach(async () => {
  await closeMapServer();
  resetConfigForTests(undefined);
});

describe("3D map page", () => {
  it("centers a satellite 3D map and escapes the label", () => {
    const html = mapPage({ label: `Thostrupvej 4 <script>`, lat: 56.1234567, lon: 9.5, apiKey: "test-key" });
    expect(html).toContain('mode="satellite"');
    expect(html).toContain("default-ui-hidden");
    expect(html).not.toContain("Træk for at se");
    expect(html).toContain('range="4500"');
    expect(html).toContain("flyCameraAround");
    expect(html).toContain("repeatCount: Infinity");
    expect(html).toContain('"outline":null');
    expect(html).toContain('center="56.123457,9.500000"');
    expect(html).toContain("Thostrupvej 4 &lt;script&gt;");
    expect(html).not.toContain("4 <script>");
    expect(html).toContain("key=test-key");
    expect(html).toContain(`127.0.0.1:${MAP_PORT}`);
  });

  it("picks the nearest building and a sane extrusion height", () => {
    expect(extrusionHeight(undefined)).toBe(18);
    expect(extrusionHeight(2)).toBe(18);
    expect(extrusionHeight(24)).toBe(24);
    const id = nearestBuildingId(
      { x: 0, y: 0 },
      [
        { buildingId: "far", coordinate: { epsg25832: { x: 40, y: 0 } } },
        { buildingId: "near", coordinate: { epsg25832: { x: 3, y: 4 } } },
      ],
    );
    expect(id).toBe("near");
  });

  it("extrudes a GeoDanmark outline when one is given", () => {
    const html = mapPage({
      label: "Rådhuspladsen 2",
      lat: 56.15,
      lon: 10.2,
      apiKey: "test-key",
      outline: { heightM: 24, path: [{ lat: 56.15, lon: 10.2 }, { lat: 56.151, lon: 10.2 }, { lat: 56.151, lon: 10.201 }] },
    });
    expect(html).toContain("Polygon3DElement");
    expect(html).toContain('"heightM":24');
    expect(html).toContain("RELATIVE_TO_GROUND");
    expect(html).toContain("#ffffff");
  });

  it("says how to add a key and never starts a page without one", async () => {
    resetConfigForTests({ ...loadConfig(), googleMapsApiKey: undefined });
    const result = await getMapView("Thostrupvej 4", 56.1, 9.5);
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("missing_credentials");
      expect(result.detail).toMatch(/GOOGLE_MAPS_API_KEY/);
    }
  });

  it("serves the page on localhost and leaves the key out of the result", async () => {
    resetConfigForTests({ ...loadConfig(), googleMapsApiKey: "test-key-not-real" });
    const result = await getMapView("Thostrupvej 4", 56.1, 9.5);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(JSON.stringify(result)).not.toContain("test-key-not-real");
    expect(result.data.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${MAP_PORT}/map/[a-f0-9]{32}$`));
    const page = await fetch(result.data.url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("gmp-map-3d");
    expect(html).toContain("key=test-key-not-real");
    expect(await (await fetch(`${result.data.url}x`)).status).toBe(404);
  });
});
