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

func TestControlForRequiresMemberZeroAtEveryStep(t *testing.T) {
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
			if got := controlFor(controlTestView(tt.vars), tt.base); got != tt.want {
				t.Fatalf("controlFor(%q) = %v, want %v", tt.base, got, tt.want)
			}
		})
	}
}
