// Pure helpers for the ensemble product taxonomy: mapping variable ids
// to/from a Product enum and rebuilding sticky ids across base changes.
// Both axes live as suffixes on layer.variable — no new persistence.
import type { EnsembleProducts, AvailableVariable } from "./v2catalog.ts";
import { splitEnsembleVar } from "./types.ts";
import { parseThresholdId, formatThresholdId, curatedThreshold } from "./distIds.ts";
import type { ThresholdUnit } from "./distIds.ts";

export type Product =
  | "med"
  | "mean"
  | "control"
  | "p10"
  | "p25"
  | "p75"
  | "p90"
  | "min"
  | "max"
  | "spread"
  | "chance";

const PCT_PRODUCTS: Record<string, number> = { p10: 10, p25: 25, p75: 75, p90: 90 };

/** currentProduct parses the active ensemble suffix on a variable id.
 *  Returns "med" for plain deterministic or p50 ids. */
export function currentProduct(varId: string): Product {
  if (parseThresholdId(varId)) return "chance";
  if (varId.endsWith("_spread")) return "spread";
  if (varId.endsWith("_mean")) return "mean";
  const { plane } = splitEnsembleVar(varId);
  switch (plane.kind) {
    case "control":
      return "control";
    case "percentile":
      if (plane.p === 0) return "min";
      if (plane.p === 100) return "max";
      if (plane.p === 50) return "med";
      if (plane.p === 10) return "p10";
      if (plane.p === 25) return "p25";
      if (plane.p === 75) return "p75";
      if (plane.p === 90) return "p90";
      return "med";
    default:
      return "med";
  }
}

/** productApplicable gates a product against a variable's caps.
 *  "med" is always applicable — the bare id is always served. */
export function productApplicable(
  product: Product,
  caps: EnsembleProducts | undefined,
): boolean {
  if (product === "med") return true;
  if (!caps) return false;
  switch (product) {
    case "mean":
      return caps.mean;
    case "control":
      return caps.control;
    case "min":
      return caps.min;
    case "max":
      return caps.max;
    case "spread":
      return caps.spread;
    case "chance":
      return caps.chance_of;
    case "p10":
    case "p25":
    case "p75":
    case "p90":
      return (caps.percentiles ?? []).includes(PCT_PRODUCTS[product]);
    default:
      return false;
  }
}

/**
 * applyProduct rebuilds the variable id for `base` carrying `product`,
 * falling back to the bare id (Med) when `target` doesn't advertise
 * that product. `prevId` (the id before the switch) seeds the chance
 * threshold direction when no curated default exists for the new base.
 */
export function applyProduct(
  base: string,
  product: Product,
  target: AvailableVariable | undefined,
  prevId?: string,
): string {
  const caps = target?.ensemble_products;
  if (!productApplicable(product, caps)) return base;
  switch (product) {
    case "med":
      return base;
    case "mean":
      return `${base}_mean`;
    case "control":
      return `${base}_ctrl`;
    case "spread":
      return `${base}_spread`;
    case "min":
      return `${base}_p0`;
    case "max":
      return `${base}_p100`;
    case "p10":
    case "p25":
    case "p75":
    case "p90":
      return `${base}_p${PCT_PRODUCTS[product]}`;
    case "chance": {
      // Prefer curated threshold for the new base; fall back to prevId direction.
      const curated = curatedThreshold(base);
      const prev = prevId ? parseThresholdId(prevId) : null;
      const dir = curated?.dir ?? prev?.dir ?? "gt";
      const nativeValue = curated?.nativeValue ?? prev?.nativeValue ?? 0;
      if (!target?.units) return base;
      // Use the native-unit path: groupId null tells resolveToken to look up
      // NATIVE_UNIT_TOKEN[nativeUnits] and treat the value as native.
      const unit: ThresholdUnit = {
        groupId: null,
        optionId: "",
        nativeUnits: target.units,
      };
      return formatThresholdId(base, dir, nativeValue, unit) ?? base;
    }
    default:
      return base;
  }
}
