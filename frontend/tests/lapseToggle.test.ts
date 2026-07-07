import { test } from "node:test";
import assert from "node:assert/strict";
import {
  showLapseToggle,
  toggleLapse,
  lapseOffBases,
  isLapseOffForFetch,
  createLayer,
  encodeLayerSegment,
  decodeLayerSegment,
} from "../src/api/mapConfig.ts";

// ---- showLapseToggle: chip shown iff isLapseVar && demAvailable ----------

test("showLapseToggle: on for t_2m/td_2m when the DEM is available", () => {
  assert.equal(showLapseToggle("t_2m", true), true);
  assert.equal(showLapseToggle("td_2m", true), true);
});

test("showLapseToggle: hidden when the DEM is unavailable, even for t_2m", () => {
  assert.equal(showLapseToggle("t_2m", false), false);
});

test("showLapseToggle: hidden for non-lapse variables regardless of DEM state", () => {
  assert.equal(showLapseToggle("tot_prec", true), false);
  assert.equal(showLapseToggle("wind_speed_10m", true), false);
  assert.equal(showLapseToggle("t_2m_gt25c", true), false); // chance-of
  assert.equal(showLapseToggle("t_2m_spread", true), false);
});

// ---- toggleLapse: on (default) <-> off, single source of truth ----------

test("toggleLapse: on (undefined) flips to off", () => {
  assert.equal(toggleLapse(undefined), "off");
});

test("toggleLapse: off flips back to the default (undefined = fixed)", () => {
  assert.equal(toggleLapse("off"), undefined);
});

test("toggleLapse: explicit 'fixed' behaves like the default (on) — flips to off", () => {
  assert.equal(toggleLapse("fixed"), "off");
});

// ---- lapseOffBases / isLapseOffForFetch: point/hover parity lookup ------

test("lapseOffBases: collects bases only from visible, lapse-eligible, off-toggled layers", () => {
  const layers = [
    createLayer("t_2m", "tiles", { lapse: "off" }),
    createLayer("td_2m", "tiles"), // on (default) — excluded
    createLayer("tot_prec", "tiles", { lapse: "off" }), // not lapse-eligible — excluded
    createLayer("wind_speed_10m", "tiles", { visible: false, lapse: "off" }), // hidden — excluded
  ];
  assert.deepEqual(lapseOffBases(layers), new Set(["t_2m"]));
});

test("lapseOffBases: same base, one visible layer OFF and one ON — base NOT in the off-set (any-ON wins, no cross-layer bleed)", () => {
  const layers = [
    createLayer("t_2m", "tiles", { lapse: "off" }),
    createLayer("t_2m_p90", "tiles"), // on (default), same base
  ];
  assert.deepEqual(lapseOffBases(layers), new Set());
});

test("lapseOffBases: same base, BOTH visible layers off — base IS in the off-set", () => {
  const layers = [
    createLayer("t_2m", "tiles", { lapse: "off" }),
    createLayer("t_2m_p90", "tiles", { lapse: "off" }),
  ];
  assert.deepEqual(lapseOffBases(layers), new Set(["t_2m"]));
});

test("lapseOffBases: a single off layer for a base — base IS in the off-set", () => {
  const layers = [createLayer("t_2m", "tiles", { lapse: "off" })];
  assert.deepEqual(lapseOffBases(layers), new Set(["t_2m"]));
});

test("isLapseOffForFetch: a derived id (percentile band) inherits its base's off state", () => {
  const off = lapseOffBases([createLayer("t_2m", "tiles", { lapse: "off" })]);
  assert.equal(isLapseOffForFetch("t_2m_p90", off), true);
  assert.equal(isLapseOffForFetch("t_2m__24h_max", off), true);
  assert.equal(isLapseOffForFetch("td_2m", off), false); // different base, still on
  assert.equal(isLapseOffForFetch("t_2m_gt25c", off), false); // chance-of never lapse-corrected
});

// ---- URL-hash persistence: the .lp token round-trips ---------------------

test("encodeLayerSegment/decodeLayerSegment: lapse off round-trips through the hash", () => {
  const layer = createLayer("t_2m", "tiles", { lapse: "off" });
  const seg = encodeLayerSegment(layer);
  assert.match(seg, /\.lpoff(\.|$)/);
  const decoded = decodeLayerSegment(seg);
  assert.equal(decoded?.lapse, "off");
});

test("encodeLayerSegment: default (on) omits the .lp token entirely", () => {
  const layer = createLayer("t_2m", "tiles");
  assert.equal(encodeLayerSegment(layer).includes(".lp"), false);
});
