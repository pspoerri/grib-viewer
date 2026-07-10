package api

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pspoerri/grib-viewer/internal/config"
)

func TestAcceptsGzip(t *testing.T) {
	tests := []struct {
		header string
		want   bool
	}{
		{"", false},
		{"br", false},
		{"gzip", true},
		{"br, GZip; q=0.5", true},
		{"gzip;q=0", false},
		{"xgzip", false},
	}
	for _, tt := range tests {
		if got := acceptsGzip(tt.header); got != tt.want {
			t.Errorf("acceptsGzip(%q) = %v, want %v", tt.header, got, tt.want)
		}
	}
}

func TestDataETagVariesByRepresentation(t *testing.T) {
	identity := dataETag("run", "/api/data?run=run", "")
	gzipped := dataETag("run", "/api/data?run=run", "gzip")
	if identity == gzipped {
		t.Fatalf("identity and gzip ETags must differ: %s", identity)
	}
	if got := dataETag("run", "/api/data?run=run", "gzip;q=0"); got != identity {
		t.Fatalf("gzip;q=0 ETag = %s, want identity %s", got, identity)
	}
}

func TestHandleMapConfigIncludesGeocoderURL(t *testing.T) {
	s := &Server{Cfg: &config.Config{
		GeocoderURL: "https://geo.example.test",
		Map: config.MapData{
			PMTiles: "https://tiles.example.test/{z}/{x}/{y}.pbf",
			Terrain: "https://terrain.example.test/{z}/{x}/{y}.webp",
		},
	}}
	rr := httptest.NewRecorder()
	s.handleMapConfig(rr, httptest.NewRequest(http.MethodGet, "/api/mapconfig", nil))

	var got map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["geocoder_url"] != s.Cfg.GeocoderURL {
		t.Fatalf("geocoder_url = %q, want %q", got["geocoder_url"], s.Cfg.GeocoderURL)
	}
}

func TestWithGzipVariesOnAcceptEncoding(t *testing.T) {
	h := withGzip(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, "forecast")
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if vary := rr.Header().Get("Vary"); !strings.Contains(vary, "Accept-Encoding") {
		t.Fatalf("Vary = %q, want Accept-Encoding", vary)
	}
	if got := rr.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	zr, err := gzip.NewReader(rr.Body)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(body); got != "forecast" {
		t.Fatalf("body = %q, want forecast", got)
	}
}

func TestWithGzipHonorsZeroQuality(t *testing.T) {
	h := withGzip(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "forecast")
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Accept-Encoding", "gzip;q=0")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if got := rr.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want identity", got)
	}
	if got := rr.Body.String(); got != "forecast" {
		t.Fatalf("body = %q, want forecast", got)
	}
}
