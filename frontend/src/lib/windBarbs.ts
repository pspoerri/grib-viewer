// Pure helpers for the v2 wind-barbs map overlay (WeatherMapV2): merge the two
// scalar u_10m / v_10m /grid FeatureCollections into wind points and name the
// per-speed barb icon bucket. Kept free of maplibre/canvas so the math is
// unit-testable (tests/windBarbs.test.ts) — the canvas icon factory and symbol
// layer live in WeatherMapV2 itself.

import { fromBearingDeg } from "./windBarbGlyph.ts";

/** m/s → knots, the unit barbGlyph rounds in. */
export const MS_TO_KT = 1.94384;
/** Winds slower than this are dropped entirely (matches v1's barb overlay). */
export const CALM_MS = 0.5;

export interface WindGridPoint {
  lon: number;
  lat: number;
  /** Wind speed in m/s (the /grid raw SI value). */
  speed: number;
  /** Same speed in knots (barbGlyph's rounding domain). */
  speedKt: number;
  /** Meteorological FROM bearing, degrees clockwise from north. */
  direction: number;
}

interface GridFeature {
  properties?: { value?: number } | null;
  geometry?: { coordinates?: number[] } | null;
}
interface GridFC {
  features?: GridFeature[];
}

/** Merge u_10m + v_10m /grid FeatureCollections into wind points.
 *
 *  The v2 /grid lattice is deterministic for identical bbox/spacing/time
 *  params (grids.go handleGrid steps uniformly in web-mercator Y × lon), but
 *  it *skips* nodata points (`if !ok { continue }`) — so the two feature arrays
 *  can desync by index when one component samples valid where the other is
 *  nodata. We therefore key by rounded coordinate rather than array index,
 *  which is correct regardless of any per-component skips. Points below
 *  CALM_MS are dropped. */
export function mergeWindGrids(uFC: GridFC, vFC: GridFC): WindGridPoint[] {
  const key = (lon: number, lat: number) =>
    `${lon.toFixed(4)},${lat.toFixed(4)}`;
  const vMap = new Map<string, number>();
  for (const f of vFC.features ?? []) {
    const c = f.geometry?.coordinates;
    const val = f.properties?.value;
    if (!c || c.length < 2 || typeof val !== "number") continue;
    vMap.set(key(c[0], c[1]), val);
  }
  const out: WindGridPoint[] = [];
  for (const f of uFC.features ?? []) {
    const c = f.geometry?.coordinates;
    const u = f.properties?.value;
    if (!c || c.length < 2 || typeof u !== "number") continue;
    const v = vMap.get(key(c[0], c[1]));
    if (typeof v !== "number") continue;
    const speed = Math.hypot(u, v);
    if (speed < CALM_MS) continue;
    out.push({
      lon: c[0],
      lat: c[1],
      speed,
      speedKt: speed * MS_TO_KT,
      direction: fromBearingDeg(u, v),
    });
  }
  return out;
}

/** maplibre icon name for a barb's rounded-5kt bucket. Below 5 kt →
 *  the shared calm-circle icon; otherwise one icon per distinct 5-kt step
 *  (the same rounding barbGlyph applies). */
export function barbBucketName(speedKt: number): string {
  const kt = Math.round(speedKt / 5) * 5;
  return kt < 5 ? "wx-barb-calm" : `wx-barb-${kt}`;
}
