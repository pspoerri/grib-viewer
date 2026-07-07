import type { Model, TimeFormat, WeatherStyle } from "../api/types";
import { modelInfoFor } from "../api/modelInfo";
import { formatRunLabel } from "../lib/runLabel";
import { formatStatusTime, formatWindowRange } from "../time";
import type { TimeWindow, WindowMode } from "../time";

interface Props {
  model: string;
  /** Model catalog (auto/auto_eps + physical models) — the switcher's options,
   *  same source and display names as the hamburger's model selector. */
  models: Model[];
  /** Model switch — identical semantics to the hamburger selector's onChange
   *  (App.handleModelChange). */
  onModelChange: (modelId: string) => void;
  weatherStyle: WeatherStyle | null;
  activeTimestep: number;
  timeFormat: TimeFormat;
  /** Active window-aggregation mode. In a non-hourly mode the badge shows
   *  the active window's clock RANGE (e.g. "12:00–18:00") instead of a
   *  single native hour, matching the reduced map frame. */
  windowMode?: WindowMode;
  /** The window the map is currently reducing over (window mode only). */
  activeWindow?: TimeWindow | null;
  /** Opens the model info page (size stats, variables, attribution, …). */
  onOpenModelInfo: () => void;
}

/** The switcher's option list — shared display logic with the hamburger's
 *  model selector (Controls.tsx): friendly name from modelInfoFor plus the
 *  latest-run label. */
export function ModelOptions({ models }: { models: Model[] }) {
  return (
    <>
      {models.map((m) => {
        const info = modelInfoFor(m.id);
        return (
          <option key={m.id} value={m.id} title={info.description}>
            {info.name}
            {m.latest_run ? ` — ${formatRunLabel(m.latest_run)}` : ""}
          </option>
        );
      })}
    </>
  );
}

/**
 * Compact status panel in the top-right corner: the current forecast time
 * plus the model/source SWITCHER (a native select — keyboard and touch
 * friendly). The (i) button beside it opens the Model info modal.
 */
export default function StatusBadge({
  model,
  models,
  onModelChange,
  weatherStyle,
  activeTimestep,
  timeFormat,
  windowMode,
  activeWindow,
  onOpenModelInfo,
}: Props) {
  const timesteps = weatherStyle?.metadata["weather-api:timesteps"] ?? [];
  const iso = activeTimestep >= 0 ? timesteps[activeTimestep] : undefined;
  // In a windowed mode the map renders the reduction over the active
  // window's block, not a single instant — so show the clock RANGE
  // ("12:00–18:00") rather than the playhead's interior hour, which would
  // misrepresent the displayed frame as an instant.
  const windowed = windowMode && windowMode !== "hourly" && activeWindow;
  // Differentiate "haven't loaded yet" (no timeline at all → em-dash)
  // from "wall-clock falls outside the current layer's range"
  // (active step set to -1 by the App-level layer-switch handler) so
  // the user sees the actual gap rather than a stale value.
  const timeText = windowed
    ? formatWindowRange(activeWindow, timeFormat)
    : iso
      ? formatStatusTime(iso, timeFormat)
      : timesteps.length > 0 && activeTimestep < 0
        ? "no data"
        : "—";
  // Friendly model name ("ICON-EU-EPS") instead of the raw registry
  // id ("iconeueps") — the id only means something to the backend.
  const modelText = model ? modelInfoFor(model).name : "—";

  return (
    <div className="status-badge">
      <span className="status-badge-stats">
        <span className="status-badge-row">
          <span className="status-badge-label">Time</span>
          <span className="status-badge-value">{timeText}</span>
        </span>
        <span className="status-badge-row">
          <label className="status-badge-label" htmlFor="status-model-select">
            Model
          </label>
          <span className="status-badge-value">
            <select
              id="status-model-select"
              className="status-badge-select"
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              title="Switch forecast model"
              aria-label="Forecast model"
            >
              <ModelOptions models={models} />
            </select>
            <button
              type="button"
              className="status-badge-info-btn"
              onClick={onOpenModelInfo}
              title="Show model info"
              aria-label={`Show model info for ${modelText}`}
            >
              <svg
                className="status-badge-info"
                viewBox="0 0 16 16"
                width="12"
                height="12"
                aria-hidden="true"
                focusable="false"
              >
                <circle
                  cx="8"
                  cy="8"
                  r="7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <rect x="7.25" y="6.75" width="1.5" height="5" rx="0.4" fill="currentColor" />
                <circle cx="8" cy="4.5" r="0.95" fill="currentColor" />
              </svg>
            </button>
          </span>
        </span>
      </span>
    </div>
  );
}
