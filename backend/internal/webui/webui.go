// Package webui serves the embedded frontend build from /.
//
// `make release` copies frontend/dist in here and gzips every file;
// only the .gz variants are embedded (half the binary size), served
// with Content-Encoding: gzip and decompressed on the fly for the
// rare client that doesn't accept it. Without a build present the
// server runs API-only.
package webui

import (
	"bytes"
	"compress/gzip"
	"embed"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var distFS embed.FS

// Handler returns the SPA handler, or nil when no build is embedded.
func Handler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return nil
	}
	if _, err := fs.Stat(sub, "index.html.gz"); err != nil {
		return nil // API-only build
	}
	return &spa{fs: sub}
}

type spa struct{ fs fs.FS }

func (s *spa) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if p == "" || p == "." {
		p = "index.html"
	}
	data, err := fs.ReadFile(s.fs, p+".gz")
	if err != nil {
		// SPA fallback: unknown non-asset paths get the app shell
		p = "index.html"
		if data, err = fs.ReadFile(s.fs, p+".gz"); err != nil {
			http.NotFound(w, r)
			return
		}
	}

	if ctype := mime.TypeByExtension(path.Ext(p)); ctype != "" {
		w.Header().Set("Content-Type", ctype)
	}
	// vite emits content-hashed filenames under assets/ — cache hard;
	// everything else (index.html, manifest, icons) revalidates
	if strings.HasPrefix(p, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.Header().Add("Vary", "Accept-Encoding")

	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		w.Write(data)
		return
	}
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "corrupt asset", http.StatusInternalServerError)
		return
	}
	defer gz.Close()
	io.Copy(w, gz)
}
