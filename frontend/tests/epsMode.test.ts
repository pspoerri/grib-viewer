// Node-run unit tests (no framework, mirrors tests/distIds.test.ts).
import assert from "node:assert/strict";
import {
  epsSwitchTarget,
  presetTargetModel,
  epsCatalogModel,
  bulkApplyMode,
} from "../src/lib/epsMode.ts";
import type { MapLayer } from "../src/api/mapConfig.ts";

function mkLayer(variable: string): MapLayer {
  return {
    id: variable,
    variable,
    displayMode: "tiles",
    opacity: 1,
    visible: true,
    ensembleMode: "det",
  } as MapLayer;
}

// Silent switch: EPS interactions on the mixed composite land on
// auto_eps; everything else stays put.
assert.equal(epsSwitchTarget("auto"), "auto_eps");
assert.equal(epsSwitchTarget("auto_eps"), null);
assert.equal(epsSwitchTarget("iconeueps"), null);
assert.equal(epsSwitchTarget("icondglobal"), null);

// Preset model resolution: presets always load the mixed `auto`
// composite; a physical model selection is never overridden.
assert.equal(presetTargetModel("auto"), "auto");
assert.equal(presetTargetModel("auto_eps"), "auto");
assert.equal(presetTargetModel("iconch1"), "iconch1");

// EPS-chrome catalog model: both composites resolve to auto_eps;
// physical models resolve to themselves.
assert.equal(epsCatalogModel("auto"), "auto_eps");
assert.equal(epsCatalogModel("auto_eps"), "auto_eps");
assert.equal(epsCatalogModel("iconeueps"), "iconeueps");

// bulkApplyMode (master DET↔EPS switch): DET→EPS defaults precip to the
// ensemble MEAN (its hourly median is ~0), everything else to the median;
// EPS→DET always returns to the deterministic median.
{
  const layers = [mkLayer("t_2m_p90"), mkLayer("tot_prec_p90"), mkLayer("precip_1h")];
  const eps = bulkApplyMode(layers, "eps");
  assert.equal(eps[0].variable, "t_2m", "non-precip → EPS median (bare id)");
  assert.equal(eps[0].ensembleMode, "eps");
  assert.equal(eps[1].variable, "precip_1h_mean", "precip (tot_prec) → consistent EPS mean");
  assert.equal(eps[2].variable, "precip_1h_mean", "precip (precip_1h) → consistent EPS mean");

  // Flipping back to DET drops the mean → deterministic precip display.
  const det = bulkApplyMode(eps, "det");
  assert.equal(det[1].ensembleMode, "det");
  assert.equal(det[1].variable, "precip_1h", "EPS→DET returns to the precip median display");
}

console.log("epsMode tests passed");
