import {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from "react";
import type { Model, PointTimeSeriesResponse, TimeFormat, Variable } from "../api/types";
import { splitEnsembleVar, splitPercentileVar } from "../api/types";
import { describeVar } from "../api/varDisplay";
import { fetchV2Point, fetchV2PointSeries } from "../api/v2client";
import { isLapseOffForFetch } from "../api/mapConfig";
import { formatStatusTime, leadReferenceMs, leadHoursOf } from "../time";
import { resolveActiveUnit, type ActiveUnit } from "../units";
import WindBarbs from "./WindBarbs";
import type { BarbRow } from "./WindBarbs";
import Meteogram from "./Meteogram";
import MultiModelCharts from "./MultiModelCharts";
import { usePersistentState } from "../lib/usePersistentState";
import { reverseGeocode, type SearchResult } from "../api/geocode";

interface Props {
  model: string;
  variable: string;
  variables?: string[];
  /** E5: bases (t_2m/td_2m) whose ⛰ toggle is OFF among the visible layers —
   *  a matching fetched series (incl. derived band/wind variants) carries
   *  `?lapse=off` for point/hover parity with the drape. */
  lapseOffBases?: Set<string>;
  run?: string;
  lat: number;
  lon: number;
  /** Place name for the header (a search pick carries the geocoder's); when
   *  absent the popup reverse-geocodes the coordinate itself. */
  placeLabel?: string;
  placeKind?: string;
  /** Map zoom at click time — scales the reverse-geocode acceptance radius. */
  clickZoom?: number;
  /** Open the full-page detail view; receives the resolved place name and
   *  the target tab (the popup's Multi view opens the multi-model tab). */
  onOpenDetail?: (label?: string, view?: "detail" | "multi") => void;
  timeFormat: TimeFormat;
  /**
   * The model's variable catalog, keyed by base name. Used to resolve
   * each variable's base unit so per-series unit conversion in the
   * popup matches the actual physical quantity (hPa for pressure, °C
   * for temperature, ...) instead of reusing the primary tile layer's
   * unit across every series.
   */
  modelVariables: Variable[];
  /** Full model catalog — the "Multi" tab compares every physical model. */
  allModels: Model[];
  /** User's per-group display-unit preferences (°C vs K, hPa vs Pa, ...). */
  unitPrefs: Record<string, string>;
  /** Currently-selected timestep on the TimeBar — highlighted in the chart. */
  activeTimestep: number;
  /** Invoked when the user clicks on a timestep in the chart. */
  onTimestepChange: (idx: number) => void;
  /** The global TimeBar timeline (ISO strings). Lets the meteogram map
   *  its now-relative series back to the shared timeline by time. */
  globalTimesteps: string[];
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Chart-kind selection
//
// Different physical quantities read better as different chart types. A
// continuous instantaneous quantity (temperature, wind speed, pressure,
// relative humidity at 2 m) is best rendered as a line chart; a
// quantity that is accumulated since run start (tot_prec, rain_gsp,
// ...) is best rendered as a bar chart of per-timestep increments so
// the user sees hourly precipitation rather than the monotonic sum;
// and non-accumulated "intensity" quantities like cloud cover or
// precipitation rates also read well as bars.
// ---------------------------------------------------------------------------

const ACCUMULATED_VARS = new Set([
  "tot_prec",
  "rain_gsp",
  "rain_con",
  "snow_gsp",
  "snow_con",
  "grau_gsp",
  "dursun",
]);

const BAR_INSTANT_VARS = new Set([
  "prr_gsp",
  "prs_gsp",
  "prr_con",
  "prs_con",
  "clct",
  "clch",
  "clcm",
  "clcl",
]);

type ChartKind = "line" | "bar" | "bar-delta";

function chartKindFor(variable: string): ChartKind {
  const v = variable.toLowerCase();
  if (ACCUMULATED_VARS.has(v)) return "bar-delta";
  if (BAR_INSTANT_VARS.has(v)) return "bar";
  // Exceedance probabilities (prob_prec_gt1mm, prob_wind_bft7, …) are
  // bounded 0–100 % intensities — bars read better than a line that
  // hugs the floor most of the forecast.
  if (v.startsWith("prob_")) return "bar";
  return "line";
}

/** Percentile-plane ids fetched alongside a probabilistic variable to
 *  draw its ensemble envelope. `inner` is null when the model only
 *  publishes the outer pair. */
interface EnsembleBandIds {
  low: string;
  high: string;
  inner: { low: string; high: string } | null;
}

/** Base variable ids that mark the popup as "showing wind data" —
 *  any of these among the displayed variables turns on the wind-barb
 *  strip (direction from median u/v, speeds from wind_10m planes). */
const WIND_CONTEXT_VARS = new Set([
  "wind_10m",
  "wind_speed_10m",
  "wind_dir_10m",
  "wind_gust_10m",
  "vmax_10m",
  "u_10m",
  "v_10m",
  "prob_wind_bft7",
  "prob_wind_bft10",
]);

function chartKindLabel(kind: ChartKind): string {
  switch (kind) {
    case "line":
      return "line";
    case "bar":
      return "bar";
    case "bar-delta":
      return "hourly";
  }
}

export default function PointPopup({
  model,
  variable,
  variables,
  lapseOffBases,
  run,
  lat,
  lon,
  placeLabel,
  placeKind,
  clickZoom,
  onOpenDetail,
  timeFormat,
  modelVariables,
  allModels,
  unitPrefs,
  activeTimestep,
  onTimestepChange,
  globalTimesteps,
  onClose,
}: Props) {
  const [data, setData] = useState<PointTimeSeriesResponse | null>(null);
  // Site ground elevation (z_site from the server's high-res DEM), shown under
  // the coordinates. One cheap /point per location; null hides the line.
  const [siteElev, setSiteElev] = useState<number | null>(null);
  // Place name: the caller's (search pick) wins; a plain map click
  // reverse-geocodes and uses the answer only on a direct (~3 km) match.
  const [revPlace, setRevPlace] = useState<SearchResult | null>(null);
  // Escape closes the popup — the ✕ is a small target and a keyboard
  // path costs nothing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    setRevPlace(null);
    if (placeLabel) return;
    const ac = new AbortController();
    reverseGeocode(lat, lon, clickZoom, ac.signal)
      .then((r) => setRevPlace(r))
      .catch(() => {}); // slow/absent geocoder → coords-only header
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zoom only scales the radius
  }, [placeLabel, lat, lon]);
  useEffect(() => {
    setSiteElev(null);
    const ac = new AbortController();
    fetchV2Point(model, "t_2m", lat, lon, {}, ac.signal)
      .then((r) => setSiteElev(r.elevation ?? null))
      .catch(() => {});
    return () => ac.abort();
  }, [model, lat, lon]);
  const [error, setError] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Popup view: persisted — clicking a new point reopens in the last-used
  // view (a forecaster living in Multi or Layers keeps it across clicks
  // and sessions).
  const [view, setView] = usePersistentState<"meteogram" | "multi" | "layers">(
    "wx:popupView",
    "meteogram",
    (raw): raw is "meteogram" | "multi" | "layers" =>
      raw === "meteogram" || raw === "multi" || raw === "layers",
  );

  const queryVars = variables ?? [variable];

  // Catalog entry for a variable id. Ensemble planes (`t_2m_p90`,
  // `t_2m_ctrl`, `t_2m_m3`) share the base variable's metadata, so
  // when the exact id misses we fall back to the suffix-stripped base
  // — but only when that base actually advertises ensemble planes, so
  // plain ids that happen to end in a matching pattern are never
  // misattributed. Keeps units (and thus K/°C/°F conversion) working
  // identically across every plane variant of a variable.
  const metaFor = useCallback(
    (varName: string): Variable | undefined => {
      const exact = modelVariables.find((v) => v.name === varName);
      if (exact) return exact;
      const { base, plane } = splitEnsembleVar(varName);
      if (plane.kind === "median") return undefined;
      const baseMeta = modelVariables.find((v) => v.name === base);
      return baseMeta?.percentiles?.length ? baseMeta : undefined;
    },
    [modelVariables],
  );

  // Per-variable base-unit lookup so every chart renders the series in
  // the unit dictated by the variable's own physical dimension rather
  // than inheriting the primary tile layer's unit. Without this, a
  // popup showing temperature + pressure together would display
  // pressure in °C (the primary layer's unit).
  const unitFor = useCallback(
    (varName: string): ActiveUnit =>
      resolveActiveUnit(metaFor(varName)?.units ?? "", unitPrefs),
    [metaFor, unitPrefs],
  );
  const primaryUnit = useMemo(() => unitFor(variable), [unitFor, variable]);
  // Friendly header label + value unit, shared with the hover readout so
  // a chance/windowed/percentile id reads the same in both popups.
  const primaryDesc = useMemo(
    () => describeVar(variable, modelVariables, unitPrefs),
    [variable, modelVariables, unitPrefs],
  );

  // Ensemble bands: for variables whose base advertises percentile
  // planes, fetch the spread planes alongside the displayed series so
  // the chart can draw the probability envelope — the p10–p90 outer
  // band and (when published) the p25–p75 inner band.
  const bandFor = useCallback(
    (varName: string): EnsembleBandIds | null => {
      // Any ensemble plane (percentile, control, member) gets the
      // envelope of its base variable — the spread is a property of
      // the ensemble, not of the displayed plane.
      const { base } = splitEnsembleVar(varName);
      const pcts = modelVariables.find((v) => v.name === base)?.percentiles;
      if (!pcts?.includes(10) || !pcts.includes(90)) return null;
      const inner =
        pcts.includes(25) && pcts.includes(75)
          ? { low: `${base}_p25`, high: `${base}_p75` }
          : null;
      return { low: `${base}_p10`, high: `${base}_p90`, inner };
    },
    [modelVariables],
  );
  // Wind-barb context: when the popup shows wind data, fetch the
  // median u/v (direction) and the wind_10m speed percentile planes
  // alongside so the barb strip can render p25 / p50 / p75 rows.
  const windPlan = useMemo(() => {
    const showWind = queryVars.some((v) =>
      WIND_CONTEXT_VARS.has(splitPercentileVar(v).base),
    );
    if (!showWind) return null;
    const has = (name: string) =>
      modelVariables.some((mv) => mv.name === name);
    if (!has("u_10m") || !has("v_10m")) return null;
    // The percentile axis is advertised under wind_10m in /v1/models;
    // the speed-percentile SERIES ids use the consistent wind_speed_10m
    // name (aliased onto the wind_10m dist archive by the backend).
    const pcts = modelVariables.find((mv) => mv.name === "wind_10m")
      ?.percentiles;
    const speedRows: { label: string; id: string }[] = [];
    if (pcts?.includes(25) && pcts.includes(50) && pcts.includes(75)) {
      speedRows.push({ label: "p25", id: "wind_speed_10m_p25" });
      speedRows.push({ label: "p50", id: "wind_speed_10m" });
      speedRows.push({ label: "p75", id: "wind_speed_10m_p75" });
    } else if (has("wind_10m")) {
      speedRows.push({ label: "p50", id: "wind_speed_10m" });
    } else if (has("wind_speed_10m")) {
      // Deterministic models without the ensemble speed product:
      // single row from the derived u/v speed.
      speedRows.push({ label: "wind", id: "wind_speed_10m" });
    } else {
      return null;
    }
    return { speedRows };
    // queryVars is rebuilt per render from variables/variable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variables, variable, modelVariables]);

  const fetchVars = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (v: string) => {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    };
    for (const v of queryVars) {
      push(v);
      const band = bandFor(v);
      if (band) {
        push(band.low);
        push(band.high);
        if (band.inner) {
          push(band.inner.low);
          push(band.inner.high);
        }
      }
    }
    if (windPlan) {
      push("u_10m");
      push("v_10m");
      for (const row of windPlan.speedRows) push(row.id);
    }
    return out;
    // queryVars is rebuilt per render from variables/variable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variables, variable, bandFor, windPlan]);
  // Abort the previous fetchPoint when the popup is re-pointed (model
  // / variable / run / lat / lon change) or unmounted, so a slow
  // request from the prior click doesn't pin server tiles or land
  // late and overwrite the new state.
  useEffect(() => {
    // The layer-chart fetch is only needed in "layers" view — the
    // meteogram runs its own bundled fetch.
    if (view !== "layers") return;
    const ctrl = new AbortController();
    setData(null);
    setError(null);
    setHoverIdx(null);
    // One /point series request per variable (the backend resolves the
    // full suffixed id, including `_p{N}` ensemble planes, server-side).
    fetchV2PointSeries(
      model,
      fetchVars,
      lat,
      lon,
      globalTimesteps,
      run ?? "",
      ctrl.signal,
      (v) => isLapseOffForFetch(v, lapseOffBases ?? new Set()),
    )
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setData(res);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load");
      });
    return () => ctrl.abort();
  }, [model, fetchVars, run, lat, lon, view, globalTimesteps, lapseOffBases]);

  const resolveValues = useCallback(
    (varName: string): (number | null)[] | undefined => {
      if (!data) return undefined;
      return (
        data.values[varName] ??
        data.values[varName.toUpperCase()] ??
        data.values[varName.toLowerCase()]
      );
    },
    [data],
  );

  const values = useMemo<(number | null)[] | undefined>(
    () => resolveValues(variable),
    [resolveValues, variable],
  );

  const kind = useMemo(() => chartKindFor(variable), [variable]);
  const isMultiVar = !!(variables && variables.length > 1);

  const barbRows = useMemo<BarbRow[] | null>(() => {
    if (!data || !windPlan) return null;
    const rows: BarbRow[] = [];
    for (const r of windPlan.speedRows) {
      const vals = resolveValues(r.id);
      if (vals) rows.push({ label: r.label, speeds: vals });
    }
    return rows.length > 0 ? rows : null;
  }, [data, windPlan, resolveValues]);
  const barbU = useMemo(
    () => (barbRows ? resolveValues("u_10m") : undefined),
    [barbRows, resolveValues],
  );
  const barbV = useMemo(
    () => (barbRows ? resolveValues("v_10m") : undefined),
    [barbRows, resolveValues],
  );

  // Header: place name when known (search pick, else the reverse-geocode
  // match), coordinates + kind + elevation on the smaller sub-line.
  const coordsText = `${lat.toFixed(3)}°N, ${lon.toFixed(3)}°E`;
  const place = placeLabel ?? revPlace?.placeName;
  const placeKindLabel = placeKind ?? revPlace?.kind;
  const headerTitle = place ?? coordsText;
  const headerSub = [
    ...(place ? [coordsText] : []),
    ...(placeKindLabel ? [placeKindLabel] : []),
    ...(siteElev != null ? [`\u26f0 ${Math.round(siteElev)} m`] : []),
  ];

  return (
    <div className="point-popup">
      <div className="point-popup-header">
        <span>
          {onOpenDetail ? (
            <button
              type="button"
              className="point-popup-place-link"
              title="Open the location detail view"
              onClick={() => onOpenDetail(place, view === "multi" ? "multi" : "detail")}
            >
              {headerTitle}
            </button>
          ) : (
            headerTitle
          )}
          {view === "layers" && !isMultiVar && (
            <>{" — "}{primaryDesc.label}{primaryDesc.unitLabel ? ` [${primaryDesc.unitLabel}]` : ""}</>
          )}
          <span className="point-popup-elev">
            {headerSub.join(" · ")}
          </span>
        </span>
        <span className="point-popup-actions">
          <span className="toggle-group point-popup-view">
            <button
              type="button"
              className={`toggle-btn${view === "meteogram" ? " active" : ""}`}
              onClick={() => setView("meteogram")}
            >
              Meteogram
            </button>
            <button
              type="button"
              className={`toggle-btn${view === "multi" ? " active" : ""}`}
              onClick={() => setView("multi")}
            >
              Multi
            </button>
            <button
              type="button"
              className={`toggle-btn${view === "layers" ? " active" : ""}`}
              onClick={() => setView("layers")}
            >
              Layers
            </button>
          </span>
          <button onClick={onClose} className="close-btn" aria-label="Close">
            &times;
          </button>
        </span>
      </div>
      <div className="point-popup-body">
        {view === "meteogram" && (
          <Meteogram
            model={model}
            run={run}
            lat={lat}
            lon={lon}
            modelVariables={modelVariables}
            unitPrefs={unitPrefs}
            timeFormat={timeFormat}
            activeTimestep={activeTimestep}
            onTimestepChange={onTimestepChange}
            globalTimesteps={globalTimesteps}
            activeProduct={variable}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
          />
        )}
        {view === "multi" && (
          <MultiModelCharts
            models={allModels}
            lat={lat}
            lon={lon}
            activeProduct={variable}
            unitPrefs={unitPrefs}
            timeFormat={timeFormat}
            globalTimesteps={globalTimesteps}
            onTimestepChange={onTimestepChange}
          />
        )}
        {view === "layers" && error && <div className="point-error">{error}</div>}
        {view === "layers" && !data && !error && (
          <div className="point-loading">Loading…</div>
        )}
        {view === "layers" && data && isMultiVar && (
          <>
            {queryVars.map((v) => {
              const vals = resolveValues(v);
              if (!vals) return null;
              const k = chartKindFor(v);
              const u = unitFor(v);
              const d = describeVar(v, modelVariables, unitPrefs);
              const band = bandFor(v);
              return (
                <div key={v} className="multi-var-chart">
                  <div className="multi-var-label">
                    {d.label}
                    {d.unitLabel ? ` [${d.unitLabel}]` : ""}
                  </div>
                  <PointChart
                    timesteps={data.timesteps}
                    values={vals}
                    kind={k}
                    kindLabel={chartKindLabel(k)}
                    activeTimestep={activeTimestep}
                    activeUnit={u}
                    timeFormat={timeFormat}
                    hoverIdx={hoverIdx}
                    onHoverIdx={setHoverIdx}
                    onPickIdx={onTimestepChange}
                    bandLow={band ? resolveValues(band.low) : undefined}
                    bandHigh={band ? resolveValues(band.high) : undefined}
                    bandInnerLow={
                      band?.inner ? resolveValues(band.inner.low) : undefined
                    }
                    bandInnerHigh={
                      band?.inner ? resolveValues(band.inner.high) : undefined
                    }
                  />
                </div>
              );
            })}
          </>
        )}
        {view === "layers" && data && !isMultiVar && values && (() => {
          const band = bandFor(variable);
          return (
            <PointChart
              timesteps={data.timesteps}
              values={values}
              kind={kind}
              kindLabel={chartKindLabel(kind)}
              activeTimestep={activeTimestep}
              activeUnit={primaryUnit}
              timeFormat={timeFormat}
              hoverIdx={hoverIdx}
              onHoverIdx={setHoverIdx}
              onPickIdx={onTimestepChange}
              bandLow={band ? resolveValues(band.low) : undefined}
              bandHigh={band ? resolveValues(band.high) : undefined}
              bandInnerLow={
                band?.inner ? resolveValues(band.inner.low) : undefined
              }
              bandInnerHigh={
                band?.inner ? resolveValues(band.inner.high) : undefined
              }
            />
          );
        })()}
        {view === "layers" && data && barbRows && barbU && barbV && (
          <WindBarbs
            timesteps={data.timesteps}
            u={barbU}
            v={barbV}
            rows={barbRows}
            activeTimestep={activeTimestep}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            onPickIdx={onTimestepChange}
            timeFormat={timeFormat}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SVG time-series chart
// ---------------------------------------------------------------------------

interface ChartProps {
  timesteps: string[];
  values: (number | null)[];
  kind: ChartKind;
  kindLabel: string;
  activeTimestep: number;
  activeUnit: ActiveUnit;
  timeFormat: TimeFormat;
  hoverIdx: number | null;
  onHoverIdx: (i: number | null) => void;
  onPickIdx: (i: number) => void;
  /** Ensemble p10 / p90 series (base units, aligned with `values`).
   *  When both are present the chart draws the probability envelope
   *  (shaded band on line charts, whiskers on bar charts) and the
   *  focus row grows a subtle "x – y" range readout. */
  bandLow?: (number | null)[];
  bandHigh?: (number | null)[];
  /** Optional p25 / p75 inner band, drawn denser inside the outer. */
  bandInnerLow?: (number | null)[];
  bandInnerHigh?: (number | null)[];
}

// viewBox geometry. The SVG scales to fill its container width via CSS
// while preserving aspect ratio, so these numbers are a design-time
// canvas, not pixels.
const CHART_W = 320;
const CHART_H = 180;
const CHART_M = { top: 10, right: 12, bottom: 28, left: 42 };
const INNER_W = CHART_W - CHART_M.left - CHART_M.right;
const INNER_H = CHART_H - CHART_M.top - CHART_M.bottom;

function formatAxisNumber(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function formatSummaryNumber(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 100) return v.toFixed(0);
  return v.toFixed(1);
}

/** Convert a raw series to display values: unit conversion plus, for
 *  accumulated (`bar-delta`) variables, the per-timestep increment
 *  clamped at zero. Shared by the main series and the p10/p90 band so
 *  all three readouts live in the same display space. */
function displaySeries(
  values: (number | null)[],
  kind: ChartKind,
  convert: (v: number) => number,
): (number | null)[] {
  const converted = values.map((v) =>
    v == null || Number.isNaN(v) ? null : convert(v),
  );
  if (kind !== "bar-delta") return converted;
  return converted.map((v, i) => {
    if (v == null) return null;
    if (i === 0) return Math.max(0, v);
    const prev = converted[i - 1];
    if (prev == null) return null;
    return Math.max(0, v - prev);
  });
}

/** Closed SVG polygons for an ensemble band: forward along the high
 *  series, back along the low. Indices where either side is null
 *  split the band into separate polygons so gaps stay gaps. */
function buildBandPaths(
  low: (number | null)[],
  high: (number | null)[],
  xAt: (i: number) => number,
  yAt: (v: number) => number,
): string[] {
  const out: string[] = [];
  let seg: number[] = [];
  const flush = () => {
    if (seg.length >= 2) {
      let d = "";
      for (let k = 0; k < seg.length; k++) {
        const i = seg[k];
        const pt = `${xAt(i)},${yAt(high[i]!)}`;
        d += k === 0 ? `M${pt}` : ` L${pt}`;
      }
      for (let k = seg.length - 1; k >= 0; k--) {
        const i = seg[k];
        d += ` L${xAt(i)},${yAt(low[i]!)}`;
      }
      out.push(d + " Z");
    }
    seg = [];
  };
  const n = Math.min(low.length, high.length);
  for (let i = 0; i < n; i++) {
    if (low[i] != null && high[i] != null) seg.push(i);
    else flush();
  }
  flush();
  return out;
}

function PointChart({
  timesteps,
  values,
  kind,
  kindLabel,
  activeTimestep,
  activeUnit,
  timeFormat,
  hoverIdx,
  onHoverIdx,
  onPickIdx,
  bandLow,
  bandHigh,
  bandInnerLow,
  bandInnerHigh,
}: ChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const convert = activeUnit.option.convert;
  const unitLabel = activeUnit.option.label;

  // Displayed value per index. For accumulated variables this is the
  // increment between consecutive timesteps, clamped to zero to absorb
  // minor rounding artefacts.
  const displayed = useMemo<(number | null)[]>(
    () => displaySeries(values, kind, convert),
    [values, kind, convert],
  );

  // Ensemble bands in display space (same conversion + delta treatment
  // as the main series). Null when the variable has no band.
  const bandLowDisp = useMemo<(number | null)[] | null>(
    () => (bandLow ? displaySeries(bandLow, kind, convert) : null),
    [bandLow, kind, convert],
  );
  const bandHighDisp = useMemo<(number | null)[] | null>(
    () => (bandHigh ? displaySeries(bandHigh, kind, convert) : null),
    [bandHigh, kind, convert],
  );
  const bandInnerLowDisp = useMemo<(number | null)[] | null>(
    () => (bandInnerLow ? displaySeries(bandInnerLow, kind, convert) : null),
    [bandInnerLow, kind, convert],
  );
  const bandInnerHighDisp = useMemo<(number | null)[] | null>(
    () => (bandInnerHigh ? displaySeries(bandInnerHigh, kind, convert) : null),
    [bandInnerHigh, kind, convert],
  );

  const n = displayed.length;

  // y-range. Bars anchor to zero so a bar's height is proportional to
  // its value; lines pad a little top and bottom so the series doesn't
  // touch the plot edges. The ensemble envelope (when present) extends
  // the range so the band never clips at the plot edge.
  const { yMin, yMax } = useMemo(() => {
    const finite = displayed.filter(
      (v): v is number => v != null && Number.isFinite(v),
    );
    for (const series of [bandLowDisp, bandHighDisp]) {
      if (!series) continue;
      for (const v of series) {
        if (v != null && Number.isFinite(v)) finite.push(v);
      }
    }
    if (finite.length === 0) return { yMin: 0, yMax: 1 };
    let lo = Math.min(...finite);
    let hi = Math.max(...finite);
    if (kind !== "line") lo = Math.min(0, lo);
    if (lo === hi) {
      hi = lo + 1;
    } else {
      const pad = (hi - lo) * 0.1;
      if (kind === "line") lo -= pad;
      hi += pad;
    }
    return { yMin: lo, yMax: hi };
  }, [displayed, kind, bandLowDisp, bandHighDisp]);

  const xAt = useCallback(
    (i: number): number =>
      CHART_M.left + (n <= 1 ? INNER_W / 2 : (i / (n - 1)) * INNER_W),
    [n],
  );
  const yAt = useCallback(
    (v: number): number =>
      CHART_M.top + INNER_H - ((v - yMin) / (yMax - yMin)) * INNER_H,
    [yMin, yMax],
  );

  const y0 = yAt(Math.max(yMin, 0));

  // Line path. Null samples split the line into separate sub-paths so
  // we don't draw a straight segment across missing data.
  const lineSegments = useMemo<string[]>(() => {
    if (kind !== "line") return [];
    const out: string[] = [];
    let current = "";
    displayed.forEach((v, i) => {
      if (v == null) {
        if (current) {
          out.push(current);
          current = "";
        }
        return;
      }
      const x = xAt(i);
      const y = yAt(v);
      current += current === "" ? `M${x},${y}` : ` L${x},${y}`;
    });
    if (current) out.push(current);
    return out;
  }, [displayed, kind, xAt, yAt]);

  // Ensemble envelope geometry. Line charts get shaded area bands;
  // bar charts get per-step whiskers (drawn in the JSX below).
  const outerBandPaths = useMemo<string[]>(
    () =>
      kind === "line" && bandLowDisp && bandHighDisp
        ? buildBandPaths(bandLowDisp, bandHighDisp, xAt, yAt)
        : [],
    [kind, bandLowDisp, bandHighDisp, xAt, yAt],
  );
  const innerBandPaths = useMemo<string[]>(
    () =>
      kind === "line" && bandInnerLowDisp && bandInnerHighDisp
        ? buildBandPaths(bandInnerLowDisp, bandInnerHighDisp, xAt, yAt)
        : [],
    [kind, bandInnerLowDisp, bandInnerHighDisp, xAt, yAt],
  );

  // Bar width: ~80% of the per-step spacing, capped so sparse series
  // don't render absurdly wide bars.
  const stepW = n > 1 ? INNER_W / (n - 1) : INNER_W;
  const barW = Math.max(1.5, Math.min(stepW * 0.8, 14));

  // y-axis ticks: three (min, mid, max) is plenty for a compact chart.
  const yTicks = useMemo(() => [yMin, (yMin + yMax) / 2, yMax], [yMin, yMax]);

  // x-axis ticks: one label per calendar day (the first timestep that
  // falls on a new day in the user's chosen zone).
  const xTicks = useMemo(() => {
    const out: { idx: number; label: string }[] = [];
    let lastDay = "";
    const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    // Lead mode: one tick per 24 lead hours ("+0d", "+1d", …).
    if (timeFormat === "lead" && Number.isFinite(leadReferenceMs())) {
      timesteps.forEach((iso, i) => {
        const ms = Date.parse(iso);
        if (Number.isNaN(ms)) return;
        const key = String(Math.floor(leadHoursOf(ms) / 24));
        if (key !== lastDay) {
          out.push({ idx: i, label: `+${key}d` });
          lastDay = key;
        }
      });
      return out;
    }
    timesteps.forEach((iso, i) => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return;
      let y, m, day, wd;
      if (timeFormat === "local") {
        y = d.getFullYear();
        m = d.getMonth();
        day = d.getDate();
        wd = d.getDay();
      } else {
        y = d.getUTCFullYear();
        m = d.getUTCMonth();
        day = d.getUTCDate();
        wd = d.getUTCDay();
      }
      const key = `${y}-${m}-${day}`;
      if (key !== lastDay) {
        out.push({ idx: i, label: `${WEEKDAYS[wd]} ${day}` });
        lastDay = key;
      }
    });
    return out;
  }, [timesteps, timeFormat]);

  // Pointer → nearest timestep index. Works for mouse + touch because
  // we bind pointer events on the SVG directly.
  const idxFromEvent = useCallback(
    (e: React.PointerEvent<SVGSVGElement>): number | null => {
      const svg = svgRef.current;
      if (!svg || n === 0) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return null;
      const xRatio = (e.clientX - rect.left) / rect.width;
      const xViewBox = xRatio * CHART_W - CHART_M.left;
      if (xViewBox < -stepW || xViewBox > INNER_W + stepW) return null;
      if (n === 1) return 0;
      const t = xViewBox / INNER_W;
      return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
    },
    [n, stepW],
  );

  const handleMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const idx = idxFromEvent(e);
      onHoverIdx(idx);
    },
    [idxFromEvent, onHoverIdx],
  );
  const handleLeave = useCallback(
    () => onHoverIdx(null),
    [onHoverIdx],
  );
  const handleClick = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const idx = idxFromEvent(e);
      if (idx != null) onPickIdx(idx);
    },
    [idxFromEvent, onPickIdx],
  );

  // The info row under the chart reads from the hovered index when the
  // user is pointing at the chart, otherwise from activeTimestep.
  const clampedActive = Math.max(0, Math.min(n - 1, activeTimestep));
  const focusIdx = hoverIdx ?? clampedActive;
  const focusValue =
    focusIdx >= 0 && focusIdx < n ? displayed[focusIdx] : null;
  const focusTime =
    focusIdx >= 0 && focusIdx < n ? timesteps[focusIdx] : undefined;
  const focusBandLow =
    bandLowDisp && focusIdx >= 0 && focusIdx < bandLowDisp.length
      ? bandLowDisp[focusIdx]
      : null;
  const focusBandHigh =
    bandHighDisp && focusIdx >= 0 && focusIdx < bandHighDisp.length
      ? bandHighDisp[focusIdx]
      : null;
  const focusInnerLow =
    bandInnerLowDisp && focusIdx >= 0 && focusIdx < bandInnerLowDisp.length
      ? bandInnerLowDisp[focusIdx]
      : null;
  const focusInnerHigh =
    bandInnerHighDisp && focusIdx >= 0 && focusIdx < bandInnerHighDisp.length
      ? bandInnerHighDisp[focusIdx]
      : null;

  // Summary stats, useful at a glance.
  const stats = useMemo(() => {
    const finite = displayed.filter(
      (v): v is number => v != null && Number.isFinite(v),
    );
    if (finite.length === 0) return null;
    let sum = 0;
    let lo = finite[0];
    let hi = finite[0];
    for (const v of finite) {
      sum += v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return { min: lo, max: hi, mean: sum / finite.length, total: sum };
  }, [displayed]);

  if (n === 0 || stats == null) {
    return <div className="point-chart-empty">No data</div>;
  }

  return (
    <div className="point-chart">
      <div className="point-chart-focus">
        <span className="point-chart-focus-time">
          {focusTime ? formatStatusTime(focusTime, timeFormat) : "—"}
        </span>
        <span className="point-chart-focus-value">
          {focusValue == null
            ? "—"
            : `${focusValue.toFixed(2)}${unitLabel ? " " + unitLabel : ""}`}
        </span>
      </div>
      {focusBandLow != null && focusBandHigh != null && (
        <div className="point-chart-band">
          {focusInnerLow != null && focusInnerHigh != null && (
            <>
              <span className="point-chart-band-label">p25–p75</span>
              <span>
                {formatSummaryNumber(focusInnerLow)} –{" "}
                {formatSummaryNumber(focusInnerHigh)}
              </span>
            </>
          )}
          <span className="point-chart-band-label">p10–p90</span>
          <span>
            {formatSummaryNumber(focusBandLow)} –{" "}
            {formatSummaryNumber(focusBandHigh)}
            {unitLabel ? ` ${unitLabel}` : ""}
          </span>
        </div>
      )}
      <svg
        ref={svgRef}
        className="point-chart-svg"
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        onPointerMove={handleMove}
        onPointerLeave={handleLeave}
        onPointerDown={handleClick}
        role="img"
        aria-label={`${kindLabel} chart of ${n} samples`}
      >
        {/* axes */}
        <line
          x1={CHART_M.left}
          y1={CHART_M.top}
          x2={CHART_M.left}
          y2={CHART_M.top + INNER_H}
          className="point-chart-axis"
        />
        <line
          x1={CHART_M.left}
          y1={CHART_M.top + INNER_H}
          x2={CHART_M.left + INNER_W}
          y2={CHART_M.top + INNER_H}
          className="point-chart-axis"
        />

        {/* dashed zero line if the range straddles zero (e.g. U/V wind) */}
        {yMin < 0 && yMax > 0 && (
          <line
            x1={CHART_M.left}
            y1={y0}
            x2={CHART_M.left + INNER_W}
            y2={y0}
            className="point-chart-zero"
          />
        )}

        {/* y-axis labels */}
        {yTicks.map((v, i) => (
          <g key={`y${i}`}>
            <line
              x1={CHART_M.left - 3}
              y1={yAt(v)}
              x2={CHART_M.left}
              y2={yAt(v)}
              className="point-chart-axis"
            />
            <text
              x={CHART_M.left - 5}
              y={yAt(v) + 3}
              className="point-chart-tick"
              textAnchor="end"
            >
              {formatAxisNumber(v)}
            </text>
          </g>
        ))}

        {/* x-axis labels (one per calendar day) */}
        {xTicks.map(({ idx, label }) => (
          <g key={`x${idx}`}>
            <line
              x1={xAt(idx)}
              y1={CHART_M.top + INNER_H}
              x2={xAt(idx)}
              y2={CHART_M.top + INNER_H + 3}
              className="point-chart-axis"
            />
            <text
              x={xAt(idx)}
              y={CHART_M.top + INNER_H + 14}
              className="point-chart-tick"
              textAnchor="middle"
            >
              {label}
            </text>
          </g>
        ))}

        {/* ensemble envelope (under the data series) */}
        {outerBandPaths.map((d, i) => (
          <path key={`bo${i}`} d={d} className="point-chart-band-area" />
        ))}
        {innerBandPaths.map((d, i) => (
          <path key={`bi${i}`} d={d} className="point-chart-band-area inner" />
        ))}

        {/* data */}
        {(kind === "bar" || kind === "bar-delta") &&
          displayed.map((v, i) => {
            if (v == null) return null;
            const isActive = i === clampedActive;
            const isHover = i === hoverIdx;
            const x = xAt(i) - barW / 2;
            if (v >= 0) {
              const y = yAt(v);
              return (
                <rect
                  key={i}
                  x={x}
                  y={y}
                  width={barW}
                  height={Math.max(0, y0 - y)}
                  className={`point-chart-bar${
                    isActive ? " active" : ""
                  }${isHover ? " hover" : ""}`}
                />
              );
            }
            const y = y0;
            const h = Math.max(0, yAt(v) - y0);
            return (
              <rect
                key={i}
                x={x}
                y={y}
                width={barW}
                height={h}
                className={`point-chart-bar neg${
                  isActive ? " active" : ""
                }${isHover ? " hover" : ""}`}
              />
            );
          })}

        {kind === "line" &&
          lineSegments.map((d, i) => (
            <path key={`seg${i}`} d={d} className="point-chart-line" />
          ))}

        {/* bar-chart ensemble whiskers: thin p10–p90 rule with a
            denser p25–p75 core, one per timestep, over the bars */}
        {kind !== "line" &&
          bandLowDisp &&
          bandHighDisp &&
          bandLowDisp.map((lo, i) => {
            const hi = bandHighDisp[i];
            if (lo == null || hi == null) return null;
            return (
              <line
                key={`wo${i}`}
                x1={xAt(i)}
                y1={yAt(lo)}
                x2={xAt(i)}
                y2={yAt(hi)}
                className="point-chart-whisker"
              />
            );
          })}
        {kind !== "line" &&
          bandInnerLowDisp &&
          bandInnerHighDisp &&
          bandInnerLowDisp.map((lo, i) => {
            const hi = bandInnerHighDisp[i];
            if (lo == null || hi == null) return null;
            return (
              <line
                key={`wi${i}`}
                x1={xAt(i)}
                y1={yAt(lo)}
                x2={xAt(i)}
                y2={yAt(hi)}
                className="point-chart-whisker inner"
              />
            );
          })}

        {/* focus marker (vertical rule at active/hover timestep) */}
        {focusIdx >= 0 && focusIdx < n && (
          <line
            x1={xAt(focusIdx)}
            y1={CHART_M.top}
            x2={xAt(focusIdx)}
            y2={CHART_M.top + INNER_H}
            className={`point-chart-marker${
              hoverIdx != null ? " hover" : ""
            }`}
          />
        )}
        {kind === "line" &&
          focusIdx >= 0 &&
          focusIdx < n &&
          focusValue != null && (
            <circle
              cx={xAt(focusIdx)}
              cy={yAt(focusValue)}
              r={3.5}
              className="point-chart-dot"
            />
          )}
      </svg>
      <div className="point-chart-stats">
        <span>
          Min <b>{formatSummaryNumber(stats.min)}</b>
        </span>
        <span>
          Max <b>{formatSummaryNumber(stats.max)}</b>
        </span>
        {kind === "bar-delta" ? (
          <span>
            Σ <b>{formatSummaryNumber(stats.total)}</b>
          </span>
        ) : (
          <span>
            Avg <b>{formatSummaryNumber(stats.mean)}</b>
          </span>
        )}
      </div>
    </div>
  );
}
