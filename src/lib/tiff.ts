/**
 * Minimal reader for the single-band GeoTIFFs Datafordeleren's DHM WCS returns:
 * uncompressed, stripped, 32-bit float. Anything else is rejected rather than misread.
 */
export interface RasterGrid {
  width: number;
  height: number;
  values: Float32Array;
}

const TAG = {
  width: 256,
  height: 257,
  bitsPerSample: 258,
  compression: 259,
  stripOffsets: 273,
  samplesPerPixel: 277,
  stripByteCounts: 279,
  sampleFormat: 339,
  tileWidth: 322,
} as const;

export function readFloat32Tiff(input: ArrayBuffer | Uint8Array): RasterGrid {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0);
  if (order !== "II" && order !== "MM") throw new Error("Not a TIFF file");
  const le = order === "II";
  const u16 = (offset: number) => view.getUint16(offset, le);
  const u32 = (offset: number) => view.getUint32(offset, le);
  if (u16(2) !== 42) throw new Error("Not a classic TIFF (BigTIFF is not supported)");

  const ifd = u32(4);
  const tags = new Map<number, number[]>();
  for (let i = 0; i < u16(ifd); i += 1) {
    const entry = ifd + 2 + i * 12;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const count = u32(entry + 4);
    const size = type === 3 ? 2 : type === 4 ? 4 : 0;
    if (!size) continue; // Only SHORT and LONG tags are needed here.
    const valueOffset = count * size <= 4 ? entry + 8 : u32(entry + 8);
    const values: number[] = [];
    for (let j = 0; j < count; j += 1) {
      values.push(size === 2 ? u16(valueOffset + j * 2) : u32(valueOffset + j * 4));
    }
    tags.set(tag, values);
  }

  const one = (tag: number) => tags.get(tag)?.[0];
  const width = one(TAG.width);
  const height = one(TAG.height);
  if (!width || !height) throw new Error("TIFF has no dimensions");
  if ((one(TAG.compression) ?? 1) !== 1) throw new Error("Compressed TIFFs are not supported");
  if (one(TAG.bitsPerSample) !== 32 || one(TAG.sampleFormat) !== 3 || (one(TAG.samplesPerPixel) ?? 1) !== 1) {
    throw new Error("Only single-band 32-bit float TIFFs are supported");
  }
  if (tags.has(TAG.tileWidth)) throw new Error("Tiled TIFFs are not supported");

  const offsets = tags.get(TAG.stripOffsets) ?? [];
  const counts = tags.get(TAG.stripByteCounts) ?? [];
  const values = new Float32Array(width * height);
  let index = 0;
  offsets.forEach((offset, strip) => {
    const length = counts[strip] ?? 0;
    for (let pos = offset; pos + 4 <= offset + length && index < values.length; pos += 4) {
      values[index++] = view.getFloat32(pos, le);
    }
  });
  if (index !== values.length) throw new Error("TIFF strips are shorter than the image");
  return { width, height, values };
}

/** Values the DHM uses for "no data" (sea, outside Denmark) are large negatives. */
export function validValues(grid: RasterGrid): number[] {
  return Array.from(grid.values).filter((value) => Number.isFinite(value) && value > -100);
}

export function percentile(sorted: number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index];
}

/** Median of the 3×3 pixels around the centre, which smooths single-pixel noise. */
export function centreValue(grid: RasterGrid): number | undefined {
  const cx = Math.floor(grid.width / 2);
  const cy = Math.floor(grid.height / 2);
  const around: number[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
      const value = grid.values[y * grid.width + x];
      if (value !== undefined && Number.isFinite(value) && value > -100) around.push(value);
    }
  }
  around.sort((a, b) => a - b);
  return percentile(around, 50);
}
