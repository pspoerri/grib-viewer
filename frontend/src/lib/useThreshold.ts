// Shared threshold state for the request-time exceedance products,
// consumed by BOTH the Controls panel's ThresholdSlider and the map
// legend's draggable marker, so the two surfaces (and the hash /
// presets, via layer.variable) can never disagree. The single source
// of truth is layer.variable: external rewrites (canned variant pick,
// hash/preset load, the other surface committing) re-sync local state
// through parseThresholdId.
import { useEffect, useRef, useState } from "react";
import type { MapLayer } from "../api/mapConfig";
import type { DistCapability } from "../api/v2catalog";
import {
  curatedThreshold,
  formatThresholdId,
  parseThresholdId,
  thresholdDomain,
  thresholdStep,
} from "../api/distIds";
import type { ThresholdDir, ThresholdUnit } from "../api/distIds";
import { resolveActiveUnit } from "../units";
import type { ActiveUnit } from "../units";

// Session memory of the last committed (dir, native value) per dist base,
// so toggling Forecast → Chance-of restores the user's last threshold
// instead of snapping back to the curated default. In-memory only (a
// reload restores via the committed id in the hash); keyed by distBase in
// native units, so it's display-unit independent.
const lastThreshold = new Map<string, { dir: ThresholdDir; nativeValue: number }>();

/** NOTE — chaining constraint: callers must not chain setDir + setValue
 *  in the same tick; each reads the render-time snapshot of the other
 *  value, so a same-tick chain would commit with the stale peer value. */
export interface ThresholdControl {
  /** Active display unit resolved from the dist archive's native units. */
  au: ActiveUnit;
  /** Step-aligned domain in display units (advertised dist.min/max
   *  converted and rounded outward to the family step). */
  lo: number;
  hi: number;
  step: number;
  /** Readout decimals: 1 for sub-integer steps, else 0. */
  decimals: number;
  dir: ThresholdDir;
  /** Current threshold in display units, clamped to [lo, hi]. Before
   *  any threshold is committed this previews at mid-domain. */
  value: number;
  /** True when layer.variable is a threshold id on this dist base —
   *  i.e. the map is showing a probability right now. */
  active: boolean;
  /** Flip the direction. Commits the rewrite only when active (a
   *  preview flip shouldn't re-tile the map). */
  setDir: (d: ThresholdDir) => void;
  /** Move the threshold and commit (debounced ~200 ms). */
  setValue: (v: number) => void;
  /** Commit the current (dir, value) — used by the legend's
   *  "Chance of" chip to enter the mode at mid-domain. */
  commit: () => void;
}

export function useThreshold({
  layer,
  distBase,
  dist,
  unitPrefs,
  onLayerUpdate,
  viaSibling,
  siblingModel,
  onSwitchModel,
}: {
  layer: MapLayer;
  distBase: string;
  dist: DistCapability;
  unitPrefs: Record<string, string>;
  onLayerUpdate: (id: string, patch: Partial<MapLayer>) => void;
  /** When the dist advertisement came from the EPS sibling of a
   *  deterministic model, a commit also switches the model. */
  viaSibling?: boolean;
  siblingModel?: string;
  onSwitchModel?: (model: string) => void;
}): ThresholdControl {
  const au = resolveActiveUnit(dist.units, unitPrefs);
  const unit: ThresholdUnit = {
    groupId: au.groupId,
    optionId: au.option.id,
    nativeUnits: dist.units,
  };
  const step = thresholdStep(au.groupId, au.option.id, dist.units);
  const { lo, hi } = thresholdDomain(dist.min, dist.max, au.option.convert, step);

  const parsed = parseThresholdId(layer.variable);
  const active = parsed != null && parsed.base === distBase;

  // Entry-time default for Chance-of: the last threshold committed on
  // this base this session, else a curated meteorological default, else
  // the rounded mid-domain. Carries dir too, so a `lt` default would
  // enter with ≤. Returned in display units, snapped + clamped.
  const def = (() => {
    const seed = lastThreshold.get(distBase) ?? curatedThreshold(distBase);
    if (seed) {
      const v = Math.round(au.option.convert(seed.nativeValue) / step) * step;
      return { dir: seed.dir, value: Math.min(hi, Math.max(lo, v)) };
    }
    return {
      dir: "gt" as ThresholdDir,
      value: Math.round((lo + hi) / 2 / step) * step,
    };
  })();

  const [dir, setDirState] = useState<ThresholdDir>(
    active && parsed ? parsed.dir : def.dir,
  );
  const [value, setValueState] = useState<number>(() =>
    active && parsed ? au.option.convert(parsed.nativeValue) : def.value,
  );

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // External rewrites (canned variant pick, hash/preset load, the
  // other surface, display unit change) reposition us and supersede
  // any in-flight debounced commit — cancel it so a stale drag can't
  // override the explicit choice (or late-fire a model switch).
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const p = parseThresholdId(layer.variable);
    if (p && p.base === distBase) {
      setDirState(p.dir);
      setValueState(au.option.convert(p.nativeValue));
    } else {
      // Preview (nothing committed): re-seed from remembered/curated/
      // mid-domain so the marker is meaningful across display-unit
      // switches and Forecast↔Chance toggles.
      setDirState(def.dir);
      setValueState(def.value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.variable, distBase, au.option.id]);

  const clamped = Math.min(hi, Math.max(lo, value));

  const commitWith = (d: ThresholdDir, v: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const id = formatThresholdId(distBase, d, v, unit);
      if (!id) return;
      // Remember the committed threshold (in native units) so a later
      // Forecast→Chance toggle on this base restores it.
      const p = parseThresholdId(id);
      if (p) lastThreshold.set(distBase, { dir: p.dir, nativeValue: p.nativeValue });
      onLayerUpdate(layer.id, { variable: id });
      if (viaSibling && siblingModel && onSwitchModel) {
        onSwitchModel(siblingModel);
      }
    }, 200);
  };

  return {
    au,
    lo,
    hi,
    step,
    decimals: step < 1 ? 1 : 0,
    dir,
    value: clamped,
    active,
    setDir: (d) => {
      setDirState(d);
      if (active) commitWith(d, clamped);
    },
    setValue: (v) => {
      setValueState(v);
      commitWith(dir, Math.min(hi, Math.max(lo, v)));
    },
    commit: () => commitWith(dir, clamped),
  };
}
