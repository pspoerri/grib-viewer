interface ColorStop {
  position: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

interface ColormapDef {
  name: string;
  stops: ColorStop[];
  /** Hidden colormaps are returned by the API so the client-side
   *  animLayer can resolve their stops, but the picker dropdown filters
   *  them out via `listColormapNames()` — they're per-field stepped
   *  variants (stepped_temp_l500, stepped_temp_2m, …), not palettes the
   *  user would pick directly. */
  hidden?: boolean;
}

let cache: Map<string, ColormapDef> | null = null;

export async function loadColormaps(): Promise<Map<string, ColormapDef>> {
  if (cache) return cache;
  // GET /api/colormaps — {colormaps: [{name, stops, hidden}]}.


  const res = await fetch("/api/colormaps");
  if (!res.ok) throw new Error(`colormaps fetch failed: ${res.status}`);
  const data = (await res.json()) as { colormaps: ColormapDef[] };
  cache = new Map(data.colormaps.map((cm) => [cm.name, cm]));
  return cache;
}

/** Synchronous snapshot of user-pickable colormap names — hidden
 *  per-field stepped variants are filtered out so the picker stays
 *  focused on palette options. Returns an empty list until
 *  `loadColormaps()` resolves at app startup. */
export function listColormapNames(): string[] {
  if (!cache) return [];
  return [...cache.values()].filter((cm) => !cm.hidden).map((cm) => cm.name);
}

function lerp8(a: number, b: number, f: number): number {
  return Math.round(a + (b - a) * f);
}

function sampleColormap(
  stops: ColorStop[],
  t: number,
): [number, number, number, number] {
  if (t <= 0) {
    const s = stops[0];
    return [s.r, s.g, s.b, s.a];
  }
  if (t >= 1) {
    const s = stops[stops.length - 1];
    return [s.r, s.g, s.b, s.a];
  }
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].position) {
      const a = stops[i - 1];
      const b = stops[i];
      const f = (t - a.position) / (b.position - a.position);
      return [
        lerp8(a.r, b.r, f),
        lerp8(a.g, b.g, f),
        lerp8(a.b, b.b, f),
        lerp8(a.a, b.a, f),
      ];
    }
  }
  const s = stops[stops.length - 1];
  return [s.r, s.g, s.b, s.a];
}

/** Colormaps whose value→colour mapping is logarithmic, not linear.
 *  Mirrors render.Colormap.LogScale on the backend: accumulation
 *  palettes span orders of magnitude (drizzle → downpour, 1h → 24h
 *  totals) over one shared window, so a log axis keeps light rain
 *  visible and makes a bigger total always read as more colour. Keep in
 *  sync with the Go side (render/colormap.go). */
const LOG_COLORMAPS = new Set(["precip"]);

export function isLogColormap(name: string | undefined | null): boolean {
  return !!name && LOG_COLORMAPS.has(name);
}

/** Log floor for a value→t window — vmin when positive, else vmax/1000
 *  so a vmin=0 archive still logs without log(0). Identical rule to the
 *  Go NormT and the GPU shader. */
function logFloor(vmin: number, vmax: number): number {
  return vmin > 0 ? vmin : vmax * 1e-3;
}

/** Map a physical value to t∈[0,1] on a log window [vmin, vmax], clamped.
 *  Equal ratios get equal screen distance (0.1→1→10→100 reads evenly);
 *  values at/below the floor return 0 (transparent first stop). MUST
 *  match render.Colormap.NormT and the GPU shader's log branch. */
export function logColorT(v: number, vmin: number, vmax: number): number {
  const lo = logFloor(vmin, vmax);
  if (lo <= 0 || vmax <= lo || v <= lo) return 0;
  const t = Math.log(v / lo) / Math.log(vmax / lo);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Inverse of logColorT: the physical value at fractional bar position
 *  t∈[0,1]. Used by the legend to label a hover/click position on a
 *  log-scaled colorbar. */
export function logColorValue(t: number, vmin: number, vmax: number): number {
  const lo = logFloor(vmin, vmax);
  if (lo <= 0 || vmax <= lo) return vmin;
  const tc = t < 0 ? 0 : t > 1 ? 1 : t;
  return lo * Math.pow(vmax / lo, tc);
}

/** Should this field's legend / tile rendering apply the canonical
 *  temperature stepping rule? The decision lives on the units string —
 *  the rule is "1 °C / 2 °C / 5 °C bands", which only makes sense for
 *  Kelvin temperature fields. */
export function isTemperatureUnits(units: string | undefined | null): boolean {
  if (!units) return false;
  const u = units.trim().toLowerCase();
  return u === "k" || u === "kelvin";
}

/** Resolve the effective stepping flag for a layer: explicit `true` /
 *  `false` win, otherwise default to "yes for temperature, no for
 *  everything else." Mirrors the server's behaviour: a temperature
 *  field whose default colormap is `stepped_temp_*` renders banded
 *  unless the user explicitly overrides. */
export function effectiveStepped(
  layerStepped: boolean | undefined,
  units: string | undefined | null,
): boolean {
  if (layerStepped !== undefined) return layerStepped;
  return isTemperatureUnits(units);
}

/** Compute integer-Celsius band-boundary positions in [0, 1] for a
 *  temperature legend that maps [vminK, vmaxK] across the bar. Mirrors
 *  the backend SteppedTempBoundaries function so a client-rendered
 *  stepped legend is bytewise identical to the server's. Zone widths:
 *  2 °C below -30, 1 °C across [-30, +40], 2 °C across [+40, +50],
 *  5 °C above +50 °C. */
export function steppedTempBoundaries(vminK: number, vmaxK: number): number[] {
  const span = vmaxK - vminK;
  if (span <= 0) return [0, 1];
  const loC = vminK - 273.15;
  const hiC = vmaxK - 273.15;
  const positions = new Map<number, number>();
  const add = (c: number) => {
    const pos = (c + 273.15 - vminK) / span;
    if (pos <= 1e-6 || pos >= 1 - 1e-6) return;
    const key = Math.round(pos * 1e9);
    positions.set(key, pos);
  };
  const zones = [
    { lo: -Infinity, hi: -30, step: 2 },
    { lo: -30, hi: 40, step: 1 },
    { lo: 40, hi: 50, step: 2 },
    { lo: 50, hi: Infinity, step: 5 },
  ];
  for (const z of zones) {
    const rLo = Math.max(loC, z.lo);
    const rHi = Math.min(hiC, z.hi);
    if (rLo > rHi) continue;
    const first = Math.ceil(rLo / z.step) * z.step;
    for (let c = first; c <= rHi + 1e-9; c += z.step) {
      add(c);
    }
  }
  const out = [0, ...positions.values(), 1];
  out.sort((a, b) => a - b);
  return out;
}

/** Convert smooth gradient stops into stepped stops sampled at the
 *  midpoint of each band. Each band emits two stops (a tiny epsilon
 *  apart at its lower edge) so the piecewise-linear sampler renders
 *  flat plateaus, mirroring render.makeStepped on the backend. */
export function makeSteppedStops(
  smoothStops: ColorStop[],
  boundaries: number[],
): ColorStop[] {
  if (smoothStops.length === 0 || boundaries.length < 2) return smoothStops;
  const sample = (t: number): [number, number, number, number] =>
    sampleColormap(smoothStops, t);
  const out: ColorStop[] = [];
  const eps = 1e-6;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const lo = boundaries[i];
    const hi = boundaries[i + 1];
    const [r, g, b, a] = sample((lo + hi) / 2);
    const start = i === 0 ? lo : lo + eps;
    out.push({ position: start, r, g, b, a });
    out.push({ position: hi, r, g, b, a });
  }
  return out;
}

/** Wrap a colormap's smooth stops with the temperature stepping rule.
 *  When `stepped` is false or `units` isn't Kelvin, returns the input
 *  unchanged so callers can blindly forward results to setColormap. */
export function maybeApplyTemperatureStepping(
  stops: ColorStop[],
  stepped: boolean,
  units: string | undefined | null,
  vminK: number,
  vmaxK: number,
): ColorStop[] {
  if (!stepped || !isTemperatureUnits(units)) return stops;
  return makeSteppedStops(stops, steppedTempBoundaries(vminK, vmaxK));
}

