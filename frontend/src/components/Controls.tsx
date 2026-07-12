import type {
  Model,
  Run,
  Variable,
  BaseMapId,
  ProjectionId,
  TimeFormat,
  WeatherStyle,
} from "../api/types";
import {
  BASE_MAPS,
  isCompositeModel,
  splitEnsembleVar,
  AUTO_MODEL_ID,
  AUTO_EPS_MODEL_ID,
} from "../api/types";
import { useEffect, useMemo, useState } from "react";
import type { MapLayer, DisplayMode, MapConfig } from "../api/mapConfig";
import {
  PROB_VARIANTS,
  probVariantBase,
  EPS_SIBLING,
  DIST_BASES,
  DIST_DISPLAY_BASE,
  DIST_LABELS,
} from "../api/mapConfig";
import { colormapLegendURL } from "../lib/wxColormap2";
import { formatRunLabel } from "../lib/runLabel";
import { fetchV2AvailableVariables, INERT_DIST } from "../api/v2catalog";
import type { AvailableVariable, DistCapability } from "../api/v2catalog";
import {
  parseThresholdId,
} from "../api/distIds";
import {
  effectiveStepped,
  isTemperatureUnits,
  listColormapNames,
} from "../lib/colormap";
import { resolveActiveUnit, unitGroupForBase } from "../units";
import { modelInfoFor } from "../api/modelInfo";
import { ModelOptions } from "./StatusBadge";
import { useThreshold } from "../lib/useThreshold";
import { currentProduct } from "../api/products";
import {
  gateOptions,
  productPatch,
  effectiveLayerMode,
  PICKER_SEGMENTS,
  segmentEnabled,
  unavailableProductPatch,
} from "../lib/layerProductGate";
import type { LayerGate, PickerProduct } from "../lib/layerProductGate";

// ---------------------------------------------------------------------------
// Display-mode labels
// ---------------------------------------------------------------------------

const MODE_LABELS: Record<DisplayMode, string> = {
  tiles: "T",
  contour: "C",
  value: "V",
  barbs: "B",
  flow: "F",
};

const MODE_TITLES: Record<DisplayMode, string> = {
  tiles: "Raster tiles",
  contour: "Contour lines",
  value: "Grid values",
  barbs: "Wind barbs",
  flow: "Flow lines",
};

// Playback-speed presets, in wall-clock ms per forecast hour. Smaller =
// faster. 125 ms is the minimum (one integer frame every 125 ms for a
// 1h-cadence archive); 4 s is the slowest.
const PLAYBACK_SPEED_PRESETS: { label: string; ms: number }[] = [
  { label: "125 ms", ms: 125 },
  { label: "250 ms", ms: 250 },
  { label: "500 ms", ms: 500 },
  { label: "1 s", ms: 1000 },
  { label: "2 s", ms: 2000 },
  { label: "4 s", ms: 4000 },
];

/** Build the legend-image options object from a layer + its (already
 *  resolved) units / vmin / vmax tuple. Encapsulates the stepping
 *  decision so the Controls and MapLegend renderers share one source of
 *  truth: stepped on for K-units fields by default, off elsewhere, with
 *  the per-layer flag overriding either way. vmin/vmax are passed in
 *  the field's canonical (Kelvin) units so the server's
 *  SteppedTempBoundaries computation lands on integer Celsius. */
function layerLegendOpts(
  layer: MapLayer,
  units: string | undefined,
  vminK: number | undefined,
  vmaxK: number | undefined,
): { stepped: boolean; vminK?: number; vmaxK?: number } | undefined {
  const stepped = effectiveStepped(layer.stepped, units);
  if (!stepped || !isTemperatureUnits(units) ||
    vminK == null || vmaxK == null) {
    return { stepped: false };
  }
  return { stepped: true, vminK, vmaxK };
}

const ALL_MODES: DisplayMode[] = ["tiles", "contour", "value", "barbs", "flow"];

/** Sentinel <option> value for a live dynamic threshold (the slider
 *  owns the id; the dropdown only displays the state). */
const CUSTOM_THRESHOLD = "__custom";

/** Determine which modes make sense for a given variable. */
function modesForVariable(variable: string): DisplayMode[] {
  // Threshold-probability fields — precomputed (prob_*) and dynamic
  // ({base}_gt2p5mm) — are scalar 0–100 % planes, never vector
  // fields, even when the name mentions wind.
  if (variable.startsWith("prob_") || parseThresholdId(variable) !== null) {
    return ["tiles", "contour", "value"];
  }
  // Barbs and flow make sense for wind-related variables
  const isWind =
    variable.includes("wind") ||
    variable.includes("u_10m") ||
    variable.includes("v_10m") ||
    variable.includes("vmax") ||
    variable === "u" ||
    variable === "v" ||
    variable === "wind_speed" ||
    variable === "wind_dir";
  return isWind ? ALL_MODES : ["tiles", "contour", "value"];
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  models: Model[];
  selectedModel: string;
  onModelChange: (model: string) => void;
  runs: Run[];
  latestRun: string;
  selectedRun: string;
  onRunChange: (run: string) => void;

  // Unified layers
  layers: MapLayer[];
  userPresets: MapConfig[];
  onSaveUserPreset: (label: string, icon: string) => void;
  onAddLayer: (variable: string, mode: DisplayMode) => void;
  onRemoveLayer: (layerId: string) => void;
  onLayerUpdate: (layerId: string, patch: Partial<MapLayer>) => void;
  onLayerReorder: (newOrder: string[]) => void;

  availableVariables: AvailableVariable[];
  /** Per-model variable catalog covering every model a layer can route to
   *  (both composite flavors on a composite, else just the model). Gates
   *  each visible layer row's per-layer DET|EPS + product control against
   *  its own model catalogs (det side ← `auto`, eps side ← `auto_eps`).
   *  Optional so older / physical-model wiring degrades to the existing
   *  single-catalog behaviour. */
  variablesByModel?: Map<string, AvailableVariable[]>;
  unitPrefs: Record<string, string>;
  onUnitPrefChange: (groupId: string, optionId: string) => void;
  weatherStyle: WeatherStyle | null;
  baseMap: BaseMapId;
  onBaseMapChange: (baseMap: BaseMapId) => void;
  projection: ProjectionId;
  onProjectionChange: (projection: ProjectionId) => void;
  terrain: boolean;
  onTerrainChange: (terrain: boolean) => void;
  hdr: boolean;
  onHdrChange: (hdr: boolean) => void;
  timeFormat: TimeFormat;
  onTimeFormatChange: (tf: TimeFormat) => void;
  /** True on synthetic-time runs: the time format is locked to "Lead"
   *  (frame times are not wall-clock meaningful). */
  leadLocked?: boolean;
  /** Opens the run browser panel (per-model buffered-run explorer). */
  onOpenRunBrowser?: () => void;
  /** Wall-clock ms per forecast hour during playback. Smaller = faster.
   *  TimeBar consumes the same value to pace the rAF loop. */
  playbackMsPerHour: number;
  onPlaybackMsPerHourChange: (ms: number) => void;
  open: boolean;
}

export default function Controls({
  models,
  selectedModel,
  onModelChange,
  runs,
  latestRun,
  selectedRun,
  onRunChange,
  layers,
  userPresets,
  onSaveUserPreset,
  onAddLayer,
  onRemoveLayer,
  onLayerUpdate,
  onLayerReorder,
  availableVariables,
  variablesByModel,
  unitPrefs,
  onUnitPrefChange,
  weatherStyle,
  baseMap,
  onBaseMapChange,
  projection,
  onProjectionChange,
  terrain,
  onTerrainChange,
  hdr,
  onHdrChange,
  timeFormat,
  onTimeFormatChange,
  leadLocked,
  onOpenRunBrowser,
  playbackMsPerHour,
  onPlaybackMsPerHourChange,
  open,
}: Props) {
  const model = models.find((m) => m.id === selectedModel);
  const variables = Array.isArray(model?.variables) ? model.variables : [];

  const [savingPreset, setSavingPreset] = useState(false);
  const [savePresetLabel, setSavePresetLabel] = useState("");
  const [savePresetIcon, setSavePresetIcon] = useState("⭐");
  // Set-once display settings (basemap, projection, quality, time
  // format, playback speed) live behind a disclosure so the panel's
  // prime real estate stays with the things users touch per-session:
  // model, layers, units.
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Deterministic models with an EPS sibling (ICON Global →
  // ICON-EPS Global) offer the sibling's probability products in the
  // per-layer dropdown; picking one switches to the sibling model.
  // The sibling catalog gates which variants actually render.
  const epsSibling = EPS_SIBLING[selectedModel];
  const [siblingVariables, setSiblingVariables] = useState<
    AvailableVariable[]
  >([]);
  // No reset on models without a sibling — the dropdown only consults
  // siblingVariables while epsSibling is set, so stale entries from a
  // previous model are unreachable.
  useEffect(() => {
    if (!epsSibling) return;
    let cancelled = false;
    fetchV2AvailableVariables(epsSibling)
      .then((vars) => {
        if (!cancelled) setSiblingVariables(vars);
      })
      .catch(() => {
        if (!cancelled) setSiblingVariables([]);
      });
    return () => {
      cancelled = true;
    };
  }, [epsSibling]);

  // Resolve unit for the primary tile layer (shown in per-layer legend)
  const primaryTile = layers.find(
    (l) => l.visible && l.displayMode === "tiles",
  );
  const primaryBaseUnit =
    weatherStyle?.metadata["weather-api:units"] ??
    variables.find((v) => v.name === primaryTile?.variable)?.units ??
    "";
  const primaryGroup = unitGroupForBase(primaryBaseUnit);

  return (
    <>
      <div className={`controls ${open ? "open" : ""}`}>
        {/* ---- Model selector ---- */}
        <section>
          <label htmlFor="model-select">Model</label>
          <select
            id="model-select"
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
          >
            {/* Shared with the top-right status panel's switcher — one
                source of truth for names/run labels (StatusBadge). */}
            <ModelOptions models={models} />
          </select>
          {/* Pinned-run chip: visible while a run is pinned; ✕ unpins so
              requests track the latest run again. */}
          {selectedRun && !isCompositeModel(selectedModel) && (
            <span className="pinned-run-chip" title="Requests are pinned to this run">
              📌 {formatRunLabel(selectedRun)}
              <button
                type="button"
                aria-label="Unpin run"
                onClick={() => onRunChange("")}
              >
                &times;
              </button>
            </span>
          )}
        </section>

        {/* ---- Run selector + browser (hidden for the auto composite) ---- */}
        {!isCompositeModel(selectedModel) && (
          <section>
            <label htmlFor="run-select">Run</label>
            <select
              id="run-select"
              value={selectedRun}
              onChange={(e) => onRunChange(e.target.value)}
              disabled={runs.length === 0}
            >
              <option value="">
                Latest{latestRun ? ` (${formatRunLabel(latestRun)})` : ""}
              </option>
              {runs.map((r) => (
                <option key={r.run} value={r.run}>
                  {formatRunLabel(r.run)}
                  {r.run === latestRun ? " — latest" : ""}
                </option>
              ))}
            </select>
            {onOpenRunBrowser && (
              <button
                className="preset-action-btn"
                type="button"
                onClick={onOpenRunBrowser}
                title="Browse buffered runs (valid windows, per-variable coverage)"
              >
                Browse runs…
              </button>
            )}
          </section>
        )}

        {/* ---- Layer list ---- */}
        <LayerList
          layers={layers}
          variables={variables}
          availableVariables={availableVariables}
          variablesByModel={variablesByModel}
          selectedModel={selectedModel}
          epsSibling={epsSibling}
          siblingVariables={siblingVariables}
          onSwitchModel={onModelChange}
          weatherStyle={weatherStyle}
          unitPrefs={unitPrefs}
          onLayerUpdate={onLayerUpdate}
          onLayerReorder={onLayerReorder}
          onRemoveLayer={onRemoveLayer}
        />

        {/* ---- Add layer ---- */}
        <AddLayerSection
          availableVariables={availableVariables}
          variables={variables}
          onAddLayer={onAddLayer}
        />

        {/* ---- Save current layers as preset ---- */}
        <section>
          <label>Layer preset</label>
          <button
            className="preset-action-btn"
            onClick={() => {
              setSavingPreset(true);
              setSavePresetLabel("");
              setSavePresetIcon("⭐");
            }}
            disabled={layers.length === 0 || savingPreset}
            title="Save the current layers as a custom preset"
          >
            Save current as preset…
          </button>
          {savingPreset && (
            <div className="preset-save-form">
              <input
                type="text"
                className="preset-save-name"
                placeholder="Preset name"
                value={savePresetLabel}
                onChange={(e) => setSavePresetLabel(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && savePresetLabel.trim()) {
                    onSaveUserPreset(savePresetLabel, savePresetIcon);
                    setSavingPreset(false);
                  } else if (e.key === "Escape") {
                    setSavingPreset(false);
                  }
                }}
              />
              <input
                type="text"
                className="preset-save-icon"
                value={savePresetIcon}
                maxLength={4}
                onChange={(e) => setSavePresetIcon(e.target.value)}
                title="Icon (emoji)"
              />
              <button
                className="preset-action-btn primary"
                disabled={!savePresetLabel.trim()}
                onClick={() => {
                  onSaveUserPreset(savePresetLabel, savePresetIcon);
                  setSavingPreset(false);
                }}
              >
                Save
              </button>
              <button
                className="preset-action-btn"
                onClick={() => setSavingPreset(false)}
              >
                Cancel
              </button>
            </div>
          )}
          {userPresets.length > 0 && !savingPreset && (
            <div className="preset-saved-summary">
              {userPresets.length} saved · use the icon bar to switch /
              hover an icon to delete
            </div>
          )}
        </section>

        {/* ---- Unit selector (for primary tile variable) ---- */}
        {primaryGroup && (
          <section>
            <label htmlFor="unit-select">Unit</label>
            <select
              id="unit-select"
              value={
                resolveActiveUnit(primaryBaseUnit, unitPrefs).option.id
              }
              onChange={(e) =>
                onUnitPrefChange(primaryGroup.id, e.target.value)
              }
            >
              {primaryGroup.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </section>
        )}

        {/* ---- Display & playback settings (set-once, collapsed) ---- */}
        <section>
          <button
            type="button"
            className="settings-toggle"
            onClick={() => setSettingsOpen((o) => !o)}
            aria-expanded={settingsOpen}
          >
            <span className="settings-toggle-caret" aria-hidden>
              {settingsOpen ? "▾" : "▸"}
            </span>
            Display &amp; playback
          </button>
        </section>
        {settingsOpen && (
        <>
        <section>
          <label htmlFor="basemap-select">Base map</label>
          <select
            id="basemap-select"
            value={baseMap}
            onChange={(e) => onBaseMapChange(e.target.value as BaseMapId)}
          >
            {Object.entries(BASE_MAPS).map(([id, { label }]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </section>

        <section>
          <label>View</label>
          <div className="toggle-row">
            <div className="toggle-group">
              <button
                className={`toggle-btn ${projection === "mercator" ? "active" : ""}`}
                onClick={() => onProjectionChange("mercator")}
              >
                Flat
              </button>
              <button
                className={`toggle-btn ${projection === "globe" ? "active" : ""}`}
                onClick={() => onProjectionChange("globe")}
              >
                Globe
              </button>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={terrain}
                onChange={(e) => onTerrainChange(e.target.checked)}
              />
              Terrain
            </label>
          </div>
        </section>

        <section>
          <label>Quality</label>
          <div className="toggle-group">
            <button
              className={`toggle-btn ${hdr ? "active" : ""}`}
              onClick={() => onHdrChange(true)}
              title="High resolution: 2× data per CSS pixel (~4× bandwidth)"
            >
              HDR
            </button>
            <button
              className={`toggle-btn ${!hdr ? "active" : ""}`}
              onClick={() => onHdrChange(false)}
              title="Standard resolution: lower bandwidth"
            >
              SDR
            </button>
          </div>
        </section>

        <section>
          <label>Time</label>
          <div className="toggle-group">
            <button
              className={`toggle-btn ${timeFormat === "utc" ? "active" : ""}`}
              onClick={() => onTimeFormatChange("utc")}
              disabled={leadLocked}
              title={leadLocked ? "Synthetic-time run: lead hours only" : undefined}
            >
              UTC
            </button>
            <button
              className={`toggle-btn ${timeFormat === "local" ? "active" : ""}`}
              onClick={() => onTimeFormatChange("local")}
              disabled={leadLocked}
              title={leadLocked ? "Synthetic-time run: lead hours only" : undefined}
            >
              Local
            </button>
            <button
              className={`toggle-btn ${timeFormat === "lead" ? "active" : ""}`}
              onClick={() => onTimeFormatChange("lead")}
              title="Lead hours since the run's reference time (+0h, +6h, …)"
            >
              Lead
            </button>
          </div>
        </section>

        <section>
          <label>Playback speed</label>
          <div className="toggle-group">
            {PLAYBACK_SPEED_PRESETS.map((p) => (
              <button
                key={p.ms}
                className={`toggle-btn ${playbackMsPerHour === p.ms ? "active" : ""}`}
                onClick={() => onPlaybackMsPerHourChange(p.ms)}
                title={`${p.ms} ms per forecast hour`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </section>
        </>
        )}

        {weatherStyle && (
          <section className="meta-info">
            <div className="meta-row">
              <span className="meta-label">Run</span>
              <span>{weatherStyle.metadata["weather-api:run"]}</span>
            </div>
          </section>
        )}

        <section className="controls-about">
          <a
            className="controls-github"
            href="https://github.com/pspoerri/grib-viewer"
            target="_blank"
            rel="noopener noreferrer"
          >
            GRIB-viewer on GitHub
          </a>
          <AppVersion />
        </section>

      </div>
    </>
  );
}

// Build version from /api/version (the backend stamps its VCS revision
// at build time). Fetched once per mount; empty while loading or when
// no backend is reachable.
function AppVersion() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/version", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { version?: string } | null) => {
        if (d?.version) setVersion(d.version);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);
  if (!version) return null;
  return <span className="controls-version">{version}</span>;
}

// ---------------------------------------------------------------------------
// Layer list sub-component
// ---------------------------------------------------------------------------

function LayerList({
  layers,
  variables,
  availableVariables,
  variablesByModel,
  selectedModel,
  epsSibling,
  siblingVariables,
  onSwitchModel,
  weatherStyle,
  unitPrefs,
  onLayerUpdate,
  onLayerReorder,
  onRemoveLayer,
}: {
  layers: MapLayer[];
  variables: Variable[];
  availableVariables: AvailableVariable[];
  variablesByModel?: Map<string, AvailableVariable[]>;
  selectedModel: string;
  epsSibling?: string;
  siblingVariables: AvailableVariable[];
  onSwitchModel: (model: string) => void;
  weatherStyle: WeatherStyle | null;
  unitPrefs: Record<string, string>;
  onLayerUpdate: (id: string, patch: Partial<MapLayer>) => void;
  onLayerReorder: (order: string[]) => void;
  onRemoveLayer: (id: string) => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  // Per-layer-model catalogs for the DET|EPS + product control. Mirrors
  // MapLegend: on a composite `variablesByModel` carries both `auto` (det
  // side) and `auto_eps` (eps side); on a physical model both sides resolve
  // to `selectedModel`'s own catalog. Fall back to `availableVariables`
  // (the active model's catalog) so a physical-model row — or an older
  // wiring with no `variablesByModel` — doesn't break.
  const composite = isCompositeModel(selectedModel);
  const fallbackCatalog = useMemo(
    () =>
      new Map(
        (Array.isArray(availableVariables) ? availableVariables : []).map(
          (v) => [v.name, v],
        ),
      ),
    [availableVariables],
  );
  const detCatalog = useMemo(() => {
    const key = composite ? AUTO_MODEL_ID : selectedModel;
    const list = variablesByModel?.get(key);
    if (composite) return new Map((list ?? []).map((v) => [v.name, v]));
    if (list && list.length > 0) return new Map(list.map((v) => [v.name, v]));
    return fallbackCatalog;
  }, [variablesByModel, composite, selectedModel, fallbackCatalog]);
  const epsCatalog = useMemo(() => {
    const key = composite ? AUTO_EPS_MODEL_ID : selectedModel;
    const list = variablesByModel?.get(key);
    if (composite) return new Map((list ?? []).map((v) => [v.name, v]));
    if (list && list.length > 0) return new Map(list.map((v) => [v.name, v]));
    return fallbackCatalog;
  }, [variablesByModel, composite, selectedModel, fallbackCatalog]);

  // Per-layer picker gate, keyed by layer id. Null when a layer has no
  // DET|EPS / product options at all (the row renders exactly as today).
  const gatesByLayerId = useMemo(() => {
    const m = new Map<string, LayerGate | null>();
    for (const layer of layers) {
      if (!layer.visible) continue;
      m.set(
        layer.id,
        gateOptions(layer, detCatalog, epsCatalog, selectedModel),
      );
    }
    return m;
  }, [layers, detCatalog, epsCatalog, selectedModel]);

  // Catalogs can invalidate a product stored in an old URL (for example DWD
  // ICON-EPS `_ctrl`, whose members are 1..40 with no member 0). Normalize it
  // once catalogs arrive so the layer renders instead of repeatedly 404ing.
  useEffect(() => {
    for (const layer of layers) {
      if (!layer.visible) continue;
      const gate = gatesByLayerId.get(layer.id);
      if (!gate) continue;
      const patch = unavailableProductPatch(layer, selectedModel, gate);
      if (patch) onLayerUpdate(layer.id, patch);
    }
  }, [layers, gatesByLayerId, selectedModel, onLayerUpdate]);

  if (layers.length === 0) {
    return (
      <section>
        <label>
          Layers <span className="text-muted">(none)</span>
        </label>
      </section>
    );
  }

  return (
    <section>
      <label>
        Layers <span className="text-muted">(drag to reorder)</span>
      </label>
      {layers.map((layer, idx) => {
        const modes = modesForVariable(layer.variable);
        // The layer variable is the authoritative archive id (`t_2m`,
        // `wind_speed_10m`) used for metadata lookups (units,
        // long_name, legend).
        const effectiveVar = layer.variable;
        // A `_p{N}` / `_ctrl` / `_m{N}` suffix is only treated as an
        // ensemble plane when the base variable actually advertises
        // the matching axis in the catalog, so threshold-probability
        // names (prob_prec_gt0p1, ...) and any future id with a
        // literal suffix keep working as plain variables. Here the
        // split just routes metadata lookups to the base variable.
        const { base: pctBase } = splitEnsembleVar(effectiveVar);
        const baseInfo =
          (Array.isArray(availableVariables)
            ? availableVariables.find((v) => v.name === pctBase)
            : undefined) ?? variables.find((v) => v.name === pctBase);
        const pctList = baseInfo?.percentiles;
        const hasPercentiles = Array.isArray(pctList) && pctList.length > 0;
        // Metadata (units, long_name, default colormap) lives on the
        // base variable; percentile planes share it.
        const varInfo =
          variables.find((v) => v.name === effectiveVar) ??
          (hasPercentiles
            ? variables.find((v) => v.name === pctBase)
            : undefined);

        // Show inline legend for visible tile layers
        const isTile = layer.displayMode === "tiles" && layer.visible;
        const styleVar = weatherStyle?.metadata["weather-api:variable"];
        const styleMatches = isTile && styleVar === effectiveVar;
        const defaultColormap = styleMatches
          ? weatherStyle?.metadata["weather-api:colormap"]
          : varInfo?.default_colormap;
        // Per-layer override (when set via the colormap dropdown) wins
        // over the variable's default. Falls through to undefined when
        // neither is available yet — callers skip the legend image.
        const colormap = layer.colormap ?? defaultColormap;
        const vmin = styleMatches ? weatherStyle?.metadata["weather-api:vmin"] : undefined;
        const vmax = styleMatches ? weatherStyle?.metadata["weather-api:vmax"] : undefined;
        const baseUnit = styleMatches
          ? weatherStyle?.metadata["weather-api:units"]
          : varInfo?.units;
        const au = baseUnit ? resolveActiveUnit(baseUnit, unitPrefs) : null;

        return (
          <div
            key={layer.id}
            className={`layer-control ${dragIdx === idx ? "dragging" : ""}`}
            draggable
            onDragStart={() => setDragIdx(idx)}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragIdx == null || dragIdx === idx) return;
              const ids = layers.map((l) => l.id);
              const [moved] = ids.splice(dragIdx, 1);
              ids.splice(idx, 0, moved);
              onLayerReorder(ids);
              setDragIdx(idx);
            }}
            onDragEnd={() => setDragIdx(null)}
          >
            <div className="layer-header">
              <span className="drag-handle">&#x2630;</span>
              <label
                className="checkbox-label layer-name-label"
                title={
                  varInfo?.long_name
                    ? `${effectiveVar} — ${varInfo.long_name}`
                    : effectiveVar
                }
              >
                <input
                  type="checkbox"
                  checked={layer.visible}
                  onChange={(e) =>
                    onLayerUpdate(layer.id, { visible: e.target.checked })
                  }
                />
                <span className="layer-label-stack">
                  <span className="layer-label-short">{effectiveVar}</span>
                  {varInfo?.long_name && varInfo.long_name !== effectiveVar && (
                    <span className="layer-label-long">{varInfo.long_name}</span>
                  )}
                </span>
              </label>
              {modes.length > 1 && (
                <div className="layer-mode-group">
                  {modes.map((m) => (
                    <button
                      key={m}
                      className={`layer-mode-btn ${layer.displayMode === m ? "active" : ""}`}
                      title={MODE_TITLES[m]}
                      onClick={() => onLayerUpdate(layer.id, { displayMode: m })}
                    >
                      {MODE_LABELS[m]}
                    </button>
                  ))}
                </div>
              )}
              <button
                className="layer-remove-btn"
                title="Remove layer"
                onClick={() => onRemoveLayer(layer.id)}
              >
                &times;
              </button>
            </div>

            {layer.visible && (
              <>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(layer.opacity * 100)}
                  onChange={(e) =>
                    onLayerUpdate(layer.id, {
                      opacity: +e.target.value / 100,
                    })
                  }
                />

                {/* Per-layer DET|EPS + ensemble-product control. Mirrors the
                 *  legend's per-row picker (shared pure logic in
                 *  layerProductGate). Composite-ONLY: on a physical model the
                 *  layer builder keeps exactly today's controls (Probability
                 *  dropdown + ThresholdSlider) — the DET|EPS mode split is a
                 *  composite concept. gateOptions additionally returns null
                 *  for a composite layer with no ensemble options, so nothing
                 *  new renders there either. Hidden on the vector modes
                 *  (barbs / flow) — ensemble planes are scalar. */}
                {composite &&
                  layer.displayMode !== "barbs" &&
                  layer.displayMode !== "flow" &&
                  (() => {
                    const gate = gatesByLayerId.get(layer.id) ?? null;
                    if (!gate) return null;
                    return (
                      <LayerEnsembleControl
                        layer={layer}
                        gate={gate}
                        selectedModel={selectedModel}
                        unitPrefs={unitPrefs}
                        onLayerUpdate={onLayerUpdate}
                      />
                    );
                  })()}

                {/* Exceedance-probability variant. The PROB_VARIANTS dropdown
                 *  lists canned precomputed prob_* siblings (t_2m → frost /
                 *  ≥25 °C / ≥30 °C, gusts → Beaufort ladder, ...) and keeps
                 *  EPS-sibling routing: picking one rewrites layer.variable
                 *  to the canned id; on a deterministic model the variants
                 *  come from the paired EPS sibling and a pick also switches
                 *  the model. A synthetic "custom threshold" option appears
                 *  only while a dynamic id is active (the slider owns the id).
                 *  "Off" restores the preferred display base.
                 *  The ThresholdSlider renders whenever the base is
                 *  dist-capable — including bases with no canned variants
                 *  (td_2m, pmsl, wind_10m) — and before any threshold is
                 *  committed it just previews at mid-range.
                 *  Hidden on vector modes (barbs / flow) —
                 *  probabilities are scalar 0–100 % planes. */}
                {layer.displayMode !== "barbs" &&
                  layer.displayMode !== "flow" &&
                  (() => {
                    const thr = parseThresholdId(layer.variable);
                    const probBase =
                      probVariantBase(layer.variable) ??
                      (thr
                        ? (DIST_DISPLAY_BASE[thr.base] ?? thr.base)
                        : pctBase);
                    const availOn = (
                      list: AvailableVariable[],
                      id: string,
                    ) =>
                      Array.isArray(list) &&
                      list.some((av) => av.name === id && av.available);
                    const variants = (PROB_VARIANTS[probBase] ?? []).flatMap(
                      (pv) => {
                        if (availOn(availableVariables, pv.id)) {
                          return [{ ...pv, viaSibling: false }];
                        }
                        if (epsSibling && availOn(siblingVariables, pv.id)) {
                          return [{ ...pv, viaSibling: true }];
                        }
                        return [];
                      },
                    );
                    // Request-time threshold capability: the dropdown
                    // base maps onto a dist archive base; the active
                    // model's advertisement wins, the EPS sibling's is
                    // the fallback (committing a threshold then also
                    // switches the model, like the canned variants).
                    const distBase = DIST_BASES[probBase];
                    // `distOn` does not check `av.available` because a
                    // `dist` advertisement already implies the archive
                    // exists on disk — the capability is only emitted
                    // for on-disk `{base}_dist.wxt` files.
                    const distOn = (
                      list: AvailableVariable[],
                    ): DistCapability | undefined =>
                      Array.isArray(list)
                        ? list.find((av) => av.name === distBase && av.dist)
                            ?.dist
                        : undefined;
                    const ownDist = distBase
                      ? distOn(availableVariables)
                      : undefined;
                    const sibDist =
                      distBase && !ownDist && epsSibling
                        ? distOn(siblingVariables)
                        : undefined;
                    const dist = ownDist ?? sibDist;
                    if (variants.length === 0 && !dist) return null;
                    const isCanned = !!probVariantBase(layer.variable);
                    const isDynamic =
                      !isCanned && !!thr && thr.base === distBase;
                    const active = isCanned
                      ? layer.variable
                      : isDynamic
                        ? CUSTOM_THRESHOLD
                        : "";
                    const siblingName = epsSibling
                      ? modelInfoFor(epsSibling).name
                      : "";
                    return (
                      <>
                        <div className="layer-sub-control">
                          <span className="layer-sub-label">Probability</span>
                          <select
                            className="layer-level-select"
                            value={active}
                            title={
                              "Show the ensemble probability of exceeding " +
                              "a threshold instead of the forecast value"
                            }
                            onChange={(e) => {
                              const id = e.target.value;
                              if (id === CUSTOM_THRESHOLD) return;
                              if (!id) {
                                onLayerUpdate(layer.id, {
                                  variable: probBase,
                                });
                                return;
                              }
                              onLayerUpdate(layer.id, { variable: id });
                              const picked = variants.find(
                                (v) => v.id === id,
                              );
                              if (picked?.viaSibling && epsSibling) {
                                onSwitchModel(epsSibling);
                              }
                            }}
                          >
                            <option value="">off — forecast value</option>
                            {isDynamic && (
                              <option value={CUSTOM_THRESHOLD}>
                                custom threshold
                              </option>
                            )}
                            {variants.map((pv) => (
                              <option key={pv.id} value={pv.id}>
                                {pv.label}
                                {pv.viaSibling ? ` — via ${siblingName}` : ""}
                              </option>
                            ))}
                          </select>
                        </div>
                        {dist && distBase && (
                          <ThresholdSlider
                            layer={layer}
                            distBase={distBase}
                            dist={dist}
                            viaSibling={!ownDist}
                            siblingModel={epsSibling}
                            unitPrefs={unitPrefs}
                            onLayerUpdate={onLayerUpdate}
                            onSwitchModel={onSwitchModel}
                          />
                        )}
                      </>
                    );
                  })()}

                {/* Contour-specific controls */}
                {layer.displayMode === "contour" && (
                  <>
                    <div className="layer-sub-control">
                      <span className="layer-sub-label">
                        Stroke {(layer.contourWidth ?? 1).toFixed(0)}
                      </span>
                      <input
                        type="range"
                        min={1}
                        max={20}
                        step={1}
                        value={layer.contourWidth ?? 1}
                        onChange={(e) =>
                          onLayerUpdate(layer.id, {
                            contourWidth: +e.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="layer-sub-control">
                      <span className="layer-sub-label">Interval</span>
                      <input
                        type="number"
                        className="layer-sub-input"
                        value={layer.contourInterval ?? ""}
                        placeholder={(() => {
                          if (!Array.isArray(availableVariables)) return "auto";
                          const dflt = (
                            availableVariables.find(
                              (v) => v.name === layer.variable,
                            ) ??
                            availableVariables.find((v) => v.name === pctBase)
                          )?.default_contour_interval;
                          return dflt != null ? String(dflt) : "auto";
                        })()}
                        onChange={(e) =>
                          onLayerUpdate(layer.id, {
                            contourInterval: e.target.value
                              ? +e.target.value
                              : undefined,
                          })
                        }
                      />
                    </div>
                    <div className="layer-sub-control">
                      <span className="layer-sub-label">Color</span>
                      <input
                        type="color"
                        className="layer-color-input"
                        value={layer.contourColor ?? "#ffffff"}
                        onChange={(e) =>
                          onLayerUpdate(layer.id, {
                            contourColor: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="layer-sub-control">
                      <span className="layer-sub-label">
                        Resolution {(layer.gridResolution ?? 0.5).toFixed(1)}x
                      </span>
                      <input
                        type="range"
                        min={1}
                        max={20}
                        step={1}
                        value={Math.round((layer.gridResolution ?? 0.5) * 10)}
                        onChange={(e) =>
                          onLayerUpdate(layer.id, {
                            gridResolution: +e.target.value / 10,
                          })
                        }
                      />
                    </div>
                  </>
                )}

                {/* Barbs-specific controls */}
                {layer.displayMode === "barbs" && (
                  <>
                    <div className="layer-sub-control">
                      <span className="layer-sub-label">
                        Scale {(layer.iconScale ?? 1.0).toFixed(1)}
                      </span>
                      <input
                        type="range"
                        min={3}
                        max={30}
                        step={1}
                        value={Math.round((layer.iconScale ?? 1.0) * 10)}
                        onChange={(e) =>
                          onLayerUpdate(layer.id, {
                            iconScale: +e.target.value / 10,
                          })
                        }
                      />
                    </div>
                    <div className="layer-sub-control">
                      <span className="layer-sub-label">
                        Spacing {layer.gridSpacing ?? 20} px
                      </span>
                      <input
                        type="range"
                        min={5}
                        max={200}
                        step={5}
                        value={layer.gridSpacing ?? 20}
                        onChange={(e) =>
                          onLayerUpdate(layer.id, {
                            gridSpacing: +e.target.value,
                          })
                        }
                      />
                    </div>
                  </>
                )}

                {/* Value-specific controls */}
                {layer.displayMode === "value" && (
                  <div className="layer-sub-control">
                    <span className="layer-sub-label">
                      Spacing {layer.gridSpacing ?? 20} px
                    </span>
                    <input
                      type="range"
                      min={5}
                      max={200}
                      step={5}
                      value={layer.gridSpacing ?? 20}
                      onChange={(e) =>
                        onLayerUpdate(layer.id, {
                          gridSpacing: +e.target.value,
                        })
                      }
                    />
                  </div>
                )}

                {/* Flow-specific controls */}
                {layer.displayMode === "flow" && (
                  <>
                    <div className="layer-sub-control">
                      <span className="layer-sub-label">
                        Density {layer.flowParticles ?? 8000}
                      </span>
                      <input
                        type="range"
                        min={500}
                        max={16000}
                        step={500}
                        value={layer.flowParticles ?? 8000}
                        onChange={(e) =>
                          onLayerUpdate(layer.id, {
                            flowParticles: +e.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="layer-sub-control">
                      <span className="layer-sub-label">
                        Speed {(layer.flowSpeed ?? 1.0).toFixed(1)}
                      </span>
                      <input
                        type="range"
                        min={2}
                        max={30}
                        step={1}
                        value={Math.round((layer.flowSpeed ?? 1.0) * 10)}
                        onChange={(e) =>
                          onLayerUpdate(layer.id, {
                            flowSpeed: +e.target.value / 10,
                          })
                        }
                      />
                    </div>
                    <div className="layer-sub-control">
                      <span className="layer-sub-label">
                        Trail {(layer.flowWidth ?? 1.5).toFixed(1)}
                      </span>
                      <input
                        type="range"
                        min={5}
                        max={40}
                        step={1}
                        value={Math.round((layer.flowWidth ?? 1.5) * 10)}
                        onChange={(e) =>
                          onLayerUpdate(layer.id, {
                            flowWidth: +e.target.value / 10,
                          })
                        }
                      />
                    </div>
                    <div className="layer-sub-control">
                      <span className="layer-sub-label">
                        Resolution {(layer.gridResolution ?? 0.5).toFixed(1)}x
                      </span>
                      <input
                        type="range"
                        min={3}
                        max={40}
                        step={1}
                        value={Math.round((layer.gridResolution ?? 0.5) * 10)}
                        onChange={(e) =>
                          onLayerUpdate(layer.id, {
                            gridResolution: +e.target.value / 10,
                          })
                        }
                      />
                    </div>
                    <div className="layer-sub-control">
                      <span className="layer-sub-label">Color</span>
                      <input
                        type="color"
                        className="layer-color-input"
                        value={flowColorToHex(layer.flowColor ?? "rgba(255,255,255,1)")}
                        onChange={(e) =>
                          onLayerUpdate(layer.id, {
                            flowColor: hexToRgba(e.target.value),
                          })
                        }
                      />
                    </div>
                  </>
                )}

                {/* Colormap picker for tile layers. Selecting a name
                 *  rewrites the tile URL with ?cmap=<name> (see
                 *  WeatherMap.deriveLayerStyle) and swaps the legend
                 *  gradient. Blank = use the variable's default. */}
                {isTile && (() => {
                  const names = listColormapNames();
                  if (names.length === 0) return null;
                  return (
                    <div className="layer-sub-control">
                      <span className="layer-sub-label">Legend</span>
                      <select
                        className="layer-level-select"
                        value={layer.colormap ?? ""}
                        onChange={(e) =>
                          onLayerUpdate(layer.id, {
                            colormap: e.target.value || undefined,
                          })
                        }
                      >
                        <option value="">
                          {defaultColormap
                            ? `Default (${defaultColormap})`
                            : "Default"}
                        </option>
                        {names.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })()}

                {/* Interpolation mode for tile/drape layers: how the native
                 *  grid is resampled to screen. Nearest is the native-grid
                 *  default; bilinear/bicubic smooth the field (bicubic reuses
                 *  the contour B-spline kernel). */}
                {isTile && (
                  <div className="layer-sub-control">
                    <span className="layer-sub-label">Interpolation</span>
                    <select
                      className="layer-level-select"
                      value={layer.interp ?? 0}
                      onChange={(e) =>
                        onLayerUpdate(layer.id, {
                          interp: +e.target.value || undefined,
                        })
                      }
                    >
                      <option value={0}>Nearest</option>
                      <option value={1}>Bilinear</option>
                      <option value={2}>Bicubic</option>
                    </select>
                  </div>
                )}

                {/* Stepped/smooth toggle for tile layers. Only useful
                 *  for temperature variables — the canonical 1°/2°/5°
                 *  band rule lives in K-space, so for non-Kelvin units
                 *  the toggle would be a no-op and we just hide it. */}
                {isTile && baseUnit && (baseUnit.toLowerCase() === "k" ||
                  baseUnit.toLowerCase() === "kelvin") && (() => {
                  const stepped = layer.stepped ?? true;
                  return (
                    <div className="layer-sub-control">
                      <span className="layer-sub-label">Stepped</span>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={stepped}
                          onChange={(e) =>
                            onLayerUpdate(layer.id, {
                              stepped: e.target.checked,
                            })
                          }
                        />
                        <span>{stepped ? "1° / 2° / 5° bands" : "smooth"}</span>
                      </label>
                    </div>
                  );
                })()}

                {/* Inline legend for tile layers. The legend.png URL
                 *  carries the same stepped/cmap/vmin/vmax flags as
                 *  the tile URLs, so the bar visually matches the
                 *  pixels on the map even when the user has toggled
                 *  stepping off on a smooth palette. */}
                {isTile && colormap && (
                  <div className="layer-legend">
                    <img
                      className="colormap-bar"
                      src={colormapLegendURL(
                        colormap,
                        200,
                        12,
                        layerLegendOpts(layer, baseUnit, vmin, vmax),
                      )}
                      alt={colormap}
                    />
                    {vmin != null && vmax != null && au && (
                      <div className="colormap-labels">
                        <span>
                          {au.option.convert(vmin).toFixed(1)}{" "}
                          {au.option.label}
                        </span>
                        <span>
                          {au.option.convert(vmax).toFixed(1)}{" "}
                          {au.option.label}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Per-layer DET|EPS + ensemble-product control (layer builder)
// ---------------------------------------------------------------------------

/** Inert dist used to keep useThreshold's hooks unconditional when the
 *  layer's base has no dist archive (spread-only var). The Chance-of
 *  segment is hidden in that case (segmentEnabled gates it on
 *  caps.chance_of, which implies a dist archive), so chance mode is
 *  unreachable and these values are never surfaced. Mirrors the legend.
 *  `INERT_DIST` is the shared placeholder from api/v2catalog. */

/** Compact per-layer ensemble-product picker for the Controls layer
 *  builder, driven entirely by the shared pure gating logic
 *  (layerProductGate) so its behaviour matches the legend's picker
 *  exactly. Renders the enabled segments (Det · Med · Mean · p90 · Chance,
 *  with the less-common p10 / Control / p25 / p75 / Min / Max / Spread
 *  behind a ⋯ overflow), highlighting the active one via effectiveLayerMode
 *  + currentProduct. Selecting a segment rewrites ONLY this layer via
 *  productPatch (no global composite flip); `chance` routes the layer to
 *  EPS and commits a threshold id through the same useThreshold path the
 *  legend uses (the Probability ThresholdSlider below then edits the
 *  threshold value — both hook instances re-sync via layer.variable). */
function LayerEnsembleControl({
  layer,
  gate,
  selectedModel,
  unitPrefs,
  onLayerUpdate,
}: {
  layer: MapLayer;
  gate: LayerGate;
  selectedModel: string;
  unitPrefs: Record<string, string>;
  onLayerUpdate: (id: string, patch: Partial<MapLayer>) => void;
}) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const thr = useThreshold({
    layer,
    distBase: gate.distBase,
    dist: gate.dist ?? INERT_DIST,
    unitPrefs,
    onLayerUpdate,
  });

  // Active segment: deterministic mode ⇒ the Det segment; otherwise the
  // active EPS product read off the id (currentProduct returns "chance"
  // exactly when parseThresholdId matches, in lockstep with useThreshold).
  const detMode = effectiveLayerMode(layer, selectedModel) === "det";
  const active: PickerProduct = detMode ? "det" : currentProduct(layer.variable);

  const select = (product: PickerProduct) => {
    setOverflowOpen(false);
    if (product === "chance") {
      // Route to EPS (productPatch sets only ensembleMode), then commit the
      // threshold id via the shared marker path (remembered / curated /
      // mid-domain) so the layer ends with both ensembleMode:"eps" AND a
      // threshold id. The ThresholdSlider below edits the value afterwards.
      onLayerUpdate(layer.id, productPatch(layer, "chance", gate));
      thr.commit();
      return;
    }
    onLayerUpdate(layer.id, productPatch(layer, product, gate));
  };

  const inline = PICKER_SEGMENTS.filter(
    (s) => !s.overflow && segmentEnabled(s.product, gate),
  );
  const overflow = PICKER_SEGMENTS.filter(
    (s) => s.overflow && segmentEnabled(s.product, gate),
  );

  return (
    <div className="layer-sub-control layer-ens-control">
      <span className="layer-sub-label">Ensemble</span>
      <div className="layer-ens-segs">
        <div className="layer-mode-group" role="group" aria-label="Ensemble product">
          {inline.map((s) => (
            <button
              key={s.product}
              type="button"
              className={`layer-mode-btn ${active === s.product ? "active" : ""}`}
              aria-pressed={active === s.product}
              onClick={() => select(s.product)}
            >
              {s.label}
            </button>
          ))}
          {overflow.length > 0 && (
            <button
              type="button"
              className={`layer-mode-btn ${overflowOpen ? "active" : ""}`}
              aria-pressed={overflowOpen}
              aria-label="More ensemble products"
              title="More ensemble products"
              onClick={() => setOverflowOpen((o) => !o)}
            >
              ⋯
            </button>
          )}
        </div>
        {overflowOpen && overflow.length > 0 && (
          <div
            className="layer-mode-group layer-ens-overflow"
            role="group"
            aria-label="More ensemble products"
          >
            {overflow.map((s) => (
              <button
                key={s.product}
                type="button"
                className={`layer-mode-btn ${active === s.product ? "active" : ""}`}
                aria-pressed={active === s.product}
                onClick={() => select(s.product)}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Request-time threshold slider
// ---------------------------------------------------------------------------

/** Live exceedance-threshold control for dist-capable bases —
 *  secondary surface (the legend marker is the primary one). All
 *  state, domain math, and the debounced id rewrite live in the
 *  shared useThreshold hook; this component keeps only the slider UI. */
function ThresholdSlider({
  layer,
  distBase,
  dist,
  viaSibling,
  siblingModel,
  unitPrefs,
  onLayerUpdate,
  onSwitchModel,
}: {
  layer: MapLayer;
  distBase: string;
  dist: DistCapability;
  viaSibling: boolean;
  siblingModel?: string;
  unitPrefs: Record<string, string>;
  onLayerUpdate: (id: string, patch: Partial<MapLayer>) => void;
  onSwitchModel: (model: string) => void;
}) {
  const thr = useThreshold({
    layer,
    distBase,
    dist,
    unitPrefs,
    onLayerUpdate,
    viaSibling,
    siblingModel,
    onSwitchModel,
  });
  return (
    <div className="layer-sub-control">
      <button
        type="button"
        className="layer-mode-btn"
        title={
          thr.dir === "gt"
            ? "Probability of exceeding the threshold — click for ≤"
            : "Probability of staying at or below the threshold — click for ≥"
        }
        onClick={() => thr.setDir(thr.dir === "gt" ? "lt" : "gt")}
      >
        {thr.dir === "gt" ? "≥" : "≤"}
      </button>
      <input
        type="range"
        min={thr.lo}
        max={thr.hi}
        step={thr.step}
        value={thr.value}
        title="Sweep the exceedance threshold — the map updates live"
        onChange={(e) => thr.setValue(+e.target.value)}
      />
      <span className="layer-sub-label threshold-label">
        {thr.active ? "" : "preview: "}P({DIST_LABELS[distBase] ?? distBase}{" "}
        {thr.dir === "gt" ? ">" : "≤"} {thr.value.toFixed(thr.decimals)}{" "}
        {thr.au.option.label})
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add layer sub-component
// ---------------------------------------------------------------------------

/** Variable picker used by the AddLayerSection. Prefers the richer
 *  /variables endpoint data (grouped by Name, with derived-variable
 *  entries) and falls back to the /models listing when /variables
 *  hasn't loaded yet — e.g. the first render after switching models.
 *  Both shapes are normalised to VariableOption so the dropdown logic
 *  is uniform. */
interface VariableOption {
  name: string;
  long_name?: string;
  group?: string;
  group_label?: string;
  derived?: boolean;
}

function buildVariableOptions(
  availableVariables: AvailableVariable[],
  fallback: { name: string; long_name?: string }[],
): VariableOption[] {
  if (Array.isArray(availableVariables) && availableVariables.length > 0) {
    // Only show variables that are actually renderable right now so
    // users don't pick something that'll 404. `tot_prec` (since run
    // start) is hidden — precip_1h is the per-window precip display base
    // (createLayer canonicalises tot_prec → precip_1h anyway).
    return availableVariables
      .filter(
        (v) => (v.available_levels ?? []).length > 0 && v.name !== "tot_prec",
      )
      .map((v) => ({
        name: v.name,
        long_name: v.long_name,
        group: v.group,
        group_label: v.group_label,
        derived: v.derived,
      }));
  }
  // Fallback: /models listing.
  return fallback
    .filter((v) => v.name !== "tot_prec")
    .map((v) => ({
      name: v.name,
      long_name: v.long_name,
    }));
}

function AddLayerSection({
  availableVariables,
  variables,
  onAddLayer,
}: {
  availableVariables: AvailableVariable[];
  variables: { name: string; long_name?: string; levels?: number[] }[];
  onAddLayer: (variable: string, mode: DisplayMode) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedVar, setSelectedVar] = useState("");
  const [selectedMode, setSelectedMode] = useState<DisplayMode>("tiles");

  const options = buildVariableOptions(availableVariables, variables);

  // Group options by group_label for the <optgroup>s — keeps
  // Temperature, Wind, ... clustered in the picker.
  const grouped = new Map<string, VariableOption[]>();
  for (const o of options) {
    const key = o.group_label ?? "Variables";
    const arr = grouped.get(key);
    if (arr) arr.push(o);
    else grouped.set(key, [o]);
  }
  const groupOrder = Array.from(grouped.keys());

  const reset = () => {
    setExpanded(false);
    setSelectedVar("");
    setSelectedMode("tiles");
  };

  if (!expanded) {
    return (
      <section>
        <button
          className="add-layer-btn"
          onClick={() => {
            setExpanded(true);
            if (!selectedVar && options.length > 0) {
              setSelectedVar(options[0].name);
            }
          }}
        >
          + Add layer
        </button>
      </section>
    );
  }

  const modes = selectedVar ? modesForVariable(selectedVar) : ALL_MODES;

  return (
    <section className="add-layer-section">
      <label>Add layer</label>
      <select
        value={selectedVar}
        onChange={(e) => {
          const name = e.target.value;
          setSelectedVar(name);
          // Reset mode if not available for new variable.
          const newModes = modesForVariable(name);
          if (!newModes.includes(selectedMode)) {
            setSelectedMode(newModes[0]);
          }
        }}
      >
        <option value="" disabled>
          Select variable...
        </option>
        {groupOrder.length > 1
          ? groupOrder.map((label) => (
              <optgroup key={label} label={label}>
                {grouped.get(label)!.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name}
                    {v.long_name ? ` — ${v.long_name}` : ""}
                    {v.derived ? " (derived)" : ""}
                  </option>
                ))}
              </optgroup>
            ))
          : options.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
                {v.long_name ? ` — ${v.long_name}` : ""}
                {v.derived ? " (derived)" : ""}
              </option>
            ))}
      </select>

      <div className="add-layer-mode-row">
        <span className="layer-sub-label">Display as</span>
        <div className="toggle-group">
          {modes.map((m) => (
            <button
              key={m}
              className={`toggle-btn ${selectedMode === m ? "active" : ""}`}
              onClick={() => setSelectedMode(m)}
              title={MODE_TITLES[m]}
            >
              {MODE_TITLES[m]}
            </button>
          ))}
        </div>
      </div>
      <div className="add-layer-row">
        <button className="add-layer-cancel-btn" onClick={reset}>
          Cancel
        </button>
        <button
          className="add-layer-confirm-btn"
          disabled={!selectedVar}
          onClick={() => {
            if (!selectedVar) return;
            onAddLayer(selectedVar, selectedMode);
            reset();
          }}
        >
          Add layer
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flowColorToHex(rgba: string): string {
  const m = rgba.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return "#ffffff";
  const r = parseInt(m[1], 10).toString(16).padStart(2, "0");
  const g = parseInt(m[2], 10).toString(16).padStart(2, "0");
  const b = parseInt(m[3], 10).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}

function hexToRgba(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},1)`;
}
