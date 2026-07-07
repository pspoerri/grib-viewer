// Unit tests for the dynamic-distribution id grammar. Run directly by
// Node (>= 23.6 type stripping): `node tests/distIds.test.ts` — wired
// into `npm run lint`. No test framework, per project convention.
import assert from "node:assert/strict";
import {
  BEAUFORT_MS,
  CURATED_THRESHOLDS,
  curatedThreshold,
  formatThresholdId,
  parseThresholdId,
  thresholdDomain,
  thresholdStep,
} from "../src/api/distIds.ts";

// ---- formatThresholdId: display-unit values onto backend ids ----

// Native passthrough units (mm/h has no units.ts group).
assert.equal(
  formatThresholdId("tot_prec", "gt", 2.5, { groupId: null, optionId: "base", nativeUnits: "mm/h" }),
  "tot_prec_gt2p5mm",
);
// Negative threshold, trailing-zero strip, °C token.
assert.equal(
  formatThresholdId("t_2m", "lt", -5, { groupId: "temperature", optionId: "c", nativeUnits: "K" }),
  "t_2m_lt-5c",
);
assert.equal(
  formatThresholdId("t_2m", "gt", 25.0, { groupId: "temperature", optionId: "c", nativeUnits: "K" }),
  "t_2m_gt25c",
);
assert.equal(
  formatThresholdId("t_2m", "gt", 77, { groupId: "temperature", optionId: "f", nativeUnits: "K" }),
  "t_2m_gt77f",
);
assert.equal(
  formatThresholdId("vmax_10m", "gt", 50, { groupId: "windSpeed", optionId: "kmh", nativeUnits: "m s-1" }),
  "vmax_10m_gt50kmh",
);
// kn display unit maps onto the backend's `kt` token.
assert.equal(
  formatThresholdId("wind_10m", "gt", 10, { groupId: "windSpeed", optionId: "kn", nativeUnits: "m s-1" }),
  "wind_10m_gt10kt",
);
// mph has no token: value converts to SI, token falls back to ms.
assert.equal(
  formatThresholdId("vmax_10m", "gt", 10, { groupId: "windSpeed", optionId: "mph", nativeUnits: "m s-1" }),
  "vmax_10m_gt4p47ms",
);
// inHg falls back to hpa (30 inHg = 1015.92 hPa).
assert.equal(
  formatThresholdId("pmsl", "gt", 30, { groupId: "pressure", optionId: "inhg", nativeUnits: "Pa" }),
  "pmsl_gt1015p92hpa",
);
// Pa display option also lands on the hpa token.
assert.equal(
  formatThresholdId("pmsl", "lt", 99000, { groupId: "pressure", optionId: "pa", nativeUnits: "Pa" }),
  "pmsl_lt990hpa",
);
// W m-2 passthrough → w token.
assert.equal(
  formatThresholdId("ghi", "gt", 400, { groupId: null, optionId: "base", nativeUnits: "W m-2" }),
  "ghi_gt400w",
);
// Pa through the ungrouped path re-expresses in the hpa token's units
// (the only native token whose units differ from the archive's).
assert.equal(
  formatThresholdId("pmsl", "gt", 101500, { groupId: null, optionId: "base", nativeUnits: "Pa" }),
  "pmsl_gt1015hpa",
);
// Integers ending in zero must survive the trailing-zero strip — the
// regex chain strips fraction zeros only ("800.00" → "800", never "8").
assert.equal(
  formatThresholdId("ghi", "gt", 800, { groupId: null, optionId: "base", nativeUnits: "W m-2" }),
  "ghi_gt800w",
);
assert.equal(
  formatThresholdId("pmsl", "lt", 1000, { groupId: "pressure", optionId: "hpa", nativeUnits: "Pa" }),
  "pmsl_lt1000hpa",
);
assert.equal(
  formatThresholdId("tot_prec", "gt", 10, { groupId: null, optionId: "base", nativeUnits: "mm/h" }),
  "tot_prec_gt10mm",
);
// Unknown unit → null (caller hides the slider).
assert.equal(
  formatThresholdId("clct", "gt", 50, { groupId: null, optionId: "base", nativeUnits: "%" }),
  null,
);

// ---- parseThresholdId: inverse, native (SI) values ----

assert.deepEqual(parseThresholdId("tot_prec_gt2p5mm"), {
  base: "tot_prec",
  dir: "gt",
  nativeValue: 2.5,
});
const lt5 = parseThresholdId("t_2m_lt-5c");
assert.ok(lt5 && lt5.base === "t_2m" && lt5.dir === "lt");
assert.ok(Math.abs(lt5.nativeValue - 268.15) < 1e-9);
const kmh = parseThresholdId("vmax_10m_gt50kmh");
assert.ok(kmh && Math.abs(kmh.nativeValue - 50 / 3.6) < 1e-9);
const bft = parseThresholdId("vmax_10m_gtbft8");
assert.ok(bft && bft.nativeValue === BEAUFORT_MS[8] && bft.nativeValue === 17);
const hpa = parseThresholdId("pmsl_gt1015p92hpa");
assert.ok(hpa && Math.abs(hpa.nativeValue - 101592) < 1e-6);

// Ladder aliases resolve through the same call.
assert.deepEqual(parseThresholdId("prob_frost"), {
  base: "t_2m",
  dir: "lt",
  nativeValue: 273.15,
});
assert.deepEqual(parseThresholdId("prob_wind_bft7"), {
  base: "vmax_10m",
  dir: "gt",
  nativeValue: 14,
});
assert.deepEqual(parseThresholdId("prob_prec_gt0p1mm"), {
  base: "tot_prec",
  dir: "gt",
  nativeValue: 0.1,
});
assert.deepEqual(parseThresholdId("prob_rad_gt400w"), {
  base: "ghi",
  dir: "gt",
  nativeValue: 400,
});

// Non-threshold / malformed ids → null.
assert.equal(parseThresholdId("t_2m"), null);
assert.equal(parseThresholdId("t_2m_p37"), null);
assert.equal(parseThresholdId("t_2m_gt25xyz"), null);
assert.equal(parseThresholdId("t_2m_gtbft99"), null);

// ---- format/parse round-trip in token units ----
const id = formatThresholdId("td_2m", "gt", 12.5, {
  groupId: "temperature",
  optionId: "c",
  nativeUnits: "K",
});
assert.equal(id, "td_2m_gt12p5c");
assert.ok(id);
const rt = parseThresholdId(id);
assert.ok(rt && Math.abs(rt.nativeValue - 285.65) < 1e-9);

// ---- thresholdStep ----
assert.equal(thresholdStep("temperature", "c", "K"), 0.5);
assert.equal(thresholdStep("temperature", "f", "K"), 1);
assert.equal(thresholdStep("windSpeed", "kmh", "m s-1"), 1);
assert.equal(thresholdStep("windSpeed", "ms", "m s-1"), 0.5);
assert.equal(thresholdStep("windSpeed", "kn", "m s-1"), 1);
assert.equal(thresholdStep("pressure", "hpa", "Pa"), 1);
assert.equal(thresholdStep(null, "base", "mm/h"), 0.1);
assert.equal(thresholdStep(null, "base", "W m-2"), 10);

// ---- thresholdDomain: marker/slider domain rounding ----

const approx = (a: number, b: number, msg: string) =>
  assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} !== ${b}`);

// t_2m K envelope → °C domain, rounded outward to the 0.5 °C step.
{
  const d = thresholdDomain(261.4, 305.9, (k) => k - 273.15, 0.5);
  approx(d.lo, -12, "t_2m lo"); // -11.75 floors to -12.0
  approx(d.hi, 33, "t_2m hi"); // 32.75 ceils to 33.0
}
// Fahrenheit step is 1 °F.
{
  const d = thresholdDomain(261.4, 305.9, (k) => (k - 273.15) * 1.8 + 32, 1);
  approx(d.lo, 10, "t_2m °F lo"); // 10.85 → 10
  approx(d.hi, 91, "t_2m °F hi"); // 90.95 → 91
}
// Native passthrough (mm/h), 0.1 step; endpoints already aligned stay put.
{
  const d = thresholdDomain(0, 28.3, (v) => v, 0.1);
  approx(d.lo, 0, "precip lo");
  approx(d.hi, 28.3, "precip hi");
}
// A direction-reversing conversion still yields lo < hi.
{
  const d = thresholdDomain(100000, 95000, (pa) => pa / 100, 1);
  approx(d.lo, 950, "pmsl lo");
  approx(d.hi, 1000, "pmsl hi");
}

// ---- curatedThreshold: entry-time Chance-of defaults ----

// Curated bases are keyed by the canonical dist base (values of
// DIST_BASES), in native archive units, and round-trip through
// parseThresholdId(formatThresholdId(...)).
assert.deepEqual(curatedThreshold("t_2m"), { dir: "gt", nativeValue: 293.15 }); // ≥ 20 °C
assert.deepEqual(curatedThreshold("td_2m"), { dir: "gt", nativeValue: 288.15 }); // ≥ 15 °C
assert.deepEqual(curatedThreshold("vmax_10m"), { dir: "gt", nativeValue: 14 }); // Bft7
assert.deepEqual(curatedThreshold("wind_10m"), { dir: "gt", nativeValue: 8 }); // Bft5
assert.deepEqual(curatedThreshold("tot_prec"), { dir: "gt", nativeValue: 1 });
assert.deepEqual(curatedThreshold("ghi"), { dir: "gt", nativeValue: 400 });
// Bases without a curated default fall through to null (mid-domain).
assert.equal(curatedThreshold("pmsl"), null);
assert.equal(curatedThreshold("clct"), null);
// The exported table and the lookup agree.
assert.equal(curatedThreshold("t_2m"), CURATED_THRESHOLDS["t_2m"]);
// Each curated default lands inside its °C/native display value as a
// well-formed id (sanity that the native value is sensible).
{
  const c = curatedThreshold("t_2m");
  assert.ok(c);
  assert.equal(
    formatThresholdId("t_2m", c.dir, c.nativeValue - 273.15, {
      groupId: "temperature",
      optionId: "c",
      nativeUnits: "K",
    }),
    "t_2m_gt20c",
  );
}

console.log("distIds tests passed");
