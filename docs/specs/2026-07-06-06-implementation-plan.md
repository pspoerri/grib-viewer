# 06 — Implementation plan (self-reviewed)

Strategy change (user directive): `wetter-api/` stays in-tree as the
**reference implementation** during the build — port proven code from
it instead of rewriting, adapting to the new architecture (online
derivation, bbox windows, multi-run). Remove the reference at the end.

## Order of work

1. **Backend foundation** (new architecture, written fresh):
   - `internal/config` — YAML config.
   - `internal/gribidx` — GRIB message indexing straight off
     go-tiled-eccodes (`grib.Index`): param→name table (ported),
     ref time, step, level, member, grid; `index.json` per run.
   - `internal/buffer` — data_dir layout, atomic writes, `latest`
     pointer, retention.
2. **Ported algorithm packages** (lift from reference, trim):
   - `internal/grid` (KD-tree NN + index maps, latlon grid, NaN-aware
     bicubic/max-pool downsample), `internal/render` (colormaps +
     legend), `internal/ensemble` (per-cell reducer, paired reducer),
     `internal/vars` (quantization catalog, field registry, ladders,
     units), `internal/contour` (marching squares — backend keeps it
     only if the frontend needs a fallback; GPU contours are primary).
3. **Derive engine** (`internal/engine`, new): field + reduction LRU
   caches (byte-budgeted, singleflight), disk-cached regrid index
   maps, de-accumulation/tavg kernels, derived registry (ported
   kernels), pyramid levels, the `Window`/`Sample` primitives.
4. **Sources** (`internal/sources`): folder (header-indexed), DWD
   opendata (ported listing/regex logic, generalized), MeteoSwiss
   STAC (ported), http-index; s3 minimal (anonymous ListObjectsV2).
   Fetch orchestrator: loop/once tickers, 8-conn pool, status.
5. **HTTP API** (`internal/api`): spec 03 surface. Var-id grammar +
   time grammar ported (ontology/timespec/distspec/units) and
   extended (`+{N}h` lead form, `?run=`). Hand-rolled protobuf
   encoder for `Window` (mirrors the frontend's hand-rolled decoder;
   round-trip tested) — no protoc in the build.
6. **Frontend**: port `wetter-api/frontend` wholesale, then adapt:
   - `v2client` → `/api`, bbox `/data` (no XYZ), `?run=`.
   - `wxLayerManager`: viewport-bbox windows (+ polar bands) instead
     of tile stitching; keep the LRU/chunk-prefetch/abort structure.
   - Keep `wxLayer2` (drape + GPU contours), `gpuFlowLayer`,
     colormap/units/time modules, all components.
   - Geocode → Nominatim (search + reverse).
   - New: run browser (uses `/runs`), Lead time format,
     `synthetic_time` degradations.
   - Basemap styles vendored into `public/styles/` from tiles.rsp.li;
     terrain per Mapterhorn example (raster-dem + existing terrarium
     lapse path).
7. **Integration + benchmark**: `make smoke` (folder source with a
   downloaded fixture), then `cmd/bench` — fetch a small real
   ICON-D2 subset from DWD, time cold/warm window, point series,
   chunk, ensemble products; frontend `pnpm build` + unit tests.
8. Remove `wetter-api/`.

## Self-review (risks, and what the plan does about them)

- **Decoder API drift**: the reference wraps go-tiled-eccodes behind
  a facade; the new code uses it directly. Mitigation: read `go doc`
  for Message/Header/RegularLatLon first; port the facade's params
  table and icosahedral constants plumbing semantics, not its API.
- **Protobuf wire mismatch** backend-encoder ↔ frontend-decoder:
  both sides ported from the same reference pair; add a golden
  round-trip test (Go encode → committed fixture → TS decode test).
- **Frontend port breakage**: the reference frontend expects
  `/api/v2` + XYZ datatiles + archive-derived catalogs. Contain the
  change surface to `src/api/*` + `wxLayerManager`; leave GPU/UI
  modules byte-close to reference so their unit tests keep passing.
- **Benchmark realism vs runtime**: full EPS runs are tens of GB.
  Benchmark on ICON-D2 with a variable allowlist and capped horizon
  (config supports both) — real data, bounded download.
- **Online-derivation latency risk** (the design's main bet): the
  bench explicitly reports cold-decode vs warm-cache window latency
  so the result is measured, not assumed.
- **Scope honesty**: satellite, MCP, `/summary`, s3-with-auth are out
  (spec 00); GPU visuals verified by ported JS-mirror unit tests, not
  headless GL.
