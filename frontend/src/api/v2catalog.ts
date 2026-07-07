/**
 * v2catalog — map the `/api/models` catalog into the `Model` / `Variable` /
 * `AvailableVariable` types the App.tsx UI (pickers, legend, controls)
 * consumes, so the API reroute doesn't rewrite every consumer. Ensemble
 * product capabilities come straight from the catalog's `products` object;
 * the per-variable legend window (vmin/vmax/colormap) carries through.
 */
import type { Model, Variable } from "./types.js";
import { fetchV2Models } from "./v2client.ts";
import type { V2ModelCat, V2VarCat } from "./v2client.js";

// ---------------------------------------------------------------------------
// Catalog types. These describe the variable-catalog / legend vocabulary the
// pickers + legend consume; the /api/models catalog is mapped into them by
// v2VarsToAvailable below. Shapes are preserved so consumers don't churn.
// ---------------------------------------------------------------------------

/** Animation hint for variables that can be rendered as a streaming
 *  vector field (e.g. particle streamlines, barbs) on top of the scalar
 *  raster tiles. Non-null for derived wind_speed / wind_dir at every
 *  level where raw u/v components are on disk. */
export interface AnimationSpec {
  /** Currently always "vector" for 2-D horizontal wind. */
  kind: string;
  /** Archive id of the zonal (east-west) component (e.g. "u_10m"). */
  u_var: string;
  /** Archive id of the meridional (north-south) component. */
  v_var: string;
  /** Bundle alias delivering both u and v from /grid and /data. */
  bundle: string;
  /** Vertical level (0 = surface / 10m, positive = archive level). */
  level?: number;
}

/** Request-time distribution (chance-of) capability. Derived from the
 *  catalog's `products.members` count + the variable's value envelope:
 *  member count > 0 enables arbitrary `{base}_gt{V}{unit}` / `_lt` exceedance
 *  ids and arbitrary `{base}_p{P}` percentiles; min/max drive slider domains
 *  (native units). */
export interface DistCapability {
  units: string;
  min: number;
  max: number;
  member_count: number;
}

/** An inert distribution capability — units-less, member-less placeholder
 *  used when a variable has no exceedance capability. */
export const INERT_DIST: DistCapability = { units: "", min: 0, max: 1, member_count: 0 };

/** Ensemble product capabilities advertised per variable by the backend.
 *  Drives which Product enum values the legend can offer. */
export interface EnsembleProducts {
  median: boolean;
  mean: boolean;
  control: boolean;
  percentiles?: number[];
  min: boolean;
  max: boolean;
  spread: boolean;
  chance_of: boolean;
}

/** Variable info as the pickers / legend consume it. */
export interface AvailableVariable {
  name: string;
  long_name?: string;
  units: string;
  default_colormap?: string;
  /** Canonical legend window (SI units) — the range the renderers use. */
  vmin?: number;
  vmax?: number;
  group: string;
  group_label?: string;
  /** Vertical level indices. Surface single-level variables yield [0]. */
  levels: number[];
  /** Nullable: null when no level has a published archive. */
  available_levels: number[] | null;
  available: boolean;
  /** True when the variable is part of the model's default (curated) set. */
  curated?: boolean;
  /** True for derived variables computed on demand from source archive(s). */
  derived?: boolean;
  default_contour_interval?: number;
  /** Points wind magnitude/direction variables at the raw u/v sources. */
  animation?: AnimationSpec;
  /** Ensemble percentile planes published for this variable. */
  percentiles?: number[];
  /** True when the latest run carries a control plane (`_ctrl`). */
  control?: boolean;
  /** Individually selectable ensemble member numbers (`_m{N}`). */
  members?: number[];
  /** Request-time distribution (chance-of) capability; absent when the run
   *  carries no addressable members. */
  dist?: DistCapability;
  /** Ensemble product capabilities; absent on deterministic variables. */
  ensemble_products?: EnsembleProducts;
  /** Windowed-aggregation capability: the ops the backend will reduce an
   *  N-hour window with, plus the default op. */
  aggregations?: { ops: string[]; default: string };
}

/** Variable metadata as the legend panel consumes it. */
export interface VariableMeta {
  model: string;
  run: string;
  variable: string;
  units: string;
  colormap: string;
  /** Observed value envelope across the archive. */
  stats: { min: number; max: number };
  /** Canonical legend window — the range the tile renderer stretches the
   *  colormap over (fieldWindow), unit-converted to match `units`. */
  vmin?: number;
  vmax?: number;
}

function toVariable(v: V2VarCat): Variable {
  return {
    name: v.name,
    units: v.units,
    long_name: v.long_name,
    default_colormap: v.colormap,
    levels: [0],
    percentiles: v.eps ? v.products?.percentiles : undefined,
  };
}

export function v2ModelsToModels(cats: V2ModelCat[]): Model[] {
  return cats.map((c) => ({
    id: c.id,
    latest_run: c.latest_run,
    synthetic_time: c.synthetic_time,
    name: c.name,
    description: c.description,
    provider: c.provider,
    provider_url: c.provider_url,
    license: c.license,
    license_url: c.license_url,
    contributors: c.contributors,
    variables: c.variables.map(toVariable),
  }));
}

/** Windowed-aggregation ops. The catalog now advertises them per variable
 *  (`aggregations: {default, valid}`); the heuristic below remains as the
 *  fallback vocabulary when a catalog entry omits them:
 *  - summable per-frame quantities (sunshine duration) → Sum;
 *  - precipitation → none: it reduces via the precip_{N}h accumulation
 *    family (the legend's "Total" path), not an aggOp;
 *  - probabilities → none: chance-of peaks across the window ("Peak" chip);
 *  - everything instantaneous → Max / Min / Mean, defaulting Max for
 *    episodic fields and Mean for state-like ones. */
function aggsFor(v: V2VarCat): { ops: string[]; default: string } | undefined {
  if (v.aggregations && v.aggregations.valid.length > 0) {
    return { ops: v.aggregations.valid, default: v.aggregations.default };
  }
  const n = v.name;
  if (n === "dursun" || n === "dursun_1h" || /_gsp_1h$/.test(n)) {
    return { ops: ["sum"], default: "sum" };
  }
  if (n === "tot_prec" || n.startsWith("precip_") || n.startsWith("rain_") || n.startsWith("snow_") || n.startsWith("prob_")) {
    return undefined;
  }
  const meanish =
    v.units === "%" ||
    v.units === "Pa" ||
    v.units === "hPa" ||
    /^W ?m-2$/.test(v.units) ||
    n.startsWith("clc") ||
    n.startsWith("relhum") ||
    n === "pmsl" ||
    n === "ps";
  return { ops: ["max", "min", "mean"], default: meanish ? "mean" : "max" };
}

function toAvailable(v: V2VarCat): AvailableVariable {
  const members = v.products?.members ?? 0;
  return {
    name: v.name,
    long_name: v.long_name,
    units: v.units,
    default_colormap: v.colormap,
    vmin: v.vmin,
    vmax: v.vmax,
    // The catalog has no group taxonomy yet; a single bucket keeps the
    // picker functional (grouping is a later refinement).
    group: "all",
    group_label: "All",
    levels: [0],
    available_levels: [0],
    available: true,
    curated: true,
    aggregations: aggsFor(v),
    percentiles: v.eps ? v.products?.percentiles : undefined,
    control: v.eps ? v.products?.control : undefined,
    members:
      v.eps && members > 0
        ? Array.from({ length: members }, (_, i) => i + 1)
        : undefined,
    // Member-distribution (chance-of) capability — drives the legend
    // slider's domain + the threshold-id grammar. Addressable members
    // imply per-member exceedance server-side.
    dist:
      v.eps && members > 0
        ? { units: v.units, min: v.vmin, max: v.vmax, member_count: members }
        : undefined,
    // Ensemble products the run actually backs, straight from the catalog's
    // `products` capability.
    ensemble_products: v.eps
      ? {
          median: v.products?.median ?? true,
          mean: v.products?.mean ?? false,
          control: v.products?.control ?? false,
          percentiles: v.products?.percentiles ?? [],
          min: v.products?.min ?? false,
          max: v.products?.max ?? false,
          spread: v.products?.spread ?? false,
          chance_of: members > 0,
        }
      : undefined,
  };
}

export function v2VarsToAvailable(cat: V2ModelCat): AvailableVariable[] {
  return cat.variables.map(toAvailable);
}

// Session cache of the /api/models catalog so fetchV2AvailableVariables
// doesn't refetch per model. Cleared on failure so a retry re-fetches.
let modelsCache: Promise<V2ModelCat[]> | null = null;

/** Load the /api/models catalog (cached for the session) and map the
 *  requested model's variables to the AvailableVariable shape the pickers
 *  consume. Empty list for an unknown model. */
export async function fetchV2AvailableVariables(
  model: string,
): Promise<AvailableVariable[]> {
  if (!modelsCache) {
    modelsCache = fetchV2Models();
    modelsCache.catch(() => {
      modelsCache = null;
    });
  }
  const cats = await modelsCache;
  const cat = cats.find((c) => c.id === model);
  return cat ? v2VarsToAvailable(cat) : [];
}
