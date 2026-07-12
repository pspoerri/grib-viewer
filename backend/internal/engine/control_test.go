package engine

import (
	"testing"
	"time"

	"github.com/pspoerri/grib-viewer/internal/gribidx"
)

func controlTestView(vars map[string][][]int) *runView {
	run := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	ri := &gribidx.RunIndex{Run: run}
	for name, steps := range vars {
		for step, members := range steps {
			for _, member := range members {
				ri.Files = append(ri.Files, gribidx.FileEntry{
					Path: name,
					Msgs: []gribidx.Msg{{
						Var: name, Member: member,
						Ref: run, Valid: run.Add(time.Duration(step) * time.Hour),
					}},
				})
			}
		}
	}
	return buildView("test", "latest", ri)
}

func TestProductsForRequiresMemberZeroAtEveryStepForControl(t *testing.T) {
	tests := []struct {
		name string
		vars map[string][][]int
		base string
		want bool
	}{
		{"DWD perturbed members only", map[string][][]int{"vmax_10m": {{1, 2}, {1, 2}}}, "vmax_10m", false},
		{"MeteoSwiss merged control and perturbed", map[string][][]int{"vmax_10m": {{0, 1}, {0, 1}}}, "vmax_10m", true},
		{"control missing at later step", map[string][][]int{"vmax_10m": {{0, 1}, {1}}}, "vmax_10m", false},
		{"derived wind has both controls", map[string][][]int{"u_10m": {{0, 1}}, "v_10m": {{0, 1}}}, "wind_speed_10m", true},
		{"derived wind component lacks control", map[string][][]int{"u_10m": {{0, 1}}, "v_10m": {{1}}}, "wind_speed_10m", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := productsFor(controlTestView(tt.vars), tt.base).Control; got != tt.want {
				t.Fatalf("productsFor(%q).Control = %v, want %v", tt.base, got, tt.want)
			}
		})
	}
}

func TestProductsForMatchesDerivedProductSupport(t *testing.T) {
	rv := controlTestView(map[string][][]int{
		"u_10m": {{0, 1}}, "v_10m": {{0, 1}},
		"t_2m": {{0, 1}}, "td_2m": {{0, 1}},
	})

	wind := productsFor(rv, "wind_speed_10m")
	if !wind.Max || !wind.Spread || !wind.Chance || !wind.Control {
		t.Fatalf("wind products = %+v, want max/spread/chance/control", wind)
	}
	direction := productsFor(rv, "wind_dir_10m")
	if !direction.Median || direction.Max || direction.Spread || direction.Chance || direction.Control {
		t.Fatalf("wind direction products = %+v, want median only", direction)
	}
	rh := productsFor(rv, "relhum_2m")
	if !rh.Max || !rh.Control || rh.Spread || rh.Chance {
		t.Fatalf("relative humidity products = %+v, want extrema/control but no spread/chance", rh)
	}
}

func TestFoldServesDerivedControlMember(t *testing.T) {
	rv := &runView{RunView: RunView{Vars: map[string]*VarInfo{
		"u_10m": {HasControl: true}, "v_10m": {HasControl: true},
	}}}
	got, err := (&Engine{}).fold(rv, PlaneSpec{Product: "ctrl"}, [][]float32{{7}, {9}}, []string{"u_10m", "v_10m"})
	if err != nil {
		t.Fatal(err)
	}
	if got[0] != 7 {
		t.Fatalf("derived control = %v, want member 0 plane", got)
	}
	rv.Vars["v_10m"].HasControl = false
	if _, err := (&Engine{}).fold(rv, PlaneSpec{Product: "ctrl"}, [][]float32{{7}, {9}}, []string{"u_10m", "v_10m"}); err == nil {
		t.Fatal("missing component control: want error")
	}
}
