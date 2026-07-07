// Time-proportional x-axis math for the Meteogram.
//
// The forecast horizon has VARIABLE cadence (e.g. hourly to +48 h, then
// 3-hourly, then 6-hourly). Spacing frames by index gives every frame
// equal width, which compresses the coarse-cadence tail in real time —
// day labels cram together and the diurnal cycle aliases into spikes.
// These helpers place frames at their true temporal position instead.

/** Fraction in [0,1] of each frame along the time axis (first→0, last→1).
 *  stepMs must be ascending epoch-ms. Single frame → [0.5]; empty → []. */
export function timeFractions(stepMs: number[]): number[] {
  const n = stepMs.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];
  const t0 = stepMs[0];
  const span = stepMs[n - 1] - t0 || 1;
  return stepMs.map((ms) => (ms - t0) / span);
}

/** Index of the frame whose fraction is nearest to target (fracs ascending). */
export function nearestFracIndex(fracs: number[], target: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < fracs.length; i++) {
    const d = Math.abs(fracs[i] - target);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Per-frame cell widths (px) that tile the axis by time-midpoints, so
 *  bars/bands span their real interval instead of a uniform slot. Edge
 *  frames mirror their single neighbour gap. */
export function cellWidths(fracs: number[], innerW: number): number[] {
  const n = fracs.length;
  if (n === 0) return [];
  if (n === 1) return [innerW];
  const x = fracs.map((f) => f * innerW);
  return x.map((xi, i) => {
    const left = i > 0 ? (x[i - 1] + xi) / 2 : xi - (x[i + 1] - xi) / 2;
    const right = i < n - 1 ? (xi + x[i + 1]) / 2 : xi + (xi - x[i - 1]) / 2;
    return Math.max(1, right - left);
  });
}
