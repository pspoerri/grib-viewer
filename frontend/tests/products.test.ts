// Unit tests for the ensemble Product taxonomy helpers.
// Run directly by Node (>= 23.6 type stripping):
//   node --no-warnings tests/products.test.ts
// Wired into `npm run lint` via test:unit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { currentProduct, applyProduct, productApplicable } from "../src/api/products.ts";
import type { EnsembleProducts, AvailableVariable } from "../src/api/v2catalog.ts";

const full: EnsembleProducts = {
  median: true, mean: true, control: true,
  percentiles: [10, 25, 50, 75, 90], min: true, max: true,
  spread: true, chance_of: true,
};

/** Helper: build a minimal AvailableVariable for tests. */
function mkVar(name: string, units: string, ep: EnsembleProducts | undefined): AvailableVariable {
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

test("currentProduct parses each suffix", () => {
  assert.equal(currentProduct("t_2m"), "med");
  assert.equal(currentProduct("t_2m_mean"), "mean");
  assert.equal(currentProduct("t_2m_ctrl"), "control");
  assert.equal(currentProduct("t_2m_p90"), "p90");
  assert.equal(currentProduct("t_2m_p0"), "min");
  assert.equal(currentProduct("t_2m_p100"), "max");
  assert.equal(currentProduct("t_2m_spread"), "spread");
  assert.equal(currentProduct("tot_prec_gt2p5mm"), "chance");
});

test("applyProduct rebuilds id for a new base", () => {
  const target = mkVar("td_2m", "K", full);
  assert.equal(applyProduct("td_2m", "mean", target), "td_2m_mean");
  assert.equal(applyProduct("td_2m", "p90", target), "td_2m_p90");
  assert.equal(applyProduct("td_2m", "min", target), "td_2m_p0");
  assert.equal(applyProduct("td_2m", "max", target), "td_2m_p100");
  assert.equal(applyProduct("td_2m", "spread", target), "td_2m_spread");
  assert.equal(applyProduct("td_2m", "med", target), "td_2m");
});

test("applyProduct falls back to med when product not applicable", () => {
  const noDist: EnsembleProducts = {
    ...full, mean: false, min: false, max: false, chance_of: false, spread: false, percentiles: [],
  };
  assert.equal(applyProduct("wetbulb_2m", "mean", undefined), "wetbulb_2m");
  assert.equal(applyProduct("clct", "spread", mkVar("clct", "%", noDist)), "clct");
  // percentile not in caps → med
  assert.equal(
    applyProduct("clct", "p25", mkVar("clct", "%", { ...noDist, percentiles: [10, 50, 90] })),
    "clct",
  );
});

test("applyProduct preserves chance threshold direction for new base", () => {
  // switching base while in chance mode uses curated threshold for the new base
  const target = mkVar("vmax_10m", "m s-1", full);
  const id = applyProduct("vmax_10m", "chance", target, "t_2m_gt20c");
  assert.ok(id.includes("_gt") || id.includes("_lt"), `got ${id}`);
  // vmax_10m has curated gt threshold → expect gt14ms
  assert.equal(id, "vmax_10m_gt14ms");
});

test("productApplicable gates per caps", () => {
  assert.equal(productApplicable("mean", full), true);
  assert.equal(productApplicable("p25", full), true);
  assert.equal(productApplicable("p25", { ...full, percentiles: [10, 50, 90] }), false);
  assert.equal(productApplicable("spread", { ...full, spread: false }), false);
  assert.equal(productApplicable("med", undefined), true); // med always ok
});
