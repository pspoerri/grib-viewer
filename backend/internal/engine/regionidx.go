package engine

import (
	"container/list"
	"encoding/binary"
	"fmt"
	"hash/fnv"
	"math"
	"sort"
	"sync"

	grib "github.com/pspoerri/go-tiled-eccodes"
	gribgrid "github.com/pspoerri/go-tiled-eccodes/grid"
)

// Region-level index-map amortization for unstructured (icosahedral)
// grids. The library caches per-pixel cell indices for XYZ tiles but
// not for bbox regions; without this every member × step render pays
// a full per-pixel nearest-neighbour sweep (~1-2 s on an ICON-D2
// window). Locating once per (mesh, region) and gathering per message
// turns a 20-member × 7-step chunk from minutes into milliseconds.

type regionIdxCache struct {
	mu    sync.Mutex
	items map[string]*regionIdxEntry
	order *list.List
	max   int
}

type regionIdxEntry struct {
	key  string
	el   *list.Element
	once sync.Once
	idx  []int32
}

func newRegionIdxCache(max int) *regionIdxCache {
	return &regionIdxCache{items: map[string]*regionIdxEntry{}, order: list.New(), max: max}
}

// meshKey fingerprints a mesh's coordinate catalogue. The grid UUID
// alone is NOT unique: DWD ships uuidOfHGrid as all zeros, so keying on
// it collided every ICON mesh (D2 / EU / global, det / EPS) onto one
// cache entry — index maps and edge masks built for one mesh were
// applied to another (holes at best, out-of-range panics at worst).
// Sampling ~64 coordinates plus the length pins the identity to the
// actual catalogue while staying deterministic across reloads, so
// sources that genuinely share a mesh (icond2 / icond2eps) still share
// cache entries.
func meshKey(u *gribgrid.Unstructured) string {
	lats, lons := u.Coordinates()
	h := fnv.New64a()
	var buf [8]byte
	binary.LittleEndian.PutUint64(buf[:], uint64(len(lats)))
	h.Write(buf[:])
	stride := len(lats)/64 + 1
	for i := 0; i < len(lats) && i < len(lons); i += stride {
		binary.LittleEndian.PutUint64(buf[:], math.Float64bits(lats[i]))
		h.Write(buf[:])
		binary.LittleEndian.PutUint64(buf[:], math.Float64bits(lons[i]))
		h.Write(buf[:])
	}
	return fmt.Sprintf("%x|%d|%x", u.UUID, len(lats), h.Sum64())
}

// regionIndices returns the per-pixel source-cell map for one mesh and
// region (-1 = outside domain/MaxDistance). Concurrent callers for the
// same key share one sweep.
func (e *Engine) regionIndices(u *gribgrid.Unstructured, reg region) []int32 {
	key := fmt.Sprintf("%s|%s", meshKey(u), reg.key())
	c := e.regIdx

	c.mu.Lock()
	ent, ok := c.items[key]
	if ok {
		c.order.MoveToFront(ent.el)
	} else {
		ent = &regionIdxEntry{key: key}
		ent.el = c.order.PushFront(ent)
		c.items[key] = ent
		for len(c.items) > c.max {
			back := c.order.Back()
			old := back.Value.(*regionIdxEntry)
			c.order.Remove(back)
			delete(c.items, old.key)
		}
	}
	c.mu.Unlock()

	ent.once.Do(func() { ent.idx = splatIndices(u, reg, e.edgeMask(u)) })
	return ent.idx
}

// edgeMask marks mesh cells inside the lateral boundary relaxation
// zone of limited-area models (~20 km from the domain hull) — their
// values are physically meaningless (zero gusts, damped fields) and
// must render as NoData so a coarser contributor shows through.
// Global meshes get no mask. Cached per mesh fingerprint (see meshKey).
func (e *Engine) edgeMask(u *gribgrid.Unstructured) []bool {
	key := "mask|" + meshKey(u)
	if v, ok := edgeMaskCache.Load(key); ok {
		m, _ := v.([]bool)
		return m
	}
	lats, lons := u.Coordinates()
	mask := buildEdgeMask(lats, lons, 20_000)
	edgeMaskCache.Store(key, mask)
	return mask
}

var edgeMaskCache sync.Map

const edgeHullSample = 4096

// buildEdgeMask returns nil for global meshes; otherwise a per-cell
// mask of cells within trimMeters of the domain's convex hull.
func buildEdgeMask(lats, lons []float64, trimMeters float64) []bool {
	if len(lats) == 0 {
		return nil
	}
	loLat, hiLat := minMax(lats)
	loLon, hiLon := minMax(lons)
	if hiLon-loLon > 350 || hiLat-loLat > 170 {
		return nil // global mesh: no lateral boundary
	}
	stride := len(lats)/edgeHullSample + 1
	var pts [][2]float64
	for i := 0; i < len(lats); i += stride {
		pts = append(pts, [2]float64{lons[i], lats[i]})
	}
	hull := convexHull(pts)
	if len(hull) < 3 {
		return nil
	}
	// distance in an equirectangular frame scaled by cos(midLat)
	cosMid := math.Cos((loLat + hiLat) / 2 * math.Pi / 180)
	const mPerDeg = 111_195.0
	trimDegSq := (trimMeters / mPerDeg) * (trimMeters / mPerDeg)
	mask := make([]bool, len(lats))
	any := false
	for i := range lats {
		p := [2]float64{lons[i] * cosMid, lats[i]}
		for j := 0; j < len(hull); j++ {
			a, b := hull[j], hull[(j+1)%len(hull)]
			a[0] *= cosMid
			b[0] *= cosMid
			if segDistSq(p, a, b) < trimDegSq {
				mask[i] = true
				any = true
				break
			}
		}
	}
	if !any {
		return nil
	}
	return mask
}

// convexHull computes the 2D hull (Andrew monotone chain).
func convexHull(pts [][2]float64) [][2]float64 {
	if len(pts) < 3 {
		return pts
	}
	sort.Slice(pts, func(i, j int) bool {
		if pts[i][0] != pts[j][0] {
			return pts[i][0] < pts[j][0]
		}
		return pts[i][1] < pts[j][1]
	})
	cross := func(o, a, b [2]float64) float64 {
		return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0])
	}
	var lower, upper [][2]float64
	for _, p := range pts {
		for len(lower) >= 2 && cross(lower[len(lower)-2], lower[len(lower)-1], p) <= 0 {
			lower = lower[:len(lower)-1]
		}
		lower = append(lower, p)
	}
	for i := len(pts) - 1; i >= 0; i-- {
		p := pts[i]
		for len(upper) >= 2 && cross(upper[len(upper)-2], upper[len(upper)-1], p) <= 0 {
			upper = upper[:len(upper)-1]
		}
		upper = append(upper, p)
	}
	return append(lower[:len(lower)-1], upper[:len(upper)-1]...)
}

func segDistSq(p, a, b [2]float64) float64 {
	dx, dy := b[0]-a[0], b[1]-a[1]
	l2 := dx*dx + dy*dy
	t := 0.0
	if l2 > 0 {
		t = ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / l2
		t = math.Max(0, math.Min(1, t))
	}
	qx, qy := a[0]+t*dx, a[1]+t*dy
	return (p[0]-qx)*(p[0]-qx) + (p[1]-qy)*(p[1]-qy)
}

// splatIndices builds the pixel→cell map by forward projection
// (every mesh cell lands in its covering pixel, nearest-to-center
// wins), then a two-pass chamfer propagation assigns each remaining
// pixel its approximate nearest cell. The chamfer is what makes
// equal-area meshes work on the equirectangular pixel lattice: at
// high latitudes the longitudinal cell spacing (deg) exceeds the
// pixel size, so splat alone leaves holes. Fill is accepted only
// within 3× the mesh spacing (real, cos-lat-scaled distance), so
// pixels outside a regional domain stay -1 and nothing bleeds past
// coverage edges. O(cells + pixels); per-pixel KD lookups on these
// meshes cost ~240 µs/px, minutes per window.
func splatIndices(u *gribgrid.Unstructured, reg region, edge []bool) []int32 {
	lats, lons := u.Coordinates()
	n := reg.Nx * reg.Ny
	idx := make([]int32, n)
	for i := range idx {
		idx[i] = -1
	}
	cw := (reg.E - reg.W) / float64(reg.Nx)
	ch := (reg.N - reg.S) / float64(reg.Ny)
	for i := range lats {
		// The len guard is belt-and-braces: with meshKey-scoped caching
		// mask and mesh always match, but a mismatch must never panic
		// the request.
		if edge != nil && i < len(edge) && edge[i] {
			continue // lateral boundary relaxation zone → NoData
		}
		la, lo := lats[i], lons[i]
		fc := (lo - reg.W) / cw
		fr := (reg.N - la) / ch
		col, row := int(fc), int(fr)
		if col < 0 || row < 0 || col >= reg.Nx || row >= reg.Ny {
			continue
		}
		p := row*reg.Nx + col
		if idx[p] < 0 || cellPixDist2(lats, lons, idx[p], reg, cw, ch, row, col) >
			cellPixDist2(lats, lons, int32(i), reg, cw, ch, row, col) {
			idx[p] = int32(i)
		}
	}

	// two-pass chamfer: propagate nearest-cell candidates with true
	// scaled-degree distances (8SSEDT-style approximate NN). The
	// acceptance radius covers the mesh spacing AND the pixel size —
	// coarsened windows have pixels wider than the native spacing.
	spacingDeg := medianConsecutiveMeters(lats, lons) / 111_195.0
	maxD := 3*spacingDeg + 1.5*math.Max(cw, ch)
	maxD2 := maxD * maxD
	dist := make([]float64, n)
	for p := range dist {
		if idx[p] >= 0 {
			dist[p] = cellPixDist2(lats, lons, idx[p], reg, cw, ch, p/reg.Nx, p%reg.Nx)
		} else {
			dist[p] = math.MaxFloat64
		}
	}
	relax := func(p, q, row, col int) {
		if q < 0 || q >= n || idx[q] < 0 {
			return
		}
		d2 := cellPixDist2(lats, lons, idx[q], reg, cw, ch, row, col)
		if d2 < dist[p] {
			dist[p] = d2
			idx[p] = idx[q]
		}
	}
	for row := 0; row < reg.Ny; row++ { // forward
		for col := 0; col < reg.Nx; col++ {
			p := row*reg.Nx + col
			if col > 0 {
				relax(p, p-1, row, col)
			}
			if row > 0 {
				relax(p, p-reg.Nx, row, col)
				if col > 0 {
					relax(p, p-reg.Nx-1, row, col)
				}
				if col < reg.Nx-1 {
					relax(p, p-reg.Nx+1, row, col)
				}
			}
		}
	}
	for row := reg.Ny - 1; row >= 0; row-- { // backward
		for col := reg.Nx - 1; col >= 0; col-- {
			p := row*reg.Nx + col
			if col < reg.Nx-1 {
				relax(p, p+1, row, col)
			}
			if row < reg.Ny-1 {
				relax(p, p+reg.Nx, row, col)
				if col < reg.Nx-1 {
					relax(p, p+reg.Nx+1, row, col)
				}
				if col > 0 {
					relax(p, p+reg.Nx-1, row, col)
				}
			}
		}
	}
	for p := range idx {
		if dist[p] > maxD2 {
			idx[p] = -1 // beyond model coverage
		}
	}
	return idx
}

// cellPixDist2: squared distance (deg², lon scaled by cos lat) between
// mesh cell c and the center of pixel (row, col).
func cellPixDist2(lats, lons []float64, c int32, reg region, cw, ch float64, row, col int) float64 {
	plat := reg.N - (float64(row)+0.5)*ch
	plon := reg.W + (float64(col)+0.5)*cw
	dlat := lats[c] - plat
	dlon := (lons[c] - plon) * math.Cos(plat*math.Pi/180)
	return dlat*dlat + dlon*dlon
}

// renderUnstructured decodes the message once (the library caches the
// decode on the message) and gathers through the cached index map.
func (e *Engine) renderUnstructured(m *grib.Message, u *gribgrid.Unstructured, reg region, dst []float32) error {
	idx := e.regionIndices(u, reg)
	vals := make([]float32, u.NumPoints())
	if _, err := m.DecodeNaturalFloat32(vals); err != nil {
		return err
	}
	nan := float32(math.NaN())
	for i, ix := range idx {
		if ix < 0 || int(ix) >= len(vals) {
			dst[i] = nan
		} else {
			dst[i] = vals[ix]
		}
	}
	return nil
}
