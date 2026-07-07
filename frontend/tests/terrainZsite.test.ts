import { test } from "node:test";
import assert from "node:assert/strict";
import {
  terrariumMeters,
  decodeTerrariumTile,
  pickTerrariumZoom,
  tileRangeForBBox,
  chooseGrid,
  assembleMosaic,
  resampleToWindow,
} from "../src/lib/terrainZsite.ts";

// ---- terrarium RGB → meters --------------------------------------------
// meters = R*256 + G + B/256 − 32768. The −32768 offset means 0 m is encoded
// as R=128, G=0, B=0 (128*256 = 32768).
test("terrariumMeters: sea level 0 m ⇒ (128,0,0)", () => {
  assert.equal(terrariumMeters(128, 0, 0), 0);
});

test("terrariumMeters: one red step is +256 m", () => {
  assert.equal(terrariumMeters(129, 0, 0), 256);
});

test("terrariumMeters: green is the 1 m digit", () => {
  assert.equal(terrariumMeters(128, 100, 0), 100);
});

test("terrariumMeters: blue is the sub-meter digit (1/256 m)", () => {
  assert.equal(terrariumMeters(128, 0, 128), 0.5);
});

test("terrariumMeters: below sea level is negative", () => {
  assert.equal(terrariumMeters(127, 0, 0), -256);
  // Dead Sea shore ≈ −430 m: R=126,G=82 → 126*256+82−32768 = −430
  assert.equal(terrariumMeters(126, 82, 0), -430);
});

test("terrariumMeters: a high peak (Mont Blanc ≈ 4808 m)", () => {
  // 4808 + 32768 = 37576 = 146*256 + 200
  assert.equal(terrariumMeters(146, 200, 0), 4808);
});

// ---- tile decode over synthetic RGBA -----------------------------------
test("decodeTerrariumTile: RGBA row-major → meters per pixel", () => {
  // 2×1 tile: px0 = 0 m (128,0,0), px1 = 100 m (128,100,0). Alpha ignored.
  const data = new Uint8ClampedArray([128, 0, 0, 255, 128, 100, 0, 255]);
  const m = decodeTerrariumTile({ width: 2, height: 1, data });
  assert.equal(m.length, 2);
  assert.equal(m[0], 0);
  assert.equal(m[1], 100);
});

// ---- zoom choice -------------------------------------------------------
test("pickTerrariumZoom: rounds map zoom, floored 0, uncapped (Mapterhorn overzooms)", () => {
  assert.equal(pickTerrariumZoom(0), 0);
  assert.equal(pickTerrariumZoom(-3), 0);
  assert.equal(pickTerrariumZoom(4.2), 4);
  assert.equal(pickTerrariumZoom(9.6), 10);
  assert.equal(pickTerrariumZoom(12), 12);
  assert.equal(pickTerrariumZoom(15.9), 16);
});

// ---- covering tile range ----------------------------------------------
test("tileRangeForBBox: z0 covers the single world tile", () => {
  const r = tileRangeForBBox(-10, -10, 10, 10, 0);
  assert.deepEqual(r, { x0: 0, x1: 0, y0: 0, y1: 0 });
});

test("tileRangeForBBox: z1 west/east & north/south split", () => {
  // West of the prime meridian ⇒ x tile 0; east ⇒ x tile 1. North ⇒ y 0, south ⇒ y 1.
  const r = tileRangeForBBox(-10, -10, 10, 10, 1);
  assert.deepEqual(r, { x0: 0, x1: 1, y0: 0, y1: 1 });
});

test("tileRangeForBBox: indices clamp to [0, 2^z-1]", () => {
  const r = tileRangeForBBox(-179.9, -85, 179.9, 85, 2);
  assert.equal(r.x0, 0);
  assert.equal(r.x1, 3);
  assert.equal(r.y0, 0);
  assert.equal(r.y1, 3);
});

// ---- output grid sizing ------------------------------------------------
test("chooseGrid: cells scale with the bbox px span at the zoom, capped", () => {
  const g = chooseGrid(-1, -1, 1, 1, 8, 512);
  // Sane, bounded, ≥2 each dim.
  assert.ok(g.nx >= 2 && g.ny >= 2);
  assert.ok(g.nx <= 1024 && g.ny <= 1024);
  assert.ok(g.nx * g.ny <= 700000);
  // A wider bbox at the same zoom yields at least as many columns.
  const wide = chooseGrid(-4, -1, 4, 1, 8, 512);
  assert.ok(wide.nx >= g.nx);
});

// ---- mosaic + resample -------------------------------------------------
// Build a 2×2-tile mosaic of tiny 2×2-px tiles at z=1, all one elevation, and
// confirm a resample yields that constant everywhere with the right grid def.
test("assembleMosaic + resampleToWindow: constant terrain, correct grid def", () => {
  const ts = 2;
  const const1234 = () => {
    const a = new Float32Array(ts * ts);
    a.fill(1234);
    return a;
  };
  const tiles = [
    [const1234(), const1234()],
    [const1234(), const1234()],
  ];
  const mosaic = assembleMosaic(tiles, ts, 0, 0);
  assert.equal(mosaic.width, 2 * ts);
  assert.equal(mosaic.height, 2 * ts);
  assert.equal(mosaic.originPx, 0);
  assert.equal(mosaic.originPy, 0);

  const west = -20,
    south = -20,
    north = 20,
    east = 20;
  const w = resampleToWindow(mosaic, 1, ts, west, south, east, north, 5, 5);
  // Grid def: lat0 = north, dlat < 0 (north→south); lon0 = west, dlon > 0.
  assert.equal(w.grid.nx, 5);
  assert.equal(w.grid.ny, 5);
  assert.equal(w.grid.lat0, north);
  assert.equal(w.grid.lon0, west);
  assert.ok(w.grid.dlat < 0);
  assert.ok(w.grid.dlon > 0);
  assert.equal(w.scale, 1);
  assert.equal(w.offset, 0);
  // Every dequantized cell equals the constant elevation.
  for (let i = 0; i < w.values.length; i++) {
    assert.equal(w.values[i] * w.scale + w.offset, 1234);
  }
});

test("resampleToWindow: horizontal gradient stays monotonic W→E", () => {
  const ts = 4;
  // One tile at z0 with a left-to-right meter ramp (col index * 100).
  const a = new Float32Array(ts * ts);
  for (let y = 0; y < ts; y++) for (let x = 0; x < ts; x++) a[y * ts + x] = x * 100;
  const mosaic = assembleMosaic([[a]], ts, 0, 0);
  const w = resampleToWindow(mosaic, 0, ts, -170, -80, 170, 80, 8, 3);
  // Middle row should increase strictly from west to east.
  const midRow = 1;
  let prev = -Infinity;
  for (let i = 0; i < w.grid.nx; i++) {
    const v = w.values[midRow * w.grid.nx + i] * w.scale + w.offset;
    assert.ok(v >= prev, `col ${i} value ${v} not ≥ ${prev}`);
    prev = v;
  }
  assert.ok(prev > w.values[midRow * w.grid.nx] * w.scale + w.offset - 1);
});
