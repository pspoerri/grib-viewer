// Node-run unit tests for the per-layer product-picker gating + patch
// logic (Task 4). No framework; mirrors tests/products.test.ts.
//   node --no-warnings tests/layerProductGate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gateOptions,
  productPatch,
  PICKER_SEGMENTS,
  segmentEnabled,
  masterIndicatorEps,
  type LayerGate,
  type PickerProduct,
} from "../src/lib/layerProductGate.ts";
import type { EnsembleProducts, AvailableVariable } from "../src/api/v2catalog.ts";
import type { MapLayer } from "../src/api/mapConfig.ts";

/** Test helper: every enabled picker product for a gate, in
 *  PICKER_SEGMENTS order (the production `enabledSegments` was removed
 *  as a dead export; the gating logic it composed lives on). */
function enabledSegments(gate: LayerGate): PickerProduct[] {
  return PICKER_SEGMENTS.filter((s) => segmentEnabled(s.product, gate)).map(
    (s) => s.product,
  );
}

const full: EnsembleProducts = {
  median: true,
  mean: true,
  control: true,
  percentiles: [10, 25, 50, 75, 90],
  min: true,
  max: true,
  spread: true,
  chance_of: true,
};

/** Minimal AvailableVariable for tests. */
function mkVar(
  name: string,
  units: string,
  ep: EnsembleProducts | undefined,
): AvailableVariable {
  return {
    name,
    units,
    group: "test",
    levels: [0],
    available_levels: [0],
    available: true,
    ensemble_products: ep,
  } as AvailableVariable;
}

/** Minimal MapLayer for tests. */
function mkLayer(variable: string, mode?: "det" | "eps"): MapLayer {
  return {
    id: "ly-1",
    variable,
    displayMode: "tiles",
    opacity: 1,
    visible: true,
    ensembleMode: mode,
  } as MapLayer;
}

function catalog(...vars: AvailableVariable[]): Map<string, AvailableVariable> {
  return new Map(vars.map((v) => [v.name, v]));
}

// --- gateOptions -----------------------------------------------------------

test("t_2m on a composite: Det enabled + all EPS products gated by caps", () => {
  const det = catalog(mkVar("t_2m", "K", undefined));
  const eps = catalog(mkVar("t_2m", "K", full));
  const g = gateOptions(mkLayer("t_2m"), det, eps, "auto");
  assert.ok(g, "gate should be non-null");
  assert.equal(g.distBase, "t_2m");
  assert.equal(g.detEnabled, true, "t_2m present in det catalog → Det enabled");
  assert.equal(g.medEnabled, true, "t_2m present in eps catalog → Med enabled");
  assert.equal(g.caps, full, "EPS caps come from the eps catalog");
  assert.equal(g.hasAny, true);
  // enabledSegments must include both Det and Med and at least p90
  const segs = enabledSegments(g);
  assert.ok(segs.includes("det"), "t_2m gate: Det segment enabled");
  assert.ok(segs.includes("med"), "t_2m gate: Med segment enabled");
  assert.ok(segs.includes("p90"), "t_2m gate: p90 segment enabled");
});

test("pmsl: present only on auto → Det only, every EPS product disabled", () => {
  // pmsl is on the deterministic catalog but absent from the EPS catalog
  // (no auto_eps archive). Det enabled, caps null → all EPS products off.
  const det = catalog(mkVar("pmsl", "Pa", undefined));
  const eps = catalog(); // no pmsl on auto_eps
  const g = gateOptions(mkLayer("pmsl"), det, eps, "auto");
  assert.ok(g);
  assert.equal(g.detEnabled, true, "pmsl present in det catalog → Det enabled");
  assert.equal(g.medEnabled, false, "pmsl absent from eps catalog → Med disabled");
  assert.equal(g.caps, null, "no pmsl in eps catalog → caps null");
  assert.equal(g.hasAny, true, "Det alone keeps the picker present");
  // Critical: enabledSegments must be exactly ["det"] — no Med, no EPS products
  assert.deepEqual(
    enabledSegments(g),
    ["det"],
    "pmsl gate: only Det segment enabled",
  );
});

test("EPS-only variable: Det disabled, EPS products enabled", () => {
  // The display base is absent from the det catalog but present on EPS.
  const det = catalog(); // not on auto
  const eps = catalog(mkVar("t_2m", "K", full));
  const g = gateOptions(mkLayer("t_2m"), det, eps, "auto");
  assert.ok(g);
  assert.equal(g.detEnabled, false, "absent from det catalog → Det disabled");
  assert.equal(g.medEnabled, true, "t_2m present in eps catalog → Med enabled");
  assert.equal(g.caps, full);
  assert.equal(g.hasAny, true);
  // enabledSegments: no Det, but Med and EPS products present
  const segs = enabledSegments(g);
  assert.ok(!segs.includes("det"), "EPS-only: Det segment not enabled");
  assert.ok(segs.includes("med"), "EPS-only: Med segment enabled");
});

test("no options at all → gate null (plain colorbar row)", () => {
  const det = catalog(); // not on det
  const eps = catalog(mkVar("t_2m", "K", undefined)); // present but no products + no dist/spread
  const g = gateOptions(mkLayer("t_2m"), det, eps, "auto");
  assert.equal(g, null, "neither Det nor any EPS product → no picker");
});

test("alias family: gusts display base resolves Det against the display var", () => {
  // wind_gust_10m is the display base for dist base vmax_10m. Det enables
  // when the display var exists in the det catalog.
  const det = catalog(mkVar("wind_gust_10m", "m s-1", undefined));
  const eps = catalog(mkVar("vmax_10m", "m s-1", full));
  const g = gateOptions(mkLayer("wind_gust_10m"), det, eps, "auto");
  assert.ok(g);
  assert.equal(g.distBase, "vmax_10m");
  assert.equal(g.displayVar, "wind_gust_10m");
  assert.equal(g.detEnabled, true);
  assert.equal(g.caps, full);
});

test("physical model: Det suppressed (no det/eps split), EPS products as before", () => {
  // On a physical model there is no auto/auto_eps split — ensembleMode is
  // ignored, so the Det segment is suppressed and the legend behaves as it
  // did before this task (EPS products gated by caps only).
  const cat = catalog(mkVar("t_2m", "K", full));
  const g = gateOptions(mkLayer("t_2m"), cat, cat, "iconeueps");
  assert.ok(g);
  assert.equal(g.detEnabled, false, "physical model → no Det segment");
  assert.equal(g.medEnabled, true, "physical model → Med always available");
  assert.equal(g.caps, full, "EPS products still gated by caps");
  assert.equal(g.hasAny, true);
  // enabledSegments: no Det, but Med and EPS products present
  const segs = enabledSegments(g);
  assert.ok(!segs.includes("det"), "physical model: Det segment not in enabled set");
  assert.ok(segs.includes("med"), "physical model: Med segment enabled");
});

// --- productPatch ----------------------------------------------------------

const t2mGate = gateOptions(
  mkLayer("t_2m"),
  catalog(mkVar("t_2m", "K", undefined)),
  catalog(mkVar("t_2m", "K", full)),
  "auto",
)!;

test("Det → ensembleMode det + median id", () => {
  const patch = productPatch(mkLayer("t_2m_p90", "eps"), "det", t2mGate);
  assert.equal(patch.ensembleMode, "det");
  assert.equal(patch.variable, "t_2m"); // medianVarId of t_2m_p90
});

test("Med → ensembleMode eps + display var (median form)", () => {
  const patch = productPatch(mkLayer("t_2m_p90", "eps"), "med", t2mGate);
  assert.equal(patch.ensembleMode, "eps");
  assert.equal(patch.variable, "t_2m"); // displayVar
});

test("p90 → ensembleMode eps + _p90 id", () => {
  const patch = productPatch(mkLayer("t_2m", "det"), "p90", t2mGate);
  assert.equal(patch.ensembleMode, "eps");
  assert.equal(patch.variable, "t_2m_p90");
});

test("mean → ensembleMode eps + _mean id", () => {
  const patch = productPatch(mkLayer("t_2m", "det"), "mean", t2mGate);
  assert.equal(patch.ensembleMode, "eps");
  assert.equal(patch.variable, "t_2m_mean");
});

test("spread → ensembleMode eps + _spread id", () => {
  const patch = productPatch(mkLayer("t_2m", "det"), "spread", t2mGate);
  assert.equal(patch.ensembleMode, "eps");
  assert.equal(patch.variable, "t_2m_spread");
});

// Precip products use the consistent precip_{N}h display base, not the
// tot_prec archive base (gate.distBase), while still gating on the dist caps.
const precipGate = gateOptions(
  mkLayer("precip_1h"),
  catalog(mkVar("precip_1h", "mm", undefined)),
  catalog(mkVar("tot_prec", "mm", full), mkVar("precip_1h", "mm", full)),
  "auto",
)!;

test("precip products stay on the consistent precip_{N}h base, not tot_prec", () => {
  assert.equal(precipGate.distBase, "tot_prec"); // caps still keyed on the archive base
  assert.equal(productPatch(mkLayer("precip_1h", "det"), "p90", precipGate).variable, "precip_1h_p90");
  assert.equal(productPatch(mkLayer("precip_1h", "det"), "mean", precipGate).variable, "precip_1h_mean");
  assert.equal(productPatch(mkLayer("precip_1h", "det"), "spread", precipGate).variable, "precip_1h_spread");
});

test("chance → ensembleMode eps only (variable committed by useThreshold)", () => {
  const patch = productPatch(mkLayer("t_2m", "det"), "chance", t2mGate);
  assert.equal(patch.ensembleMode, "eps");
  assert.equal(
    patch.variable,
    undefined,
    "chance leaves variable to the threshold commit",
  );
});

test("inline row promotes Chance and demotes p10 to overflow", () => {
  const chance = PICKER_SEGMENTS.find((s) => s.product === "chance")!;
  const p10 = PICKER_SEGMENTS.find((s) => s.product === "p10")!;
  assert.equal(chance.overflow, false, "Chance is inline");
  assert.equal(chance.label, "Chance", "Chance uses the compact label");
  assert.equal(p10.overflow, true, "p10 moved to the overflow menu");

  // Full t_2m gate: inline product row = Det · Med · Mean · p90 · Chance.
  const inline = PICKER_SEGMENTS.filter(
    (s) => !s.overflow && segmentEnabled(s.product, t2mGate),
  ).map((s) => s.product);
  assert.deepEqual(inline, ["det", "med", "mean", "p90", "chance"]);

  // p10 is still reachable — now via the overflow group; chance is not.
  const overflow = PICKER_SEGMENTS.filter(
    (s) => s.overflow && segmentEnabled(s.product, t2mGate),
  ).map((s) => s.product);
  assert.ok(overflow.includes("p10"), "p10 reachable via overflow");
  assert.ok(!overflow.includes("chance"), "chance no longer in overflow");
});

test("masterIndicatorEps mirrors the primary tile layer", () => {
  const det = mkLayer("t_2m", "det");
  const eps = mkLayer("t_2m", "eps");

  // Primary layer det while selectedModel is auto_eps → indicator reads DET.
  assert.equal(masterIndicatorEps([det], "auto_eps", true), false);
  // Primary layer eps while selectedModel is auto → indicator reads EPS.
  assert.equal(masterIndicatorEps([eps], "auto", false), true);
  // Only the FIRST (primary) layer is mirrored; a secondary is ignored.
  assert.equal(masterIndicatorEps([det, eps], "auto_eps", true), false);
  // No tile layers → fall back to the composite default (compositeEps).
  assert.equal(masterIndicatorEps([], "auto_eps", true), true);
  assert.equal(masterIndicatorEps([], "auto", false), false);
});

console.log("layerProductGate tests passed");
