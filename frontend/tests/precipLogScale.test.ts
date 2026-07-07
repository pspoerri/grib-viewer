import assert from "node:assert/strict";
import {
  isLogColormap,
  logColorT,
  logColorValue,
} from "../src/lib/colormap.ts";

// precip is the log accumulation palette; nothing else (yet).
assert.equal(isLogColormap("precip"), true);
assert.equal(isLogColormap("wind"), false);
assert.equal(isLogColormap(undefined), false);

// Shared precip window — must match the Go NormT / GPU shader exactly.
const VMIN = 0.1;
const VMAX = 100;

// Below/at floor → transparent first stop; vmax → top.
assert.equal(logColorT(0.05, VMIN, VMAX), 0);
assert.equal(logColorT(0.1, VMIN, VMAX), 0);
assert.equal(logColorT(100, VMIN, VMAX), 1);

// Decades split the bar into even thirds (0.1→1→10→100).
assert.ok(Math.abs(logColorT(1, VMIN, VMAX) - 1 / 3) < 1e-9);
assert.ok(Math.abs(logColorT(10, VMIN, VMAX) - 2 / 3) < 1e-9);

// The core fix: more rain → strictly more colour (the old per-window
// linear scale made a longer window render *lighter*).
let prev = -1;
for (const v of [0.2, 0.5, 1, 3, 5, 8, 20, 50, 90]) {
  const t = logColorT(v, VMIN, VMAX);
  assert.ok(t > prev, `logColorT(${v}) = ${t} not > ${prev}`);
  assert.ok(t > 0 && t < 1, `logColorT(${v}) = ${t} outside (0,1)`);
  prev = t;
}

// logColorValue inverts logColorT.
for (const v of [0.3, 1, 7.5, 42, 99]) {
  const back = logColorValue(logColorT(v, VMIN, VMAX), VMIN, VMAX);
  assert.ok(Math.abs(back - v) < 1e-6, `round-trip ${v} → ${back}`);
}

// vmin=0 archive still logs without log(0): floor = vmax/1000.
assert.equal(logColorT(0.04, 0, 40), 0); // below 40/1000 = 0.04 floor
assert.ok(logColorT(4, 0, 40) > 0);

console.log("precipLogScale.test.ts ok");
