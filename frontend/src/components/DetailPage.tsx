import { useEffect, useMemo, useState } from "react";
import type { Model, PointTimeSeriesResponse, TimeFormat, Variable } from "../api/types";
import { fetchV2PointSeries, fetchV2Point, normalizeProbSeries } from "../api/v2client";
import { formatStatusTime, leadReferenceMs, leadHoursOf } from "../time";
import WindBarbs from "./WindBarbs";
import type { BarbRow } from "./WindBarbs";
import MultiModelCharts from "./MultiModelCharts";
import { solarElevationDeg } from "../lib/solar";

// DetailPage: a full-page, linkable (#…&pt=lat,lon&pv=detail|multi)
// per-location view. Two tabs:
//   - Overview: the model's series arranged into dense, meteogram-styled
//     sections — temperature with the cloud rows pinned at the top of its
//     panel, precip bars with the rain-probability overlay, wind lines + a
//     wind-barb strip, pressure, radiation, and snow depth (only when the
//     model actually reports snow). Night shading throughout.
//   - Multi-model: every physical NWP model compared at the point
//     (MultiModelCharts, wide geometry).

const W = 860;
const LEFT = 48;
const RIGHT = 16;
const INNER_W = W - LEFT - RIGHT;
const PANEL_H = 92;
const TEMP_PANEL_H = 150;
const CLOUD_BAND_H = 26;
const AXIS_H = 18;

interface SeriesSpec {
  id: string;
  label: string;
  color: string;
  kind: "line" | "bars" | "area" | "dashed";
  /** Convert a raw API value to display units. */
  conv?: (v: number) => number;
}

interface PanelSpec {
  title: string;
  unit: string;
  series: SeriesSpec[];
  /** Optional band pair (converted like series[0]). */
  band?: { lo: string; hi: string; color: string };
  fixed0100?: boolean;
  /** Taller panel with cloud-cover rows pinned at its top (meteogram style). */
  cloudRows?: string[];
  /** Dashed 0–100 % overlay on its own right-hand scale (rain probability). */
  overlay?: SeriesSpec;
  /** Render only when some sample satisfies this (e.g. snow depth > 0). */
  showIf?: (vals: (number | null)[]) => boolean;
}

interface SectionSpec {
  title: string;
  panels: PanelSpec[];
}

const K2C = (v: number) => v - 273.15;
const MS2KMH = (v: number) => v * 3.6;
const PA2HPA = (v: number) => (v > 2000 ? v / 100 : v);
const M2CM = (v: number) => v * 100;

/** Build the section plan from the model's catalog. */
function buildSections(
  has: (n: string) => boolean,
  pcts: (n: string) => number[] | undefined,
  siteElev: number | null,
): SectionSpec[] {
  const out: SectionSpec[] = [];

  if (has("t_2m")) {
    const band = (pcts("t_2m") ?? []).includes(10) && (pcts("t_2m") ?? []).includes(90);
    const cloudRows = ["clcl", "clcm", "clch"].every(has)
      ? ["clch", "clcm", "clcl"]
      : has("clct")
        ? ["clct"]
        : [];
    out.push({
      title: "Temperature & clouds",
      panels: [
        {
          // Screen temps are lapse-corrected server-side to the site DEM
          // elevation — say so, it's why every model reads plausibly here.
          title: siteElev != null ? `2 m temperature · ⛰ at ${Math.round(siteElev)} m` : "2 m temperature",
          unit: "°C",
          cloudRows,
          series: [{ id: "t_2m", label: "t_2m", color: "#e8a33d", kind: "line", conv: K2C }],
          band: band ? { lo: "t_2m_p10", hi: "t_2m_p90", color: "#e8a33d" } : undefined,
        },
      ],
    });
  }

  const rainPanels: PanelSpec[] = [];
  if (has("tot_prec")) {
    rainPanels.push({
      title: "hourly precipitation · chance ≥ 1 mm/h",
      unit: "mm/h",
      series: [{ id: "precip_1h", label: "precip_1h", color: "#4aa3df", kind: "bars" }],
      overlay: { id: "prob_prec_gt1mm", label: "P(≥1mm)", color: "#4aa3df", kind: "dashed" },
    });
  }
  if (has("h_snow")) {
    rainPanels.push({
      title: "snow depth",
      unit: "cm",
      series: [{ id: "h_snow", label: "h_snow", color: "#cfe3f5", kind: "area", conv: M2CM }],
      // Only when the model actually reports snow at this point — a flat
      // zero panel is noise most of the year.
      showIf: (vals) => vals.some((v) => v != null && v > 0.005),
    });
  }
  if (rainPanels.length > 0) out.push({ title: "Precipitation", panels: rainPanels });

  if (has("u_10m") && has("v_10m")) {
    out.push({
      title: "Wind",
      panels: [
        {
          title: "10 m wind / gusts",
          unit: "km/h",
          series: [
            { id: "wind_speed_10m", label: "wind", color: "#e8a33d", kind: "line", conv: MS2KMH },
            ...(has("vmax_10m")
              ? [{ id: "vmax_10m", label: "gusts", color: "#5bc8af", kind: "line" as const, conv: MS2KMH }]
              : []),
          ],
        },
      ],
    });
  }

  if (has("pmsl")) {
    out.push({
      title: "Pressure",
      panels: [
        {
          title: "mean sea-level pressure",
          unit: "hPa",
          series: [{ id: "pmsl", label: "pmsl", color: "#9fb8d0", kind: "line", conv: PA2HPA }],
        },
      ],
    });
  }

  if (has("aswdir_s") || has("global_rad") || has("glob_s")) {
    out.push({
      title: "Radiation",
      panels: [
        {
          title: "global radiation",
          unit: "W/m²",
          series: [{ id: "global_rad", label: "GHI", color: "#e8d34a", kind: "area" }],
        },
      ],
    });
  }

  return out;
}

/** SVG path segments for a series (nulls split segments). */
function linePathsD(vals: (number | null)[], xAt: (i: number) => number, yAt: (v: number) => number): string[] {
  const out: string[] = [];
  let d = "";
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v == null || !Number.isFinite(v)) {
      if (d) out.push(d);
      d = "";
      continue;
    }
    d += `${d ? " L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`;
  }
  if (d) out.push(d);
  return out;
}

function Panel({
  spec,
  data,
  dayTicks,
  nightBands,
}: {
  spec: PanelSpec;
  data: PointTimeSeriesResponse;
  dayTicks: { idx: number; label: string }[];
  nightBands: { x0: number; x1: number }[];
}) {
  const n = data.timesteps.length;
  const xAt = (i: number) => LEFT + (INNER_W * i) / Math.max(1, n - 1);
  const panelH = spec.cloudRows?.length ? TEMP_PANEL_H : PANEL_H;
  const cloudH = spec.cloudRows?.length ? CLOUD_BAND_H : 0;

  const conv0 = spec.series[0]?.conv ?? ((v: number) => v);
  const seriesVals = spec.series.map((sp) => {
    const raw = data.values[sp.id];
    const c = sp.conv ?? ((v: number) => v);
    return raw ? raw.map((v) => (v == null ? null : c(v))) : null;
  });
  const bandLo = spec.band ? data.values[spec.band.lo]?.map((v) => (v == null ? null : conv0(v))) : null;
  const bandHi = spec.band ? data.values[spec.band.hi]?.map((v) => (v == null ? null : conv0(v))) : null;
  const overlayRaw = spec.overlay ? data.values[spec.overlay.id] : null;
  // v2 /point serves exceedance as a 0..1 fraction — the 0–100% overlay scale
  // needs percent.
  const overlayVals = overlayRaw ? normalizeProbSeries(overlayRaw) : null;

  const hasData = seriesVals.some((vs) => vs?.some((v) => v != null));
  const { lo, hi } = useMemo(() => {
    if (spec.fixed0100) return { lo: 0, hi: 100 };
    const all: number[] = [];
    for (const vs of [...seriesVals, bandLo, bandHi]) {
      if (vs) for (const v of vs) if (v != null && Number.isFinite(v)) all.push(v);
    }
    if (all.length === 0) return { lo: 0, hi: 1 };
    let l = Math.min(...all);
    let h = Math.max(...all);
    const barsOnly = spec.series.every((sp) => sp.kind === "bars" || sp.kind === "area");
    if (barsOnly && l > 0) l = 0;
    if (h === l) h = l + 1;
    const pad = (h - l) * 0.08;
    let lo2 = l - (barsOnly ? 0 : pad);
    if (l >= 0 && lo2 < 0) lo2 = 0; // non-negative data must not pad below zero
    return { lo: lo2, hi: h + pad };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- derived from data identity
  }, [data, spec]);

  if (!hasData) return null;
  if (spec.showIf && !seriesVals.some((vs) => vs && spec.showIf!(vs))) return null;
  // Data band under the cloud rows; the temperature trace may ride into them.
  const yAt = (v: number) =>
    cloudH / 2 + AXIS_H / 2 + (panelH - AXIS_H - cloudH / 2) * (1 - (v - lo) / (hi - lo));
  const bot = yAt(lo);
  const span = hi - lo;
  const fmt = (v: number) => (span > 5 ? v.toFixed(0) : v.toFixed(1));
  const barW = Math.max(1, ((INNER_W / Math.max(1, n)) * 0.7));
  const overlayY = (v: number) => bot - (v / 100) * (panelH - AXIS_H) * 0.6;

  return (
    <div className="detail-panel">
      <div className="detail-panel-title">
        {spec.title} <span className="detail-panel-unit">[{spec.unit}]</span>
      </div>
      <svg viewBox={`0 0 ${W} ${panelH + AXIS_H}`} className="detail-panel-svg" role="img" aria-label={spec.title}>
        {nightBands.map((b, i) => (
          <rect
            key={`n${i}`}
            x={b.x0}
            y={0}
            width={Math.max(0, b.x1 - b.x0)}
            height={bot}
            className="meteogram-night"
          />
        ))}
        {dayTicks.map(({ idx, label }) => (
          <g key={idx}>
            <line x1={xAt(idx)} y1={0} x2={xAt(idx)} y2={bot} className="detail-gridline" />
            <text x={xAt(idx) + 3} y={panelH + AXIS_H - 5} className="detail-tick">
              {label}
            </text>
          </g>
        ))}
        {/* cloud-cover rows pinned at the top of the panel (meteogram style) */}
        {spec.cloudRows?.map((cv, r) => {
          const rows = spec.cloudRows!.length;
          const rowH = CLOUD_BAND_H / rows;
          const yTop = 1 + r * rowH;
          const vals = data.values[cv];
          const labels = rows === 3 ? ["H", "M", "L"] : ["☁"];
          return (
            <g key={cv}>
              <text x={LEFT + INNER_W + 3} y={yTop + rowH / 2 + 3} className="detail-tick">
                {labels[r]}
              </text>
              {vals?.map((v, i) =>
                v == null || v <= 1 ? null : (
                  <rect
                    key={i}
                    x={xAt(i) - (INNER_W / Math.max(1, n - 1)) / 2}
                    y={yTop}
                    width={INNER_W / Math.max(1, n - 1) + 0.5}
                    height={rowH - 1.5}
                    className="meteogram-cloud"
                    style={{ fillOpacity: 0.85 * Math.min(1, v / 100) }}
                  />
                ),
              )}
            </g>
          );
        })}
        <line x1={LEFT} y1={bot} x2={LEFT + INNER_W} y2={bot} className="detail-axis" />
        {/* horizontal range hints: labeled inner gridlines at ¼, ½, ¾ */}
        {[0.25, 0.5, 0.75].map((f) => {
          const v = lo + (hi - lo) * f;
          return (
            <g key={f}>
              <line x1={LEFT} y1={yAt(v)} x2={LEFT + INNER_W} y2={yAt(v)} className="detail-gridline-h" />
              <text x={LEFT - 5} y={yAt(v) + 3} textAnchor="end" className="detail-tick">
                {fmt(v)}
              </text>
            </g>
          );
        })}
        <text x={LEFT - 5} y={yAt(hi) + 8} textAnchor="end" className="detail-tick">
          {fmt(hi)}
        </text>
        <text x={LEFT - 5} y={bot} textAnchor="end" className="detail-tick">
          {fmt(lo)}
        </text>
        {bandLo && bandHi && spec.band && (
          <polygon
            points={[
              ...bandHi.map((v, i) => (v == null ? null : `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`)),
              ...bandLo
                .map((v, i) => (v == null ? null : `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`))
                .reverse(),
            ]
              .filter(Boolean)
              .join(" ")}
            fill={spec.band.color}
            opacity={0.2}
          />
        )}
        {spec.series.map((sp, si) => {
          const vals = seriesVals[si];
          if (!vals) return null;
          if (sp.kind === "bars") {
            return (
              <g key={sp.id} fill={sp.color}>
                {vals.map((v, i) =>
                  v == null || v <= 0 ? null : (
                    <rect key={i} x={xAt(i) - barW / 2} y={yAt(v)} width={barW} height={bot - yAt(v)} />
                  ),
                )}
              </g>
            );
          }
          if (sp.kind === "area") {
            const pts = vals
              .map((v, i) => (v == null ? null : `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`))
              .filter(Boolean) as string[];
            if (pts.length < 2) return null;
            const x0 = pts[0].split(",")[0];
            const x1 = pts[pts.length - 1].split(",")[0];
            return (
              <polygon
                key={sp.id}
                points={`${x0},${bot} ${pts.join(" ")} ${x1},${bot}`}
                fill={sp.color}
                opacity={0.4}
              />
            );
          }
          return linePathsD(vals, xAt, yAt).map((d, di) => (
            <path
              key={`${sp.id}-${di}`}
              d={d}
              fill="none"
              stroke={sp.color}
              strokeWidth={1.5}
              strokeDasharray={sp.kind === "dashed" ? "4,3" : undefined}
            />
          ));
        })}
        {/* dashed 0–100 % overlay (rain probability) on its own scale */}
        {overlayVals && spec.overlay && (
          <>
            {linePathsD(overlayVals, xAt, overlayY).map((d, di) => (
              <path
                key={`ov-${di}`}
                d={d}
                fill="none"
                stroke={spec.overlay!.color}
                strokeWidth={1}
                strokeDasharray="3,2"
                opacity={0.9}
              />
            ))}
            <text x={LEFT + INNER_W + 3} y={overlayY(100) + 3} className="detail-tick">
              %
            </text>
          </>
        )}
        {spec.series.length > 1 &&
          spec.series.map((sp, si) => (
            <text key={sp.id} x={LEFT + INNER_W - 4} y={14 + si * 12} textAnchor="end" fill={sp.color} className="detail-legend">
              {sp.label}
            </text>
          ))}
      </svg>
    </div>
  );
}

interface Props {
  model: string;
  lat: number;
  lon: number;
  placeLabel?: string;
  modelVariables: Variable[];
  /** Full model catalog — the multi-model view compares every physical model. */
  allModels: Model[];
  /** Active map product — the multi-model view's fourth panel. */
  activeProduct?: string;
  unitPrefs: Record<string, string>;
  timesteps: string[];
  run?: string;
  timeFormat: TimeFormat;
  /** Which tab is shown; synced to the #…&pv= hash (linkable). */
  view: "detail" | "multi";
  onViewChange: (v: "detail" | "multi") => void;
  onClose: () => void;
}

export default function DetailPage({
  model,
  lat,
  lon,
  placeLabel,
  modelVariables,
  allModels,
  activeProduct,
  unitPrefs,
  timesteps,
  run,
  timeFormat,
  view,
  onViewChange,
  onClose,
}: Props) {
  // Declared before the sections memo below reads it (TDZ).
  const [siteElev, setSiteElev] = useState<number | null>(null);
  const has = (n: string) => modelVariables.some((v) => v.name === n);
  const pcts = (n: string) => modelVariables.find((v) => v.name === n)?.percentiles;
  const sections = useMemo(
    () => buildSections(has, pcts, siteElev),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalog identity
    [modelVariables, siteElev],
  );

  // Wind-barb strip plan (meteogram parity): median u/v direction + the
  // wind_10m speed-percentile rows when the model publishes them.
  const barbPlan = useMemo(() => {
    if (!has("u_10m") || !has("v_10m")) return null;
    const windPcts = pcts("wind_10m") ?? pcts("u_10m");
    const rows: { label: string; id: string }[] =
      windPcts?.includes(25) && windPcts.includes(75)
        ? [
            { label: "p25", id: "wind_speed_10m_p25" },
            { label: "p50", id: "wind_speed_10m" },
            { label: "p75", id: "wind_speed_10m_p75" },
          ]
        : [{ label: "wind", id: "wind_speed_10m" }];
    return { rows };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalog identity
  }, [modelVariables]);

  const fetchVars = useMemo(() => {
    const ids = new Set<string>();
    for (const sec of sections) {
      for (const p of sec.panels) {
        for (const sp of p.series) ids.add(sp.id);
        if (p.band) {
          ids.add(p.band.lo);
          ids.add(p.band.hi);
        }
        for (const cv of p.cloudRows ?? []) ids.add(cv);
        if (p.overlay) ids.add(p.overlay.id);
      }
    }
    if (barbPlan) {
      ids.add("u_10m");
      ids.add("v_10m");
      for (const r of barbPlan.rows) ids.add(r.id);
    }
    return [...ids];
  }, [sections, barbPlan]);

  const [data, setData] = useState<PointTimeSeriesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [barbHover, setBarbHover] = useState<number | null>(null);

  useEffect(() => {
    if (view !== "detail" || timesteps.length === 0 || fetchVars.length === 0) return;
    const ac = new AbortController();
    setData(null);
    setError(null);
    fetchV2PointSeries(model, fetchVars, lat, lon, timesteps, run ?? "", ac.signal)
      .then(setData)
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(String((e as Error)?.message ?? e));
      });
    return () => ac.abort();
  }, [model, lat, lon, timesteps, run, fetchVars, view]);

  useEffect(() => {
    const ac = new AbortController();
    fetchV2Point(model, "t_2m", lat, lon, {}, ac.signal)
      .then((r) => setSiteElev(r.elevation ?? null))
      .catch(() => {});
    return () => ac.abort();
  }, [model, lat, lon]);

  // Esc closes, like ModelInfoPage.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dayTicks = useMemo(() => {
    if (!data) return [];
    const out: { idx: number; label: string }[] = [];
    let prev = "";
    // Lead mode: one tick per 24 lead hours ("+0d", "+1d", …).
    if (timeFormat === "lead" && Number.isFinite(leadReferenceMs())) {
      data.timesteps.forEach((ts, i) => {
        const ms = Date.parse(ts);
        if (Number.isNaN(ms)) return;
        const key = String(Math.floor(leadHoursOf(ms) / 24));
        if (key !== prev) {
          if (i > 0) out.push({ idx: i, label: `+${key}d` });
          prev = key;
        }
      });
      return out;
    }
    data.timesteps.forEach((ts, i) => {
      const d = new Date(ts);
      const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      if (key !== prev) {
        prev = key;
        if (i > 0) out.push({ idx: i, label: d.toLocaleDateString(undefined, { weekday: "short", day: "2-digit" }) });
      }
    });
    return out;
  }, [data, timeFormat]);

  // Night shading shared by every panel (computed once from the axis).
  // Suppressed in lead mode (synthetic time).
  const nightBands = useMemo(() => {
    if (!data) return [];
    if (timeFormat === "lead") return [];
    const n = data.timesteps.length;
    const xAt = (i: number) => LEFT + (INNER_W * i) / Math.max(1, n - 1);
    const out: { x0: number; x1: number }[] = [];
    let start: number | null = null;
    for (let i = 0; i < n; i++) {
      const night = solarElevationDeg(Date.parse(data.timesteps[i]), lat, lon) < -0.8;
      if (night && start == null) start = i;
      if (!night && start != null) {
        out.push({ x0: xAt(start), x1: xAt(i) });
        start = null;
      }
    }
    if (start != null) out.push({ x0: xAt(start), x1: xAt(n - 1) });
    return out;
  }, [data, lat, lon, timeFormat]);

  const barbRows = useMemo<BarbRow[] | null>(() => {
    if (!data || !barbPlan) return null;
    const rows: BarbRow[] = [];
    for (const r of barbPlan.rows) {
      const vals = data.values[r.id];
      if (vals && vals.some((v) => v != null)) rows.push({ label: r.label, speeds: vals });
    }
    return rows.length > 0 ? rows : null;
  }, [data, barbPlan]);
  const barbU = data?.values["u_10m"];
  const barbV = data?.values["v_10m"];

  const coordsText = `${lat.toFixed(3)}°N, ${lon.toFixed(3)}°E`;

  return (
    <div className="detail-page">
      <div className="detail-page-header">
        <div>
          <h1>{placeLabel ?? coordsText}</h1>
          <div className="detail-page-sub">
            {placeLabel ? `${coordsText} · ` : ""}
            {siteElev != null ? `⛰ ${Math.round(siteElev)} m · ` : ""}
            {view === "multi" ? "all models" : model}
            {view === "detail" && data?.timesteps.length
              ? ` · ${formatStatusTime(data.timesteps[0], timeFormat)} → ${formatStatusTime(
                  data.timesteps[data.timesteps.length - 1],
                  timeFormat,
                )}`
              : ""}
          </div>
        </div>
        <span className="point-popup-actions">
          <span className="toggle-group detail-page-tabs">
            <button
              type="button"
              className={`toggle-btn${view === "detail" ? " active" : ""}`}
              onClick={() => onViewChange("detail")}
            >
              Overview
            </button>
            <button
              type="button"
              className={`toggle-btn${view === "multi" ? " active" : ""}`}
              onClick={() => onViewChange("multi")}
            >
              Multi-model
            </button>
          </span>
          <button className="close-btn" onClick={onClose} aria-label="Back to the map">
            &times;
          </button>
        </span>
      </div>
      <div className="detail-page-body">
        {view === "multi" && (
          <MultiModelCharts
            models={allModels}
            lat={lat}
            lon={lon}
            activeProduct={activeProduct}
            unitPrefs={unitPrefs}
            timeFormat={timeFormat}
            wide
          />
        )}
        {view === "detail" && error && <div className="point-error">{error}</div>}
        {view === "detail" && !data && !error && <div className="point-loading">Loading…</div>}
        {view === "detail" &&
          data &&
          sections.map((sec) => (
            <section key={sec.title} className="detail-section">
              <h2>{sec.title}</h2>
              {sec.panels.map((p) => (
                <Panel key={p.title} spec={p} data={data} dayTicks={dayTicks} nightBands={nightBands} />
              ))}
              {sec.title === "Wind" && barbRows && barbU && barbV && (
                <div className="detail-panel">
                  <WindBarbs
                    timesteps={data.timesteps}
                    u={barbU}
                    v={barbV}
                    rows={barbRows}
                    activeTimestep={0}
                    hoverIdx={barbHover}
                    onHoverIdx={setBarbHover}
                    onPickIdx={() => {}}
                    timeFormat={timeFormat}
                    geom={{ w: W, left: LEFT, right: RIGHT, maxBarbs: 36 }}
                  />
                </div>
              )}
            </section>
          ))}
      </div>
    </div>
  );
}
