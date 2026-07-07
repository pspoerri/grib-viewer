import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeWindGrids,
  barbBucketName,
  CALM_MS,
} from "../src/lib/windBarbs.ts";

function pt(lon: number, lat: number, value: number) {
  return {
    properties: { value },
    geometry: { coordinates: [lon, lat] },
  };
}

test("mergeWindGrids matches u+v by coordinate → speed/direction", () => {
  const u = { features: [pt(8, 47, 3)] };
  const v = { features: [pt(8, 47, 4)] };
  const out = mergeWindGrids(u, v);
  assert.equal(out.length, 1);
  assert.equal(out[0].speed, 5); // hypot(3,4)
  assert.ok(Math.abs(out[0].speedKt - 5 * 1.94384) < 1e-6);
  // u east, v north → wind blowing toward the NE, so a FROM bearing in the
  // SW quadrant (fromBearingDeg = atan2(-u,-v) → ≈216.87°).
  const expDir = ((Math.atan2(-3, -4) * 180) / Math.PI + 360) % 360;
  assert.ok(Math.abs(out[0].direction - expDir) < 1e-6);
  assert.ok(out[0].direction > 180 && out[0].direction < 270);
});

test("mergeWindGrids keys by coordinate, tolerating desynced arrays", () => {
  // v has an extra leading point u lacks (a nodata-skip desync); the shared
  // coord must still pair correctly by key, not by index.
  const u = { features: [pt(8, 47, 3)] };
  const v = { features: [pt(1, 1, 9), pt(8, 47, 4)] };
  const out = mergeWindGrids(u, v);
  assert.equal(out.length, 1);
  assert.equal(out[0].speed, 5);
});

test("mergeWindGrids drops calm points below CALM_MS", () => {
  const tiny = CALM_MS / 4;
  const u = { features: [pt(8, 47, tiny)] };
  const v = { features: [pt(8, 47, 0)] };
  assert.equal(mergeWindGrids(u, v).length, 0);
});

test("barbBucketName rounds to 5-kt buckets; calm below 5 kt", () => {
  assert.equal(barbBucketName(2), "wx-barb-calm"); // rounds to 0
  assert.equal(barbBucketName(7), "wx-barb-5"); // rounds to 5
  assert.equal(barbBucketName(23), "wx-barb-25"); // rounds to 25
  assert.equal(barbBucketName(52), "wx-barb-50");
});
