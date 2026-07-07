import { useCallback, useMemo, useRef } from "react";
import { formatStatusTime } from "../time";
import type { TimeFormat } from "../api/types";
import { BARB_STAFF as STAFF, barbGlyph, fromBearingDeg } from "../lib/windBarbGlyph";

// Strip geometry — matches the PointPopup chart canvas (CHART_W /
// CHART_M.left / CHART_M.right) so barbs line up with the time axis
// of the charts stacked above them.
const W = 320;
const LEFT = 42;
const RIGHT = 12;
const ROW_H = 30;
const PAD_TOP = 4;
const PAD_BOTTOM = 4;

const MS_TO_KT = 1.94384;

export interface BarbRow {
  /** Row label, e.g. "p25" / "p50" / "p75". */
  label: string;
  /** Wind speed per timestep, m/s (API base units). */
  speeds: (number | null)[];
}

interface Props {
  timesteps: string[];
  /** Median 10 m wind components per timestep — direction source for
   *  every row. Speed percentiles don't carry their own direction
   *  (percentile-of-speed has no unique direction), so all rows share
   *  the median direction and differ only in feathering. */
  u: (number | null)[];
  v: (number | null)[];
  rows: BarbRow[];
  activeTimestep: number;
  hoverIdx: number | null;
  onHoverIdx: (i: number | null) => void;
  onPickIdx: (i: number) => void;
  timeFormat: TimeFormat;
  /** Canvas geometry override — the detail page's wide (860px) charts. */
  geom?: { w: number; left: number; right: number; maxBarbs?: number };
}

/**
 * Wind-barb meteogram strip: one row per speed percentile, a barb per
 * (subsampled) timestep. Direction comes from the median u/v; the
 * rows differ in feathering only. Shares the chart's x-geometry so
 * the active-timestep rule lines up with the charts above.
 */
export default function WindBarbs({
  timesteps,
  u,
  v,
  rows,
  activeTimestep,
  hoverIdx,
  onHoverIdx,
  onPickIdx,
  timeFormat,
  geom,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const n = timesteps.length;
  const height = PAD_TOP + rows.length * ROW_H + PAD_BOTTOM;
  const W2 = geom?.w ?? W;
  const LEFT2 = geom?.left ?? LEFT;
  const INNER_W2 = W2 - LEFT2 - (geom?.right ?? RIGHT);

  const xAt = useCallback(
    (i: number): number => LEFT2 + (n <= 1 ? INNER_W2 / 2 : (i / (n - 1)) * INNER_W2),
    [n, LEFT2, INNER_W2],
  );

  // Subsample so feathers stay readable (~14 barbs on the popup canvas).
  const indices = useMemo(() => {
    const maxBarbs = geom?.maxBarbs ?? 14;
    const stride = Math.max(1, Math.ceil(n / maxBarbs));
    const out: number[] = [];
    for (let i = 0; i < n; i += stride) out.push(i);
    return out;
  }, [n, geom?.maxBarbs]);

  const idxFromEvent = useCallback(
    (e: React.PointerEvent<SVGSVGElement>): number | null => {
      const svg = svgRef.current;
      if (!svg || n === 0) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return null;
      const xViewBox = ((e.clientX - rect.left) / rect.width) * W2 - LEFT2;
      if (xViewBox < -10 || xViewBox > INNER_W2 + 10) return null;
      if (n === 1) return 0;
      const t = xViewBox / INNER_W2;
      return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
    },
    [n, W2, LEFT2, INNER_W2],
  );

  const clampedActive = Math.max(0, Math.min(n - 1, activeTimestep));
  const focusIdx = hoverIdx ?? clampedActive;

  // Focus readout: per-row speed (converted to knots) + shared
  // direction at the focused timestep.
  const focus = useMemo(() => {
    if (focusIdx < 0 || focusIdx >= n) return null;
    const uu = u[focusIdx];
    const vv = v[focusIdx];
    const dir = uu != null && vv != null ? fromBearingDeg(uu, vv) : null;
    const speeds = rows.map((r) => {
      const s = r.speeds[focusIdx];
      return s == null ? null : s * MS_TO_KT;
    });
    return { dir, speeds };
  }, [focusIdx, n, u, v, rows]);

  if (n === 0 || rows.length === 0) return null;

  return (
    <div className="wind-barbs">
      <div className="wind-barbs-head">
        <span className="wind-barbs-title">Wind barbs · 10 m · kt</span>
        {focus && (
          <span className="wind-barbs-focus">
            {focus.dir != null ? `${Math.round(focus.dir)}°` : "—"}
            {" · "}
            {rows
              .map((r, k) =>
                focus.speeds[k] == null
                  ? `${r.label} —`
                  : `${r.label} ${Math.round(focus.speeds[k]!)}`,
              )
              .join(" · ")}
          </span>
        )}
      </div>
      <svg
        ref={svgRef}
        className="point-chart-svg wind-barbs-svg"
        viewBox={`0 0 ${W2} ${height}`}
        onPointerMove={(e) => onHoverIdx(idxFromEvent(e))}
        onPointerLeave={() => onHoverIdx(null)}
        onPointerDown={(e) => {
          const idx = idxFromEvent(e);
          if (idx != null) onPickIdx(idx);
        }}
        role="img"
        aria-label={`Wind barb strip, ${rows.length} percentile rows`}
      >
        {/* focus rule across all rows, aligned with the charts above */}
        {focusIdx >= 0 && focusIdx < n && (
          <line
            x1={xAt(focusIdx)}
            y1={PAD_TOP}
            x2={xAt(focusIdx)}
            y2={height - PAD_BOTTOM}
            className={`point-chart-marker${hoverIdx != null ? " hover" : ""}`}
          />
        )}
        {rows.map((row, r) => {
          const cy = PAD_TOP + r * ROW_H + ROW_H / 2 + STAFF / 2;
          return (
            <g key={row.label}>
              <text
                x={LEFT2 - 5}
                y={PAD_TOP + r * ROW_H + ROW_H / 2 + 3}
                textAnchor="end"
                className={`point-chart-tick wind-barbs-label${
                  row.label === "p50" ? " median" : ""
                }`}
              >
                {row.label}
              </text>
              {indices.map((i) => {
                const speed = row.speeds[i];
                const uu = u[i];
                const vv = v[i];
                if (speed == null || uu == null || vv == null) return null;
                const kt = speed * MS_TO_KT;
                const { lines, pennants, calm } = barbGlyph(kt);
                const x = xAt(i);
                const cls = `wind-barb${row.label === "p50" ? " median" : ""}${
                  i === focusIdx ? " focus" : ""
                }`;
                if (calm) {
                  return (
                    <circle
                      key={i}
                      cx={x}
                      cy={cy - STAFF / 2}
                      r={2}
                      className={`${cls} calm`}
                    />
                  );
                }
                const rot = fromBearingDeg(uu, vv);
                return (
                  <g
                    key={i}
                    className={cls}
                    transform={`translate(${x},${cy}) rotate(${rot})`}
                  >
                    {lines.map(([x1, y1, x2, y2], k) => (
                      <line key={k} x1={x1} y1={y1} x2={x2} y2={y2} />
                    ))}
                    {pennants.map((pts, k) => (
                      <polygon key={`p${k}`} points={pts} />
                    ))}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <div className="wind-barbs-footer">
        <span>
          {focusIdx >= 0 && focusIdx < n
            ? formatStatusTime(timesteps[focusIdx], timeFormat)
            : ""}
        </span>
        <span className="wind-barbs-hint">direction = median u/v</span>
      </div>
    </div>
  );
}
