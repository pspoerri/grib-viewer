import { test } from "node:test";
import assert from "node:assert/strict";

// CPU mirror of the GLSL bsplineW/bsplineDW embedded in wxLayer2.ts's contour
// shader. These MUST stay identical — the GPU can't be unit-tested headlessly
// (fp32 unreliable), so this pins the math the shader copies.
function W(t: number): number {
  const at = Math.abs(t);
  if (at < 1) return (0.5 * at - 1) * at * at + 2 / 3;
  if (at < 2) {
    const u = 2 - at;
    return (u * u * u) / 6;
  }
  return 0;
}
function dW(t: number): number {
  const at = Math.abs(t);
  const s = Math.sign(t);
  if (at < 1) return s * (1.5 * at - 2) * at;
  if (at < 2) {
    const u = 2 - at;
    return -s * 0.5 * u * u;
  }
  return 0;
}
// Stencil weights at fractional texel position fr, offsets -1..2: W(off - fr).
const wts = (fr: number) => [-1, 0, 1, 2].map((o) => W(o - fr));
const dwts = (fr: number) => [-1, 0, 1, 2].map((o) => -dW(o - fr)); // sign per GLSL

test("value weights are a partition of unity (unbiased reconstruction)", () => {
  for (const fr of [0, 0.1, 0.5, 0.73, 0.999]) {
    const s = wts(fr).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(s - 1) < 1e-6, `Σw(${fr})=${s}`);
  }
});

test("kernel SMOOTHS a checkerboard (B-spline, not Catmull-Rom)", () => {
  // Interpolating Catmull-Rom returns ±1; the smoothing B-spline returns ~±1/3.
  const checker = [1, -1, 1, -1];
  const c = wts(0).reduce((a, w, i) => a + w * checker[i], 0);
  assert.ok(Math.abs(c) < 0.4, `checkerboard should attenuate to ~1/3, got ${c}`);
});

test("derivative weights sum to zero", () => {
  for (const fr of [0.2, 0.5, 0.8]) {
    const s = dwts(fr).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(s) < 1e-6, `Σdw(${fr})=${s}`);
  }
});

test("analytic gradient matches finite difference on a ramp", () => {
  // A linear field v(i)=3i sampled by the stencil: reconstructed dV/di must be 3.
  const field = (i: number) => 3 * i; // texel index → value
  for (const fr of [0.25, 0.5, 0.6]) {
    // taps at integer indices base-1..base+2 around position p=base+fr; use base=0.
    const taps = [-1, 0, 1, 2].map((o) => field(o));
    const dvdi = dwts(fr).reduce((a, dw, k) => a + dw * taps[k], 0);
    assert.ok(Math.abs(dvdi - 3) < 1e-5, `dV/di(${fr})=${dvdi}, want 3`);
  }
});
