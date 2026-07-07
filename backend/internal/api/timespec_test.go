package api

import (
	"testing"
	"time"
)

func hourly(run time.Time, n int) []time.Time {
	out := make([]time.Time, n)
	for i := range out {
		out[i] = run.Add(time.Duration(i) * time.Hour)
	}
	return out
}

func TestParseTimeSpec(t *testing.T) {
	if ts, _ := parseTimeSpec("latest"); !ts.Latest {
		t.Fatal("latest")
	}
	if ts, _ := parseTimeSpec("+12h"); !ts.IsLead || ts.Lead != 12*time.Hour {
		t.Fatal("lead")
	}
	ts, err := parseTimeSpec("2026-07-06T12:00:00Z+PT6H")
	if err != nil || ts.Span != 6*time.Hour || ts.At.Hour() != 12 {
		t.Fatalf("span: %+v %v", ts, err)
	}
	// tz offsets contain '+' — must not split there
	ts, err = parseTimeSpec("2026-07-06T12:00:00+02:00")
	if err != nil || ts.Span != 0 || ts.At.Hour() != 10 {
		t.Fatalf("tz offset: %+v %v", ts, err)
	}
	if _, err := parseTimeSpec("2026-07-06T12:00:00Z+P1M"); err == nil {
		t.Fatal("months must be rejected")
	}
}

func TestResolveTimes(t *testing.T) {
	run := time.Date(2026, 7, 6, 0, 0, 0, 0, time.UTC)
	steps := hourly(run, 48)

	// plain instant → nearest step
	fs, err := resolveTimes(steps, run, false, timeSpec{At: run.Add(90 * time.Minute)}, 0)
	if err != nil || len(fs) != 1 || !fs[0].Times[0].Equal(run.Add(2*time.Hour)) {
		t.Fatalf("nearest: %+v %v", fs, err)
	}
	// latest → first step
	fs, _ = resolveTimes(steps, run, false, timeSpec{Latest: true}, 0)
	if !fs[0].Times[0].Equal(run) {
		t.Fatal("latest = analysis frame")
	}
	// lead
	fs, _ = resolveTimes(steps, run, true, timeSpec{IsLead: true, Lead: 12 * time.Hour}, 0)
	if !fs[0].Times[0].Equal(run.Add(12 * time.Hour)) {
		t.Fatal("lead addressing")
	}
	// now on synthetic run → error
	if _, err := resolveTimes(steps, run, true, timeSpec{Now: true}, 0); err == nil {
		t.Fatal("now must fail on synthetic")
	}
	// plain span → chunk frames
	fs, _ = resolveTimes(steps, run, false, timeSpec{At: run, Span: 6 * time.Hour}, 0)
	if len(fs) != 6 {
		t.Fatalf("chunk frames: %d", len(fs))
	}
	// window instant → trailing inclusive block
	fs, _ = resolveTimes(steps, run, false, timeSpec{At: run.Add(24 * time.Hour)}, 6)
	if len(fs) != 1 || len(fs[0].Times) != 7 {
		t.Fatalf("trailing block: %d", len(fs[0].Times))
	}
	// window span → half-open forward blocks
	fs, _ = resolveTimes(steps, run, false, timeSpec{At: run, Span: 24 * time.Hour}, 6)
	if len(fs) != 4 || len(fs[0].Times) != 6 {
		t.Fatalf("blocks: %d x %d", len(fs), len(fs[0].Times))
	}
	// far outside → error naming window
	_, err = resolveTimes(steps, run, false, timeSpec{At: run.Add(100 * time.Hour)}, 0)
	if err == nil {
		t.Fatal("outside must 404")
	}
}
