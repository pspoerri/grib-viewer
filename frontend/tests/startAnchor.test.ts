import assert from "node:assert/strict";
import { startAnchorIndex } from "../src/time.ts";

// 24 hourly UTC frames 2026-06-13T00:00Z .. 23:00Z
const axis = Array.from({ length: 24 }, (_, i) =>
  new Date(Date.UTC(2026, 5, 13, i)).toISOString().replace(".000Z", "Z"),
);

// Anchor present → nearest frame to the anchor (10:00 → index 10).
assert.equal(
  startAnchorIndex(axis, "2026-06-13T10:00:00Z", Date.UTC(2026, 5, 13, 3)),
  10,
  "uses the server anchor, not now",
);

// Anchor absent → falls back to the supplied now (03:00 → index 3).
assert.equal(
  startAnchorIndex(axis, undefined, Date.UTC(2026, 5, 13, 3)),
  3,
  "falls back to now when no anchor",
);

// Unparseable anchor → falls back to now.
assert.equal(
  startAnchorIndex(axis, "not-a-time", Date.UTC(2026, 5, 13, 5)),
  5,
  "falls back to now on bad anchor",
);

// Empty timesteps → 0.
assert.equal(startAnchorIndex([], "2026-06-13T10:00:00Z"), 0, "empty axis → 0");

console.log("startAnchor.test.ts ok");
