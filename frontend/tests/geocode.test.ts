import { test } from "node:test";
import assert from "node:assert/strict";
import {
  trimDisplayName,
  nominatimBBox,
  toSearchResult,
  reverseZoom,
  kindBBox,
  NOMINATIM_BASE,
  SEARCH_URL,
} from "../src/api/geocode.ts";

test("search URL derives from the configurable Nominatim base", () => {
  assert.equal(SEARCH_URL, `${NOMINATIM_BASE}/search`);
});

test("trimDisplayName keeps the first two comma segments", () => {
  assert.equal(
    trimDisplayName("Zürich, Bezirk Zürich, Zürich, Schweiz"),
    "Zürich, Bezirk Zürich",
  );
  assert.equal(trimDisplayName("Paris"), "Paris");
  assert.equal(trimDisplayName(undefined, "fallback"), "fallback");
});

test("nominatimBBox maps ['s','n','w','e'] strings → [w,s,e,n] numbers", () => {
  assert.deepEqual(nominatimBBox(["47.32", "47.43", "8.45", "8.63"]), [
    8.45, 47.32, 8.63, 47.43,
  ]);
  assert.equal(nominatimBBox(["a", "b", "c", "d"]), undefined);
  assert.equal(nominatimBBox(undefined), undefined);
});

test("toSearchResult maps a jsonv2 result onto the app shape", () => {
  const r = toSearchResult({
    name: "Zürich",
    display_name: "Zürich, Bezirk Zürich, Zürich, Schweiz",
    lat: "47.3744",
    lon: "8.5410",
    category: "boundary",
    type: "administrative",
    addresstype: "city",
    place_rank: 16,
    boundingbox: ["47.32", "47.43", "8.45", "8.63"],
  });
  assert.ok(r);
  assert.deepEqual(r.center, [8.541, 47.3744]);
  assert.equal(r.text, "Zürich");
  assert.equal(r.placeName, "Zürich, Bezirk Zürich");
  assert.equal(r.kind, "city");
  assert.equal(r.country, "Schweiz");
  assert.equal(r.zoom, 8); // place_rank / 2
  assert.deepEqual(r.bbox, [8.45, 47.32, 8.63, 47.43]);
  // Nominatim serves no timezone — consumers degrade.
  assert.equal(r.timezone, undefined);
});

test("toSearchResult: bbox-less results fall back to the kind-scaled box", () => {
  const r = toSearchResult({ name: "Spot", lat: "47", lon: "8", type: "peak" });
  assert.ok(r);
  assert.deepEqual(r.bbox, kindBBox(47, 8, "peak"));
});

test("toSearchResult rejects unusable results", () => {
  assert.equal(toSearchResult({ name: "x" }), null);
  assert.equal(toSearchResult({ lat: "47", lon: "8" }), null); // nameless
});

test("reverseZoom clamps the map zoom into Nominatim's [3,18]", () => {
  assert.equal(reverseZoom(0), 3);
  assert.equal(reverseZoom(10.4), 10);
  assert.equal(reverseZoom(22), 18);
  assert.equal(reverseZoom(undefined), 10);
});
