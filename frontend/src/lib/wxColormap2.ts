/**
 * wxColormap2 — colormap loading + sampling for the v2 frontend.
 *
 * Self-contained (not the v1-coupled lib/colormap.ts, which fetches the
 * Vite-proxied /api path and keeps an unexported sampler): fetches the colormap
 * stops from the same absolute API base as the v2 endpoints, samples them into a
 * 256-entry RGBA ramp for the GPU layer, and emits a CSS gradient for the legend.
 *
 * Value→colour fidelity matching the legend is split between this module and the
 * GPU shader: stepped TEMPERATURE bands are baked into the ramp texture here (so
 * the drape's existing linear sample shows discrete bands aligned to the legend's
 * absolute-°C boundaries — see rampForLayer), while LOG precip stays a linear ramp
 * and the log value→t mapping happens in wxLayer2's shader (u_log). Both reuse
 * lib/colormap.ts — the single source of truth for the band/step + log rules — so
 * the drape and the legend can't drift.
 */

import {
  effectiveStepped,
  maybeApplyTemperatureStepping,
} from "./colormap.ts";

// The legend's log/stepping rules live in lib/colormap.ts. Re-export the log flag
// so the GPU path (wxLayerManager → wxLayer2's u_log) sources it from the same
// place the legend does — drape and legend can't disagree on which palettes log.
export { isLogColormap } from "./colormap.ts";

export interface CStop {
  position: number; // 0..1
  r: number; // 0..255
  g: number;
  b: number;
  a: number; // 0..255
}

let cache: Map<string, CStop[]> | null = null;

/** Load + cache the colormap stops keyed by name from {apiBase}/api/colormaps. */
export async function loadColormaps2(apiBase: string): Promise<Map<string, CStop[]>> {
  if (cache) return cache;
  const res = await fetch(`${apiBase}/api/colormaps`);
  if (!res.ok) throw new Error(`colormaps fetch failed: ${res.status}`);
  const data = (await res.json()) as { colormaps: { name: string; stops: CStop[] }[] };
  cache = new Map(data.colormaps.map((c) => [c.name, c.stops]));
  return cache;
}

export function colormapStops(name: string | undefined | null): CStop[] | undefined {
  return name ? cache?.get(name) : undefined;
}

/** Linear-interpolated colour at t∈[0,1] over the stops. */
function sample(stops: CStop[], t: number): [number, number, number, number] {
  const first = stops[0];
  if (t <= first.position) return [first.r, first.g, first.b, first.a];
  const last = stops[stops.length - 1];
  if (t >= last.position) return [last.r, last.g, last.b, last.a];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].position) {
      const a = stops[i - 1];
      const b = stops[i];
      const f = (t - a.position) / (b.position - a.position || 1);
      return [
        Math.round(a.r + (b.r - a.r) * f),
        Math.round(a.g + (b.g - a.g) * f),
        Math.round(a.b + (b.b - a.b) * f),
        Math.round(a.a + (b.a - a.a) * f),
      ];
    }
  }
  return [last.r, last.g, last.b, last.a];
}

/** Sample stops into an N-entry RGBA ramp for WxV2Layer. alpha overrides per-stop alpha when set. */
export function rampFromStops(stops: CStop[], n = 256, alpha?: number): Uint8Array {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b, a] = sample(stops, i / (n - 1));
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = alpha ?? a;
  }
  return out;
}

export interface RampLayerOptions {
  /** Layer's stepped override: true/false win; undefined defers to the units
   *  default (temperature → stepped, else smooth). Mirrors the legend. */
  stepped?: boolean;
  /** Variable units — drives the default stepping decision (only Kelvin
   *  temperature fields step) and the absolute-°C band placement. */
  units?: string | null;
  /** Legend value→colour window (Kelvin for temperature); also the domain the
   *  integer-°C band boundaries are placed across. */
  vmin: number;
  vmax: number;
}

/** Build the GPU ramp for a layer, BAKING temperature bands into the texture when
 *  the colormap should render stepped — so the drape's linear texture sample shows
 *  the SAME discrete bands as the legend. The band boundaries come from
 *  lib/colormap.ts (steppedTempBoundaries via maybeApplyTemperatureStepping), the
 *  exact integer-°C ladder the legend PNG uses, placed at linear positions across
 *  [vmin, vmax] — which is where the drape shader's t=(v−vmin)/(vmax−vmin) lands
 *  the same value, so the bands align. Non-stepped colormaps get the smooth ramp
 *  unchanged (log palettes stay smooth here; their log mapping is the shader's job).
 *  Rebuild whenever colormap / vmin / vmax / units / stepped change. */
export function rampForLayer(
  stops: CStop[],
  opts: RampLayerOptions,
  n = 256,
): Uint8Array {
  const stepped = effectiveStepped(opts.stepped, opts.units);
  const baked = maybeApplyTemperatureStepping(
    stops,
    stepped,
    opts.units,
    opts.vmin,
    opts.vmax,
  );
  return rampFromStops(baked, n);
}

export interface ColormapLegendOptions {
  /** When true, bake the temperature-stepping variant (1°/2°/5° bands
   *  across [vminK, vmaxK]) into the strip — the same bands the GPU drape
   *  bakes into its ramp texture. */
  stepped?: boolean;
  vminK?: number;
  vmaxK?: number;
}

// Transparent 1×1 PNG shown until the colormap catalog resolves.
const TRANSPARENT_PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==";

/** Client-rendered legend strip as a data URL — there is no server legend
 *  endpoint; the bar is drawn from the /api/colormaps stops (spec 04). Same
 *  signature as the old server URL builder so the <img src> call sites are
 *  unchanged. Returns a transparent pixel until the stops cache is warm. */
export function colormapLegendURL(
  name: string,
  width = 256,
  height = 16,
  opts?: ColormapLegendOptions,
): string {
  const stops = colormapStops(name);
  if (!stops || stops.length === 0 || typeof document === "undefined") {
    return TRANSPARENT_PX;
  }
  const stepped =
    !!opts?.stepped &&
    opts.vminK != null &&
    opts.vmaxK != null &&
    opts.vmaxK > opts.vminK;
  const ramp = stepped
    ? rampForLayer(
        stops,
        { stepped: true, units: "K", vmin: opts!.vminK!, vmax: opts!.vmaxK! },
        width,
      )
    : rampFromStops(stops, width);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return TRANSPARENT_PX;
  const img = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    img.data.set(ramp, y * width * 4);
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}
