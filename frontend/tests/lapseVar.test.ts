import { test } from "node:test";
import assert from "node:assert/strict";
import { isLapseVar, LAPSE_GAMMA } from "../src/api/mapConfig.ts";

test("isLapseVar: bare screen-temperature bases are lapse vars", () => {
  assert.equal(isLapseVar("t_2m"), true);
  assert.equal(isLapseVar("td_2m"), true);
});

test("isLapseVar: ensemble plane suffixes strip to the base", () => {
  assert.equal(isLapseVar("t_2m_p90"), true);
  assert.equal(isLapseVar("td_2m_p90"), true);
  assert.equal(isLapseVar("t_2m_mean"), true);
  assert.equal(isLapseVar("t_2m_ctrl"), true);
  assert.equal(isLapseVar("t_2m_m3"), true);
});

test("isLapseVar: window token is stripped before the base check", () => {
  assert.equal(isLapseVar("t_2m__24h_max"), true);
  assert.equal(isLapseVar("td_2m__6h_min"), true);
  // Window over a percentile plane still resolves to the temp base.
  assert.equal(isLapseVar("t_2m_p90__12h_mean"), true);
});

test("isLapseVar: spread is excluded (a p90−p10 difference, not a temperature)", () => {
  assert.equal(isLapseVar("t_2m_spread"), false);
  assert.equal(isLapseVar("td_2m_spread"), false);
});

test("isLapseVar: chance-of (_gt/_lt) threshold ids are excluded", () => {
  assert.equal(isLapseVar("t_2m_gt25c"), false);
  assert.equal(isLapseVar("t_2m_lt-5c"), false);
  assert.equal(isLapseVar("prob_frost"), false); // ladder alias → t_2m base, still excluded
  assert.equal(isLapseVar("prob_t2m_gt30c"), false);
  // Implicit-peak windowed threshold: window strips to the threshold id, which
  // parseThresholdId then rejects.
  assert.equal(isLapseVar("t_2m_gt25c__24h"), false);
});

test("isLapseVar: non-temperature fields are not lapse vars", () => {
  assert.equal(isLapseVar("tot_prec"), false);
  assert.equal(isLapseVar("precip_1h"), false);
  assert.equal(isLapseVar("wind_speed_10m"), false);
  assert.equal(isLapseVar("pmsl"), false);
  assert.equal(isLapseVar("t_g"), false); // ground temp is not a screen temp
  assert.equal(isLapseVar("t_500hpa"), false); // isobaric temp is not screen temp
});

test("LAPSE_GAMMA is the ICAO −6.5 K/km rate", () => {
  assert.equal(LAPSE_GAMMA, -0.0065);
});
