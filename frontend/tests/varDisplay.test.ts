// Node-run unit tests for the hover-readout label/unit resolver. No
// framework; wired into `npm run lint` (test:unit). Run directly:
//   node --no-warnings tests/varDisplay.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeVar } from "../src/api/varDisplay.ts";
import type { Variable } from "../src/api/types.ts";

const catalog: Variable[] = [
  {
    name: "tot_prec",
    long_name: "Total precipitation",
    units: "kg m-2",
    dist: { units: "mm/h", min: 0, max: 100, member_count: 5 },
  },
  { name: "clct", long_name: "Total cloud cover", units: "%" },
  { name: "t_2m", long_name: "2 m temperature", units: "K" },
  {
    name: "vmax_10m",
    long_name: "Max 10 m gust",
    units: "m s-1",
    dist: { units: "m s-1", min: 0, max: 60, member_count: 5 },
  },
] as Variable[];

const d = (id: string) => describeVar(id, catalog, {});

test("exceedance/chance product → friendly label in percent (the reported bug)", () => {
  const r = d("tot_prec_gt1p6mm__24h");
  // Was: name "TOT_PREC_GT1P6MM__24H", unit "mm".
  assert.equal(r.unitLabel, "%");
  assert.equal(r.convert(14.3), 14.3); // chance passes through, not mm-converted
  for (const s of ["Total precipitation", "≥1.6", "mm/h", "chance", "(24h)"]) {
    assert.ok(r.label.includes(s), `label ${JSON.stringify(r.label)} missing ${s}`);
  }
});

test("windowed mean → '(Nh mean)', keeps base unit", () => {
  const r = d("clct__24h_mean");
  assert.equal(r.unitLabel, "%");
  assert.ok(r.label.includes("Total cloud cover"));
  assert.ok(r.label.includes("24h mean"));
});

test("'lt' direction renders ≤", () => {
  const r = d("tot_prec_lt1mm__24h");
  assert.equal(r.unitLabel, "%");
  assert.ok(r.label.includes("≤1"));
  assert.ok(r.label.includes("chance"));
});

test("threshold is shown in the user's display unit", () => {
  // 14 m/s → 50.4 km/h (default wind unit); still a chance in %.
  const r = d("vmax_10m_gt14ms__6h");
  assert.equal(r.unitLabel, "%");
  assert.ok(r.label.includes("Max 10 m gust"));
  assert.ok(r.label.includes("chance"));
  assert.ok(r.label.includes("(6h)"));
  assert.ok(/≥\d/.test(r.label), `expected a ≥number in ${r.label}`);
});

test("precip-total title adapts to the window (per-window total, not 'since run start')", () => {
  assert.equal(d("precip_1h").label, "Precipitation (1h)");
  assert.equal(d("precip_6h").label, "Precipitation (6h total)");
  assert.equal(d("precip_24h").label, "Precipitation (24h total)");
  // legacy bare id resolves to the 1-hour total, never "since run start"
  assert.equal(d("tot_prec").label, "Precipitation (1h)");
  assert.ok(!/run start/i.test(d("tot_prec").label));
  // value stays in the precip unit, not a percent
  assert.notEqual(d("precip_6h").unitLabel, "%");
});

test("plain and percentile planes label from long_name", () => {
  assert.equal(d("t_2m").label, "2 m temperature");
  assert.ok(d("t_2m_p90").label.includes("p90"));
  assert.ok(d("t_2m_mean__6h_max").label.includes("mean"));
  assert.ok(d("t_2m_mean__6h_max").label.includes("6h max"));
});

test("spread sits in the base unit, not percent", () => {
  const r = d("vmax_10m_spread");
  assert.ok(r.label.includes("spread"));
  assert.notEqual(r.unitLabel, "%");
});

test("unknown id falls back to the base id (never the raw windowed id)", () => {
  const r = d("nosuch_var__3h_sum");
  assert.ok(r.label.includes("nosuch_var"));
  assert.ok(r.label.includes("3h sum"));
  assert.ok(!r.label.includes("__"), "must not show the raw window token");
});
