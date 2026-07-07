import { useEffect, useState } from "react";
import type { Variable } from "../api/types";
import { describeVar } from "../api/varDisplay";
import { fetchV2Point } from "../api/v2client";

interface Props {
  model: string;
  run?: string;
  variables: string[];
  /** Active forecast-frame index (v2 /point fetches one frame). */
  timeIndex?: number;
  /** Global timeline (ISO) — maps timeIndex → the {time} path segment. */
  timesteps?: string[];
  /** Cursor position over the map (lat/lon) and over the map container
   *  in CSS pixels. Pass `null` to hide the label. */
  hover: { lat: number; lon: number; x: number; y: number } | null;
  /** Variable catalogue for unit resolution. */
  modelVariables: Variable[];
  unitPrefs: Record<string, string>;
  /** E5: bases (t_2m/td_2m) whose ⛰ toggle is OFF among the visible layers —
   *  a matching hover variable's fetch carries `?lapse=off` for point/hover
   *  parity with the drape. */
  lapseOffBases?: Set<string>;
}

const FETCH_DEBOUNCE_MS = 80;

interface FetchedValues {
  lat: number;
  lon: number;
  values: Record<string, number | null>;
}

/**
 * Floating label that follows the mouse cursor over the map and shows
 * each visible layer's current value at that location. Fetches are
 * debounced so even rapid cursor sweeps fire at most one request per
 * settled position; the previous request is aborted on every move.
 */
export default function HoverValueLabel({
  model,
  run,
  variables,
  timeIndex,
  timesteps,
  hover,
  modelVariables,
  unitPrefs,
}: Props) {
  const [fetched, setFetched] = useState<FetchedValues | null>(null);

  useEffect(() => {
    if (!hover || !model || variables.length === 0 || timeIndex == null) return;
    const ctrl = new AbortController();
    const lat = hover.lat;
    const lon = hover.lon;
    const timer = window.setTimeout(() => {
      // /point is single-variable + single-frame: fan out one request per
      // visible variable. The FULL product id (suffixes included) resolves
      // server-side; a pinned run rides along as ?run=.
      Promise.all(
        variables.map((v) =>
          fetchV2Point(
            model,
            v,
            lat,
            lon,
            { time: timeIndex, timesteps, run },
            ctrl.signal,
          )
            .then((r) => [v, r.value] as const)
            .catch(() => [v, null] as const),
        ),
      ).then((entries) => {
        if (ctrl.signal.aborted) return;
        setFetched({ lat, lon, values: Object.fromEntries(entries) });
      });
    }, FETCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [hover, model, run, timeIndex, timesteps, variables, modelVariables]);

  if (!hover || !fetched) return null;
  // Reject values that belong to a stale cursor position. Without this
  // the label would render the prior coordinate's numbers for one tick
  // when the user resumes hovering after a brief pause.
  if (
    Math.abs(fetched.lat - hover.lat) > 1e-6 ||
    Math.abs(fetched.lon - hover.lon) > 1e-6
  ) {
    return null;
  }

  // Prefer a position to the upper-right of the cursor. Container-
  // relative coordinates suffice — the label is absolutely positioned
  // inside .map-wrapper which fills the viewport.
  const off = 14;
  const style: React.CSSProperties = {
    left: hover.x + off,
    top: hover.y + off,
  };

  return (
    <div className="hover-value-label" style={style}>
      {variables.map((v) => {
        const raw = fetched.values[v];
        // describeVar turns the (possibly windowed / ensemble / exceedance)
        // id into a friendly label + the value's unit — so a chance product
        // (`tot_prec_gt1p6mm__24h`) reads "… chance" in % and a windowed
        // mean (`clct__24h_mean`) reads "Total cloud cover (24h mean)" %,
        // instead of the raw uppercased id with the base's unit.
        const d = describeVar(v, modelVariables, unitPrefs);
        const display =
          raw == null || Number.isNaN(raw) ? "—" : d.convert(raw).toFixed(1);
        return (
          <div key={v} className="hover-value-row">
            <span className="hover-value-name">{d.label}</span>
            <span className="hover-value-num">
              {display}
              {d.unitLabel ? (
                <span className="hover-value-unit"> {d.unitLabel}</span>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
