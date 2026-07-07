import type { TimeFormat } from "./api/types.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

interface DateParts {
  year: number;
  month: number; // 0-based
  day: number;
  weekday: number; // 0 = Sunday
  hour: number;
  minute: number;
}

// ---------------------------------------------------------------------------
// Lead-time ("+Nh") display — the forced format on synthetic-time runs.
// The reference instant (the run's own reference time) is module state set by
// App whenever the active run changes; format functions fall back to UTC
// wall-clock display while it is unset.
// ---------------------------------------------------------------------------

let leadRefMs = NaN;

/** Set (or clear, with undefined/null/unparseable) the lead-time reference
 *  instant — RFC3339 string or epoch ms. */
export function setLeadReference(ref: string | number | null | undefined): void {
  const ms = typeof ref === "number" ? ref : ref ? Date.parse(ref) : NaN;
  leadRefMs = Number.isFinite(ms) ? ms : NaN;
}

/** The active lead reference (epoch ms), NaN when unset. */
export function leadReferenceMs(): number {
  return leadRefMs;
}

/** Whole lead hours of an instant against the reference. */
export function leadHoursOf(ms: number, refMs: number = leadRefMs): number {
  return Math.round((ms - refMs) / 3_600_000);
}

/** "+12h" label for an instant (lead display). */
export function leadLabel(ms: number, refMs: number = leadRefMs): string {
  return `+${leadHoursOf(ms, refMs)}h`;
}

/** True when lead formatting is actually usable for `tf`. */
function leadActive(tf: TimeFormat): boolean {
  return tf === "lead" && Number.isFinite(leadRefMs);
}

function parts(d: Date, tf: TimeFormat): DateParts {
  if (tf === "local") {
    return {
      year: d.getFullYear(),
      month: d.getMonth(),
      day: d.getDate(),
      weekday: d.getDay(),
      hour: d.getHours(),
      minute: d.getMinutes(),
    };
  }
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/** "Sat 11 Apr 14:00 UTC" / "Sat 11 Apr 16:00 CEST" — or "+12h" in lead mode. */
export function formatStatusTime(iso: string, tf: TimeFormat): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (leadActive(tf)) return leadLabel(d.getTime());
  const p = parts(d, tf);
  const weekday = WEEKDAYS[p.weekday];
  const day = String(p.day).padStart(2, "0");
  const month = MONTHS[p.month];
  const hour = String(p.hour).padStart(2, "0");
  const minute = String(p.minute).padStart(2, "0");
  const zone = tf === "local" ? localZoneLabel(d) : "UTC";
  return `${weekday} ${day} ${month} ${hour}:${minute} ${zone}`;
}

/** Two-line split of formatStatusTime — date on one line, clock on
 *  the other. Used by the TimeBar hover tooltip so date and clock
 *  stack vertically with a tight line-height. */
export function formatStatusTimeParts(
  iso: string,
  tf: TimeFormat,
): { date: string; clock: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: iso, clock: "" };
  if (leadActive(tf)) {
    const h = leadHoursOf(d.getTime());
    return { date: `+${Math.floor(h / 24)}d`, clock: `+${h}h` };
  }
  const p = parts(d, tf);
  const weekday = WEEKDAYS[p.weekday];
  const day = String(p.day).padStart(2, "0");
  const month = MONTHS[p.month];
  const hour = String(p.hour).padStart(2, "0");
  const minute = String(p.minute).padStart(2, "0");
  const zone = tf === "local" ? localZoneLabel(d) : "UTC";
  return {
    date: `${weekday} ${day} ${month}`,
    clock: `${hour}:${minute} ${zone}`,
  };
}

/** Compact status-badge label for a windowed (non-hourly) selection: the
 *  date plus the clock RANGE the block aggregates over —
 *  "Sun 21 Jun 12:00–18:00 CEST" for a sub-daily window, "Sun 21 Jun" for
 *  a daily one. Shown by the badge in window mode instead of a single
 *  native hour, so the displayed time matches the reduced map frame (the
 *  block [start, start+N), not the playhead's interior hour). */
export function formatWindowRange(win: TimeWindow, tf: TimeFormat): string {
  if (leadActive(tf)) {
    return `+${leadHoursOf(win.startMs)}–${leadHoursOf(win.endMs)}h`;
  }
  const start = formatStatusTimeParts(win.startIso, tf);
  if (win.spanHours >= 24) return start.date;
  const end = formatStatusTimeParts(new Date(win.endMs).toISOString(), tf);
  // clock is "HH:MM ZONE"; drop the zone off the start so the range reads
  // "12:00–18:00 CEST" with a single trailing zone label.
  const startClock = start.clock.replace(/ \S+$/, "");
  return `${start.date} ${startClock}–${end.clock}`;
}

export interface DayStep {
  idx: number;
  hour: string;
  hourNum: number;
  minute: number;
  /** Epoch ms of the timestep — used by TimeBar to position labels by
   *  wall-clock time so 10-min and 1-h cadences share the same per-hour
   *  density and a single archive can mix cadences across time. */
  ms: number;
}

export interface DayGroup {
  key: string;
  /** Single-line "Sat 11" — kept for any consumer that wants the
   *  combined form. The TimeBar uses weekday + dayNum separately so
   *  the day label can stack vertically and the column stays narrow. */
  label: string;
  /** Three-letter weekday name, e.g. "Sat". */
  weekday: string;
  /** Two-digit day-of-month, e.g. "11". */
  dayNum: string;
  /** Epoch ms of the first step in this day. */
  startMs: number;
  /** Epoch ms of the last step in this day. */
  endMs: number;
  /** endMs - startMs. Drives the day-box width (px-per-hour × spanHours)
   *  and the per-step leftPct. Zero when the day has a single step. */
  spanMs: number;
  steps: DayStep[];
}

/** Group timesteps by calendar day for the TimeBar, respecting the chosen zone. */
export function groupTimestepsByDay(
  timesteps: string[],
  tf: TimeFormat,
): DayGroup[] {
  const lead = leadActive(tf);
  const groups = new Map<string, DayGroup>();
  timesteps.forEach((iso, idx) => {
    const d = new Date(iso);
    const ms = d.getTime();
    let key: string;
    let label = "";
    let weekday = "";
    let dayNum = "";
    let hour: string;
    let hourNum: number;
    let minute: number;
    if (lead) {
      // Lead display: 24 h buckets anchored at the run reference, labelled
      // "+0d/+1d/…"; hour ticks are the lead-hour offset within the bucket.
      const totalH = (ms - leadRefMs) / 3_600_000;
      const dayIdx = Math.floor(totalH / 24);
      key = `lead-${dayIdx}`;
      label = `+${dayIdx}d`;
      weekday = "+";
      dayNum = `${dayIdx}d`;
      const within = totalH - dayIdx * 24;
      hourNum = Math.floor(within + 1e-9);
      minute = Math.round((within - hourNum) * 60);
      hour = String(hourNum).padStart(2, "0");
    } else {
      const p = parts(d, tf);
      key = `${p.year}-${p.month}-${p.day}`;
      dayNum = String(p.day).padStart(2, "0");
      weekday = WEEKDAYS[p.weekday];
      label = `${weekday} ${dayNum}`;
      hour = String(p.hour).padStart(2, "0");
      hourNum = p.hour;
      minute = p.minute;
    }
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        label,
        weekday,
        dayNum,
        startMs: ms,
        endMs: ms,
        spanMs: 0,
        steps: [],
      };
      groups.set(key, g);
    }
    g.steps.push({ idx, hour, hourNum, minute, ms });
    if (ms < g.startMs) g.startMs = ms;
    if (ms > g.endMs) g.endMs = ms;
    g.spanMs = g.endMs - g.startMs;
  });
  return Array.from(groups.values());
}

export type WindowMode = "hourly" | "3h" | "6h" | "12h" | "daily";

export interface TimeWindow {
  /** Stable bucket key within (mode, tz). */
  key: string;
  /** Epoch ms of the bucket's nominal start boundary. */
  startMs: number;
  /** Epoch ms of the bucket's nominal end boundary (exclusive). */
  endMs: number;
  /** RFC3339 'Z' instant of the start boundary — the request anchor. */
  startIso: string;
  /** Window length in whole hours: 1 (hourly) / 6 / 12 / 24. */
  spanHours: number;
  /** Native timestep indices in [startMs, endMs). */
  nativeIndices: number[];
  /** True when the covered steps don't fill the nominal window (the
   *  leading/trailing edge of the forecast). */
  partial: boolean;
  /** Pill label. Sub-daily modes show the window's hour range it covers
   *  ("06–12"); daily shows the weekday+day ("Sat 13"). */
  label: string;
  /** Day context for sub-daily pills ("Sat 13"), rendered on a line above
   *  the range so multi-day windowed timelines stay legible. Empty for
   *  daily mode (the label already carries the day). */
  dayLabel: string;
}

const MODE_HOURS: Record<WindowMode, number> = {
  hourly: 1,
  "3h": 3,
  "6h": 6,
  "12h": 12,
  daily: 24,
};

/** Epoch ms of the bucket boundary at or before `ms`, in the chosen tz.
 *  6h floors the hour to a multiple of 6; 12h to a multiple of 12; daily
 *  to local/utc midnight. Uses calendar arithmetic (not fixed offsets)
 *  so DST-shifted days bucket correctly. */
function bucketStartMs(ms: number, mode: WindowMode, tf: TimeFormat): number {
  const span = MODE_HOURS[mode];
  if (leadActive(tf)) {
    // Lead buckets anchor at the run reference, not the calendar.
    const spanMs = span * 3_600_000;
    return leadRefMs + Math.floor((ms - leadRefMs) / spanMs) * spanMs;
  }
  const d = new Date(ms);
  const p = parts(d, tf);
  const flooredHour = span >= 24 ? 0 : Math.floor(p.hour / span) * span;
  if (tf !== "local") {
    return Date.UTC(p.year, p.month, p.day, flooredHour, 0, 0, 0);
  }
  return new Date(p.year, p.month, p.day, flooredHour, 0, 0, 0).getTime();
}

/** Epoch ms of the next bucket boundary after `startMs`. Daily advances
 *  one calendar day (DST-safe); sub-day modes add spanHours. */
function bucketEndMs(startMs: number, mode: WindowMode, tf: TimeFormat): number {
  if (mode !== "daily" || leadActive(tf)) {
    return startMs + MODE_HOURS[mode] * 3_600_000;
  }
  const d = new Date(startMs);
  const p = parts(d, tf);
  if (tf !== "local") return Date.UTC(p.year, p.month, p.day + 1, 0, 0, 0, 0);
  return new Date(p.year, p.month, p.day + 1, 0, 0, 0, 0).getTime();
}

function rfc3339Z(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** Bucket forecast timesteps into windows on the nesting grid
 *  (6h@00/06/12/18, 12h@00/12, daily@00) under the chosen tz. Hourly
 *  returns one window per step. Leading/trailing buckets that don't fill
 *  their nominal window are marked partial. */
export function bucketTimesteps(
  timesteps: string[],
  mode: WindowMode,
  tf: TimeFormat,
): TimeWindow[] {
  if (timesteps.length === 0) return [];
  const stepMs = timesteps.map((s) => Date.parse(s));
  const firstMs = stepMs[0];
  const lastMs = stepMs[stepMs.length - 1];

  if (mode === "hourly") {
    return timesteps.map((iso, idx) => {
      const ms = stepMs[idx];
      return {
        key: `h-${idx}`,
        startMs: ms,
        endMs: ms + 3_600_000,
        startIso: rfc3339Z(ms),
        spanHours: 1,
        nativeIndices: [idx],
        partial: false,
        label: formatStatusTimeParts(iso, tf).clock,
        dayLabel: "",
      };
    });
  }

  const byKey = new Map<number, TimeWindow>();
  stepMs.forEach((ms, idx) => {
    const start = bucketStartMs(ms, mode, tf);
    let w = byKey.get(start);
    if (!w) {
      const end = bucketEndMs(start, mode, tf);
      let label: string;
      let dayLabel: string;
      if (leadActive(tf)) {
        // Lead display: "+0d/+1d" daily pills; "+6–12h" sub-daily ranges
        // with the "+Nd" day context above.
        const dayIdx = Math.floor(leadHoursOf(start) / 24);
        const dl = `+${dayIdx}d`;
        label = mode === "daily" ? dl : `+${leadHoursOf(start)}–${leadHoursOf(end)}h`;
        dayLabel = mode === "daily" ? "" : dl;
      } else {
        const ps = parts(new Date(start), tf);
        const pe = parts(new Date(end), tf);
        const sh = String(ps.hour).padStart(2, "0");
        const eh = String(pe.hour).padStart(2, "0");
        const dl = `${WEEKDAYS[ps.weekday]} ${String(ps.day).padStart(2, "0")}`;
        // Daily: the label is the weekday+day. Sub-daily: the hour range
        // the window covers ("06–12"), with the day carried on dayLabel.
        label = mode === "daily" ? dl : `${sh}–${eh}`;
        dayLabel = mode === "daily" ? "" : dl;
      }
      w = {
        key: `${mode}-${start}`,
        startMs: start,
        endMs: end,
        startIso: rfc3339Z(start),
        spanHours: Math.round((end - start) / 3_600_000),
        nativeIndices: [],
        partial: false,
        label,
        dayLabel,
      };
      byKey.set(start, w);
    }
    w.nativeIndices.push(idx);
  });

  const out = Array.from(byKey.values()).sort((a, b) => a.startMs - b.startMs);
  for (const w of out) {
    // Partial when the nominal window extends past the available step
    // range on either edge.
    w.partial = w.startMs < firstMs || w.endMs > lastMs + 1;
  }
  return out;
}

/**
 * Return the index of the timestep closest to `targetMs` (default: now).
 * Returns 0 for empty or all-invalid inputs. Ties break toward the earlier
 * index.
 */
export function nearestTimestepIndex(
  timesteps: string[],
  targetMs: number = Date.now(),
): number {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < timesteps.length; i++) {
    const t = Date.parse(timesteps[i]);
    if (Number.isNaN(t)) continue;
    const d = Math.abs(t - targetMs);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  return best;
}

/** Index of the frame the client should open at, given the server's
 *  `weather-api:start` anchor (RFC3339 UTC). Falls back to `nowMs`
 *  (default: real now) when the anchor is missing or unparseable, which
 *  reproduces the previous nearest-to-now behaviour. Empty axis → 0. */
export function startAnchorIndex(
  timesteps: string[],
  startIso: string | undefined,
  nowMs: number = Date.now(),
): number {
  const anchorMs = startIso ? Date.parse(startIso) : NaN;
  return nearestTimestepIndex(
    timesteps,
    Number.isFinite(anchorMs) ? anchorMs : nowMs,
  );
}

/** Best-effort short-name for the browser's local timezone at the given instant. */
function localZoneLabel(d: Date): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZoneName: "short",
    }).formatToParts(d);
    const tz = parts.find((p) => p.type === "timeZoneName");
    if (tz && tz.value) return tz.value;
  } catch {
    // fall through
  }
  return "local";
}
