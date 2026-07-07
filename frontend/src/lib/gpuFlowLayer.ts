/**
 * GPU-resident wind streamline layer.
 *
 * Particle state lives in a 2D RGBA32F texture sized (TRAIL_LEN, count):
 * each row is one particle, each column one position in a ring-buffer
 * trail. The four channels carry [x, y, age, lifetime] so all per-
 * particle state lives in one texture and a single-attachment FBO is
 * enough.
 *
 * Per frame the update shader writes the column at the current ring
 * write-index — no full-texture shift. Other columns are preserved
 * via a blitFramebuffer copy from the source ping-pong texture
 * before the draw, then the draw's viewport is clamped to a single
 * column so only that column is written. The write index advances
 * mod TRAIL_LEN, so render passes always read [oldest, …, newest]
 * by walking from (writeIndex+1) mod T to writeIndex.
 *
 * u/v come in as a pair of 2D R32F textures (the assembled stitched
 * field for the whole viewport). For fractional playback two slots are
 * bound (slot A = floor frame, slot B = ceil frame) and the update
 * shader lerps between them by `u_alpha` PER SAMPLE — so the wind
 * field smoothly evolves while the playhead is between frames,
 * which is what the user sees as "smoother animation".
 *
 * Projection: identical to WeatherAnimLayer's contour vertex shader
 * (mercator → web-mercator clip via u_matrix, with a globe-aware
 * blend driven by ProjectionData), so streamlines stay locked to the
 * map under pan/zoom and survive the projection toggle.
 */
import type { CustomLayerInterface, Map as MaplibreMap } from "maplibre-gl";
import type { FlowField } from "./flowLines.ts";
import {
  isWebGL2,
  extractProjData,
  computeWrapOffsets,
  translateMatrixX,
  collectUniforms,
  parseCssColor,
  setUniformMatrix4fv,
  setUniform1f,
  setUniform1i,
  setUniform2f,
  setUniform4f,
} from "./glLayerHelpers.ts";

// Number of trail columns per particle (one column written per render
// tick). With dt-aware scaling each step covers the per-frame share
// of the per-second velocity — see the speed calibration in the
// update fragment shader. At the calibration baseline (10 px/sec
// per 10 km/h wind at speedFactor=5) TRAIL_LEN of 64 spans ~1 s of
// motion at 60 Hz: ~10 px trail at light winds, ~30 px at gusty
// winds. Longer trails read as continuous flowlines tracing the
// field rather than disconnected drifting points; the eye joins
// adjacent particles' paths into a coherent overall flow pattern.
const TRAIL_LEN = 64;

export interface GpuFlowLayerOptions {
  id: string;
  /** Particle count. Stored as TRAIL_LEN × count in a 2D texture, so
   *  bumping past ~16K starts to push texture-size limits on low-end
   *  devices. Default 4000. */
  count?: number;
  /** Trail color (CSS). Default white. */
  color?: string;
  /** Layer opacity, 0..1. Default 1. */
  opacity?: number;
  /** Line width in CSS px. Default 1.5. */
  lineWidth?: number;
  /** Wind→displacement scale. Higher = faster particles. Default 1. */
  speedFactor?: number;
  /** Particle lifetime in update steps before respawn. Default 240
   *  — ~4 s at 60 Hz. With TRAIL_LEN=64 (~1 s of trail), this gives
   *  particles ~3× their trail length to live before respawning, so
   *  most of the visible time the trail is fully populated rather
   *  than warming up or decaying. */
  maxAge?: number;
  /** Wall-clock ms per forecast hour during playback. Particle
   *  advection scales by REF_PLAYBACK_MS_PER_HOUR / playbackMsPerHour
   *  so streamline speed tracks the rate of field evolution: at slow
   *  playback particles drift slowly under the slowly-changing field,
   *  at fast playback they whisk along to match. Default 250 (the
   *  prior calibration baseline) preserves the historical visual
   *  speed for callers that don't pass this option. */
  playbackMsPerHour?: number;
}

/** Reference playback rate at which the existing speed calibration
 *  (10 CSS px/sec at 10 km/h wind with u_speed=1) holds verbatim.
 *  Scaling is REF_PLAYBACK_MS_PER_HOUR / playbackMsPerHour, so at the
 *  reference rate the scale is 1 and particles move exactly as they
 *  did before this prop existed. */
const REF_PLAYBACK_MS_PER_HOUR = 250;

interface UVSlot {
  uTex: WebGLTexture | null;
  vTex: WebGLTexture | null;
  /** Field bounds in mercator [0,1]² (xMin, yMin, xMax, yMax). y axis
   *  goes north → south, so yMin < yMax with yMin at the field's
   *  northern edge. */
  bounds: [number, number, number, number];
  /** Field latitude range (north, south) in degrees. The texture's rows are
   *  uniform in LATITUDE (plate-carrée window), not in mercator y — the
   *  shader converts a particle's mercator y back to latitude before the
   *  row lookup. Sampling linearly in mercator y misplaced rows by whole
   *  degrees at high latitudes (streamlines rendered far outside the
   *  model's domain, advecting mid-latitude winds over the Arctic). */
  latRange: [number, number];
  width: number;
  height: number;
}

interface PingPongTex {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export class GpuFlowLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private map: MaplibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;

  private updateProgram: WebGLProgram | null = null;
  private renderProgram: WebGLProgram | null = null;
  private uUpdate: Record<string, WebGLUniformLocation | null> = {};
  private uRender: Record<string, WebGLUniformLocation | null> = {};

  private posA: PingPongTex | null = null;
  private posB: PingPongTex | null = null;
  /** Current "previous frame" texture — the source for the next
   *  update read, and the target for the render pass after the
   *  update has run + swapped. */
  private posSrc: PingPongTex | null = null;
  private posDst: PingPongTex | null = null;

  private quadVAO: WebGLVertexArrayObject | null = null;
  private quadVBO: WebGLBuffer | null = null;
  private trailVAO: WebGLVertexArrayObject | null = null;

  private slotA: UVSlot = makeEmptySlot();
  private slotB: UVSlot = makeEmptySlot();
  private alpha = 0;

  private writeIndex = 0;
  private frame = 0;
  /** Wall-clock timestamp of the previous render() call. The shader
   *  scales per-frame displacement by elapsed dt so animation speed
   *  is independent of the rAF rate (a 30 Hz throttled tab moves
   *  particles the same distance per second as a 60 Hz one). */
  private prevRenderMs: number | null = null;

  private count: number;
  private color: [number, number, number, number] = [1, 1, 1, 1];
  private opacity: number;
  private lineWidth: number;
  private speedFactor: number;
  private maxAge: number;
  private playbackMsPerHour: number;
  private initialized = false;

  constructor(opts: GpuFlowLayerOptions) {
    this.id = opts.id;
    this.count = opts.count ?? 4000;
    this.opacity = opts.opacity ?? 1;
    this.lineWidth = opts.lineWidth ?? 1.5;
    this.speedFactor = opts.speedFactor ?? 1;
    this.maxAge = opts.maxAge ?? 240;
    this.playbackMsPerHour = opts.playbackMsPerHour ?? REF_PLAYBACK_MS_PER_HOUR;
    this.setColor(opts.color ?? "rgba(255,255,255,1)");
  }

  // ── CustomLayerInterface ────────────────────────────────────

  onAdd(map: MaplibreMap, glRaw: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!isWebGL2(glRaw)) {
      throw new Error("GpuFlowLayer requires WebGL2.");
    }
    if (!glRaw.getExtension("EXT_color_buffer_float")) {
      throw new Error(
        "GpuFlowLayer requires EXT_color_buffer_float for float framebuffers.",
      );
    }
    this.map = map;
    this.gl = glRaw;

    this.updateProgram = compile(glRaw, UPDATE_VERT_SRC, UPDATE_FRAG_SRC);
    this.renderProgram = compile(glRaw, RENDER_VERT_SRC, RENDER_FRAG_SRC);

    this.uUpdate = collectUniforms(glRaw, this.updateProgram, [
      "u_pos_in",
      "u_uA", "u_vA", "u_uB", "u_vB",
      "u_alpha", "u_haveB",
      "u_boundsA", "u_boundsB",
      "u_latA", "u_latB",
      "u_writeIndex", "u_trailLen",
      "u_speed", "u_maxAge",
      "u_seed",
      "u_px_to_merc", "u_dt_sec",
    ]);
    this.uRender = collectUniforms(glRaw, this.renderProgram, [
      "u_matrix", "u_fallback_matrix",
      "u_clip_plane", "u_proj_transition",
      "u_pos", "u_writeIndex", "u_trailLen",
      "u_color", "u_opacity",
    ]);

    this.allocateBuffers();
    this.initParticleState();
    this.initialized = true;
  }

  onRemove(_map: MaplibreMap, glRaw: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!isWebGL2(glRaw)) return;
    if (this.posA) {
      glRaw.deleteTexture(this.posA.tex);
      glRaw.deleteFramebuffer(this.posA.fbo);
    }
    if (this.posB) {
      glRaw.deleteTexture(this.posB.tex);
      glRaw.deleteFramebuffer(this.posB.fbo);
    }
    if (this.slotA.uTex) glRaw.deleteTexture(this.slotA.uTex);
    if (this.slotA.vTex) glRaw.deleteTexture(this.slotA.vTex);
    if (this.slotB.uTex) glRaw.deleteTexture(this.slotB.uTex);
    if (this.slotB.vTex) glRaw.deleteTexture(this.slotB.vTex);
    if (this.quadVAO) glRaw.deleteVertexArray(this.quadVAO);
    if (this.quadVBO) glRaw.deleteBuffer(this.quadVBO);
    if (this.trailVAO) glRaw.deleteVertexArray(this.trailVAO);
    if (this.updateProgram) glRaw.deleteProgram(this.updateProgram);
    if (this.renderProgram) glRaw.deleteProgram(this.renderProgram);
    this.gl = null;
    this.map = null;
    this.initialized = false;
  }

  render(glRaw: WebGLRenderingContext | WebGL2RenderingContext, args: unknown): void {
    if (!isWebGL2(glRaw) || !this.initialized) return;
    if (!this.slotA.uTex) return;
    const proj = extractProjData(args);
    if (!proj) return;
    const gl = glRaw;

    // Wall-clock dt — shader uses it to compute per-frame
    // displacement in real-time terms (px/sec rather than px/frame),
    // so animation speed stays the same on a throttled tab. Clamp
    // to 100 ms to keep a long pause from teleporting particles
    // forward when the tab regains focus.
    const now = performance.now();
    const dtMs = this.prevRenderMs == null
      ? 1000 / 60
      : Math.min(100, now - this.prevRenderMs);
    this.prevRenderMs = now;

    // Scale dt by playback rate: at slow playback the wind field
    // evolves slowly, so particles should also drift slowly to keep
    // streamline density legible relative to the rate of change. The
    // reference baseline matches the original calibration, so a
    // caller that doesn't override playbackMsPerHour sees the
    // historical visual speed.
    const playbackScale =
      REF_PLAYBACK_MS_PER_HOUR / Math.max(1, this.playbackMsPerHour);
    const dtSec = (dtMs / 1000) * playbackScale;

    // Mercator units per CSS pixel at the current zoom — converts
    // the shader's pixel-space speed target into mercator
    // displacement. World tile is 256 CSS px at zoom 0; doubling
    // each level. dpr is *not* folded in here because the calibration
    // target ("10 px") is in CSS pixels.
    const zoom = this.map?.getZoom() ?? 0;
    const pxToMerc = 1 / (256 * Math.pow(2, zoom));

    this.runUpdatePass(gl, dtSec, pxToMerc);

    // Render pass: restore canvas FBO and draw trail strips.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(this.renderProgram);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.posSrc!.tex);
    setUniform1i(gl, this.uRender.u_pos, 0);

    setUniform4f(
      gl, this.uRender.u_clip_plane,
      proj.clippingPlane[0], proj.clippingPlane[1],
      proj.clippingPlane[2], proj.clippingPlane[3],
    );
    setUniform1f(gl, this.uRender.u_proj_transition, proj.transition);
    setUniform1i(gl, this.uRender.u_writeIndex, this.writeIndex);
    setUniform1i(gl, this.uRender.u_trailLen, TRAIL_LEN);
    setUniform4f(
      gl, this.uRender.u_color,
      this.color[0], this.color[1], this.color[2], this.color[3],
    );
    setUniform1f(gl, this.uRender.u_opacity, this.opacity);

    gl.lineWidth(Math.max(1, this.lineWidth));
    gl.bindVertexArray(this.trailVAO);

    // World-copy wrap: in flat mercator at low zoom the canvas is
    // wider than one world (256 × 2^z CSS px), so MapLibre wraps
    // copies of the basemap horizontally. The flow layer's particles
    // live in mercator [0,1]² which only covers one world; without
    // an explicit redraw at each copy offset, only the central
    // world strip shows particles and the rest of the page is
    // empty. Globe projection has only one sphere, so suppress the
    // wrap when transitioning toward globe.
    const wrapOffsets =
      proj.transition > 0.001 ? [0] : computeWrapOffsets(this.map);
    for (const wrap of wrapOffsets) {
      const m = wrap === 0 ? proj.matrix : translateMatrixX(proj.matrix, wrap);
      const mFb = wrap === 0
        ? proj.fallbackMatrix
        : translateMatrixX(proj.fallbackMatrix, wrap);
      setUniformMatrix4fv(gl, this.uRender.u_matrix, m);
      setUniformMatrix4fv(gl, this.uRender.u_fallback_matrix, mFb);
      gl.drawArraysInstanced(gl.LINE_STRIP, 0, TRAIL_LEN, this.count);
    }
    gl.bindVertexArray(null);

    // Trigger another repaint so particles keep stepping.
    this.map?.triggerRepaint();
  }

  // ── Public API ─────────────────────────────────────────────

  /**
   * Bind the active u/v field for the floor frame. If `b` is non-null
   * and `alpha > 0`, the update shader linearly interpolates samples
   * from a → b at every particle position. Pass null + alpha=0 for
   * single-frame sampling. Both fields must share width/height/bounds
   * (which the FlowChunkDriver guarantees per viewport).
   */
  setUVFields(a: FlowField, b: FlowField | null, alpha: number): void {
    if (!this.gl) return;
    const gl = this.gl;
    this.uploadFlowFieldInto(gl, this.slotA, a);
    if (b) this.uploadFlowFieldInto(gl, this.slotB, b);
    this.alpha = b ? Math.max(0, Math.min(1, alpha)) : 0;
    this.map?.triggerRepaint();
  }

  setColor(css: string): void {
    this.color = parseCssColor(css);
    this.map?.triggerRepaint();
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    this.map?.triggerRepaint();
  }

  setSpeedFactor(speed: number): void {
    this.speedFactor = speed;
  }

  setPlaybackMsPerHour(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) {
      this.playbackMsPerHour = ms;
    }
  }

  // ── internals ──────────────────────────────────────────────

  private allocateBuffers(): void {
    const gl = this.gl!;

    // Clamp count against GPU limits before allocating. The state
    // texture is TRAIL_LEN × count and the update pass viewport is
    // (1, count), so both MAX_TEXTURE_SIZE and MAX_VIEWPORT_DIMS[1]
    // bound the height. Without this clamp, fp10000 in the URL hash
    // produces a 64×10000 RGBA32F texture that exceeds the 8192 cap
    // on many integrated GPUs and the FBO comes back as
    // FRAMEBUFFER_INCOMPLETE_ATTACHMENT (0x8cd6).
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const maxVp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    const limit = Math.min(maxTex, maxVp[1]);
    if (this.count > limit) {
      console.warn(
        `GpuFlowLayer: clamping particle count ${this.count} → ${limit} (GPU limit).`,
      );
      this.count = limit;
    }

    // Pick the highest-precision float format whose FBO actually
    // checks out as complete. RGBA32F is what EXT_color_buffer_float
    // is supposed to make renderable, but several drivers (Safari /
    // iOS; some Intel integrated GPUs) expose the extension while
    // still failing the FBO completeness check on RGBA32F. RGBA16F
    // halves position precision but is reliably renderable, and at
    // typical display zoom (≤ ~zoom 12) it stays inside one CSS px.
    const fmt = pickFloatFBOFormat(gl, TRAIL_LEN, this.count);

    this.posA = createPingPong(gl, TRAIL_LEN, this.count, fmt);
    this.posB = createPingPong(gl, TRAIL_LEN, this.count, fmt);
    this.posSrc = this.posA;
    this.posDst = this.posB;

    // Full-screen quad for the update fragment dispatch. Drawn with
    // viewport clamped to a single column.
    const verts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.quadVAO = gl.createVertexArray();
    this.quadVBO = gl.createBuffer();
    gl.bindVertexArray(this.quadVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Render VAO is empty — vertex shader uses gl_VertexID + gl_InstanceID.
    this.trailVAO = gl.createVertexArray();
  }

  private initParticleState(): void {
    const gl = this.gl!;
    const N = this.count;
    const T = TRAIL_LEN;
    // Initial positions use the Halton low-discrepancy sequence
    // (base 2 for x, base 3 for y) instead of plain Math.random().
    // Halton guarantees uniform coverage of [0,1]² with no clustering
    // or visible alignment, so on reload streamlines don't all
    // appear to emerge from the same handful of starting points
    // before the field-driven respawn distributes them. Initial ages
    // stay random so respawns are phase-distributed across the
    // particle population.
    const data = new Float32Array(T * N * 4);
    for (let p = 0; p < N; p++) {
      const x = halton(p + 1, 2);
      const y = halton(p + 1, 3);
      const age = Math.random() * this.maxAge;
      for (let c = 0; c < T; c++) {
        const i = (p * T + c) * 4;
        data[i + 0] = x;
        data[i + 1] = y;
        data[i + 2] = age;
        data[i + 3] = this.maxAge;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.posA!.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, T, N, gl.RGBA, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, this.posB!.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, T, N, gl.RGBA, gl.FLOAT, data);
  }

  private runUpdatePass(
    gl: WebGL2RenderingContext,
    dtSec: number,
    pxToMerc: number,
  ): void {
    const src = this.posSrc!;
    const dst = this.posDst!;

    // 1) Copy whole src into dst so untouched columns persist.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo);
    gl.blitFramebuffer(
      0, 0, TRAIL_LEN, this.count,
      0, 0, TRAIL_LEN, this.count,
      gl.COLOR_BUFFER_BIT, gl.NEAREST,
    );
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);

    // 2) Draw the update shader to dst, viewport limited to the
    //    single column we want to write.
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(this.writeIndex, 0, 1, this.count);
    gl.useProgram(this.updateProgram);
    gl.disable(gl.BLEND);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    setUniform1i(gl, this.uUpdate.u_pos_in, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.slotA.uTex!);
    setUniform1i(gl, this.uUpdate.u_uA, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.slotA.vTex!);
    setUniform1i(gl, this.uUpdate.u_vA, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.slotB.uTex ?? this.slotA.uTex!);
    setUniform1i(gl, this.uUpdate.u_uB, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.slotB.vTex ?? this.slotA.vTex!);
    setUniform1i(gl, this.uUpdate.u_vB, 4);

    setUniform1f(gl, this.uUpdate.u_alpha, this.alpha);
    setUniform1i(
      gl, this.uUpdate.u_haveB,
      this.slotB.uTex && this.alpha > 0 ? 1 : 0,
    );
    setUniform4f(
      gl, this.uUpdate.u_boundsA,
      this.slotA.bounds[0], this.slotA.bounds[1],
      this.slotA.bounds[2], this.slotA.bounds[3],
    );
    const sb = this.slotB.uTex ? this.slotB.bounds : this.slotA.bounds;
    setUniform4f(gl, this.uUpdate.u_boundsB, sb[0], sb[1], sb[2], sb[3]);
    setUniform2f(gl, this.uUpdate.u_latA, this.slotA.latRange[0], this.slotA.latRange[1]);
    const sl = this.slotB.uTex ? this.slotB.latRange : this.slotA.latRange;
    setUniform2f(gl, this.uUpdate.u_latB, sl[0], sl[1]);
    setUniform1i(gl, this.uUpdate.u_writeIndex, this.writeIndex);
    setUniform1i(gl, this.uUpdate.u_trailLen, TRAIL_LEN);
    setUniform1f(gl, this.uUpdate.u_speed, this.speedFactor);
    setUniform1f(gl, this.uUpdate.u_maxAge, this.maxAge);
    setUniform1f(gl, this.uUpdate.u_seed, (this.frame * 0.6180339887) % 1);
    setUniform1f(gl, this.uUpdate.u_dt_sec, dtSec);
    setUniform1f(gl, this.uUpdate.u_px_to_merc, pxToMerc);

    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    // 3) Swap src/dst for next frame, advance write index.
    this.posSrc = dst;
    this.posDst = src;
    this.writeIndex = (this.writeIndex + 1) % TRAIL_LEN;
    this.frame += 1;
  }

  private uploadFlowFieldInto(
    gl: WebGL2RenderingContext,
    slot: UVSlot,
    f: FlowField,
  ): void {
    if (!slot.uTex || slot.width !== f.width || slot.height !== f.height) {
      if (slot.uTex) gl.deleteTexture(slot.uTex);
      if (slot.vTex) gl.deleteTexture(slot.vTex);
      slot.uTex = createFloatTex2D(gl, f.width, f.height, gl.R32F);
      slot.vTex = createFloatTex2D(gl, f.width, f.height, gl.R32F);
      slot.width = f.width;
      slot.height = f.height;
    }
    // u/v are stored north-to-south in flowChunkDriver's stitching
    // (row 0 = northernmost), matching the wire format. We upload
    // verbatim and account for the y-direction in the shader's
    // bounds mapping below.
    gl.bindTexture(gl.TEXTURE_2D, slot.uTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, f.width, f.height, gl.RED, gl.FLOAT, f.u);
    gl.bindTexture(gl.TEXTURE_2D, slot.vTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, f.width, f.height, gl.RED, gl.FLOAT, f.v);
    // Bounds layout: (xMin, yMin, xMax, yMax) in mercator [0,1]², y
    // axis north → south. The field's lat-bounds [s, n] map to
    // mercator-y [latToMy(n), latToMy(s)] — north has the smaller y.
    const [w, s, e, n] = f.bounds;
    slot.bounds = [
      lngToMx(w),
      latToMy(n),
      lngToMx(e),
      latToMy(s),
    ];
    slot.latRange = [n, s];
  }
}

// ── Helpers ────────────────────────────────────────────────────

function makeEmptySlot(): UVSlot {
  return {
    uTex: null,
    vTex: null,
    bounds: [0, 0, 1, 1],
    latRange: [85.051129, -85.051129],
    width: 0,
    height: 0,
  };
}

/**
 * Halton low-discrepancy sequence — element `i` for the given prime
 * `base`. Used to seed initial particle positions with guaranteed
 * uniform coverage of [0,1]² (using base 2 for x, base 3 for y); a
 * pair of Math.random() calls would cluster on reload often enough
 * to look like particles emerge from the same handful of points.
 */
function halton(i: number, base: number): number {
  let f = 1;
  let r = 0;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

function lngToMx(lng: number): number {
  return (lng + 180) / 360;
}

function latToMy(lat: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

function createFloatTex2D(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  internalFormat: number,
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("createTexture returned null");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function createPingPong(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  internalFormat: number,
): PingPongTex {
  const tex = createFloatTex2D(gl, w, h, internalFormat);
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error("createFramebuffer returned null");
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0,
  );
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    throw new Error(`GpuFlowLayer FBO incomplete: 0x${status.toString(16)}`);
  }
  return { tex, fbo };
}

/**
 * Try RGBA32F first, fall back to RGBA16F if the FBO comes back
 * incomplete. Returns the internal format that produced a complete
 * FBO at the requested dimensions; throws if neither works.
 */
function pickFloatFBOFormat(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
): number {
  let lastStatus = 0;
  for (const fmt of [gl.RGBA32F, gl.RGBA16F]) {
    const tex = createFloatTex2D(gl, w, h, fmt);
    const fbo = gl.createFramebuffer();
    if (!fbo) {
      gl.deleteTexture(tex);
      throw new Error("createFramebuffer returned null");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0,
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    if (status === gl.FRAMEBUFFER_COMPLETE) {
      if (fmt === gl.RGBA16F) {
        console.warn(
          "GpuFlowLayer: RGBA32F FBO not renderable on this GPU, falling back to RGBA16F (reduced position precision at high zoom).",
        );
      }
      return fmt;
    }
    lastStatus = status;
  }
  throw new Error(
    `GpuFlowLayer FBO incomplete: 0x${lastStatus.toString(16)} (tried RGBA32F + RGBA16F)`,
  );
}

function compile(
  gl: WebGL2RenderingContext,
  vs: string,
  fs: string,
): WebGLProgram {
  const vshader = compileShader(gl, vs, gl.VERTEX_SHADER);
  const fshader = compileShader(gl, fs, gl.FRAGMENT_SHADER);
  const prog = gl.createProgram();
  if (!prog) throw new Error("createProgram returned null");
  gl.attachShader(prog, vshader);
  gl.attachShader(prog, fshader);
  gl.linkProgram(prog);
  gl.detachShader(prog, vshader);
  gl.detachShader(prog, fshader);
  gl.deleteShader(vshader);
  gl.deleteShader(fshader);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog) ?? "";
    gl.deleteProgram(prog);
    throw new Error(`GpuFlowLayer link: ${info}`);
  }
  return prog;
}

function compileShader(gl: WebGL2RenderingContext, src: string, type: number): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader returned null");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh) ?? "";
    gl.deleteShader(sh);
    throw new Error(`GpuFlowLayer shader compile: ${info}\n${src}`);
  }
  return sh;
}

// ── Shaders ────────────────────────────────────────────────────

const UPDATE_VERT_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// One fragment per particle (within the writeIndex column). Reads
// the previous head, integrates one RK2 step, writes new head at
// the column the viewport is clamped to. Out-of-bounds / dead
// particles respawn at a uniformly-random position inside the field.
const UPDATE_FRAG_SRC = `#version 300 es
precision highp float;

uniform sampler2D u_pos_in;
uniform sampler2D u_uA;
uniform sampler2D u_vA;
uniform sampler2D u_uB;
uniform sampler2D u_vB;
uniform float u_alpha;
uniform int   u_haveB;
uniform vec4  u_boundsA;
uniform vec4  u_boundsB;
// Field latitude range (north, south) in degrees — the texture's rows are
// uniform in latitude, so the row lookup needs the particle's latitude,
// not its mercator y.
uniform vec2  u_latA;
uniform vec2  u_latB;
uniform int   u_writeIndex;
uniform int   u_trailLen;
uniform float u_speed;
uniform float u_maxAge;
uniform float u_seed;
uniform float u_dt_sec;       // seconds since the previous update tick
uniform float u_px_to_merc;   // mercator units per CSS pixel at current zoom

layout(location = 0) out vec4 outPos;

// "Hash without Sine" by Dave Hoskins — better dispersion than the
// classic fract(sin(dot(...))) hash, which produces visible aliasing
// artifacts at certain inputs. Particles respawning in the same frame
// share a u_seed component, so a high-quality hash matters: the bad
// hash made batches of adjacent-particle respawns land in correlated
// positions, undoing the per-particle spread we want.
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

#define PI_F 3.14159265358979323846

vec2 sampleField(sampler2D uTex, sampler2D vTex, vec2 m, vec4 bounds, vec2 latNS) {
  if (m.x < bounds.x || m.x > bounds.z || m.y < bounds.y || m.y > bounds.w) {
    return vec2(0.0 / 0.0);
  }
  // Column: mercator x is linear in longitude, so the linear map is exact.
  // Row: rows are uniform in LATITUDE — invert the mercator projection for
  // the particle's latitude first. A linear map in mercator y put rows
  // whole degrees off at high latitudes.
  float latDeg = degrees(2.0 * atan(exp(PI_F - 2.0 * PI_F * m.y)) - PI_F * 0.5);
  vec2 f = vec2(
    (m.x - bounds.x) / (bounds.z - bounds.x),
    (latNS.x - latDeg) / (latNS.x - latNS.y)
  );
  ivec2 sz = textureSize(uTex, 0);
  vec2 size = vec2(sz);
  vec2 p = f * size - 0.5;
  vec2 pf = floor(p);
  vec2 t = clamp(p - pf, 0.0, 1.0);
  ivec2 hi = sz - ivec2(1);
  ivec2 p00 = clamp(ivec2(pf),               ivec2(0), hi);
  ivec2 p10 = clamp(ivec2(pf) + ivec2(1, 0), ivec2(0), hi);
  ivec2 p01 = clamp(ivec2(pf) + ivec2(0, 1), ivec2(0), hi);
  ivec2 p11 = clamp(ivec2(pf) + ivec2(1, 1), ivec2(0), hi);
  float u00 = texelFetch(uTex, p00, 0).r;
  float u10 = texelFetch(uTex, p10, 0).r;
  float u01 = texelFetch(uTex, p01, 0).r;
  float u11 = texelFetch(uTex, p11, 0).r;
  float v00 = texelFetch(vTex, p00, 0).r;
  float v10 = texelFetch(vTex, p10, 0).r;
  float v01 = texelFetch(vTex, p01, 0).r;
  float v11 = texelFetch(vTex, p11, 0).r;
  float u = mix(mix(u00, u10, t.x), mix(u01, u11, t.x), t.y);
  float v = mix(mix(v00, v10, t.x), mix(v01, v11, t.x), t.y);
  return vec2(u, v);
}

vec2 sampleUV(vec2 m) {
  vec2 a = sampleField(u_uA, u_vA, m, u_boundsA, u_latA);
  if (u_haveB == 0) return a;
  vec2 b = sampleField(u_uB, u_vB, m, u_boundsB, u_latB);
  if (any(isnan(a))) return b;
  if (any(isnan(b))) return a;
  return mix(a, b, u_alpha);
}

void main() {
  // gl_FragCoord.x is writeIndex (we clamped the viewport); .y is
  // the particle row 0..count-1.
  int particle = int(gl_FragCoord.y);
  // Read the previous head from column (writeIndex - 1 + T) % T.
  int prevCol = (u_writeIndex - 1 + u_trailLen) % u_trailLen;
  vec4 head = texelFetch(u_pos_in, ivec2(prevCol, particle), 0);
  vec2 m = head.xy;
  float age = head.z;
  float ageMax = head.w > 0.0 ? head.w : u_maxAge;

  bool respawn = age >= ageMax;
  vec2 uv = sampleUV(m);
  if (any(isnan(uv))) respawn = true;
  // Stalled particles (calm air) re-spawn so coverage doesn't drift
  // toward "dead zones" over time.
  if (length(uv) < 0.05) respawn = true;

  if (respawn) {
    vec2 seedKey = vec2(float(particle), u_seed * 17.0);
    vec2 r = vec2(hash21(seedKey), hash21(seedKey + vec2(1.7, 3.3)));
    vec2 newM = mix(u_boundsA.xy, u_boundsA.zw, r);
    outPos = vec4(newM, 0.0, ageMax);
    return;
  }

  // RK2 (midpoint) integration in mercator [0,1]² space. Mercator-y
  // axis points south, so a positive v (northward) decreases y —
  // negate the y contribution.
  //
  // Speed calibration: at u_speed=1 (the baseline slider value), a
  // 10 km/h (= 2.78 m/s) wind should advect a particle 10 CSS px
  // per second. Working backwards:
  //   pxPerSec   = uv_ms × u_speed × K
  //   10         = 2.78  × 1       × K  ⇒  K ≈ 3.6
  //   pxPerStep  = pxPerSec × dt_sec
  //   mercStep   = pxPerStep × pxToMerc
  // So scale (mercator per (m/s × step)) = 3.6 × u_speed × dt × pxToMerc.
  // dt and pxToMerc come in as uniforms so visual speed stays
  // constant across zoom levels (mercator/pixel shrinks as you zoom
  // in) and frame rates (a 30 Hz tab gets 2× the per-step
  // displacement to cover the same per-second distance as 60 Hz).
  float scale = 3.6 * u_speed * u_dt_sec * u_px_to_merc;
  vec2 step1 = vec2(uv.x * scale, -uv.y * scale);
  vec2 mid = m + step1 * 0.5;
  vec2 uv2 = sampleUV(mid);
  if (any(isnan(uv2))) uv2 = uv;
  vec2 step2 = vec2(uv2.x * scale, -uv2.y * scale);
  vec2 newM = m + step2;

  outPos = vec4(newM, age + 1.0, ageMax);
}
`;

const RENDER_VERT_SRC = `#version 300 es
precision highp float;

uniform mat4 u_matrix;
uniform mat4 u_fallback_matrix;
uniform vec4 u_clip_plane;
uniform float u_proj_transition;
uniform sampler2D u_pos;
uniform int u_writeIndex;
uniform int u_trailLen;

out float v_alpha;

#define PI 3.14159265358979323846

vec3 mercatorToSphere(vec2 m) {
  float sx = m.x * 2.0 * PI + PI;
  float sy = 2.0 * atan(exp(PI - (m.y * 2.0 * PI))) - PI * 0.5;
  float clat = cos(sy);
  return vec3(sin(sx) * clat, sin(sy), cos(sx) * clat);
}

void main() {
  // After an update tick, u_writeIndex points at the column that
  // will be OVERWRITTEN next — i.e. the column that currently holds
  // the oldest data. The most recent write sits at (writeIndex - 1)
  // mod T. So trail goes oldest (col writeIndex) → newest
  // (col writeIndex + T - 1 mod T = writeIndex - 1 mod T).
  int particle = gl_InstanceID;
  int t = gl_VertexID;
  int col = (u_writeIndex + t) % u_trailLen;
  vec4 stateNow = texelFetch(u_pos, ivec2(col, particle), 0);
  vec2 m = stateNow.xy;
  float ageNow = stateNow.z;
  float ageMax = stateNow.w > 0.0 ? stateNow.w : 1.0;

  // Continuity check: in a healthy trail, ages walk oldest → newest
  // strictly +1 per step. Anything else is a discontinuity that
  // should not draw a segment connecting unrelated positions:
  //   - Respawn boundary: agePrev = M-1 (old life), ageNow = 0 →
  //     gap = -(M-1).
  //   - Two consecutive respawns (calm-wind areas): both ages = 0,
  //     gap = 0 → still wrong, the older check (just "decrease")
  //     missed this and rendered a screen-spanning line between two
  //     random in-bounds spawn points.
  //   - Pre-warmup init state: all columns share one random age,
  //     gap = 0 between every neighbor → segments suppressed until
  //     the trail has been written enough times to be sequential.
  // Flagging any non-+1 step on either side gives both endpoints of
  // a bad segment v_alpha = 0 simultaneously, fully eliminating the
  // line.
  float jumpFlag = 0.0;
  if (t > 0) {
    int colPrev = (u_writeIndex + t - 1) % u_trailLen;
    float agePrev = texelFetch(u_pos, ivec2(colPrev, particle), 0).z;
    if (abs(ageNow - agePrev - 1.0) > 0.5) jumpFlag = 1.0;
  }
  if (t < u_trailLen - 1) {
    int colNext = (u_writeIndex + t + 1) % u_trailLen;
    float ageNext = texelFetch(u_pos, ivec2(colNext, particle), 0).z;
    if (abs(ageNext - ageNow - 1.0) > 0.5) jumpFlag = 1.0;
  }

  // Trail fade: oldest segment faint, newest at full. Per-particle
  // life envelope holds at 1.0 for most of the lifetime and only
  // smooths out in the last ~15% — a linear fade across the whole
  // life made every particle visibly pulse (bright → dim → respawn
  // → bright) since trail brightness shadowed each particle's age
  // even with phase-distributed initial ages. Holding at full
  // brightness for most of life and tapering only near death keeps
  // the overall visual brightness steady.
  float trailA = float(t) / float(u_trailLen - 1);
  float ageFrac = clamp(ageNow / ageMax, 0.0, 1.0);
  float lifeA = 1.0 - smoothstep(0.85, 1.0, ageFrac);
  v_alpha = trailA * lifeA * (1.0 - jumpFlag);

  vec4 clipPos;
  if (u_proj_transition < 0.001) {
    clipPos = u_matrix * vec4(m, 0.0, 1.0);
  } else {
    vec3 sphere = mercatorToSphere(m);
    vec4 globePos = u_matrix * vec4(sphere, 1.0);
    float clipZ = 1.0 - (dot(sphere, u_clip_plane.xyz) + u_clip_plane.w);
    globePos.z = clipZ * globePos.w;
    if (u_proj_transition > 0.999) {
      clipPos = globePos;
    } else {
      vec4 flatPos = u_fallback_matrix * vec4(m, 0.0, 1.0);
      clipPos = mix(flatPos, globePos, u_proj_transition);
      clipPos.z = mix(0.0, globePos.z,
        clamp((u_proj_transition - 0.2) / 0.8, 0.0, 1.0));
    }
  }
  gl_Position = clipPos;
}
`;

const RENDER_FRAG_SRC = `#version 300 es
precision highp float;

uniform vec4 u_color;
uniform float u_opacity;
in float v_alpha;
out vec4 outColor;

// Non-premultiplied output so the blend func (SRC_ALPHA,
// ONE_MINUS_SRC_ALPHA) gives the standard "dst*(1-a) + color*a"
// blending. Emitting premultiplied (rgb*a) under that blend func
// would multiply colors by alpha twice, crushing faint trail
// segments to invisibility.
void main() {
  float a = v_alpha * u_color.a * u_opacity;
  outColor = vec4(u_color.rgb, a);
}
`;
