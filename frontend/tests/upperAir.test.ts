import assert from "node:assert/strict";
import {
  TOPICS,
  findTopicForPresetId,
  createLayer,
  parseIsobarLevel,
  swapIsobarLevel,
  activeIsobarLevel,
  matchesPreset,
  detectPreset,
  findPreset,
} from "../src/api/mapConfig.ts";
import { resolveActiveUnit, unitGroupForBase } from "../src/units.ts";

// ── §1 topic restructure ──────────────────────────────────────────
{
  const ids = TOPICS.map((t) => t.id);
  assert.ok(!ids.includes("wind"), "wind topic removed");
  assert.ok(!ids.includes("geopotential"), "geopotential topic removed");
  assert.deepEqual(
    ids,
    ["temperature", "precipitation", "upperair", "custom"],
    "final topic order",
  );

  const surface = TOPICS.find((t) => t.id === "precipitation");
  assert.ok(surface, "surface topic kept under id 'precipitation'");
  assert.equal(surface.label, "Surface", "renamed label");
  assert.deepEqual(
    surface.presetIds,
    [
      "precipitation",
      "humidity",
      "convection",
      "snow",
      "radiation",
      "pressure",
      "wind",
    ],
    "surface absorbs pressure + wind after the original five",
  );

  // Topic-id stability: presets that moved still resolve to a topic.
  assert.equal(findTopicForPresetId("pressure", []), "precipitation");
  assert.equal(findTopicForPresetId("wind", []), "precipitation");
  assert.equal(findTopicForPresetId("upper_geopotential", []), "upperair");
}

// ── §2 isobar helpers ─────────────────────────────────────────────
{
  // parseIsobarLevel: pull the level out of every isobaric id shape.
  assert.equal(parseIsobarLevel("fi_500hpa"), 500);
  assert.equal(parseIsobarLevel("t_850hpa"), 850);
  assert.equal(parseIsobarLevel("wind_speed_300hpa"), 300);
  assert.equal(parseIsobarLevel("u_300hpa"), 300);
  assert.equal(parseIsobarLevel("fi_500hpa[dam]"), 500, "bracket tolerated");
  // Non-isobaric ids → null.
  assert.equal(parseIsobarLevel("t_2m"), null);
  assert.equal(parseIsobarLevel("pmsl"), null);
  assert.equal(parseIsobarLevel("u_10m"), null);

  // swapIsobarLevel: rewrite the level token, preserve base + bracket.
  assert.equal(swapIsobarLevel("fi_500hpa", 850), "fi_850hpa");
  assert.equal(swapIsobarLevel("t_500hpa", 300), "t_300hpa");
  assert.equal(swapIsobarLevel("wind_speed_300hpa", 500), "wind_speed_500hpa");
  assert.equal(swapIsobarLevel("u_300hpa", 850), "u_850hpa");
  assert.equal(swapIsobarLevel("v_300hpa", 850), "v_850hpa");
  assert.equal(
    swapIsobarLevel("fi_500hpa[dam]", 850),
    "fi_850hpa[dam]",
    "bracket preserved",
  );
  // Non-isobaric ids pass through unchanged.
  assert.equal(swapIsobarLevel("t_2m", 500), "t_2m");
  assert.equal(swapIsobarLevel("pmsl", 500), "pmsl");

  // activeIsobarLevel: first level-bearing layer wins; null when none.
  assert.equal(
    activeIsobarLevel([
      createLayer("pmsl", "contour"),
      createLayer("t_850hpa", "tiles"),
    ]),
    850,
  );
  assert.equal(activeIsobarLevel([createLayer("t_2m", "tiles")]), null);
  assert.equal(activeIsobarLevel([]), null);
}

// ── §2 level-agnostic matching ────────────────────────────────────
{
  const geo = findPreset("upper_geopotential");
  assert.ok(geo, "upper_geopotential preset exists");

  // Rewrite the template (500 hPa) to 850 hPa the way the height
  // selector does, then confirm the preset still matches / detects.
  const at850 = geo.layers.map((l) => ({
    ...l,
    variable: swapIsobarLevel(l.variable, 850),
  }));
  assert.ok(
    matchesPreset(at850, geo),
    "850 hPa layers still match the 500 hPa geopotential template",
  );
  assert.equal(
    detectPreset(at850, []),
    "upper_geopotential",
    "detectPreset keeps the phenomenon id at a non-template level",
  );

  // Sanity: a genuinely different layer set is still 'custom'. (Use a
  // variable that no built-in preset references so detection can't latch
  // onto a single-layer preset.)
  assert.equal(
    detectPreset([createLayer("zzz_not_a_real_var", "tiles")], []),
    "custom",
  );

  // Sanity: the three phenomena stay distinct (different bases/modes),
  // so level-agnostic matching never collapses Temp into Height.
  const jet = findPreset("upper_wind");
  assert.ok(jet && !matchesPreset(jet.layers, geo), "Jet ≠ Height template");
}

// ── §3 geopotential unit group (gpm → dam) ────────────────────────
{
  const g = unitGroupForBase("gpm");
  assert.ok(g, "gpm resolves to a unit group");
  assert.equal(g.id, "geopotential");
  assert.equal(g.defaultOptionId, "dam");

  // Default (no pref) → dam, value/10 → "552".
  const au = resolveActiveUnit("gpm", {});
  assert.equal(au.option.id, "dam");
  assert.equal(au.option.label, "dam");
  assert.equal(au.option.convert(5520), 552);

  // Explicit gpm pref → identity.
  const raw = resolveActiveUnit("gpm", { geopotential: "gpm" });
  assert.equal(raw.option.id, "gpm");
  assert.equal(raw.option.convert(5520), 5520);
}

console.log("upperAir.test.ts: OK");
