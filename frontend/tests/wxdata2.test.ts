import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeWindow, decodeChunk, lapseFixed } from "../src/lib/wxdata2.ts";

// Fixture emitted by the Go encoder (backend/internal/format/datatile2, a 2×1
// grid: value(0,0)=100, value(1,0)=200 raw int16; scale 0.1). Cross-language
// proof that the TS decoder reads the real protobuf wire.
const FIXTURE_HEX =
  "0a01741204745f326d1a280802100119000000000000494021000000000000244029000000000000f0bf31000000000000f03f22046400c8002dcdcccc3d388080feffffffffffff01";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

test("decodeWindow reads the Go-encoded protobuf Window", () => {
  const w = decodeWindow(hexToBytes(FIXTURE_HEX));
  assert.equal(w.model, "t");
  assert.equal(w.variable, "t_2m");
  assert.deepEqual(w.grid, { nx: 2, ny: 1, lat0: 50, lon0: 10, dlat: -1, dlon: 1 });
  assert.equal(w.values.length, 2);
  assert.equal(w.values[0], 100);
  assert.equal(w.values[1], 200);
  assert.ok(Math.abs(w.scale - 0.1) < 1e-6);
  assert.equal(w.offset, 0);
  assert.equal(w.nodata, -32768);
});

// --- new spec-03 fields: 8 height, 11 synthetic_time, 12 run_unix ----------

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  for (;;) {
    const b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v === 0) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p instanceof Uint8Array ? p : Uint8Array.from(p), off);
    off += p.length;
  }
  return out;
}

test("decodeWindow reads height (8), synthetic_time (11), run_unix (12)", () => {
  const base = hexToBytes(FIXTURE_HEX);
  // field 8 (bytes): 2×int16 LE height plane [500, -100]
  const height = [0x42, 4, 0xf4, 0x01, 0x9c, 0xff];
  // field 11 (varint bool): true
  const synth = [0x58, 1];
  // field 12 (varint int64): run reference 2026-06-28T00:00:00Z
  const runUnix = 1782604800;
  const run = [0x60, ...varint(runUnix)];
  const w = decodeWindow(concat(base, height, synth, run));
  assert.equal(w.values.length, 2); // untouched by the new fields
  assert.ok(w.height, "height plane decoded");
  assert.equal(w.height!.length, 2);
  assert.equal(w.height![0], 500);
  assert.equal(w.height![1], -100);
  assert.equal(w.syntheticTime, true);
  assert.equal(w.runUnix, runUnix);
});

test("multi-frame chunk: frames share the buffer + carry frame times", () => {
  const base = hexToBytes(FIXTURE_HEX);
  // Replace the values with two stacked frames (2 cells each): a trailing
  // field-4 occurrence wins in the hand decoder (last-write), so append a
  // 4-int16 values payload + nframes + two frame_unix entries.
  const values2 = [0x22, 8, 100, 0, 200, 0, 44, 1, 144, 1]; // [100,200,300,400]
  const nframes = [0x48, 2]; // field 9 = 2
  const t0 = 1782604800;
  const times = [0x50, ...varint(t0), 0x50, ...varint(t0 + 3600)];
  const w = decodeChunk(concat(base, values2, nframes, times));
  assert.equal(w.frames.length, 2);
  // Per-frame views split nx*ny=2 cells each, sharing the response buffer.
  assert.deepEqual([...w.frames[0].values], [100, 200]);
  assert.deepEqual([...w.frames[1].values], [300, 400]);
  assert.equal(w.times.length, 2);
  assert.equal(w.times[0], "2026-06-28T00:00:00Z");
  assert.equal(w.times[1], "2026-06-28T01:00:00Z");
});

test("lapseFixed mirrors the serve-side correction", () => {
  assert.ok(Math.abs(lapseFixed(280, 100, 600) - 276.75) < 1e-9);
  assert.equal(lapseFixed(280, 500, 500), 280);
});
