/**
 * wxdata2 — client decode + sampling for the /data native-grid window
 * (the protobuf Window message of spec docs/specs/2026-07-06-03-http-api.md).
 *
 * The Window carries a regular lat/lon grid-def + row-major little-endian int16
 * values + scale/offset/nodata. The GPU resamples it to screen and dequantizes
 * in-shader. lapseFixed() mirrors the serve-side lapse correction.
 *
 * Protobuf is hand-decoded (no runtime dependency), matching the v1 animChunk
 * DataView pattern.
 */

export interface Grid {
  nx: number;
  ny: number;
  lat0: number; // northwest grid point
  lon0: number;
  dlat: number; // < 0 (north→south)
  dlon: number; // > 0 (west→east)
}

export interface Window {
  model: string;
  variable: string;
  grid: Grid;
  values: Int16Array; // row-major, nx*ny
  scale: number;
  offset: number;
  nodata: number; // int16 sentinel
  /** Optional z_model int16 plane (meters, same grid) riding the message —
   *  the lapse correction's model-surface height (field 8). */
  height?: Int16Array;
  /** True when frame times are not wall-clock meaningful (field 11). */
  syntheticTime?: boolean;
  /** Run reference time, unix seconds (field 12) — lead-time display. */
  runUnix?: number;
  /** Web Mercator tile zoom the window was mosaicked from. Legacy field for
   *  the terrarium DEM path (which still mosaics tiles client-side). */
  tileZ?: number;
}

/** Compose same-lattice Windows into one covering Window — in the bbox API
 *  this is "the main viewport window + optional polar-band window(s)" (a
 *  globe view past ±85° issues one extra bbox request per visible pole). A
 *  null entry (404 — no overlap with the model domain) leaves a nodata hole.
 *  Windows whose grid step or quantization disagree with the first are
 *  dropped rather than corrupt the mosaic. Returns null when no window
 *  carried data. */
export function stitchWindows(wins: (Window | null)[]): Window | null {
  const eq = (a: number, b: number) => Math.abs(a - b) <= 1e-9;
  const all = wins.filter((w): w is Window => !!w && w.grid.nx > 0 && w.grid.ny > 0);
  if (all.length === 0) return null;
  const f = all[0];
  const ws = all.filter(
    (w) =>
      eq(w.grid.dlon, f.grid.dlon) &&
      eq(w.grid.dlat, f.grid.dlat) &&
      w.scale === f.scale &&
      w.offset === f.offset &&
      w.nodata === f.nodata,
  );
  if (ws.length === 1) return f;
  const { dlon, dlat } = f.grid;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  let south = Infinity;
  for (const w of ws) {
    west = Math.min(west, w.grid.lon0);
    north = Math.max(north, w.grid.lat0);
    east = Math.max(east, w.grid.lon0 + dlon * (w.grid.nx - 1));
    south = Math.min(south, w.grid.lat0 + dlat * (w.grid.ny - 1)); // dlat < 0
  }
  const nx = Math.round((east - west) / dlon) + 1;
  const ny = Math.round((south - north) / dlat) + 1;
  const values = new Int16Array(nx * ny).fill(f.nodata);
  for (const w of ws) {
    // Neighboring tiles overlap by the server margin; the duplicated cells sit
    // on the same lattice with identical values, so blit order is irrelevant.
    const ci = Math.round((w.grid.lon0 - west) / dlon);
    const rj = Math.round((w.grid.lat0 - north) / dlat);
    for (let j = 0; j < w.grid.ny; j++) {
      values.set(w.values.subarray(j * w.grid.nx, (j + 1) * w.grid.nx), (rj + j) * nx + ci);
    }
  }
  return {
    ...f,
    grid: { nx, ny, lat0: north, lon0: west, dlat, dlon },
    values,
  };
}

/** True when two grid-defs address the exact same texels — same dims and the
 *  same lat/lon origin + step. The lapse drape samples z_model at the VALUE
 *  window's fractional texel coords (same sampleField kernel), which is only
 *  correct when the z_model texture sits on the value's grid; when a value
 *  fetch falls back to a coarser pyramid level than the hsurf fetch, the grids
 *  diverge and the correction must be skipped rather than index a mismatched
 *  texture. nx/ny compare exactly (ints); the float origin/step tolerate a tiny
 *  epsilon (both come from the same server bbox+level+margin, so equal in
 *  practice). */
export function gridsAlign(a: Grid, b: Grid): boolean {
  const eq = (x: number, y: number) => Math.abs(x - y) <= 1e-6;
  return (
    a.nx === b.nx &&
    a.ny === b.ny &&
    eq(a.lat0, b.lat0) &&
    eq(a.lon0, b.lon0) &&
    eq(a.dlat, b.dlat) &&
    eq(a.dlon, b.dlon)
  );
}

class PBReader {
  private view: DataView;
  private off = 0;
  private readonly end: number;

  constructor(buf: ArrayBuffer | Uint8Array) {
    if (buf instanceof Uint8Array) {
      this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    } else {
      this.view = new DataView(buf);
    }
    this.end = this.view.byteLength;
  }

  eof(): boolean {
    return this.off >= this.end;
  }

  /** Reads a base-128 varint as a signed 64-bit value (BigInt), narrowed by caller. */
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.view.getUint8(this.off++);
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
    }
    return BigInt.asIntN(64, result);
  }

  tag(): { field: number; wire: number } {
    const t = Number(this.varint());
    return { field: t >>> 3, wire: t & 0x7 };
  }

  fixed32f(): number {
    const v = this.view.getFloat32(this.off, true);
    this.off += 4;
    return v;
  }

  fixed64f(): number {
    const v = this.view.getFloat64(this.off, true);
    this.off += 8;
    return v;
  }

  bytes(): Uint8Array {
    const n = Number(this.varint());
    const out = new Uint8Array(this.view.buffer, this.view.byteOffset + this.off, n);
    this.off += n;
    return out;
  }

  /** Skips an unknown field of the given wire type. */
  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.varint();
        break;
      case 1:
        this.off += 8;
        break;
      case 2:
        this.off += Number(this.varint());
        break;
      case 5:
        this.off += 4;
        break;
      default:
        throw new Error(`wxdata2: unsupported wire type ${wire}`);
    }
  }
}

function decodeGrid(buf: Uint8Array): Grid {
  const r = new PBReader(buf);
  const g: Grid = { nx: 0, ny: 0, lat0: 0, lon0: 0, dlat: 0, dlon: 0 };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: g.nx = Number(r.varint()); break;
      case 2: g.ny = Number(r.varint()); break;
      case 3: g.lat0 = r.fixed64f(); break;
      case 4: g.lon0 = r.fixed64f(); break;
      case 5: g.dlat = r.fixed64f(); break;
      case 6: g.dlon = r.fixed64f(); break;
      default: r.skip(wire);
    }
  }
  return g;
}

const decoder = new TextDecoder();

function int16LE(bytes: Uint8Array): Int16Array {
  const n = bytes.byteLength >> 1;
  const out = new Int16Array(n);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}

/** Decodes a wxtiles.v2.Window protobuf message. */
export function decodeWindow(buf: ArrayBuffer | Uint8Array): Window {
  return decodeChunk(buf).frames[0];
}

/** An animation chunk: one Window per stacked frame + each frame's valid time. */
export interface Chunk {
  frames: Window[];
  /** RFC3339 UTC valid time per frame (from frame_unix); empty for a plain
   *  single-frame Window. */
  times: string[];
}

/** Decodes a wxtiles.v2.Window that may carry nframes stacked frames (an
 *  animation chunk — one request buffers hours of playback). A plain
 *  single-frame message decodes to one frame with `times` empty. The per-frame
 *  Int16Array views share the response buffer (no copies). */
export function decodeChunk(buf: ArrayBuffer | Uint8Array): Chunk {
  const r = new PBReader(buf);
  const w: Window = {
    model: "",
    variable: "",
    grid: { nx: 0, ny: 0, lat0: 0, lon0: 0, dlat: 0, dlon: 0 },
    values: new Int16Array(0),
    scale: 1,
    offset: 0,
    nodata: -32768,
  };
  let nframes = 0;
  const unix: number[] = [];
  while (!r.eof()) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: w.model = decoder.decode(r.bytes()); break;
      case 2: w.variable = decoder.decode(r.bytes()); break;
      case 3: w.grid = decodeGrid(r.bytes()); break;
      case 4: w.values = int16LE(r.bytes()); break;
      case 5: w.scale = r.fixed32f(); break;
      case 6: w.offset = r.fixed32f(); break;
      case 7: w.nodata = Number(r.varint()); break;
      case 8: {
        const h = int16LE(r.bytes());
        if (h.length > 0) w.height = h;
        break;
      }
      case 9: nframes = Number(r.varint()); break;
      case 10:
        if (wire === 2) {
          // packed varints
          const pr = new PBReader(r.bytes());
          while (!pr.eof()) unix.push(Number(pr.varint()));
        } else {
          unix.push(Number(r.varint()));
        }
        break;
      case 11: w.syntheticTime = Number(r.varint()) !== 0; break;
      case 12: w.runUnix = Number(r.varint()); break;
      default: r.skip(wire);
    }
  }
  const toISO = (u: number) => new Date(u * 1000).toISOString().replace(".000Z", "Z");
  if (nframes <= 1) {
    // A one-frame CHUNK response (a span whose covered set collapsed to one
    // frame — thin data / horizon tail) still carries its frame_unix; dropping
    // it would make the frame unmappable and refetch forever. A plain
    // single-frame Window has no frame_unix → times stays empty.
    return { frames: [w], times: unix.map(toISO) };
  }
  const per = w.grid.nx * w.grid.ny;
  const frames: Window[] = [];
  for (let k = 0; k < nframes; k++) {
    frames.push({ ...w, values: w.values.subarray(k * per, (k + 1) * per) });
  }
  return { frames, times: unix.map(toISO) };
}

/** Cap for edgeDistanceKm — far enough past the 2×50 km exclusion ramp that
 *  every feather/yield clamp saturates. */
export const EDGE_DIST_CAP_KM = 150;

/** Per-texel distance (km) to the nearest NODATA texel — the window's
 *  valid-data edge field, capped at `capKm`.
 *
 *  Why: the composite ladder's contributor bbox is the ENVELOPE of a rotated /
 *  icosahedral native grid, so the true coverage edge is a diagonal that runs
 *  far inside the declared rect (ICON-CH1's west edge sits ~1° inside its bbox
 *  at 46°N). A feather anchored to the rect therefore never fires at the real
 *  data edge and the drape hard-seams where its values go NoData. This field
 *  lets the drape shader feather against the TRUE edge (alpha ∝ dist/featherKm)
 *  and lets coarser drapes ramp their yield with the same measure, keeping the
 *  fine↔coarse handoff a constant-coverage crossfade along arbitrary-shaped
 *  coverage boundaries.
 *
 *  Two-pass chamfer transform with per-row metric steps (dx shrinks with
 *  cos(lat); mercator windows are equirectangular in the grid-def, so the row
 *  latitude is exact). Windows with no nodata at all (global grids) return a
 *  capKm-filled field without scanning twice. The window boundary itself is
 *  NOT an edge — it's the viewport crop, and feathering there would fade every
 *  pan edge. */
export function edgeDistanceKm(w: Window, capKm = EDGE_DIST_CAP_KM): Float32Array {
  const { nx, ny, lat0, dlat, dlon } = w.grid;
  const n = nx * ny;
  const d = new Float32Array(n);
  const INF = capKm * 4;
  let anyNodata = false;
  for (let i = 0; i < n; i++) {
    if (w.values[i] === w.nodata) {
      d[i] = 0;
      anyNodata = true;
    } else {
      d[i] = INF;
    }
  }
  if (!anyNodata) {
    d.fill(capKm);
    return d;
  }
  const KM_PER_DEG = 111.195;
  const dyKm = Math.abs(dlat) * KM_PER_DEG;
  const dxKmAt = (j: number) => {
    const lat = lat0 + dlat * j;
    return Math.max(
      Math.abs(dlon) * KM_PER_DEG * Math.abs(Math.cos((lat * Math.PI) / 180)),
      1e-3,
    );
  };
  // Forward pass: NW → SE.
  for (let j = 0; j < ny; j++) {
    const dxKm = dxKmAt(j);
    const ddKm = Math.hypot(dxKm, dyKm);
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      const idx = row + i;
      let v = d[idx];
      if (v === 0) continue;
      if (i > 0 && d[idx - 1] + dxKm < v) v = d[idx - 1] + dxKm;
      if (j > 0) {
        const up = idx - nx;
        if (d[up] + dyKm < v) v = d[up] + dyKm;
        if (i > 0 && d[up - 1] + ddKm < v) v = d[up - 1] + ddKm;
        if (i < nx - 1 && d[up + 1] + ddKm < v) v = d[up + 1] + ddKm;
      }
      d[idx] = v;
    }
  }
  // Backward pass: SE → NW.
  for (let j = ny - 1; j >= 0; j--) {
    const dxKm = dxKmAt(j);
    const ddKm = Math.hypot(dxKm, dyKm);
    const row = j * nx;
    for (let i = nx - 1; i >= 0; i--) {
      const idx = row + i;
      let v = d[idx];
      if (v === 0) continue;
      if (i < nx - 1 && d[idx + 1] + dxKm < v) v = d[idx + 1] + dxKm;
      if (j < ny - 1) {
        const dn = idx + nx;
        if (d[dn] + dyKm < v) v = d[dn] + dyKm;
        if (i < nx - 1 && d[dn + 1] + ddKm < v) v = d[dn + 1] + ddKm;
        if (i > 0 && d[dn - 1] + ddKm < v) v = d[dn - 1] + ddKm;
      }
      d[idx] = v;
    }
  }
  for (let i = 0; i < n; i++) if (d[i] > capKm) d[i] = capKm;
  return d;
}

/** ICAO standard lapse, −6.5 K/km, in K per metre. */
export const GAMMA_ICAO = -0.0065;

/** lapseFixed: T_site = T_model + γ·(z_site − z_model). Mirrors the serve path. */
export function lapseFixed(tModel: number, zModel: number, zSite: number): number {
  return tModel + GAMMA_ICAO * (zSite - zModel);
}
