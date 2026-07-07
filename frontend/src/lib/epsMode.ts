// Pure helpers for the silent, preset-based EPS mode. The design rule
// set (docs/superpowers/specs/2026-06-12-eps-composite-design.md):
// EPS interactions on the mixed composite switch to auto_eps; presets
// declare their flavor via epsMode.
import { AUTO_MODEL_ID, AUTO_EPS_MODEL_ID, isCompositeModel } from "../api/types.ts";
import { medianVarId, strippedBase } from "../api/mapConfig.ts";
import type { MapLayer } from "../api/mapConfig.ts";

/** True when an id's value base is the precip-total family (tot_prec,
 *  precip_1h, precip_Nh) regardless of any ensemble-product suffix. */
function isPrecipBase(varId: string): boolean {
  const base = strippedBase(varId);
  return base === "tot_prec" || base === "precip_1h" || /^precip_\d+h$/.test(base);
}

/** Default EPS product variable when a tile layer flips to ensemble mode.
 *  Most variables default to the Median (bare id = the same central value
 *  DET shows; always served). Precipitation is the exception: its hourly
 *  median rate is ~0 most hours, so a Median default looks empty — default
 *  it to the ensemble MEAN instead (the expected total over the window).
 *  Uses the consistent `precip_{N}h_mean` name (preserving the layer's base
 *  window), which the windowed request path swaps to the active window and
 *  the backend serves from the member kernel. */
export function defaultEpsVariable(layer: MapLayer): string {
  if (isPrecipBase(layer.variable)) {
    const base = strippedBase(layer.variable);
    return `${base === "tot_prec" ? "precip_1h" : base}_mean`;
  }
  return medianVarId(layer.variable);
}

/** The model an EPS interaction (Chance-of, Spread) should switch to,
 *  or null when no switch is needed. Only the mixed composite switches —
 *  physical models already are their own ensemble (or have none). */
export function epsSwitchTarget(model: string): string | null {
  return model === AUTO_MODEL_ID ? AUTO_EPS_MODEL_ID : null;
}

/** The model a preset load resolves to: presets always load the mixed
 *  `auto` composite, and physical-model selections are never overridden. */
export function presetTargetModel(current: string): string {
  if (current !== AUTO_MODEL_ID && current !== AUTO_EPS_MODEL_ID) {
    return current;
  }
  return AUTO_MODEL_ID;
}

/** The model whose catalog gates EPS chrome: the EPS flavor when on
 *  either composite, the model itself otherwise. */
export function epsCatalogModel(model: string): string {
  return model === AUTO_MODEL_ID || model === AUTO_EPS_MODEL_ID
    ? AUTO_EPS_MODEL_ID
    : model;
}

/** The Det/EPS pill state for a model: false = Deterministic (auto),
 *  true = EPS (auto_eps), undefined = not a composite (no pill). */
export function compositeEpsState(model: string): boolean | undefined {
  if (model === AUTO_EPS_MODEL_ID) return true;
  if (model === AUTO_MODEL_ID) return false;
  return undefined;
}

/** The composite model id for a Det/EPS pill choice. */
export function compositeModelForEps(eps: boolean): string {
  return eps ? AUTO_EPS_MODEL_ID : AUTO_MODEL_ID;
}

/** Resolve a layer's request model given the global `selectedModel`.
 *
 *  - Physical (non-composite) `selectedModel`: return `selectedModel`
 *    unchanged — `ensembleMode` is ignored on physical models.
 *  - Composite `selectedModel` (`auto`/`auto_eps`): resolve effective
 *    mode = `layer.ensembleMode ?? (selectedModel==="auto_eps" ? "eps" : "det")`,
 *    then return `compositeModelForEps(mode === "eps")`.
 */
export function layerModel(layer: MapLayer, selectedModel: string): string {
  if (!isCompositeModel(selectedModel)) return selectedModel;
  const effectiveMode =
    layer.ensembleMode ?? (selectedModel === AUTO_EPS_MODEL_ID ? "eps" : "det");
  return compositeModelForEps(effectiveMode === "eps");
}

/** The set of request models in use for a given `selectedModel`.
 *  Composite (`auto`/`auto_eps`): both composite flavors, since any
 *  layer can be routed to either via its `ensembleMode`. Physical: just
 *  the model itself. Drives App.tsx's per-model variable-catalog fetch
 *  (so a layer's metadata resolves against `layerModel(layer)`). */
export function modelsInUse(selectedModel: string): string[] {
  if (isCompositeModel(selectedModel)) {
    return [AUTO_MODEL_ID, AUTO_EPS_MODEL_ID];
  }
  return [selectedModel];
}

/** Master-flip mapper: return a new array of layers with every visible
 *  tile layer's `ensembleMode` set to `mode` and its variable reset to
 *  the median/display base (via `medianVarId`). Hidden layers and
 *  non-tile layers are returned untouched (same object reference).
 *  The input array is never mutated. */
export function bulkApplyMode(layers: MapLayer[], mode: "det" | "eps"): MapLayer[] {
  return layers.map((layer) => {
    if (!layer.visible || layer.displayMode !== "tiles") return layer;
    // DET→EPS picks the per-variable EPS default (Mean for precip, Median
    // for the rest); EPS→DET always returns to the deterministic median.
    const variable =
      mode === "eps" ? defaultEpsVariable(layer) : medianVarId(layer.variable);
    return { ...layer, ensembleMode: mode, variable };
  });
}
