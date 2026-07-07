/**
 * wxLayer2 — MapLibre custom GPU layer that drapes a v2 native-grid Window.
 *
 * It uploads the native lat/lon grid as a texture and renders a quad covering the
 * window's mercator bbox. The fragment shader does the projection the RIGHT way:
 * per pixel it inverse-projects its web-mercator position back to (lat, lon),
 * maps that to a grid texel via the window's grid-def, samples + dequantizes +
 * colormaps. (A single flat quad with linear uv would stretch the field, because
 * lat→mercator is nonlinear — hence the per-fragment inverse projection.)
 *
 * Verified rendering both a deterministic global field and an EPS regional field
 * via headless Chrome.
 */
import type { CustomLayerInterface, Map as MaplibreMap } from "maplibre-gl";
import { decodeWindow, edgeDistanceKm, gridsAlign, type Window } from "./wxdata2.ts";
import { isWebGL2, extractProjData, computeWrapOffsets, translateMatrixX } from "./glLayerHelpers.ts";

interface MercatorCoordinate {
  x: number;
  y: number;
}

/** lngLat → MapLibre web-mercator [0,1]. */
function lngLatToMerc(lng: number, lat: number): MercatorCoordinate {
  const x = (180 + lng) / 360;
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return { x, y };
}

// Extended mercator-y parameterization: the world is y∈[0,1] (±85.05°), and
// each polar cap rides a linear-in-latitude band of height POLE_CAP_H beyond
// it (y<0 = north cap → +90, y>1 = south cap → −90). Mercator itself maps the
// poles to ±∞, so without this the mesh — and therefore the globe drape —
// could never cover the caps. The SAME mapping is baked into the vertex and
// fragment shaders (MERC_DECODE); the flat projection clamps y back to [0,1],
// collapsing cap rows onto the world edge (mercator can't show poles anyway).
const MERC_LAT_LIM = 85.05112877980659;
const POLE_CAP_H = 0.02;

/** Latitude → extended mercator y (linear cap bands beyond ±85.05°). */
function latToMercYExt(lat: number): number {
  if (lat > MERC_LAT_LIM) return (-POLE_CAP_H * (lat - MERC_LAT_LIM)) / (90 - MERC_LAT_LIM);
  if (lat < -MERC_LAT_LIM) return 1 + (POLE_CAP_H * (-lat - MERC_LAT_LIM)) / (90 - MERC_LAT_LIM);
  return lngLatToMerc(0, lat).y;
}

/** GLSL inverse of latToMercYExt — shared by the vertex + both fragment
 *  programs so mesh, sphere lift, and texture lookup agree exactly. */
const MERC_DECODE = `
const float MERC_LAT_LIM = 85.05112877980659;
const float POLE_LAT_PER_Y = ${(90 - MERC_LAT_LIM) / POLE_CAP_H};
float mercToLat(float y) {
  if (y < 0.0) return MERC_LAT_LIM - y * POLE_LAT_PER_Y;
  if (y > 1.0) return -MERC_LAT_LIM - (y - 1.0) * POLE_LAT_PER_Y;
  return degrees(atan(sinh(3.14159265358979323846 * (1.0 - 2.0 * y))));
}`;

// Globe-aware vertex projection (same pattern as gpuFlowLayer's RENDER_VERT):
// mercator [0,1] positions go straight through u_matrix in flat mode; in globe
// mode they are lifted onto the unit sphere first (u_matrix is then MapLibre's
// sphere→clip mainMatrix) with a custom clip-Z that culls the back hemisphere —
// depth test is off for the drape, so this clip is the ONLY back cull. The mesh
// is subdivided (buildGeometry) so the quad actually curves around the sphere.
const VERT = `#version 300 es
precision highp float;
uniform mat4 u_matrix;          // globe: sphere→clip; flat: mercator→clip
uniform mat4 u_fallback_matrix; // mercator→clip, used during the transition
uniform vec4 u_clip_plane;      // back-of-globe clipping plane (sphere space)
uniform float u_proj_transition; // 0 = mercator, 1 = globe
// Globe terrain drape: shared z_site DEM window (same terrarium mosaic the
// lapse correction uses). Ground-anchored fields ride the relief (u_liftM = 0);
// atmospheric fields (clouds, upper-air) float u_liftM metres above it.
uniform sampler2D u_terrain; // R32F metres, NaN = nodata (reads as sea level)
uniform vec4 u_terrGeo;      // lon0, dlon, lat0, dlat
uniform vec2 u_terrDim;      // nx, ny
uniform float u_terrOn;      // >0.5 → lift active (manager wires it in globe only)
uniform float u_liftM;       // altitude above the terrain (0 = glued to it)
uniform float u_depthBias;   // clip-space camera-ward nudge while depth testing
in vec2 a_pos;       // extended web-mercator: y<0 / y>1 = polar cap bands
out vec2 v_merc;

#define PI 3.14159265358979323846
${MERC_DECODE}

vec3 mercatorToSphere(vec2 m) {
  float sx = m.x * 2.0 * PI + PI;
  float sy = radians(mercToLat(m.y));
  float clat = cos(sy);
  return vec3(sin(sx) * clat, sin(sy), cos(sx) * clat);
}

float terrTexel(ivec2 c) {
  c = clamp(c, ivec2(0), ivec2(u_terrDim) - 1);
  float v = texelFetch(u_terrain, c, 0).r;
  return isnan(v) ? 0.0 : v;
}

// Bilinear terrain height (metres) at (lon, lat) through the DEM grid-def.
float terrainM(float lon, float lat) {
  vec2 p = vec2((lon - u_terrGeo.x) / u_terrGeo.y, (lat - u_terrGeo.z) / u_terrGeo.w);
  vec2 f0 = floor(p);
  vec2 fr = p - f0;
  ivec2 b = ivec2(f0);
  float v00 = terrTexel(b), v10 = terrTexel(b + ivec2(1, 0));
  float v01 = terrTexel(b + ivec2(0, 1)), v11 = terrTexel(b + ivec2(1, 1));
  return mix(mix(v00, v10, fr.x), mix(v01, v11, fr.x), fr.y);
}

void main() {
  v_merc = a_pos;
  // Terrain lift (0 when u_terrOn is off — flat-projection mode). MapLibre's
  // "globe" renders as vertical-perspective at low zoom but TRANSITIONS TO
  // MERCATOR rendering above ~z11 with terrain still 3D — so the lift must
  // apply on BOTH branches: as a mercator z (metres / earthCirc / cos(lat),
  // the height the mercator+terrain matrix expects) and as a radial sphere
  // displacement (metres / earth radius). Lifting only the sphere branch left
  // the drape flat at city zooms while the OSM overlay rode the relief.
  float lat = mercToLat(a_pos.y);
  float e = 0.0;
  if (u_terrOn > 0.5) {
    e = max(terrainM(a_pos.x * 360.0 - 180.0, lat), 0.0) + u_liftM;
  }
  float zMerc = e / (40075016.686 * max(cos(radians(lat)), 0.05));
  // Flat projection can't show the polar caps — collapse cap rows onto the
  // world edge (degenerate triangles, invisible) instead of painting off-world.
  vec2 flatMerc = vec2(a_pos.x, clamp(a_pos.y, 0.0, 1.0));
  if (u_proj_transition < 0.001) {
    gl_Position = u_matrix * vec4(flatMerc, zMerc, 1.0);
    // Nudge toward the camera so the depth test against MapLibre's terrain
    // mesh (a slightly different triangulation of the same DEM) doesn't
    // speckle the drape with acne. 0 when the depth test is off.
    gl_Position.z -= u_depthBias * gl_Position.w;
    return;
  }
  vec3 sphere = mercatorToSphere(a_pos);
  vec3 surf = sphere * (1.0 + e / 6371008.8);
  vec4 globePos = u_matrix * vec4(surf, 1.0);
  // Mirrors MapLibre's globeComputeClippingZ; lower bound only — an upper
  // clamp would defeat the back cull (v1 lesson: back hemisphere bled through).
  // Clip-Z from the UNLIFTED sphere: terrain must not perturb the back cull.
  float clipZ = 1.0 - (dot(sphere, u_clip_plane.xyz) + u_clip_plane.w);
  globePos.z = max(clipZ, -0.999) * globePos.w;
  if (u_proj_transition > 0.999) {
    gl_Position = globePos;
    return;
  }
  // Mercator↔globe transition: lerp xy/w, delay clip-Z until late in the
  // animation so the back side doesn't pop while still mostly mercator.
  vec4 flatPos = u_fallback_matrix * vec4(flatMerc, zMerc, 1.0);
  vec4 blend = mix(flatPos, globePos, u_proj_transition);
  blend.z = mix(0.0, globePos.z, clamp((u_proj_transition - 0.2) / 0.8, 0.0, 1.0));
  gl_Position = blend;
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_value;     // RG32F: R = dequantized field, current frame (NaN =
                               // nodata); G = km to nearest NoData texel (edge feather)
uniform sampler2D u_valueNext; // RG32F next frame, for GPU tween (sampled only when u_mix > 0)
uniform float u_mix;           // 0..1 blend from u_value → u_valueNext
uniform int u_interp;          // 0 nearest, 1 bilinear, 2 bicubic B-spline
uniform sampler2D u_cmap;    // 1D RGBA colormap
uniform float u_vmin;
uniform float u_vmax;
uniform float u_log;         // >0.5 → log value→t (precip); else linear. Bands are
                             // pre-baked into u_cmap, so stepping needs no uniform.
uniform float u_lat0;        // window grid-def (NW grid point, signed steps)
uniform float u_lon0;
uniform float u_dlat;
uniform float u_dlon;
uniform float u_nx;
uniform float u_ny;
uniform float u_period;      // longitude wrap period in columns (0 = non-periodic)
uniform float u_opacity;     // per-layer alpha for stacked drapes
uniform float u_featherKm;   // composite feather band (km, 0 = off / global base)
uniform vec4  u_domain;      // contributor footprint (west, south, east, north) deg
// Finer ACTIVE contributor domains this (coarser) drape must yield to. v1
// composited per-pixel finest-wins server-side; stacked semi-transparent
// drapes can't reproduce that with alpha alone — a fine model's "dry/clear"
// maps to transparent and the coarse field shows straight through beneath it,
// and alpha-ramp palettes (clouds) double-brighten where domains overlap.
// Fading the coarse drape OUT inside finer domains (the inverse of the fine
// drape's own edge feather) restores finest-wins with a smooth crossfade.
//
// The yield is gated per-pixel on the finer drape's OWN value texture: rotated
// native grids (icond2, iconch*) regrid to a regular-grid archive whose bbox
// corners/edges are NoData, so the finer contributor's bounding rect over-
// states its footprint — yielding by rect alone blanked the coarse drape
// under those NoData regions (black frames tracking the trapezoid edges).
// A finer pixel only claims this fragment when its texture sample is valid.
uniform int   u_nexcl;
uniform vec4  u_excl[6];     // (west, south, east, north) deg per finer domain
uniform vec4  u_exclGeo[6];  // finer window grid-def: lon0, dlon, lat0, dlat
uniform vec2  u_exclDim[6];  // finer window texel dims: nx, ny
uniform sampler2D u_exclTex0; // finer window frame textures (RG32F: R value/NaN,
                              // G km-to-NoData — see u_value);
uniform sampler2D u_exclTex1; // discrete samplers — ES 3.00 forbids dynamic
uniform sampler2D u_exclTex2; // indexing of sampler arrays
uniform sampler2D u_exclTex3;
uniform sampler2D u_exclTex4;
uniform sampler2D u_exclTex5;
uniform float u_exclFeatherKm;
// Elevation lapse correction (screen temps only). corr = u_gamma·(zsite − zmodel),
// added to the value AFTER the frame tween and BEFORE colormap. z_site (the sharp
// DEM) is sampled at the TRUE fragment lat/lon through its own grid-def; z_model
// (hsurf) is sampled at the VALUE's effective grid location with the SAME
// sampleField kernel (u_interp) — the manager guarantees the hsurf window rides
// the value window's grid (same bbox+level+model grid), so z_model reuses u_nx/
// u_ny and needs no grid-def of its own. This keeps the (T, z_model) pair
// correlated inside a model cell (nearest-T ⇒ nearest-z_model of the SAME cell),
// killing the cell-boundary halos/banding the old raw-lat/lon z_model sampling
// produced in steep terrain. A NaN tap or u_lapseOn off → 0, so the drape never
// blanks for lack of terrain data.
uniform float u_lapseOn;     // >0.5 apply the correction
uniform float u_gamma;       // lapse rate (K/m)
uniform sampler2D u_zsite;   // R32F high-res DEM, site elevation (m; NaN nodata)
uniform sampler2D u_zmodel;  // R32F model hsurf on the value grid (m; NaN nodata)
uniform vec4  u_zsiteGeo;    // lon0, dlon, lat0, dlat
uniform vec2  u_zsiteDim;    // nx, ny
// Globe terrain drape (see VERT): the same DEM window also drives a very
// subtle Lambert hillshade on ground-draped fields so the relief reads.
uniform sampler2D u_terrain; // R32F metres, NaN = nodata
uniform vec4  u_terrGeo;     // lon0, dlon, lat0, dlat
uniform vec2  u_terrDim;     // nx, ny
uniform float u_shade;       // hillshade strength, 0 = off (lifted/flat layers)
in vec2 v_merc;
${MERC_DECODE}
out vec4 fragColor;
const float PI = 3.141592653589793;
const float KM_PER_DEG = 111.195;

float bsW(float t){ float a=abs(t); if(a<1.0) return (0.5*a-1.0)*a*a+2.0/3.0; if(a<2.0){float u=2.0-a; return u*u*u/6.0;} return 0.0; }
float texAt(sampler2D s, ivec2 p, vec2 dim){ ivec2 hi=ivec2(int(dim.x)-1,int(dim.y)-1); return texelFetch(s, clamp(p, ivec2(0), hi), 0).r; }
// NaN-aware bilinear at fractional texel coords, weights renormalized over the
// valid (non-nodata) taps; all-nodata → NaN. Parameterized on the texture's own
// grid dims so the field sample and the lapse z-planes share one kernel.
float sampleBilinear(sampler2D s, vec2 p, vec2 dim){
  vec2 f0=floor(p), fr=p-f0; ivec2 b=ivec2(f0);
  float v00=texAt(s,b,dim), v10=texAt(s,b+ivec2(1,0),dim), v01=texAt(s,b+ivec2(0,1),dim), v11=texAt(s,b+ivec2(1,1),dim);
  float w00=(1.0-fr.x)*(1.0-fr.y), w10=fr.x*(1.0-fr.y), w01=(1.0-fr.x)*fr.y, w11=fr.x*fr.y;
  float sum=0.0, ws=0.0;
  if(!isnan(v00)){sum+=w00*v00; ws+=w00;}
  if(!isnan(v10)){sum+=w10*v10; ws+=w10;}
  if(!isnan(v01)){sum+=w01*v01; ws+=w01;}
  if(!isnan(v11)){sum+=w11*v11; ws+=w11;}
  return ws>0.0 ? sum/ws : (0.0/0.0);
}
// NaN-aware field sample at fractional texel coords (texel centres on integers):
// u_interp 0=nearest, 1=bilinear, 2=bicubic B-spline. Weights renormalize over the
// valid (non-nodata) taps so nodata edges don't bleed; all-nodata → NaN.
float sampleField(sampler2D s, vec2 p){
  vec2 dim=vec2(u_nx,u_ny);
  if (u_interp <= 0) return texAt(s, ivec2(floor(p + 0.5)), dim);
  if (u_interp == 1) return sampleBilinear(s, p, dim);
  vec2 pf=floor(p), fr=p-pf; ivec2 base=ivec2(pf);
  float wx[4]; wx[0]=bsW(-1.0-fr.x); wx[1]=bsW(-fr.x); wx[2]=bsW(1.0-fr.x); wx[3]=bsW(2.0-fr.x);
  float wy[4]; wy[0]=bsW(-1.0-fr.y); wy[1]=bsW(-fr.y); wy[2]=bsW(1.0-fr.y); wy[3]=bsW(2.0-fr.y);
  float sum=0.0, ws=0.0;
  for(int j=0;j<4;j++){ for(int i=0;i<4;i++){
    float v=texAt(s, base+ivec2(i-1,j-1), dim);
    if(isnan(v)) continue;
    float w=wx[i]*wy[j]; sum+=w*v; ws+=w;
  }}
  return ws>0.0 ? sum/ws : (0.0/0.0);
}

// value → colormap t∈[0,1]. Linear by default; log when u_log (precip palettes),
// a byte-for-byte mirror of lib/colormap.ts logColorT / render.Colormap.NormT so
// the drape and the legend place a value at the same colour. Log floor = vmin when
// positive, else vmax/1000 (a vmin=0 archive still logs without log(0)); at/below
// the floor → 0 (the transparent first stop).
float colorT(float v){
  if (u_log > 0.5) {
    float lo = u_vmin > 0.0 ? u_vmin : u_vmax * 1e-3;
    if (lo <= 0.0 || u_vmax <= lo || v <= lo) return 0.0;
    return clamp(log(v / lo) / log(u_vmax / lo), 0.0, 1.0);
  }
  return clamp((v - u_vmin) / (u_vmax - u_vmin), 0.0, 1.0);
}

// Distance (km) to the drape's nearest NoData texel, bilinear from the frame
// texture's G channel (edgeDistanceKm — finite everywhere, so plain bilinear).
// This is the drape's TRUE valid-data edge: rotated/icosahedral native grids
// regrid into an archive whose coverage edge runs diagonally far inside the
// declared bbox rect, so rect distance alone never sees the real edge.
float gAt(sampler2D s, ivec2 p, vec2 dim){ ivec2 hi=ivec2(int(dim.x)-1,int(dim.y)-1); return texelFetch(s, clamp(p, ivec2(0), hi), 0).g; }
float edgeKmAt(sampler2D s, vec2 p, vec2 dim){
  vec2 f0=floor(p), fr=p-f0; ivec2 b=ivec2(f0);
  float v00=gAt(s,b,dim), v10=gAt(s,b+ivec2(1,0),dim), v01=gAt(s,b+ivec2(0,1),dim), v11=gAt(s,b+ivec2(1,1),dim);
  return mix(mix(v00, v10, fr.x), mix(v01, v11, fr.x), fr.y);
}

// How much this (coarser) fragment yields to finer contributor i: the F..2F
// band ramp inside the finer domain — where "inside depth" is the LESSER of
// the rect distance and the finer drape's own valid-data edge distance (G
// channel), so the ramp tracks the true (possibly diagonal) coverage edge.
// The finer drape feathers its alpha 0→1 over 0..F of the same measure; the
// coarse fade starting at F keeps that pair a constant-coverage crossfade.
// Outside the finer window texture or on its NoData pixels the yield is 0 and
// the coarse field stays.
float exclYield(sampler2D s, int i, float lon, float lat) {
  vec4 d = u_excl[i];
  float cl = max(cos(radians(lat)), 0.01);
  float eW = (lon - d.x) * cl * KM_PER_DEG;
  float eE = (d.z - lon) * cl * KM_PER_DEG;
  float eS = (lat - d.y) * KM_PER_DEG;
  float eN = (d.w - lat) * KM_PER_DEG;
  float depth = min(min(eW, eE), min(eS, eN)); // >0 inside the finer domain
  float f = max(u_exclFeatherKm, 1.0);
  // Exact early-out: band = ((min(depth, dData) − f) / f) is 0 whenever the
  // rect depth alone is ≤ f, so fragments outside (or on the rim of) the finer
  // domain skip the data-edge texture taps entirely.
  if (depth <= f) return 0.0;
  vec4 g = u_exclGeo[i];
  vec2 dim = u_exclDim[i];
  float fi = (lon - g.x) / g.y;
  float fj = (lat - g.z) / g.w;
  if (fi < -0.5 || fi > dim.x - 0.5 || fj < -0.5 || fj > dim.y - 0.5) return 0.0;
  depth = min(depth, edgeKmAt(s, vec2(fi, fj), dim));
  float band = clamp((depth - f) / f, 0.0, 1.0);
  if (band <= 0.0) return 0.0;
  ivec2 p = ivec2(clamp(floor(vec2(fi, fj) + 0.5), vec2(0.0), dim - 1.0));
  float v = texelFetch(s, p, 0).r;
  return isnan(v) ? 0.0 : band;
}

// Elevation lapse correction: u_gamma·(z_site − z_model). z_site is sampled at
// the TRUE fragment lat/lon (bilinear via its own grid-def) — that's where the
// ridge-scale sharpness comes from. z_model is sampled at the value's effective
// grid location pval=(fi,fj) with the SAME sampleField kernel (u_interp), so
// z_model tracks the value grid cell-for-cell (no interpolation-kernel mismatch,
// no cell-boundary artifacts). Returns 0 when disabled or when either plane has
// no valid sample here — the drape must never blank for missing terrain data.
float lapseCorr(float lat, float lon, vec2 pval){
  if (u_lapseOn < 0.5) return 0.0;
  vec2 ps = vec2((lon - u_zsiteGeo.x) / u_zsiteGeo.y, (lat - u_zsiteGeo.z) / u_zsiteGeo.w);
  float zs = sampleBilinear(u_zsite, ps, u_zsiteDim);
  float zm = sampleField(u_zmodel, pval);
  if (isnan(zs) || isnan(zm)) return 0.0;
  return u_gamma * (zs - zm);
}

float terrAtLL(float lon, float lat){
  vec2 p = vec2((lon - u_terrGeo.x) / u_terrGeo.y, (lat - u_terrGeo.z) / u_terrGeo.w);
  return sampleBilinear(u_terrain, p, u_terrDim);
}

// Very subtle Lambert hillshade from the DEM gradient (central differences one
// DEM cell apart), light matching v1's drape/basemap sun (az 335°, alt 60°).
// Flat terrain or missing data → 1.0. u_shade scales the deviation from 1 and
// the clamp keeps it gentle so stepped palettes don't drown in shading.
float hillshade(float lon, float lat){
  if (u_shade < 0.001) return 1.0;
  float dLon = abs(u_terrGeo.y), dLat = abs(u_terrGeo.w);
  float zE = terrAtLL(lon + dLon, lat), zW = terrAtLL(lon - dLon, lat);
  float zN = terrAtLL(lon, lat + dLat), zS = terrAtLL(lon, lat - dLat);
  if (isnan(zE + zW + zN + zS)) return 1.0;
  float mx = 111320.0 * dLon * max(cos(radians(lat)), 0.05); // metres per DEM cell
  float my = 111320.0 * dLat;
  vec3 nrm = normalize(vec3(-(zE - zW) / (2.0 * mx), -(zN - zS) / (2.0 * my), 1.0));
  vec3 L = vec3(-0.21131, 0.45315, 0.86603); // az 335°, alt 60°, unit length
  float sh = dot(nrm, L) / L.z; // flat ground → exactly 1.0
  return clamp(1.0 + (sh - 1.0) * u_shade, 0.85, 1.06);
}

void main() {
  // Inverse web-mercator: this fragment's mercator → (lat, lon).
  float lon = v_merc.x * 360.0 - 180.0;
  float lat = mercToLat(v_merc.y);
  // (lat,lon) → fractional grid cell → texel (texel centers, no UNPACK_FLIP so
  // data row 0 = north sits at texture t≈0).
  float fi = (lon - u_lon0) / u_dlon;
  float fj = (lat - u_lat0) / u_dlat;
  if (fj < -0.5 || fj > u_ny - 0.5) discard;
  // Global grids wrap at the antimeridian: wrap the column index instead of
  // discarding, so there's no seam/hole where the grid's lon coverage ends.
  if (u_period > 0.5) fi = fi - u_period * floor(fi / u_period);
  else if (fi < -0.5 || fi > u_nx - 0.5) discard;
  // Sample the field with the selected interpolation (NaN-aware). fi,fj are
  // fractional texel coords; texel centres sit on integers.
  float v = sampleField(u_value, vec2(fi, fj));
  // GPU tween: blend toward the next frame. NaN-aware so a nodata cell in one
  // frame falls back to the other instead of punching a hole during playback.
  if (u_mix > 0.0) {
    float vb = sampleField(u_valueNext, vec2(fi, fj));
    if (isnan(v)) v = vb;
    else if (!isnan(vb)) v = mix(v, vb, u_mix);
  }
  if (isnan(v)) discard;
  // Elevation lapse correction (screen temps): shift the tweened value by
  // γ·(z_site − z_model) before colormap so both tween frames correct identically.
  // z_model samples the value's own grid coords (fi,fj) with the value kernel.
  v += lapseCorr(lat, lon, vec2(fi, fj));
  float t = colorT(v);
  vec4 c = texture(u_cmap, vec2(t, 0.5));
  float alpha = u_opacity;
  // Composite feather: ramp alpha to 0 over the u_featherKm band INSIDE the
  // contributor's footprint, so a finer contributor hands off smoothly to the
  // coarser one stacked below instead of hard-seaming at its domain edge.
  // Distance to the nearest footprint edge in km (equirectangular — v1's
  // auto.FeatherWeight). Off (0) for single drapes and the composite's global
  // base, which fills everywhere.
  if (u_featherKm > 0.0) {
    float cosLat = max(cos(radians(lat)), 0.01);
    float dW = (lon - u_domain.x) * cosLat * KM_PER_DEG;
    float dE = (u_domain.z - lon) * cosLat * KM_PER_DEG;
    float dS = (lat - u_domain.y) * KM_PER_DEG;
    float dN = (u_domain.w - lat) * KM_PER_DEG;
    float dEdge = min(min(dW, dE), min(dS, dN));
    // The declared rect is only the coverage ENVELOPE: also feather against
    // the drape's true valid-data edge (G channel — distance to NoData), so
    // rotated-grid contributors fade out along their diagonal coverage edge
    // instead of hard-seaming where the rect feather never fires.
    dEdge = min(dEdge, edgeKmAt(u_value, vec2(fi, fj), vec2(u_nx, u_ny)));
    alpha *= clamp(dEdge / u_featherKm, 0.0, 1.0);
  }
  // Yield to finer active contributors. Under source-over compositing the
  // coarse drape must stay FULLY opaque beneath the finer drape's edge ramp
  // (that pair is already a constant-coverage crossfade); fading both in the
  // same band sums to <1 coverage and draws a basemap-bleed border around the
  // finer domain. So the coarse fade starts only past the feather band
  // (depth F..2F), removing interior show-through/double-draw without
  // touching the edge crossfade. exclYield() additionally gates on the finer
  // drape's own texture: no valid finer sample → no yield, whatever the rect
  // says — the coarse field keeps covering the finer archive's NoData regions.
  if (u_nexcl > 0) alpha *= 1.0 - exclYield(u_exclTex0, 0, lon, lat);
  if (u_nexcl > 1) alpha *= 1.0 - exclYield(u_exclTex1, 1, lon, lat);
  if (u_nexcl > 2) alpha *= 1.0 - exclYield(u_exclTex2, 2, lon, lat);
  if (u_nexcl > 3) alpha *= 1.0 - exclYield(u_exclTex3, 3, lon, lat);
  if (u_nexcl > 4) alpha *= 1.0 - exclYield(u_exclTex4, 4, lon, lat);
  if (u_nexcl > 5) alpha *= 1.0 - exclYield(u_exclTex5, 5, lon, lat);
  if (alpha <= 0.0) discard;
  fragColor = vec4(c.rgb * hillshade(lon, lat), c.a * alpha);
}`;

// Contour program: same inverse-projection as FRAG, but reconstructs the field
// with a 16-tap cubic-B-spline (value + analytic gradient) and draws isolines
// as fwidth-AA lines, optionally over a colormap fill. The B-spline (not
// Catmull-Rom) low-passes texel-scale regridder noise that otherwise beads the
// lines — lifted from v1 animLayerShaders.ts. Adapted to v2's R32F (NaN=nodata)
// 2D texture: float taps + isnan instead of int16 texelFetch + nodata.
// Lapse elevation correction is OUT OF SCOPE here — drape-only (the contour
// program does not apply γ·(z_site − z_model)).
const CONTOUR_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_value;   // R32F dequantized field (NaN = nodata)
uniform sampler2D u_cmap;    // 1D RGBA colormap
uniform float u_vmin;
uniform float u_vmax;
uniform float u_lat0;
uniform float u_lon0;
uniform float u_dlat;
uniform float u_dlon;
uniform float u_nx;
uniform float u_ny;
uniform float u_period;
uniform float u_interval;     // contour spacing, physical units
uniform float u_base;         // contour level offset
uniform float u_lineWidthPx;
uniform float u_fillOn;        // >0.5 = colormap fill under the lines
uniform float u_lineMode;      // <0.5 = colour by level (colormap), else single
uniform vec4  u_lineColor;     // used when u_lineMode >= 0.5
uniform float u_opacity;       // per-layer alpha for stacked drapes
in vec2 v_merc;
${MERC_DECODE}
out vec4 fragColor;
const float PI = 3.141592653589793;

float bsplineW(float t){
  float at = abs(t);
  if (at < 1.0) return (0.5*at - 1.0)*at*at + 2.0/3.0;
  if (at < 2.0){ float u = 2.0 - at; return u*u*u*(1.0/6.0); }
  return 0.0;
}
float bsplineDW(float t){
  float at = abs(t); float s = sign(t);
  if (at < 1.0) return s*(1.5*at - 2.0)*at;
  if (at < 2.0){ float u = 2.0 - at; return -s*0.5*u*u; }
  return 0.0;
}

// 16-tap reconstruction at fractional texel coords p=(fi,fj). Texel centres sit
// at integer fi (the drape samples uv=(fi+0.5)/nx), so p maps straight in — no
// -0.5 shift. Returns vec3(value, dV/dfi, dV/dfj); NaN.x if any tap is nodata.
vec3 sampleGrad(vec2 p){
  ivec2 hi = ivec2(int(u_nx) - 1, int(u_ny) - 1);
  vec2 pf = floor(p);
  vec2 fr = clamp(p - pf, 0.0, 1.0);
  ivec2 base = ivec2(pf);
  float wx[4]; float dwx[4];
  wx[0]=bsplineW(-1.0-fr.x); dwx[0]=-bsplineDW(-1.0-fr.x);
  wx[1]=bsplineW( 0.0-fr.x); dwx[1]=-bsplineDW( 0.0-fr.x);
  wx[2]=bsplineW( 1.0-fr.x); dwx[2]=-bsplineDW( 1.0-fr.x);
  wx[3]=bsplineW( 2.0-fr.x); dwx[3]=-bsplineDW( 2.0-fr.x);
  float wy[4]; float dwy[4];
  wy[0]=bsplineW(-1.0-fr.y); dwy[0]=-bsplineDW(-1.0-fr.y);
  wy[1]=bsplineW( 0.0-fr.y); dwy[1]=-bsplineDW( 0.0-fr.y);
  wy[2]=bsplineW( 1.0-fr.y); dwy[2]=-bsplineDW( 1.0-fr.y);
  wy[3]=bsplineW( 2.0-fr.y); dwy[3]=-bsplineDW( 2.0-fr.y);
  float sumV=0.0; float sumDx=0.0; float sumDy=0.0;
  for (int j=0;j<4;j++){
    for (int i=0;i<4;i++){
      ivec2 px = clamp(base + ivec2(i-1, j-1), ivec2(0), hi);
      float v = texelFetch(u_value, px, 0).r;
      if (isnan(v)) return vec3(0.0/0.0);
      sumV  += v *  wx[i] *  wy[j];
      sumDx += v * dwx[i] *  wy[j];
      sumDy += v *  wx[i] * dwy[j];
    }
  }
  return vec3(sumV, sumDx, sumDy);
}

void main(){
  float lon = v_merc.x * 360.0 - 180.0;
  float lat = mercToLat(v_merc.y);
  float fi = (lon - u_lon0) / u_dlon;
  float fj = (lat - u_lat0) / u_dlat;
  if (fj < -0.5 || fj > u_ny - 0.5) discard;
  if (u_period > 0.5) fi = fi - u_period * floor(fi / u_period);
  else if (fi < -0.5 || fi > u_nx - 0.5) discard;

  vec3 s = sampleGrad(vec2(fi, fj));
  float v = s.x;
  if (isnan(v)) discard;

  // Screen-space gradient via lon/lat derivatives (continuous in v_merc, so no
  // antimeridian-wrap discontinuity — fi's modular wrap would corrupt dFdx(fi)).
  float dVdlon = s.y / u_dlon;
  float dVdlat = s.z / u_dlat;
  vec2 grad = vec2(
    dVdlon * dFdx(lon) + dVdlat * dFdx(lat),
    dVdlon * dFdy(lon) + dVdlat * dFdy(lat)
  );
  float gmag = max(length(grad), 1e-7);

  float k = floor((v - u_base) / u_interval + 0.5);
  float level = u_base + k * u_interval;
  float sd = (v - level) / gmag;
  float halfW = u_lineWidthPx * 0.5;
  float a = 1.0 - smoothstep(halfW, halfW + 1.0, abs(sd));

  float tv = clamp((v - u_vmin) / (u_vmax - u_vmin), 0.0, 1.0);
  vec4 fill = u_fillOn > 0.5 ? texture(u_cmap, vec2(tv, 0.5)) : vec4(0.0);
  vec3 lineRGB;
  if (u_lineMode < 0.5){
    float tl = clamp((level - u_vmin) / (u_vmax - u_vmin), 0.0, 1.0);
    lineRGB = texture(u_cmap, vec2(tl, 0.5)).rgb;
  } else {
    lineRGB = u_lineColor.rgb;
  }
  vec4 outc = mix(fill, vec4(lineRGB, 1.0), a);
  if (outc.a <= 0.0) discard;
  fragColor = vec4(outc.rgb, outc.a * u_opacity);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error("wxLayer2 shader: " + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export interface WxLayerOptions {
  vmin: number;
  vmax: number;
  colormap: Uint8Array; // RGBA, N*4
}

export interface ContourState {
  interval: number;
  base: number;
  lineMode: 0 | 1; // 0 = colour by level, 1 = single colour
  lineColor: [number, number, number, number];
  fillOn: boolean;
  widthPx: number;
}

/** A MapLibre CustomLayerInterface drawing one decoded v2 Window. */
export class WxV2Layer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private contourProgram: WebGLProgram | null = null;
  private mode: "drape" | "contour" = "drape";
  private opacity = 1;
  private featherKm = 0; // composite feather band (km); 0 = off
  private domain: [number, number, number, number] = [-180, -90, 180, 90]; // w,s,e,n
  // Finer ACTIVE contributor layers this drape yields to (see u_excl in FRAG).
  // Live references: their domain rect, window grid-def, and value texture are
  // read at draw time so the per-pixel NoData gate always sees the current frame.
  private excl: WxV2Layer[] = [];
  private exclFeatherKm = 50;
  private contour: ContourState = {
    interval: 1,
    base: 0,
    lineMode: 0,
    lineColor: [1, 1, 1, 1],
    fillOn: true,
    widthPx: 1.5,
  };
  private posBuf: WebGLBuffer | null = null;
  private idxBuf: WebGLBuffer | null = null;
  private valueTex: WebGLTexture | null = null;
  private valueTexNext: WebGLTexture | null = null; // next-frame texture for GPU tween
  private cmapTex: WebGLTexture | null = null;
  private idxCount = 0;
  private win: Window | null = null; // current frame window (owns the grid-def)
  private winNext: Window | null = null; // next frame window (shares win's grid)
  private mix = 0; // 0..1 tween factor between the two frame textures
  private interp = 0; // drape interpolation: 0 nearest, 1 bilinear, 2 bicubic
  private logScale = 0; // 0 linear, 1 log value→t (drape only; precip palettes)
  private opts: WxLayerOptions;
  private map: MaplibreMap | null = null;
  // Mesh extents (extended-mercator): what the current mesh covers and the
  // full window bbox — the render-time staleness check rebuilds the clipped
  // mesh when the camera outgrows it (cached-window pans bypass setWindow).
  private builtExtent: { x0: number; x1: number; y0: number; y1: number } | null = null;
  private winExtent: { x0: number; x1: number; y0: number; y1: number } | null = null;
  private period = 0; // longitude wrap period (cols per 360°); 0 = non-periodic
  // Lapse-rate elevation correction inputs (E3 wiring; E4 implements the
  // shader). z_site = high-res DEM window; z_model = this contributor's hsurf
  // window; gamma = lapse rate (K/m); on = whether to apply. Stored only for
  // now — the drape shader ignores them until E4.
  private lapseZSite: Window | null = null;
  private lapseZModel: Window | null = null;
  private lapseGamma = 0;
  private lapseOn = false;
  private zsiteTex: WebGLTexture | null = null; // R32F z_site DEM (lapse)
  private zmodelTex: WebGLTexture | null = null; // R32F z_model hsurf (lapse)
  // Globe terrain drape: DEM window lifting the mesh onto (or above) the relief,
  // plus the hillshade strength for ground-draped fields. Cleared in flat mode.
  private terrainWin: Window | null = null;
  private terrainTex: WebGLTexture | null = null;
  private terrainLiftM = 0;
  private shadeStrength = 0;

  constructor(id: string, opts: WxLayerOptions) {
    this.id = id;
    this.opts = opts;
  }

  onAdd(map: MaplibreMap, glRaw: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!isWebGL2(glRaw)) return; // the float data-texture path needs WebGL2
    const gl = glRaw;
    this.map = map;
    this.gl = gl;
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error("wxLayer2 link: " + gl.getProgramInfoLog(p));
    }
    this.program = p;
    const cp = gl.createProgram()!;
    gl.attachShader(cp, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(cp, compile(gl, gl.FRAGMENT_SHADER, CONTOUR_FRAG));
    gl.linkProgram(cp);
    if (!gl.getProgramParameter(cp, gl.LINK_STATUS)) {
      throw new Error("wxLayer2 contour link: " + gl.getProgramInfoLog(cp));
    }
    this.contourProgram = cp;
    this.posBuf = gl.createBuffer();
    this.idxBuf = gl.createBuffer();
    this.cmapTex = this.makeColormap(gl, this.opts.colormap);
    // A window/colormap may have been set before the GL context existed (the data
    // fetch can win the race against the map's load → onAdd). Upload it now and
    // repaint, else the drape stays blank until the first user-triggered move.
    if (this.win) this.upload(this.win);
    if (this.winNext) this.uploadNext(this.winNext);
    if (this.lapseZSite && this.lapseZModel) this.uploadLapse(this.lapseZSite, this.lapseZModel);
    if (this.terrainWin) this.terrainTex = this.makeValueTex(gl, this.terrainWin);
    map.triggerRepaint();
  }

  /** Decode + display a window response (protobuf bytes). */
  setWindowBytes(buf: ArrayBuffer | Uint8Array): void {
    this.setWindow(decodeWindow(buf));
  }

  setWindow(w: Window): void {
    this.win = w;
    this.winNext = null;
    this.mix = 0;
    if (this.gl) this.upload(w);
    this.map?.triggerRepaint();
  }

  /** Set the current + next frame windows and the tween factor (0..1) for smooth
   *  GPU playback. `b` must share `a`'s grid (same viewport + level fetch); b=null
   *  (or mix<=0) renders `a` alone. Re-uploads only the texture that changed, so a
   *  mix-only update during a frame dwell should go through setMix instead. */
  setFrames(a: Window, b: Window | null, mix: number): void {
    const reA = a !== this.win;
    const reB = b !== this.winNext;
    this.win = a;
    this.winNext = b;
    this.mix = b ? Math.max(0, Math.min(1, mix)) : 0;
    if (this.gl) {
      if (reA) this.upload(a);
      if (b && reB) this.uploadNext(b);
    }
    this.map?.triggerRepaint();
  }

  /** Update only the tween factor (both frame textures already uploaded). */
  setMix(mix: number): void {
    this.mix = this.winNext ? Math.max(0, Math.min(1, mix)) : 0;
    this.map?.triggerRepaint();
  }

  /** Hide the drape (e.g. when a contour/value mode owns the display). render()
   * early-returns with no window, so this blanks the layer without removing it. */
  clear(): void {
    this.win = null;
    this.winNext = null;
    this.mix = 0;
    this.map?.triggerRepaint();
  }

  /** Switch render program: "drape" (colormap fill) or "contour" (GPU isolines
   *  over an optional fill). Both use the same uploaded window. */
  setMode(mode: "drape" | "contour"): void {
    this.mode = mode;
    this.map?.triggerRepaint();
  }

  /** Update contour styling (interval / base / line colour / fill / width). */
  setContourState(s: Partial<ContourState>): void {
    this.contour = { ...this.contour, ...s };
    this.map?.triggerRepaint();
  }

  /** Update the value→colour window (physical units) without re-uploading data. */
  setRange(vmin: number, vmax: number): void {
    this.opts.vmin = vmin;
    this.opts.vmax = vmax;
    this.map?.triggerRepaint();
  }

  /** Drape interpolation mode: 0 nearest, 1 bilinear, 2 bicubic B-spline. */
  setInterp(mode: number): void {
    this.interp = mode | 0;
    this.map?.triggerRepaint();
  }

  /** Log value→colour mapping (drape program): true for log palettes (precip),
   *  so the drape places a value at the same colour the log-scaled legend does.
   *  Temperature stepping is baked into the colormap texture, not here. */
  setLog(on: boolean): void {
    this.logScale = on ? 1 : 0;
    this.map?.triggerRepaint();
  }

  /** Per-layer alpha for stacked drapes (1 = opaque). */
  setOpacity(a: number): void {
    this.opacity = a;
    this.map?.triggerRepaint();
  }

  /** Composite feather: ramp alpha to 0 over `km` inside the contributor footprint
   *  `domain` (west, south, east, north), so stacked contributors blend instead of
   *  hard-seaming at the domain edge. km=0 disables it (single drape / global base). */
  setFeather(km: number, domain: [number, number, number, number]): void {
    this.featherKm = Math.max(0, km);
    this.domain = domain;
    this.map?.triggerRepaint();
  }

  /** Finer ACTIVE contributor layers this coarser drape must yield to this
   *  frame — faded out over featherKm past their domain edge, gated per-pixel
   *  on the finer drape's own valid data (per-pixel finest-wins, v1 semantics). */
  setExclusions(finer: WxV2Layer[], featherKm: number): void {
    this.excl = finer.slice(0, 6);
    this.exclFeatherKm = Math.max(1, featherKm);
    this.map?.triggerRepaint();
  }

  /** Lapse-rate elevation correction inputs for a screen-temperature drape.
   *  z_site (high-res DEM) and z_model (this contributor's hsurf) are native
   *  Windows over the current viewport; gamma is the lapse rate (K/m); `on`
   *  gates whether the correction is applied. The drape shader adds
   *  γ·(z_site − z_model) to the value before colormap. Passing (null, null, γ,
   *  false) clears/disables the correction (corr → 0). The two z planes upload
   *  as R32F textures (reusing makeValueTex) and only rebuild when their window
   *  ref changes — the manager gates re-issue on (bbox, level) so this is not a
   *  per-frame GPU upload. */
  setLapse(
    zsite: Window | null,
    zmodel: Window | null,
    gamma: number,
    on: boolean,
  ): void {
    this.lapseGamma = gamma;
    this.lapseOn = on && zsite != null && zmodel != null;
    if (this.gl) this.uploadLapse(zsite, zmodel);
    else {
      this.lapseZSite = zsite;
      this.lapseZModel = zmodel;
    }
    this.map?.triggerRepaint();
  }

  /** Globe terrain drape: lift the mesh onto the DEM (+liftM metres above it)
   *  and, for ground-draped fields (liftM 0), apply the subtle hillshade at
   *  `shade` strength. Passing (null, 0, 0) clears it (flat mode / DEM missing).
   *  The texture rebuilds only when the window ref changes — the manager gates
   *  re-issue on (globe, bbox, zoom). */
  setTerrainDrape(zsite: Window | null, liftM: number, shade: number): void {
    this.terrainLiftM = liftM;
    this.shadeStrength = shade;
    if (this.gl && (zsite !== this.terrainWin || (zsite && !this.terrainTex))) {
      if (this.terrainTex) this.gl.deleteTexture(this.terrainTex);
      this.terrainTex = zsite ? this.makeValueTex(this.gl, zsite) : null;
    }
    this.terrainWin = zsite;
    this.map?.triggerRepaint();
  }

  // (Re)build the two terrain textures from their windows, reusing makeValueTex
  // (same dequantize + NaN-nodata path). A texture is rebuilt only when its
  // window ref changed (or it's missing); nulls delete + unbind so the shader's
  // NaN/u_lapseOn guards drive corr → 0.
  private uploadLapse(zsite: Window | null, zmodel: Window | null): void {
    const gl = this.gl!;
    if (zsite !== this.lapseZSite || (zsite && !this.zsiteTex)) {
      if (this.zsiteTex) gl.deleteTexture(this.zsiteTex);
      this.zsiteTex = zsite ? this.makeValueTex(gl, zsite) : null;
    }
    if (zmodel !== this.lapseZModel || (zmodel && !this.zmodelTex)) {
      if (this.zmodelTex) gl.deleteTexture(this.zmodelTex);
      this.zmodelTex = zmodel ? this.makeValueTex(gl, zmodel) : null;
    }
    this.lapseZSite = zsite;
    this.lapseZModel = zmodel;
  }

  /** Swap the colormap (RGBA, N*4) — rebuilds the 1D colour texture. */
  setColormap(rgba: Uint8Array): void {
    this.opts.colormap = rgba;
    if (this.gl) {
      if (this.cmapTex) this.gl.deleteTexture(this.cmapTex);
      this.cmapTex = this.makeColormap(this.gl, rgba);
    }
    this.map?.triggerRepaint();
  }

  private makeColormap(gl: WebGL2RenderingContext, rgba: Uint8Array): WebGLTexture {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, rgba.length / 4, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  // Dequantize a window into an R32F texture (nodata → NaN, which the shaders
  // discard). NEAREST filtering: R32F LINEAR needs OES_texture_float_linear;
  // NEAREST is core WebGL2 and the inverse-projection samples texel centres.
  private makeValueTex(gl: WebGL2RenderingContext, w: Window): WebGLTexture {
    const { nx, ny } = w.grid;
    const f = new Float32Array(nx * ny);
    for (let i = 0; i < f.length; i++) {
      const raw = w.values[i];
      f[i] = raw === w.nodata ? NaN : raw * w.scale + w.offset;
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, nx, ny, 0, gl.RED, gl.FLOAT, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  // FRAME textures carry a second channel: G = distance (km) to the window's
  // nearest NoData texel (edgeDistanceKm), the drape's TRUE valid-data edge.
  // The composite ladder's contributor bbox is only the ENVELOPE of a rotated/
  // icosahedral native grid — the real coverage edge runs diagonally far inside
  // it — so the shader feathers alpha (and coarser drapes ramp their yield)
  // against min(rect distance, this data distance). R stays the dequantized
  // value (NaN nodata) so every existing .r sampler is unaffected.
  //
  // The distance field depends only on the NoData mask, which is the model's
  // static coverage on a fixed grid — cache it per grid-def so playback frame
  // swaps re-run only the interleave, not the chamfer.
  private edgeDistCache: { key: string; data: Float32Array } | null = null;

  private edgeDistFor(w: Window): Float32Array {
    const g = w.grid;
    const key = `${g.nx}|${g.ny}|${g.lat0}|${g.lon0}|${g.dlat}|${g.dlon}`;
    if (this.edgeDistCache?.key !== key) {
      this.edgeDistCache = { key, data: edgeDistanceKm(w) };
    }
    return this.edgeDistCache.data;
  }

  private makeFrameTex(gl: WebGL2RenderingContext, w: Window): WebGLTexture {
    const { nx, ny } = w.grid;
    const dist = this.edgeDistFor(w);
    const f = new Float32Array(nx * ny * 2);
    for (let i = 0; i < nx * ny; i++) {
      const raw = w.values[i];
      f[i * 2] = raw === w.nodata ? NaN : raw * w.scale + w.offset;
      f[i * 2 + 1] = dist[i];
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, nx, ny, 0, gl.RG, gl.FLOAT, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  // Current frame: (re)build its value texture + the covering quad. Deletes the
  // prior texture first — without this, every frame swap during playback leaked
  // an R32F texture (a global field is tens of MB of VRAM per frame).
  private upload(w: Window): void {
    const gl = this.gl!;
    if (this.valueTex) gl.deleteTexture(this.valueTex);
    this.valueTex = this.makeFrameTex(gl, w);
    this.buildGeometry(w);
  }

  // Next frame (tween target): just its value texture; the geometry/period come
  // from the current frame, which shares the grid (same viewport + level fetch).
  private uploadNext(w: Window): void {
    const gl = this.gl!;
    if (this.valueTexNext) gl.deleteTexture(this.valueTexNext);
    this.valueTexNext = this.makeFrameTex(gl, w);
  }

  /** Padded visible extent in (extended-)mercator world units, or null when
   *  the full window should be meshed (low zoom / no map). The mesh's fixed
   *  vertex budget must serve the VISIBLE area, not the fetched window: since
   *  the z/x/y datatile switch a window is a covering TILE that can be 10×+
   *  the viewport at high zoom, and 128 segments across it starve the
   *  per-vertex terrain lift — the drape grew a km-faceted ghost mountain
   *  with the real basemap peak showing through it ("transparent Matterhorn"). */
  private viewClip(): { x0: number; x1: number; y0: number; y1: number } | null {
    const map = this.map;
    if (!map) return null;
    const z = map.getZoom();
    if (z < 6) return null; // window ≈ viewport at low zoom; the sphere needs the full mesh
    const c = map.getCenter();
    const canvas = map.getCanvas();
    const dpr = window.devicePixelRatio || 1;
    // Pitch widens the visible ground toward the horizon — grow the pad with it.
    const K = 2.5 + 4 * ((map.getPitch?.() ?? 0) / 60);
    const sx = ((K * canvas.width) / dpr / 512) * 2 ** -z;
    const sy = ((K * canvas.height) / dpr / 512) * 2 ** -z;
    const cm = lngLatToMerc((((c.lng + 180) % 360) + 360) % 360 - 180, c.lat);
    return { x0: cm.x - sx / 2, x1: cm.x + sx / 2, y0: cm.y - sy / 2, y1: cm.y + sy / 2 };
  }

  /** Mesh extent for the current camera: the window bbox intersected with the
   *  padded viewport (unwrapped into the window's frame for periodic grids).
   *  Falls back to the full window when they don't overlap (offscreen layer). */
  private meshExtent(win: { x0: number; x1: number; y0: number; y1: number }): {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
  } {
    const vc = this.viewClip();
    if (!vc) return win;
    let cx0 = vc.x0;
    if (this.period > 0) cx0 = win.x0 + ((((cx0 - win.x0) % 1) + 1) % 1);
    const x0 = Math.max(win.x0, cx0);
    const x1 = Math.min(win.x1, cx0 + (vc.x1 - vc.x0));
    const y0 = Math.max(win.y0, vc.y0);
    const y1 = Math.min(win.y1, vc.y1);
    return x1 > x0 && y1 > y0 ? { x0, x1, y0, y1 } : win;
  }

  private buildGeometry(w: Window): void {
    const gl = this.gl!;
    const { nx, ny, lat0, lon0, dlat, dlon } = w.grid;
    // Longitudinal periodicity: a global grid wraps at the antimeridian. period
    // = columns per 360° (nx when there's no redundant wrap column); 0 = regional.
    this.period =
      Math.abs(Math.abs(nx * dlon) - 360) < 1 ? nx : Math.abs(Math.abs((nx - 1) * dlon) - 360) < 1 ? nx - 1 : 0;

    // A subdivided mesh covering the window's geographic bbox in mercator. The
    // fragment shader inverse-projects each pixel, so in flat mode a single quad
    // would suffice — the subdivision exists for globe mode, where each vertex is
    // lifted onto the sphere and a 4-vertex quad would render as a flat plane
    // cutting through the planet. Segment count scales with the mercator span
    // (global field → 64 segments ≈ 3.8°/cell, sub-pixel chord error; a regional
    // window gets just a few). For a periodic grid extend the east edge a full
    // 360° so adjacent world copies tile with no gap (the shader wraps the
    // lookup across the seam).
    const eastLon = this.period > 0 ? lon0 + 360 : lon0 + (nx - 1) * dlon;
    const nw = lngLatToMerc(lon0, lat0);
    const se = lngLatToMerc(eastLon, lat0 + (ny - 1) * dlat);
    // Extended y: poleward of ±85.05° rides the linear cap band (finite, so a
    // pole-to-pole grid meshes cleanly). The vertex shader collapses cap rows
    // onto the world edge in flat mode and lifts them onto the sphere in globe.
    const y0 = latToMercYExt(lat0);
    const y1 = latToMercYExt(lat0 + (ny - 1) * dlat);
    // Clip the meshed extent to the padded viewport (see viewClip) so the
    // fixed vertex budget always serves what's on screen; the FRAG samples
    // the full window texture by lat/lon either way, so clipping never
    // changes WHAT is drawn — only how finely its terrain lift is meshed.
    this.winExtent = { x0: nw.x, x1: se.x, y0, y1 };
    const ext = this.meshExtent(this.winExtent);
    this.builtExtent = ext;
    // Mesh density serves two masters: sphere-chord accuracy (coarse cells
    // leave chord-vs-arc slivers at composite domain edges) and the TERRAIN
    // lift, which is sampled per-vertex. The full-window sphere keeps 254²
    // (sub-pixel chord error); a viewport-CLIPPED extent means the terrain
    // drape at high zoom, where the silhouette must match MapLibre's own
    // ~19 m terrain mesh — 254 segments over the pitch-padded extent is
    // ~60 m and its narrower crest silhouette left an undrapped border
    // around peaks, so clipped meshes double to 510² (32-bit indices;
    // WebGL2 guarantees UNSIGNED_INT elements).
    const segsX = ext === this.winExtent ? 254 : 510;
    const segsY = segsX;
    const pos = new Float32Array((segsX + 1) * (segsY + 1) * 2);
    for (let j = 0, k = 0; j <= segsY; j++) {
      const y = ext.y0 + ((ext.y1 - ext.y0) * j) / segsY;
      for (let i = 0; i <= segsX; i++) {
        pos[k++] = ext.x0 + ((ext.x1 - ext.x0) * i) / segsX;
        pos[k++] = y;
      }
    }
    const idx = new Uint32Array(segsX * segsY * 6);
    for (let j = 0, k = 0; j < segsY; j++) {
      for (let i = 0; i < segsX; i++) {
        const a = j * (segsX + 1) + i;
        const c = a + segsX + 1;
        idx[k++] = a;
        idx[k++] = a + 1;
        idx[k++] = c;
        idx[k++] = c;
        idx[k++] = a + 1;
        idx[k++] = c + 1;
      }
    }
    this.idxCount = idx.length;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  }

  render(glRaw: WebGLRenderingContext | WebGL2RenderingContext, args: unknown): void {
    const prog = this.mode === "contour" ? this.contourProgram : this.program;
    if (!isWebGL2(glRaw) || !prog || !this.valueTex || this.idxCount === 0 || !this.win) return;
    // Rebuild the viewport-clipped mesh when the camera outgrew it: a pan can
    // reveal window area beyond the built extent, and a zoom change makes the
    // built density wrong for the screen. 10% hysteresis keeps continuous
    // pans/zooms from rebuilding every frame (a rebuild is ~16.6k verts).
    if (this.winExtent && this.builtExtent) {
      const want = this.meshExtent(this.winExtent);
      const b = this.builtExtent;
      const tol = 0.1 * Math.max(want.x1 - want.x0, want.y1 - want.y0);
      if (
        Math.abs(want.x0 - b.x0) > tol ||
        Math.abs(want.x1 - b.x1) > tol ||
        Math.abs(want.y0 - b.y0) > tol ||
        Math.abs(want.y1 - b.y1) > tol
      ) {
        this.buildGeometry(this.win);
      }
    }
    const proj = extractProjData(args);
    if (!proj) return;
    const gl = glRaw;
    const g = this.win.grid;
    const u = (name: string) => gl.getUniformLocation(prog, name);

    gl.useProgram(prog);
    gl.uniform1f(u("u_vmin"), this.opts.vmin);
    gl.uniform1f(u("u_vmax"), this.opts.vmax);
    gl.uniform1f(u("u_lat0"), g.lat0);
    gl.uniform1f(u("u_lon0"), g.lon0);
    gl.uniform1f(u("u_dlat"), g.dlat);
    gl.uniform1f(u("u_dlon"), g.dlon);
    gl.uniform1f(u("u_nx"), g.nx);
    gl.uniform1f(u("u_ny"), g.ny);
    gl.uniform1f(u("u_period"), this.period);
    gl.uniform1f(u("u_opacity"), this.opacity);
    let lapseActive = false;
    if (this.mode === "drape") {
      // Lapse elevation correction: the drape shader adds γ·(z_site − z_model)
      // to the value before colormap. u_lapseOn gates it; bind the two z planes
      // to units 9/10 (a harmless valueTex stands in when inactive so the
      // samplers stay complete — never sampled under u_lapseOn=0).
      // z_model must ride the VALUE window's grid so the shader can sample it at
      // the value's (fi,fj) with u_interp. That holds by construction (same
      // bbox+level+model grid), but a value-window level-fallback can diverge the
      // two grids — in which case disable lapse for this frame rather than index a
      // mismatched z_model texture (the manager re-aligns on the next fetch).
      lapseActive = !!(
        this.lapseOn &&
        this.zsiteTex &&
        this.zmodelTex &&
        this.lapseZSite &&
        this.lapseZModel &&
        gridsAlign(this.win.grid, this.lapseZModel.grid)
      );
      gl.uniform1f(u("u_lapseOn"), lapseActive ? 1 : 0);
      gl.uniform1f(u("u_gamma"), this.lapseGamma);
      if (lapseActive) {
        const zs = this.lapseZSite!.grid;
        gl.uniform4f(u("u_zsiteGeo"), zs.lon0, zs.dlon, zs.lat0, zs.dlat);
        gl.uniform2f(u("u_zsiteDim"), zs.nx, zs.ny);
      }
      gl.activeTexture(gl.TEXTURE9);
      gl.bindTexture(gl.TEXTURE_2D, lapseActive ? this.zsiteTex : this.valueTex);
      gl.uniform1i(u("u_zsite"), 9);
      gl.activeTexture(gl.TEXTURE10);
      gl.bindTexture(gl.TEXTURE_2D, lapseActive ? this.zmodelTex : this.valueTex);
      gl.uniform1i(u("u_zmodel"), 10);
      gl.uniform1f(u("u_log"), this.logScale);
      gl.uniform1f(u("u_featherKm"), this.featherKm);
      gl.uniform4f(u("u_domain"), this.domain[0], this.domain[1], this.domain[2], this.domain[3]);
      // A finer layer only participates once it has a window texture to gate
      // the per-pixel yield on; until then the coarse field keeps covering it.
      const ex = this.excl.filter((e) => e.valueTex && e.win).slice(0, 6);
      gl.uniform1i(u("u_nexcl"), ex.length);
      gl.uniform1f(u("u_exclFeatherKm"), this.exclFeatherKm);
      ex.forEach((e, i) => {
        const d = e.domain;
        const eg = e.win!.grid;
        gl.uniform4f(u(`u_excl[${i}]`), d[0], d[1], d[2], d[3]);
        gl.uniform4f(u(`u_exclGeo[${i}]`), eg.lon0, eg.dlon, eg.lat0, eg.dlat);
        gl.uniform2f(u(`u_exclDim[${i}]`), eg.nx, eg.ny);
        gl.activeTexture(gl.TEXTURE3 + i);
        gl.bindTexture(gl.TEXTURE_2D, e.valueTex);
        gl.uniform1i(u(`u_exclTex${i}`), 3 + i);
      });
    }
    if (this.mode === "contour") {
      const c = this.contour;
      gl.uniform1f(u("u_interval"), c.interval);
      gl.uniform1f(u("u_base"), c.base);
      gl.uniform1f(u("u_lineWidthPx"), c.widthPx);
      gl.uniform1f(u("u_fillOn"), c.fillOn ? 1 : 0);
      gl.uniform1f(u("u_lineMode"), c.lineMode);
      gl.uniform4f(u("u_lineColor"), c.lineColor[0], c.lineColor[1], c.lineColor[2], c.lineColor[3]);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.valueTex);
    gl.uniform1i(u("u_value"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.cmapTex);
    gl.uniform1i(u("u_cmap"), 1);
    if (this.mode === "drape") {
      // Next-frame texture + tween factor (0 ⇒ u_value used as-is, no blend).
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.valueTexNext ?? this.valueTex);
      gl.uniform1i(u("u_valueNext"), 2);
      gl.uniform1f(u("u_mix"), this.winNext ? this.mix : 0);
      // Lapse forces ≥ bilinear: with nearest, the reduced temp T − γ·z_model is
      // per-cell constant and steps at every cell border (γ·z_site only adds
      // detail WITHIN a cell), painting a faint native-grid "tile" seam. The
      // same-kernel invariant means interpolating value+z_model together blends
      // the reduced temp across cells — continuous, and closer to the server's
      // always-bilinear /point sampling. Explicit bicubic (2) is untouched.
      gl.uniform1i(u("u_interp"), lapseActive ? Math.max(this.interp, 1) : this.interp);
    }

    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // A 2D drape ignores depth — but once the mesh is lifted onto the terrain
    // it self-overlaps in screen space at pitch, and without hidden-surface
    // removal the drape of the valley BEHIND a mountain paints over the peak.
    // MapLibre's terrain pass has already written its depth here, so in the
    // mercator-rendering regime (globe high zoom / flat+terrain) we depth-TEST
    // against it (never write — the drape must not occlude labels). The pure
    // sphere branch keeps depth off: its z is the synthetic back-cull value.
    const terrOn = !!(this.terrainTex && this.terrainWin);
    const depthOcclude = terrOn && proj.transition < 0.001;
    if (depthOcclude) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      // Slope-scaled pull toward the camera (classic shadow-acne treatment):
      // at silhouette-grazing angles a few metres of drape-vs-terrain
      // triangulation mismatch is a huge screen-space depth gap — the
      // constant u_depthBias alone left an undrapped border around peaks.
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-4, -4);
    } else {
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    gl.uniform1f(u("u_depthBias"), depthOcclude ? 1e-3 : 0);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);

    // Globe projection state (no-ops in flat mode: transition = 0).
    gl.uniformMatrix4fv(u("u_fallback_matrix"), false, proj.fallbackMatrix);
    const cp = proj.clippingPlane;
    gl.uniform4f(u("u_clip_plane"), cp[0], cp[1], cp[2], cp[3]);
    gl.uniform1f(u("u_proj_transition"), proj.transition);
    // Globe terrain drape: mesh lift (both programs — shared VERT) + hillshade
    // (drape FRAG only; the contour program has no u_shade). A harmless valueTex
    // stands in when inactive so the sampler stays complete, never sampled
    // under u_terrOn = 0.
    gl.uniform1f(u("u_terrOn"), terrOn ? 1 : 0);
    // +6 m while depth-occluding: the fixed-budget mesh undersamples crest
    // maxima, leaving the drape silhouette a few pixels inside the terrain's —
    // an undrapped fringe against the sky that no depth bias can cover (there
    // is no drape fragment there at all). A few metres of uniform lift tucks
    // the drape envelope over the terrain silhouette; invisible otherwise.
    gl.uniform1f(u("u_liftM"), this.terrainLiftM);
    gl.uniform1f(u("u_shade"), terrOn ? this.shadeStrength : 0);
    if (terrOn) {
      const tg = this.terrainWin!.grid;
      gl.uniform4f(u("u_terrGeo"), tg.lon0, tg.dlon, tg.lat0, tg.dlat);
      gl.uniform2f(u("u_terrDim"), tg.nx, tg.ny);
    }
    gl.activeTexture(gl.TEXTURE11);
    gl.bindTexture(gl.TEXTURE_2D, terrOn ? this.terrainTex : this.valueTex);
    gl.uniform1i(u("u_terrain"), 11);

    // Draw once per visible world copy so the field wraps across the
    // antimeridian / repeats when zoomed out. The geometry stays at mercator
    // [0,1] (so the grid lookup is unchanged); only the matrix shifts. Globe
    // has a single sphere — suppress the wrap while transitioning toward it.
    const offsets = proj.transition > 0.001 ? [0] : computeWrapOffsets(this.map);
    for (const wrap of offsets) {
      const m = wrap === 0 ? proj.matrix : translateMatrixX(proj.matrix, wrap);
      gl.uniformMatrix4fv(u("u_matrix"), false, m);
      gl.drawElements(gl.TRIANGLES, this.idxCount, gl.UNSIGNED_INT, 0);
    }
  }
}
