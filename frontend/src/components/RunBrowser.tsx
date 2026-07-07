/**
 * RunBrowser — the timerange-exploration panel (spec 04): lists every
 * buffered run of the selected model (GET /api/models/{model}/runs, newest
 * first) with its valid window, completeness flag and per-variable step
 * coverage bars. Clicking a run PINS it: App stores it as `selectedRun`
 * (the URL hash `r=` param) and every data/point/grid request carries
 * `?run=` until the pin is cleared ("Latest" row, or the pinned chip next
 * to the model selector).
 */
import { useEffect, useMemo, useState } from "react";
import type { Run } from "../api/types";
import { formatRunLabel } from "../lib/runLabel";
import { formatStatusTime } from "../time";

interface Props {
  model: string;
  runs: Run[];
  loading?: boolean;
  error?: string | null;
  /** Currently pinned run id; "" = latest (no pin). */
  selectedRun: string;
  /** Pin a run ("" unpins → latest). */
  onPin: (run: string) => void;
  onClose: () => void;
}

/** Compact "valid from → to" line for a run. */
function validWindow(r: Run): string {
  if (!r.forecast_start || !r.forecast_end) return "";
  const from = formatStatusTime(r.forecast_start, "utc");
  const to = formatStatusTime(r.forecast_end, "utc");
  return `${from} → ${to}`;
}

export default function RunBrowser({
  model,
  runs,
  loading,
  error,
  selectedRun,
  onPin,
  onClose,
}: Props) {
  // Escape closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Per-run coverage normalization: the widest per-variable step count in
  // the run list defines 100% so the bars compare across runs.
  const maxSteps = useMemo(() => {
    let mx = 1;
    for (const r of runs) {
      for (const n of Object.values(r.steps ?? {})) if (n > mx) mx = n;
    }
    return mx;
  }, [runs]);

  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="run-browser-backdrop" onClick={onClose}>
      <div
        className="run-browser"
        role="dialog"
        aria-label={`Runs for ${model}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="run-browser-head">
          <span className="run-browser-title">Runs — {model}</span>
          <button
            type="button"
            className="close-btn"
            onClick={onClose}
            aria-label="Close run browser"
          >
            &times;
          </button>
        </div>
        {loading && <div className="run-browser-empty">Loading runs…</div>}
        {!loading && error && (
          <div className="run-browser-empty">Failed to load runs: {error}</div>
        )}
        {!loading && !error && runs.length === 0 && (
          <div className="run-browser-empty">No buffered runs</div>
        )}
        <ul className="run-browser-list">
          {/* "Latest" pseudo-row: unpins so requests track the newest run. */}
          <li>
            <button
              type="button"
              className={`run-browser-row${selectedRun === "" ? " active" : ""}`}
              onClick={() => {
                onPin("");
                onClose();
              }}
            >
              <span className="run-browser-run">Latest</span>
              <span className="run-browser-window">follow the newest run</span>
            </button>
          </li>
          {runs.map((r) => {
            const vars = Object.entries(r.steps ?? {});
            const isOpen = expanded === r.run;
            return (
              <li key={r.run}>
                <button
                  type="button"
                  className={`run-browser-row${selectedRun === r.run ? " active" : ""}`}
                  onClick={() => {
                    onPin(r.run);
                    onClose();
                  }}
                  title={`Pin ${formatRunLabel(r.run)}`}
                >
                  <span className="run-browser-run">{formatRunLabel(r.run)}</span>
                  <span className="run-browser-window">{validWindow(r)}</span>
                  <span
                    className={`run-browser-flag${r.complete ? " complete" : ""}`}
                    title={r.complete ? "Run complete" : "Run still filling"}
                  >
                    {r.complete ? "complete" : "partial"}
                  </span>
                  {r.synthetic_time && (
                    <span className="run-browser-flag" title="Synthetic time axis">
                      synthetic
                    </span>
                  )}
                </button>
                {vars.length > 0 && (
                  <div className="run-browser-coverage">
                    {(isOpen ? vars : vars.slice(0, 6)).map(([name, n]) => (
                      <div className="run-browser-var" key={name}>
                        <span className="run-browser-var-name">{name}</span>
                        <span className="run-browser-bar">
                          <span
                            className="run-browser-bar-fill"
                            style={{
                              width: `${Math.max(2, Math.min(100, (n / maxSteps) * 100))}%`,
                            }}
                          />
                        </span>
                        <span className="run-browser-var-n">{n}</span>
                      </div>
                    ))}
                    {vars.length > 6 && (
                      <button
                        type="button"
                        className="run-browser-more"
                        onClick={() => setExpanded(isOpen ? null : r.run)}
                      >
                        {isOpen ? "Show fewer" : `Show all ${vars.length} variables`}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
