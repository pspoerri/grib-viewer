// Package ensemble reduces per-member NWP planes to probabilistic
// products at serve time: per-cell percentiles, mean, spread, and
// threshold-exceedance probabilities (spec 02 "Ensemble reduction").
//
// Member ordering is irrelevant for every product (sorting is
// internal). What MUST line up is cross-variable member pairing:
// derived per-member fields (wind speed from u and v) need u and v of
// the same perturbation number combined before reduction — see
// PairedMagnitude.
package ensemble

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// ReducePlanes computes one reduced plane from equal-length member
// planes. kind is one of "mean", "min", "max", "spread", or "pNN"
// (any integer percentile 0..100; p0 = min, p100 = max).
//
// Per cell: NaN members are dropped; a cell needs at least (n+1)/2
// valid members (n = number of member planes) to produce a value,
// otherwise it stays NaN — a cell outside one member's domain is
// noise, a cell outside most members' domains is nodata.
//
// Percentiles use the linear-interpolation estimator (numpy default):
// rank = p/100·(nValid−1) on the sorted valid values. spread is
// p90 − p10.
func ReducePlanes(members [][]float32, kind string) ([]float32, error) {
	cells, err := checkPlanes(members)
	if err != nil {
		return nil, err
	}
	switch kind {
	case "mean":
		return reduceMean(members, cells), nil
	case "min":
		return reducePercentiles(members, cells, 0, -1), nil
	case "max":
		return reducePercentiles(members, cells, 100, -1), nil
	case "spread":
		return reducePercentiles(members, cells, 90, 10), nil
	}
	if strings.HasPrefix(kind, "p") {
		p, perr := strconv.Atoi(kind[1:])
		if perr == nil && p >= 0 && p <= 100 {
			return reducePercentiles(members, cells, p, -1), nil
		}
	}
	return nil, fmt.Errorf("ensemble: unknown reduce kind %q", kind)
}

// Exceed computes the per-cell fraction (0..1) of members with
// v > thr (below=false) or v < thr (below=true). NaN members are
// dropped per cell with the same at-least-half validity rule as
// ReducePlanes; a nil result cell is NaN.
func Exceed(members [][]float32, thr float64, below bool) []float32 {
	n := len(members)
	if n == 0 {
		return nil
	}
	cells := len(members[0])
	out := nanPlane(cells)
	minValid := (n + 1) / 2
	for c := 0; c < cells; c++ {
		valid, cross := 0, 0
		for _, m := range members {
			v := float64(m[c])
			if math.IsNaN(v) {
				continue
			}
			valid++
			if (below && v < thr) || (!below && v > thr) {
				cross++
			}
		}
		if valid < minValid {
			continue
		}
		out[c] = float32(cross) / float32(valid)
	}
	return out
}

// PairedMagnitude combines two component sets per member:
// out[m][i] = hypot(u[m][i], v[m][i]). Inputs must be index-aligned
// by member (u[m] and v[m] belong to the same perturbation number).
// NaN in either component propagates.
func PairedMagnitude(u, v [][]float32) ([][]float32, error) {
	if len(u) != len(v) {
		return nil, fmt.Errorf("ensemble: %d u members vs %d v members", len(u), len(v))
	}
	out := make([][]float32, len(u))
	for m := range u {
		if len(u[m]) != len(v[m]) {
			return nil, fmt.Errorf("ensemble: member %d has %d u cells vs %d v cells", m, len(u[m]), len(v[m]))
		}
		plane := make([]float32, len(u[m]))
		for i := range plane {
			plane[i] = float32(math.Hypot(float64(u[m][i]), float64(v[m][i])))
		}
		out[m] = plane
	}
	return out, nil
}

// checkPlanes validates the member set and returns the shared cell
// count.
func checkPlanes(members [][]float32) (int, error) {
	if len(members) == 0 {
		return 0, errors.New("ensemble: no member planes")
	}
	cells := len(members[0])
	for i, m := range members {
		if len(m) != cells {
			return 0, fmt.Errorf("ensemble: member %d has %d cells, want %d", i, len(m), cells)
		}
	}
	return cells, nil
}

// reduceMean is the per-cell arithmetic mean of valid members.
func reduceMean(members [][]float32, cells int) []float32 {
	out := nanPlane(cells)
	minValid := (len(members) + 1) / 2
	for c := 0; c < cells; c++ {
		sum, n := 0.0, 0
		for _, m := range members {
			v := float64(m[c])
			if math.IsNaN(v) {
				continue
			}
			sum += v
			n++
		}
		if n < minValid {
			continue
		}
		out[c] = float32(sum / float64(n))
	}
	return out
}

// reducePercentiles computes percentile p per cell; when q >= 0 the
// result is the difference p − q instead (the spread kernel), sharing
// one sort per cell.
func reducePercentiles(members [][]float32, cells int, p, q int) []float32 {
	out := nanPlane(cells)
	minValid := (len(members) + 1) / 2
	scratch := make([]float64, len(members))
	for c := 0; c < cells; c++ {
		n := 0
		for _, m := range members {
			v := float64(m[c])
			if math.IsNaN(v) {
				continue
			}
			scratch[n] = v
			n++
		}
		if n < minValid {
			continue
		}
		vals := scratch[:n]
		sort.Float64s(vals)
		if q >= 0 {
			out[c] = float32(interpPercentile(vals, p) - interpPercentile(vals, q))
		} else {
			out[c] = float32(interpPercentile(vals, p))
		}
	}
	return out
}

// interpPercentile evaluates percentile p over sorted vals using the
// linear-interpolation estimator. vals must be non-empty and sorted
// ascending.
func interpPercentile(vals []float64, p int) float64 {
	if len(vals) == 1 {
		return vals[0]
	}
	rank := float64(p) / 100 * float64(len(vals)-1)
	lo := int(math.Floor(rank))
	hi := int(math.Ceil(rank))
	if lo < 0 {
		lo = 0
	}
	if hi >= len(vals) {
		hi = len(vals) - 1
	}
	if lo == hi {
		return vals[lo]
	}
	frac := rank - float64(lo)
	return vals[lo] + (vals[hi]-vals[lo])*frac
}

// nanPlane allocates a length-n plane pre-filled with NaN.
func nanPlane(n int) []float32 {
	out := make([]float32, n)
	nan := float32(math.NaN())
	for i := range out {
		out[i] = nan
	}
	return out
}
