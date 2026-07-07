// Node-run unit tests (no framework, mirrors tests/distIds.test.ts).
// Verifies spreadIdFor resolves the available `{base}_spread` sibling
// across the base itself, its dist base, and its display base — the
// gate for the legend's Spread view-mode chip.
import assert from "node:assert/strict";
import { spreadIdFor } from "../src/api/mapConfig.ts";

const A = { available: true };

// Catalog advertising every spread product the EPS models publish.
const catalog = new Map<string, { available?: boolean }>(
  Object.entries({
    t_2m_spread: A,
    wind_gust_10m_spread: A,
    wind_speed_10m_spread: A,
    pmsl_spread: A,
    tot_prec_spread: A,
  }),
);

// Direct `{base}_spread` hit.
assert.equal(spreadIdFor("t_2m", catalog), "t_2m_spread");
assert.equal(spreadIdFor("pmsl", catalog), "pmsl_spread");
assert.equal(spreadIdFor("wind_gust_10m", catalog), "wind_gust_10m_spread");
assert.equal(spreadIdFor("wind_speed_10m", catalog), "wind_speed_10m_spread");
// Precip spread is advertised on tot_prec_spread but returned under the
// consistent display id precip_{N}h_spread (served by the member kernel).
assert.equal(spreadIdFor("tot_prec", catalog), "precip_1h_spread");

// Gusts via the threshold/dist base (vmax_10m): resolves through the
// display base wind_gust_10m so Chance-of mode (base = vmax_10m) still
// offers the Spread chip.
assert.equal(spreadIdFor("vmax_10m", catalog), "wind_gust_10m_spread");

// Precip via the dist base (precip_1h → tot_prec), returned as the
// consistent precip_{N}h_spread display id.
assert.equal(spreadIdFor("precip_1h", catalog), "precip_1h_spread");

// No spread product → null.
assert.equal(spreadIdFor("hsurf", catalog), null);
assert.equal(spreadIdFor("clct", catalog), null);

// Advertised-but-unavailable spread → null (not offered).
const unavail = new Map<string, { available?: boolean }>(
  Object.entries({ t_2m_spread: { available: false } }),
);
assert.equal(spreadIdFor("t_2m", unavail), null);

console.log("spreadId tests passed");
