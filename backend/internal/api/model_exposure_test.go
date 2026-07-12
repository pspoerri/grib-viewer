package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/pspoerri/grib-viewer/internal/buffer"
	"github.com/pspoerri/grib-viewer/internal/config"
	"github.com/pspoerri/grib-viewer/internal/engine"
	"github.com/pspoerri/grib-viewer/internal/gribidx"
)

func TestMaximumProductsUnionsAccessibleCapabilities(t *testing.T) {
	a := productsDTO{Median: true, Mean: true, Max: true, Percentiles: []int{10, 50}, Members: 40}
	b := productsDTO{Median: true, Control: true, Spread: true, Chance: true, Percentiles: []int{25, 50, 90}, Members: 11}
	got := maximumProducts(a, b)
	if !got.Max || !got.Control || !got.Spread || !got.Chance {
		t.Fatalf("maximum products = %+v", got)
	}
	if got.Members != 40 {
		t.Fatalf("members = %d, want maximum 40", got.Members)
	}
	wantP := []int{10, 25, 50, 90}
	if len(got.Percentiles) != len(wantP) {
		t.Fatalf("percentiles = %v, want %v", got.Percentiles, wantP)
	}
	for i := range wantP {
		if got.Percentiles[i] != wantP[i] {
			t.Fatalf("percentiles = %v, want %v", got.Percentiles, wantP)
		}
	}
}

func TestSupportsProductUsesActualCapability(t *testing.T) {
	c := engine.ProductCapabilities{Median: true, Max: true, Chance: true}
	if !supportsProduct(c, engine.PlaneSpec{Product: "p100"}) {
		t.Fatal("accessible maximum was not exposed")
	}
	if supportsProduct(c, engine.PlaneSpec{Product: "ctrl"}) {
		t.Fatal("unavailable control was exposed")
	}
	if !supportsProduct(c, engine.PlaneSpec{Exceed: &engine.ExceedSpec{}}) {
		t.Fatal("accessible chance product was not exposed")
	}
}

func TestModelsOmitsBufferedSourceWithoutVariables(t *testing.T) {
	root := t.TempDir()
	b := buffer.New(root)
	run := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	runDir := b.RunDir("ghost", run)
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := gribidx.Save(runDir, &gribidx.RunIndex{Source: "ghost", Run: run, Complete: true}); err != nil {
		t.Fatal(err)
	}
	if err := b.WriteLatest("ghost", run.Format(buffer.RunIDFormat)); err != nil {
		t.Fatal(err)
	}
	s := &Server{
		Cfg:    &config.Config{Sources: []config.Source{{ID: "ghost"}}},
		Engine: engine.New(b, 16),
	}
	rr := httptest.NewRecorder()
	s.handleModels(rr, httptest.NewRequest(http.MethodGet, "/api/models", nil))
	var body struct {
		Models []modelDTO `json:"models"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Models) != 0 {
		t.Fatalf("models = %+v, want no phantom model", body.Models)
	}
}
