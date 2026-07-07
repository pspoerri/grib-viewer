import { test } from "node:test";
import assert from "node:assert/strict";
import { windowAggFor } from "../src/api/mapConfig.ts";
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
  ["clct", { name: "clct", units: "%", group: "g", levels: [], available_levels: null, available: true, aggregations: { ops: ["max", "min", "mean"], default: "mean" } } as AvailableVariable],
  ["pmsl", { name: "pmsl", units: "Pa", group: "g", levels: [], available_levels: null, available: true, aggregations: { ops: ["min", "max", "mean"], default: "min" } } as AvailableVariable],
]);

test("precip total (non-chance) sums the window", () => {
  assert.equal(windowAggFor(layer("precip_1h"), varInfo), "sum");
});

test("precip ensemble product still sums (strippedBase resolves through the suffix)", () => {
  assert.equal(windowAggFor(layer("precip_1h_p90"), varInfo), "sum");
});

test("precip chance-of forces max, NOT sum (the confirmed critical bug)", () => {
  assert.equal(windowAggFor(layer("tot_prec_gt2p5mm"), varInfo), "max");
});

test("prob_* precip chance-of alias forces max", () => {
  assert.equal(windowAggFor(layer("prob_prec_gt1mm"), varInfo), "max");
});

test("non-precip variable with no explicit aggOp uses the catalog default", () => {
  assert.equal(windowAggFor(layer("t_2m"), varInfo), "max");
});

test("state-like variable defaults to mean", () => {
  assert.equal(windowAggFor(layer("clct"), varInfo), "mean");
});

test("explicit layer.aggOp wins for non-chance, non-precip variables", () => {
  assert.equal(windowAggFor(layer("t_2m", { aggOp: "min" }), varInfo), "min");
});

test("explicit layer.aggOp does NOT override chance-of's forced max", () => {
  assert.equal(windowAggFor(layer("tot_prec_gt2p5mm", { aggOp: "sum" }), varInfo), "max");
});
