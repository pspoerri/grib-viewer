// Human-readable label + value unit for a (possibly windowed / ensemble /
// exceedance) variable id, for the hover readout. Mirrors the legend's
// label intent but works from the id + catalog alone (the hover has no
// live legend state). Pure — unit-tested in varDisplay.test.ts.

import type { Variable, EnsemblePlane } from "./types.ts";
import { parseWindowVar, splitEnsembleVar } from "./types.ts";
import { parseThresholdId } from "./distIds.ts";
import { resolveActiveUnit } from "../units.ts";

export interface VarDisplay {
  /** Human-readable label, e.g. "Total precipitation ≥1.6 mm/h chance (24h)". */
  label: string;
  /** Unit suffix for the value ("%", "°C", "mm/h", …); "" when unitless. */
  unitLabel: string;
  /** Native→display conversion for the raw value (identity for chance). */
  convert: (v: number) => number;
}

/** Compact number: one decimal, trailing ".0" dropped. */
const fmtNum = (n: number): string => String(+n.toFixed(1));

/** Adaptive title for a precipitation-total layer/readout: the per-window
 *  accumulation, never the since-run-start cumulative. Adapts to the
 *  selected aggregation: hourly → "Precipitation (1h)"; an N-hour window
 *  → "Precipitation (Nh total)". */
export function precipTotalTitle(spanHours: number): string {
  return spanHours <= 1
    ? "Precipitation (1h)"
    : `Precipitation (${spanHours}h total)`;
}

/** Window length (hours) of a precip-total id (precip_{N}h, or the legacy
 *  `tot_prec` which now serves the 1-hour total), or null when `id` isn't
 *  one — so a chance-of/exceedance precip id (prob_prec_*, tot_prec_gt*)
 *  keeps its own label. */
function precipTotalSpan(id: string): number | null {
  if (id === "tot_prec") return 1;
  const m = /^precip_(\d+)h$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** Plane qualifier for the non-median ensemble planes. */
function planeQual(plane: EnsemblePlane): string {
  switch (plane.kind) {
    case "percentile":
      return `p${plane.p}`;
    case "control":
      return "control";
    case "member":
      return `member ${plane.m}`;
    default:
      return ""; // median → no qualifier (the bare id is p50)
  }
}

/**
 * Describe a variable id for display: a friendly label and the value's
 * unit. Handles exceedance/"chance" products (→ %), the ensemble spread,
 * percentile / control / member / mean planes, and the `__{N}h[_op]`
 * window modifier, falling back to the catalog `long_name` then the base
 * id (never the raw uppercased id the popup previously showed).
 */
export function describeVar(
  id: string,
  catalog: Variable[],
  unitPrefs: Record<string, string>,
): VarDisplay {
  const byName = (n: string): Variable | undefined =>
    catalog.find((m) => m.name === n);
  const { base: noWin, n: winHours, op } = parseWindowVar(id);
  const winTag = winHours ? `${winHours}h${op ? ` ${op}` : ""}` : "";

  // Exceedance / Chance-of product (`{base}_gt|lt{V}{unit}`, after the
  // window strip) → a probability in percent, NOT the base's unit.
  const thr = parseThresholdId(noWin);
  if (thr) {
    const meta = byName(thr.base);
    const long = meta?.long_name ?? thr.base;
    const distUnits = meta?.dist?.units ?? meta?.units ?? "";
    const au = resolveActiveUnit(distUnits, unitPrefs);
    const cmp = thr.dir === "lt" ? "≤" : "≥";
    const valStr = fmtNum(au.option.convert(thr.nativeValue));
    const unit = au.option.label ? ` ${au.option.label}` : "";
    const win = winHours ? ` (${winHours}h)` : "";
    return {
      label: `${long} ${cmp}${valStr}${unit} chance${win}`,
      unitLabel: "%",
      convert: (v) => v,
    };
  }

  // Ensemble spread (server-derived p90−p10 width) — sits in the base's
  // own units, not a probability.
  if (noWin.endsWith("_spread")) {
    const base = noWin.slice(0, -"_spread".length);
    const meta = byName(base);
    const au = resolveActiveUnit(meta?.units ?? "", unitPrefs);
    const tag = ["spread", winTag].filter(Boolean).join(", ");
    return {
      label: `${meta?.long_name ?? base} (${tag})`,
      unitLabel: au.option.label,
      convert: au.option.convert,
    };
  }

  // Precipitation total (per-window accumulation): precip_{N}h, or the
  // legacy tot_prec id. The title adapts to the window; the value is mm.
  const precipSpan = precipTotalSpan(noWin);
  if (precipSpan !== null) {
    const meta = byName(noWin) ?? byName("tot_prec");
    const au = resolveActiveUnit(meta?.units ?? "mm", unitPrefs);
    return {
      label: precipTotalTitle(precipSpan),
      unitLabel: au.option.label,
      convert: au.option.convert,
    };
  }

  // Plain / percentile / control / member / ensemble-mean planes.
  const isMean = noWin.endsWith("_mean");
  const coreId = isMean ? noWin.slice(0, -"_mean".length) : noWin;
  const { base, plane } = splitEnsembleVar(coreId);
  const meta = byName(noWin) ?? byName(coreId) ?? byName(base);
  const long = meta?.long_name ?? base;
  const au = resolveActiveUnit(meta?.units ?? "", unitPrefs);

  const quals = [
    isMean ? "mean" : "",
    planeQual(plane),
    winTag,
  ].filter(Boolean);
  const label = quals.length ? `${long} (${quals.join(", ")})` : long;
  return { label, unitLabel: au.option.label, convert: au.option.convert };
}
