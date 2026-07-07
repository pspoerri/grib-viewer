// Display-unit conversion for API-provided base units.
//
// The backend always stores and serves values in a canonical base unit
// (K for temperature, m s-1 for wind, Pa for pressure, kg m-2 for
// accumulated precipitation, m for lengths). The user, however, usually
// wants to see °C, km/h, hPa, mm, ft, etc. This module centralises the
// base-unit → display-unit mapping and the conversion math so any
// component can ask "given base unit X and the user's prefs, what is
// the active display unit and how do I convert a value to it?"
//
// The conversion is purely cosmetic for the map tile layer (the tile
// PNG is pre-rendered from the archive), but it matters for the point
// popup (raw sample values) and the colormap legend labels.

export interface UnitOption {
  id: string;
  label: string;
  /** Convert a value from the group's base unit to this option. */
  convert: (v: number) => number;
}

export interface UnitGroup {
  id: string;
  /**
   * Normalised (lowercase, trimmed) base-unit strings the backend may
   * report for variables in this group. The first entry is the
   * canonical spelling for documentation.
   */
  baseKeys: string[];
  options: UnitOption[];
  defaultOptionId: string;
}

const identity = (v: number): number => v;

export const UNIT_GROUPS: UnitGroup[] = [
  {
    id: "temperature",
    baseKeys: ["k", "kelvin"],
    defaultOptionId: "c",
    options: [
      { id: "c", label: "°C", convert: (k) => k - 273.15 },
      { id: "f", label: "°F", convert: (k) => (k - 273.15) * 1.8 + 32 },
      { id: "k", label: "K", convert: identity },
    ],
  },
  {
    id: "windSpeed",
    baseKeys: ["m s-1", "m/s", "ms-1", "m s^-1"],
    defaultOptionId: "kmh",
    options: [
      { id: "kmh", label: "km/h", convert: (v) => v * 3.6 },
      { id: "ms", label: "m/s", convert: identity },
      { id: "mph", label: "mph", convert: (v) => v * 2.2369362920544 },
      { id: "kn", label: "kn", convert: (v) => v * 1.9438444924406 },
    ],
  },
  {
    id: "pressure",
    baseKeys: ["pa", "pascal"],
    defaultOptionId: "hpa",
    options: [
      { id: "hpa", label: "hPa", convert: (v) => v / 100 },
      { id: "pa", label: "Pa", convert: identity },
      { id: "inhg", label: "inHg", convert: (v) => v * 0.0002952998057228486 },
    ],
  },
  {
    // kg m-2 of water is numerically identical to millimetres of water
    // column, which is the quantity users actually want for rain/snow.
    id: "precipAmount",
    baseKeys: ["kg m-2", "kg/m2", "kg/m^2", "kg m^-2"],
    defaultOptionId: "mm",
    options: [
      { id: "mm", label: "mm", convert: identity },
      { id: "in", label: "in", convert: (v) => v / 25.4 },
    ],
  },
  {
    id: "length",
    baseKeys: ["m", "meter", "metre", "meters", "metres"],
    defaultOptionId: "m",
    options: [
      { id: "m", label: "m", convert: identity },
      { id: "km", label: "km", convert: (v) => v / 1000 },
      { id: "ft", label: "ft", convert: (v) => v * 3.280839895013123 },
    ],
  },
  {
    // Geopotential height. The backend serves fi_{N}hpa in gpm
    // (geopotential metres); dam (decametres, gpm ÷ 10) is the synoptic
    // convention for upper-air height charts and is the default, so
    // contour labels / legend / point popups read like "552". gpm stays
    // available as a raw option.
    id: "geopotential",
    baseKeys: ["gpm"],
    defaultOptionId: "dam",
    options: [
      { id: "dam", label: "dam", convert: (v) => v / 10 },
      { id: "gpm", label: "gpm", convert: identity },
    ],
  },
];

function normUnit(u: string): string {
  return u.trim().toLowerCase();
}

/**
 * Return the unit group whose baseKeys match the given base unit, or
 * undefined if no conversion is known.
 */
export function unitGroupForBase(baseUnit: string): UnitGroup | undefined {
  const norm = normUnit(baseUnit);
  if (!norm) return undefined;
  return UNIT_GROUPS.find((g) => g.baseKeys.includes(norm));
}

/**
 * The concrete display unit picked for a variable, given its base unit
 * and the user's per-group preferences. If the base unit has no known
 * group, the returned option is a pass-through whose label is the base
 * unit verbatim, so call sites can treat "unknown" uniformly.
 */
export interface ActiveUnit {
  /** Non-null if a known unit group matched the base unit. */
  groupId: string | null;
  option: UnitOption;
  /** The base unit as reported by the API, used for diagnostics. */
  baseLabel: string;
}

/**
 * Resolve the active display unit for a base unit. Looks up the user's
 * preference for the matching group; falls back to the group default,
 * or to a pass-through identity option when the base unit is unknown.
 */
export function resolveActiveUnit(
  baseUnit: string,
  preferences: Record<string, string>,
): ActiveUnit {
  const group = unitGroupForBase(baseUnit);
  if (!group) {
    return {
      groupId: null,
      option: { id: "base", label: baseUnit, convert: identity },
      baseLabel: baseUnit,
    };
  }
  const prefId = preferences[group.id];
  const option =
    (prefId && group.options.find((o) => o.id === prefId)) ||
    group.options.find((o) => o.id === group.defaultOptionId) ||
    group.options[0];
  return { groupId: group.id, option, baseLabel: baseUnit };
}
