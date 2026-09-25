import { fromUrl } from "geotiff";
import { encode } from "jpeg-js";

const FACADE_WIDTH = 800;
const FACADE_HEIGHT = 600;

/** Camera from a skråfoto STAC item. Angles follow Klimadatastyrelsen's published formula. */
export interface ObliqueCamera {
  rotation: number[];
  center: [number, number, number];
  focalLengthMm: number;
  pixelSpacingMm: number;
  principalPointMm: [number, number];
  columns: number;
  rows: number;
}

/**
 * Pixel of a ground point. Origin of the published formula is the lower left;
 * the returned row counts from the top, which is what a COG window uses.
 */
export function projectToPixel(
  camera: ObliqueCamera,
  x: number,
  y: number,
  z: number,
): { column: number; row: number } | undefined {
  if (camera.rotation.length !== 9 || camera.pixelSpacingMm <= 0) return undefined;
  const [m11, m12, m13, m21, m22, m23, m31, m32, m33] = camera.rotation as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const [xc, yc, zc] = camera.center;
  const [ppoX, ppoY] = camera.principalPointMm;
  const focalPx = camera.focalLengthMm / camera.pixelSpacingMm;
  const x0 = camera.columns * 0.5 + ppoX / camera.pixelSpacingMm;
  const y0 = camera.rows * 0.5 + ppoY / camera.pixelSpacingMm;
  const dx = x - xc;
  const dy = y - yc;
  const dz = z - zc;
  const depth = m31 * dx + m32 * dy + m33 * dz;
  if (!Number.isFinite(depth) || Math.abs(depth) < 1e-6) return undefined;
  const column = x0 - (focalPx * (m11 * dx + m12 * dy + m13 * dz)) / depth;
  const fromBottom = y0 - (focalPx * (m21 * dx + m22 * dy + m23 * dz)) / depth;
  const row = camera.rows - fromBottom;
  if (column < 0 || row < 0 || column >= camera.columns || row >= camera.rows) return undefined;
  return { column, row };
}

function windowAround(column: number, row: number, imageWidth: number, imageHeight: number): [number, number, number, number] {
  const width = Math.min(FACADE_WIDTH, imageWidth);
  const height = Math.min(FACADE_HEIGHT, imageHeight);
  const left = Math.max(0, Math.min(Math.round(column - width / 2), imageWidth - width));
  const top = Math.max(0, Math.min(Math.round(row - height / 2), imageHeight - height));
  return [left, top, left + width, top + height];
}

/** Reads an 800×600 JPEG around the ground point. The COG URL is public and carries no token. */
export async function readFacadeJpeg(
  href: string,
  camera: ObliqueCamera,
  x: number,
  y: number,
  z: number,
): Promise<{ jpeg: string; width: number; height: number } | undefined> {
  const pixel = projectToPixel(camera, x, y, z);
  if (!pixel) return undefined;
  const tiff = await fromUrl(href);
  const image = await tiff.getImage();
  const frame = windowAround(pixel.column, pixel.row, image.getWidth(), image.getHeight());
  const raster = await image.readRGB({ window: frame, interleave: true });
  const width = frame[2] - frame[0];
  const height = frame[3] - frame[1];
  const samples = raster as Uint8Array;
  const bands = Math.max(1, Math.round(samples.length / (width * height)));
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const at = i * bands;
    rgba[i * 4] = samples[at] ?? 0;
    rgba[i * 4 + 1] = samples[at + 1] ?? samples[at] ?? 0;
    rgba[i * 4 + 2] = samples[at + 2] ?? samples[at] ?? 0;
    rgba[i * 4 + 3] = 255;
  }
  const encoded = encode({ data: rgba, width, height }, 80);
  return { jpeg: Buffer.from(encoded.data).toString("base64"), width, height };
}
