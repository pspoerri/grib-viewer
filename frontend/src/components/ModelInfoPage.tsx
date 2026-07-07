import { useEffect, useMemo, useState } from "react";
import type { BaseMapId, WeatherStyle } from "../api/types";
import { BASE_MAPS } from "../api/types";
import { fetchV2AvailableVariables } from "../api/v2catalog";
import type { AvailableVariable } from "../api/v2catalog";
import { fetchV2LatestRun } from "../api/v2client";
import type { LatestRunInfo } from "../api/v2client";
import { knownModelIds, modelInfoFor } from "../api/modelInfo";
import type { MapLayer } from "../api/mapConfig";
import { createLayer, encodeMapHash } from "../api/mapConfig";

interface Props {
  /** Currently selected model. The page focuses on this model but also
   *  lists every other registered model at the bottom. */
  model: string;
  /** Weather style of the currently rendered layer, used to dedupe the
   *  per-layer attribution strings from `sources[*].attribution`. */
  weatherStyle: WeatherStyle | null;
  /** Active base map id, so we can label its attribution. */
  baseMap: BaseMapId;
  /** Whether the satellite (ESA WorldCover) underlay is enabled. */
  satellite: boolean;
  /** Whether the terrain DEM layer is currently enabled. */
  terrain: boolean;
  /** Callback that replaces the map's current layer list with the
   *  provided one. Used by the "Display" variable action to pivot the
   *  map to a single-variable view and close the modal. */
  onSetLayers: (layers: MapLayer[], presetId: string | null) => void;
  onClose: () => void;
}

/**
 * Full-screen modal showing everything about a model the user might
 * want: variable catalog with a Display button, schedule (cadence,
 * horizon, next run), size stats (latest run + retained runs), and
 * full attribution. Opened from the StatusBadge model row.
 */
export default function ModelInfoPage({
  model,
  weatherStyle,
  baseMap,
  satellite,
  terrain,
  onSetLayers,
  onClose,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // v2 retains the latest run only — no run history. The model-info page shows
  // the latest run's schedule (below) rather than a retained-runs list.

  // Latest-run details (cadence, horizon, next run, total size) for the
  // currently selected model. `auto` returns a meaningful response
  // too — its "run" is the synthetic auto-XXXXXX id.
  // Keep latest response keyed by model id; switching models shows
  // stale data briefly instead of calling setState synchronously in the
  // effect (which would trigger cascading re-renders, cf. eslint
  // react-hooks/set-state-in-effect). Reads below treat a missing key
  // as "still loading".
  const [latestByKey, setLatestByKey] = useState<
    Record<string, LatestRunInfo>
  >({});
  const [latestErrByKey, setLatestErrByKey] = useState<Record<string, string>>(
    {},
  );
  useEffect(() => {
    if (!model) return;
    const ctrl = new AbortController();
    fetchV2LatestRun(model, ctrl.signal)
      .then((d) => {
        if (ctrl.signal.aborted) return;
        setLatestByKey((prev) => ({ ...prev, [model]: d }));
      })
      .catch((e: Error) => {
        if (ctrl.signal.aborted) return;
        setLatestErrByKey((prev) => ({ ...prev, [model]: e.message }));
      });
    return () => ctrl.abort();
  }, [model]);
  const latest = latestByKey[model] ?? null;
  const latestErr = latestErrByKey[model] ?? null;

  // Variable catalog for the selected model (grouped by unit family
  // server-side). `auto` returns the composite view; physical models
  // return curated + derived entries.
  const [variables, setVariables] = useState<AvailableVariable[]>([]);
  useEffect(() => {
    if (!model) return;
    let cancelled = false;
    fetchV2AvailableVariables(model)
      .then((vs) => {
        if (!cancelled) setVariables(vs);
      })
      .catch(() => {
        if (!cancelled) setVariables([]);
      });
    return () => {
      cancelled = true;
    };
  }, [model]);

  const weatherAttributions = useMemo(() => {
    if (!weatherStyle) return [] as string[];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const src of Object.values(weatherStyle.sources)) {
      const a = src.attribution?.trim();
      if (a && !seen.has(a)) {
        seen.add(a);
        out.push(a);
      }
    }
    return out;
  }, [weatherStyle]);

  const primary = modelInfoFor(model);
  const contributors = primary.contributors ?? [];

  // Build a single-tiles-layer representation for a variable id
  // (`t_2m`, `wind_speed_10m`). The id is the only routing key.
  const layerFor = (variable: string): MapLayer =>
    createLayer(variable, "tiles", { opacity: 0.85 });

  // Hash representation of (model + single tiles layer). Opening this
  // URL in a new tab bootstraps App from decodeMapHash so the variable
  // renders standalone, with the same model but base/proj/terrain left
  // to defaults (the new tab is a fresh session — don't smuggle visual
  // prefs across).
  const hrefFor = (variable: string): string => {
    const hash = encodeMapHash({
      model,
      layers: [layerFor(variable)],
    });
    return `${window.location.pathname}${hash}`;
  };

  // Install the layer in-place and close the modal. Used by the
  // anchor's onClick for plain left-clicks; cmd/ctrl/middle-click fall
  // through to the browser so the href opens a new tab.
  const displayVariable = (variable: string) => {
    onSetLayers([layerFor(variable)], null);
    onClose();
  };

  return (
    <div
      className="attribution-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="attribution-page model-info-page"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-info-title"
      >
        <header className="attribution-header">
          <h2 id="model-info-title">Model info</h2>
          <button
            onClick={onClose}
            className="close-btn"
            aria-label="Close model info page"
          >
            &times;
          </button>
        </header>

        <div className="attribution-body">
          <section className="attribution-section">
            <ModelEntry id={model} primary />
            {contributors.length > 0 && (
              <>
                <h4 className="attribution-subheading">Contributors</h4>
                <ul className="attribution-list">
                  {contributors.map((id) => (
                    <li key={id}>
                      <ModelEntry id={id} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <ScheduleSection latest={latest} latestErr={latestErr} />

          <SizeStatsSection latest={latest} />

          <VariablesSection
            variables={variables}
            onDisplay={displayVariable}
            hrefFor={hrefFor}
          />

          <section className="attribution-section">
            <h3>Loaded weather layers</h3>
            {weatherAttributions.length === 0 ? (
              <p className="attribution-empty">No layer is currently loaded.</p>
            ) : (
              <ul className="attribution-list">
                {weatherAttributions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="attribution-section">
            <h3>Base map</h3>
            <p>
              {BASE_MAPS[baseMap].label} — &copy;{" "}
              <a
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noreferrer"
              >
                OpenStreetMap
              </a>{" "}
              contributors.
            </p>
            {satellite && (
              <p>
                Satellite underlay: &copy;{" "}
                <a
                  href="https://esa-worldcover.org/"
                  target="_blank"
                  rel="noreferrer"
                >
                  ESA WorldCover
                </a>
                .
              </p>
            )}
            {terrain && (
              <p>
                Terrain DEM:{" "}
                <a
                  href="https://mapterhorn.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Mapterhorn
                </a>{" "}
                — elevation data from public-domain sources (SRTM, Copernicus,
                national lidar).
              </p>
            )}
          </section>

          <section className="attribution-section">
            <h3>All registered models</h3>
            <ul className="attribution-list">
              {knownModelIds()
                .filter((id) => id !== model)
                .map((id) => (
                  <li key={id}>
                    <ModelEntry id={id} />
                  </li>
                ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function ScheduleSection({
  latest,
  latestErr,
}: {
  latest: LatestRunInfo | null;
  latestErr: string | null;
}) {
  // Countdown ticker. 30s cadence — fresh enough for a "in 2h 14m"
  // label and cheap enough that it won't show up in profiles.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (latestErr) {
    return (
      <section className="attribution-section">
        <h3>Schedule</h3>
        <p className="attribution-empty">
          Latest run unavailable: {latestErr}
        </p>
      </section>
    );
  }
  if (!latest) {
    return (
      <section className="attribution-section">
        <h3>Schedule</h3>
        <p className="attribution-empty">Loading…</p>
      </section>
    );
  }

  const nextAvail = latest.next_available_at
    ? new Date(latest.next_available_at).getTime()
    : null;
  const nextRun = latest.next_run ? new Date(latest.next_run).getTime() : null;

  return (
    <section className="attribution-section">
      <h3>Schedule</h3>
      <div className="model-info-stats">
        {latest.cadence_hours ? (
          <Stat label="Cadence" value={`${latest.cadence_hours} h`} />
        ) : null}
        {latest.horizon_hours ? (
          <Stat label="Horizon" value={`${latest.horizon_hours} h`} />
        ) : null}
        {latest.timesteps ? (
          <Stat label="Timesteps" value={String(latest.timesteps)} />
        ) : null}
        {nextRun != null && (
          <Stat label="Next run" value={formatRunTime(new Date(nextRun))} />
        )}
        {nextAvail != null && (
          <Stat
            label="Available"
            value={
              nextAvail - now <= 0
                ? "any moment"
                : `in ${humanDuration(nextAvail - now)}`
            }
          />
        )}
      </div>
      {latest.forecast_start && latest.forecast_end && (
        <p className="model-info-forecast-range">
          Forecast: {formatRunTime(new Date(latest.forecast_start))} →{" "}
          {formatRunTime(new Date(latest.forecast_end))}
        </p>
      )}
    </section>
  );
}

function SizeStatsSection({ latest }: { latest: LatestRunInfo | null }) {
  const latestSize = latest?.size_bytes ?? 0;
  const latestVars = latest?.variables ?? 0;
  const perVar = latestVars > 0 ? latestSize / latestVars : 0;

  // v2 retains the latest run only and its latest-run endpoint carries no size
  // metrics, so this stays hidden unless a future endpoint reports them.
  if (latestSize === 0) return null;

  return (
    <section className="attribution-section">
      <h3>Size</h3>
      <div className="model-info-stats">
        <Stat label="Latest run" value={formatBytes(latestSize)} />
        {latestVars > 0 && (
          <Stat
            label="Archives"
            value={`${latestVars} · ≈${formatBytes(perVar)} each`}
          />
        )}
      </div>
    </section>
  );
}

function VariablesSection({
  variables,
  onDisplay,
  hrefFor,
}: {
  variables: AvailableVariable[];
  onDisplay: (variable: string) => void;
  hrefFor: (variable: string) => string;
}) {
  // Group by GroupLabel — the backend already sorts within-group
  // alphabetically and pushes "other" to the end, so a single pass
  // preserves that order.
  const groups = useMemo(() => {
    const out: { label: string; items: AvailableVariable[] }[] = [];
    let current: { label: string; items: AvailableVariable[] } | null = null;
    for (const v of variables) {
      const label = v.group_label || "Other";
      if (!current || current.label !== label) {
        current = { label, items: [] };
        out.push(current);
      }
      current.items.push(v);
    }
    return out;
  }, [variables]);

  if (variables.length === 0) {
    return (
      <section className="attribution-section">
        <h3>Variables</h3>
        <p className="attribution-empty">Loading variable catalog…</p>
      </section>
    );
  }

  return (
    <section className="attribution-section">
      <h3>Variables</h3>
      {groups.map((g) => (
        <div key={g.label} className="model-info-var-group">
          <h4 className="attribution-subheading">{g.label}</h4>
          <ul className="model-info-var-list">
            {g.items.map((v) => (
              <VariableRow
                key={v.name}
                v={v}
                onDisplay={onDisplay}
                hrefFor={hrefFor}
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function VariableRow({
  v,
  onDisplay,
  hrefFor,
}: {
  v: AvailableVariable;
  onDisplay: (variable: string) => void;
  hrefFor: (variable: string) => string;
}) {
  // Each variable gets one Display link under its bare name. When the
  // backend reports no archive, the row stays but renders a disabled
  // link so users see the variable exists and is unavailable on this
  // model.
  type Display = { id: string; variable: string; label: string };
  const displays: Display[] = [
    { id: v.name, variable: v.name, label: "Display" },
  ];
  const available = v.available;
  // Three UX buckets:
  //   • available                      → no tag, fully usable
  //   • !available && curated          → "no archive" (ingest pending /
  //                                        failed — something to watch)
  //   • !available && !curated         → "optional" (outside the
  //                                        default ingest budget; would
  //                                        appear under --all-fields)
  const curated = v.curated !== false; // default to true for safety
  return (
    <li className={`model-info-var-row${available ? "" : " unavailable"}`}>
      <div className="model-info-var-main">
        <span className="model-info-var-name">{v.name}</span>
        {v.units && <span className="model-info-var-units">{v.units}</span>}
        {v.derived && <span className="model-info-var-tag">derived</span>}
        {!available && curated && (
          <span className="model-info-var-tag muted">no archive</span>
        )}
        {!available && !curated && (
          <span className="model-info-var-tag muted">optional</span>
        )}
      </div>
      {v.long_name && (
        <div className="model-info-var-desc">{v.long_name}</div>
      )}
      <div className="model-info-var-actions">
        {displays.map((d) => (
          <DisplayLink
            key={d.id}
            label={d.label}
            href={hrefFor(d.variable)}
            disabled={!available}
            onActivate={() => onDisplay(d.variable)}
          />
        ))}
      </div>
    </li>
  );
}

/**
 * Anchor styled like a button that supports both SPA and new-tab
 * navigation. A plain left-click is intercepted and handled in-place
 * (swaps the map layers, closes the modal) so the page does not
 * reload. Cmd/ctrl/shift/middle clicks fall through to the browser,
 * which then opens the href in a new tab / window with the variable
 * pre-selected via the URL hash.
 *
 * Disabled anchors render a visually-identical `<button disabled>` —
 * anchors can't natively be disabled, and swapping the element keeps
 * keyboard/a11y behavior honest.
 */
function DisplayLink({
  label,
  href,
  disabled,
  onActivate,
}: {
  label: string;
  href: string;
  disabled: boolean;
  onActivate: () => void;
}) {
  if (disabled) {
    return (
      <button
        type="button"
        className="model-info-display-btn"
        disabled
        aria-label={label}
      >
        {label}
      </button>
    );
  }
  return (
    <a
      className="model-info-display-btn"
      href={href}
      onClick={(e) => {
        // Respect modifier-/middle-clicks: let the browser open a new
        // tab instead of running the in-place handler.
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        ) {
          return;
        }
        e.preventDefault();
        onActivate();
      }}
    >
      {label}
    </a>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="model-info-stat">
      <span className="model-info-stat-label">{label}</span>
      <span className="model-info-stat-value">{value}</span>
    </div>
  );
}

function ModelEntry({ id, primary }: { id: string; primary?: boolean }) {
  const info = modelInfoFor(id);
  return (
    <div className={`attribution-model${primary ? " primary" : ""}`}>
      <div className="attribution-model-head">
        <span className="attribution-model-name">{info.name}</span>
        <span className="attribution-model-id">{id}</span>
      </div>
      {info.description && (
        <p className="attribution-model-desc">{info.description}</p>
      )}
      <div className="attribution-model-meta">
        {info.provider && (
          <span>
            Provider:{" "}
            {info.providerUrl ? (
              <a href={info.providerUrl} target="_blank" rel="noreferrer">
                {info.provider}
              </a>
            ) : (
              info.provider
            )}
          </span>
        )}
        {info.license && (
          <span>
            License:{" "}
            {info.licenseUrl ? (
              <a href={info.licenseUrl} target="_blank" rel="noreferrer">
                {info.license}
              </a>
            ) : (
              info.license
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function formatRunTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

function humanDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m === 0 ? `${h}h` : `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr === 0 ? `${d}d` : `${d}d ${hr}h`;
}

function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
