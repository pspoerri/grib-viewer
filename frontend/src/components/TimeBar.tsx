import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { RefObject, PointerEvent as ReactPointerEvent } from "react";
import type { TimeFormat, WeatherStyle } from "../api/types";
import {
  formatStatusTimeParts,
  groupTimestepsByDay,
  bucketTimesteps,
} from "../time";
import type { DayGroup, WindowMode } from "../time";
import type { WeatherMapHandle } from "./WeatherMapV2";

interface Props {
  weatherStyle: WeatherStyle | null;
  activeTimestep: number;
  onTimestepChange: (step: number) => void;
  /** Local/UTC display + bucketing timezone. The toggle lives in the
   *  hamburger menu (Controls); the TimeBar only consumes it for label
   *  formatting + window bucketing. */
  timeFormat: TimeFormat;
  /** Aggregation window mode. "hourly" keeps the per-step day-grouped
   *  timeline + GPU-tween playback; the coarser modes bucket the steps
   *  into 3h/6h/12h/daily windows and step window-by-window. The mode
   *  selector lives in the legend; the TimeBar only consumes the value
   *  to render the windowed timeline. */
  windowMode: WindowMode;
  /** Ref to the WeatherMap so the play loop can drive every GPU
   *  animation layer with a fractional playhead at vsync. */
  mapRef?: RefObject<WeatherMapHandle | null>;
  /** Fires `true` when the play loop has paused on an unloaded window
   *  (the prefetcher hasn't caught up yet) and `false` once data lands
   *  and playback resumes. The parent renders a small loading
   *  indicator while this is true. Cache-hit playback never trips it. */
  onFrameLoadingChange?: (loading: boolean) => void;
  /** Fires whenever the play/pause state toggles. The parent uses this
   *  to suppress mobile auto-hide of the preset bar while playback is
   *  running — only the Play button press itself dismisses the strip. */
  onPlayingChange?: (playing: boolean) => void;
  /** Wall-clock cost of one forecast hour during playback. A 1h-cadence
   *  archive crosses one integer frame per `msPerForecastHour` ms; a
   *  3h-cadence segment dwells 3× that. The shader linearly interpolates
   *  between adjacent frames for non-integer `u_time`, so the rAF loop
   *  drives smooth motion regardless of cadence. Configured from the
   *  hamburger menu. */
  msPerForecastHour: number;
}
// After the last forecast frame, hold there for this long before the
// cycle wraps back to the first frame. Without it the wrap snaps
// instantly and the user never sees the final frame settle.
const LAST_FRAME_DWELL_MS = 1000;
// Touch-only: a pointerdown→pointerup with movement under this many
// pixels counts as a tap (commits step selection); larger movement
// means the browser likely took over the gesture for scrolling.
const TAP_THRESHOLD_PX = 8;

interface HoverInfo {
  dayKey: string;
  stepIdx: number;
  leftPct: number;
}

export default function TimeBar({
  weatherStyle,
  activeTimestep,
  onTimestepChange,
  timeFormat,
  windowMode,
  mapRef,
  onFrameLoadingChange,
  onPlayingChange,
  msPerForecastHour,
}: Props) {
  const onFrameLoadingChangeRef = useRef(onFrameLoadingChange);
  useEffect(() => {
    onFrameLoadingChangeRef.current = onFrameLoadingChange;
  }, [onFrameLoadingChange]);
  const onPlayingChangeRef = useRef(onPlayingChange);
  useEffect(() => {
    onPlayingChangeRef.current = onPlayingChange;
  }, [onPlayingChange]);
  const [playing, setPlaying] = useState(false);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const playingRef = useRef(false);
  const timestepRef = useRef(activeTimestep);
  const daysRowRef = useRef<HTMLDivElement>(null);
  // Capture the box currently being dragged so pointer-move continues
  // scrubbing even when the cursor leaves it.
  const dragBoxRef = useRef<{ day: DayGroup; el: HTMLElement } | null>(null);
  // Touch-only: track an in-progress tap so the browser is free to
  // hijack the gesture for horizontal scrolling. We commit the step
  // selection on pointerup if movement stayed under TAP_THRESHOLD_PX.
  const tapRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    day: DayGroup;
    el: HTMLElement;
  } | null>(null);

  useEffect(() => {
    timestepRef.current = activeTimestep;
  }, [activeTimestep]);

  const timesteps = useMemo(
    () => weatherStyle?.metadata["weather-api:timesteps"] ?? [],
    [weatherStyle],
  );
  const days = useMemo(
    () => groupTimestepsByDay(timesteps, timeFormat),
    [timesteps, timeFormat],
  );

  // Windowed (non-hourly) rendering buckets the steps onto the
  // 6h/12h/daily nesting grid. Hourly keeps the day-grouped path above.
  const isWindowed = windowMode !== "hourly";
  const windows = useMemo(
    () => (isWindowed ? bucketTimesteps(timesteps, windowMode, timeFormat) : []),
    [isWindowed, timesteps, windowMode, timeFormat],
  );
  // The active window is the one whose native step range covers the
  // current active timestep.
  const activeWindowKey = useMemo(() => {
    for (const w of windows) {
      if (w.nativeIndices.includes(activeTimestep)) return w.key;
    }
    return null;
  }, [windows, activeTimestep]);

  // Stride for the hour tick labels. Derived from the SMALLEST gap
  // between consecutive timesteps so a mixed-cadence archive (10-min
  // recent + hourly older) thins to the dense end. Sub-3h cadences
  // thin to every 3rd hour; 3h+ cadences keep every hour-aligned step.
  const stride = useMemo(() => {
    if (timesteps.length < 2) return 1;
    let minDtMs = Infinity;
    for (let i = 1; i < timesteps.length; i++) {
      const dt = Date.parse(timesteps[i]) - Date.parse(timesteps[i - 1]);
      if (Number.isFinite(dt) && dt > 0 && dt < minDtMs) minDtMs = dt;
    }
    const dtH = minDtMs / 3_600_000;
    if (!Number.isFinite(dtH) || dtH <= 0) return 1;
    return dtH < 3 ? 3 : 1;
  }, [timesteps]);

  // Identify the day group that contains the active timestep.
  const activeDayKey = useMemo(() => {
    for (const d of days) {
      if (d.steps.some((s) => s.idx === activeTimestep)) return d.key;
    }
    return null;
  }, [days, activeTimestep]);

  // Keep the active day box in view when the row overflows. Scrolls
  // only when the active day changes so playback doesn't janky-scroll
  // every frame. The first scroll after the timeline loads is instant
  // (centers "now" without animating from the row's initial scroll
  // position); subsequent active-day changes animate smoothly.
  const didInitialCenter = useRef(false);
  useEffect(() => {
    const row = daysRowRef.current;
    if (!row || !activeDayKey) return;
    const box = row.querySelector<HTMLElement>(`[data-day="${activeDayKey}"]`);
    if (box) {
      box.scrollIntoView({
        behavior: didInitialCenter.current ? "smooth" : "auto",
        block: "nearest",
        inline: "center",
      });
      didInitialCenter.current = true;
    }
  }, [activeDayKey]);

  // Reset the initial-center flag when the weatherStyle changes so a
  // model/variable switch re-centers instantly on the new "now"
  // instead of animating across the freshly-rendered row.
  useEffect(() => {
    didInitialCenter.current = false;
  }, [weatherStyle]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlaying(false);
  }, [weatherStyle]);

  // Stop playback when switching into an aggregation mode. These are
  // expensive to animate — each window is a fresh on-demand reduced-tile
  // fetch (no prefetch / GPU tween), so auto-advancing through them
  // hammers the backend and stutters. The play button stays available
  // (the user can opt back in), but a mode switch never leaves it running.
  useEffect(() => {
    if (windowMode !== "hourly") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPlaying(false);
    }
  }, [windowMode]);

  useEffect(() => {
    playingRef.current = playing;
    // Tell the map handle so its activeTimestep effect can skip the
    // integer-frame GPU u_time echo while we drive setPlayhead at
    // vsync. Without this the React-state echo of our own
    // onTimestepChange overwrites u_time briefly each integer
    // crossing — visible jitter at 3h cadence.
    mapRef?.current?.setPlaying(playing);
    onPlayingChangeRef.current?.(playing);
  }, [playing, mapRef]);

  useEffect(() => {
    // GPU-tween playback is hourly-mode only. Windowed modes step
    // window-by-window through a separate, interpolation-free loop
    // (below) — guarding here keeps the hourly path byte-equivalent to
    // before window-mode was added.
    if (isWindowed) return;
    if (!playing || timesteps.length === 0) return;

    // Capture once: the WeatherMap handle is stable for the lifetime of
    // a play session, and copying lets the cleanup snap-back below
    // address the same handle even if the ref were swapped.
    const handle = mapRef?.current ?? null;
    const N = timesteps.length;

    // Cumulative wall-clock ms to reach each integer frame, paced so
    // every forecast hour costs `msPerForecastHour`. A 3h gap between
    // adjacent timesteps becomes a 3× longer dwell, a 10-min gap a 1/6
    // dwell — mixed-cadence archives play at uniform real-time rate.
    // Unparseable / zero / negative gaps fall back to one hour so the
    // loop never stalls on bad metadata.
    const cum = new Array<number>(N);
    cum[0] = 0;
    for (let i = 1; i < N; i++) {
      const dtMs = Date.parse(timesteps[i]) - Date.parse(timesteps[i - 1]);
      const dtH = dtMs / 3_600_000;
      const segMs = Number.isFinite(dtH) && dtH > 0
        ? dtH * msPerForecastHour
        : msPerForecastHour;
      cum[i] = cum[i - 1] + segMs;
    }
    const lastCum = N > 1 ? cum[N - 1] : 0;
    const cycleMs = lastCum + LAST_FRAME_DWELL_MS;

    // Anchor wall-clock so playback resumes from the user's current
    // scrub position rather than snapping to frame 0 on each play press.
    const startInt = Math.max(0, Math.min(N - 1, timestepRef.current | 0));
    let lastIntFrame = startInt;
    let playStart = performance.now() - cum[startInt];
    // 0 when running, performance.now() at the moment we detected the
    // current/next window wasn't loaded yet. While > 0, the playhead
    // holds at lastIntFrame, the loading indicator is on, and each
    // rAF tick re-checks readiness. Once ready, we shift `playStart`
    // forward by the freeze duration so the playhead resumes from
    // exactly where it paused (no jump-ahead at fast cadences).
    let frozenSinceMs = 0;
    let rafId = 0;
    let cancelled = false;
    // Recently-fired integer frames (values we pushed via
    // onTimestepChange that may not have committed back through React
    // yet). When timestepRef.current still reflects an old value, the
    // propInt-mismatch check below would otherwise interpret the stale
    // echo as an external scrub and yank playStart backwards — at 3h
    // cadence each integer frame is 1200 ms of wall time, so the
    // resulting jump-back-then-forward is highly visible. Storing the
    // last few values lets us recognise a stale echo even when React
    // is multiple ticks behind. Capped to bound size.
    const recentFires = new Set<number>([startInt]);
    const RECENT_FIRES_MAX = 6;

    const tick = () => {
      if (cancelled || !playingRef.current) return;

      // External scrub during play: the parent updated activeTimestep,
      // which propagated to timestepRef. Re-anchor wall-clock so the
      // play position jumps to the new step and keeps rolling from
      // there without abruptly snapping back. A propInt that matches
      // a value we recently fired (still propagating through React) is
      // ignored — that's our own echo, not a user scrub.
      const propInt = timestepRef.current | 0;
      if (propInt !== lastIntFrame && !recentFires.has(propInt)) {
        lastIntFrame = Math.max(0, Math.min(N - 1, propInt));
        playStart = performance.now() - cum[lastIntFrame];
        recentFires.clear();
        recentFires.add(lastIntFrame);
        // A scrub also resets any pending freeze — the new position's
        // readiness will be re-evaluated below.
        if (frozenSinceMs > 0) {
          frozenSinceMs = 0;
          onFrameLoadingChangeRef.current?.(false);
        }
      }

      // Readiness gate. We need data for both the current window
      // (covering lastIntFrame) and the immediate-next window (covering
      // lastIntFrame+1) since fractional tweens between integer frames
      // may straddle a window boundary. The driver chunk-prefetcher
      // warms the next window in parallel during play, but with large
      // bundles or high-resolution tile sets the prefetch can lag the
      // playhead. Holding the playhead until both windows land trades a
      // brief pause (with an indicator) for stutter-free motion through
      // the boundary.
      const nextInt = Math.min(N - 1, lastIntFrame + 1);
      const ready =
        (handle?.isFrameReady(lastIntFrame) ?? true) &&
        (handle?.isFrameReady(nextInt) ?? true);

      if (!ready) {
        if (frozenSinceMs === 0) {
          frozenSinceMs = performance.now();
          onFrameLoadingChangeRef.current?.(true);
          // Kick a one-shot async wait so each driver's readyListeners
          // fire as soon as the missing chunk lands. Per-driver
          // timeouts inside ensure a stuck request can't wedge play.
          // The actual unfreeze happens in the readiness-true branch
          // below — re-checked on every rAF tick.
          void handle?.waitForFrameReady(nextInt, 8000);
        }
        // Hold the playhead exactly at the current integer (no
        // fractional tween into half-loaded data).
        handle?.setPlayhead(lastIntFrame);
        rafId = requestAnimationFrame(tick);
        return;
      }

      if (frozenSinceMs > 0) {
        // Just unfroze: shift the wall-clock anchor forward by the
        // freeze duration so the playhead resumes from where it paused
        // (rather than snapping ahead by the time spent waiting).
        playStart += performance.now() - frozenSinceMs;
        frozenSinceMs = 0;
        onFrameLoadingChangeRef.current?.(false);
      }

      let elapsed = performance.now() - playStart;
      if (cycleMs > 0) {
        elapsed = ((elapsed % cycleMs) + cycleMs) % cycleMs;
      }

      let t: number;
      if (N <= 1) {
        t = 0;
      } else if (elapsed >= lastCum) {
        // Dwell at the last frame for LAST_FRAME_DWELL_MS before wrap.
        t = N - 1;
      } else {
        // Walk the cumulative array forward (or back, after a scrub) to
        // the segment containing `elapsed`. N is small (≤ a few hundred)
        // and we usually advance by 0–1 segments per tick, so this is
        // amortized O(1).
        let seg = lastIntFrame;
        if (seg > N - 2) seg = N - 2;
        if (seg < 0) seg = 0;
        while (seg < N - 1 && cum[seg + 1] <= elapsed) seg++;
        while (seg > 0 && cum[seg] > elapsed) seg--;
        const segDur = cum[seg + 1] - cum[seg];
        t = segDur > 0 ? seg + (elapsed - cum[seg]) / segDur : seg;
      }

      handle?.setPlayhead(t);

      const intF = Math.floor(t);
      if (intF !== lastIntFrame) {
        lastIntFrame = intF;
        recentFires.add(intF);
        if (recentFires.size > RECENT_FIRES_MAX) {
          // Drop the oldest insertion (Map/Set preserve insertion order).
          const first = recentFires.values().next().value as number | undefined;
          if (first !== undefined) recentFires.delete(first);
        }
        // Drives barbs/grid (which still step in integer frames) and
        // the time-bar's active-step highlight via parent React state.
        // GPU tile + flow drivers ignore this integer echo while
        // playing; they're driven by setPlayhead's fractional value.
        onTimestepChange(intF);
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      // Snap back to integer on pause so the visible frame matches the
      // active-step indicator in the time bar.
      handle?.setPlayhead(timestepRef.current);
      // If we paused mid-freeze, drop the loading indicator so the
      // spinner doesn't linger on the paused UI.
      if (frozenSinceMs > 0) {
        onFrameLoadingChangeRef.current?.(false);
      }
    };
  }, [playing, timesteps, onTimestepChange, mapRef, msPerForecastHour, isWindowed]);

  // Windowed playback: advance window-by-window on a fixed interval,
  // committing the representative (first) native index of each window.
  // No sub-frame interpolation — the active window highlight follows
  // the committed timestep. The reduced-frame layer request itself is
  // wired in Task 18; here we just drive the representative timestep so
  // the time bar + (future) layer follow the window. Dwell scales with
  // the window span so a 6h window dwells longer than an hourly tick.
  useEffect(() => {
    if (!isWindowed || !playing || windows.length === 0) return;
    const dwellMs = (w: { spanHours: number }) =>
      Math.max(msPerForecastHour, w.spanHours * msPerForecastHour);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scheduleNext = () => {
      if (cancelled) return;
      // Locate the window covering the current step; advance to the
      // next (wrapping to the first after the last).
      const cur = timestepRef.current;
      let i = windows.findIndex((w) => w.nativeIndices.includes(cur));
      if (i < 0) i = 0;
      const dwell = dwellMs(windows[i]);
      timer = setTimeout(() => {
        if (cancelled || !playingRef.current) return;
        const nextIdx = (i + 1) % windows.length;
        const rep = windows[nextIdx].nativeIndices[0];
        if (rep !== undefined) onTimestepChange(rep);
        scheduleNext();
      }, dwell);
    };
    scheduleNext();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [isWindowed, playing, windows, onTimestepChange, msPerForecastHour]);

  const togglePlay = useCallback(() => {
    setPlaying((p) => !p);
  }, []);

  // Windowed-mode selection: clicking a window commits its
  // representative (first) native timestep. Playback continues from
  // there (mirrors the hourly path's no-pause-on-click behaviour).
  const selectWindow = useCallback(
    (rep: number | undefined) => {
      if (rep !== undefined) onTimestepChange(rep);
    },
    [onTimestepChange],
  );

  // Convert a pointer x-coordinate within a day box into (stepIdx, leftPct).
  // The track is laid out by wall-clock time (frac → targetMs across the
  // day's spanMs), and we snap to the step nearest that target. This
  // makes mixed-cadence archives scrub correctly: a click 1/4 of the way
  // across the box always lands at the step closest to (start + span/4),
  // regardless of whether neighbouring steps are 10 min or 1 h apart.
  const stepFromPointer = useCallback(
    (day: DayGroup, clientX: number, rect: DOMRect) => {
      const width = rect.width;
      const relX = clientX - rect.left;
      const frac = width > 0 ? Math.max(0, Math.min(1, relX / width)) : 0;
      if (day.spanMs <= 0 || day.steps.length <= 1) {
        const only = day.steps[0];
        return { stepIdx: only?.idx ?? 0, leftPct: 50 };
      }
      const targetMs = day.startMs + frac * day.spanMs;
      let best = day.steps[0];
      let bestDist = Math.abs(best.ms - targetMs);
      for (const s of day.steps) {
        const d = Math.abs(s.ms - targetMs);
        if (d < bestDist) {
          best = s;
          bestDist = d;
        }
      }
      const leftPct = ((best.ms - day.startMs) / day.spanMs) * 100;
      return { stepIdx: best.idx, leftPct };
    },
    [],
  );

  // The track (not the whole box) defines step 0-at-left-edge,
  // step N-1-at-right-edge. Clicks on the day-label area fall to the
  // left of the track and clamp to step 0 via stepFromPointer.
  const trackRectOf = (boxEl: HTMLElement): DOMRect | null => {
    const track = boxEl.querySelector<HTMLElement>(".time-bar-day-track");
    return track ? track.getBoundingClientRect() : null;
  };

  const handleDayPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragBoxRef.current;
      if (drag) {
        const rect = trackRectOf(drag.el);
        if (!rect) return;
        const { stepIdx, leftPct } = stepFromPointer(drag.day, e.clientX, rect);
        setHover({ dayKey: drag.day.key, stepIdx, leftPct });
        onTimestepChange(stepIdx);
        return;
      }
      // Skip hover preview on touch — there's no hover, and processing
      // pointermove during a swipe would re-render every frame while
      // the browser is trying to scroll the row.
      if (e.pointerType !== "mouse") return;
      const el = e.currentTarget;
      const dayKey = el.dataset.day;
      if (!dayKey) return;
      const day = days.find((d) => d.key === dayKey);
      if (!day) return;
      const rect = trackRectOf(el);
      if (!rect) return;
      const { stepIdx, leftPct } = stepFromPointer(day, e.clientX, rect);
      setHover({ dayKey, stepIdx, leftPct });
    },
    [days, stepFromPointer, onTimestepChange],
  );

  const handleDayPointerLeave = useCallback(() => {
    if (!dragBoxRef.current) setHover(null);
  }, []);

  const handleDayPointerDown = useCallback(
    (day: DayGroup, e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== "mouse") {
        // Touch / pen: don't capture the pointer. We need to leave the
        // gesture available to the browser so a horizontal swipe scrolls
        // the day row. Commit the step selection on pointerup if the
        // user didn't move (i.e. it was a tap, not a swipe).
        tapRef.current = {
          pointerId: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          day,
          el: e.currentTarget,
        };
        return;
      }
      // Don't pause on click — the user's expectation when the timeline
      // is animating and they click elsewhere is "continue from there",
      // not "stop". The play loop reads `timestepRef.current + 1` each
      // tick, so committing the new step here means the next iteration
      // picks up from the click target. Explicit pause still works via
      // the play/pause button.
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      dragBoxRef.current = { day, el };
      const rect = trackRectOf(el);
      if (!rect) return;
      const { stepIdx, leftPct } = stepFromPointer(day, e.clientX, rect);
      setHover({ dayKey: day.key, stepIdx, leftPct });
      onTimestepChange(stepIdx);
    },
    [onTimestepChange, stepFromPointer],
  );

  const handleDayPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragBoxRef.current;
      if (drag) {
        try {
          drag.el.releasePointerCapture(e.pointerId);
        } catch {
          // ignore — capture may have already been released
        }
        dragBoxRef.current = null;
        return;
      }
      const tap = tapRef.current;
      if (tap && tap.pointerId === e.pointerId) {
        tapRef.current = null;
        const dx = e.clientX - tap.x;
        const dy = e.clientY - tap.y;
        if (Math.hypot(dx, dy) <= TAP_THRESHOLD_PX) {
          // Don't pause on tap — playback continues from the new step
          // (see handleDayPointerDown for rationale).
          const rect = trackRectOf(tap.el);
          if (!rect) return;
          const { stepIdx, leftPct } = stepFromPointer(
            tap.day,
            e.clientX,
            rect,
          );
          setHover({ dayKey: tap.day.key, stepIdx, leftPct });
          onTimestepChange(stepIdx);
        }
      }
    },
    [onTimestepChange, stepFromPointer],
  );

  const handleDayPointerCancel = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Browser canceled the pointer (commonly: scroll took over the
      // gesture). Drop both the drag and the pending-tap state so we
      // don't fire a stale step change on a later event.
      if (tapRef.current?.pointerId === e.pointerId) tapRef.current = null;
      const drag = dragBoxRef.current;
      if (drag) {
        try {
          drag.el.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        dragBoxRef.current = null;
      }
    },
    [],
  );

  // Mouse-wheel stepping. Vertical wheel (mouse, or pinch-style
  // trackpad) advances or rewinds the timestep one tick per
  // accumulator threshold. Horizontal-dominant deltas pass through
  // so a trackpad's natural left/right pan still scrolls the days
  // row. Attached non-passively so preventDefault can stop the page
  // from scrolling on top-level wheel.
  const wheelAccumRef = useRef(0);
  useEffect(() => {
    const row = daysRowRef.current;
    if (!row) return;
    const onWheel = (e: WheelEvent) => {
      const ax = Math.abs(e.deltaX);
      const ay = Math.abs(e.deltaY);
      if (ay <= ax) return; // let horizontal trackpad pan scroll the row
      e.preventDefault();
      // Treat deltaY in pixel units (deltaMode 0). Lines / pages
      // (deltaMode 1 / 2) tick once per event regardless of size.
      const step = e.deltaMode === 0 ? e.deltaY : Math.sign(e.deltaY) * 50;
      // Reset on direction reversal so a quick flick the other way
      // doesn't have to clear the prior accumulator first.
      if (Math.sign(step) !== Math.sign(wheelAccumRef.current)) {
        wheelAccumRef.current = 0;
      }
      wheelAccumRef.current += step;
      const THRESHOLD = 30;
      let dir = 0;
      while (wheelAccumRef.current >= THRESHOLD) {
        wheelAccumRef.current -= THRESHOLD;
        dir += 1;
      }
      while (wheelAccumRef.current <= -THRESHOLD) {
        wheelAccumRef.current += THRESHOLD;
        dir -= 1;
      }
      if (dir === 0) return;
      const cur = timestepRef.current;
      const N = timesteps.length;
      if (N === 0) return;
      if (isWindowed && windows.length > 0) {
        // Step window-by-window: find the current window, move `dir`
        // windows, and commit the representative (first) native index.
        let i = windows.findIndex((w) => w.nativeIndices.includes(cur));
        if (i < 0) i = 0;
        const ni = Math.min(windows.length - 1, Math.max(0, i + dir));
        const rep = windows[ni].nativeIndices[0];
        if (rep !== undefined && rep !== cur) onTimestepChange(rep);
        return;
      }
      const next = Math.min(N - 1, Math.max(0, cur + dir));
      if (next !== cur) onTimestepChange(next);
    };
    row.addEventListener("wheel", onWheel, { passive: false });
    return () => row.removeEventListener("wheel", onWheel);
  }, [onTimestepChange, timesteps, isWindowed, windows]);

  if (timesteps.length === 0) return null;

  return (
    <div className="time-bar">
      <button
        className="play-btn"
        onClick={togglePlay}
        title={playing ? "Pause" : "Play"}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <polygon points="6,4 20,12 6,20" />
          </svg>
        )}
      </button>
      {isWindowed ? (
        <div
          className="time-bar-windows"
          role="tablist"
          aria-label={`Timeline by ${windowMode} window`}
          ref={daysRowRef}
        >
          {windows.map((w, i) => {
            const isActive = w.key === activeWindowKey;
            const rep = w.nativeIndices[0];
            const classes = ["time-bar-window"];
            if (isActive) classes.push("active");
            if (w.partial) classes.push("time-bar-window--partial");
            // Day context only on the first window of each day's run, so
            // a sub-daily timeline reads as day groups instead of
            // repeating the date on every pill.
            const prev = windows[i - 1];
            const showDay = !!w.dayLabel && (!prev || prev.dayLabel !== w.dayLabel);
            const fullLabel = w.dayLabel ? `${w.dayLabel} ${w.label}` : w.label;
            return (
              <button
                key={w.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={classes.join(" ")}
                title={
                  w.partial
                    ? `${fullLabel} (partial — ${w.nativeIndices.length}/${w.spanHours}h)`
                    : fullLabel
                }
                onClick={() => selectWindow(rep)}
              >
                {w.dayLabel && (
                  <span className="time-bar-window-day">
                    {showDay ? w.dayLabel : " "}
                  </span>
                )}
                <span className="time-bar-window-range">{w.label}</span>
              </button>
            );
          })}
        </div>
      ) : (
      <div
        className="time-bar-days"
        role="tablist"
        aria-label="Timeline by day"
        ref={daysRowRef}
      >
        {days.map((day) => {
          const isActive = day.key === activeDayKey;
          const activeStep = isActive
            ? day.steps.find((s) => s.idx === activeTimestep)
            : undefined;
          const activePct =
            isActive && activeStep && day.spanMs > 0
              ? ((activeStep.ms - day.startMs) / day.spanMs) * 100
              : 0;
          const isHoveringThis = hover?.dayKey === day.key;
          const hoverParts = isHoveringThis
            ? formatStatusTimeParts(timesteps[hover.stepIdx], timeFormat)
            : null;

          // Track width is set per-day from the day's wall-clock span,
          // not its step count, so 10-min and 1-h cadences cover the
          // same width per hour and a single archive can mix cadences
          // across time without the dense end blowing the box up.
          const PX_PER_HOUR = 8;
          const spanHours = day.spanMs / 3_600_000;
          const trackWidthPx = Math.max(1, spanHours * PX_PER_HOUR);
          // Box layout: padding-left 8 + day label 22 + gap 8 = 38px
          // offset before the track. Day label stacks weekday over
          // day-number so the column is narrow (~22px) and the box
          // height is driven by the two-line label, not by min-height
          // padding. Fill grows from the box's left edge so the accent
          // bleed covers the day label area too — "the day is part of
          // the box" — and its right border lands exactly at the
          // active step's label position in the track.
          const trackOffsetPx = 38;
          const fillWidthPx = isActive
            ? trackOffsetPx + (activePct / 100) * trackWidthPx
            : 0;

          return (
            <div
              key={day.key}
              data-day={day.key}
              role="tab"
              aria-selected={isActive}
              className={`time-bar-day-box${isActive ? " active" : ""}`}
              onPointerDown={(e) => handleDayPointerDown(day, e)}
              onPointerMove={handleDayPointerMove}
              onPointerUp={handleDayPointerUp}
              onPointerCancel={handleDayPointerCancel}
              onPointerLeave={handleDayPointerLeave}
            >
              {isActive && (
                <div
                  className="time-bar-day-fill"
                  style={{ width: `${fillWidthPx}px` }}
                  aria-hidden="true"
                />
              )}
              <span className="time-bar-day-label" aria-label={day.label}>
                <span className="time-bar-day-label-weekday">{day.weekday}</span>
                <span className="time-bar-day-label-num">{day.dayNum}</span>
              </span>
              <div
                className="time-bar-day-track"
                style={{ width: `${trackWidthPx}px` }}
              >
                <div className="time-bar-day-steps">
                  {day.steps.map((step) => {
                    // Clock-aligned labeling: only steps on the hour
                    // (minute==0) get a tick — otherwise a 10-min
                    // cadence stacks 6 labels at the same hour. Then
                    // thin to every 3rd hour for 1h-or-finer cadences;
                    // 3h+ keep every aligned step. Skip "00" (implied
                    // by the date). Hours inside the fill (past-in-
                    // active, or any hour in a fully-past day) still
                    // render — otherwise the user couldn't scrub back
                    // and see what hour they were landing on — but in
                    // a muted color so the live future hours read as
                    // primary.
                    if (step.minute !== 0) return null;
                    const clockAligned =
                      stride === 1 || step.hourNum % 3 === 0;
                    if (!clockAligned) return null;
                    if (step.hour === "00") return null;
                    const isStepActive = step.idx === activeTimestep;
                    const isPast = step.idx < activeTimestep;
                    const leftPct =
                      day.spanMs > 0
                        ? ((step.ms - day.startMs) / day.spanMs) * 100
                        : 50;
                    const classes = ["time-bar-day-num"];
                    if (isStepActive) classes.push("active");
                    else if (isPast) classes.push("past");
                    return (
                      <span
                        key={step.idx}
                        className={classes.join(" ")}
                        style={{ left: `${leftPct}%` }}
                      >
                        {step.hour}
                      </span>
                    );
                  })}
                </div>
                {isHoveringThis && hoverParts && (
                  <div
                    className="time-bar-day-tooltip"
                    style={{ left: `${hover.leftPct}%` }}
                    role="tooltip"
                  >
                    <span className="time-bar-day-tooltip-date">
                      {hoverParts.date}
                    </span>
                    <span className="time-bar-day-tooltip-clock">
                      {hoverParts.clock}
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
