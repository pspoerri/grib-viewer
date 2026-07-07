package ensemble

import (
	"math"
	"testing"
)

var nan = float32(math.NaN())

// planes builds one-value-per-member planes from a flat member list,
// so percentile expectations read naturally.
func planes(vals ...float32) [][]float32 {
	out := make([][]float32, len(vals))
	for i, v := range vals {
		out[i] = []float32{v}
	}
	return out
}

func approx(a, b float32) bool {
	return math.Abs(float64(a)-float64(b)) < 1e-5
}

func TestReducePlanesPercentiles(t *testing.T) {
	members := planes(1, 2, 3, 4, 5)
	tests := []struct {
		kind string
		want float32
	}{
		{"p0", 1},
		{"p10", 1.4}, // rank = 0.1·4 = 0.4 → 1 + 0.4·(2−1)
		{"p25", 2},
		{"p50", 3},
		{"p75", 4},
		{"p90", 4.6},
		{"p100", 5},
		{"min", 1},
		{"max", 5},
		{"mean", 3},
		{"spread", 3.2}, // p90 − p10 = 4.6 − 1.4
		{"p37", 2.48},   // rank = 0.37·4 = 1.48 → 2 + 0.48·(3−2)
	}
	for _, tt := range tests {
		got, err := ReducePlanes(members, tt.kind)
		if err != nil {
			t.Errorf("ReducePlanes(%q) err = %v", tt.kind, err)
			continue
		}
		if !approx(got[0], tt.want) {
			t.Errorf("ReducePlanes(%q) = %v, want %v", tt.kind, got[0], tt.want)
		}
	}
	// Member order must not matter.
	shuffled := planes(4, 1, 5, 3, 2)
	got, _ := ReducePlanes(shuffled, "p50")
	if !approx(got[0], 3) {
		t.Errorf("shuffled p50 = %v, want 3", got[0])
	}
	// Single member: every percentile returns the value.
	got, _ = ReducePlanes(planes(7), "p90")
	if got[0] != 7 {
		t.Errorf("single-member p90 = %v, want 7", got[0])
	}
}

func TestReducePlanesValidityRule(t *testing.T) {
	// n = 4 → minValid = (4+1)/2 = 2.
	// cell 0: 4 valid; cell 1: 2 valid (exactly at threshold);
	// cell 2: 1 valid → NaN.
	members := [][]float32{
		{1, 1, nan},
		{2, nan, nan},
		{3, 3, nan},
		{4, nan, 4},
	}
	got, err := ReducePlanes(members, "mean")
	if err != nil {
		t.Fatal(err)
	}
	if !approx(got[0], 2.5) {
		t.Errorf("cell 0 mean = %v, want 2.5", got[0])
	}
	if !approx(got[1], 2) {
		t.Errorf("cell 1 mean = %v, want 2 (exactly half valid)", got[1])
	}
	if !math.IsNaN(float64(got[2])) {
		t.Errorf("cell 2 mean = %v, want NaN (below half valid)", got[2])
	}
	// Same rule for percentiles.
	got, _ = ReducePlanes(members, "p50")
	if !approx(got[0], 2.5) || !approx(got[1], 2) || !math.IsNaN(float64(got[2])) {
		t.Errorf("p50 = %v, want [2.5 2 NaN]", got)
	}
}

func TestReducePlanesErrors(t *testing.T) {
	if _, err := ReducePlanes(nil, "mean"); err == nil {
		t.Error("empty member set: want error")
	}
	if _, err := ReducePlanes([][]float32{{1, 2}, {1}}, "mean"); err == nil {
		t.Error("ragged member planes: want error")
	}
	for _, kind := range []string{"", "median", "p101", "p-1", "pxx", "P50"} {
		if _, err := ReducePlanes(planes(1, 2), kind); err == nil {
			t.Errorf("kind %q: want error", kind)
		}
	}
}

func TestExceed(t *testing.T) {
	members := planes(1, 2, 3, 4)
	got := Exceed(members, 2.5, false)
	if !approx(got[0], 0.5) {
		t.Errorf("P(v>2.5) = %v, want 0.5", got[0])
	}
	got = Exceed(members, 2.5, true)
	if !approx(got[0], 0.5) {
		t.Errorf("P(v<2.5) = %v, want 0.5", got[0])
	}
	// Strict comparison: members equal to the threshold count neither way.
	got = Exceed(members, 2, false)
	if !approx(got[0], 0.5) {
		t.Errorf("P(v>2) = %v, want 0.5", got[0])
	}
	got = Exceed(members, 2, true)
	if !approx(got[0], 0.25) {
		t.Errorf("P(v<2) = %v, want 0.25", got[0])
	}
	// Extremes.
	if got = Exceed(members, 0, false); got[0] != 1 {
		t.Errorf("P(v>0) = %v, want 1", got[0])
	}
	if got = Exceed(members, 10, false); got[0] != 0 {
		t.Errorf("P(v>10) = %v, want 0", got[0])
	}
}

func TestExceedValidityRule(t *testing.T) {
	members := [][]float32{
		{1, nan},
		{2, nan},
		{3, nan},
		{4, 9},
	}
	got := Exceed(members, 2.5, false)
	if !approx(got[0], 0.5) {
		t.Errorf("cell 0 = %v, want 0.5", got[0])
	}
	if !math.IsNaN(float64(got[1])) {
		t.Errorf("cell 1 = %v, want NaN (1 of 4 valid)", got[1])
	}
	// The fraction denominator is the VALID count, not n.
	members = [][]float32{{4}, {4}, {1}, {nan}}
	got = Exceed(members, 2.5, false)
	if !approx(got[0], 2.0/3.0) {
		t.Errorf("valid-denominator fraction = %v, want 2/3", got[0])
	}
}

func TestPairedMagnitude(t *testing.T) {
	u := [][]float32{{3, 0}, {-6, 1}}
	v := [][]float32{{4, 0}, {8, nan}}
	got, err := PairedMagnitude(u, v)
	if err != nil {
		t.Fatal(err)
	}
	if !approx(got[0][0], 5) || !approx(got[0][1], 0) {
		t.Errorf("member 0 = %v, want [5 0]", got[0])
	}
	if !approx(got[1][0], 10) {
		t.Errorf("member 1 cell 0 = %v, want 10", got[1][0])
	}
	if !math.IsNaN(float64(got[1][1])) {
		t.Errorf("member 1 cell 1 = %v, want NaN (component NaN propagates)", got[1][1])
	}

	if _, err := PairedMagnitude(u, v[:1]); err == nil {
		t.Error("member count mismatch: want error")
	}
	if _, err := PairedMagnitude([][]float32{{1, 2}}, [][]float32{{1}}); err == nil {
		t.Error("cell count mismatch: want error")
	}
}

func TestPairedMagnitudeIntoReduce(t *testing.T) {
	// End-to-end: percentile of speed, not speed of percentiles.
	u := [][]float32{{3}, {0}, {5}}
	v := [][]float32{{4}, {2}, {12}}
	speeds, err := PairedMagnitude(u, v)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ReducePlanes(speeds, "p50")
	if err != nil {
		t.Fatal(err)
	}
	if !approx(got[0], 5) { // speeds are {5, 2, 13} → median 5
		t.Errorf("p50 speed = %v, want 5", got[0])
	}
}
