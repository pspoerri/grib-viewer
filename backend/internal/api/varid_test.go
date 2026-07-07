package api

import (
	"math"
	"testing"
)

func testResolver(bases ...string) func(string) bool {
	set := map[string]bool{}
	for _, b := range bases {
		set[b] = true
	}
	return func(b string) bool { return set[b] }
}

func TestParseVarID(t *testing.T) {
	res := testResolver("t_2m", "u_10m", "tot_prec", "t_850hpa", "wind_speed_10m", "vmax_10m")

	cases := []struct {
		id      string
		base    string
		product string
		exceed  float64 // NaN = none
		below   bool
		winH    int
		winOp   string
		unit    string
		wantErr bool
	}{
		{id: "t_2m", base: "t_2m", exceed: math.NaN()},
		{id: "u_10m", base: "u_10m", exceed: math.NaN()}, // not member 10 of u_10
		{id: "t_2m_p90", base: "t_2m", product: "p90", exceed: math.NaN()},
		{id: "t_2m_mean", base: "t_2m", product: "mean", exceed: math.NaN()},
		{id: "t_2m_ctrl", base: "t_2m", product: "ctrl", exceed: math.NaN()},
		{id: "t_2m_spread", base: "t_2m", product: "spread", exceed: math.NaN()},
		{id: "t_2m_m17", base: "t_2m", product: "m17", exceed: math.NaN()},
		{id: "tot_prec_gt2p5mm", base: "tot_prec", exceed: 2.5},
		{id: "t_2m_lt0c", base: "t_2m", exceed: 273.15, below: true},
		{id: "vmax_10m_gtbft8", base: "vmax_10m", exceed: 17.0},
		{id: "t_2m__24h_max", base: "t_2m", winH: 24, winOp: "max", exceed: math.NaN()},
		{id: "tot_prec_gt1mm__24h", base: "tot_prec", exceed: 1.0, winH: 24, winOp: "max"},
		{id: "t_2m_p90__6h_max[f]", base: "t_2m", product: "p90", winH: 6, winOp: "max", unit: "f", exceed: math.NaN()},
		{id: "t_850hpa_p10", base: "t_850hpa", product: "p10", exceed: math.NaN()},
		{id: "wind_speed_10m_p90", base: "wind_speed_10m", product: "p90", exceed: math.NaN()},
		{id: "t_2m_p200", wantErr: true},
		{id: "nope", wantErr: true},
		{id: "t_2m__24h", wantErr: true}, // plain window needs an op
	}
	for _, c := range cases {
		vr, err := parseVarID(c.id, res)
		if c.wantErr {
			if err == nil {
				t.Errorf("%s: want error", c.id)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.id, err)
			continue
		}
		if vr.Plane.Base != c.base || vr.Plane.Product != c.product ||
			vr.WinHours != c.winH || vr.WinOp != c.winOp || vr.UnitCode != c.unit {
			t.Errorf("%s: got %+v win=%d/%s unit=%q", c.id, vr.Plane, vr.WinHours, vr.WinOp, vr.UnitCode)
		}
		if !math.IsNaN(c.exceed) {
			if vr.Plane.Exceed == nil {
				t.Errorf("%s: want exceed", c.id)
			} else if math.Abs(vr.Plane.Exceed.Thr-c.exceed) > 1e-9 || vr.Plane.Exceed.Below != c.below {
				t.Errorf("%s: exceed %+v", c.id, vr.Plane.Exceed)
			}
		} else if vr.Plane.Exceed != nil {
			t.Errorf("%s: unexpected exceed", c.id)
		}
	}
}
