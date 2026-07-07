package render

import "testing"

func TestRegistryHasReferenceSet(t *testing.T) {
	// public palettes + the hidden per-field variants the catalog names
	for _, name := range []string{
		"viridis", "plasma", "inferno", "magma",
		"greys", "purples", "blues", "greens",
		"coolwarm", "bwr", "seismic", "berlin", "managua", "vanimo",
		"precip", "wind", "cloud", "clouds", "relhum", "solar", "snow", "prob",
		"stepped_temp", "stepped_temp_2m", "stepped_temp_td_2m",
		"wind_speed_v100", "pressure_mslp", "radar_dbz",
	} {
		if _, ok := Get(name); !ok {
			t.Errorf("missing colormap %q", name)
		}
	}
}

func TestTransparencyAnchors(t *testing.T) {
	// palettes that must read through to the basemap at zero
	for _, name := range []string{"precip", "snow", "prob", "clouds"} {
		cm, ok := Get(name)
		if !ok {
			t.Fatalf("missing %q", name)
		}
		if a := cm.Stops[0].Color.A; a != 0 {
			t.Errorf("%s: first stop alpha = %d, want 0", name, a)
		}
	}
	// temperature is opaque everywhere
	cm, _ := Get("stepped_temp_2m")
	for _, st := range cm.Stops {
		if st.Color.A != 255 {
			t.Fatalf("stepped_temp_2m has transparent stop at %v", st.Position)
		}
	}
}

func TestSampleNaNTransparent(t *testing.T) {
	cm, _ := Get("viridis")
	if got := cm.Sample(nan()); got.A != 0 {
		t.Fatalf("NaN sample alpha = %d", got.A)
	}
}

func nan() float64 { var z float64; return z / z }
