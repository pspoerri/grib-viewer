import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWindowVar, parseWindowVar } from "../src/api/types.ts";

test("buildWindowVar joins base + window + op", () => {
  assert.equal(buildWindowVar("t_2m", 24, "max"), "t_2m__24h_max");
  assert.equal(buildWindowVar("t_2m_p90", 6, "max"), "t_2m_p90__6h_max");
  assert.equal(buildWindowVar("tot_prec_gt2p5mm", 24, ""), "tot_prec_gt2p5mm__24h");
});

test("parseWindowVar round-trips", () => {
  assert.deepEqual(parseWindowVar("t_2m"), { base: "t_2m", n: null, op: null });
  assert.deepEqual(parseWindowVar("t_2m__24h_max"), { base: "t_2m", n: 24, op: "max" });
  assert.deepEqual(parseWindowVar("tot_prec_gt2p5mm__24h"), {
    base: "tot_prec_gt2p5mm",
    n: 24,
    op: null,
  });
});

test("parseWindowVar tolerates ensemble + exceedance bases", () => {
  assert.deepEqual(parseWindowVar("t_2m_p90__6h_min"), {
    base: "t_2m_p90",
    n: 6,
    op: "min",
  });
  assert.deepEqual(parseWindowVar("t_2m__3h_mean"), {
    base: "t_2m",
    n: 3,
    op: "mean",
  });
  assert.deepEqual(parseWindowVar("vmax_10m__12h_sum"), {
    base: "vmax_10m",
    n: 12,
    op: "sum",
  });
});

test("parseWindowVar rejects malformed window tokens", () => {
  // No '__' → bare id.
  assert.deepEqual(parseWindowVar("t_2m_max"), {
    base: "t_2m_max",
    n: null,
    op: null,
  });
  // '__' present but the left of the op is not an N-hour token.
  assert.deepEqual(parseWindowVar("t_2m__foo_max"), {
    base: "t_2m__foo_max",
    n: null,
    op: null,
  });
});

// aggCapsFor: caps-driven (catalog `aggregations`), not a hardcoded table.
import { aggCapsFor, supportsAgg } from "../src/api/mapConfig.ts";
import type { AvailableVariable } from "../src/api/v2catalog.ts";

function mkVar(
  name: string,
  aggregations?: { ops: string[]; default: string },
): AvailableVariable {
  return {
    name,
    units: "",
    group: "",
    levels: [0],
    available_levels: [0],
    available: true,
    aggregations,
  };
}

test("aggCapsFor reads the catalog aggregations object", () => {
  const cat = new Map<string, AvailableVariable>([
    ["t_2m", mkVar("t_2m", { ops: ["max", "min", "mean"], default: "max" })],
    ["pmsl", mkVar("pmsl", { ops: ["min"], default: "min" })],
    ["wetbulb_2m", mkVar("wetbulb_2m")], // no aggregations
  ]);
  assert.deepEqual(aggCapsFor(cat, "t_2m"), {
    ops: ["max", "min", "mean"],
    default: "max",
  });
  // Suffixed ids resolve to the base var's caps.
  assert.deepEqual(aggCapsFor(cat, "t_2m_p90"), {
    ops: ["max", "min", "mean"],
    default: "max",
  });
  assert.deepEqual(aggCapsFor(cat, "pmsl"), { ops: ["min"], default: "min" });
  assert.equal(aggCapsFor(cat, "wetbulb_2m"), null);
  // Unknown / still-loading catalog → null (graceful).
  assert.equal(aggCapsFor(cat, "unknown_var"), null);
  assert.equal(aggCapsFor(new Map(), "t_2m"), null);
});

test("supportsAgg mirrors aggCapsFor presence", () => {
  const cat = new Map<string, AvailableVariable>([
    ["t_2m", mkVar("t_2m", { ops: ["max", "min"], default: "max" })],
    ["wetbulb_2m", mkVar("wetbulb_2m")],
  ]);
  assert.equal(supportsAgg(cat, "t_2m"), true);
  assert.equal(supportsAgg(cat, "wetbulb_2m"), false);
  assert.equal(supportsAgg(cat, "unknown"), false);
});

// Hash round-trip: the window length N comes from the global windowMode;
// the per-layer op rides the `.ao` token. The window var id is built at
// request time via buildWindowVar(base, N, op) — not stored in
// layer.variable, which keeps carrying the ensemble-product suffix.
import { encodeMapHash, decodeMapHash, createLayer } from "../src/api/mapConfig.ts";

test("hash round-trips windowMode + anchor + per-layer agg op", () => {
  const layer = { ...createLayer("t_2m", "tiles"), aggOp: "min" as const };
  const hash = encodeMapHash({
    model: "icond2",
    layers: [layer],
    windowMode: "daily",
    anchor: "2026-06-13T00:00:00Z",
  });
  const parsed = decodeMapHash(hash);
  assert.equal(parsed?.layers[0].variable, "t_2m");
  assert.equal(parsed?.layers[0].aggOp, "min");
  assert.equal(parsed?.windowMode, "daily");
  assert.equal(parsed?.anchor, "2026-06-13T00:00:00Z");
});

test("hash round-trips the pinned run + lead time format", () => {
  const layer = createLayer("t_2m", "tiles");
  const hash = encodeMapHash({
    model: "icond2",
    run: "2026-06-27T12:00:00Z",
    layers: [layer],
    tf: "lead",
  });
  assert.ok(hash.includes("r=2026-06-27T12:00:00Z"), hash);
  assert.ok(hash.includes("tf=lead"), hash);
  const parsed = decodeMapHash(hash);
  assert.equal(parsed?.run, "2026-06-27T12:00:00Z");
  assert.equal(parsed?.tf, "lead");
  // Default ("utc") stays off the hash; non-defaults are carried.
  const plain = encodeMapHash({ model: "icond2", layers: [layer], tf: "utc" });
  assert.ok(!plain.includes("tf="), plain);
  const local = encodeMapHash({ model: "icond2", layers: [layer], tf: "local" });
  assert.ok(local.includes("tf=local"), local);
});

console.log("windowMod.test.ts: OK");
