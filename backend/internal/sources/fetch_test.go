package sources

import (
	"bytes"
	"compress/bzip2"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fastRetries shrinks the backoff for tests.
func fastRetries(t *testing.T) {
	t.Helper()
	old := baseRetryDelay
	baseRetryDelay = time.Millisecond
	t.Cleanup(func() { baseRetryDelay = old })
}

func TestFetchURLRetriesTransient(t *testing.T) {
	fastRetries(t)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) < 3 {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		w.Write([]byte("payload"))
	}))
	defer srv.Close()

	var buf bytes.Buffer
	if err := fetchURL(context.Background(), srv.Client(), srv.URL+"/f.grib2", &buf); err != nil {
		t.Fatalf("fetchURL: %v", err)
	}
	if buf.String() != "payload" {
		t.Fatalf("got %q", buf.String())
	}
	if got := hits.Load(); got != 3 {
		t.Fatalf("expected 3 attempts, got %d", got)
	}
}

func TestFetchURL4xxTerminal(t *testing.T) {
	fastRetries(t)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.NotFound(w, r)
	}))
	defer srv.Close()

	var buf bytes.Buffer
	err := fetchURL(context.Background(), srv.Client(), srv.URL+"/f.grib2", &buf)
	if err == nil {
		t.Fatal("expected error")
	}
	var se *httpStatusError
	if !errors.As(err, &se) || se.Status != 404 {
		t.Fatalf("expected 404 httpStatusError, got %v", err)
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("404 must be terminal (1 attempt), got %d", got)
	}
}

func TestFetchURL429Retried(t *testing.T) {
	fastRetries(t)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) < 2 {
			http.Error(w, "slow down", http.StatusTooManyRequests)
			return
		}
		w.Write([]byte("ok"))
	}))
	defer srv.Close()

	var buf bytes.Buffer
	if err := fetchURL(context.Background(), srv.Client(), srv.URL+"/f", &buf); err != nil {
		t.Fatalf("fetchURL: %v", err)
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("expected 429 to be retried once, got %d attempts", got)
	}
}

func TestFetchURLExhaustsAttempts(t *testing.T) {
	fastRetries(t)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Error(w, "boom", http.StatusBadGateway)
	}))
	defer srv.Close()

	var buf bytes.Buffer
	err := fetchURL(context.Background(), srv.Client(), srv.URL+"/f", &buf)
	if err == nil {
		t.Fatal("expected error")
	}
	if got := hits.Load(); got != downloadMaxAttempts {
		t.Fatalf("expected %d attempts, got %d", downloadMaxAttempts, got)
	}
}

func TestFetchURLPartialWriteTerminal(t *testing.T) {
	fastRetries(t)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Length", "100")
		w.Write([]byte("short"))
		// Abort mid-body so the client sees an unexpected EOF after
		// bytes already reached dst.
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		conn, _, _ := w.(http.Hijacker).Hijack()
		conn.Close()
	}))
	defer srv.Close()

	var buf bytes.Buffer
	err := fetchURL(context.Background(), srv.Client(), srv.URL+"/f", &buf)
	if err == nil {
		t.Fatal("expected error")
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("partial write must not retry, got %d attempts", got)
	}
}

func TestFetchURLBz2Inflate(t *testing.T) {
	payload := "GRIB payload bytes"
	compressed := bz2Compress(t, []byte(payload))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, ".bz2") {
			http.NotFound(w, r)
			return
		}
		w.Write(compressed)
	}))
	defer srv.Close()

	var buf bytes.Buffer
	if err := fetchURL(context.Background(), srv.Client(), srv.URL+"/f.grib2.bz2", &buf); err != nil {
		t.Fatalf("fetchURL: %v", err)
	}
	if buf.String() != payload {
		t.Fatalf("bz2 inflation mismatch: got %q", buf.String())
	}
}

// bz2Compress shells out to the system bzip2 (stdlib only decompresses).
func bz2Compress(t *testing.T, data []byte) []byte {
	t.Helper()
	cmd := exec.Command("bzip2", "-c")
	cmd.Stdin = bytes.NewReader(data)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		t.Skipf("bzip2 not available: %v", err)
	}
	// Round-trip sanity check with the stdlib reader.
	var back bytes.Buffer
	if _, err := back.ReadFrom(bzip2.NewReader(bytes.NewReader(out.Bytes()))); err != nil || !bytes.Equal(back.Bytes(), data) {
		t.Fatalf("bz2 round-trip failed: %v", err)
	}
	return out.Bytes()
}
