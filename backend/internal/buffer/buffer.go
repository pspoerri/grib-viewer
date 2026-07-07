// Package buffer manages the on-disk GRIB buffer (spec 01):
//
//	{data_dir}/{source_id}/static/...
//	{data_dir}/{source_id}/runs/{YYYYMMDDTHHMMZ}/*.grib2 + index.json
//	{data_dir}/{source_id}/latest        -> {"run":"..."}
package buffer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

const RunIDFormat = "20060102T1504Z"

type Buffer struct{ Root string }

// New absolutizes root so indexed file paths stay valid regardless of
// the serving process's working directory.
func New(root string) *Buffer {
	if abs, err := filepath.Abs(root); err == nil {
		root = abs
	}
	return &Buffer{Root: root}
}

func (b *Buffer) SourceDir(source string) string { return filepath.Join(b.Root, source) }
func (b *Buffer) StaticDir(source string) string {
	return filepath.Join(b.Root, source, "static")
}
func (b *Buffer) RunDir(source string, run time.Time) string {
	return filepath.Join(b.Root, source, "runs", run.UTC().Format(RunIDFormat))
}
func (b *Buffer) RunDirByID(source, runID string) string {
	return filepath.Join(b.Root, source, "runs", runID)
}

// WriteAtomic writes data to path via a sibling temp file + rename.
func WriteAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".part-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// CreateAtomic returns a temp file and a commit func that renames it to path.
func CreateAtomic(path string) (*os.File, func() error, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, nil, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".part-*")
	if err != nil {
		return nil, nil, err
	}
	commit := func() error {
		if err := tmp.Close(); err != nil {
			os.Remove(tmp.Name())
			return err
		}
		return os.Rename(tmp.Name(), path)
	}
	return tmp, commit, nil
}

type latestDoc struct {
	Run string `json:"run"`
}

func (b *Buffer) WriteLatest(source, runID string) error {
	raw, _ := json.Marshal(latestDoc{Run: runID})
	return WriteAtomic(filepath.Join(b.SourceDir(source), "latest"), raw)
}

func (b *Buffer) ReadLatest(source string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(b.SourceDir(source), "latest"))
	if err != nil {
		return "", err
	}
	var d latestDoc
	if err := json.Unmarshal(raw, &d); err != nil {
		return "", fmt.Errorf("latest pointer for %s: %w", source, err)
	}
	return d.Run, nil
}

// ListRuns returns buffered run IDs for a source, newest first.
func (b *Buffer) ListRuns(source string) ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(b.SourceDir(source), "runs"))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var runs []string
	for _, e := range entries {
		if e.IsDir() {
			runs = append(runs, e.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(runs))) // run IDs sort chronologically
	return runs, nil
}

// Prune removes all but the newest keep runs. It never removes protect
// (the run currently being fetched). keep <= 0 keeps everything.
func (b *Buffer) Prune(source string, keep int, protect string) error {
	if keep <= 0 {
		return nil
	}
	runs, err := b.ListRuns(source)
	if err != nil {
		return err
	}
	for i, run := range runs {
		if i < keep || run == protect {
			continue
		}
		if err := os.RemoveAll(b.RunDirByID(source, run)); err != nil {
			return err
		}
	}
	return nil
}
