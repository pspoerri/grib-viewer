package vars

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// BeaufortMS maps an integer Beaufort number to its conventional
// warning threshold in m/s. Entries 5/7/8/10/12 match the classic
// gust ladder (bft7 ↔ 14 m/s, bft8 ↔ 17 m/s, …); the rest follow the
// standard scale's lower bounds.
var BeaufortMS = [...]float64{
	0, 0.3, 1.6, 3.4, 5.5, 8, 10.8, 14, 17, 20.8, 25, 28.5, 33,
}

// thresholdUnitTokens maps each exceedance-threshold unit token to its
// conversion into SI units plus the SI unit strings it is valid
// against. Beaufort is special-cased (integer table lookup) in
// ParseThresholdTail.
var thresholdUnitTokens = map[string]struct {
	toSI func(float64) float64
	si   map[string]bool
}{
	"c":   {func(v float64) float64 { return v + 273.15 }, map[string]bool{"K": true}},
	"f":   {func(v float64) float64 { return (v-32)*5/9 + 273.15 }, map[string]bool{"K": true}},
	"k":   {func(v float64) float64 { return v }, map[string]bool{"K": true}},
	"ms":  {func(v float64) float64 { return v }, map[string]bool{"m s-1": true, "m/s": true}},
	"kmh": {func(v float64) float64 { return v / 3.6 }, map[string]bool{"m s-1": true, "m/s": true}},
	"kt":  {func(v float64) float64 { return v / 1.94384 }, map[string]bool{"m s-1": true, "m/s": true}},
	"bft": {nil, map[string]bool{"m s-1": true, "m/s": true}},
	"mm":  {func(v float64) float64 { return v }, map[string]bool{"kg m-2": true, "mm": true, "mm/h": true}},
	"in":  {func(v float64) float64 { return v * 25.4 }, map[string]bool{"kg m-2": true, "mm": true, "mm/h": true}},
	"hpa": {func(v float64) float64 { return v * 100 }, map[string]bool{"Pa": true}},
	"w":   {func(v float64) float64 { return v }, map[string]bool{"W m-2": true, "W/m2": true}},
}

// thresholdUnitPrefixes lists unit tokens using the prefixed grammar
// (unit letters before the number, e.g. "bft8").
var thresholdUnitPrefixes = []string{"bft"}

// ParseThresholdTail parses an exceedance threshold token — the tail
// after `_gt`/`_lt` in ids like tot_prec_gt2p5mm (spec 03) — and
// returns the threshold in the variable's SI units.
//
// Two grammars are supported:
//
//	Standard: [-]digits[p digits] letters   e.g. "2p5mm", "0c", "-5c", "30ms"
//	Prefixed: letters digits                e.g. "bft8" (Beaufort)
//
// The decimal separator is 'p'. The unit token must be dimensionally
// compatible with siUnits (temperature c/f/k against K, speed
// ms/kmh/kt/bft against m s-1, precip mm/in, pressure hpa,
// radiation w).
func ParseThresholdTail(tail string, siUnits string) (float64, error) {
	value, unit, ok := splitThresholdTail(tail)
	if !ok {
		return 0, fmt.Errorf("vars: malformed threshold %q", tail)
	}
	tok, known := thresholdUnitTokens[unit]
	if !known {
		return 0, fmt.Errorf("vars: unknown threshold unit in %q", tail)
	}
	if !tok.si[siUnits] {
		return 0, fmt.Errorf("vars: threshold unit %q does not apply to %q", unit, siUnits)
	}
	// Table-lookup units (Beaufort) carry no toSI func.
	if tok.toSI == nil {
		b := int(value)
		if float64(b) != value || b < 0 || b >= len(BeaufortMS) || math.IsNaN(value) {
			return 0, fmt.Errorf("vars: beaufort threshold must be an integer in [0, 12], got %v", value)
		}
		return BeaufortMS[b], nil
	}
	return tok.toSI(value), nil
}

// FormatThreshold renders a threshold value (in the token's own units)
// and unit token back into tail form: FormatThreshold(2.5, "mm") →
// "2p5mm", FormatThreshold(8, "bft") → "bft8". The inverse of the
// ParseThresholdTail grammar split, used for catalog/product listings.
func FormatThreshold(value float64, unit string) string {
	for _, prefix := range thresholdUnitPrefixes {
		if unit == prefix {
			return unit + strconv.Itoa(int(value))
		}
	}
	num := strconv.FormatFloat(value, 'f', -1, 64)
	num = strings.ReplaceAll(num, ".", "p")
	return num + unit
}

// splitThresholdTail splits a threshold tail into (value, unit, ok).
// In the prefixed form the unit must appear in thresholdUnitPrefixes.
func splitThresholdTail(tail string) (float64, string, bool) {
	if len(tail) == 0 {
		return 0, "", false
	}
	// Prefixed form: known unit prefix followed by digits.
	if tail[0] >= 'a' && tail[0] <= 'z' {
		for _, prefix := range thresholdUnitPrefixes {
			if len(tail) > len(prefix) && tail[:len(prefix)] == prefix {
				numStr := tail[len(prefix):]
				allDigits := true
				for _, c := range numStr {
					if c < '0' || c > '9' {
						allDigits = false
						break
					}
				}
				if !allDigits {
					continue
				}
				n := 0.0
				for _, c := range numStr {
					n = n*10 + float64(c-'0')
				}
				return n, prefix, true
			}
		}
		return 0, "", false
	}
	// Standard form: [-]digits[p digits] letters
	i := 0
	neg := false
	if tail[i] == '-' {
		neg = true
		i++
	}
	start := i
	for i < len(tail) && tail[i] >= '0' && tail[i] <= '9' {
		i++
	}
	if i == start {
		return 0, "", false
	}
	intPart := tail[start:i]
	frac := ""
	if i < len(tail) && tail[i] == 'p' {
		i++
		fs := i
		for i < len(tail) && tail[i] >= '0' && tail[i] <= '9' {
			i++
		}
		if i == fs {
			return 0, "", false
		}
		frac = tail[fs:i]
	}
	unit := tail[i:]
	if unit == "" {
		return 0, "", false
	}
	for _, c := range unit {
		if c < 'a' || c > 'z' {
			return 0, "", false
		}
	}
	v := 0.0
	for _, c := range intPart {
		v = v*10 + float64(c-'0')
	}
	scale := 0.1
	for _, c := range frac {
		v += float64(c-'0') * scale
		scale /= 10
	}
	if neg {
		v = -v
	}
	if math.IsInf(v, 0) {
		return 0, "", false
	}
	return v, unit, true
}
