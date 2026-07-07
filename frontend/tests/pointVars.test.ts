import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pointVarForLayer,
  visibleWindowedVariables,
  createLayer,
} from "../src/api/mapConfig.ts";
import type { MapLayer } from "../src/api/mapConfig.ts";
import type { AvailableVariable } from "../src/api/v2catalog.ts";

function layer(variable: string, extra: Partial<MapLayer> = {}): MapLayer {
  return {
    id: variable,
    variable,
    displayMode: "tiles",
    opacity: 1,
    visible: true,
    ...extra,
  } as MapLayer;
}

const varInfo = new Map<string, AvailableVariable>([
  ["t_2m", { name: "t_2m", units: "K", group: "g", levels: [], available_levels: null, available: true, aggregations: { ops: ["max", "min", "mean"], default: "max" } } as AvailableVariable],
  ["pmsl", { name: "pmsl", units: "Pa", group: "g", levels: [], available_levels: null, available: true, aggregations: { ops: ["min", "max", "mean"], default: "min" } } as AvailableVariable],
  // wetbulb_2m: no aggregations advertised (diagnostic) → graceful bare id
  ["wetbulb_2m", { name: "wetbulb_2m", units: "K", group: "g", levels: [], available_levels: null, available: true } as AvailableVariable],
  // rain_gsp_1h: de-accumulated per-hour rate → SUM the window total (matches
  // the drape's agg=sum, so point/hover and the map agree).
  ["rain_gsp_1h", { name: "rain_gsp_1h", units: "mm", group: "g", levels: [], available_levels: null, available: true, aggregations: { ops: ["sum"], default: "sum" } } as AvailableVariable],
]);

test("hourly mode returns the bare effective var id (no window mod)", () => {
  assert.equal(pointVarForLayer(layer("t_2m"), "hourly", 1, varInfo), "t_2m");
  assert.equal(pointVarForLayer(layer("t_2m_p90"), "hourly", 1, varInfo), "t_2m_p90");
});

test("value layer gets {base}__{N}h_{op} with the variable's default op", () => {
  assert.equal(pointVarForLayer(layer("t_2m"), "6h", 6, varInfo), "t_2m__6h_max");
  assert.equal(pointVarForLayer(layer("pmsl"), "12h", 12, varInfo), "pmsl__12h_min");
});

test("explicit layer.aggOp overrides the default op", () => {
  assert.equal(pointVarForLayer(layer("t_2m", { aggOp: "min" }), "6h", 6, varInfo), "t_2m__6h_min");
});

test("ensemble product composes with the window mod (reduce-after-select)", () => {
  assert.equal(pointVarForLayer(layer("t_2m_p90"), "6h", 6, varInfo), "t_2m_p90__6h_max");
});

test("chance-of (_gt/_lt) uses the implicit-peak form {base}__{N}h", () => {
  assert.equal(pointVarForLayer(layer("t_2m_gt20c"), "6h", 6, varInfo), "t_2m_gt20c__6h");
});

test("precip Total resolves to the precip_{N}h accumulation", () => {
  assert.equal(pointVarForLayer(layer("precip_1h"), "6h", 6, varInfo), "precip_6h");
  assert.equal(pointVarForLayer(layer("tot_prec"), "daily", 24, varInfo), "precip_24h");
});

test("precip ensemble products keep their suffix across the window swap", () => {
  // The window swaps in the NAME (precip_{N}h_{product}); the suffix is preserved.
  assert.equal(pointVarForLayer(layer("precip_1h_mean"), "6h", 6, varInfo), "precip_6h_mean");
  assert.equal(pointVarForLayer(layer("precip_1h_p90"), "12h", 12, varInfo), "precip_12h_p90");
  // hourly mode leaves the (bare 1h) product id untouched
  assert.equal(pointVarForLayer(layer("precip_1h_mean"), "hourly", 1, varInfo), "precip_1h_mean");
});

test("createLayer canonicalises tot_prec → precip_1h (never the since-run-start cumulative)", () => {
  assert.equal(createLayer("tot_prec", "tiles").variable, "precip_1h");
  // non-precip vars pass through untouched
  assert.equal(createLayer("t_2m", "tiles").variable, "t_2m");
  assert.equal(createLayer("precip_6h", "tiles").variable, "precip_6h");
});

test("de-accumulated grid-scale rate sums the window total (point ≡ drape agg=sum)", () => {
  assert.equal(pointVarForLayer(layer("rain_gsp_1h"), "daily", 24, varInfo), "rain_gsp_1h__24h_sum");
  assert.equal(pointVarForLayer(layer("rain_gsp_1h"), "6h", 6, varInfo), "rain_gsp_1h__6h_sum");
});

test("a variable with no advertised aggregations stays bare (graceful)", () => {
  assert.equal(pointVarForLayer(layer("wetbulb_2m"), "6h", 6, varInfo), "wetbulb_2m");
});

test("visibleWindowedVariables maps visible layers and dedups", () => {
  const layers = [
    layer("t_2m"),
    layer("pmsl", { visible: false }),
    layer("t_2m"), // dup → collapsed
  ];
  assert.deepEqual(visibleWindowedVariables(layers, "6h", 6, varInfo), ["t_2m__6h_max"]);
  assert.deepEqual(visibleWindowedVariables(layers, "hourly", 1, varInfo), ["t_2m"]);
});
