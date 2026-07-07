import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Model, TimeFormat, Variable } from "../api/types";
import { splitEnsembleVar } from "../api/types";
import { describeVar } from "../api/varDisplay";
import { fetchV2Meta, fetchV2Point, fetchV2PointSeries } from "../api/v2client";
import { formatStatusTime, nearestTimestepIndex, leadReferenceMs, leadHoursOf } from "../time";
import { solarElevationDeg } from "../lib/solar";

// ---------------------------------------------------------------------------
// MultiModelCharts — meteoblue-multimodel-style comparison of every physical
// NWP model at one point: stacked panels (temperature with per-model p10–p90
// bands, hourly precip bars, wind) plus the active map product when it isn't
// one of those. Each model is fetched over its OWN native timeline and drawn
// time-proportionally over a shared now-onward domain, so coarse models draw
// smooth lines to their own horizon. Used by the point-popup "Multi" tab and
// the detail page's multi-model view.
// ---------------------------------------------------------------------------

/** Stable color per known model; extras fall back to the palette. */
const MODEL_COLORS: Record<string, string> = {
  iconch1: "#e8a33d",
  iconch2: "#e86a5f",
  icond2: "#5bc8af",
  iconeueps: "#4aa3df",
  icondglobal: "#c77dff",
  iconepsglobal: "#b8c34a",
};
const EXTRA_COLORS = ["#9fb8d0", "#e8d34a", "#d98fb0", "#7fd0e8"];

/** Known model ordering, finest-first (unknown ids append after). */
const MODEL_ORDER = [
  "iconch1",
  "iconch2",
  "icond2",
  "iconeueps",
  "icondglobal",
  "iconepsglobal",
];

/** Vars already covered by the fixed panels. */
const FIXED_PANEL_VARS = new Set([
  "t_2m",
  "precip_1h",
  "tot_prec",
  "wind_speed_10m",
  "wind_10m",
  "u_10m",
  "v_10m",
]);

interface ModelRow {
  model: string;
  color: string;
  timesteps: string[];
  ms: number[];
  values: Record<string, (number | null)[] | undefined>;
}

interface Props {
  /** Full model catalog (all models — composites/satellites filtered here). */
  models: Model[];
  lat: number;
  lon: number;
  /** Active map product; gets a fourth panel when not covered by the fixed ones. */
  activeProduct?: string;
  unitPrefs: Record<string, string>;
  timeFormat: TimeFormat;
  /** Detail-page geometry (860px canvas) instead of the popup's 340px. */
  wide?: boolean;
  /** Optional TimeBar sync: click picks the nearest global timestep. */
  globalTimesteps?: string[];
  onTimestepChange?: (idx: number) => void;
}

/** Strip a __{N}h_{op} window modifier — the comparison is hourly. */
function stripWindowMod(id: string): string {
  return id.replace(/__\d+h_(?:max|min|mean|sum)$/, "");
}

function modelColor(id: string, i: number): string {
  return MODEL_COLORS[id] ?? EXTRA_COLORS[i % EXTRA_COLORS.length];
}

/** Single joined polyline through non-null samples (a coarse model's series
 *  has no gaps on its own axis; joining keeps any stray null from shredding
 *  the line into dashes). */
function joinedPath(
  ms: number[],
  vals: (number | null)[] | undefined,
  xAtMs: (t: number) => number,
  yAt: (v: number) => number,
): string {
  if (!vals) return "";
  let d = "";
  for (let i = 0; i < ms.length; i++) {
    const v = vals[i];
    if (v == null || !Number.isFinite(v)) continue;
    d += `${d ? " L" : "M"}${xAtMs(ms[i]).toFixed(1)},${yAt(v).toFixed(1)}`;
  }
  return d;
}

function bandPolygon(
  ms: number[],
  lo: (number | null)[] | undefined,
  hi: (number | null)[] | undefined,
  xAtMs: (t: number) => number,
  yAt: (v: number) => number,
): string {
  if (!lo || !hi) return "";
  const fwd: string[] = [];
  const back: string[] = [];
  for (let i = 0; i < ms.length; i++) {
    const l = lo[i];
    const h = hi[i];
    if (l == null || h == null) continue;
    fwd.push(`${xAtMs(ms[i]).toFixed(1)},${yAt(h).toFixed(1)}`);
    back.push(`${xAtMs(ms[i]).toFixed(1)},${yAt(l).toFixed(1)}`);
  }
  if (fwd.length < 2) return "";
  return `${fwd.join(" ")} ${back.reverse().join(" ")}`;
}

export default function MultiModelCharts({
  models,
  lat,
  lon,
  activeProduct,
  unitPrefs,
  timeFormat,
  wide,
  globalTimesteps,
  onTimestepChange,
}: Props) {
  // Site elevation (z_site): screen temps are lapse-corrected server-side to
  // it — the tag on the temperature panel says why the models agree here.
  const [siteElev, setSiteElev] = useState<number | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    fetchV2Point("auto", "t_2m", lat, lon, {}, ac.signal)
      .then((r) => setSiteElev(r.elevation ?? null))
      .catch(() => {});
    return () => ac.abort();
  }, [lat, lon]);
  const W = wide ? 860 : 340;
  const LEFT = wide ? 48 : 36;
  const RIGHT = wide ? 16 : 26;
  const INNER_W = W - LEFT - RIGHT;
  const LEGEND_H = 16;
  const TEMP_H = wide ? 150 : 120;
  const PANEL_H = wide ? 90 : 64;
  const GAP = 10;
  const AXIS_H = 16;

  const svgRef = useRef<SVGSVGElement>(null);
  const [rows, setRows] = useState<ModelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusMs, setFocusMs] = useState<number | null>(null);

  const physical = useMemo(() => {
    const ms = models.filter(
      (m) => !m.id.startsWith("auto") && !m.id.startsWith("sat_"),
    );
    ms.sort((a, b) => {
      const ia = MODEL_ORDER.indexOf(a.id);
      const ib = MODEL_ORDER.indexOf(b.id);
      if ((ia < 0) !== (ib < 0)) return ia < 0 ? 1 : -1;
      if (ia >= 0 && ia !== ib) return ia - ib;
      return a.id.localeCompare(b.id);
    });
    return ms;
  }, [models]);

  // The product panel's id (window modifier stripped) — only when not already
  // covered by a fixed panel.
  const productId = useMemo(() => {
    if (!activeProduct) return null;
    const id = stripWindowMod(activeProduct);
    const { base } = splitEnsembleVar(id);
    return FIXED_PANEL_VARS.has(base) || FIXED_PANEL_VARS.has(id) ? null : id;
  }, [activeProduct]);
  const productIsProb = useMemo(
    () =>
      !!productId &&
      (productId.startsWith("prob_") || /_gt|_lt/.test(productId)),
    [productId],
  );

  useEffect(() => {
    if (physical.length === 0) return;
    const ac = new AbortController();
    // Clearing stale rows on re-point is intentional: the tab shows "Loading…".
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRows(null);
    setError(null);
    const cutoff = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    Promise.all(
      physical.map(async (m, mi): Promise<ModelRow | null> => {
        const has = (n: string) => m.variables.some((v) => v.name === n);
        const pcts = (n: string) =>
          m.variables.find((v) => v.name === n)?.percentiles;
        const banded = (n: string) => {
          const p = pcts(n);
          return !!p?.includes(10) && !!p?.includes(90);
        };
        const vars: string[] = [];
        if (has("t_2m")) {
          vars.push("t_2m");
          if (banded("t_2m")) vars.push("t_2m_p10", "t_2m_p90");
        }
        if (has("precip_1h") || has("tot_prec")) vars.push("precip_1h");
        if (has("clct")) vars.push("clct");
        if (has("wind_speed_10m") || (has("u_10m") && has("v_10m")))
          vars.push("wind_speed_10m", "wind_dir_10m");
        if (productId) {
          const { base } = splitEnsembleVar(productId);
          if (has(productId) || has(base)) {
            vars.push(productId);
            if (!productIsProb && banded(base))
              vars.push(`${base}_p10`, `${base}_p90`);
          }
        }
        if (vars.length === 0) return null;
        try {
          const meta = await fetchV2Meta(m.id, "t_2m", ac.signal);
          let axis = meta.timesteps ?? [];
          const start = axis.findIndex((ts) => Date.parse(ts) >= cutoff);
          if (start > 0) axis = axis.slice(start);
          if (axis.length < 2) return null;
          const res = await fetchV2PointSeries(
            m.id,
            vars,
            lat,
            lon,
            axis,
            "",
            ac.signal,
          );
          // A model whose grid doesn't cover the point returns all nulls —
          // drop it from the comparison entirely.
          const any = vars.some((v) =>
            res.values[v]?.some((x) => x != null),
          );
          if (!any) return null;
          return {
            model: m.id,
            color: modelColor(m.id, mi),
            timesteps: res.timesteps,
            ms: res.timesteps.map((t) => Date.parse(t)),
            values: res.values,
          };
        } catch {
          return null; // model can't serve this point — drop out
        }
      }),
    )
      .then((rs) => {
        if (ac.signal.aborted) return;
        setRows(rs.filter((r): r is ModelRow => r != null));
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted)
          setError(String((e as Error)?.message ?? e));
      });
    return () => ac.abort();
  }, [physical, lat, lon, productId, productIsProb]);

  // Shared time domain: now → the longest model's horizon.
  const domain = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const r of rows) {
      if (r.ms.length === 0) continue;
      t0 = Math.min(t0, r.ms[0]);
      t1 = Math.max(t1, r.ms[r.ms.length - 1]);
    }
    return Number.isFinite(t0) && t1 > t0 ? { t0, t1 } : null;
  }, [rows]);

  const xAtMs = useCallback(
    (t: number) =>
      LEFT + (domain ? ((t - domain.t0) / (domain.t1 - domain.t0)) * INNER_W : 0),
    [domain, LEFT, INNER_W],
  );

  // Unit conversion helpers from the first model that carries the var.
  const catalogFor = useCallback(
    (id: string): Variable[] => {
      const { base } = splitEnsembleVar(stripWindowMod(id));
      const m = physical.find((mm) =>
        mm.variables.some((v) => v.name === id || v.name === base),
      );
      return m?.variables ?? [];
    },
    [physical],
  );
  const tempDesc = useMemo(
    () => describeVar("t_2m", catalogFor("t_2m"), unitPrefs),
    [catalogFor, unitPrefs],
  );
  const windDesc = useMemo(
    () => describeVar("wind_speed_10m", catalogFor("wind_speed_10m"), unitPrefs),
    [catalogFor, unitPrefs],
  );
  const productDesc = useMemo(
    () =>
      productId ? describeVar(productId, catalogFor(productId), unitPrefs) : null,
    [productId, catalogFor, unitPrefs],
  );

  const conv = useCallback(
    (vals: (number | null)[] | undefined, c: (v: number) => number) =>
      vals?.map((v) => (v == null || Number.isNaN(v) ? null : c(v))),
    [],
  );

  // Per-panel converted series per model.
  const panels = useMemo(() => {
    if (!rows) return null;
    const tempC = tempDesc.convert ?? ((v: number) => v);
    const windC = windDesc.convert ?? ((v: number) => v);
    const prodC = productDesc?.convert ?? ((v: number) => v);
    return rows.map((r) => ({
      row: r,
      temp: conv(r.values["t_2m"], tempC),
      tempLo: conv(r.values["t_2m_p10"], tempC),
      tempHi: conv(r.values["t_2m_p90"], tempC),
      precip: r.values["precip_1h"],
      clouds: r.values["clct"],
      wind: conv(r.values["wind_speed_10m"], windC),
      dir: r.values["wind_dir_10m"],
      product: productId ? conv(r.values[productId], prodC) : undefined,
      productLo: productId
        ? conv(r.values[`${splitEnsembleVar(productId).base}_p10`], prodC)
        : undefined,
      productHi: productId
        ? conv(r.values[`${splitEnsembleVar(productId).base}_p90`], prodC)
        : undefined,
    }));
  }, [rows, tempDesc, windDesc, productDesc, productId, conv]);

  // Which panels have any data at all.
  const active = useMemo(() => {
    const anyOf = (sel: (p: NonNullable<typeof panels>[number]) => (number | null)[] | undefined) =>
      !!panels?.some((p) => sel(p)?.some((v) => v != null));
    return {
      temp: anyOf((p) => p.temp),
      precip: anyOf((p) => p.precip),
      clouds: anyOf((p) => p.clouds),
      wind: anyOf((p) => p.wind),
      dir: anyOf((p) => p.dir),
      product: !!productId && anyOf((p) => p.product),
    };
  }, [panels, productId]);

  // Scale helper over every model's series in a panel.
  const scaleOf = useCallback(
    (
      sels: ((p: NonNullable<typeof panels>[number]) => (number | null)[] | undefined)[],
      opts?: { zeroFloor?: boolean; fixed0100?: boolean; minHi?: number },
    ) => {
      if (opts?.fixed0100) return { lo: 0, hi: 100 };
      const all: number[] = [];
      for (const p of panels ?? []) {
        for (const sel of sels) {
          const vs = sel(p);
          if (vs) for (const v of vs) if (v != null && Number.isFinite(v)) all.push(v);
        }
      }
      if (all.length === 0) return null;
      let lo = Math.min(...all);
      let hi = Math.max(...all);
      if (opts?.zeroFloor) lo = 0;
      if (opts?.minHi != null && hi < opts.minHi) hi = opts.minHi;
      if (hi === lo) hi = lo + 1;
      const pad = (hi - lo) * 0.08;
      const lo2 = opts?.zeroFloor ? 0 : lo - pad;
      return { lo: lo >= 0 && lo2 < 0 ? 0 : lo2, hi: hi + pad };
    },
    [panels],
  );

  // Layout.
  const sections: { key: string; h: number }[] = [];
  if (active.temp) sections.push({ key: "temp", h: TEMP_H });
  if (active.precip) sections.push({ key: "precip", h: PANEL_H });
  if (active.clouds) sections.push({ key: "clouds", h: PANEL_H });
  if (active.wind) sections.push({ key: "wind", h: PANEL_H });
  if (active.dir) sections.push({ key: "dir", h: 12 + (panels?.length ?? 0) * 13 });
  if (active.product) sections.push({ key: "product", h: PANEL_H });
  const tops: Record<string, number> = {};
  let y = LEGEND_H + 4;
  for (const s of sections) {
    tops[s.key] = y;
    y += s.h + GAP;
  }
  const TOTAL_H = y + AXIS_H;

  // Night shading + day ticks over the shared domain (hourly sampling).
  const nightBands = useMemo(() => {
    if (!domain) return [];
    if (timeFormat === "lead") return []; // synthetic time — no day/night
    const out: { x0: number; x1: number }[] = [];
    let start: number | null = null;
    for (let t = domain.t0; t <= domain.t1; t += 3_600_000) {
      const night = solarElevationDeg(t, lat, lon) < -0.8;
      if (night && start == null) start = t;
      if (!night && start != null) {
        out.push({ x0: xAtMs(start), x1: xAtMs(t) });
        start = null;
      }
    }
    if (start != null) out.push({ x0: xAtMs(start), x1: xAtMs(domain.t1) });
    return out;
  }, [domain, lat, lon, xAtMs, timeFormat]);

  const dayTicks = useMemo(() => {
    if (!domain) return [];
    const out: { t: number; label: string }[] = [];
    const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let lastKey = "";
    // Lead mode: one tick per 24 lead hours ("+0d", "+1d", …).
    if (timeFormat === "lead" && Number.isFinite(leadReferenceMs())) {
      for (let t = domain.t0; t <= domain.t1; t += 3_600_000) {
        const key = String(Math.floor(leadHoursOf(t) / 24));
        if (key !== lastKey) {
          if (lastKey !== "") out.push({ t, label: `+${key}d` });
          lastKey = key;
        }
      }
      return out;
    }
    for (let t = domain.t0; t <= domain.t1; t += 3_600_000) {
      const d = new Date(t);
      const local = timeFormat === "local";
      const day = local ? d.getDate() : d.getUTCDate();
      const key = `${local ? d.getMonth() : d.getUTCMonth()}-${day}`;
      if (key !== lastKey) {
        if (lastKey !== "")
          out.push({
            t,
            label: `${WEEKDAYS[local ? d.getDay() : d.getUTCDay()]} ${day}`,
          });
        lastKey = key;
      }
    }
    return out;
  }, [domain, timeFormat]);

  // Hover / click.
  const msFromEvent = useCallback(
    (e: React.PointerEvent<SVGSVGElement>): number | null => {
      const svg = svgRef.current;
      if (!svg || !domain) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return null;
      const xVb = ((e.clientX - rect.left) / rect.width) * W;
      if (xVb < LEFT - 8 || xVb > LEFT + INNER_W + 8) return null;
      const f = Math.max(0, Math.min(1, (xVb - LEFT) / INNER_W));
      return domain.t0 + f * (domain.t1 - domain.t0);
    },
    [domain, W, LEFT, INNER_W],
  );

  /** Nearest own-axis value for a model at the focus time (≤ 90 min away). */
  const valueAt = useCallback(
    (r: ModelRow, vals: (number | null)[] | undefined, t: number): number | null => {
      if (!vals || r.ms.length === 0) return null;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < r.ms.length; i++) {
        const d = Math.abs(r.ms[i] - t);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best < 0 || bestD > 5_400_000) return null;
      return vals[best] ?? null;
    },
    [],
  );

  if (physical.length === 0) return <div className="point-chart-empty">No models</div>;
  if (error) return <div className="point-error">{error}</div>;
  if (!rows) return <div className="point-loading">Loading…</div>;
  if (!domain || !panels || sections.length === 0)
    return <div className="point-chart-empty">No data</div>;

  const tempScale = scaleOf([(p) => p.temp, (p) => p.tempLo, (p) => p.tempHi]);
  // minHi 1: a drizzle-trace week must not zoom the axis into a "0.0–0.0" band.
  const precipScale = scaleOf([(p) => p.precip], { zeroFloor: true, minHi: 1 });
  const windScale = scaleOf([(p) => p.wind], { zeroFloor: true });
  const productScale = scaleOf(
    [(p) => p.product, (p) => p.productLo, (p) => p.productHi],
    productIsProb ? { fixed0100: true } : undefined,
  );

  const yFn = (top: number, h: number, sc: { lo: number; hi: number }) =>
    (v: number) => top + 6 + (h - 12) * (1 - (v - sc.lo) / (sc.hi - sc.lo));

  // Precip bars: side-by-side per model within each hour slot.
  const hourPx = (3_600_000 / (domain.t1 - domain.t0)) * INNER_W;
  const precipModels = panels.filter((p) => p.precip?.some((v) => v != null && v > 0));
  const barW = Math.max(0.6, Math.min((hourPx * 0.85) / Math.max(1, precipModels.length), 6));

  const focusText =
    focusMs != null
      ? formatStatusTime(new Date(focusMs).toISOString(), timeFormat)
      : null;

  const panelFrame = (
    key: string,
    top: number,
    h: number,
    sc: { lo: number; hi: number },
    title: string,
    unit: string,
  ) => {
    const yF = yFn(top, h, sc);
    const fmt = (v: number) => (sc.hi - sc.lo > 5 ? v.toFixed(0) : v.toFixed(1));
    return (
      <g key={`${key}-frame`}>
        <line x1={LEFT} y1={top + h} x2={LEFT + INNER_W} y2={top + h} className="detail-axis" />
        <text x={LEFT - 4} y={yF(sc.hi) + 3} textAnchor="end" className="point-chart-tick">
          {fmt(sc.hi)}
        </text>
        <text x={LEFT - 4} y={yF(sc.lo) + 3} textAnchor="end" className="point-chart-tick">
          {fmt(sc.lo)}
        </text>
        <text
          x={LEFT + INNER_W - 4}
          y={top + 10}
          textAnchor="end"
          className="point-chart-tick"
          style={{ opacity: 0.75 }}
        >
          {title}
          {unit ? ` [${unit}]` : ""}
        </text>
      </g>
    );
  };

  return (
    <div className={`multimodel${wide ? " wide" : ""}`}>
      <div className="multimodel-legend">
        {panels.map((p) => {
          const v = focusMs != null ? valueAt(p.row, p.temp, focusMs) : null;
          return (
            <span key={p.row.model} className="multimodel-legend-item" style={{ color: p.row.color }}>
              ● {p.row.model}
              {v != null && <b> {v.toFixed(1)}°</b>}
            </span>
          );
        })}
        {focusText && <span className="multimodel-legend-time">{focusText}</span>}
      </div>
      <svg
        ref={svgRef}
        className="point-chart-svg multimodel-svg"
        viewBox={`0 0 ${W} ${TOTAL_H}`}
        role="img"
        aria-label="Multi-model comparison"
        onPointerMove={(e) => setFocusMs(msFromEvent(e))}
        onPointerLeave={() => setFocusMs(null)}
        onPointerDown={(e) => {
          const t = msFromEvent(e);
          if (t != null && globalTimesteps?.length && onTimestepChange) {
            onTimestepChange(nearestTimestepIndex(globalTimesteps, t));
          }
        }}
      >
        {nightBands.map((b, i) => (
          <rect
            key={`n${i}`}
            x={b.x0}
            y={LEGEND_H}
            width={Math.max(0, b.x1 - b.x0)}
            height={TOTAL_H - LEGEND_H - AXIS_H}
            className="meteogram-night"
          />
        ))}
        {dayTicks.map(({ t, label }) => (
          <g key={`d${t}`}>
            <line
              x1={xAtMs(t)}
              y1={LEGEND_H}
              x2={xAtMs(t)}
              y2={TOTAL_H - AXIS_H}
              className="meteogram-dayline"
            />
            <text x={xAtMs(t) + 3} y={TOTAL_H - 4} className="meteogram-daylabel">
              {label}
            </text>
          </g>
        ))}

        {/* ── Temperature ── */}
        {active.temp && tempScale && (
          <g>
            {panelFrame(
              "temp",
              tops.temp,
              TEMP_H,
              tempScale,
              siteElev != null ? `t_2m · ⛰ at ${Math.round(siteElev)} m` : "t_2m",
              tempDesc.unitLabel ?? "",
            )}
            {tempScale.lo < 0 && tempScale.hi > 0 && (
              <line
                x1={LEFT}
                y1={yFn(tops.temp, TEMP_H, tempScale)(0)}
                x2={LEFT + INNER_W}
                y2={yFn(tops.temp, TEMP_H, tempScale)(0)}
                className="meteogram-zero"
              />
            )}
            {panels.map((p) => {
              const yF = yFn(tops.temp, TEMP_H, tempScale);
              const band = bandPolygon(p.row.ms, p.tempLo, p.tempHi, xAtMs, yF);
              const d = joinedPath(p.row.ms, p.temp, xAtMs, yF);
              return (
                <g key={p.row.model}>
                  {band && <polygon points={band} fill={p.row.color} opacity={0.13} />}
                  {d && <path d={d} fill="none" stroke={p.row.color} strokeWidth={1.5} />}
                </g>
              );
            })}
          </g>
        )}

        {/* ── Precip ── */}
        {active.precip && precipScale && (
          <g>
            {panelFrame("precip", tops.precip, PANEL_H, precipScale, "precip_1h", "mm/h")}
            {precipModels.map((p, mi) => {
              const yF = yFn(tops.precip, PANEL_H, precipScale);
              const bot = tops.precip + PANEL_H;
              return (
                <g key={p.row.model} fill={p.row.color} opacity={0.85}>
                  {p.precip!.map((v, i) =>
                    v == null || v <= 0 ? null : (
                      <rect
                        key={i}
                        x={
                          xAtMs(p.row.ms[i]) -
                          (precipModels.length * barW) / 2 +
                          mi * barW
                        }
                        y={yF(v)}
                        width={barW}
                        height={Math.max(0, bot - 6 - yF(v))}
                      />
                    ),
                  )}
                </g>
              );
            })}
          </g>
        )}

        {/* ── Total cloud cover ── */}
        {active.clouds && (
          <g>
            {panelFrame("clouds", tops.clouds, PANEL_H, { lo: 0, hi: 100 }, "clct", "%")}
            {panels.map((p) => {
              const d = joinedPath(p.row.ms, p.clouds, xAtMs, yFn(tops.clouds, PANEL_H, { lo: 0, hi: 100 }));
              return d ? (
                <path key={p.row.model} d={d} fill="none" stroke={p.row.color} strokeWidth={1.2} opacity={0.9} />
              ) : null;
            })}
          </g>
        )}

        {/* ── Wind ── */}
        {active.wind && windScale && (
          <g>
            {panelFrame("wind", tops.wind, PANEL_H, windScale, "wind", windDesc.unitLabel ?? "")}
            {panels.map((p) => {
              const d = joinedPath(p.row.ms, p.wind, xAtMs, yFn(tops.wind, PANEL_H, windScale));
              return d ? (
                <path key={p.row.model} d={d} fill="none" stroke={p.row.color} strokeWidth={1.5} />
              ) : null;
            })}
          </g>
        )}

        {/* ── Wind direction: one arrow row per model (flow direction) ── */}
        {active.dir && (
          <g>
            <text
              x={LEFT + INNER_W - 4}
              y={tops.dir + 8}
              textAnchor="end"
              className="point-chart-tick"
              style={{ opacity: 0.75 }}
            >
              direction
            </text>
            {panels.map((p, mi) => {
              if (!p.dir || !p.dir.some((v) => v != null)) return null;
              const yRow = tops.dir + 14 + mi * 13;
              // ~28 arrows across the strip, sampled on the model's own axis.
              const step = Math.max(1, Math.ceil(p.row.ms.length / 28));
              const arrows = [];
              for (let i = 0; i < p.row.ms.length; i += step) {
                const d = p.dir[i];
                if (d == null) continue;
                // wind_dir is the FROM bearing; the arrow points with the flow.
                const rot = d + 90;
                arrows.push(
                  <g key={i} transform={`translate(${xAtMs(p.row.ms[i]).toFixed(1)},${yRow}) rotate(${rot.toFixed(0)})`}>
                    <line x1={-4} y1={0} x2={4} y2={0} stroke={p.row.color} strokeWidth={1.1} />
                    <path d="M4,0 L1.4,-1.8 M4,0 L1.4,1.8" stroke={p.row.color} strokeWidth={1.1} fill="none" />
                  </g>,
                );
              }
              return <g key={p.row.model}>{arrows}</g>;
            })}
          </g>
        )}

        {/* ── Active product ── */}
        {active.product && productScale && productDesc && (
          <g>
            {panelFrame(
              "product",
              tops.product,
              PANEL_H,
              productScale,
              productDesc.label,
              productDesc.unitLabel ?? "",
            )}
            {panels.map((p) => {
              const yF = yFn(tops.product, PANEL_H, productScale);
              const band = bandPolygon(p.row.ms, p.productLo, p.productHi, xAtMs, yF);
              const d = joinedPath(p.row.ms, p.product, xAtMs, yF);
              return (
                <g key={p.row.model}>
                  {band && <polygon points={band} fill={p.row.color} opacity={0.13} />}
                  {d && (
                    <path
                      d={d}
                      fill="none"
                      stroke={p.row.color}
                      strokeWidth={1.5}
                      strokeDasharray={productIsProb ? "4,3" : undefined}
                    />
                  )}
                </g>
              );
            })}
          </g>
        )}

        {/* focus rule */}
        {focusMs != null && (
          <line
            x1={xAtMs(focusMs)}
            y1={LEGEND_H}
            x2={xAtMs(focusMs)}
            y2={TOTAL_H - AXIS_H}
            className="point-chart-marker hover"
          />
        )}
      </svg>
    </div>
  );
}
