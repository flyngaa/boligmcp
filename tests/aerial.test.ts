import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../src/config.js";
import { resetCacheForTests } from "../src/lib/cache.js";
import {
  getAerialPhoto,
  latestSkaafotoCollection,
  orthophotoUrl,
  pickObliques,
} from "../src/sources/dataforsyningen.js";
import { projectToPixel, type ObliqueCamera } from "../src/sources/skraafoto.js";

afterEach(() => {
  resetConfigForTests(undefined);
  resetCacheForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const X = 519410.53;
const Y = 6248008.77;

const SOUTH: ObliqueCamera = {
  rotation: [
    -0.999615306842663, -0.027705639122477276, 0.0012790178512454512, 0.020485324486707444, -0.7064474637908654,
    0.7074689621348264, -0.018697320838105446, 0.7072230047617718, 0.7067432572930624,
  ],
  center: [518999.835, 6250033.709, 2016.349],
  focalLengthMm: 123.38,
  pixelSpacingMm: 0.00376,
  principalPointMm: [0, 0],
  columns: 14144,
  rows: 10560,
};

describe("aerial photo", () => {
  it("builds a WMS url without the token", () => {
    const url = orthophotoUrl(X, Y);
    expect(url).toContain("layers=orto_foraar_12_5");
    expect(url).toContain("srs=EPSG%3A25832");
    expect(url).not.toContain("token");
    expect(url).toContain("519360.53");
    expect(url).toContain("6248058.77");
  });

  it("projects a ground point into the skråfoto with the published formula", () => {
    const pixel = projectToPixel(SOUTH, 519410.53, 6248008.77, 42.28);
    expect(pixel?.column).toBeCloseTo(2940, 0);
    expect(pixel?.row).toBeCloseTo(4790, 0);
  });

  it("picks the newest skråfoto collection", () => {
    expect(latestSkaafotoCollection(["skraafotos2017", "skraafotos2025", "orto"])).toBe("skraafotos2025");
  });

  it("keeps one shot per direction and prefers a footprint that contains the point", () => {
    const shots = pickObliques(
      [
        {
          id: "far",
          collection: "skraafotos2025",
          bbox: [9.3, 56.36, 9.31, 56.37],
          properties: { direction: "north", datetime: "2025-05-15T10:00:00Z" },
        },
        {
          id: "covers",
          collection: "skraafotos2025",
          bbox: [9.31, 56.37, 9.32, 56.38],
          properties: { direction: "north", datetime: "2025-05-15T10:01:00Z" },
        },
        {
          id: "east-shot",
          collection: "skraafotos2025",
          bbox: [9.31, 56.37, 9.32, 56.38],
          properties: { direction: "east", datetime: "2025-05-15T10:02:00Z" },
        },
      ],
      9.314,
      56.376,
    );
    expect(shots.map((shot) => shot.itemId)).toEqual(["covers", "east-shot"]);
  });

  it("says how to add a token when none is configured", async () => {
    resetConfigForTests({ adressevaelgerToken: "adressevaelger123", cachePath: ":memory:" });
    const result = await getAerialPhoto(X, Y);
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("missing_credentials");
      expect(result.detail).toContain("npx -y boligmcp setup");
      expect(result.detail).toContain("Do not ask the user to paste");
    }
  });

  it("fetches the orthophoto with the token in a header and does not cache a rejection", async () => {
    resetConfigForTests({
      adressevaelgerToken: "adressevaelger123",
      cachePath: ":memory:",
      dataforsyningenToken: "test-token",
    });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("token")).toBe("test-token");
      expect(String(url)).not.toContain("test-token");
      if (String(url).includes("/collections")) {
        return new Response(JSON.stringify({ collections: [{ id: "skraafotos2025" }] }), { status: 200 });
      }
      if (String(url).includes("/search")) {
        return new Response(
          JSON.stringify({
            features: [
              {
                id: "south-shot",
                collection: "skraafotos2025",
                bbox: [9.3, 56.37, 9.33, 56.39],
                properties: { direction: "south", datetime: "2025-05-15T12:00:00Z" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await getAerialPhoto(X, Y);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.jpeg).toBe(Buffer.from(jpeg).toString("base64"));
      expect(result.data.photo.obliques).toEqual([
        {
          direction: "south",
          itemId: "south-shot",
          collection: "skraafotos2025",
          takenAt: "2025-05-15T12:00:00Z",
        },
      ]);
      expect(result.data.photo.viewerUrl).not.toContain("token");
    }

    fetch.mockImplementation(async () => new Response("no", { status: 401 }));
    const again = await getAerialPhoto(X, Y);
    expect(again.status).toBe("ok");

    const moved = await getAerialPhoto(X + 10, Y);
    expect(moved.status).toBe("unavailable");
    if (moved.status === "unavailable") expect(moved.reason).toBe("missing_credentials");
  });
});
