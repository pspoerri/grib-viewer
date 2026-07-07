import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alignSeriesToAxis,
  framesInSpan,
  leadTimeSegment,
  v2DataUrl,
  v2DataChunkUrl,
  v2GridUrl,
  v2TimeGrammar,
} from "../src/api/v2client.ts";

const TS3 = [
  "2026-06-28T00:00:00Z",
  "2026-06-28T01:00:00Z",
  "2026-06-28T02:00:00Z",
];

test("v2TimeGrammar: instant without an axis → latest, no suffix", () => {
  assert.deepEqual(v2TimeGrammar({ time: 5 }), {
    timePath: "latest",
    suffix: "",
  });
});

test("v2TimeGrammar: instant resolves to the frame's RFC3339 time", () => {
  assert.deepEqual(v2TimeGrammar({ timesteps: TS3, time: 1 }), {
    timePath: "2026-06-28T01:00:00Z",
    suffix: "",
  });
});

test("v2TimeGrammar: window → one-window span + __{N}h_{op} suffix", () => {
  // Inclusive bucket [0,2] over a 1h axis = a 3h span [00:00, 03:00) so the
  // backend's half-open block reduces exactly frames 0,1,2.
  assert.deepEqual(
    v2TimeGrammar({ timesteps: TS3, time: 2, window: { t0: 0, t1: 2, op: "max" } }),
    { timePath: "2026-06-28T00:00:00Z+PT3H", suffix: "__3h_max" },
  );
});

test("v2TimeGrammar: single-frame window spans one cadence step", () => {
  const ts = ["2026-06-28T00:00:00Z", "2026-06-28T01:00:00Z"];
  assert.deepEqual(
    v2TimeGrammar({ timesteps: ts, time: 1, window: { t0: 1, t1: 1, op: "mean" } }),
    { timePath: "2026-06-28T01:00:00Z+PT1H", suffix: "__1h_mean" },
  );
});

test("leadTimeSegment builds the '+{N}h' lead-time form", () => {
  assert.equal(leadTimeSegment(0), "+0h");
  assert.equal(leadTimeSegment(12), "+12h");
  assert.equal(leadTimeSegment(12.4), "+12h");
});

test("framesInSpan: a calendar day selects exactly that day's frames", () => {
  // Hourly axis spanning two UTC days; the 28th's bucket is [00:00, next-00:00).
  const ts = [
    "2026-06-27T22:00:00Z",
    "2026-06-27T23:00:00Z",
    "2026-06-28T00:00:00Z",
    "2026-06-28T01:00:00Z",
    "2026-06-28T23:00:00Z",
    "2026-06-29T00:00:00Z",
  ];
  const start = Date.parse("2026-06-28T00:00:00Z");
  const end = Date.parse("2026-06-29T00:00:00Z");
  // Inclusive frame range = indices 2..4 (00:00, 01:00, 23:00 of the 28th);
  // the 29th-00:00 frame is excluded (end is exclusive).
  assert.deepEqual(framesInSpan(ts, start, end), { t0: 2, t1: 4 });
});

test("framesInSpan: a coarser cadence with no frame in the bucket → null", () => {
  // 6-hourly axis; the bucket [03:00, 06:00) contains no frame.
  const ts = ["2026-06-28T00:00:00Z", "2026-06-28T06:00:00Z"];
  const start = Date.parse("2026-06-28T03:00:00Z");
  const end = Date.parse("2026-06-28T06:00:00Z");
  assert.equal(framesInSpan(ts, start, end), null);
});

test("framesInSpan: single frame in the bucket → t0 == t1", () => {
  const ts = ["2026-06-28T00:00:00Z", "2026-06-28T12:00:00Z"];
  const start = Date.parse("2026-06-28T06:00:00Z");
  const end = Date.parse("2026-06-28T18:00:00Z");
  assert.deepEqual(framesInSpan(ts, start, end), { t0: 1, t1: 1 });
});

// ---------------------------------------------------------------------------
// /data URL building — the ONE-request-per-(layer, viewport, frame) surface.
// ---------------------------------------------------------------------------

test("v2DataUrl: {time} path = latest when the axis is unknown", () => {
  assert.equal(
    v2DataUrl("icond2", "t_2m_mean", { bbox: "45.00,6.00,48.00,11.00", time: 0 }),
    "/api/models/icond2/data/latest/t_2m_mean?bbox=45.00%2C6.00%2C48.00%2C11.00",
  );
});

test("v2DataUrl: frame instant + maxcells budget + pinned ?run=", () => {
  assert.equal(
    v2DataUrl("icond2", "t_2m", {
      bbox: "45.00,6.00,48.00,11.00",
      maxcells: 700000,
      run: "2026-06-28T06:00:00Z",
      timesteps: TS3,
      time: 1,
    }),
    "/api/models/icond2/data/2026-06-28T01%3A00%3A00Z/t_2m?bbox=45.00%2C6.00%2C48.00%2C11.00&maxcells=700000&run=2026-06-28T06%3A00%3A00Z",
  );
});

test("v2DataUrl: windowed reduction rides the span {time} + id suffix", () => {
  assert.equal(
    v2DataUrl("icond2", "t_2m", {
      bbox: "45.00,6.00,48.00,11.00",
      timesteps: TS3,
      time: 2,
      window: { t0: 0, t1: 2, op: "max" },
    }),
    "/api/models/icond2/data/2026-06-28T00%3A00%3A00Z%2BPT3H/t_2m__3h_max?bbox=45.00%2C6.00%2C48.00%2C11.00",
  );
});

test("v2DataChunkUrl: plain span buffers a multi-frame animation chunk", () => {
  assert.equal(
    v2DataChunkUrl("icond2", "precip_1h", {
      bbox: "45.00,6.00,48.00,11.00",
      maxcells: 1400000,
      startISO: "2026-06-28T00:00:00Z",
      seconds: 7 * 3600 + 1,
    }),
    "/api/models/icond2/data/2026-06-28T00%3A00%3A00Z%2BPT25201S/precip_1h?bbox=45.00%2C6.00%2C48.00%2C11.00&maxcells=1400000",
  );
});

test("v2DataChunkUrl: pinned run rides the chunk request too", () => {
  const url = v2DataChunkUrl("icond2", "precip_1h", {
    bbox: "45.00,6.00,48.00,11.00",
    run: "2026-06-27T12:00:00Z",
    startISO: "2026-06-28T00:00:00Z",
    seconds: 3601,
  });
  assert.ok(url.includes("run=2026-06-27T12%3A00%3A00Z"), url);
  assert.ok(url.startsWith("/api/models/icond2/data/"), url);
});

test("alignSeriesToAxis: full match passes values through in order", () => {
  assert.deepEqual(alignSeriesToAxis(TS3, TS3, [1, 2, 3]), [1, 2, 3]);
});

test("alignSeriesToAxis: a frame the backend skipped becomes null", () => {
  // Backend omits the middle frame (no data for that native step).
  const respTs = [TS3[0], TS3[2]];
  assert.deepEqual(alignSeriesToAxis(TS3, respTs, [1, 3]), [1, null, 3]);
});

test("alignSeriesToAxis: instant equality tolerates differing RFC3339 offset notation", () => {
  assert.deepEqual(
    alignSeriesToAxis(
      ["2026-06-28T00:00:00Z"],
      ["2026-06-28T00:00:00.000Z"],
      [42],
    ),
    [42],
  );
});

test("v2GridUrl: a window encodes as the span {time} + __{N}h_{op} suffix + ?run=", () => {
  assert.equal(
    v2GridUrl("icond2", "t_2m", {
      bbox: "45,6,48,11",
      spacing: 0.5,
      run: "2026-06-28T00:00:00Z",
      timesteps: TS3,
      time: 2,
      window: { t0: 0, t1: 2, op: "mean" },
    }),
    "/api/models/icond2/grid/2026-06-28T00%3A00%3A00Z%2BPT3H/t_2m__3h_mean?bbox=45%2C6%2C48%2C11&spacing=0.5&run=2026-06-28T00%3A00%3A00Z",
  );
});

test("v2GridUrl: no pinned run → no run param", () => {
  const url = v2GridUrl("icond2", "t_2m", {
    bbox: "45,6,48,11",
    spacing: 0.5,
    timesteps: TS3,
    time: 0,
  });
  assert.ok(!url.includes("run="), url);
});
