package api

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// timeSpec is the parsed {time} path segment (spec 03).
type timeSpec struct {
	Latest bool
	Now    bool
	Lead   time.Duration // +{N}h form
	IsLead bool
	At     time.Time
	Span   time.Duration // 0 = instant
}

var leadRe = regexp.MustCompile(`^\+(\d+)h$`)

func parseTimeSpec(s string) (timeSpec, error) {
	s = strings.ReplaceAll(s, "%3A", ":")
	switch {
	case s == "" || s == "latest":
		return timeSpec{Latest: true}, nil
	case leadRe.MatchString(s):
		n, _ := strconv.Atoi(leadRe.FindStringSubmatch(s)[1])
		return timeSpec{IsLead: true, Lead: time.Duration(n) * time.Hour}, nil
	}
	// span: split on the LAST '+' whose tail starts with 'P'
	base, span := s, time.Duration(0)
	if i := strings.LastIndexByte(s, '+'); i >= 0 && i+1 < len(s) && s[i+1] == 'P' {
		d, err := parseISODuration(s[i+1:])
		if err != nil {
			return timeSpec{}, err
		}
		base, span = s[:i], d
	}
	ts := timeSpec{Span: span}
	if base == "now" {
		ts.Now = true
		return ts, nil
	}
	at, err := time.Parse(time.RFC3339, base)
	if err != nil {
		return timeSpec{}, fmt.Errorf("bad time %q", s)
	}
	ts.At = at.UTC()
	return ts, nil
}

var isoDurRe = regexp.MustCompile(`^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$`)

func parseISODuration(s string) (time.Duration, error) {
	m := isoDurRe.FindStringSubmatch(s)
	if m == nil || (m[1] == "" && m[2] == "" && m[3] == "" && m[4] == "" && m[5] == "") {
		return 0, fmt.Errorf("bad duration %q (months/years unsupported)", s)
	}
	f := func(x string) float64 {
		if x == "" {
			return 0
		}
		v, _ := strconv.ParseFloat(x, 64)
		return v
	}
	h := f(m[1])*7*24 + f(m[2])*24 + f(m[3]) + f(m[4])/60 + f(m[5])/3600
	return time.Duration(h * float64(time.Hour)), nil
}

// frameSet is one output frame: Times folded by the window op (or a
// single native step when no window applies), labelled Label.
type frameSet struct {
	Times []time.Time
	Label time.Time
}

type timeAxisErr struct {
	msg      string
	from, to time.Time
}

func (e *timeAxisErr) Error() string { return e.msg }

// resolveTimes maps a timeSpec onto a run's native step axis.
// winHours > 0 activates block semantics (spec 03).
func resolveTimes(steps []time.Time, run time.Time, synthetic bool, ts timeSpec, winHours int) ([]frameSet, error) {
	if len(steps) == 0 {
		return nil, &timeAxisErr{msg: "no timesteps"}
	}
	first, last := steps[0], steps[len(steps)-1]
	cadence := minGap(steps)

	anchor := func() (time.Time, error) {
		switch {
		case ts.Latest:
			return first, nil
		case ts.IsLead:
			return run.Add(ts.Lead), nil
		case ts.Now:
			if synthetic {
				return time.Time{}, &timeAxisErr{msg: "'now' is meaningless on a synthetic-time run; use +Nh lead addressing", from: first, to: last}
			}
			return time.Now().UTC().Truncate(time.Hour), nil
		default:
			return ts.At, nil
		}
	}
	at, err := anchor()
	if err != nil {
		return nil, err
	}

	if winHours <= 0 {
		if ts.Span > 0 { // plain span → every native step (chunk)
			var out []frameSet
			for _, s := range steps {
				if !s.Before(at) && s.Before(at.Add(ts.Span)) {
					out = append(out, frameSet{Times: []time.Time{s}, Label: s})
				}
			}
			if len(out) == 0 {
				return nil, &timeAxisErr{msg: "span outside run window", from: first, to: last}
			}
			return out, nil
		}
		s, ok := nearest(steps, at, cadence)
		if !ok {
			return nil, &timeAxisErr{msg: "instant outside run window", from: first, to: last}
		}
		return []frameSet{{Times: []time.Time{s}, Label: s}}, nil
	}

	win := time.Duration(winHours) * time.Hour
	if ts.Span == 0 { // trailing inclusive block [t−N, t]
		var times []time.Time
		for _, s := range steps {
			if !s.Before(at.Add(-win)) && !s.After(at) {
				times = append(times, s)
			}
		}
		if len(times) == 0 {
			return nil, &timeAxisErr{msg: "window outside run", from: first, to: last}
		}
		return []frameSet{{Times: times, Label: at}}, nil
	}
	// span → ⌊M/N⌋ half-open forward blocks
	nBlocks := int(ts.Span / win)
	if nBlocks < 1 {
		nBlocks = 1
	}
	var out []frameSet
	for k := 0; k < nBlocks; k++ {
		lo := at.Add(time.Duration(k) * win)
		hi := lo.Add(win)
		var times []time.Time
		for _, s := range steps {
			if !s.Before(lo) && s.Before(hi) {
				times = append(times, s)
			}
		}
		if len(times) > 0 {
			out = append(out, frameSet{Times: times, Label: lo})
		}
	}
	if len(out) == 0 {
		return nil, &timeAxisErr{msg: "span outside run window", from: first, to: last}
	}
	return out, nil
}

func minGap(steps []time.Time) time.Duration {
	g := time.Hour
	for i := 1; i < len(steps); i++ {
		if d := steps[i].Sub(steps[i-1]); i == 1 || d < g {
			g = d
		}
	}
	if g <= 0 {
		g = time.Hour
	}
	return g
}

func nearest(steps []time.Time, at time.Time, cadence time.Duration) (time.Time, bool) {
	i := sort.Search(len(steps), func(i int) bool { return !steps[i].Before(at) })
	best := -1
	if i < len(steps) {
		best = i
	}
	if i > 0 && (best < 0 || at.Sub(steps[i-1]) < steps[best].Sub(at)) {
		best = i - 1
	}
	if best < 0 {
		return time.Time{}, false
	}
	d := steps[best].Sub(at)
	if d < 0 {
		d = -d
	}
	if d > cadence {
		return time.Time{}, false
	}
	return steps[best], true
}
