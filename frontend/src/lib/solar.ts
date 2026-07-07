// Shared by the meteogram, multi-model charts, and the detail page.

/** Approximate solar elevation (degrees) — low-precision NOAA-style
 *  formula, plenty for shading night bands on a meteogram. Shared with
 *  the multi-model charts and the detail page. */
export function solarElevationDeg(timeMs: number, lat: number, lon: number): number {
  const rad = Math.PI / 180;
  const d = timeMs / 86400000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const decl = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmstH = (18.697374558 + 24.06570982441908 * d) % 24;
  const lha = (gmstH * 15 + lon) * rad - ra;
  const elev = Math.asin(
    Math.sin(lat * rad) * Math.sin(decl) +
      Math.cos(lat * rad) * Math.cos(decl) * Math.cos(lha),
  );
  return elev / rad;
}
