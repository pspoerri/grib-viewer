// Geocoding client shared by the search pill and the point popup's
// reverse lookup, backed by Nominatim (OpenStreetMap). The geocoder can be
// SLOW — callers fire requests once per location, never await them in the
// render path, and let labels pop in late. Requests are debounced by the
// callers per the Nominatim usage policy.

/** Nominatim base URL. Set from /api/mapconfig before the app mounts. */
export let NOMINATIM_BASE = "https://nominatim.openstreetmap.org";

/** Forward-search endpoint (`{base}/search?q=&format=jsonv2&limit=8&addressdetails=0`). */
export let SEARCH_URL = `${NOMINATIM_BASE}/search`;

export function setNominatimBase(base: string): void {
  const normalized = base.trim().replace(/\/+$/, "");
  if (!normalized) return;
  NOMINATIM_BASE = normalized;
  SEARCH_URL = `${normalized}/search`;
}

export interface SearchResult {
  /** [lon, lat] */
  center: [number, number];
  /** [minLon, minLat, maxLon, maxLat] when the place has an extent. */
  bbox?: [number, number, number, number];
  placeName: string;
  /** Short primary label (the place's own name). */
  text: string;
  /** Place kind from the geocoder ("town", "peak", "administrative", …). */
  kind?: string;
  /** Feature's own display zoom, when derivable (place_rank / 2). */
  zoom?: number;
  /** Country context, when present in the display name. */
  country?: string;
  /** IANA timezone — Nominatim doesn't serve one; consumers degrade. */
  timezone?: string;
}

/** Raw Nominatim jsonv2 result (search + reverse share the shape). */
export interface RawResult {
  name?: string;
  display_name?: string;
  /** Strings in jsonv2. */
  lat?: string | number;
  lon?: string | number;
  category?: string;
  type?: string;
  addresstype?: string;
  place_rank?: number;
  /** ["south", "north", "west", "east"] as strings. */
  boundingbox?: (string | number)[];
  error?: string;
}

function num(v: string | number | undefined): number | undefined {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : undefined;
}

/** display_name trimmed to its first two comma segments — "Zürich, Schweiz"
 *  rather than the full six-segment administrative chain. */
export function trimDisplayName(displayName: string | undefined, fallback = ""): string {
  if (!displayName) return fallback;
  const segs = displayName.split(",").map((s) => s.trim()).filter(Boolean);
  return segs.slice(0, 2).join(", ") || fallback;
}

/** Nominatim boundingbox ["s","n","w","e"] → [w, s, e, n]. */
export function nominatimBBox(
  b?: (string | number)[],
): [number, number, number, number] | undefined {
  if (!b || b.length !== 4) return undefined;
  const s = num(b[0]);
  const n = num(b[1]);
  const w = num(b[2]);
  const e = num(b[3]);
  if (s == null || n == null || w == null || e == null) return undefined;
  return [w, s, e, n];
}

/** Map one raw Nominatim result to the app's SearchResult shape (null when it
 *  has no usable coordinates). Nominatim serves no timezone — left absent. */
export function toSearchResult(f: RawResult): SearchResult | null {
  const lat = num(f.lat);
  const lon = num(f.lon);
  if (lat == null || lon == null) return null;
  const name = f.name || trimDisplayName(f.display_name).split(",")[0] || "";
  if (!name) return null;
  const segs = (f.display_name ?? "").split(",").map((s) => s.trim());
  const kind = f.addresstype || f.type;
  return {
    center: [lon, lat],
    bbox: nominatimBBox(f.boundingbox) ?? kindBBox(lat, lon, kind),
    placeName: trimDisplayName(f.display_name, name),
    text: name,
    kind,
    country: segs.length > 1 ? segs[segs.length - 1] : undefined,
    zoom: f.place_rank != null ? Math.round(f.place_rank / 2) : undefined,
  };
}

/** Forward geocode: ranked candidates for a query. */
export async function searchLocations(
  query: string,
  signal?: AbortSignal,
  limit = 8,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: String(limit),
    addressdetails: "0",
  });
  const res = await fetch(`${SEARCH_URL}?${params}`, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`geocode search failed: ${res.status}`);
  const data = (await res.json()) as RawResult[];
  const out: SearchResult[] = [];
  for (const f of Array.isArray(data) ? data : []) {
    const r = toSearchResult(f);
    if (r) out.push(r);
  }
  return out;
}

/** Map zoom appropriate for a place kind (country wide, poi tight). */
export function kindZoom(kind?: string): number {
  switch (kind) {
    case "country":
      return 5;
    case "state":
    case "region":
      return 7;
    case "city":
      return 11;
    case "town":
    case "village":
    case "municipality":
      return 12;
    case "peak":
    case "poi":
    case "neighbourhood":
    case "suburb":
    case "hamlet":
      return 13;
  }
  return 10;
}

/** Kind-scaled [west, south, east, north] extent around a point result — the
 *  fallback zoom hint the map flies to for bbox-less results. */
export function kindBBox(lat: number, lon: number, kind?: string): [number, number, number, number] {
  const half = 360 / 2 ** (kindZoom(kind) + 1);
  return [lon - half, lat - half * 0.6, lon + half, lat + half * 0.6];
}

/** Nominatim reverse zoom for a map zoom: clamp to the [3, 18] level range
 *  the endpoint understands (18 = building, 10 = city, 5 = state). */
export function reverseZoom(mapZoom: number | undefined): number {
  const z = Math.round(mapZoom ?? 10);
  return Math.max(3, Math.min(18, z));
}

/** Reverse-geocode a coordinate to its most relevant nearby place. Nominatim
 *  may return nothing usable (open ocean, remote terrain) → null. The map
 *  zoom the click happened at scales the request's own `zoom` (Nominatim's
 *  granularity control) AND a distance gate: what counts as "here" on a
 *  country-level view is tens of km, on a street-level view a couple. */
export async function reverseGeocode(
  lat: number,
  lon: number,
  zoom?: number,
  signal?: AbortSignal,
): Promise<(SearchResult & { distanceKm: number }) | null> {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    format: "jsonv2",
    zoom: String(reverseZoom(zoom)),
  });
  const res = await fetch(
    `${NOMINATIM_BASE}/reverse?${params}`,
    signal ? { signal } : undefined,
  );
  if (!res.ok) return null;
  const f = (await res.json()) as RawResult | null;
  if (!f || f.error) return null;
  const r = toSearchResult(f);
  if (!r) return null;
  const dLat = ((r.center[1] - lat) * Math.PI) / 180;
  const dLon = (((r.center[0] - lon) * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180);
  const km = Math.sqrt(dLat * dLat + dLon * dLon) * 6371;
  // ~viewport-scaled relevance: ≈2 km at city zoom, tens of km zoomed out.
  const thresholdKm = Math.min(60, Math.max(2, 4000 / 2 ** (zoom ?? 10)));
  if (km > thresholdKm) return null;
  return { ...r, distanceKm: km };
}
