import { test } from "node:test";
import assert from "node:assert/strict";
import { compositeEpsState, compositeModelForEps, layerModel, bulkApplyMode, modelsInUse } from "../src/lib/epsMode.ts";
import { strippedBase, medianVarId, aggBase, encodeLayerSegment, decodeLayerSegment } from "../src/api/mapConfig.ts";
import type { MapLayer } from "../src/api/mapConfig.ts";

let _n = 0;
function layer(variable: string, extra: Partial<MapLayer> = {}): MapLayer {
  return { id: `ly-${++_n}`, variable, displayMode: "tiles", opacity: 1, visible: true, ...extra } as MapLayer;
}

test("compositeEpsState maps the composite flavor (else undefined)", () => {
  assert.equal(compositeEpsState("auto"), false);
  assert.equal(compositeEpsState("auto_eps"), true);
  assert.equal(compositeEpsState("iconch1"), undefined);
  assert.equal(compositeEpsState("icondglobal"), undefined);
});

test("compositeModelForEps picks the composite id", () => {
  assert.equal(compositeModelForEps(true), "auto_eps");
  assert.equal(compositeModelForEps(false), "auto");
});

test("strippedBase removes every ensemble product / threshold suffix", () => {
  assert.equal(strippedBase("t_2m"), "t_2m");
  assert.equal(strippedBase("t_2m_p90"), "t_2m");
  assert.equal(strippedBase("t_2m_p0"), "t_2m");
  assert.equal(strippedBase("t_2m_mean"), "t_2m");
  assert.equal(strippedBase("t_2m_ctrl"), "t_2m");
  assert.equal(strippedBase("t_2m_spread"), "t_2m");
  assert.equal(strippedBase("t_2m_gt20c"), "t_2m"); // chance-of (gt)
  assert.equal(strippedBase("t_2m_lt0c"), "t_2m"); // chance-of (lt)
  assert.equal(strippedBase("t_2m_m07"), "t_2m"); // ensemble member (via splitEnsembleVar)
});

test("aggBase strips the window mod AND every ensemble product to the catalog base", () => {
  // The catalog-base resolver feeds both aggCapsFor (window chips) and
  // HoverValueLabel's unit lookup. It must peel _mean / _spread / threshold
  // too — splitEnsembleVar alone misses those, so a Mean layer (t_2m_mean)
  // failed unit resolution and the hover showed raw Kelvin.
  assert.equal(aggBase("t_2m"), "t_2m");
  assert.equal(aggBase("t_2m_p90"), "t_2m");
  assert.equal(aggBase("t_2m_mean"), "t_2m"); // the Kelvin-in-hover bug
  assert.equal(aggBase("t_2m_spread"), "t_2m");
  assert.equal(aggBase("t_2m_gt20c"), "t_2m"); // chance-of
  assert.equal(aggBase("t_2m_p90__6h_max"), "t_2m"); // window × product
  assert.equal(aggBase("t_2m_mean__6h_max"), "t_2m");
});

test("medianVarId returns the displayVar form (alias families) and is idempotent", () => {
  assert.equal(medianVarId("t_2m_p90"), "t_2m");
  assert.equal(medianVarId("t_2m_mean"), "t_2m");
  assert.equal(medianVarId("t_2m"), "t_2m");
  // gusts: dist base vmax_10m → displayVar wind_gust_10m
  assert.equal(medianVarId("vmax_10m_p90"), "wind_gust_10m");
  assert.equal(medianVarId("wind_gust_10m"), "wind_gust_10m"); // idempotent
  // precip: tot_prec → precip_1h
  assert.equal(medianVarId("tot_prec_gt2p5mm"), "precip_1h");
});

// ---------------------------------------------------------------------------
// New: per-layer ensemble mode helpers
// ---------------------------------------------------------------------------

test("layerModel: det→auto, eps→auto_eps, undefined inherits selectedModel, physical→selectedModel", () => {
  const det = layer("t_2m", { ensembleMode: "det" });
  const eps = layer("t_2m", { ensembleMode: "eps" });
  const undef = layer("t_2m"); // ensembleMode absent

  // Composite selectedModel: det→auto, eps→auto_eps
  assert.equal(layerModel(det, "auto"), "auto");
  assert.equal(layerModel(det, "auto_eps"), "auto");
  assert.equal(layerModel(eps, "auto"), "auto_eps");
  assert.equal(layerModel(eps, "auto_eps"), "auto_eps");

  // Undefined inherits from selectedModel
  assert.equal(layerModel(undef, "auto"), "auto");
  assert.equal(layerModel(undef, "auto_eps"), "auto_eps");

  // Physical model: ensembleMode is ignored — selectedModel returned unchanged
  assert.equal(layerModel(det, "icondglobal"), "icondglobal");
  assert.equal(layerModel(eps, "icondglobal"), "icondglobal");
  assert.equal(layerModel(det, "iconch1"), "iconch1");
  assert.equal(layerModel(eps, "iconch1"), "iconch1");
  assert.equal(layerModel(undef, "icondglobal"), "icondglobal");
});

test("modelsInUse: composite yields both flavors; physical yields just itself", () => {
  // Both composites expose both flavors (a layer can route to either via
  // ensembleMode), so App.tsx must fetch both catalogs for per-layer metadata.
  assert.deepEqual(modelsInUse("auto"), ["auto", "auto_eps"]);
  assert.deepEqual(modelsInUse("auto_eps"), ["auto", "auto_eps"]);
  // Physical models: ensembleMode is ignored, so only the model's own catalog.
  assert.deepEqual(modelsInUse("icondglobal"), ["icondglobal"]);
  assert.deepEqual(modelsInUse("iconch1"), ["iconch1"]);
  assert.deepEqual(modelsInUse("iconeueps"), ["iconeueps"]);
});

test("modelsInUse ∘ layerModel: every layer's resolved model is in the in-use set", () => {
  // The invariant App.tsx relies on: the catalog map keyed by modelsInUse
  // covers layerModel(layer) for any layer/selectedModel combination.
  for (const sel of ["auto", "auto_eps", "icondglobal"]) {
    const inUse = new Set(modelsInUse(sel));
    for (const mode of ["det", "eps", undefined] as const) {
      const l = layer("t_2m", mode ? { ensembleMode: mode } : {});
      assert.ok(
        inUse.has(layerModel(l, sel)),
        `layerModel(${mode ?? "undef"}, ${sel})=${layerModel(l, sel)} not in ${[...inUse]}`,
      );
    }
  }
});

test("bulkApplyMode: sets ensembleMode + resets product on visible tile layers; hidden/non-tile untouched; does not mutate inputs", () => {
  // Visible tile layers with various product suffixes
  const p90Layer   = layer("t_2m_p90");             // → t_2m (strippedBase→t_2m, DIST_DISPLAY_BASE→t_2m)
  const meanLayer  = layer("vmax_10m_mean");         // → wind_gust_10m (strippedBase→vmax_10m, DIST_DISPLAY_BASE→wind_gust_10m)
  const ctrlLayer  = layer("t_2m_ctrl");             // → t_2m
  const threshLayer = layer("tot_prec_gt2p5mm");     // → precip_1h (parseThresholdId→tot_prec, DIST_DISPLAY_BASE→precip_1h)
  // Hidden tile layer — must be untouched
  const hiddenLayer = layer("t_2m_p90", { visible: false });
  // Non-tile visible layer (flow) — must be untouched
  const flowLayer  = layer("u_10m", { displayMode: "flow" });

  const inputLayers: MapLayer[] = [p90Layer, meanLayer, ctrlLayer, threshLayer, hiddenLayer, flowLayer];
  // Freeze originals to detect mutation
  const origSnapshot = inputLayers.map(l => ({ ...l }));

  // --- mode="eps" ---
  const epsResult = bulkApplyMode(inputLayers, "eps");

  // Returns a new array
  assert.notEqual(epsResult, inputLayers);

  // p90Layer → t_2m, ensembleMode=eps
  assert.equal(epsResult[0].ensembleMode, "eps");
  assert.equal(epsResult[0].variable, "t_2m");         // medianVarId("t_2m_p90") = "t_2m"
  assert.notEqual(epsResult[0], p90Layer);              // new object

  // meanLayer: vmax_10m_mean → wind_gust_10m
  assert.equal(epsResult[1].ensembleMode, "eps");
  assert.equal(epsResult[1].variable, "wind_gust_10m"); // medianVarId("vmax_10m_mean") = "wind_gust_10m"

  // ctrlLayer: t_2m_ctrl → t_2m
  assert.equal(epsResult[2].ensembleMode, "eps");
  assert.equal(epsResult[2].variable, "t_2m");          // medianVarId("t_2m_ctrl") = "t_2m"

  // threshLayer: tot_prec_gt2p5mm → precip_1h_mean (precip family defaults
  // to the EPS Mean on DET→EPS, in the consistent precip_{N}h name; its
  // median hourly rate is ~0).
  assert.equal(epsResult[3].ensembleMode, "eps");
  assert.equal(epsResult[3].variable, "precip_1h_mean");

  // hiddenLayer: untouched (same object reference)
  assert.equal(epsResult[4], hiddenLayer);

  // flowLayer: untouched (same object reference)
  assert.equal(epsResult[5], flowLayer);

  // --- mode="det" ---
  const detResult = bulkApplyMode(inputLayers, "det");
  assert.equal(detResult[0].ensembleMode, "det");
  assert.equal(detResult[0].variable, "t_2m");
  assert.equal(detResult[4], hiddenLayer);  // hidden still untouched
  assert.equal(detResult[5], flowLayer);    // non-tile still untouched

  // Input array not mutated
  for (let i = 0; i < inputLayers.length; i++) {
    assert.deepEqual(inputLayers[i], origSnapshot[i]);
  }
});

test("URL round-trip: .det/.eps token preserved; absent token decodes to undefined; back-compat with token-less hashes", () => {
  // Encode a layer with ensembleMode:"eps" and decode it back
  const epsLayer = layer("clct", { ensembleMode: "eps" });
  const epsSeg = encodeLayerSegment(epsLayer);
  assert.ok(epsSeg.endsWith(".eps"), `expected .eps suffix, got: ${epsSeg}`);
  const epsDecoded = decodeLayerSegment(epsSeg);
  assert.ok(epsDecoded !== null);
  assert.equal(epsDecoded!.ensembleMode, "eps");
  assert.equal(epsDecoded!.variable, "clct");

  // Encode a layer with ensembleMode:"det" and decode it back
  const detLayer = layer("pmsl", { ensembleMode: "det" });
  const detSeg = encodeLayerSegment(detLayer);
  assert.ok(detSeg.endsWith(".det"), `expected .det suffix, got: ${detSeg}`);
  const detDecoded = decodeLayerSegment(detSeg);
  assert.ok(detDecoded !== null);
  assert.equal(detDecoded!.ensembleMode, "det");

  // Layer with no ensembleMode → segment has no .det/.eps, decodes to undefined
  const noMode = layer("t_2m");
  const noModeSeg = encodeLayerSegment(noMode);
  assert.ok(!noModeSeg.endsWith(".eps") && !noModeSeg.endsWith(".det"), `unexpected mode token: ${noModeSeg}`);
  const noModeDecoded = decodeLayerSegment(noModeSeg);
  assert.equal(noModeDecoded!.ensembleMode, undefined);

  // Back-compat: hand-crafted token-less segment decodes to ensembleMode=undefined
  const bareDecoded = decodeLayerSegment("clct.t.10");
  assert.ok(bareDecoded !== null);
  assert.equal(bareDecoded!.ensembleMode, undefined);

  // .ga token still works alongside .eps
  const withGa = layer("clct", { ensembleMode: "eps", gpuAnim: true });
  const withGaSeg = encodeLayerSegment(withGa);
  assert.ok(withGaSeg.includes(".ga"), `missing .ga in: ${withGaSeg}`);
  assert.ok(withGaSeg.endsWith(".eps"), `expected .eps at end: ${withGaSeg}`);
  const withGaDecoded = decodeLayerSegment(withGaSeg);
  assert.equal(withGaDecoded!.ensembleMode, "eps");
  assert.equal(withGaDecoded!.gpuAnim, true);

  // clct.t.10.ga round-trips token-lessly (no mode → undefined)
  const gaOnly = decodeLayerSegment("clct.t.10.ga");
  assert.equal(gaOnly!.ensembleMode, undefined);
  assert.equal(gaOnly!.gpuAnim, true);

  // clct.t.10.ga.eps carries eps
  const gaEps = decodeLayerSegment("clct.t.10.ga.eps");
  assert.equal(gaEps!.ensembleMode, "eps");
  assert.equal(gaEps!.gpuAnim, true);
});
