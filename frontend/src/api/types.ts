export interface Variable {
  name: string;
  units: string;
  long_name?: string;
  default_colormap?: string;
  /** Vertical levels the model publishes for this variable. Single-level
   *  fields (t_2m, u_10m, ...) yield [0]; multi-level atmospheric fields
   *  (t, u, v, ...) yield the sorted list of model levels. Omitted by
   *  older servers that don't expose the array. */
  levels?: number[];
  /** True for variables computed on demand from source archive(s)
   *  (e.g. wind_speed_10m from u_10m/v_10m, precip_1h from tot_prec). */
  derived?: boolean;
  /** Ensemble percentile planes the model publishes for this variable
   *  (e.g. [10, 25, 50, 75, 90] on iconeueps probabilistic fields). A
   *  plane is requested by suffixing the variable id (`t_2m_p90`); the
   *  bare id serves the median (p50). Absent on deterministic
   *  variables and on older servers. */
  percentiles?: number[];
  /** Request-time distribution capability (units/min/max/member_count
   *  of the {name}_dist.wxt archive in the latest run). Structural
   *  duplicate of client.ts's DistCapability — types.ts stays
   *  dependency-free. Absent on deterministic variables and on runs
   *  without dist archives. */
  dist?: { units: string; min: number; max: number; member_count: number };
}

// ---------------------------------------------------------------------------
// Ensemble-percentile variable ids
// ---------------------------------------------------------------------------

const PERCENTILE_SUFFIX_RE = /^(.+)_p(\d+)$/;

/** Split a variable id into its base id and percentile plane. Returns
 *  `percentile: null` when the id carries no `_p{N}` suffix. Purely
 *  syntactic — callers must check the catalog's `percentiles` array on
 *  the base variable before treating the suffix as a percentile plane
 *  (threshold-probability ids like `prob_prec_gt0p1` never match
 *  because the digit run isn't preceded by `_p`). */
export function splitPercentileVar(id: string): {
  base: string;
  percentile: number | null;
} {
  const m = PERCENTILE_SUFFIX_RE.exec(id);
  if (!m) return { base: id, percentile: null };
  return { base: m[1], percentile: parseInt(m[2], 10) };
}

/** One selectable plane of an ensemble variable: the median (bare id),
 *  a percentile (`_p{P}`), the control member (`_ctrl`), an individual
 *  member (`_m{N}`), or the spread view (`_spread`, the server-derived
 *  p90 − p10 width — not a plane of the archive but a sibling derived
 *  variable, mapped per-layer when the catalog publishes it). */
export type EnsemblePlane =
  | { kind: "median" }
  | { kind: "percentile"; p: number }
  | { kind: "control" }
  | { kind: "member"; m: number }
  | { kind: "spread" };

const MEMBER_SUFFIX_RE = /^(.+)_m(\d+)$/;

/** Split a variable id into its base id and ensemble plane. Purely
 *  syntactic — callers must check the catalog (percentiles / control /
 *  members on the base variable) before treating the suffix as an
 *  ensemble plane. */
export function splitEnsembleVar(id: string): {
  base: string;
  plane: EnsemblePlane;
} {
  if (id.endsWith("_ctrl")) {
    return { base: id.slice(0, -"_ctrl".length), plane: { kind: "control" } };
  }
  const pm = PERCENTILE_SUFFIX_RE.exec(id);
  if (pm) {
    return { base: pm[1], plane: { kind: "percentile", p: parseInt(pm[2], 10) } };
  }
  const mm = MEMBER_SUFFIX_RE.exec(id);
  if (mm) {
    return { base: mm[1], plane: { kind: "member", m: parseInt(mm[2], 10) } };
  }
  return { base: id, plane: { kind: "median" } };
}

/** Windowed-aggregation operator. The backend reduces an N-hour window
 *  to a single output frame with one of these ops; the catalog's
 *  `aggregations` capability advertises which ops a variable supports. */
export type AggOp = "max" | "min" | "mean" | "sum";

const WINDOW_OPS = ["max", "min", "mean", "sum"];

/** Build the windowed-aggregation variable id in the `{base}__{n}h_{op}`
 *  grammar. The window length N and the op now live in the variable id
 *  (not in the time span and not in a separate layer field). An empty op
 *  yields `{base}__{n}h` — the exceedance implicit-peak form, where the
 *  backend peaks the threshold probability across the window. The base
 *  may itself carry a percentile (`t_2m_p90`) or exceedance
 *  (`tot_prec_gt2p5mm`) suffix; it is passed through verbatim. */
export function buildWindowVar(base: string, n: number, op: string): string {
  return op ? `${base}__${n}h_${op}` : `${base}__${n}h`;
}

/** Parse a `{base}__{n}h[_{op}]` id back into its parts. Returns
 *  `{ base: id, n: null, op: null }` for any id that doesn't carry a
 *  well-formed window token (no `__`, a non-N-hour left token, or a
 *  non-positive N), so bare ids pass through unchanged. */
export function parseWindowVar(id: string): {
  base: string;
  n: number | null;
  op: string | null;
} {
  const i = id.indexOf("__");
  if (i < 0) return { base: id, n: null, op: null };
  const left = id.slice(0, i);
  let right = id.slice(i + 2);
  let op: string | null = null;
  const j = right.lastIndexOf("_");
  if (j >= 0 && WINDOW_OPS.includes(right.slice(j + 1))) {
    op = right.slice(j + 1);
    right = right.slice(0, j);
  }
  if (!right.endsWith("h")) return { base: id, n: null, op: null };
  const n = parseInt(right.slice(0, -1), 10);
  if (!Number.isFinite(n) || n <= 0) return { base: id, n: null, op: null };
  return { base: left, n, op };
}

export interface Model {
  id: string;
  variables: Variable[];
  latest_run?: string;
  /** True when the model's run axis is synthetic (frame times not
   *  wall-clock meaningful) — lead-hour time display is forced. */
  synthetic_time?: boolean;
  /** Attribution metadata from the backend's per-source `info:` config
   *  block (see api/modelInfo.ts for the registry that consumes it). */
  name?: string;
  description?: string;
  provider?: string;
  provider_url?: string;
  license?: string;
  license_url?: string;
  contributors?: string[];
  /** Lapse-rate elevation-correction capability for this model's
   *  screen-temperature variables. Present (available=true) only when the
   *  server has the DEM archive; the UI gates its toggle on this. */
  lapse?: { available: boolean; default: string; modes: string[] };
}

export interface Run {
  run: string;
  start?: string;
  /** Number of .wxt archives published for this run. */
  variables?: number;
  /** Total size of every .wxt file in the run directory, bytes. */
  size_bytes?: number;
  /** RFC3339 first / last forecast timestep across archives. */
  forecast_start?: string;
  forecast_end?: string;
  /** Forecast timestep count (same across archives in a single run). */
  timesteps?: number;
  /** True when every buffered variable covers the run's full horizon. */
  complete?: boolean;
  /** True when the run's frame times are not wall-clock meaningful. */
  synthetic_time?: boolean;
  /** Per-variable step coverage (variable id → steps present). */
  steps?: Record<string, number>;
}

export interface PointTimeSeriesResponse {
  model: string;
  run: string;
  lat: number;
  lon: number;
  timesteps: string[];
  values: Record<string, (number | null)[]>;
}

export interface StyleMetadata {
  "weather-api:run": string;
  "weather-api:model": string;
  "weather-api:variable": string;
  "weather-api:units": string;
  "weather-api:colormap": string;
  "weather-api:vmin": number;
  "weather-api:vmax": number;
  "weather-api:timesteps": string[];
  "weather-api:active_timestep": string;
  /** RFC3339 UTC anchor: the frame the client should open at (≈ now,
   *  clamped forward past de-accumulation null frames). Optional — older
   *  servers omit it and the client falls back to nearest-now. */
  "weather-api:start"?: string;
  /** True when the active run's frame times are synthetic (not wall-clock
   *  meaningful) — lead-hour display is forced and now-anchoring disabled. */
  "weather-api:synthetic"?: boolean;
}

export interface StyleSource {
  type: "raster";
  tiles: string[];
  tileSize: number;
  minzoom: number;
  maxzoom: number;
  bounds?: [number, number, number, number];
  attribution?: string;
}

export interface StyleLayer {
  id: string;
  type: "raster";
  source: string;
  layout?: { visibility: "visible" | "none" };
  paint?: { "raster-opacity": number };
}

export interface WeatherStyle {
  version: 8;
  name: string;
  sources: Record<string, StyleSource>;
  layers: StyleLayer[];
  metadata: StyleMetadata;
}

export type BaseMapId = "black" | "dark" | "grayscale" | "light" | "white" | "summer" | "winter";
export type ProjectionId = "globe" | "mercator";
export type TimeFormat = "utc" | "local" | "lead";

/**
 * The `auto` composite is a virtual model — it has no on-disk runs of
 * its own and the server always resolves every request to a single
 * "live" tick. NWP variables flow through the resolution-ladder
 * compositor; satellite channels (rgb / r / g / b / nir / cloud)
 * flow through the geostationary view-zenith blender. The frontend
 * never pins `auto` to a specific run, never fetches
 * /models/auto/runs, and never shows a run selector for it. This
 * constant is the single place that string lives so grep stays
 * honest.
 */
export const AUTO_MODEL_ID = "auto";

/** The EPS-only composite: same resolution ladder as `auto` but
 *  without icondglobal, so every blend pixel carries a true ensemble
 *  statistic. */
export const AUTO_EPS_MODEL_ID = "auto_eps";

/** Model ids the backend publishes as composites — no physical
 *  on-disk runs, resolved per-request. After the sat-into-auto
 *  merge there were two composites: the mixed `auto` and the
 *  EPS-only `auto_eps`. */
export const COMPOSITE_MODEL_IDS = new Set([AUTO_MODEL_ID, AUTO_EPS_MODEL_ID]);

export function isCompositeModel(id: string): boolean {
  return COMPOSITE_MODEL_IDS.has(id);
}

export const BASE_MAPS: Record<
  BaseMapId,
  {
    label: string;
    /** When set, the style pair is built programmatically from
     *  @protomaps/basemaps (official fonts/sprites); otherwise the
     *  authored {id}-back/-front documents vendored in public/styles
     *  are fetched. */
    flavor?: "light" | "dark" | "white" | "black" | "grayscale";
  }
> = {
  black: {
    label: "Black",
    flavor: "black",
  },
  dark: {
    label: "Dark",
    flavor: "dark",
  },
  grayscale: {
    label: "Grayscale",
    flavor: "grayscale",
  },
  light: {
    label: "Light",
    flavor: "light",
  },
  white: {
    label: "White",
    flavor: "white",
  },
  summer: {
    label: "Summer",
  },
  winter: {
    label: "Winter",
  },
};

