// Pure helpers for the dynamic distribution products: building and
// parsing `{base}_gt{V}{unit}` / `{base}_lt{V}{unit}` exceedance ids
// and resolving the precomputed-ladder aliases onto the same grammar.
// Mirrors the backend grammar in backend/internal/models/distspec.go —
// decimal separator is `p` (tot_prec_gt2p5mm), negatives keep their
// `-` (t_2m_lt-5c), Beaufort uses the prefixed form (vmax_10m_gtbft8).
// "Native" throughout means the dist archive's storage units (K,
// m s-1, Pa, mm/h, W m-2) — the same convention as the catalog's
// `dist.min`/`dist.max` envelope.

export type ThresholdDir = "gt" | "lt";

/** The display unit a threshold value is expressed in: the units.ts
 *  group/option pair for grouped units, or groupId=null when the
 *  archive's native unit has no conversion group (mm/h, W m-2) and
 *  the display unit IS the native unit.
 *
 *  When groupId is null, optionId is ignored by the token resolver —
 *  callers conventionally pass the pass-through option id returned by
 *  resolveActiveUnit (e.g. "base"). */
export interface ThresholdUnit {
  groupId: string | null;
  optionId: string;
  /** The dist archive's native units string, from the catalog's
   *  `dist.units` ("K", "m s-1", "Pa", "mm/h", "W m-2", ...). */
  nativeUnits: string;
}

export interface ParsedThreshold {
  base: string;
  dir: ThresholdDir;
  /** Threshold in the dist archive's native units. */
  nativeValue: number;
}

/** Beaufort number → conventional warning threshold in m/s. Mirrors
 *  models.BeaufortThresholdMS so vmax_10m_gtbft7 ⇔ 14 m/s exactly. */
export const BEAUFORT_MS: number[] = [
  0, 0.3, 1.6, 3.4, 5.5, 8, 10.8, 14, 17, 20.8, 25, 28.5, 33,
];

interface TokenSpec {
  token: string;
  /** token-unit value → native units (mirrors distUnitTokens.toNative). */
  toNative: (v: number) => number;
  /** native units → token-unit value. */
  fromNative: (v: number) => number;
}

const TOKENS: Record<string, TokenSpec> = {
  c: { token: "c", toNative: (v) => v + 273.15, fromNative: (v) => v - 273.15 },
  f: {
    token: "f",
    toNative: (v) => ((v - 32) * 5) / 9 + 273.15,
    fromNative: (v) => (v - 273.15) * 1.8 + 32,
  },
  k: { token: "k", toNative: (v) => v, fromNative: (v) => v },
  ms: { token: "ms", toNative: (v) => v, fromNative: (v) => v },
  kmh: { token: "kmh", toNative: (v) => v / 3.6, fromNative: (v) => v * 3.6 },
  kt: {
    token: "kt",
    toNative: (v) => v / 1.94384,
    fromNative: (v) => v * 1.94384,
  },
  mm: { token: "mm", toNative: (v) => v, fromNative: (v) => v },
  in: { token: "in", toNative: (v) => v * 25.4, fromNative: (v) => v / 25.4 },
  hpa: { token: "hpa", toNative: (v) => v * 100, fromNative: (v) => v / 100 },
  w: { token: "w", toNative: (v) => v, fromNative: (v) => v },
};

/** units.ts option id → backend threshold token, for options that
 *  have one of their own. */
const OPTION_TOKEN: Record<string, string> = {
  c: "c",
  f: "f",
  k: "k",
  ms: "ms",
  kmh: "kmh",
  kn: "kt",
  mm: "mm",
  in: "in",
  hpa: "hpa",
};

/** Fallback token per units.ts group for display units without a
 *  backend token (mph, inHg, Pa) — the value converts to native
 *  first, then re-expresses in the fallback token's units. */
const GROUP_FALLBACK_TOKEN: Record<string, string> = {
  temperature: "k",
  windSpeed: "ms",
  pressure: "hpa",
  precipAmount: "mm",
};

/** Display-unit → native conversion for the fallback options. */
const FALLBACK_TO_NATIVE: Record<string, (v: number) => number> = {
  mph: (v) => v * 0.44704,
  inhg: (v) => v * 3386.389,
  pa: (v) => v,
};

/** Token for native unit strings that have no units.ts group (the
 *  slider then operates in the native unit directly). */
const NATIVE_UNIT_TOKEN: Record<string, string> = {
  K: "k",
  "m s-1": "ms",
  "m/s": "ms",
  Pa: "hpa",
  "kg m-2": "mm",
  mm: "mm",
  "mm/h": "mm",
  "W m-2": "w",
  "W/m2": "w",
};

function resolveToken(
  unit: ThresholdUnit,
): { spec: TokenSpec; displayToToken: (v: number) => number } | null {
  if (unit.groupId) {
    const direct = OPTION_TOKEN[unit.optionId];
    if (direct) return { spec: TOKENS[direct], displayToToken: (v) => v };
    const fb = GROUP_FALLBACK_TOKEN[unit.groupId];
    const toNative = FALLBACK_TO_NATIVE[unit.optionId];
    if (fb && toNative) {
      const spec = TOKENS[fb];
      return { spec, displayToToken: (v) => spec.fromNative(toNative(v)) };
    }
    return null;
  }
  const native = NATIVE_UNIT_TOKEN[unit.nativeUnits];
  if (!native) return null;
  // The display value is in native units here; re-express it in the
  // token's units (identity for every entry except Pa → hpa, which
  // would otherwise emit a Pa number under an hpa token).
  const spec = TOKENS[native];
  return { spec, displayToToken: spec.fromNative };
}

/** Encode a threshold number the way the backend grammar expects:
 *  rounded to two decimals, trailing zeros stripped, `.` → `p`. */
function encodeThresholdNumber(v: number): string {
  let r = Math.round(v * 100) / 100;
  if (Object.is(r, -0)) r = 0;
  return r
    .toFixed(2)
    .replace(/0+$/, "")
    .replace(/\.$/, "")
    .replace(".", "p");
}

/** Build a dynamic exceedance id from a display-unit threshold value.
 *  Returns null when the display unit can't be expressed in any
 *  backend token (unknown native units — e.g. `%`). */
export function formatThresholdId(
  base: string,
  dir: ThresholdDir,
  value: number,
  unit: ThresholdUnit,
): string | null {
  const r = resolveToken(unit);
  if (r == null) return null;
  return `${base}_${dir}${encodeThresholdNumber(r.displayToToken(value))}${r.spec.token}`;
}

// The greedy `(.+)` reproduces the backend's last-index `_gt`/`_lt`
// split, so bases containing the literal substring keep parsing.
const THRESH_RE = /^(.+)_(gt|lt)(-?\d+(?:p\d+)?)([a-z]+)$/;
const BFT_RE = /^(.+)_(gt|lt)bft(\d{1,2})$/;

/** Precomputed-ladder ids → their dynamic equivalent. Thresholds are
 *  native values copied from ensemble.StandardProbGroups (frost is
 *  273.15 K, Beaufort 7 is 14 m/s, ...). */
const LADDER_ALIASES: Record<string, ParsedThreshold> = {
  prob_frost: { base: "t_2m", dir: "lt", nativeValue: 273.15 },
  prob_t2m_gt25c: { base: "t_2m", dir: "gt", nativeValue: 298.15 },
  prob_t2m_gt30c: { base: "t_2m", dir: "gt", nativeValue: 303.15 },
  prob_wind_bft5: { base: "vmax_10m", dir: "gt", nativeValue: 8 },
  prob_wind_bft7: { base: "vmax_10m", dir: "gt", nativeValue: 14 },
  prob_wind_bft8: { base: "vmax_10m", dir: "gt", nativeValue: 17 },
  prob_wind_bft10: { base: "vmax_10m", dir: "gt", nativeValue: 25 },
  prob_wind_bft12: { base: "vmax_10m", dir: "gt", nativeValue: 33 },
  prob_prec_gt0p1mm: { base: "tot_prec", dir: "gt", nativeValue: 0.1 },
  prob_prec_gt1mm: { base: "tot_prec", dir: "gt", nativeValue: 1 },
  prob_prec_gt2mm: { base: "tot_prec", dir: "gt", nativeValue: 2 },
  prob_prec_gt5mm: { base: "tot_prec", dir: "gt", nativeValue: 5 },
  prob_prec_gt10mm: { base: "tot_prec", dir: "gt", nativeValue: 10 },
  prob_rad_gt120w: { base: "ghi", dir: "gt", nativeValue: 120 },
  prob_rad_gt400w: { base: "ghi", dir: "gt", nativeValue: 400 },
  prob_rad_gt800w: { base: "ghi", dir: "gt", nativeValue: 800 },
};

/** Curated, meteorologically sensible default thresholds per canonical
 *  dist base (the `distBase` useThreshold receives — the values of
 *  mapConfig.DIST_BASES). Used as the entry-time default when the user
 *  first opens Chance-of on a base, before any remembered choice, so the
 *  marker lands on a meaningful value instead of the raw mid-domain.
 *  Native archive units, matching dist.min/max and ParsedThreshold. Bases
 *  without an entry fall back to the rounded mid-domain. */
export const CURATED_THRESHOLDS: Record<string, { dir: ThresholdDir; nativeValue: number }> = {
  t_2m: { dir: "gt", nativeValue: 293.15 }, // ≥ 20 °C
  td_2m: { dir: "gt", nativeValue: 288.15 }, // ≥ 15 °C dew point
  vmax_10m: { dir: "gt", nativeValue: 14 }, // ≥ Bft 7 (≈50 km/h gust)
  wind_10m: { dir: "gt", nativeValue: 8 }, // ≥ Bft 5
  tot_prec: { dir: "gt", nativeValue: 1 }, // ≥ 1 mm/h
  ghi: { dir: "gt", nativeValue: 400 }, // ≥ 400 W/m²
};

/** Curated entry-time default (dir + native value) for Chance-of mode on
 *  a dist base, or null when none is defined (caller falls back to the
 *  rounded mid-domain). */
export function curatedThreshold(
  distBase: string,
): { dir: ThresholdDir; nativeValue: number } | null {
  return CURATED_THRESHOLDS[distBase] ?? null;
}

/** Parse a dynamic exceedance id OR a precomputed-ladder alias into
 *  (base, direction, native threshold). Returns null for everything
 *  else — plain ids, percentile ids, malformed tails. */
export function parseThresholdId(id: string): ParsedThreshold | null {
  const alias = LADDER_ALIASES[id];
  if (alias) return { ...alias };
  const bm = BFT_RE.exec(id);
  if (bm) {
    const b = parseInt(bm[3], 10);
    if (b < 0 || b > 12) return null;
    return {
      base: bm[1],
      dir: bm[2] as ThresholdDir,
      nativeValue: BEAUFORT_MS[b],
    };
  }
  const m = THRESH_RE.exec(id);
  if (!m) return null;
  const tok = TOKENS[m[4]];
  if (!tok) return null;
  const value = parseFloat(m[3].replace("p", "."));
  if (!Number.isFinite(value)) return null;
  return {
    base: m[1],
    dir: m[2] as ThresholdDir,
    nativeValue: tok.toNative(value),
  };
}

/** Slider/marker domain: the dist archive's value envelope converted
 *  to display units and rounded OUTWARD to the family step, so both
 *  endpoints land on step-aligned values and the full member range
 *  stays reachable. `convert` is the active unit's native→display
 *  conversion; direction-reversing conversions are handled by sorting
 *  the converted endpoints. */
export function thresholdDomain(
  nativeMin: number,
  nativeMax: number,
  convert: (v: number) => number,
  step: number,
): { lo: number; hi: number } {
  const a = convert(nativeMin);
  const b = convert(nativeMax);
  return {
    lo: Math.floor(Math.min(a, b) / step) * step,
    hi: Math.ceil(Math.max(a, b) / step) * step,
  };
}

/** Slider step in display units, per spec: precip 0.1 mm/h,
 *  temperature 0.5 °C (1 °F), wind 1 km/h / 0.5 m/s / 1 kn, pressure
 *  1 hPa, radiation 10 W/m². */
export function thresholdStep(
  groupId: string | null,
  optionId: string,
  nativeUnits: string,
): number {
  if (groupId === "temperature") return optionId === "f" ? 1 : 0.5;
  if (groupId === "windSpeed") return optionId === "ms" ? 0.5 : 1;
  if (groupId === "pressure") return 1;
  if (groupId === "precipAmount") return 0.1;
  if (nativeUnits === "mm/h" || nativeUnits === "kg m-2" || nativeUnits === "mm") return 0.1;
  if (nativeUnits.startsWith("W")) return 10;
  return 1;
}
