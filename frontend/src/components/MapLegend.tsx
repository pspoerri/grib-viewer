import { useState, useMemo, useRef } from "react";
import type { WeatherStyle } from "../api/types";
import { splitEnsembleVar, AUTO_MODEL_ID, AUTO_EPS_MODEL_ID, isCompositeModel } from "../api/types";
import type { MapLayer } from "../api/mapConfig";
import {
  DIST_LABELS,
  aggCapsFor,
  showLapseToggle,
} from "../api/mapConfig";
import type { AggOp } from "../api/types";
import type { WindowMode } from "../time";
import { colormapLegendURL } from "../lib/wxColormap2";
import { INERT_DIST } from "../api/v2catalog";
import type {
  AvailableVariable,
  VariableMeta,
} from "../api/v2catalog";
import {
  effectiveStepped,
  isLogColormap,
  isTemperatureUnits,
  logColorValue,
} from "../lib/colormap";
import { useThreshold } from "../lib/useThreshold";
import { currentProduct } from "../api/products";
import { precipTotalTitle } from "../api/varDisplay";
import {
  gateOptions,
  productPatch,
  effectiveLayerMode,
  masterIndicatorEps,
  PICKER_SEGMENTS,
  segmentEnabled,
} from "../lib/layerProductGate";
import type { LayerGate, PickerProduct } from "../lib/layerProductGate";
import { resolveActiveUnit, unitGroupForBase } from "../units";

interface Props {
  layers: MapLayer[];
  weatherStyle: WeatherStyle | null;
  selectedModel: string;
  selectedRun?: string;
  unitPrefs: Record<string, string>;
  /** Active window-mode (hourly / 3h / 6h / 12h / daily). When ≠ "hourly"
   *  the threshold legend exposes a per-layer Max/Min operator (or a precip
   *  "Total" indicator); the operator reduces the windowed planes. */
  windowMode?: WindowMode;
  /** Change the aggregation window. The selector lives at the top of the
   *  legend box; absent in contexts that don't drive playback. */
  onWindowModeChange?: (mode: WindowMode) => void;
  /** Persist a new unit choice for a unit group (e.g. temperature →
   *  fahrenheit). Wired to the App-level unitPrefs that lives in
   *  localStorage, so the choice survives reloads as a per-type
   *  default. */
  onUnitPrefChange?: (groupId: string, optionId: string) => void;
  /** Rewrite a layer (by id) — the legend's threshold marker commits
   *  dynamic exceedance ids through the same App-level handler as the
   *  Controls panel, so hash/presets/Controls stay consistent. */
  onLayerUpdate?: (id: string, patch: Partial<MapLayer>) => void;
  /** True when the shared z_site DEM the GPU drape's lapse correction reads
   *  has resolved available this session (WxLayerManager's onDemAvailability
   *  callback, surfaced via App state). Gates the header 🏔️ toggle —
   *  hidden entirely once the DEM endpoint 404s. */
  lapseAvailable?: boolean;
  /** Variables of the model EPS interactions land on (auto_eps when on
   *  a composite) — fallback EPS catalog when `variablesByModel` has no
   *  auto_eps entry (e.g. a physical EPS model). */
  epsTargetVariables?: AvailableVariable[];
  /** Per-model variable catalog covering every model a layer can route to
   *  (modelsInUse(selectedModel): both composite flavors on a composite,
   *  else just the model). Gates each row's product picker against its own
   *  per-layer model catalog (det side ← `auto`, eps side ← `auto_eps`). */
  variablesByModel?: Map<string, AvailableVariable[]>;
  /** Det/EPS state of the active composite: false = Deterministic (auto),
   *  true = EPS (auto_eps), undefined = not a composite (master switch
   *  hidden). Drives the header DET|EPS segmented control's active side. */
  compositeEps?: boolean;
  /** Master DET|EPS switch handler: flips the composite default AND
   *  bulk-applies the mode to every visible tile layer (Decision 4).
   *  Composite-only. */
  onMasterMode?: (mode: "det" | "eps") => void;
}

/** Window-length (N) selector, in display order. This is the N axis of
 *  the `{base}__{N}h_{op}` grammar: "1h" is the native / no-window-mod
 *  path (the bare id, per-frame animation); 3h/6h/12h are trailing
 *  N-hour windows; "Daily" is N=24 with the time anchor snapped to local
 *  midnight (bucketTimesteps floors daily buckets to midnight) so the
 *  blocks align to calendar days. The op (max/min/mean/sum) is picked
 *  separately by WindowAggChips. */
const WINDOW_MODES: { mode: WindowMode; label: string }[] = [
  { mode: "hourly", label: "1h" },
  { mode: "3h", label: "3h" },
  { mode: "6h", label: "6h" },
  { mode: "12h", label: "12h" },
  { mode: "daily", label: "Daily" },
];

/** Window-length N (whole hours) per window-mode — the N in
 *  `{base}__{N}h_{op}`. Also resolves the precip accumulation variable
 *  (`precip_{N}h`) whose long name carries the period, so the legend
 *  label tracks the selected window. */
const WINDOW_HOURS: Record<WindowMode, number> = {
  hourly: 1,
  "3h": 3,
  "6h": 6,
  "12h": 12,
  daily: 24,
};

/** Short button label per window op. */
const AGG_OP_LABEL: Record<AggOp, string> = {
  max: "Max",
  min: "Min",
  mean: "Mean",
  sum: "Sum",
};

/** Long tooltip per window op. */
const AGG_OP_TITLE: Record<AggOp, string> = {
  max: "Window maximum",
  min: "Window minimum",
  mean: "Window mean",
  sum: "Window total",
};

/** True when a variable id is a precipitation accumulation field
 *  (`tot_prec` / `precip_*`). These reduce via the `precip_{N}h`
 *  accumulation (window-mode "Total"), NOT an aggOp — so supportsAgg is
 *  deliberately false for them and the legend shows an informational
 *  "Total" indicator instead of Max/Min chips. The Total selection
 *  itself is wired in Task 18. */
function isPrecipVar(varId: string): boolean {
  return varId === "tot_prec" || varId.startsWith("precip_");
}

/** Window-op chips for one layer: the ops the backend advertises for the
 *  variable (max/min/mean/sum via aggCapsFor), an informational "Total"
 *  for precip accumulations, or a "Peak" lock in Chance-of mode
 *  (exceedance probs auto-peak server-side). The picked op rides
 *  `layer.aggOp`; WeatherMap builds the `{base}__{N}h_{op}` request var at
 *  request time (window N from the global window-mode). Renders only in a
 *  windowed mode; null in hourly, while the catalog is loading, or for
 *  fields with no advertised aggregations. Shared by the primary
 *  threshold entry and every secondary legend row. */
function WindowAggChips({
  variable,
  aggOp,
  windowMode,
  layerId,
  varInfo,
  onLayerUpdate,
  chance = false,
}: {
  variable: string;
  aggOp?: MapLayer["aggOp"];
  windowMode?: WindowMode;
  layerId?: string;
  varInfo: Map<string, AvailableVariable>;
  onLayerUpdate?: (id: string, patch: Partial<MapLayer>) => void;
  chance?: boolean;
}) {
  if (!windowMode || windowMode === "hourly") return null;
  if (chance) {
    return (
      <span
        className="legend-mode-chip legend-agg-lock"
        title="Probabilities peak across the window (≥ / ≤ direction sets the side)"
      >
        Peak
      </span>
    );
  }
  const caps = aggCapsFor(varInfo, variable);
  if (caps && layerId && onLayerUpdate) {
    const active = (aggOp ?? caps.default) as AggOp;
    return (
      <span className="legend-agg-chips">
        {caps.ops.map((op) => (
          <button
            key={op}
            type="button"
            className={`legend-mode-chip${active === op ? " active" : ""}`}
            title={AGG_OP_TITLE[op as AggOp] ?? op}
            onClick={() => onLayerUpdate(layerId, { aggOp: op as AggOp })}
          >
            {AGG_OP_LABEL[op as AggOp] ?? op}
          </button>
        ))}
      </span>
    );
  }
  if (isPrecipVar(variable)) {
    return (
      <span
        className="legend-mode-chip legend-agg-lock"
        title="Precipitation totals over the window"
      >
        Total
      </span>
    );
  }
  return null;
}

/** Header-level 🏔️ terrain toggle, docked next to the DET|ENS master switch:
 *  ONE switch for the temperature elevation (lapse-rate) correction
 *  (`T_site = T_model + γ·(z_site − z_model)`, on by default), bulk-applied to
 *  every lapse-eligible layer — it flips the SAME `layer.lapse` field the
 *  point/hover fetches read for `?lapse=off` parity, so the two can never
 *  drift. Shown when any eligible layer exists and the shared z_site DEM
 *  resolved available this session (`lapseAvailable`). */
function TerrainToggle({
  layers,
  lapseAvailable,
  onLayerUpdate,
}: {
  layers: MapLayer[];
  lapseAvailable?: boolean;
  onLayerUpdate?: (id: string, patch: Partial<MapLayer>) => void;
}) {
  const eligible = layers.filter((l) =>
    showLapseToggle(l.variable, !!lapseAvailable),
  );
  if (eligible.length === 0 || !onLayerUpdate) return null;
  const on = eligible.some((l) => l.lapse !== "off");
  return (
    <button
      type="button"
      className={`legend-mode-chip legend-terrain-toggle${on ? " active" : ""}`}
      aria-pressed={on}
      title={
        on
          ? "Terrain-corrected for elevation (lapse rate) — click to show raw model values"
          : "Raw model values — click to apply the terrain (lapse-rate) correction"
      }
      onClick={() => {
        const next: MapLayer["lapse"] = on ? "off" : undefined;
        for (const l of eligible) onLayerUpdate(l.id, { lapse: next });
      }}
    >
      🏔️
    </button>
  );
}

/** Header-level interpolation toggle beside 🏔️: flips every visible tile
 *  layer's drape sampling between nearest (native grid cells, the default)
 *  and bicubic B-spline (smooth). The chip shows the ACTIVE scheme; pressing
 *  it selects the other. Lapse-on drapes already force ≥ bilinear at render
 *  (native-cell seams), so with the correction active "Nearest" effectively
 *  renders bilinear — explicit Bicubic is honored either way. */
function InterpToggle({
  layers,
  onLayerUpdate,
}: {
  layers: MapLayer[];
  onLayerUpdate?: (id: string, patch: Partial<MapLayer>) => void;
}) {
  if (layers.length === 0 || !onLayerUpdate) return null;
  const bicubic = layers.some((l) => (l.interp ?? 0) === 2);
  return (
    <button
      type="button"
      className={`legend-mode-chip legend-interp-toggle${bicubic ? " active" : ""}`}
      aria-pressed={bicubic}
      title={
        bicubic
          ? "Bicubic-smoothed field — click to show the native grid cells (nearest)"
          : "Native grid cells (nearest) — click for bicubic smoothing"
      }
      onClick={() => {
        const next = bicubic ? undefined : 2;
        for (const l of layers) onLayerUpdate(l.id, { interp: next });
      }}
    >
      {bicubic ? "Bicubic" : "Nearest"}
    </button>
  );
}

interface LegendEntry {
  variable: string;
  longName?: string;
  colormap: string;
  vmin: number;
  vmax: number;
  units: string;
  /** When true, the legend bar gets a `stepped=1` query so the server
   *  draws integer-Celsius bands instead of a smooth gradient. */
  stepped: boolean;
  /** Source layer id + its current window-aggregation op, so the entry can
   *  render Max/Min chips and commit the choice back through onLayerUpdate. */
  layerId?: string;
  aggOp?: MapLayer["aggOp"];
}

export default function MapLegend({
  layers,
  weatherStyle,
  selectedModel,
  selectedRun,
  unitPrefs,
  windowMode,
  onWindowModeChange,
  onUnitPrefChange,
  onLayerUpdate,
  lapseAvailable,
  epsTargetVariables,
  variablesByModel,
  compositeEps,
  onMasterMode,
}: Props) {
  const [expanded, setExpanded] = useState(true);

  // varInfo + extraMeta come from the v2 catalog (variablesByModel prop), not a
  // v1 /variables or /meta fetch (those 404 on the v2 backend). vmin/vmax/
  // colormap/units carry straight through from the catalog.
  const modelVars = useMemo(
    () => variablesByModel?.get(selectedModel) ?? [],
    [variablesByModel, selectedModel],
  );
  const varInfo = useMemo(
    () => new Map(modelVars.map((v) => [v.name, v])),
    [modelVars],
  );
  const extraMeta = useMemo(() => {
    const m = new Map<string, VariableMeta>();
    for (const av of modelVars) {
      m.set(av.name, {
        model: selectedModel,
        run: selectedRun ?? "",
        variable: av.name,
        units: av.units,
        colormap: av.default_colormap ?? "",
        stats: { min: av.vmin ?? 0, max: av.vmax ?? 1 },
        vmin: av.vmin,
        vmax: av.vmax,
      });
    }
    return m;
  }, [modelVars, selectedModel, selectedRun]);

  // Visible tile layers that need legend entries
  const tileLayers = useMemo(
    () => layers.filter((l) => l.visible && l.displayMode === "tiles"),
    [layers],
  );

  // Effective variable id of the primary (style) layer.
  const primaryVar = weatherStyle?.metadata["weather-api:variable"] ?? "";

  // Build legend entries. A per-layer `colormap` override (set from the
  // Controls panel) wins over the variable's default so the legend
  // matches what the user actually sees on the map. The `stepped`
  // decision mirrors WeatherMap's GPU path: explicit layer flag wins,
  // else default to "stepped on temperature, smooth elsewhere".
  const entries = useMemo(() => {
    const result: LegendEntry[] = [];
    for (const layer of tileLayers) {
      const varId = layer.variable;
      let entry: LegendEntry | null = null;
      if (varId === primaryVar && weatherStyle) {
        const units = weatherStyle.metadata["weather-api:units"] ?? "";
        entry = {
          variable: varId,
          colormap:
            layer.colormap ??
            weatherStyle.metadata["weather-api:colormap"] ??
            "",
          vmin: weatherStyle.metadata["weather-api:vmin"] ?? 0,
          vmax: weatherStyle.metadata["weather-api:vmax"] ?? 1,
          units,
          stepped: effectiveStepped(layer.stepped, units),
        };
      } else {
        const meta = extraMeta.get(varId);
        if (meta) {
          const units = meta.units ?? "";
          entry = {
            variable: varId,
            colormap: layer.colormap ?? meta.colormap ?? "",
            // Use the canonical legend window the renderer stretches the
            // colormap over (matches the tile + the primary layer); fall
            // back to the observed stats envelope only for an older
            // backend that doesn't yet advertise vmin/vmax.
            vmin: meta.vmin ?? meta.stats?.min ?? 0,
            vmax: meta.vmax ?? meta.stats?.max ?? 1,
            units,
            stepped: effectiveStepped(layer.stepped, units),
          };
        }
      }
      if (entry) {
        entry.layerId = layer.id;
        entry.aggOp = layer.aggOp;
        // Period-aware label: a precip-total layer always shows the
        // per-window accumulation (precip_1h hourly, precip_{N}h windowed),
        // so its title adapts to the selected aggregation — "Precipitation
        // (1h)" / "Precipitation (6h total)" — never the catalog's
        // "…since run start" / "…last Nh".
        const winHours =
          windowMode && windowMode !== "hourly" ? WINDOW_HOURS[windowMode] : 0;
        if (isPrecipVar(entry.variable)) {
          entry.longName = precipTotalTitle(winHours > 0 ? winHours : 1);
        } else {
          const info = varInfo.get(entry.variable);
          if (info?.long_name) {
            entry.longName = info.long_name;
          } else {
            // Percentile planes (t_2m_p90) share the base variable's
            // long name; qualify it with the plane so two legend rows
            // for different percentiles stay distinguishable.
            const { base, plane } = splitEnsembleVar(entry.variable);
            const baseInfo =
              plane.kind !== "median" ? varInfo.get(base) : undefined;
            if (baseInfo?.percentiles?.length && baseInfo.long_name) {
              const tag =
                plane.kind === "percentile"
                  ? `p${plane.p}`
                  : plane.kind === "control"
                    ? "control"
                    : plane.kind === "member"
                      ? `member ${plane.m}`
                      : "";
              if (tag) entry.longName = `${baseInfo.long_name} (${tag})`;
            }
          }
        }
        result.push(entry);
      }
    }
    return result;
  }, [tileLayers, primaryVar, weatherStyle, extraMeta, varInfo, windowMode]);

  // Per-layer-model catalogs for the product-picker gating. On a composite
  // `variablesByModel` carries both `auto` (det side) and `auto_eps` (eps
  // side); on a physical model it carries just the model under
  // `selectedModel`. Fall back to the legacy single-catalog inputs
  // (`epsTargetVariables` for the eps side, `varInfo` for both) so an older
  // wiring / physical EPS model doesn't regress.
  const isComposite = isCompositeModel(selectedModel);
  const detCatalog = useMemo(() => {
    const key = isComposite ? AUTO_MODEL_ID : selectedModel;
    const list = variablesByModel?.get(key);
    if (isComposite) return new Map((list ?? []).map((v) => [v.name, v]));
    if (list && list.length > 0) return new Map(list.map((v) => [v.name, v]));
    return varInfo;
  }, [variablesByModel, isComposite, selectedModel, varInfo]);
  const epsCatalog = useMemo(() => {
    const key = isComposite ? AUTO_EPS_MODEL_ID : selectedModel;
    const list = variablesByModel?.get(key);
    if (isComposite) return new Map((list ?? []).map((v) => [v.name, v]));
    if (list && list.length > 0) return new Map(list.map((v) => [v.name, v]));
    if (epsTargetVariables && epsTargetVariables.length > 0) {
      return new Map(epsTargetVariables.map((v) => [v.name, v]));
    }
    return varInfo;
  }, [variablesByModel, isComposite, selectedModel, epsTargetVariables, varInfo]);

  // Per-layer picker gate, keyed by layer id. Null when a layer has no
  // picker options at all (falls back to the plain colorbar row).
  const gatesByLayerId = useMemo(() => {
    const m = new Map<string, LayerGate | null>();
    for (const layer of tileLayers) {
      m.set(layer.id, gateOptions(layer, detCatalog, epsCatalog, selectedModel));
    }
    return m;
  }, [tileLayers, detCatalog, epsCatalog, selectedModel]);

  // Entry lookup by source layer id (set in the entries useMemo above).
  const entriesByLayerId = useMemo(() => {
    const m = new Map<string, LegendEntry>();
    for (const e of entries) if (e.layerId) m.set(e.layerId, e);
    return m;
  }, [entries]);

  // A row is interactive (renders a picker) when its gate is non-null and
  // we can commit layer rewrites.
  const anyPicker =
    onLayerUpdate != null &&
    tileLayers.some((l) => gatesByLayerId.get(l.id) != null);

  if (entries.length === 0 && !anyPicker) return null;

  return (
    <div className={`map-legend ${expanded ? "expanded" : "collapsed"}`}>
      <button
        className="map-legend-toggle"
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? "Legend" : `Legend (${entries.length})`}
        <span className="map-legend-chevron">{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded && (
        <div className="map-legend-body">
          <div className="legend-header-controls">
            {onWindowModeChange && (
              <div
                className="toggle-group legend-window-modes"
                role="group"
                aria-label="Aggregation window"
              >
                {WINDOW_MODES.map(({ mode, label }) => (
                  <button
                    key={mode}
                    type="button"
                    className={`toggle-btn${windowMode === mode ? " active" : ""}`}
                    aria-pressed={windowMode === mode}
                    onClick={() => onWindowModeChange(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {((isComposite && onMasterMode) || tileLayers.length > 0) && (
              <div className="legend-header-row">
                {isComposite && onMasterMode && (
                  <MasterModeSwitch
                    eps={masterIndicatorEps(
                      tileLayers,
                      selectedModel,
                      compositeEps,
                    )}
                    onChange={(mode) => onMasterMode(mode)}
                  />
                )}
                <TerrainToggle
                  layers={tileLayers}
                  lapseAvailable={lapseAvailable}
                  onLayerUpdate={onLayerUpdate}
                />
                <InterpToggle layers={tileLayers} onLayerUpdate={onLayerUpdate} />
              </div>
            )}
          </div>
          {tileLayers.map((layer) => {
            const entry = entriesByLayerId.get(layer.id) ?? null;
            const gate = gatesByLayerId.get(layer.id) ?? null;
            if (gate && onLayerUpdate) {
              return (
                <LayerProductPicker
                  key={layer.id}
                  layer={layer}
                  entry={entry}
                  gate={gate}
                  selectedModel={selectedModel}
                  baseColormap={
                    epsCatalog.get(gate.distBase)?.default_colormap ?? "viridis"
                  }
                  baseLongName={
                    // Precip's dist base is tot_prec, whose catalog name is
                    // "total precipitation since run start" — wrong for a
                    // per-window layer. Use the same adaptive title the
                    // non-EPS legend row shows ("Precipitation (1h)" / "(6h
                    // total)") so the EPS picker reads identically.
                    isPrecipVar(layer.variable)
                      ? precipTotalTitle(
                          windowMode && windowMode !== "hourly"
                            ? WINDOW_HOURS[windowMode]
                            : 1,
                        )
                      : epsCatalog.get(gate.distBase)?.long_name
                  }
                  unitPrefs={unitPrefs}
                  windowMode={windowMode}
                  varInfo={varInfo}
                  onUnitPrefChange={onUnitPrefChange}
                  onLayerUpdate={onLayerUpdate}
                />
              );
            }
            return (
              entry && (
                <LegendEntryRow
                  key={layer.id}
                  entry={entry}
                  unitPrefs={unitPrefs}
                  onUnitPrefChange={onUnitPrefChange}
                  windowMode={windowMode}
                  varInfo={varInfo}
                  onLayerUpdate={onLayerUpdate}
                />
              )
            );
          })}
        </div>
      )}
    </div>
  );
}

interface RowProps {
  entry: LegendEntry;
  unitPrefs: Record<string, string>;
  onUnitPrefChange?: (groupId: string, optionId: string) => void;
  /** When set (with onLayerUpdate), the row shows window-op chips for
   *  aggregatable layers. Omitted where the chips would duplicate a
   *  parent's (the threshold entry renders its own). */
  windowMode?: WindowMode;
  /** Live catalog — drives the caps-driven window-op chips. */
  varInfo?: Map<string, AvailableVariable>;
  onLayerUpdate?: (id: string, patch: Partial<MapLayer>) => void;
  /** When true, the variable name span is suppressed (the parent header
   *  already shows it). Non-primary callers omit this → name visible. */
  hideName?: boolean;
}

function LegendEntryRow({
  entry,
  unitPrefs,
  onUnitPrefChange,
  windowMode,
  varInfo,
  onLayerUpdate,
  hideName,
}: RowProps) {
  const au = resolveActiveUnit(entry.units, unitPrefs);
  const group = unitGroupForBase(entry.units);
  const stepOpts =
    entry.stepped && isTemperatureUnits(entry.units)
      ? {
          stepped: true,
          vminK: entry.vmin,
          vmaxK: entry.vmax,
        }
      : undefined;

  // Hover-over-bar: capture cursor x in [0,1] of the bar so we can
  // interpolate the underlying value and show it floating above the
  // bar. Pointer events on the wrapper rather than the <img> avoid the
  // browser's "drag image" handling intercepting the event sequence.
  const barWrapRef = useRef<HTMLDivElement>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);

  const handleBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = barWrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const t = (e.clientX - rect.left) / rect.width;
    setHoverT(Math.max(0, Math.min(1, t)));
  };
  const handleBarLeave = () => setHoverT(null);

  // Stepped temperature legends jump in 1° increments visually, so
  // round the hover readout to the same step. Smooth bars get a
  // single decimal — finer than the bar's pixel resolution but
  // readable.
  const formatHoverValue = (raw: number): string => {
    const v = au.option.convert(raw);
    if (au.groupId === "temperature" && entry.stepped) {
      return v.toFixed(0);
    }
    if (Math.abs(v) >= 100) return v.toFixed(0);
    return v.toFixed(1);
  };

  const cycleUnit = () => {
    if (!group || !onUnitPrefChange) return;
    const opts = group.options;
    if (opts.length <= 1) return;
    const cur = opts.findIndex((o) => o.id === au.option.id);
    const next = opts[(cur + 1) % opts.length];
    onUnitPrefChange(group.id, next.id);
  };

  // Log palettes (precip) place value geometrically along the bar, so
  // the hover readout must invert the same log map the tile shader uses
  // — a linear interpolation here would mislabel every position but the
  // two ends.
  const hoverValue =
    hoverT == null
      ? null
      : isLogColormap(entry.colormap)
        ? logColorValue(hoverT, entry.vmin, entry.vmax)
        : entry.vmin + hoverT * (entry.vmax - entry.vmin);

  return (
    <div
      className="map-legend-entry"
      title={entry.longName ? `${entry.variable} — ${entry.longName}` : entry.variable}
    >
      {!hideName && (
        <span className="map-legend-var">
          {entry.longName ?? entry.variable}
        </span>
      )}
      {windowMode && windowMode !== "hourly" && onLayerUpdate && (
        <div className="legend-mode-chips legend-row-agg">
          <WindowAggChips
            variable={entry.variable}
            aggOp={entry.aggOp}
            windowMode={windowMode}
            layerId={entry.layerId}
            varInfo={varInfo ?? new Map()}
            onLayerUpdate={onLayerUpdate}
          />
        </div>
      )}
      {entry.colormap && (
        <div
          className="map-legend-bar-wrap"
          ref={barWrapRef}
          onPointerMove={handleBarMove}
          onPointerLeave={handleBarLeave}
        >
          <img
            className="map-legend-bar"
            src={colormapLegendURL(entry.colormap, 160, 10, stepOpts)}
            alt={entry.colormap}
            draggable={false}
          />
          {hoverT != null && hoverValue != null && (
            <>
              <div
                className="map-legend-hover-marker"
                style={{ left: `${hoverT * 100}%` }}
              />
              <div
                className="map-legend-hover-tip"
                style={{ left: `${hoverT * 100}%` }}
              >
                {formatHoverValue(hoverValue)}
                {au.option.label ? (
                  <span className="map-legend-hover-unit"> {au.option.label}</span>
                ) : null}
              </div>
            </>
          )}
        </div>
      )}
      <div className="map-legend-range">
        <span>{au.option.convert(entry.vmin).toFixed(1)}</span>
        {group && group.options.length > 1 && onUnitPrefChange ? (
          <button
            type="button"
            className="map-legend-unit-btn"
            onClick={cycleUnit}
            title={`Switch unit (${group.options
              .map((o) => o.label)
              .join(" / ")})`}
          >
            {au.option.label}
          </button>
        ) : (
          <span className="map-legend-unit">{au.option.label}</span>
        )}
        <span>{au.option.convert(entry.vmax).toFixed(1)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-layer ensemble-product picker (Det / Med / Mean / p* / Spread / Chance)
// ---------------------------------------------------------------------------

/** Master DET | EPS segmented control at the legend-header level. Flipping
 *  it sets the composite default AND bulk-applies the mode to every visible
 *  tile layer (Decision 4). Composite-only. Reuses the segmented-control
 *  styling. */
function MasterModeSwitch({
  eps,
  onChange,
}: {
  eps: boolean;
  onChange: (mode: "det" | "eps") => void;
}) {
  return (
    <span
      className="legend-seg-group legend-master-mode"
      role="group"
      aria-label="Ensemble mode (all layers)"
      title="Switch every layer between the deterministic and ensemble composite"
    >
      <button
        type="button"
        className={`legend-seg${!eps ? " active" : ""}`}
        aria-pressed={!eps}
        onClick={() => onChange("det")}
      >
        DET
      </button>
      <button
        type="button"
        className={`legend-seg${eps ? " active" : ""}`}
        aria-pressed={eps}
        onClick={() => onChange("eps")}
      >
        ENS
      </button>
    </span>
  );
}

/** Legend row for the primary tile layer when its value base is an EPS
 *  forecast variable (advertises ensemble_products caps and/or a dist
 *  archive). ONE segmented product picker selects the ensemble product —
 *  all carried in `layer.variable` so they round-trip through
 *  hash/presets. The active product is resolved from the id by
 *  currentProduct; selecting a segment rewrites the id via applyProduct
 *  (or, for Chance-of, enters the existing useThreshold marker path).
 *
 *    Spread    → `{base}_spread` (server-derived p90 − p10); rendered as
 *                an ordinary value row so its numeric min/max show.
 *    Chance of → a `{base}_gt{V}{u}`/`_lt…` threshold; keeps the value
 *                scale and dims the non-event side of a draggable ▲
 *                marker (there is deliberately no 0–100 % colorbar).
 *
 *  The threshold marker derives from parseThresholdId(layer.variable),
 *  so the Controls dropdown, hash, and presets stay in sync with zero
 *  new persistence. The ≥/≤ direction chip renders ONLY in Chance-of
 *  mode, where flipping it always re-commits — so the direction can
 *  never be a no-op preview that looks like "≥/≤ doesn't apply". */
function LayerProductPicker({
  layer,
  entry,
  gate,
  selectedModel,
  baseColormap,
  baseLongName,
  unitPrefs,
  windowMode,
  varInfo,
  onUnitPrefChange,
  onLayerUpdate,
}: {
  layer: MapLayer;
  /** Non-chance legend entry (null while its meta is in flight). */
  entry: LegendEntry | null;
  /** Resolved per-layer gate (distBase/displayVar/dist/caps/detEnabled). */
  gate: LayerGate;
  /** Active global model — resolves the layer's effective det/eps mode. */
  selectedModel: string;
  baseColormap: string;
  baseLongName?: string;
  unitPrefs: Record<string, string>;
  windowMode?: WindowMode;
  /** Live catalog — drives the caps-driven window-op chips. */
  varInfo: Map<string, AvailableVariable>;
  onUnitPrefChange?: (groupId: string, optionId: string) => void;
  onLayerUpdate: (id: string, patch: Partial<MapLayer>) => void;
}) {
  const { distBase, dist } = gate;
  const thr = useThreshold({
    layer,
    distBase,
    dist: dist ?? INERT_DIST,
    unitPrefs,
    onLayerUpdate,
  });
  // Active segment: when the layer's effective mode is deterministic, `Det`
  // is the active segment; otherwise the active EPS product is read off the
  // id by currentProduct (which returns "chance" exactly when
  // parseThresholdId matches, staying in lockstep with useThreshold's own
  // `active`). On a det layer the body is the plain value colorbar (chance
  // is an EPS product, so never active in det mode).
  const detMode = effectiveLayerMode(layer, selectedModel) === "det";
  const active: PickerProduct = detMode
    ? "det"
    : currentProduct(layer.variable);
  const chance = active === "chance";
  const [overflowOpen, setOverflowOpen] = useState(false);
  const label = DIST_LABELS[distBase] ?? distBase;

  const select = (product: PickerProduct) => {
    // Close the overflow panel whenever a product is picked (including from
    // the inline row) so the ⋯ menu collapses after selection.
    setOverflowOpen(false);
    // Rewrite ONLY this layer (variable + ensembleMode) — no global
    // composite flip. productPatch maps the segment to the patch; chance
    // leaves the variable to the useThreshold commit below.
    if (product === "chance") {
      // Route to EPS, then enter the existing useThreshold marker path
      // (mid-domain / remembered threshold) which commits the threshold id.
      onLayerUpdate(layer.id, productPatch(layer, "chance", gate));
      thr.commit();
      return;
    }
    onLayerUpdate(layer.id, productPatch(layer, product, gate));
  };

  // Marker drag: pointer-captured so the drag keeps tracking outside
  // the bar; pointerdown alone implements tap-to-place. `draggingRef`
  // gates pointermove synchronously (avoids the stale-closure first
  // move); `dragging` state drives the value bubble's render.
  const wrapRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  // Cursor position over the bar in [0,1] for the desktop hover readout;
  // null when not hovering (touch never sets it — there is no hover).
  const [hoverT, setHoverT] = useState<number | null>(null);
  const placeFromEvent = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const v =
      Math.round((thr.lo + t * (thr.hi - thr.lo)) / thr.step) * thr.step;
    thr.setValue(v);
  };

  const markerPct =
    thr.hi > thr.lo ? ((thr.value - thr.lo) / (thr.hi - thr.lo)) * 100 : 50;

  // Transient value bubble: during a drag it tracks the committed
  // threshold at the knob; on desktop hover it previews the value a
  // click would set at the cursor.
  const showBubble = dragging || hoverT != null;
  const bubblePct = dragging ? markerPct : (hoverT ?? 0) * 100;
  const bubbleValue = dragging
    ? thr.value
    : Math.round((thr.lo + (hoverT ?? 0) * (thr.hi - thr.lo)) / thr.step) *
      thr.step;

  // Unit cycler for Chance-of mode (the forecast row has its own). The
  // dist archive's native units resolve the conversion group; cycling
  // re-expresses the threshold via useThreshold's au.option.id effect.
  const distGroup = dist ? unitGroupForBase(dist.units) : undefined;
  const cycleDistUnit = () => {
    if (!distGroup || !onUnitPrefChange) return;
    const opts = distGroup.options;
    if (opts.length <= 1) return;
    const cur = opts.findIndex((o) => o.id === thr.au.option.id);
    onUnitPrefChange(distGroup.id, opts[(cur + 1) % opts.length].id);
  };

  // Stepped temperature bars need the kelvin envelope; the dist
  // capability's min/max are native units (K for temperature bases).
  const stepOpts =
    dist && isTemperatureUnits(dist.units)
      ? { stepped: true, vminK: dist.min, vmaxK: dist.max }
      : undefined;

  return (
    <div className="map-legend-entry">
      <div className="legend-primary-header">
        <span className="map-legend-var">{baseLongName ?? label}</span>
      </div>
      <div className="legend-mode-chips">
        <span className="legend-seg-group" role="group" aria-label="Ensemble product">
          {/* The ACTIVE product always renders inline, even when it normally
              lives in the ⋯ overflow (Min/Max/p25/…): with e.g. t_2m_p100
              selected, no visible chip indicated the layer's product at all. */}
          {PICKER_SEGMENTS.filter(
            (s) => (!s.overflow || s.product === active) && segmentEnabled(s.product, gate),
          ).map((s) => (
            <button
              key={s.product}
              type="button"
              className={`legend-seg${active === s.product ? " active" : ""}`}
              aria-pressed={active === s.product}
              onClick={() => select(s.product)}
            >
              {s.label}
            </button>
          ))}
          {PICKER_SEGMENTS.some(
            (s) => s.overflow && segmentEnabled(s.product, gate),
          ) && (
            <button
              type="button"
              className={`legend-seg legend-seg-more${overflowOpen ? " active" : ""}`}
              aria-pressed={overflowOpen}
              aria-label="More ensemble products"
              title="More ensemble products"
              onClick={() => setOverflowOpen((o) => !o)}
            >
              ⋯
            </button>
          )}
        </span>
        {overflowOpen && (
          <span
            className="legend-seg-group legend-seg-overflow"
            role="group"
            aria-label="More ensemble products"
          >
            {PICKER_SEGMENTS.filter(
              (s) => s.overflow && segmentEnabled(s.product, gate),
            ).map((s) => (
              <button
                key={s.product}
                type="button"
                className={`legend-seg${active === s.product ? " active" : ""}`}
                aria-pressed={active === s.product}
                onClick={() => select(s.product)}
              >
                {s.label}
              </button>
            ))}
          </span>
        )}
        {chance && (
          <button
            type="button"
            className="legend-mode-chip legend-dir-chip"
            title={
              thr.dir === "gt"
                ? "Chance of exceeding the threshold — click for ≤"
                : "Chance of staying at or below the threshold — click for ≥"
            }
            onClick={() => thr.setDir(thr.dir === "gt" ? "lt" : "gt")}
          >
            {thr.dir === "gt" ? "≥" : "≤"}
          </button>
        )}
        <WindowAggChips
          variable={layer.variable}
          aggOp={layer.aggOp}
          windowMode={windowMode}
          layerId={layer.id}
          varInfo={varInfo}
          onLayerUpdate={onLayerUpdate}
          chance={chance}
        />
      </div>
      {!chance ? (
        entry && (
          <LegendEntryRow
            entry={entry}
            unitPrefs={unitPrefs}
            onUnitPrefChange={onUnitPrefChange}
            hideName
          />
        )
      ) : (
        <>
          <div
            className="map-legend-bar-wrap legend-threshold-wrap"
            ref={wrapRef}
            onPointerDown={(e) => {
              draggingRef.current = true;
              setDragging(true);
              e.currentTarget.setPointerCapture(e.pointerId);
              placeFromEvent(e);
            }}
            onPointerMove={(e) => {
              if (draggingRef.current) {
                placeFromEvent(e);
                return;
              }
              // Desktop hover preview only — touch has no hover and a
              // pointermove during a swipe would re-render every frame.
              if (e.pointerType !== "mouse") return;
              const el = wrapRef.current;
              if (!el) return;
              const rect = el.getBoundingClientRect();
              if (rect.width === 0) return;
              setHoverT(
                Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
              );
            }}
            onPointerUp={(e) => {
              draggingRef.current = false;
              setDragging(false);
              e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onPointerCancel={() => {
              draggingRef.current = false;
              setDragging(false);
            }}
            onPointerLeave={() => setHoverT(null)}
          >
            <img
              className="map-legend-bar"
              src={colormapLegendURL(baseColormap, 160, 10, stepOpts)}
              alt={baseColormap}
              draggable={false}
            />
            <div
              className="legend-dim-overlay"
              style={
                thr.dir === "gt"
                  ? { left: 0, width: `${markerPct}%` }
                  : { left: `${markerPct}%`, right: 0 }
              }
            />
            <div
              className="legend-threshold-marker"
              style={{ left: `${markerPct}%` }}
            />
            {showBubble && (
              <div
                className="map-legend-hover-tip legend-threshold-tip"
                style={{ left: `${bubblePct}%` }}
              >
                {bubbleValue.toFixed(thr.decimals)}
                {thr.au.option.label ? (
                  <span className="map-legend-hover-unit">
                    {" "}
                    {thr.au.option.label}
                  </span>
                ) : null}
              </div>
            )}
          </div>
          <div className="map-legend-range">
            <span>{thr.lo.toFixed(thr.decimals)}</span>
            <span className="legend-threshold-value">
              {thr.value.toFixed(thr.decimals)}{" "}
              {distGroup && distGroup.options.length > 1 && onUnitPrefChange ? (
                <button
                  type="button"
                  className="map-legend-unit-btn"
                  onClick={cycleDistUnit}
                  title={`Switch unit (${distGroup.options
                    .map((o) => o.label)
                    .join(" / ")})`}
                >
                  {thr.au.option.label}
                </button>
              ) : (
                thr.au.option.label
              )}
            </span>
            <span>{thr.hi.toFixed(thr.decimals)}</span>
          </div>
          <div className="legend-readout">
            map shows: chance that {label} {thr.dir === "gt" ? "≥" : "≤"}{" "}
            {thr.value.toFixed(thr.decimals)} {thr.au.option.label} (0–100%)
          </div>
        </>
      )}
    </div>
  );
}
