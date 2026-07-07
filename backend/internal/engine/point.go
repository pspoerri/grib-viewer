package engine

import (
	"math"
	"time"
)

// PointReq asks for a point value or series (spec 03 /point).
type PointReq struct {
	Source, Run string
	Plane       PlaneSpec
	Times       []time.Time
	Agg         string
	Lat, Lon    float64
}

// PointResult carries per-time values plus the model surface height.
type PointResult struct {
	Times     []time.Time
	Values    []*float64 // nil = nodata
	Height    *float64   // z_model at the point (hsurf), if available
	Synthetic bool
	Run       time.Time
}

// pointCells: mini-window edge length around the point. 8 native cells
// gives the bilinear sample room at any nearby cell alignment.
const pointCells = 8

// Point samples a plane spec at (lat, lon) through the same plane
// pipeline as windows (uniform product semantics), then bilinear.
func (e *Engine) Point(req PointReq) (*PointResult, error) {
	req.Plane.Base = NormBase(req.Plane.Base)
	rv, err := e.View(req.Source, req.Run)
	if err != nil {
		return nil, err
	}
	deg, err := e.nativeDeg(rv, req.Plane.Base, time.Time{})
	if err != nil {
		return nil, err
	}
	half := deg * pointCells / 2
	reg := region{
		S: req.Lat - half, N: req.Lat + half,
		W: req.Lon - half, E: req.Lon + half,
		Nx: pointCells, Ny: pointCells,
	}
	res := &PointResult{Synthetic: rv.Synthetic, Run: rv.Run}

	sample := func(t time.Time) *float64 {
		p, err := e.plane(rv, req.Plane, t, reg)
		if err != nil {
			return nil
		}
		v := bilinear(p, reg, req.Lat, req.Lon)
		if v != v {
			return nil
		}
		return &v
	}

	if req.Agg != "" && len(req.Times) > 1 {
		var vals []float64
		for _, t := range req.Times {
			if v := sample(t); v != nil {
				vals = append(vals, *v)
			}
		}
		res.Times = []time.Time{req.Times[len(req.Times)-1]}
		res.Values = []*float64{foldScalar(vals, req.Agg)}
	} else {
		for _, t := range req.Times {
			res.Times = append(res.Times, t)
			res.Values = append(res.Values, sample(t))
		}
	}

	if hs := e.heightPlane(rv, reg); hs != nil {
		if v := bilinear(hs, reg, req.Lat, req.Lon); v == v {
			res.Height = &v
		}
	}
	return res, nil
}

func foldScalar(vals []float64, op string) *float64 {
	if len(vals) == 0 {
		return nil
	}
	out := vals[0]
	for _, v := range vals[1:] {
		switch op {
		case "max":
			out = math.Max(out, v)
		case "min":
			out = math.Min(out, v)
		case "mean", "sum":
			out += v
		}
	}
	if op == "mean" {
		out /= float64(len(vals))
	}
	return &out
}

// bilinear samples a region plane at (lat, lon), NaN-aware with weight
// renormalization over valid taps.
func bilinear(p []float32, reg region, lat, lon float64) float64 {
	g := reg.gridDef()
	fx := (lon - g.Lon0) / g.DLon
	fy := (lat - g.Lat0) / g.DLat
	x0 := int(math.Floor(fx))
	y0 := int(math.Floor(fy))
	wx := fx - float64(x0)
	wy := fy - float64(y0)

	var sum, wsum float64
	for dy := 0; dy <= 1; dy++ {
		for dx := 0; dx <= 1; dx++ {
			x, y := x0+dx, y0+dy
			if x < 0 || y < 0 || x >= g.Nx || y >= g.Ny {
				continue
			}
			v := float64(p[y*g.Nx+x])
			if v != v {
				continue
			}
			w := (1 - math.Abs(float64(dx)-wx)) * (1 - math.Abs(float64(dy)-wy))
			sum += v * w
			wsum += w
		}
	}
	if wsum <= 0 {
		return math.NaN()
	}
	return sum / wsum
}
