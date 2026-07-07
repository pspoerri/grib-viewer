# 02 — Derive engine (online field derivation)

Everything the old system pre-computed at ingest happens here at
request time, backed by caches. The design premise: decoding one
(variable, step) GRIB message is milliseconds with go-tiled-eccodes,
member reduction is cheap next to decode, and the expensive one-time
work (KD-tree index maps) amortizes per run — so online derivation is
viable if the caches hold the working set.

## Decode layer (go-tiled-eccodes, used directly)

- `grib.Open(path)` (mmap) / message iteration; decode straight from
  the buffered files at the offsets recorded in `index.json`.
- `DecodeFloat32` yields the field in natural WMO scan order (W→E,
  N→S); bitmap-missing cells are NaN.
- Grid handling:
  - **regular lat/lon (template 3.0)**: use directly as the native
    grid.
  - **rotated lat/lon**: unrotate at the regrid step (treated like an
    unstructured cloud through the same index-map path — simple and
    correct; optimize later if a profile demands).
  - **icosahedral (template 3.101)**: no coordinates in the message;
    pair values with external `clat`/`clon` (DWD: two single-message
    files; MeteoSwiss: `tlat`/`tlon` in horizontal_constants) from the
    buffer's `static/` dir.
- Per-message metadata consumed: parameter triple + centre,
  level type/value, step, `perturbationNumber`, grid template, PV
  coefficients (hybrid levels, only if pressure interpolation is ever
  added — out of scope v1).
- Parameter → variable-name mapping via a small hand-maintained table
  keyed on (centre, discipline, category, number), falling back to the
  GRIB shortName; unknown parameters are still served under a
  generated id `p{d}_{c}_{n}` so arbitrary debug output is viewable.

## Native grid & regrid

Internal canonical form: **regular lat/lon array + GridDef**
`{nx, ny, lat0, lon0, dlat<0, dlon>0}` (row 0 north, col 0 west).

- Regular-grid models pass through untouched.
- Unstructured/rotated grids regrid via nearest-neighbour with a
  KD-tree over unit-sphere embeddings (squared chord distance —
  monotonic in great-circle, no trig in the loop). The
  **target→source index map is built once per (grid signature)** and
  cached on disk next to the run (`index_map.bin`) — this was ~89 % of
  CPU when unamortized. After that every regrid is a flat gather.
- `maxDist` cap masks cells outside model coverage → NaN. Limited-area
  models additionally get a convex-hull edge mask trimming the ~20 km
  boundary relaxation zone.
- Target resolution per model = the old system's table (CH1 0.005°,
  D2-class 0.01°, EU-class 0.03125°, global 0.0625°/0.125°), derived
  from native cell spacing for unknown models (round to a power-of-two
  fraction of a degree covering the native density).
- **Pyramid**: coarser levels are the native array downsampled by 2^k
  with NaN-aware bicubic (Catmull-Rom, weights renormalized over valid
  taps); precip-rate/probability fields use NaN-aware max-pool instead
  so intense cells survive zoom-out. Levels are computed lazily and
  cached like any field.

## Caches

Two in-memory LRUs with byte budgets (config `cache.fields_mb` split
~¾ / ¼), keyed by content identity so run pruning simply stops hits:

1. **Field cache** — decoded+regridded native planes, key
   `(source, run, var, step, member|plane, pyrLevel)`, value
   `[]float32` + GridDef.
2. **Reduction cache** — per-cell sorted member matrix per
   `(source, run, var, step)`, from which *all* ensemble products
   (any percentile, mean, any exceedance threshold) are answered
   without re-decode. Stored as the sorted member array per cell
   (the old `dist` archive, but in RAM).

Singleflight around both (concurrent identical requests share one
decode). A run's first map view warms the caches; the animation
working set (viewport window × frames) is what the budget must hold.

## Ensemble reduction

- Members decoded per (var, step): DWD EPS = one file, all members
  tagged by perturbationNumber; MeteoSwiss = control asset (1) +
  perturbed asset (N).
- Per cell: drop NaN members; require ≥ ⌈(n+1)/2⌉ valid else NaN.
- Percentiles: linear-interpolation estimator (numpy default),
  `rank = p/100·(n−1)` on the sorted values. Any integer p ∈ [0,100];
  p0 = min, p100 = max, bare id = p50.
- Mean = arithmetic mean of valid members. Control = perturbation 0
  (or lowest number present). Spread = p90 − p10.
- Exceedance `P(X > thr)` (or `<`) = crossing members / valid members,
  computed by comparing against the raw member values — computed from
  the reduction cache for arbitrary thresholds.
- **Paired products**: wind speed (and any two-component derived
  field) combines u/v **per member, matched by perturbation number**,
  then reduces. Members missing a component are dropped.

## Temporal source types & de-accumulation

Per-variable classification (catalog, spec 05):

- **instant** — serve as-is.
- **accumulated since run start** (`tot_prec`, precip components,
  snow): step rate over `(prev, cur]` = Δacc/Δh, clamped ≥ 0,
  member-paired. Window totals = endpoint difference. ICON
  accumulation sentinels at hour 0 cleaned.
- **time-averaged since run start** (radiation fluxes): de-average
  `(cur·h − prev·h_prev)/Δh`; step 0 keeps its value.

## Derived variables (pointwise/lookback kernels, computed on request)

Same registry idea as the old `DerivedRegistry` — a derived id
declares its inputs and a kernel; the engine fetches inputs (through
the caches) and applies per cell:

- `precip_{1,3,6,12,24}h` = tot_prec[t] − tot_prec[t−N] (the honest
  display form for accumulants).
- `wind_speed_10m` / `wind_dir_10m` (= `atan2(−u,−v)`, meteorological)
  and isobaric `wind_{lvl}hpa` — ensemble planes only via member
  pairing (see above); component-percentile derivation refused (404).
- `ghi` = aswdifd_s + aswdir_s per member, then de-averaged.
- `relhum_2m` from (t_2m, td_2m), Magnus over water.
- Comfort set: dewpoint depression, wetbulb, heat index, θe (from
  t/td/p) — deterministic diagnostics, no ensemble planes.
- `{base}_spread` = p90 − p10 via the reduction cache.
- Sunshine duration and cloud-from-IR are **dropped** (satellite cut).

Derived ids advertise themselves in the catalog exactly like real
variables; whether a product (percentile/exceedance) is available
follows from whether the inputs carry members.

## Point sampling & series

- Bilinear on the native grid (NaN-aware); a point series over a span
  decodes only the requested cell's surrounding values per step —
  implemented as a tiny-window read through the same cache path (the
  field cache makes repeated meteogram queries cheap).
- Model surface height (`hsurf`, from static assets or the run) is
  joined onto point responses when available so the client can do
  lapse correction and altitude display.

## Window assembly (the serve primitive)

`Window(model, run, var-id, time, bbox, maxCells)`:

1. Parse var-id → (base, plane/product, window-op, unit) (spec 03).
2. Resolve time → native step(s); window ops fold steps with
   max/min/mean/sum; spans without op → frame stack (animation chunk).
3. Pick pyramid level: smallest k such that the bbox at level k fits
   `maxCells` (client passes its budget; default 700k).
4. Cut the native sub-window covering bbox + margin (2 cells, for
   client-side interpolation), gather from caches, quantize to int16
   (per-variable scale/offset, spec 05).

Everything (window, point, grid, contours-if-ever) goes through this
one primitive.

## Concurrency & memory

- `GOMEMLIMIT` auto-set to 80 % of detected RAM when unset.
- Decode worker pool sized by GOMAXPROCS; per-request member decodes
  bounded so one 40-member request can't monopolize the pool.
- The old system's peak-RAM lesson: member working set = cells ×
  members × 4 B. The reduction cache admits large-grid EPS entries
  only within its byte budget; over budget, products fall back to
  streaming reduction (decode members, reduce, discard) — slower but
  bounded.
