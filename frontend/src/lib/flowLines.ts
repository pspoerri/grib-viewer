/**
 * Wind-flow data types for GpuFlowLayer.
 *
 * v1's Canvas2D tracer and chunk dequantizer are gone; what survives is the
 * assembled `FlowField` shape the GPU layer consumes, plus the v2 adapter
 * that dequantizes a native-grid `Window` (u_10m / v_10m component) into it.
 */
import type { Window } from "./wxdata2.ts";

export interface FlowField {
  /** Zonal (east-west) component grid, row-major, width × height. */
  u: Float32Array;
  /** Meridional (north-south) component grid, row-major, width × height. */
  v: Float32Array;
  /** Grid width (columns). */
  width: number;
  /** Grid height (rows). */
  height: number;
  /** Geographic bounds [west, south, east, north]. */
  bounds: [number, number, number, number];
}

/** Dequantize one component window into physical m/s (NaN = nodata). */
function dequant(w: Window): Float32Array {
  const out = new Float32Array(w.values.length);
  for (let i = 0; i < w.values.length; i++) {
    const raw = w.values[i];
    out[i] = raw === w.nodata ? NaN : raw * w.scale + w.offset;
  }
  return out;
}

/** Assemble a (u, v) window pair into the FlowField GpuFlowLayer samples.
 *  Both components come from the same fetch (model, bbox, level, frame), so
 *  they share one grid def; returns null on a mismatch (transient — e.g. one
 *  component landed from a different pyramid level mid-zoom). Window rows run
 *  north→south (dlat < 0), which is exactly the row order the layer's
 *  mercator-bounds texture lookup expects. */
export function windowsToFlowField(u: Window, v: Window): FlowField | null {
  const g = u.grid;
  if (v.grid.nx !== g.nx || v.grid.ny !== g.ny) return null;
  const west = g.lon0;
  const east = g.lon0 + (g.nx - 1) * g.dlon;
  const north = g.lat0;
  const south = g.lat0 + (g.ny - 1) * g.dlat;
  return {
    u: dequant(u),
    v: dequant(v),
    width: g.nx,
    height: g.ny,
    bounds: [west, south, east, north],
  };
}
