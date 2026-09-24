import { describe, expect, it } from "vitest";
import { buildFlags } from "../src/analysis/flags.js";
import { centreValue, readFloat32Tiff, type RasterGrid } from "../src/lib/tiff.js";
import { summarizeTerrain } from "../src/sources/datafordeler/dhm.js";

/** Builds the kind of file the DHM WCS returns: little-endian, uncompressed float32 strips. */
function tiff(width: number, height: number, values: number[], rowsPerStrip = 2): Uint8Array {
  const entries: Array<[number, number, number, number]> = [];
  const strips = Math.ceil(height / rowsPerStrip);
  const headerSize = 8;
  const ifdSize = 2 + 9 * 12 + 4;
  const arrays = headerSize + ifdSize;
  const offsetsAt = arrays;
  const countsAt = offsetsAt + strips * 4;
  const dataAt = countsAt + strips * 4;
  const buffer = new ArrayBuffer(dataAt + values.length * 4);
  const view = new DataView(buffer);
  view.setUint8(0, 0x49);
  view.setUint8(1, 0x49);
  view.setUint16(2, 42, true);
  view.setUint32(4, headerSize, true);
  entries.push([256, 3, 1, width], [257, 3, 1, height], [258, 3, 1, 32], [259, 3, 1, 1], [273, 4, strips, offsetsAt]);
  entries.push([277, 3, 1, 1], [278, 3, 1, rowsPerStrip], [279, 4, strips, countsAt], [339, 3, 1, 3]);
  view.setUint16(headerSize, entries.length, true);
  entries.forEach(([tag, type, count, value], i) => {
    const at = headerSize + 2 + i * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(at + 8, value, true);
    else view.setUint32(at + 8, value, true);
  });
  for (let s = 0; s < strips; s += 1) {
    const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
    view.setUint32(offsetsAt + s * 4, dataAt + s * rowsPerStrip * width * 4, true);
    view.setUint32(countsAt + s * 4, rows * width * 4, true);
  }
  values.forEach((value, i) => view.setFloat32(dataAt + i * 4, value, true));
  return new Uint8Array(buffer);
}

const flat = (size: number, value: number): RasterGrid => ({ width: size, height: size, values: new Float32Array(size * size).fill(value) });

describe("GeoTIFF reader", () => {
  it("reads float32 strips in order and takes the 3×3 median at the centre", () => {
    const values = Array.from({ length: 25 }, (_, i) => i);
    values[12] = 999; // one noisy centre pixel
    const grid = readFloat32Tiff(tiff(5, 5, values));
    expect(grid.width).toBe(5);
    expect(Array.from(grid.values.slice(0, 5))).toEqual([0, 1, 2, 3, 4]);
    expect(centreValue(grid)).toBe(13);
  });

  it("rejects files it cannot read correctly", () => {
    expect(() => readFloat32Tiff(new Uint8Array([0x50, 0x4b, 3, 4]))).toThrow(/Not a TIFF/);
    const compressed = tiff(2, 2, [1, 2, 3, 4]);
    new DataView(compressed.buffer).setUint16(8 + 2 + 3 * 12 + 8, 5, true); // Compression = LZW
    expect(() => readFloat32Tiff(compressed)).toThrow(/Compressed/);
  });
});

describe("terrain summary", () => {
  it("compares the point with its surroundings and ignores no-data", () => {
    const wide = flat(10, 12);
    wide.values[0] = -9999;
    const summary = summarizeTerrain(flat(5, 9.8), flat(5, 16.3), wide, "building");
    expect(summary).toMatchObject({ datum: "DVR90", terrainM: 9.8, heightAboveTerrainM: 6.5, relativeToSurroundingsM: -2.2 });
    expect(summary?.surroundings.minM).toBe(12);
  });
});

describe("terrain flags", () => {
  const terrain = (terrainM: number, medianM: number) => ({
    datum: "DVR90" as const,
    terrainM,
    surroundings: { radiusM: 250, medianM, p10M: medianM, minM: medianM, maxM: medianM },
    relativeToSurroundingsM: terrainM - medianM,
  });

  it("raises low terrain and hollows, and stays quiet on normal ground", () => {
    expect(buildFlags({ terrain: terrain(1.2, 1.3) }).map((f) => [f.id, f.severity])).toEqual([["very_low_terrain", "high"]]);
    expect(buildFlags({ terrain: terrain(2.1, 2.0) }).map((f) => f.id)).toEqual(["low_terrain"]);
    expect(buildFlags({ terrain: terrain(20, 22) }).map((f) => f.id)).toEqual(["terrain_depression"]);
    expect(buildFlags({ terrain: terrain(29.8, 29.9) })).toEqual([]);
  });
});
