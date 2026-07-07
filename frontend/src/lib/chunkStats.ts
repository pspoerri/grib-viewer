/**
 * Global stats for animation-chunk fetches: in-flight count for the
 * next-frame window, bytes downloaded over the session, and a rolling
 * bandwidth estimate.
 *
 * Drivers (AnimTileDriver, FramePrefetchDriver) call recordStart /
 * recordDone around each network fetch they own. Consumers (the
 * loading indicator, the bandwidth-aware prefetch policy) read the
 * aggregate via getStats() or subscribe for updates.
 *
 * Why this lives outside requestTracker.ts: requestTracker counts ALL
 * /api/v1 fetches (including style.json, /meta, GeoJSON contours).
 * The animation indicator needs a finer-grained view limited to
 * chunk-tile bytes, and the bandwidth estimator needs response sizes
 * which the global fetch wrapper doesn't observe (it can't tee the
 * body without breaking consumers).
 */

export interface ChunkStats {
  /** Requests that have been kicked but haven't completed. */
  inFlight: number;
  /** Subset of inFlight for *visible* tiles only (excludes background
   *  prefetch of future playback windows). Drives the subtle
   *  "still loading" chip so it reflects on-screen loading, not the
   *  driver's continuous look-ahead prefetch. */
  visibleInFlight: number;
  /** Total successful chunk fetches since session start. */
  completed: number;
  /** Total request initiations since session start (failed + succeeded + in-flight). */
  total: number;
  /** Bytes received from completed chunk fetches. */
  bytesDown: number;
  /**
   * Rolling estimate of effective download bandwidth, in bytes/sec.
   * Computed from the last `BW_WINDOW_MS` of completed chunks. NaN
   * until enough samples are collected.
   */
  bandwidthBps: number;
}

interface Sample {
  t: number;     // performance.now() at completion
  bytes: number; // payload size
  durMs: number; // request duration (start → done)
}

/** Bandwidth is averaged over the most recent samples within this window. */
const BW_WINDOW_MS = 8000;
/** Cap on retained samples (memory bound when nothing's draining the window). */
const MAX_SAMPLES = 256;

const state = {
  inFlight: 0,
  visibleInFlight: 0,
  completed: 0,
  total: 0,
  bytesDown: 0,
};
const samples: Sample[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

/** Mark the start of a chunk fetch. Returns a token to pass to recordDone.
 *  Pass `prefetch=true` for background look-ahead fetches so they're
 *  excluded from `visibleInFlight` (the on-screen loading signal). */
export function recordStart(prefetch = false): { startedAt: number; prefetch: boolean } {
  state.inFlight += 1;
  if (!prefetch) state.visibleInFlight += 1;
  state.total += 1;
  notify();
  return { startedAt: performance.now(), prefetch };
}

/** Mark a chunk fetch as completed (success or failure). Pass the
 *  payload size in bytes (0 if unknown / aborted). */
export function recordDone(
  token: { startedAt: number; prefetch: boolean },
  bytes: number,
  ok: boolean,
): void {
  state.inFlight = Math.max(0, state.inFlight - 1);
  if (!token.prefetch) state.visibleInFlight = Math.max(0, state.visibleInFlight - 1);
  if (ok) {
    state.completed += 1;
    state.bytesDown += Math.max(0, bytes);
    if (bytes > 0) {
      const now = performance.now();
      samples.push({ t: now, bytes, durMs: Math.max(1, now - token.startedAt) });
      if (samples.length > MAX_SAMPLES) samples.shift();
    }
  }
  notify();
}

function bandwidthBps(): number {
  const now = performance.now();
  const cutoff = now - BW_WINDOW_MS;
  // Drop expired samples lazily on read.
  while (samples.length > 0 && samples[0].t < cutoff) samples.shift();
  if (samples.length === 0) return NaN;

  // Sum of per-chunk durations OVER-COUNTS time when chunks run in
  // parallel: 8 chunks each taking 2 s of wall-clock under
  // contention sums to 16 s, but the link only spent 2 s producing
  // those bytes. Divide by wall-clock span instead to get actual
  // throughput. The earliest sample's effective start time
  // (its completion minus its measured duration) is the floor of the
  // observation period; clamp to BW_WINDOW_MS so a long-paused
  // session re-entering with one fresh sample doesn't compute an
  // absurdly high rate from a near-zero span.
  let bytes = 0;
  for (const s of samples) bytes += s.bytes;

  const earliest = samples[0];
  const earliestStart = earliest.t - earliest.durMs;
  const span = Math.max(1, Math.min(BW_WINDOW_MS, now - earliestStart));
  return (bytes / span) * 1000;
}

export function getStats(): ChunkStats {
  return {
    inFlight: state.inFlight,
    visibleInFlight: state.visibleInFlight,
    completed: state.completed,
    total: state.total,
    bytesDown: state.bytesDown,
    bandwidthBps: bandwidthBps(),
  };
}

export function subscribeStats(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
