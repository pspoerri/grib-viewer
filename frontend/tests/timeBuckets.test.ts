import assert from "node:assert/strict";
import { bucketTimesteps } from "../src/time.ts";

// 25 hourly steps from 2026-06-13T00:00Z .. 2026-06-14T00:00Z (UTC).
const steps: string[] = [];
for (let h = 0; h <= 24; h++) {
  const d = new Date(Date.UTC(2026, 5, 13, h));
  steps.push(d.toISOString().replace(".000", ""));
}

// ── hourly: one window per step, span 1, never partial ──
{
  const ws = bucketTimesteps(steps, "hourly", "utc");
  assert.equal(ws.length, steps.length);
  assert.equal(ws[0].spanHours, 1);
  assert.deepEqual(ws[0].nativeIndices, [0]);
  assert.ok(ws.every((w) => !w.partial));
}

// ── 6h (UTC): boundaries at 00/06/12/18 ──
{
  const ws = bucketTimesteps(steps, "6h", "utc");
  // 00..05 (6), 06..11 (6), 12..17 (6), 18..23 (6), 24 (1, partial)
  assert.equal(ws[0].nativeIndices.length, 6);
  assert.equal(ws[0].spanHours, 6);
  assert.equal(new Date(ws[0].startMs).getUTCHours(), 0);
  assert.equal(new Date(ws[1].startMs).getUTCHours(), 6);
  const last = ws[ws.length - 1];
  assert.equal(last.nativeIndices.length, 1, "trailing 24:00 bucket has one step");
  assert.ok(last.partial, "trailing bucket is partial");
}

// ── 12h (UTC): boundaries at 00/12 ──
{
  const ws = bucketTimesteps(steps, "12h", "utc");
  assert.equal(ws[0].nativeIndices.length, 12);
  assert.equal(new Date(ws[1].startMs).getUTCHours(), 12);
}

// ── daily (UTC): one bucket for the 13th (24 steps), partial 14th ──
{
  const ws = bucketTimesteps(steps, "daily", "utc");
  assert.equal(ws[0].nativeIndices.length, 24, "00..23 on the 13th");
  assert.equal(ws[0].spanHours, 24);
  assert.equal(ws[0].startIso, "2026-06-13T00:00:00Z");
}

// ── startIso is RFC3339 Z and parses back to startMs ──
{
  const ws = bucketTimesteps(steps, "6h", "utc");
  assert.equal(Date.parse(ws[0].startIso), ws[0].startMs);
}

console.log("timeBuckets.test.ts: OK");
