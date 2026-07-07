/**
 * contourScale — pick a sensible contour interval from the ACTUAL data range,
 * not the variable's (often much wider) colormap range.
 *
 * Why this exists: pmsl's colormap spans 870–1080 hPa but a real field is
 * ~1000–1025 hPa; t_2m's colormap spans −73…57 °C but a summer field is
 * ~10–32 °C. Deriving the interval from the colormap range gave 10 hPa / 10 K
 * steps — only 2–3 isolines in view. Deriving it from the data's p2–p98 range
 * gives a proper synoptic spacing (~2 hPa / 2 K).
 */

/** A "nice" 1/2/5×10ⁿ step near x. */
export function niceStep(x: number): number {
  if (!(x > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

/**
 * Dequantize a window's int16 values (skipping nodata) and return the
 * [p_lo, p_hi] percentile range in physical units. Null if too few valid cells.
 */
export function dataRange(
  values: ArrayLike<number>,
  nodata: number,
  scale: number,
  offset: number,
  loP = 0.02,
  hiP = 0.98,
): { lo: number; hi: number } | null {
  const vals: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    if (raw !== nodata) vals.push(raw * scale + offset);
  }
  if (vals.length < 2) return null;
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * loP)];
  const hi = vals[Math.floor(vals.length * hiP)] || lo + 1;
  return { lo, hi };
}

/** Contour interval for a data range: ~`target` isolines across [lo, hi]. A
 * lower target gives a coarser interval — 8 lands ~2 hPa on pressure and ~2 K
 * on temperature, fine enough to read the pattern but above the orographic /
 * regridder noise floor that tangles pmsl-over-mountains at 1 hPa. */
export function contourInterval(lo: number, hi: number, target = 8): number {
  return niceStep((hi - lo) / target);
}
