import { test } from "node:test";
import assert from "node:assert/strict";
import { v2ModelsToModels, v2VarsToAvailable } from "../src/api/v2catalog.ts";
import type { V2ModelCat } from "../src/api/v2client.ts";

const cat: V2ModelCat = {
  id: "icond2",
  latest_run: "2026-06-28T18:00:00Z",
  synthetic_time: false,
  variables: [
    {
      name: "t_2m",
      units: "K",
      long_name: "2m temperature",
      colormap: "stepped_temp_2m",
      vmin: 200,
      vmax: 330,
      eps: true,
      products: {
        median: true,
        mean: true,
        control: true,
        min: true,
        max: true,
        spread: true,
        percentiles: [10, 25, 50, 75, 90],
        members: 20,
      },
      aggregations: { default: "max", valid: ["max", "min", "mean"] },
      temporal: "instant",
    },
    {
      name: "pmsl",
      units: "Pa",
      colormap: "viridis",
      vmin: 87000,
      vmax: 108000,
      eps: false,
      aggregations: { default: "mean", valid: ["max", "min", "mean"] },
    },
  ],
};

test("v2ModelsToModels maps id/latest_run/synthetic/variables + EPS percentiles", () => {
  const [m] = v2ModelsToModels([cat]);
  assert.equal(m.id, "icond2");
  assert.equal(m.latest_run, "2026-06-28T18:00:00Z");
  assert.equal(m.synthetic_time, false);
  assert.equal(m.variables.length, 2);
  assert.equal(m.variables[0].name, "t_2m");
  assert.deepEqual(m.variables[0].percentiles, [10, 25, 50, 75, 90]);
  assert.equal(m.variables[1].percentiles, undefined); // deterministic var
});

test("v2VarsToAvailable carries legend window + colormap + percentiles", () => {
  const vs = v2VarsToAvailable(cat);
  const t = vs[0];
  assert.equal(t.vmin, 200);
  assert.equal(t.vmax, 330);
  assert.equal(t.default_colormap, "stepped_temp_2m");
  assert.equal(t.available, true);
  assert.deepEqual(t.percentiles, [10, 25, 50, 75, 90]);
  assert.deepEqual(t.levels, [0]);
  assert.deepEqual(t.available_levels, [0]);
});

test("catalog-advertised aggregations win over the heuristic", () => {
  const vs = v2VarsToAvailable(cat);
  assert.deepEqual(vs[0].aggregations, { ops: ["max", "min", "mean"], default: "max" });
  assert.deepEqual(vs[1].aggregations, { ops: ["max", "min", "mean"], default: "mean" });
});

test("aggsFor fallback: de-accum rates SUM, precip excluded, state max/mean", () => {
  const mk = (name: string, units: string, colormap: string) => ({
    name, units, colormap, vmin: 0, vmax: 1, eps: false,
  });
  const c: V2ModelCat = {
    id: "icond2",
    latest_run: "2026-06-28T18:00:00Z",
    variables: [
      mk("precip_1h", "mm", "precip"),
      mk("rain_gsp_1h", "mm", "precip"),
      mk("snow_gsp_1h", "mm", "precip"),
      mk("dursun_1h", "s", "viridis"),
      mk("rain_gsp", "kg m-2", "precip"),
      mk("t_2m", "K", "stepped_temp_2m"),
      mk("clct", "%", "clouds"),
    ],
  };
  const by = new Map(v2VarsToAvailable(c).map((v) => [v.name, v.aggregations]));
  // precip totals reduce via the precip_{N}h swap, not an aggOp → no vocabulary
  assert.equal(by.get("precip_1h"), undefined);
  // raw run-cumulative accumulant → excluded (must never be GPU-summed)
  assert.equal(by.get("rain_gsp"), undefined);
  // de-accumulated per-hour rates → SUM the window total
  assert.deepEqual(by.get("rain_gsp_1h"), { ops: ["sum"], default: "sum" });
  assert.deepEqual(by.get("snow_gsp_1h"), { ops: ["sum"], default: "sum" });
  assert.deepEqual(by.get("dursun_1h"), { ops: ["sum"], default: "sum" });
  // instantaneous fields keep max/min/mean (temperature default max)
  assert.equal(by.get("t_2m")?.default, "max");
  assert.equal(by.get("clct")?.default, "mean");
});

test("v2VarsToAvailable maps the products capability onto ensemble_products", () => {
  const vs = v2VarsToAvailable(cat);
  const ep = vs[0].ensemble_products;
  assert.ok(ep, "EPS var should advertise ensemble_products");
  assert.equal(ep.median, true);
  assert.deepEqual(ep.percentiles, [10, 25, 50, 75, 90]);
  assert.equal(ep.spread, true);
  assert.equal(ep.mean, true);
  assert.equal(ep.control, true);
  // members > 0 → chance-of (exceedance) capability + member list + dist domain
  assert.equal(ep.chance_of, true);
  assert.equal(vs[0].members?.length, 20);
  assert.deepEqual(vs[0].dist, { units: "K", min: 200, max: 330, member_count: 20 });
  // deterministic var → no ensemble_products, no dist
  assert.equal(vs[1].ensemble_products, undefined);
  assert.equal(vs[1].dist, undefined);
});

test("EPS var without addressable members → no chance-of / dist", () => {
  const c: V2ModelCat = {
    id: "auto_eps",
    latest_run: "auto-1",
    variables: [
      {
        name: "t_2m",
        units: "K",
        vmin: 200,
        vmax: 330,
        eps: true,
        products: {
          median: true, mean: false, control: false,
          min: false, max: false, spread: false,
          percentiles: [10, 90], members: 0,
        },
      },
    ],
  };
  const [t] = v2VarsToAvailable(c);
  assert.equal(t.ensemble_products?.chance_of, false);
  assert.equal(t.dist, undefined);
  assert.equal(t.members, undefined);
});
