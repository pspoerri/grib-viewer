package config

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestKeepRunsOmittedDefaultsButExplicitZeroIsPreserved(t *testing.T) {
	tests := []struct {
		name string
		line string
		want int
	}{
		{name: "omitted", want: 2},
		{name: "keep everything", line: "    keep_runs: 0\n", want: 0},
		{name: "explicit limit", line: "    keep_runs: 5\n", want: 5},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.yaml")
			raw := fmt.Sprintf("sources:\n  - id: local\n    type: folder\n    path: /tmp/grib\n%s", tt.line)
			if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
				t.Fatal(err)
			}
			cfg, err := Load(path)
			if err != nil {
				t.Fatal(err)
			}
			if got := cfg.Sources[0].KeepRuns; got != tt.want {
				t.Fatalf("KeepRuns = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestGeocoderURLDefaultAndOverride(t *testing.T) {
	for _, tt := range []struct {
		name string
		line string
		want string
	}{
		{name: "default", line: "data_dir: ./data\n", want: "https://nominatim.openstreetmap.org"},
		{name: "override", line: "geocoder_url: https://geo.example.test/nominatim\n", want: "https://geo.example.test/nominatim"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.yaml")
			if err := os.WriteFile(path, []byte(tt.line), 0o600); err != nil {
				t.Fatal(err)
			}
			cfg, err := Load(path)
			if err != nil {
				t.Fatal(err)
			}
			if cfg.GeocoderURL != tt.want {
				t.Fatalf("GeocoderURL = %q, want %q", cfg.GeocoderURL, tt.want)
			}
		})
	}
}
