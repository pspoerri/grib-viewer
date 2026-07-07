import { test } from "node:test";
import assert from "node:assert/strict";
import {
  primaryAggOp,
  inheritedWindowOp,
  windowedWindVars,
  gridWindComponents,
  windowedGridVars,
} from "../src/api/mapConfig.ts";
import type { MapLayer } from "../src/api/mapConfig.ts";
import type { AvailableVariable } from "../src/api/v2catalog.ts";

function layer(variable: string, extra: Partial<MapLayer> = {}): MapLayer {
  return { id: variable, variable, displayMode: "tiles", opacity: 1, visible: true, ...extra } as MapLayer;
}
function av(name: string, ops: string[], def: string): AvailableVariable {
  return { name, units: "", group: "g", levels: [], available_levels: null, available: true, aggregations: { ops, default: def } } as AvailableVariable;
}
const varInfo = new Map<string, AvailableVariable>([
  ["wind_gust_10m", av("wind_gust_10m", ["max"], "max")],
  ["wind_speed_10m", av("wind_speed_10m", ["max", "mean"], "max")],
  ["u_10m", av("u_10m", ["max"], "max")],
  ["v_10m", av("v_10m", ["max"], "max")],
]);

test("primaryAggOp reads the first visible tiles layer's op (or default)", () => {
  const layers = [
    layer("wind_gust_10m", { displayMode: "tiles", aggOp: undefined }),
    layer("wind_speed_10m", { displayMode: "flow" }),
  ];
  assert.equal(primaryAggOp(layers, varInfo), "max");
  layers[0] = layer("wind_speed_10m", { displayMode: "tiles", aggOp: "mean" });
  assert.equal(primaryAggOp(layers, varInfo), "mean");
});

test("inheritedWindowOp clamps the primary op to the layer's caps", () => {
  // gust primary picked nothing → max; speed supports it.
  assert.equal(inheritedWindowOp(layer("wind_speed_10m"), "mean", varInfo), "mean");
  // primary picked an op the layer's var can't do → fall back to its default.
  assert.equal(inheritedWindowOp(layer("u_10m"), "mean", varInfo), "max");
  // no caps for the layer → null.
  assert.equal(inheritedWindowOp(layer("nope"), "max", varInfo), null);
});

test("windowedWindVars builds the per-component pair", () => {
  assert.equal(windowedWindVars("u_10m", "v_10m", 6, "max"), "u_10m__6h_max,v_10m__6h_max");
});

test("gridWindComponents resolves bundle + explicit components", () => {
  assert.deepEqual(gridWindComponents(layer("wind_speed_10m", { gridBundle: "wind" })), ["u_10m", "v_10m"]);
  assert.deepEqual(gridWindComponents(layer("x", { flowUVar: "u_500hpa", flowVVar: "v_500hpa" })), ["u_500hpa", "v_500hpa"]);
  assert.equal(gridWindComponents(layer("t_2m")), null);
});

test("windowedGridVars: wind bundle → windowed pair, scalar → windowed single, hourly → null", () => {
  const gust = layer("wind_speed_10m", { gridBundle: "wind", displayMode: "barbs" });
  assert.equal(windowedGridVars(gust, "6h", 6, varInfo, "max"), "u_10m__6h_max,v_10m__6h_max");
  const val = layer("wind_speed_10m", { displayMode: "value" });
  assert.equal(windowedGridVars(val, "6h", 6, varInfo, "mean"), "wind_speed_10m__6h_mean");
  assert.equal(windowedGridVars(gust, "hourly", 1, varInfo, "max"), null);
});
