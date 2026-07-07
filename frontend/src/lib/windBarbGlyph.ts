// Shared wind-barb glyph construction, used by the popup meteogram
// strip (components/WindBarbs.tsx) and the on-map click-point barb fan
// (components/WeatherMap.tsx).

/** Staff length of one barb glyph, px in viewBox space. */
export const BARB_STAFF = 13;

export interface BarbGlyphParts {
  /** Stroke segments as [x1, y1, x2, y2] in glyph-local coords. */
  lines: [number, number, number, number][];
  /** Filled pennant triangles as SVG polygon `points` strings. */
  pennants: string[];
  /** True when the speed rounds below 5 kt — draw a calm circle. */
  calm: boolean;
}

/** One barb glyph: standard meteorological station barb in knots —
 *  pennant = 50 kt, full feather = 10 kt, half feather = 5 kt. Glyph
 *  is built pointing north (staff up from the station point at the
 *  origin); the caller rotates it to the wind's FROM bearing. */
export function barbGlyph(speedKt: number): BarbGlyphParts {
  const lines: [number, number, number, number][] = [];
  const pennants: string[] = [];
  const kt = Math.round(speedKt / 5) * 5;
  if (kt < 5) return { lines, pennants, calm: true };

  // Staff from station (0,0) up to (0,-BARB_STAFF).
  lines.push([0, 0, 0, -BARB_STAFF]);

  let rest = kt;
  let y = -BARB_STAFF;
  const step = 3.2;
  // Pennants (50 kt): filled triangle, base ~3 px along the staff,
  // apex 6 px out on the right side (NH convention).
  while (rest >= 50) {
    pennants.push(`0,${y} 6,${y + 1.2} 0,${y + 3.2}`);
    y += step + 0.8;
    rest -= 50;
  }
  // Full feathers (10 kt): 6 px, slanted toward the staff tip.
  while (rest >= 10) {
    lines.push([0, y, 6, y - 2.4]);
    y += step;
    rest -= 10;
  }
  // Half feather (5 kt). A lone half feather sits one step in from
  // the tip so it can't be mistaken for a full one.
  if (rest >= 5) {
    if (kt === 5) y += step;
    lines.push([0, y, 3, y - 1.2]);
  }
  return { lines, pennants, calm: false };
}

/** Meteorological FROM bearing in degrees (0 = from north, clockwise)
 *  for a wind vector (u eastward, v northward). */
export function fromBearingDeg(u: number, v: number): number {
  const deg = (Math.atan2(-u, -v) * 180) / Math.PI;
  return (deg + 360) % 360;
}
