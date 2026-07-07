import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointTimeSeriesResponse, TimeFormat, Variable } from "../api/types";
import { fetchV2PointSeries, normalizeProbSeries } from "../api/v2client";
import { formatStatusTime, nearestTimestepIndex, leadReferenceMs, leadHoursOf } from "../time";
import { resolveActiveUnit } from "../units";
import { describeVar } from "../api/varDisplay";
import WindBarbs from "./WindBarbs";
import type { BarbRow } from "./WindBarbs";
import { timeFractions, nearestFracIndex, cellWidths } from "../lib/meteogramScale";
import { solarElevationDeg } from "../lib/solar";

// ---------------------------------------------------------------------------
// Meteogram — meteoblue-style stacked point forecast
//
// One shared time axis, three SVG panels (2 m temperature with the
// ensemble envelope, cloud cover at three height bands, hourly
// precipitation with the >1 mm/h ensemble probability), day/night
// shading from solar elevation, and the wind-barb percentile strip
// underneath. All panels share hover/click with the TimeBar.
// ---------------------------------------------------------------------------

// One shared plot: cloud-cover rows occupy the top band, temperature
// (left axis) draws over the full plot height — allowed to overlap
// the clouds — and precipitation bars (right axis) rise from the
// bottom underneath the temperature line.
const W = 340;
const LEFT = 36;
const RIGHT = 26; // room for the right-hand precip axis labels
const INNER_W = W - LEFT - RIGHT;

const DAY_LABEL_H = 14;
const PLOT_H = 160;
/** Height of the optional active-product panel, slotted between the
 *  main plot and the x-label band. Only contributes to the layout when
 *  the panel actually renders (see PRODUCT_PANEL_ON). */
const PRODUCT_PANEL_H = 46;
/** Height of the always-on pressure panel (pmsl line under the plot). */
const PRESSURE_PANEL_H = 40;
const X_LABEL_H = 4;

const PLOT_Y0 = DAY_LABEL_H;
const PLOT_Y1 = PLOT_Y0 + PLOT_H;
/** Stroke accent for the active-product trace. */
const PRODUCT_COLOR = "#c77dff";
/** Height of the cloud band pinned to the top of the plot. */
const CLOUD_BAND_H = 30;
/** Precip bars rise at most this fraction of the plot height. */
const PRECIP_MAX_FRAC = 0.55;

/** Base ids already covered by an existing meteogram panel — no extra
 *  active-product panel is drawn for these. */
const PRODUCT_SKIP = new Set([
  "t_2m",
  "clct",
  "clcl",
  "clcm",
  "clch",
  "precip_1h",
  "tot_prec",
  "pmsl",
  "u_10m",
  "v_10m",
  "wind_10m",
  "wind_speed_10m",
]);

interface Props {
  model: string;
  run?: string;
  lat: number;
  lon: number;
  modelVariables: Variable[];
  unitPrefs: Record<string, string>;
  timeFormat: TimeFormat;
  activeTimestep: number;
  onTimestepChange: (idx: number) => void;
  hoverIdx: number | null;
  onHoverIdx: (i: number | null) => void;
  /** The global TimeBar timeline (ISO strings). The meteogram fetches a
   *  now-relative window, so this maps the global active timestep into
   *  the local series (and a local pick back to global) by wall-clock. */
  globalTimesteps: string[];
  /** The active map product (e.g. `t_2m_gt23c`). When set and not already
   *  covered by a built-in panel, it gets its own compact panel. */
  activeProduct?: string;
}


/** Line path over non-null samples, split at gaps. */
function linePaths(
  values: (number | null)[],
  xAt: (i: number) => number,
  yAt: (v: number) => number,
): string[] {
  const out: string[] = [];
  let cur = "";
  values.forEach((v, i) => {
    if (v == null) {
      if (cur) out.push(cur);
      cur = "";
      return;
    }
    cur += cur === "" ? `M${xAt(i)},${yAt(v)}` : ` L${xAt(i)},${yAt(v)}`;
  });
  if (cur) out.push(cur);
  return out;
}

/** Band polygon between low/high series (split at gaps). */
function bandPaths(
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
      seg.forEach((i, k) => {
        d += `${k === 0 ? "M" : " L"}${xAt(i)},${yAt(high[i]!)}`;
      });
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

export default function Meteogram({
  model,
  run,
  lat,
  lon,
  modelVariables,
  unitPrefs,
  timeFormat,
  activeTimestep,
  onTimestepChange,
  hoverIdx,
  onHoverIdx,
  globalTimesteps,
  activeProduct,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [data, setData] = useState<PointTimeSeriesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const has = useCallback(
    (name: string) => modelVariables.some((v) => v.name === name),
    [modelVariables],
  );
  const pctsOf = useCallback(
    (name: string) => modelVariables.find((v) => v.name === name)?.percentiles,
    [modelVariables],
  );

  // Variable plan, bounded by the model's catalog.
  const plan = useMemo(() => {
    const t2mPcts = pctsOf("t_2m");
    // EPS wind detection: the v2 catalog has no wind_10m row (the paired-speed
    // archive is request-facing as wind_speed_10m), so the u_10m row's
    // percentile planes are the ensemble capability signal.
    const windPcts = pctsOf("wind_10m") ?? pctsOf("u_10m");
    const clouds = (["clcl", "clcm", "clch"] as const).filter(has);
    // Precip uses the consistent precip_1h hourly total (already the
    // de-accumulated delta) — never the raw tot_prec odometer.
    const precipVar = has("precip_1h") ? "precip_1h" : null;
    return {
      t2m: has("t_2m") ? "t_2m" : null,
      t2mBand: t2mPcts?.includes(10) && t2mPcts.includes(90),
      t2mInner: t2mPcts?.includes(25) && t2mPcts.includes(75),
      clouds: clouds.length === 3 ? clouds : has("clct") ? (["clct"] as const) : [],
      precipVar,
      // Precip exceedance probability: prefer the ≥1 mm/h product,
      // fall back to whatever rung of the ladder the model publishes
      // so a trimmed threshold set doesn't silently drop the line.
      probPrec: has("prob_prec_gt1mm")
        ? "prob_prec_gt1mm"
        : (modelVariables.find((v) => v.name.startsWith("prob_prec_gt"))
            ?.name ?? null),
      pmsl: has("pmsl") ? "pmsl" : null,
      uv: has("u_10m") && has("v_10m"),
      // Series ids use the consistent wind_speed_10m name (the backend
      // aliases wind_speed_10m_p{P}/bare onto the wind_10m dist archive).
      // The percentile AXIS is still advertised under wind_10m in the
      // /v1/models catalog, so detection reads windPcts/`wind_10m`; the
      // deterministic fallback keys on the derived wind_speed_10m itself.
      windRows:
        windPcts?.includes(25) && windPcts.includes(75)
          ? [
              { label: "p25", id: "wind_speed_10m_p25" },
              { label: "p50", id: "wind_speed_10m" },
              { label: "p75", id: "wind_speed_10m_p75" },
            ]
          : has("wind_10m")
            ? [{ label: "p50", id: "wind_speed_10m" }]
            : has("wind_speed_10m")
              ? [{ label: "wind", id: "wind_speed_10m" }]
              : [],
    };
  }, [has, pctsOf, modelVariables]);

  const fetchVars = useMemo(() => {
    const out: string[] = [];
    if (plan.t2m) {
      out.push("t_2m");
      if (plan.t2mBand) out.push("t_2m_p10", "t_2m_p90");
      if (plan.t2mInner) out.push("t_2m_p25", "t_2m_p75");
    }
    out.push(...plan.clouds);
    if (plan.precipVar) out.push(plan.precipVar);
    if (plan.probPrec) out.push(plan.probPrec);
    if (plan.pmsl) out.push(plan.pmsl);
    if (plan.uv && plan.windRows.length > 0) {
      out.push("u_10m", "v_10m", ...plan.windRows.map((r) => r.id));
    }
    // Always fetch the active map product so its panel (or, when it
    // coincides with a built-in panel, the existing trace) has data.
    if (activeProduct && !out.includes(activeProduct)) out.push(activeProduct);
    return out;
  }, [plan, activeProduct]);

  useEffect(() => {
    if (fetchVars.length === 0) return;
    const ctrl = new AbortController();
    // v2 has no point-series endpoint: fetchV2PointSeries fans out one /point per
    // (var, frame) over the global timeline, returning the v1
    // PointTimeSeriesResponse shape. Each frame is an instant, so the _gt/_lt
    // exceedance ids stay per-tick (no window auto-peak). "Now-relative" is
    // achieved by clipping the returned series to now-onward below.
    // Clearing stale data on re-point is intentional: the popup shows "Loading…".
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setData(null);
    setError(null);
    fetchV2PointSeries(
      model,
      fetchVars,
      lat,
      lon,
      globalTimesteps,
      run ?? "",
      ctrl.signal,
      // The meteogram is a site forecast: temperatures are ALWAYS
      // elevation-corrected (server default), independent of any layer's
      // drape ⛰ toggle — only per-layer readouts mirror the screen.
    )
      .then((res) => {
        if (ctrl.signal.aborted) return;
        // Clip leading ticks before the current hour so the chart reads
        // forecast-from-now. Date.now() is fine here (fetch handler, not
        // render/memo, so react-hooks/purity isn't tripped). Defensive:
        // keep the full response if clipping would leave fewer than 2
        // ticks (or no tick is at/after the cutoff).
        const cutoff = Math.floor(Date.now() / 3_600_000) * 3_600_000;
        const startIdx = res.timesteps.findIndex(
          (ts) => Date.parse(ts) >= cutoff,
        );
        if (startIdx <= 0 || res.timesteps.length - startIdx < 2) {
          setData(res);
          return;
        }
        const clipped: PointTimeSeriesResponse = {
          ...res,
          timesteps: res.timesteps.slice(startIdx),
          values: Object.fromEntries(
            Object.entries(res.values).map(([k, arr]) => [
              k,
              Array.isArray(arr) ? arr.slice(startIdx) : arr,
            ]),
          ),
        };
        setData(clipped);
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      });
    return () => ctrl.abort();
  }, [model, run, lat, lon, fetchVars, globalTimesteps]);

  const tempUnit = useMemo(
    () =>
      resolveActiveUnit(
        modelVariables.find((v) => v.name === "t_2m")?.units ?? "K",
        unitPrefs,
      ),
    [modelVariables, unitPrefs],
  );

  const series = useCallback(
    (name: string | null | undefined): (number | null)[] | null => {
      if (!name || !data) return null;
      return data.values[name] ?? null;
    },
    [data],
  );

  const timesteps = useMemo(() => data?.timesteps ?? [], [data]);
  const n = timesteps.length;

  // Frame epoch-ms and time-proportional x positions. The forecast tail
  // has variable cadence (hourly → 3h → 6h); spacing by index would
  // compress the coarse tail (crammed day labels) and alias the diurnal
  // cycle into spikes. Place each frame at its true temporal position.
  const stepMs = useMemo(
    () => timesteps.map((iso) => Date.parse(iso)),
    [timesteps],
  );
  const fracs = useMemo(() => timeFractions(stepMs), [stepMs]);
  const xAt = useCallback(
    (i: number) => LEFT + (fracs.length ? fracs[i] : 0.5) * INNER_W,
    [fracs],
  );
  // Per-frame cell widths (px) for bars/bands so a coarse-cadence frame
  // spans its real interval instead of a uniform index slot.
  const cellW = useMemo(() => cellWidths(fracs, INNER_W), [fracs]);

  // Temperature in display units.
  const tConv = tempUnit.option.convert;
  const tempDisp = useMemo(() => {
    const raw = series(plan.t2m);
    return raw
      ? raw.map((v) => (v == null || Number.isNaN(v) ? null : tConv(v)))
      : null;
  }, [series, plan.t2m, tConv]);
  const tempBand = useMemo(() => {
    const conv = (vals: (number | null)[] | null) =>
      vals
        ? vals.map((v) => (v == null || Number.isNaN(v) ? null : tConv(v)))
        : null;
    return {
      p10: conv(series(plan.t2mBand ? "t_2m_p10" : null)),
      p90: conv(series(plan.t2mBand ? "t_2m_p90" : null)),
      p25: conv(series(plan.t2mInner ? "t_2m_p25" : null)),
      p75: conv(series(plan.t2mInner ? "t_2m_p75" : null)),
    };
  }, [series, plan.t2mBand, plan.t2mInner, tConv]);

  // Hourly precipitation (mm) — precip_1h is already the per-hour total.
  const precip = useMemo(() => {
    const raw = series(plan.precipVar);
    if (!raw) return null;
    return raw.map((v) => (v == null || Number.isNaN(v) ? null : Math.max(0, v)));
  }, [series, plan.precipVar]);
  const probPrec = useMemo(() => {
    const vs = series(plan.probPrec);
    // v2 /point serves exceedance as a 0..1 fraction — the 0–100 plot axis
    // needs percent (the line was squashed onto the baseline otherwise).
    return vs ? normalizeProbSeries(vs) : vs;
  }, [series, plan.probPrec]);

  // Day/night + day boundaries. Suppressed in lead mode (synthetic time —
  // solar elevation against synthetic instants is meaningless).
  const nightBands = useMemo(() => {
    if (timeFormat === "lead") return [];
    const bands: { x0: number; x1: number }[] = [];
    let start: number | null = null;
    for (let i = 0; i < n; i++) {
      const night = solarElevationDeg(stepMs[i], lat, lon) < -0.8;
      if (night && start == null) start = i;
      if (!night && start != null) {
        bands.push({ x0: xAt(start), x1: xAt(i) });
        start = null;
      }
    }
    if (start != null) bands.push({ x0: xAt(start), x1: xAt(n - 1) });
    return bands;
  }, [n, stepMs, lat, lon, xAt, timeFormat]);

  const dayTicks = useMemo(() => {
    const out: { idx: number; label: string }[] = [];
    const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let lastKey = "";
    // Lead mode: one tick per 24 lead hours ("+0d", "+1d", …).
    if (timeFormat === "lead" && Number.isFinite(leadReferenceMs())) {
      timesteps.forEach((iso, i) => {
        const ms = Date.parse(iso);
        if (Number.isNaN(ms)) return;
        const key = String(Math.floor(leadHoursOf(ms) / 24));
        if (key !== lastKey) {
          out.push({ idx: i, label: `+${key}d` });
          lastKey = key;
        }
      });
      return out;
    }
    timesteps.forEach((iso, i) => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return;
      const local = timeFormat === "local";
      const day = local ? d.getDate() : d.getUTCDate();
      const wd = local ? d.getDay() : d.getUTCDay();
      const key = `${local ? d.getMonth() : d.getUTCMonth()}-${day}`;
      if (key !== lastKey) {
        out.push({ idx: i, label: `${WEEKDAYS[wd]} ${day}` });
        lastKey = key;
      }
    });
    return out;
  }, [timesteps, timeFormat]);

  // Temperature y-scale (display units, left axis), envelope included.
  // Mapped across the full plot height so warm spells are allowed to
  // ride up into the cloud band.
  const tempScale = useMemo(() => {
    const all: number[] = [];
    for (const s of [tempDisp, tempBand.p10, tempBand.p90]) {
      if (!s) continue;
      for (const v of s) if (v != null && Number.isFinite(v)) all.push(v);
    }
    if (all.length === 0) return null;
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    const pad = Math.max(1, (hi - lo) * 0.12);
    lo -= pad;
    hi += pad;
    return {
      lo,
      hi,
      yAt: (v: number) =>
        PLOT_Y0 + 6 + (PLOT_H - 12) * (1 - (v - lo) / (hi - lo)),
    };
  }, [tempDisp, tempBand]);

  // Precip y-scale (right axis): bars anchored at the plot bottom,
  // capped to PRECIP_MAX_FRAC of the plot so heavy rain never buries
  // the temperature trace.
  const precipScale = useMemo(() => {
    let hi = 1;
    if (precip) {
      for (const v of precip) if (v != null && v > hi) hi = v;
    }
    hi *= 1.1;
    return {
      hi,
      yAt: (v: number) => PLOT_Y1 - (v / hi) * (PLOT_H * PRECIP_MAX_FRAC),
    };
  }, [precip]);

  // ── Active-product panel ──
  // Show the active map product as its own compact panel only when it
  // isn't already covered by a built-in panel (temperature, clouds,
  // precip, wind). The series is read by the same `series` helper, so
  // it's whatever the now-relative fetch returned for that id.
  // Friendly label + correct unit/convert via the shared describeVar (same as
  // the popup header / hover). A product without its own catalog row
  // (precip_1h_mean, …) still resolves the base variable's unit instead of
  // falling back to unitless raw values.
  const productDesc = useMemo(
    () =>
      activeProduct
        ? describeVar(activeProduct, modelVariables, unitPrefs)
        : null,
    [activeProduct, modelVariables, unitPrefs],
  );
  const productDisp = useMemo(() => {
    if (!activeProduct || PRODUCT_SKIP.has(activeProduct)) return null;
    const raw = series(activeProduct);
    if (!raw) return null;
    const conv = productDesc?.convert ?? ((v: number) => v);
    return raw.map((v) =>
      v == null || Number.isNaN(v) ? null : conv(v),
    );
  }, [activeProduct, series, productDesc]);
  // Probability products read 0–100 %; everything else auto-scales.
  const productIsProb = useMemo(() => {
    if (!activeProduct) return false;
    return (
      productDesc?.unitLabel === "%" ||
      activeProduct.startsWith("prob_") ||
      /_gt|_lt/.test(activeProduct)
    );
  }, [activeProduct, productDesc]);
  // Whether the panel renders (and therefore claims layout height).
  const productPanelOn = !!(
    productDisp && productDisp.some((v) => v != null && Number.isFinite(v))
  );


  // ── Pressure panel (pmsl) ── always on when the model carries it: a thin
  // line panel below the plot/product panel, in hPa (raw Pa auto-scaled).
  const pressDisp = useMemo(() => {
    const vals = plan.pmsl ? data?.values[plan.pmsl] : undefined;
    if (!vals) return null;
    const out = vals.map((v) => (v == null ? null : v > 2000 ? v / 100 : v));
    return out.some((v) => v != null && Number.isFinite(v)) ? out : null;
  }, [data, plan.pmsl]);
  const pressPanelOn = !!pressDisp;
  const PRESS_Y0 = PLOT_Y1 + (productPanelOn ? PRODUCT_PANEL_H : 0);
  const PRESS_Y1 = PRESS_Y0 + PRESSURE_PANEL_H;
  const pressScale = useMemo(() => {
    if (!pressDisp) return null;
    const all = pressDisp.filter((v): v is number => v != null && Number.isFinite(v));
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    const pad = Math.max(0.5, (hi - lo) * 0.12);
    lo -= pad;
    hi += pad;
    const top = PRESS_Y0 + 12;
    const bot = PRESS_Y1 - 4;
    return {
      lo,
      hi,
      yAt: (v: number) => (hi === lo ? (top + bot) / 2 : bot - (bot - top) * ((v - lo) / (hi - lo))),
    };
  }, [pressDisp, PRESS_Y0, PRESS_Y1]);

  // Layout: the product panel slots between the main plot and the
  // x-labels. TOTAL_H grows only when the panel renders.
  const TOTAL_H =
    DAY_LABEL_H +
    PLOT_H +
    (productPanelOn ? PRODUCT_PANEL_H : 0) +
    (pressPanelOn ? PRESSURE_PANEL_H : 0) +
    X_LABEL_H;
  const PRODUCT_Y0 = PLOT_Y1;
  const PRODUCT_Y1 = PRODUCT_Y0 + PRODUCT_PANEL_H;

  // Product y-scale (auto for non-prob; fixed 0–100 for probability).
  const productScale = useMemo(() => {
    if (!productPanelOn || !productDisp) return null;
    let lo: number;
    let hi: number;
    if (productIsProb) {
      lo = 0;
      hi = 100;
    } else {
      const all: number[] = [];
      for (const v of productDisp) {
        if (v != null && Number.isFinite(v)) all.push(v);
      }
      if (all.length === 0) return null;
      lo = Math.min(...all);
      hi = Math.max(...all);
      const pad = Math.max(0.5, (hi - lo) * 0.12);
      lo -= pad;
      hi += pad;
    }
    const top = PRODUCT_Y0 + 12;
    const bot = PRODUCT_Y1 - 4;
    return {
      lo,
      hi,
      yAt: (v: number) =>
        hi === lo ? (top + bot) / 2 : bot - (bot - top) * ((v - lo) / (hi - lo)),
    };
  }, [productPanelOn, productDisp, productIsProb, PRODUCT_Y0, PRODUCT_Y1]);

  const productLabel = productDesc?.label ?? "";


  const idxFromEvent = useCallback(
    (e: React.PointerEvent<SVGSVGElement>): number | null => {
      const svg = svgRef.current;
      if (!svg || n === 0) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return null;
      const xVb = ((e.clientX - rect.left) / rect.width) * W - LEFT;
      if (xVb < -8 || xVb > INNER_W + 8) return null;
      if (n === 1) return 0;
      // Invert the time-proportional axis: nearest frame by x-fraction,
      // not by uniform index (frames aren't evenly spaced in the tail).
      return Math.max(0, Math.min(n - 1, nearestFracIndex(fracs, xVb / INNER_W)));
    },
    [n, fracs],
  );

  // Map the GLOBAL active timestep into the LOCAL series by wall-clock:
  // the meteogram fetches a now-relative window, so its index space no
  // longer matches the global timeline. Fall back to a direct clamp when
  // the global timeline is empty (keeps it working without globalTimesteps).
  const activeMs = Number.isFinite(Date.parse(globalTimesteps[activeTimestep] ?? ""))
    ? Date.parse(globalTimesteps[activeTimestep])
    : NaN;
  const clampedActive =
    n > 0 && Number.isFinite(activeMs)
      ? nearestTimestepIndex(timesteps, activeMs)
      : Math.max(0, Math.min(n - 1, activeTimestep));
  const focusIdx = hoverIdx ?? clampedActive;

  // Map a LOCAL pick back to a GLOBAL timestep index (by wall-clock)
  // before notifying the parent. Hover stays local (popup-only).
  const pickGlobal = useCallback(
    (localIdx: number) => {
      const localIso = timesteps[localIdx];
      if (globalTimesteps.length && localIso) {
        onTimestepChange(
          nearestTimestepIndex(globalTimesteps, Date.parse(localIso)),
        );
      } else {
        onTimestepChange(localIdx);
      }
    },
    [timesteps, globalTimesteps, onTimestepChange],
  );

  const barbRows = useMemo<BarbRow[]>(() => {
    if (!data) return [];
    const rows: BarbRow[] = [];
    for (const r of plan.windRows) {
      const vals = data.values[r.id];
      // Drop all-null rows: a run ingested before the paired wind_10m archive
      // landed advertises the capability but serves nothing — show the rows
      // that have data instead of empty percentile strips.
      if (vals && vals.some((v) => v != null)) rows.push({ label: r.label, speeds: vals });
    }
    return rows;
  }, [data, plan.windRows]);
  const uVals = data?.values["u_10m"];
  const vVals = data?.values["v_10m"];

  if (error) return <div className="point-error">{error}</div>;
  if (!data) return <div className="point-loading">Loading…</div>;
  if (n === 0) return <div className="point-chart-empty">No data</div>;

  const focusTemp =
    tempDisp && focusIdx < tempDisp.length ? tempDisp[focusIdx] : null;
  const focusPrecip =
    precip && focusIdx < precip.length ? precip[focusIdx] : null;
  const focusProb =
    probPrec && focusIdx < probPrec.length ? probPrec[focusIdx] : null;
  // Per-frame slot/bar widths from the time-proportional cells, so the
  // coarse-cadence tail draws wider bars/bands (no uniform-index gaps).
  const slotW = (i: number) => cellW[i] ?? INNER_W;
  const barWAt = (i: number) => Math.max(1, Math.min(slotW(i) * 0.85, 10));

  return (
    <div className="meteogram">
      <div className="meteogram-focus">
        <span className="meteogram-focus-time">
          {timesteps[focusIdx]
            ? formatStatusTime(timesteps[focusIdx], timeFormat)
            : "—"}
        </span>
        <span className="meteogram-focus-vals">
          {focusTemp != null && (
            <b>
              {focusTemp.toFixed(1)} {tempUnit.option.label}
            </b>
          )}
          {focusPrecip != null && focusPrecip > 0 && (
            <span> · {focusPrecip.toFixed(1)} mm/h</span>
          )}
          {focusProb != null && (
            <span>
              {" "}
              · {Math.round(focusProb)}% &gt;
              {plan.probPrec?.match(/_gt(\d+(?:p\d+)?)mm/)?.[1]?.replace("p", ".") ?? "1"}
              mm
            </span>
          )}
        </span>
      </div>
      <svg
        ref={svgRef}
        className="point-chart-svg meteogram-svg"
        viewBox={`0 0 ${W} ${TOTAL_H}`}
        onPointerMove={(e) => onHoverIdx(idxFromEvent(e))}
        onPointerLeave={() => onHoverIdx(null)}
        onPointerDown={(e) => {
          const idx = idxFromEvent(e);
          if (idx != null) pickGlobal(idx);
        }}
        role="img"
        aria-label="Meteogram"
      >
        {/* night shading across all panels */}
        {nightBands.map((b, i) => (
          <rect
            key={`n${i}`}
            x={b.x0}
            y={DAY_LABEL_H}
            width={Math.max(0, b.x1 - b.x0)}
            height={TOTAL_H - DAY_LABEL_H - X_LABEL_H}
            className="meteogram-night"
          />
        ))}

        {/* day boundaries + labels */}
        {dayTicks.map(({ idx, label }) => (
          <g key={`d${idx}`}>
            <line
              x1={xAt(idx)}
              y1={DAY_LABEL_H}
              x2={xAt(idx)}
              y2={TOTAL_H - X_LABEL_H}
              className="meteogram-dayline"
            />
            <text x={xAt(idx) + 3} y={DAY_LABEL_H - 4} className="meteogram-daylabel">
              {label}
            </text>
          </g>
        ))}

        {/* Paint order inside the shared plot (back → front):
            clouds (top band) → precip bars (right axis, bottom) →
            >1mm probability line → temperature envelope → temperature
            line. The temperature trace is allowed to ride over the
            cloud band. */}

        {/* ── Cloud band, pinned to the top of the plot ── */}
        {plan.clouds.length > 0 &&
          (() => {
            // Render order top→bottom: high, mid, low (or single clct).
            const order =
              plan.clouds.length === 3 ? ["clch", "clcm", "clcl"] : ["clct"];
            const labels =
              plan.clouds.length === 3 ? ["H", "M", "L"] : ["☁"];
            const rowH = CLOUD_BAND_H / order.length;
            return order.map((cv, r) => {
              const vals = series(cv);
              const y = PLOT_Y0 + r * rowH;
              return (
                <g key={cv}>
                  <text
                    x={LEFT + INNER_W + 4}
                    y={y + rowH / 2 + 3}
                    textAnchor="start"
                    className="point-chart-tick"
                  >
                    {labels[r]}
                  </text>
                  {vals?.map((v, i) =>
                    v == null || v <= 1 ? null : (
                      <rect
                        key={i}
                        x={xAt(i) - slotW(i) / 2}
                        y={y + 1}
                        width={slotW(i) + 0.5}
                        height={rowH - 2}
                        className="meteogram-cloud"
                        style={{ fillOpacity: 0.85 * Math.min(1, v / 100) }}
                      />
                    ),
                  )}
                </g>
              );
            });
          })()}

        {/* ── Precip bars (right axis), under the temperature trace ── */}
        <g>
          {[precipScale.hi / 1.1].map((v, i) => (
            <text
              key={`py${i}`}
              x={LEFT + INNER_W + 4}
              y={precipScale.yAt(v) + 3}
              textAnchor="start"
              className="point-chart-tick meteogram-precip-tick"
            >
              {v < 10 ? v.toFixed(1) : String(Math.round(v))}
            </text>
          ))}
          <text
            x={LEFT + INNER_W + 4}
            y={PLOT_Y1 - 1}
            textAnchor="start"
            className="point-chart-tick meteogram-precip-tick"
          >
            mm
          </text>
          {precip?.map((v, i) =>
            v == null || v <= 0 ? null : (
              <rect
                key={i}
                x={xAt(i) - barWAt(i) / 2}
                y={precipScale.yAt(v)}
                width={barWAt(i)}
                height={PLOT_Y1 - precipScale.yAt(v)}
                className="meteogram-precip-bar"
              />
            ),
          )}
          {probPrec &&
            linePaths(
              probPrec,
              xAt,
              (v) => PLOT_Y1 - (v / 100) * (PLOT_H * PRECIP_MAX_FRAC),
            ).map((d, i) => (
              <path key={`pp${i}`} d={d} className="meteogram-prob-line" />
            ))}
        </g>

        {/* ── Temperature (left axis), drawn over clouds + precip ── */}
        {tempScale && (
          <g>
            {[tempScale.lo, (tempScale.lo + tempScale.hi) / 2, tempScale.hi].map(
              (v, i) => (
                <text
                  key={`ty${i}`}
                  x={LEFT - 4}
                  y={tempScale.yAt(v) + 3}
                  textAnchor="end"
                  className="point-chart-tick"
                >
                  {Math.round(v)}
                </text>
              ),
            )}
            {/* 0° line when in range (only meaningful for °C/°F) */}
            {tempScale.lo < 0 && tempScale.hi > 0 && (
              <line
                x1={LEFT}
                y1={tempScale.yAt(0)}
                x2={LEFT + INNER_W}
                y2={tempScale.yAt(0)}
                className="meteogram-zero"
              />
            )}
            {tempBand.p10 &&
              tempBand.p90 &&
              bandPaths(tempBand.p10, tempBand.p90, xAt, tempScale.yAt).map(
                (d, i) => (
                  <path key={`tb${i}`} d={d} className="meteogram-temp-band" />
                ),
              )}
            {tempBand.p25 &&
              tempBand.p75 &&
              bandPaths(tempBand.p25, tempBand.p75, xAt, tempScale.yAt).map(
                (d, i) => (
                  <path
                    key={`tbi${i}`}
                    d={d}
                    className="meteogram-temp-band inner"
                  />
                ),
              )}
            {tempDisp &&
              linePaths(tempDisp, xAt, tempScale.yAt).map((d, i) => (
                <path key={`tl${i}`} d={d} className="meteogram-temp-line" />
              ))}
          </g>
        )}

        {/* ── Pressure panel (pmsl, hPa) ── */}
        {pressPanelOn && pressScale && pressDisp && (
          <g className="meteogram-pressure">
            <line
              x1={LEFT}
              y1={PRESS_Y0}
              x2={LEFT + INNER_W}
              y2={PRESS_Y0}
              className="meteogram-dayline"
            />
            <text
              x={LEFT}
              y={PRESS_Y0 + 9}
              className="point-chart-tick"
              style={{ opacity: 0.7 }}
            >
              Pressure [hPa]
            </text>
            <text
              x={LEFT - 4}
              y={pressScale.yAt(pressScale.hi) + 3}
              textAnchor="end"
              className="point-chart-tick"
            >
              {Math.round(pressScale.hi)}
            </text>
            <text
              x={LEFT - 4}
              y={pressScale.yAt(pressScale.lo) + 3}
              textAnchor="end"
              className="point-chart-tick"
            >
              {Math.round(pressScale.lo)}
            </text>
            {linePaths(pressDisp, xAt, pressScale.yAt).map((d, i) => (
              <path key={`ps${i}`} d={d} fill="none" stroke="#9fb8d0" strokeWidth={1.2} />
            ))}
            {focusIdx >= 0 && focusIdx < pressDisp.length && pressDisp[focusIdx] != null && (
              <>
                <circle
                  cx={xAt(focusIdx)}
                  cy={pressScale.yAt(pressDisp[focusIdx]!)}
                  r={2.5}
                  fill="#9fb8d0"
                />
                <text
                  x={LEFT + INNER_W}
                  y={PRESS_Y0 + 9}
                  textAnchor="end"
                  className="point-chart-tick"
                >
                  {pressDisp[focusIdx]!.toFixed(1)} hPa
                </text>
              </>
            )}
          </g>
        )}

        {/* ── Active-product panel (under the main plot) ── */}
        {productPanelOn && productScale && productDisp && (
          <g className="meteogram-product">
            {/* separator above the panel */}
            <line
              x1={LEFT}
              y1={PRODUCT_Y0}
              x2={LEFT + INNER_W}
              y2={PRODUCT_Y0}
              className="meteogram-dayline"
            />
            {/* label + unit */}
            <text
              x={LEFT}
              y={PRODUCT_Y0 + 9}
              className="point-chart-tick"
              style={{ opacity: 0.7 }}
            >
              {productLabel}
              {productDesc?.unitLabel ? ` [${productDesc.unitLabel}]` : ""}
            </text>
            {/* y-axis min/max labels */}
            <text
              x={LEFT - 4}
              y={productScale.yAt(productScale.hi) + 3}
              textAnchor="end"
              className="point-chart-tick"
            >
              {Math.round(productScale.hi)}
            </text>
            <text
              x={LEFT - 4}
              y={productScale.yAt(productScale.lo) + 3}
              textAnchor="end"
              className="point-chart-tick"
            >
              {Math.round(productScale.lo)}
            </text>
            {/* series trace */}
            {linePaths(productDisp, xAt, productScale.yAt).map((d, i) => (
              <path
                key={`pr${i}`}
                d={d}
                fill="none"
                stroke={PRODUCT_COLOR}
                strokeWidth={1.5}
              />
            ))}
            {/* focus marker dot */}
            {focusIdx >= 0 &&
              focusIdx < productDisp.length &&
              productDisp[focusIdx] != null && (
                <circle
                  cx={xAt(focusIdx)}
                  cy={productScale.yAt(productDisp[focusIdx]!)}
                  r={2.5}
                  fill={PRODUCT_COLOR}
                />
              )}
          </g>
        )}

        {/* focus rule across all panels */}
        {focusIdx >= 0 && focusIdx < n && (
          <line
            x1={xAt(focusIdx)}
            y1={DAY_LABEL_H}
            x2={xAt(focusIdx)}
            y2={TOTAL_H - X_LABEL_H}
            className={`point-chart-marker${hoverIdx != null ? " hover" : ""}`}
          />
        )}
      </svg>
      {barbRows.length > 0 && uVals && vVals && (
        <WindBarbs
          timesteps={timesteps}
          u={uVals}
          v={vVals}
          rows={barbRows}
          activeTimestep={clampedActive}
          hoverIdx={hoverIdx}
          onHoverIdx={onHoverIdx}
          onPickIdx={pickGlobal}
          timeFormat={timeFormat}
        />
      )}
    </div>
  );
}
