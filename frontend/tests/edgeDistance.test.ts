import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeDistanceKm, EDGE_DIST_CAP_KM, type Window } from "../src/lib/wxdata2.ts";

const KM_PER_DEG = 111.195;

// A Window on the equator (cos(lat) ≈ 1 so dx ≈ dy) with a given nodata mask
// ('X' = nodata, anything else = valid). 1° grid steps → 111.195 km per cell.
function win(rows: string[]): Window {
  const ny = rows.length;
  const nx = rows[0].length;
  const values = new Int16Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      values[j * nx + i] = rows[j][i] === "X" ? -32768 : 100;
    }
  }
  return {
    model: "m",
    variable: "t_2m",
    grid: { nx, ny, lat0: ny / 2, lon0: 0, dlat: -1, dlon: 1 },
    values,
    scale: 0.1,
    offset: 0,
    nodata: -32768,
  };
}

test("edgeDistanceKm: no nodata anywhere → capped everywhere (window crop is not an edge)", () => {
  const d = edgeDistanceKm(win(["...", "...", "..."]));
  for (const v of d) assert.equal(v, EDGE_DIST_CAP_KM);
});

test("edgeDistanceKm: nodata texels are 0; distance grows away from the edge column", () => {
  const d = edgeDistanceKm(win(["X....", "X....", "X...."]));
  const nx = 5;
  for (let j = 0; j < 3; j++) {
    assert.equal(d[j * nx + 0], 0, `nodata col row ${j}`);
    for (let i = 1; i < nx; i++) {
      // Straight-line distance to column 0, in km (± the equirectangular cos
      // factor at these small latitudes).
      const got = d[j * nx + i];
      const want = Math.min(i * KM_PER_DEG, EDGE_DIST_CAP_KM);
      assert.ok(Math.abs(got - want) / want < 0.01, `row ${j} col ${i}: ${got} vs ${want}`);
    }
  }
});

test("edgeDistanceKm: interior nodata hole radiates in all directions (chamfer diagonal)", () => {
  const d = edgeDistanceKm(win(["...", ".X.", "..."]));
  const nx = 3;
  assert.equal(d[1 * nx + 1], 0);
  // 4-neighbours: one straight step.
  for (const [j, i] of [[0, 1], [1, 0], [1, 2], [2, 1]] as const) {
    assert.ok(Math.abs(d[j * nx + i] - KM_PER_DEG) / KM_PER_DEG < 0.02, `4-nb ${j},${i}: ${d[j * nx + i]}`);
  }
  // Diagonals: one diagonal step ≈ √2 · straight.
  const diag = Math.SQRT2 * KM_PER_DEG;
  for (const [j, i] of [[0, 0], [0, 2], [2, 0], [2, 2]] as const) {
    assert.ok(Math.abs(d[j * nx + i] - diag) / diag < 0.05, `diag ${j},${i}: ${d[j * nx + i]}`);
  }
});

test("edgeDistanceKm: diagonal coverage edge (rotated-grid corner) tracks the staircase", () => {
  // NoData upper-left triangle — the icond2/iconch1 bbox-corner shape.
  const rows = ["XXX..", "XX...", "X....", ".....", "....."];
  const d = edgeDistanceKm(win(rows));
  const nx = 5;
  // Valid texels adjacent (4- or 8-) to the staircase are within one diagonal step.
  assert.ok(d[0 * nx + 3] <= Math.SQRT2 * KM_PER_DEG + 1);
  assert.ok(d[2 * nx + 1] <= Math.SQRT2 * KM_PER_DEG + 1);
  // The far corner is the deepest point.
  const far = d[4 * nx + 4];
  for (let j = 0; j < 5; j++) {
    for (let i = 0; i < 5; i++) assert.ok(d[j * nx + i] <= far + 1e-6);
  }
});

test("edgeDistanceKm: distances cap at capKm", () => {
  // 1 nodata texel in a wide window: far texels clamp to the cap.
  const rows: string[] = [];
  for (let j = 0; j < 3; j++) rows.push("X" + ".".repeat(40));
  const d = edgeDistanceKm(win(rows), 200);
  assert.equal(d[41 * 1 - 1 + 40], 200); // right edge of row 0 (40° ≈ 4400 km away)
  assert.equal(d[0], 0);
});

test("edgeDistanceKm: dx shrinks with cos(lat) at high latitude", () => {
  // Same mask at 80°N: an eastward step is ~cos(80°)·111 km ≈ 19 km.
  const w = win(["X....", "X....", "X...."]);
  w.grid.lat0 = 80;
  w.grid.dlat = -0.0001; // keep rows at ~80°N so cos(lat) is uniform
  const d = edgeDistanceKm(w);
  const cos80 = Math.cos((80 * Math.PI) / 180);
  const got = d[0 * 5 + 3];
  const want = 3 * KM_PER_DEG * cos80;
  assert.ok(Math.abs(got - want) / want < 0.02, `${got} vs ${want}`);
});
