package engine

import (
	"time"
)

// Exported helpers for the api layer (keeps runView internal).

// baseAliases maps display ids the frontend uses to catalog bases
// (parity with the reference catalog's paired names).
var baseAliases = map[string]string{
	"wind_gust_10m": "vmax_10m",
	"global_rad":    "ghi", // aswdifd_s + aswdir_s, derived on demand
}

// NormBase resolves display-id aliases to catalog bases.
func NormBase(b string) string {
	if a, ok := baseAliases[b]; ok {
		return a
	}
	return b
}

// Aliases returns display-id → base pairs (catalog advertisement).
func Aliases() map[string]string {
	out := make(map[string]string, len(baseAliases))
	for k, v := range baseAliases {
		out[k] = v
	}
	return out
}

// Info returns the run's public view.
func (e *Engine) Info(source, run string) (*RunView, error) {
	rv, err := e.View(source, run)
	if err != nil {
		return nil, err
	}
	return &rv.RunView, nil
}

// Resolvable reports whether base names a servable (raw or derived)
// variable of the run.
func (e *Engine) Resolvable(source, run, base string) bool {
	base = NormBase(base)
	rv, err := e.View(source, run)
	if err != nil {
		return false
	}
	if _, ok := rv.planes[base]; ok {
		return true
	}
	switch {
	case precipRe.MatchString(base):
		_, ok := rv.planes["tot_prec"]
		return ok
	case base == "ghi":
		_, a := rv.planes["aswdifd_s"]
		_, b := rv.planes["aswdir_s"]
		return a && b
	case base == "relhum_2m":
		_, a := rv.planes["t_2m"]
		_, b := rv.planes["td_2m"]
		return a && b
	case base == "wind_dir_10m":
		_, a := rv.planes["u_10m"]
		_, b := rv.planes["v_10m"]
		return a && b
	case windRe.MatchString(base):
		lvl := windRe.FindStringSubmatch(base)[1]
		_, a := rv.planes["u_"+lvl]
		_, b := rv.planes["v_"+lvl]
		return a && b
	}
	return false
}

// StepsFor returns the native time axis for a (possibly derived) base.
func (e *Engine) StepsFor(source, run, base string) ([]time.Time, error) {
	rv, err := e.View(source, run)
	if err != nil {
		return nil, err
	}
	name := e.sampleVarFor(rv, NormBase(base))
	vi, ok := rv.Vars[name]
	if !ok {
		return nil, ErrNotFound
	}
	return vi.Steps, nil
}

// MembersFor returns the member count backing a (possibly derived) base.
func (e *Engine) MembersFor(source, run, base string) int {
	rv, err := e.View(source, run)
	if err != nil {
		return 0
	}
	vi, ok := rv.Vars[e.sampleVarFor(rv, NormBase(base))]
	if !ok {
		return 0
	}
	return vi.Members
}

// NativeDeg exposes grid-spacing estimation to the api layer.
func (e *Engine) NativeDeg(source, run, base string) (float64, error) {
	rv, err := e.View(source, run)
	if err != nil {
		return 0, err
	}
	return e.nativeDeg(rv, NormBase(base), time.Time{})
}

// DerivedVars lists derived ids servable for a run (catalog).
func (e *Engine) DerivedVars(source, run string) []string {
	var out []string
	for _, cand := range []string{
		"precip_1h", "precip_3h", "precip_6h", "precip_12h", "precip_24h",
		"wind_speed_10m", "wind_dir_10m", "ghi", "relhum_2m",
	} {
		if e.Resolvable(source, run, cand) {
			out = append(out, cand)
		}
	}
	return out
}
