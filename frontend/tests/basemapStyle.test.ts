import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FRONT_ANCHOR_KEY,
  mergeBasemapStyles,
  patchBasemapStyle,
  type AnyStyle,
} from "../src/lib/basemapStyle.ts";

const back: AnyStyle = {
  version: 8,
  sources: { osm: { type: "vector" } },
  layers: [{ id: "land" }, { id: "landuse" }],
  glyphs: "back://{fontstack}/{range}",
};

const front: AnyStyle = {
  sources: { osmfront: { type: "vector" } },
  layers: [{ id: "boundaries" }, { id: "water-lines" }, { id: "place-labels" }],
  sprite: "front-sprite",
  glyphs: "front://{fontstack}/{range}",
};

test("merge stacks front above back and records the anchor", () => {
  const merged = mergeBasemapStyles(back, front);
  assert.deepEqual(
    merged.layers?.map((l) => l.id),
    ["land", "landuse", "boundaries", "water-lines", "place-labels"],
  );
  assert.equal(merged.metadata?.[FRONT_ANCHOR_KEY], "boundaries");
  assert.ok(merged.sources?.osm && merged.sources?.osmfront);
});

test("merge prefers the front's glyphs and sprite (font-rendering fix)", () => {
  const merged = mergeBasemapStyles(back, front);
  assert.equal(merged.glyphs, "front://{fontstack}/{range}");
  assert.equal(merged.sprite, "front-sprite");
});

test("null or empty front falls back to the back style unchanged", () => {
  assert.equal(mergeBasemapStyles(back, null), back);
  assert.equal(mergeBasemapStyles(back, { layers: [] }), back);
});

test("patchBasemapStyle coerces boundary coalesce to-number", () => {
  const style: AnyStyle = {
    layers: [
      {
        id: "country-borders",
        filter: ["<=", ["coalesce", ["get", "kind_detail"], ["get", "admin_level"]], 2],
      },
      { id: "roads", filter: ["==", ["get", "kind"], "highway"] },
    ],
  };
  patchBasemapStyle(style);
  assert.deepEqual(style.layers?.[0].filter, [
    "<=",
    ["to-number", ["coalesce", ["get", "kind_detail"], ["get", "admin_level"]]],
    2,
  ]);
  // non-boundary filters untouched
  assert.deepEqual(style.layers?.[1].filter, ["==", ["get", "kind"], "highway"]);
});

test("patchBasemapStyle strips place-label dots and drops road shields", () => {
  const style: AnyStyle = {
    layers: [
      {
        id: "places_locality",
        layout: { "icon-image": "townspot", "text-field": ["get", "name"] },
      },
      { id: "roads_shields", layout: { "icon-image": "shield" } },
      { id: "roads_labels_major", layout: { "text-field": ["get", "name"] } },
    ],
  };
  patchBasemapStyle(style);
  assert.deepEqual(
    style.layers?.map((l) => l.id),
    ["places_locality", "roads_labels_major"],
  );
  const layout = style.layers?.[0].layout as Record<string, unknown>;
  assert.equal(layout["icon-image"], undefined);
  assert.deepEqual(layout["text-field"], ["get", "name"]);
});

