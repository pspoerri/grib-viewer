// Pure gating + product→patch logic for the per-layer ensemble-product
// picker rendered on every tile-layer legend row (Task 4). Extracted from
// the old primary-only PrimaryEpsEntry so each row's options can be gated
// against its own per-model catalogs (auto vs auto_eps on a composite) and
// unit-tested in isolation.
import type {
  AvailableVariable,
  DistCapability,
  EnsembleProducts,
} from "../api/v2catalog.ts";
import {
  DIST_BASES,
  DIST_DISPLAY_BASE,
  medianVarId,
  spreadIdFor,
  strippedBase,
} from "../api/mapConfig.ts";
import type { MapLayer } from "../api/mapConfig.ts";
import { applyProduct, currentProduct, productApplicable } from "../api/products.ts";
import type { Product } from "../api/products.ts";
import { layerModel } from "./epsMode.ts";
import { AUTO_MODEL_ID, isCompositeModel } from "../api/types.ts";

/** Picker products = the ensemble Product enum plus the UI-only `det`
 *  pseudo-product (the Det segment, which routes the layer to the
 *  deterministic composite rather than selecting an ensemble plane). */
export type PickerProduct = Product | "det";

/** Resolved picker gate for one tile layer, computed from the layer's
 *  per-model catalogs. */
export interface LayerGate {
  /** Dist/value base (DIST_BASES-resolved). */
  distBase: string;
  /** Forecast-value id the Det / Med segments restore (display base). */
  displayVar: string;
  /** Catalog entry for `distBase` in the EPS catalog — applyProduct reads
   *  its units (chance path) + ensemble_products (gating). */
  targetVar: AvailableVariable | undefined;
  /** Dist capability of the value base (EPS catalog), or null. */
  dist: DistCapability | null;
  /** `{base}_spread` sibling id, or null. */
  spreadId: string | null;
  /** Ensemble-product caps of `distBase` (EPS catalog), gating the EPS
   *  segments. Null when the EPS catalog lacks the base (e.g. pmsl). */
  caps: EnsembleProducts | null;
  /** True when the display/median base exists in the deterministic
   *  catalog → the `Det` segment is offered. */
  detEnabled: boolean;
  /** True when the EPS catalog backs the median (display) id →
   *  the `Med` segment is offered. On a composite, requires the EPS
   *  catalog to actually carry the variable; on a physical model always
   *  true (bare median is always served). */
  medEnabled: boolean;
  /** True when the picker has at least one option (Det or any EPS
   *  product / dist / spread). When false the row renders plain. */
  hasAny: boolean;
}

/** The layer's effective ensemble mode under the current selectedModel.
 *  composite → AUTO ⇒ "det"; composite → AUTO_EPS or physical model ⇒ "eps". */
export function effectiveLayerMode(
  layer: MapLayer,
  selectedModel: string,
): "det" | "eps" {
  return layerModel(layer, selectedModel) === AUTO_MODEL_ID ? "det" : "eps";
}

/** The master DET|EPS switch mirrors the PRIMARY (first visible tile) layer's
 *  effective mode, so the indicator never disagrees with a per-layer product
 *  pick: picking `Det` on the primary flips the switch to DET, any ensemble
 *  product flips it to EPS. Falls back to the composite default
 *  (`compositeEps`) when there are no tile layers to mirror. Pure — drives the
 *  switch's active side only; it does NOT change `selectedModel`. */
export function masterIndicatorEps(
  tileLayers: MapLayer[],
  selectedModel: string,
  compositeEps: boolean | undefined,
): boolean {
  const primary = tileLayers[0];
  if (primary) return effectiveLayerMode(primary, selectedModel) === "eps";
  return compositeEps === true;
}

/** Resolve the per-layer picker gate.
 *
 *  `detCatalog` is the deterministic-side catalog (`auto` on a composite,
 *  or the model's own catalog on a physical model); `epsCatalog` is the
 *  EPS-side catalog (`auto_eps` on a composite, same as detCatalog on a
 *  physical model). Returns null when the layer has no picker options at
 *  all (so the caller falls back to the plain colorbar row).
 */
export function gateOptions(
  layer: MapLayer,
  detCatalog: Map<string, AvailableVariable>,
  epsCatalog: Map<string, AvailableVariable>,
  selectedModel: string,
): LayerGate | null {
  const id = layer.variable;
  const rawBase = strippedBase(id);
  const distBase = DIST_BASES[rawBase] ?? rawBase;
  const displayVar = DIST_DISPLAY_BASE[distBase] ?? rawBase;

  const epsEntry = epsCatalog.get(distBase);
  const caps = epsEntry?.ensemble_products ?? null;
  const dist = epsEntry?.dist ?? null;
  const spreadId = spreadIdFor(rawBase, epsCatalog);

  // Det is a composite-only concept (the deterministic `auto` flavor). On
  // a physical model det/eps routing is meaningless (ensembleMode is
  // ignored), so the Det segment is suppressed — the legend behaves as it
  // did before this task. On a composite, Det is offered when the
  // median/display base is served by the deterministic catalog. Check both
  // the display var and the raw base so alias families (gusts →
  // wind_gust_10m) resolve correctly.
  const detEnabled =
    isCompositeModel(selectedModel) &&
    (detCatalog.has(displayVar) || detCatalog.has(rawBase));

  // Med is only offered when the EPS catalog actually backs the median id.
  // On a composite this requires the variable to exist in the EPS catalog
  // (e.g. pmsl absent from auto_eps → Med must NOT render). On a physical
  // model the bare median is always served, so medEnabled stays true.
  // Note: on a physical model the Med path is only reachable when gateOptions
  // returns non-null (i.e. caps/dist/spread is present); if none of those
  // exist the function returns null before reaching the picker, so medEnabled
  // being unconditionally true here does not produce a spurious Med segment.
  const medEnabled = isCompositeModel(selectedModel)
    ? epsCatalog.has(displayVar) || epsCatalog.has(rawBase)
    : true;

  const hasEps = caps != null || dist != null || spreadId != null;
  if (!detEnabled && !hasEps) return null;

  return {
    distBase,
    displayVar,
    targetVar: epsEntry,
    dist,
    spreadId,
    caps,
    detEnabled,
    medEnabled,
    hasAny: detEnabled || hasEps,
  };
}

/** Ordered picker segments — Det leads, then inline EPS segments, then
 *  overflow. Exported so MapLegend and tests share a single source of
 *  truth for the segment list and the enable logic. */
export const PICKER_SEGMENTS: { product: PickerProduct; label: string; overflow: boolean }[] = [
  { product: "det", label: "Det", overflow: false },
  { product: "med", label: "Med", overflow: false },
  { product: "mean", label: "Mean", overflow: false },
  { product: "p10", label: "p10", overflow: true },
  { product: "p90", label: "p90", overflow: false },
  { product: "control", label: "Control", overflow: true },
  { product: "p25", label: "p25", overflow: true },
  { product: "p75", label: "p75", overflow: true },
  { product: "min", label: "Min", overflow: true },
  { product: "max", label: "Max", overflow: true },
  { product: "spread", label: "Spread", overflow: true },
  { product: "chance", label: "Chance", overflow: false },
];

/** Whether a picker segment is enabled for a layer's gate.
 *  - `det`  → gate.detEnabled (deterministic catalog has the var)
 *  - `med`  → gate.medEnabled (EPS catalog has the var on a composite;
 *              always true on a physical model)
 *  - others → productApplicable against the EPS caps */
export function segmentEnabled(product: PickerProduct, gate: LayerGate): boolean {
  if (product === "det") return gate.detEnabled;
  if (product === "med") return gate.medEnabled;
  // Spread is gated on the catalog's `{base}_spread` sibling (gate.spreadId),
  // not the ensemble caps — v2 serves spread as a derived variable and the
  // caps' spread flag is a stale v1 leftover pinned to false.
  if (product === "spread") return gate.spreadId != null;
  return productApplicable(product, gate.caps ?? undefined);
}

/** Map a product pick to the layer patch (variable + ensembleMode),
 *  rewriting ONLY this layer (no global composite flip).
 *
 *  - `det`   -> { ensembleMode: "det", variable: medianVarId(layer) }
 *  - `med`   -> { ensembleMode: "eps", variable: displayVar }
 *  - percentile/mean/min/max/spread -> { ensembleMode: "eps", variable:
 *    applyProduct(...) }
 *  - `chance`-> { ensembleMode: "eps" } only — the threshold id is committed
 *    by useThreshold separately (this just flags the mode).
 */
export function productPatch(
  layer: MapLayer,
  product: PickerProduct,
  gate: LayerGate,
): Partial<MapLayer> {
  if (product === "det") {
    return { ensembleMode: "det", variable: medianVarId(layer.variable) };
  }
  if (product === "med") {
    return { ensembleMode: "eps", variable: gate.displayVar };
  }
  if (product === "chance") {
    // The variable (threshold id) is committed by useThreshold; here we
    // only ensure the layer routes to EPS.
    return { ensembleMode: "eps" };
  }
  // Precip products use the consistent display base (precip_{N}h_{product}),
  // not the tot_prec archive base, while still gating on the dist caps
  // (gate.targetVar). The backend serves precip_{N}h_{product} via the member
  // kernel; the window swap then carries the suffix. Other families keep the
  // dist base (e.g. gusts resolve products under vmax_10m, not wind_gust_10m).
  const productBase = gate.distBase === "tot_prec" ? gate.displayVar : gate.distBase;
  return {
    ensembleMode: "eps",
    variable: applyProduct(productBase, product, gate.targetVar, layer.variable),
  };
}

/** Rewrite a persisted/bookmarked product that the current catalog no longer
 * serves. Prefer the ensemble median, then deterministic mode on composites.
 * Returning null means the current product is valid or no safe fallback exists. */
export function unavailableProductPatch(
  layer: MapLayer,
  selectedModel: string,
  gate: LayerGate,
): Partial<MapLayer> | null {
  const active: PickerProduct =
    effectiveLayerMode(layer, selectedModel) === "det"
      ? "det"
      : currentProduct(layer.variable);
  if (segmentEnabled(active, gate)) return null;
  if (gate.medEnabled) return productPatch(layer, "med", gate);
  if (gate.detEnabled) return productPatch(layer, "det", gate);
  return null;
}
