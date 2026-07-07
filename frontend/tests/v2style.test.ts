import { test } from "node:test";
import assert from "node:assert/strict";
import { v2WeatherStyle } from "../src/api/v2style.ts";

const meta = {
  model: "icond2",
  name: "t_2m",
  units: "K",
  colormap: "stepped_temp_2m",
  vmin: 200,
  vmax: 330,
  eps: true,
  planes: [10, 50, 90],
  native_deg: 0.01,
  ntimesteps: 3,
  run: "2026-06-28T18:00:00Z",
  timesteps: [
    "2026-06-28T18:00:00Z",
    "2026-06-28T19:00:00Z",
    "2026-06-28T20:00:00Z",
  ],
  scale: 0.01,
  offset: 270,
};

test("v2WeatherStyle carries the timesteps axis + legend window", () => {
  const s = v2WeatherStyle(meta, Date.parse("2026-06-28T17:00:00Z"));
  assert.equal(s.version, 8);
  assert.deepEqual(s.metadata["weather-api:timesteps"], meta.timesteps);
  assert.equal(s.metadata["weather-api:vmin"], 200);
  assert.equal(s.metadata["weather-api:vmax"], 330);
  assert.equal(s.metadata["weather-api:colormap"], "stepped_temp_2m");
  assert.equal(s.metadata["weather-api:model"], "icond2");
  assert.equal(s.metadata["weather-api:units"], "K");
});

test("start anchor = first frame ≥ now", () => {
  // now between frame 0 and 1 → open at frame 1.
  const s = v2WeatherStyle(meta, Date.parse("2026-06-28T18:30:00Z"));
  assert.equal(s.metadata["weather-api:start"], "2026-06-28T19:00:00Z");
});

test("start anchor clamps to last frame past the horizon", () => {
  const s = v2WeatherStyle(meta, Date.parse("2026-06-29T00:00:00Z"));
  assert.equal(s.metadata["weather-api:start"], "2026-06-28T20:00:00Z");
});
