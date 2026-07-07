import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setLeadReference,
  leadReferenceMs,
  leadHoursOf,
  leadLabel,
  formatStatusTime,
  formatStatusTimeParts,
  formatWindowRange,
  groupTimestepsByDay,
  bucketTimesteps,
} from "../src/time.ts";

const REF = "2026-06-28T00:00:00Z";
const REF_MS = Date.parse(REF);

function hoursISO(...hs: number[]): string[] {
  return hs.map((h) =>
    new Date(REF_MS + h * 3_600_000).toISOString().replace(".000Z", "Z"),
  );
}

test("setLeadReference: parseable ISO / epoch ms / clear", () => {
  setLeadReference(REF);
  assert.equal(leadReferenceMs(), REF_MS);
  setLeadReference(REF_MS + 1000);
  assert.equal(leadReferenceMs(), REF_MS + 1000);
  setLeadReference(null);
  assert.ok(Number.isNaN(leadReferenceMs()));
  setLeadReference("not-a-date");
  assert.ok(Number.isNaN(leadReferenceMs()));
});

test("leadHoursOf / leadLabel", () => {
  setLeadReference(REF);
  assert.equal(leadHoursOf(REF_MS), 0);
  assert.equal(leadHoursOf(REF_MS + 6.4 * 3_600_000), 6);
  assert.equal(leadLabel(REF_MS + 12 * 3_600_000), "+12h");
});

test("formatStatusTime in lead mode → '+Nh'; UTC/local untouched", () => {
  setLeadReference(REF);
  const [iso] = hoursISO(30);
  assert.equal(formatStatusTime(iso, "lead"), "+30h");
  assert.equal(formatStatusTime(iso, "utc"), "Mon 29 Jun 06:00 UTC");
  const parts = formatStatusTimeParts(iso, "lead");
  assert.deepEqual(parts, { date: "+1d", clock: "+30h" });
});

test("lead mode without a reference degrades to UTC display", () => {
  setLeadReference(null);
  const [iso] = hoursISO(30);
  assert.equal(formatStatusTime(iso, "lead"), "Mon 29 Jun 06:00 UTC");
});

test("groupTimestepsByDay in lead mode groups per 24 lead hours", () => {
  setLeadReference(REF);
  const ts = hoursISO(0, 6, 12, 18, 24, 30);
  const days = groupTimestepsByDay(ts, "lead");
  assert.equal(days.length, 2);
  assert.equal(days[0].label, "+0d");
  assert.equal(days[0].dayNum, "0d");
  assert.equal(days[0].steps.length, 4);
  assert.deepEqual(
    days[0].steps.map((s) => s.hour),
    ["00", "06", "12", "18"],
  );
  assert.equal(days[1].label, "+1d");
  assert.deepEqual(
    days[1].steps.map((s) => s.hour),
    ["00", "06"],
  );
});

test("lead day-buckets anchor at the run reference, not the calendar", () => {
  // Reference at 06Z: the first "+0d" bucket is [ref, ref+24h) regardless of
  // UTC midnights.
  const ref6 = "2026-06-28T06:00:00Z";
  setLeadReference(ref6);
  const base = Date.parse(ref6);
  const ts = [0, 12, 23, 24].map((h) =>
    new Date(base + h * 3_600_000).toISOString().replace(".000Z", "Z"),
  );
  const days = groupTimestepsByDay(ts, "lead");
  assert.equal(days.length, 2);
  assert.equal(days[0].steps.length, 3);
  assert.equal(days[1].steps.length, 1);
});

test("bucketTimesteps daily in lead mode buckets on the run-relative grid", () => {
  setLeadReference(REF);
  const ts = hoursISO(0, 6, 12, 18, 24, 30);
  const wins = bucketTimesteps(ts, "daily", "lead");
  assert.equal(wins.length, 2);
  assert.equal(wins[0].label, "+0d");
  assert.deepEqual(wins[0].nativeIndices, [0, 1, 2, 3]);
  assert.equal(wins[1].label, "+1d");
  assert.equal(wins[0].spanHours, 24);
});

test("bucketTimesteps 6h in lead mode labels lead-hour ranges", () => {
  setLeadReference(REF);
  const ts = hoursISO(0, 3, 6, 9);
  const wins = bucketTimesteps(ts, "6h", "lead");
  assert.equal(wins.length, 2);
  assert.equal(wins[0].label, "+0–6h");
  assert.equal(wins[0].dayLabel, "+0d");
  assert.equal(wins[1].label, "+6–12h");
  assert.equal(formatWindowRange(wins[1], "lead"), "+6–12h");
});

// Leave the module clean for other test files sharing the process.
test("cleanup", () => {
  setLeadReference(null);
  assert.ok(Number.isNaN(leadReferenceMs()));
});
