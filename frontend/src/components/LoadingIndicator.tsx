import { useEffect, useState } from "react";
import { getStats, subscribeStats } from "../lib/chunkStats";

interface Props {
  /** True whenever any of: initial style fetch, GPU first-chunk wait,
   *  play-loop frame wait. The parent ORs these together; we just
   *  decide whether to render. */
  active: boolean;
  /** Current HDR setting. The overlay surfaces the toggle so a user
   *  who hits the loading screen on a slow connection can drop to
   *  SDR without waiting for the load to complete first. */
  hdr: boolean;
  onHdrChange: (hdr: boolean) => void;
}

/**
 * Centered loading indicator. Lives in the middle of the map and
 * displays a spinner plus the live in-flight request count, with an
 * inline HDR/SDR switch so a slow connection can downgrade quality
 * without waiting for the current load to finish.
 *
 * Replaces the per-state mini-spinners (StatusBadge tiny spinner,
 * bottom-of-map frame-loading dot). One indicator, one visual
 * vocabulary, regardless of whether we're waiting on the initial
 * style.json, the first GPU chunk, or the play loop's next-frame
 * gate.
 */
export default function LoadingIndicator({ active, hdr, onHdrChange }: Props) {
  // Subscribe whether or not we're rendering so the displayed
  // numbers are correct the moment `active` flips on (no flash of
  // stale stats from the previous loading episode). The subscription
  // is cheap — chunkStats only notifies on actual fetch start/done.
  const [stats, setStats] = useState(getStats);
  useEffect(() => subscribeStats(() => setStats(getStats())), []);

  const { inFlight, visibleInFlight } = stats;

  // The centered overlay clears the moment the first chunk paints
  // (`active` drops). But a slow layer — e.g. a cold exceedance /
  // Chance-of computation — keeps streaming the rest of its tiles long
  // after that, with no on-screen feedback. Show a subtle, non-blocking
  // chip while *visible* tiles are still in flight (background look-ahead
  // prefetch is excluded so it doesn't show during idle/playback warming),
  // debounced so routine fast loads/pans don't flash it. Depends on the
  // boolean (not the count) so the timer isn't reset on every tile
  // start/done.
  const tilesBusy = visibleInFlight > 0;
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!tilesBusy) return;
    const id = setTimeout(() => setArmed(true), 400);
    // Disarm on the busy→idle transition (this effect only re-runs when
    // the boolean flips, so the timer isn't reset by tile-count churn).
    return () => {
      clearTimeout(id);
      setArmed(false);
    };
  }, [tilesBusy]);
  const showChip = tilesBusy && armed;

  if (active) {
    return (
      <div
        className="loading-overlay"
        role="status"
        aria-live="polite"
        aria-label="Loading weather data"
      >
        <span className="loading-indicator loading-overlay-spinner" />
        <div className="loading-overlay-meta">
          {inFlight > 0
            ? `${inFlight} ${inFlight === 1 ? "request" : "requests"} in flight`
            : "Loading…"}
        </div>
        <div className="loading-overlay-quality">
          <button
            type="button"
            className={`toggle-btn ${hdr ? "active" : ""}`}
            onClick={() => onHdrChange(true)}
            title="High resolution: 2× data per CSS pixel (~4× bandwidth)"
          >
            HD
          </button>
          <button
            type="button"
            className={`toggle-btn ${!hdr ? "active" : ""}`}
            onClick={() => onHdrChange(false)}
            title="Standard resolution: lower bandwidth"
          >
            SD
          </button>
        </div>
      </div>
    );
  }

  // First chunk has painted (overlay gone) but tiles are still loading.
  if (showChip) {
    return (
      <div
        className="loading-chip"
        role="status"
        aria-live="polite"
        aria-label="Loading weather data"
      >
        <span className="loading-indicator loading-chip-spinner" />
        <span className="loading-chip-label">
          Loading {visibleInFlight} {visibleInFlight === 1 ? "tile" : "tiles"}…
        </span>
      </div>
    );
  }

  return null;
}
