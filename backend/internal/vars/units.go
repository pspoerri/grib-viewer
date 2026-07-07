package vars

import (
	"fmt"
	"math"
	"strings"
)

// unitConv describes one target unit within a family: a conversion
// from the family's SI base and a display label.
type unitConv struct {
	code    string // lowercase code used in [unit] display brackets
	label   string // display label (e.g. "°C", "km/h")
	convert func(float64) float64
}

// unitFamily groups conversions sharing a physical dimension.
type unitFamily struct {
	siLabel string
	units   []unitConv
}

func identity(v float64) float64 { return v }

var (
	familyTemperature = &unitFamily{
		siLabel: "K",
		units: []unitConv{
			{"k", "K", identity},
			{"c", "°C", func(v float64) float64 { return v - 273.15 }},
			{"f", "°F", func(v float64) float64 { return (v-273.15)*9.0/5.0 + 32 }},
		},
	}
	familySpeed = &unitFamily{
		siLabel: "m/s",
		units: []unitConv{
			{"ms", "m/s", identity},
			{"kmh", "km/h", func(v float64) float64 { return v * 3.6 }},
			{"mph", "mph", func(v float64) float64 { return v * 2.23694 }},
			{"kn", "kn", func(v float64) float64 { return v * 1.94384 }},
			{"kt", "kn", func(v float64) float64 { return v * 1.94384 }},
			{"bft", "bft", msToBeaufort},
		},
	}
	familyLength = &unitFamily{
		siLabel: "m",
		units: []unitConv{
			{"m", "m", identity},
			{"cm", "cm", func(v float64) float64 { return v * 100 }},
			{"km", "km", func(v float64) float64 { return v / 1000 }},
			{"ft", "ft", func(v float64) float64 { return v * 3.28084 }},
		},
	}
	familyGeopotential = &unitFamily{
		siLabel: "gpm",
		units: []unitConv{
			{"gpm", "gpm", identity},
			{"dam", "dam", func(v float64) float64 { return v / 10 }},
			{"m", "m", identity},
			{"ft", "ft", func(v float64) float64 { return v * 3.28084 }},
		},
	}
	familyPrecip = &unitFamily{
		siLabel: "mm",
		units: []unitConv{
			{"mm", "mm", identity},
			{"in", "in", func(v float64) float64 { return v / 25.4 }},
		},
	}
	familyPressure = &unitFamily{
		siLabel: "Pa",
		units: []unitConv{
			{"pa", "Pa", identity},
			{"hpa", "hPa", func(v float64) float64 { return v / 100 }},
		},
	}
	familyPercent = &unitFamily{
		siLabel: "%",
		units:   []unitConv{{"%", "%", identity}},
	}
	familyRadiation = &unitFamily{
		siLabel: "W/m²",
		units:   []unitConv{{"w", "W/m²", identity}, {"wm2", "W/m²", identity}},
	}
	familyEnergy = &unitFamily{
		siLabel: "J/kg",
		units: []unitConv{
			{"jkg", "J/kg", identity},
			{"kjkg", "kJ/kg", func(v float64) float64 { return v / 1000 }},
		},
	}
	familyTime = &unitFamily{
		siLabel: "s",
		units: []unitConv{
			{"s", "s", identity},
			{"min", "min", func(v float64) float64 { return v / 60 }},
			{"h", "h", func(v float64) float64 { return v / 3600 }},
		},
	}
)

// siUnitToFamily maps SI unit strings from the catalog / archive
// metadata to their conversion family. Multiple SI representations map
// to the same family so callers can use whichever form upstream data
// happens to carry.
var siUnitToFamily = map[string]*unitFamily{
	"K":      familyTemperature,
	"m s-1":  familySpeed,
	"m/s":    familySpeed,
	"m":      familyLength,
	"gpm":    familyGeopotential,
	"kg m-2": familyPrecip,
	"kg/m2":  familyPrecip,
	"mm":     familyPrecip,
	"Pa":     familyPressure,
	"%":      familyPercent,
	"W m-2":  familyRadiation,
	"W/m2":   familyRadiation,
	"J kg-1": familyEnergy,
	"J/kg":   familyEnergy,
	"s":      familyTime,
}

// ResolveUnit maps a field's SI unit string plus a requested unit code
// (from the [unit] display bracket: c, f, k, kmh, ms, mph, kn, bft,
// mm, in, hpa, pa, m, ft, gpm, dam, ...) to a conversion func and a
// display label. Codes are case-insensitive. An empty code means "use
// SI" and returns the identity conversion with the SI display label.
// Unknown or dimensionally incompatible codes return an error.
func ResolveUnit(siUnits, code string) (func(float64) float64, string, error) {
	fam := siUnitToFamily[siUnits]
	if code == "" {
		if fam != nil {
			return identity, fam.siLabel, nil
		}
		return identity, siUnits, nil
	}
	if fam == nil {
		return nil, "", fmt.Errorf("vars: no unit conversions for %q", siUnits)
	}
	lc := strings.ToLower(code)
	for i := range fam.units {
		if fam.units[i].code == lc {
			return fam.units[i].convert, fam.units[i].label, nil
		}
	}
	return nil, "", fmt.Errorf("vars: unit code %q does not apply to %q", code, siUnits)
}

// msToBeaufort converts wind speed in m/s to the Beaufort scale using
// the standard formula B = (v / 0.836)^(2/3), clamped to [0, 12].
func msToBeaufort(v float64) float64 {
	if v <= 0 {
		return 0
	}
	b := math.Pow(v/0.836, 2.0/3.0)
	if b > 12 {
		b = 12
	}
	return b
}
