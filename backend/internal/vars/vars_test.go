package vars

import (
	"math"
	"strings"
	"testing"
)

func TestLookupCatalog(t *testing.T) {
	tests := []struct {
		name   string
		ok     bool
		units  string
		scale  float64
		offset float64
	}{
		{"t_2m", true, "K", 0.01, 270},
		{"td_2m", true, "K", 0.01, 260},
		{"tmax_2m", true, "K", 0.01, 270},
		{"tot_prec", true, "kg m-2", 0.01, 0},
		{"pmsl", true, "Pa", 1.0, 100000},
		{"hsurf", true, "m", 0.5, 0},
		{"vis", true, "m", 5.0, 0},
		{"precip_6h", true, "mm", 0.01, 0},
		{"wind_speed_10m", true, "m s-1", 0.01, 0},
		{"cape_ml", true, "J kg-1", 0.5, 0},
		{"dbz_cmax", true, "dBZ", 0.1, 0},
		// Bare header-named bases.
		{"t", true, "K", 0.01, 250},
		{"td", true, "K", 0.01, 260},
		{"u", true, "m s-1", 0.01, 0},
		{"vmax", true, "m s-1", 0.01, 0},
		// Curated isobaric entries.
		{"t_850hpa", true, "K", 0.01, 270},
		{"t_500hpa", true, "K", 0.01, 250},
		{"fi_500hpa", true, "gpm", 0.5, 0},
		{"u_300hpa", true, "m s-1", 0.01, 0},
		{"wind_850hpa", true, "m s-1", 0.01, 0},
		// Unknown ids.
		{"nonexistent", false, "", 0, 0},
		{"t_2m_p90", false, "", 0, 0}, // plane suffixes are the caller's job
	}
	for _, tt := range tests {
		f, ok := Lookup(tt.name)
		if ok != tt.ok {
			t.Errorf("Lookup(%q) ok = %v, want %v", tt.name, ok, tt.ok)
			continue
		}
		if !ok {
			continue
		}
		if f.Units != tt.units || f.Scale != tt.scale || f.Offset != tt.offset {
			t.Errorf("Lookup(%q) = units %q scale %v offset %v, want %q %v %v",
				tt.name, f.Units, f.Scale, f.Offset, tt.units, tt.scale, tt.offset)
		}
	}
}

func TestLookupLevelForms(t *testing.T) {
	// Soil-level suffix resolves through the t_so entry.
	f, ok := Lookup("t_so_l3")
	if !ok {
		t.Fatal("Lookup(t_so_l3) not found")
	}
	if f.Name != "t_so_l3" || f.Units != "K" || f.Offset != 270 {
		t.Errorf("t_so_l3 = %+v, want K field with offset 270", f)
	}
	if !strings.Contains(f.LongName, "soil temperature") {
		t.Errorf("t_so_l3 long name %q missing base name", f.LongName)
	}

	// Curated isobaric levels resolve exactly (level offsets differ).
	f, ok = Lookup("t_850hpa")
	if !ok || f.Offset != 270 || f.VMin != 230 || f.VMax != 310 {
		t.Errorf("t_850hpa = %+v ok=%v, want offset 270 vmin 230 vmax 310", f, ok)
	}

	// Uncurated isobaric levels fall back to the bare family entry.
	f, ok = Lookup("t_700hpa")
	if !ok {
		t.Fatal("Lookup(t_700hpa) not found")
	}
	if f.Units != "K" || f.Offset != 250 {
		t.Errorf("t_700hpa fell back to %+v, want the bare t entry (offset 250)", f)
	}
	if !strings.HasPrefix(f.LongName, "700 hPa") {
		t.Errorf("t_700hpa long name %q missing level", f.LongName)
	}
	if _, ok := Lookup("fi_700hpa"); !ok {
		t.Error("fi_700hpa should fall back to the fi family")
	}
	if _, ok := Lookup("clct_700hpa"); ok {
		t.Error("clct_700hpa should not resolve (not an isobaric family)")
	}

	// Unknown level base stays unknown.
	if _, ok := Lookup("xx_l3"); ok {
		t.Error("xx_l3 should not resolve")
	}
}

func TestGeneric(t *testing.T) {
	f := Generic("p0_1_2")
	if f.Name != "p0_1_2" || f.Colormap != "viridis" || f.Scale != 0 || f.Offset != 0 {
		t.Errorf("Generic = %+v, want viridis with scale 0 (auto)", f)
	}
}

func TestCatalogColormapsAndReducers(t *testing.T) {
	tests := []struct {
		name    string
		cmap    string
		temp    Temporal
		reducer ReducerKind
	}{
		{"t_2m", "stepped_temp_2m", TemporalInstant, ReduceMinMax},
		{"tot_prec", "precip", TemporalAccum, ReduceSum},
		{"snow_gsp", "snow", TemporalAccum, ReduceSum},
		{"clct", "clouds", TemporalInstant, ReduceMean},
		{"aswdir_s", "solar", TemporalTavg, ReduceMean},
		{"relhum_2m", "relhum", TemporalInstant, ReduceMean},
		{"vmax_10m", "wind_speed_v100", TemporalInstant, ReduceMax},
		{"vis", "viridis", TemporalInstant, ReduceMin},
		{"hsurf", "viridis", TemporalStatic, ReduceMean},
	}
	for _, tt := range tests {
		f, ok := Lookup(tt.name)
		if !ok {
			t.Errorf("Lookup(%q) not found", tt.name)
			continue
		}
		if f.Colormap != tt.cmap || f.Temporal != tt.temp || f.Reducer != tt.reducer {
			t.Errorf("%s = cmap %q temporal %v reducer %v, want %q %v %v",
				tt.name, f.Colormap, f.Temporal, f.Reducer, tt.cmap, tt.temp, tt.reducer)
		}
	}
}

func TestResolveUnit(t *testing.T) {
	tests := []struct {
		si, code string
		in, out  float64
		label    string
	}{
		{"K", "c", 273.15, 0, "°C"},
		{"K", "c", 300, 26.85, "°C"},
		{"K", "f", 273.15, 32, "°F"},
		{"K", "k", 250, 250, "K"},
		{"m s-1", "kmh", 10, 36, "km/h"},
		{"m s-1", "kn", 10, 19.4384, "kn"},
		{"m s-1", "mph", 10, 22.3694, "mph"},
		{"m s-1", "bft", 17, math.Pow(17/0.836, 2.0/3.0), "bft"},
		{"m/s", "ms", 5, 5, "m/s"},
		{"kg m-2", "in", 25.4, 1, "in"},
		{"mm", "mm", 2.5, 2.5, "mm"},
		{"Pa", "hpa", 101300, 1013, "hPa"},
		{"m", "ft", 1, 3.28084, "ft"},
		{"gpm", "dam", 5500, 550, "dam"},
		// Case-insensitive codes.
		{"K", "C", 273.15, 0, "°C"},
		{"Pa", "hPa", 100, 1, "hPa"},
	}
	for _, tt := range tests {
		conv, label, err := ResolveUnit(tt.si, tt.code)
		if err != nil {
			t.Errorf("ResolveUnit(%q, %q) err = %v", tt.si, tt.code, err)
			continue
		}
		if label != tt.label {
			t.Errorf("ResolveUnit(%q, %q) label = %q, want %q", tt.si, tt.code, label, tt.label)
		}
		if got := conv(tt.in); math.Abs(got-tt.out) > 1e-9 {
			t.Errorf("ResolveUnit(%q, %q)(%v) = %v, want %v", tt.si, tt.code, tt.in, got, tt.out)
		}
	}
}

func TestResolveUnitEmptyAndErrors(t *testing.T) {
	conv, label, err := ResolveUnit("m s-1", "")
	if err != nil {
		t.Fatalf("empty code: err = %v", err)
	}
	if label != "m/s" || conv(3) != 3 {
		t.Errorf("empty code: conv(3)=%v label=%q, want identity m/s", conv(3), label)
	}
	// Unknown SI unit with empty code still yields identity.
	conv, label, err = ResolveUnit("dBZ", "")
	if err != nil {
		t.Fatalf("dBZ empty code: err = %v", err)
	}
	if label != "dBZ" || conv(35) != 35 {
		t.Errorf("dBZ empty code: got %v %q", conv(35), label)
	}
	for _, tt := range []struct{ si, code string }{
		{"K", "mm"},    // incompatible
		{"K", "zz"},    // unknown code
		{"dBZ", "c"},   // no family
		{"m s-1", "c"}, // wrong family
	} {
		if _, _, err := ResolveUnit(tt.si, tt.code); err == nil {
			t.Errorf("ResolveUnit(%q, %q) expected error", tt.si, tt.code)
		}
	}
}

func TestResolveUnitRoundTrips(t *testing.T) {
	// K→C→K and m/s→kmh→m/s style round trips through inverse math.
	toC, _, _ := ResolveUnit("K", "c")
	toF, _, _ := ResolveUnit("K", "f")
	if got := toC(293.15); math.Abs(got-20) > 1e-9 {
		t.Errorf("K→C: got %v", got)
	}
	if got := (toF(293.15) - 32) * 5 / 9; math.Abs(got-20) > 1e-9 {
		t.Errorf("K→F round trip: got %v", got)
	}
	toKmh, _, _ := ResolveUnit("m s-1", "kmh")
	if got := toKmh(10) / 3.6; math.Abs(got-10) > 1e-9 {
		t.Errorf("m/s→kmh round trip: got %v", got)
	}
	toKn, _, _ := ResolveUnit("m s-1", "kn")
	if got := toKn(10) / 1.94384; math.Abs(got-10) > 1e-9 {
		t.Errorf("m/s→kn round trip: got %v", got)
	}
	// Beaufort thresholds map back onto their own scale value.
	toBft, _, _ := ResolveUnit("m s-1", "bft")
	for b := 1; b <= 12; b++ {
		got := toBft(BeaufortMS[b])
		if got < float64(b)-1.5 || got > float64(b)+1.5 {
			t.Errorf("bft(%v m/s) = %v, want ≈ %d", BeaufortMS[b], got, b)
		}
	}
}

func TestParseThresholdTail(t *testing.T) {
	tests := []struct {
		tail, si string
		want     float64
		wantErr  bool
	}{
		{"2p5mm", "kg m-2", 2.5, false},
		{"2p5mm", "mm", 2.5, false},
		{"-5c", "K", 268.15, false},
		{"bft8", "m s-1", 17.0, false},
		{"30ms", "m s-1", 30, false},
		{"0c", "K", 273.15, false},
		{"32f", "K", 273.15, false},
		{"250k", "K", 250, false},
		{"36kmh", "m s-1", 10, false},
		{"1in", "mm", 25.4, false},
		{"10hpa", "Pa", 1000, false},
		{"400w", "W m-2", 400, false},
		{"0p1mm", "kg m-2", 0.1, false},
		// Errors.
		{"", "K", 0, true},
		{"mm", "kg m-2", 0, true},   // no digits
		{"2p5", "kg m-2", 0, true},  // no unit
		{"2p5mm", "K", 0, true},     // incompatible
		{"5xy", "K", 0, true},       // unknown unit
		{"bft13", "m s-1", 0, true}, // beyond the table
		{"bft", "m s-1", 0, true},   // no number
		{"2pmm", "kg m-2", 0, true}, // dangling decimal
		{"--5c", "K", 0, true},      // double sign
	}
	for _, tt := range tests {
		got, err := ParseThresholdTail(tt.tail, tt.si)
		if tt.wantErr {
			if err == nil {
				t.Errorf("ParseThresholdTail(%q, %q) = %v, want error", tt.tail, tt.si, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseThresholdTail(%q, %q) err = %v", tt.tail, tt.si, err)
			continue
		}
		if math.Abs(got-tt.want) > 1e-9 {
			t.Errorf("ParseThresholdTail(%q, %q) = %v, want %v", tt.tail, tt.si, got, tt.want)
		}
	}
}

func TestSupportsThreshold(t *testing.T) {
	for _, units := range []string{"K", "m s-1", "mm", "kg m-2", "Pa", "W m-2"} {
		if !SupportsThreshold(units) {
			t.Errorf("SupportsThreshold(%q) = false", units)
		}
	}
	for _, units := range []string{"%", "J kg-1", "degree"} {
		if SupportsThreshold(units) {
			t.Errorf("SupportsThreshold(%q) = true", units)
		}
	}
}

func TestBeaufortTable(t *testing.T) {
	if len(BeaufortMS) != 13 {
		t.Fatalf("BeaufortMS has %d entries, want 13", len(BeaufortMS))
	}
	want := [...]float64{0, 0.3, 1.6, 3.4, 5.5, 8, 10.8, 14, 17, 20.8, 25, 28.5, 33}
	for i, v := range want {
		if BeaufortMS[i] != v {
			t.Errorf("BeaufortMS[%d] = %v, want %v", i, BeaufortMS[i], v)
		}
	}
}

func TestFormatThreshold(t *testing.T) {
	tests := []struct {
		value float64
		unit  string
		want  string
	}{
		{2.5, "mm", "2p5mm"},
		{8, "bft", "bft8"},
		{-5, "c", "-5c"},
		{30, "ms", "30ms"},
		{0.1, "mm", "0p1mm"},
	}
	for _, tt := range tests {
		if got := FormatThreshold(tt.value, tt.unit); got != tt.want {
			t.Errorf("FormatThreshold(%v, %q) = %q, want %q", tt.value, tt.unit, got, tt.want)
		}
	}
	// Round trip through the parser (in a compatible SI unit).
	sis := map[string]string{"mm": "mm", "c": "K", "ms": "m s-1", "bft": "m s-1"}
	for _, tt := range tests {
		v, err := ParseThresholdTail(FormatThreshold(tt.value, tt.unit), sis[tt.unit])
		if err != nil {
			t.Errorf("round trip %q: %v", tt.want, err)
			continue
		}
		if tt.unit == "bft" {
			if v != BeaufortMS[int(tt.value)] {
				t.Errorf("round trip %q = %v", tt.want, v)
			}
			continue
		}
		conv, _, _ := ResolveUnit(sis[tt.unit], tt.unit)
		if math.Abs(conv(v)-tt.value) > 1e-9 {
			t.Errorf("round trip %q: parsed SI %v converts to %v, want %v", tt.want, v, conv(v), tt.value)
		}
	}
}
