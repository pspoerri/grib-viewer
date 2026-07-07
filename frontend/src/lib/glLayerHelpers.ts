/**
 * Shared WebGL2 / projection helpers for the custom MapLibre layers
 * (animLayer, gpuFlowLayer, contourLabelLayer). These were copied
 * byte-for-byte across all three; this module is the single canonical
 * home. `compileShader` stays local in each layer because its thrown
 * error message is layer-specific (a deliberate per-file difference,
 * not drift).
 */
import type { Map as MaplibreMap } from "maplibre-gl";

export function isWebGL2(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
): gl is WebGL2RenderingContext {
  return typeof (gl as WebGL2RenderingContext).texStorage3D === "function";
}

export interface ProjData {
  matrix: Float32Array | number[];
  fallbackMatrix: Float32Array | number[];
  clippingPlane: [number, number, number, number];
  transition: number;
}

/**
 * Extract MapLibre's ProjectionData from the render args. Newer
 * versions surface mercator + globe uniforms together as
 * `defaultProjectionData`; older ones (or simpler test harnesses) may
 * only provide a single matrix. Falls back to a mercator-only
 * configuration when fields are missing.
 */
export function extractProjData(args: unknown): ProjData | null {
  if (!args || typeof args !== "object") return null;
  const a = args as {
    matrix?: Float32Array | number[];
    defaultProjectionData?: {
      mainMatrix?: Float32Array | number[];
      fallbackMatrix?: Float32Array | number[];
      clippingPlane?: [number, number, number, number];
      projectionTransition?: number;
    };
  };
  const dpd = a.defaultProjectionData;
  const matrix = a.matrix ?? dpd?.mainMatrix;
  if (!matrix) return null;
  return {
    matrix,
    fallbackMatrix: dpd?.fallbackMatrix ?? matrix,
    clippingPlane: dpd?.clippingPlane ?? [0, 0, 0, 0],
    transition: dpd?.projectionTransition ?? 0,
  };
}

/**
 * Compute the set of mercator world-copy offsets that intersect the
 * current viewport. MapLibre's raster source draws wrapped copies
 * automatically; CustomLayerInterface gives us a single matrix per
 * frame and expects us to handle wrap ourselves. Suppressed (returns
 * [0]) when getRenderWorldCopies() is false.
 */
export function computeWrapOffsets(map: MaplibreMap | null): number[] {
  if (!map) return [0];
  const m = map as unknown as { getRenderWorldCopies?: () => boolean };
  if (m.getRenderWorldCopies && !m.getRenderWorldCopies()) return [0];
  const canvas = map.getCanvas();
  const z = map.getZoom();
  const worldPx = 256 * Math.pow(2, z);
  const viewportPx = canvas.width;
  const halfWorlds = Math.ceil(viewportPx / (2 * worldPx)) + 1;
  const centerLng = map.getCenter().lng;
  const centerCopy = Math.round(centerLng / 360);
  const out: number[] = [];
  for (let i = -halfWorlds; i <= halfWorlds; i++) out.push(centerCopy + i);
  return out;
}

/**
 * Right-multiply a 4x4 column-major matrix by a translation in x by
 * `tx`. Used to nudge the standard map matrix into each world-copy
 * slot for the wrap pass.
 */
export function translateMatrixX(
  matrix: Float32Array | number[],
  tx: number,
): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 16; i++) out[i] = matrix[i];
  out[12] += matrix[0] * tx;
  out[13] += matrix[1] * tx;
  out[14] += matrix[2] * tx;
  out[15] += matrix[3] * tx;
  return out;
}

export function collectUniforms(
  gl: WebGL2RenderingContext,
  prog: WebGLProgram,
  names: string[],
): Record<string, WebGLUniformLocation | null> {
  const out: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) out[n] = gl.getUniformLocation(prog, n);
  return out;
}

export function setUniformMatrix4fv(
  gl: WebGL2RenderingContext,
  loc: WebGLUniformLocation | null | undefined,
  value: Float32Array | number[],
): void {
  if (loc) gl.uniformMatrix4fv(loc, false, value);
}
export function setUniform1f(
  gl: WebGL2RenderingContext,
  loc: WebGLUniformLocation | null | undefined,
  v: number,
): void {
  if (loc) gl.uniform1f(loc, v);
}
export function setUniform1i(
  gl: WebGL2RenderingContext,
  loc: WebGLUniformLocation | null | undefined,
  v: number,
): void {
  if (loc) gl.uniform1i(loc, v);
}
export function setUniform2f(
  gl: WebGL2RenderingContext,
  loc: WebGLUniformLocation | null | undefined,
  a: number,
  b: number,
): void {
  if (loc) gl.uniform2f(loc, a, b);
}
export function setUniform4f(
  gl: WebGL2RenderingContext,
  loc: WebGLUniformLocation | null | undefined,
  a: number,
  b: number,
  c: number,
  d: number,
): void {
  if (loc) gl.uniform4f(loc, a, b, c, d);
}

/** Parse a CSS color (#rgb, #rrggbb, rgb()/rgba()) into [r,g,b,a] in
 *  the 0..1 range. Falls back to opaque white for unrecognized input. */
export function parseCssColor(css: string): [number, number, number, number] {
  const trimmed = css.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (m) {
    const v = parseInt(m[1], 16);
    return [
      ((v >> 16) & 0xff) / 255,
      ((v >> 8) & 0xff) / 255,
      (v & 0xff) / 255,
      1,
    ];
  }
  m = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (m) {
    const v = parseInt(m[1], 16);
    return [
      (((v >> 8) & 0xf) * 0x11) / 255,
      (((v >> 4) & 0xf) * 0x11) / 255,
      ((v & 0xf) * 0x11) / 255,
      1,
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(trimmed);
  if (rgb) {
    return [
      Number(rgb[1]) / 255,
      Number(rgb[2]) / 255,
      Number(rgb[3]) / 255,
      rgb[4] ? Number(rgb[4]) : 1,
    ];
  }
  return [1, 1, 1, 1];
}
