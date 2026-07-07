// Package gribidx builds and persists per-run GRIB message indexes
// (spec 01). Indexing reads only message headers — no field decode.
// Files are indexed in place (folder sources never copy data).
package gribidx

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	grib "github.com/pspoerri/go-tiled-eccodes"
)

// Msg describes one GRIB2 field within a file.
type Msg struct {
	Msg       int       `json:"msg"` // message index within the file
	Var       string    `json:"var"`
	LevelType uint8     `json:"level_type,omitempty"`
	Level     int       `json:"level,omitempty"` // hPa for isobaric, m/cm otherwise
	Member    int       `json:"member"`          // -1 deterministic, 0 control, 1..N perturbed
	Ref       time.Time `json:"ref"`
	Valid     time.Time `json:"valid"`
	GridTmpl  uint16    `json:"grid_tmpl"`
}

// FileEntry is one indexed GRIB file (path may live outside the data dir).
type FileEntry struct {
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	MTime int64  `json:"mtime"`
	Msgs  []Msg  `json:"msgs"`
}

// RunIndex is the persisted index.json for one run.
type RunIndex struct {
	Source    string      `json:"source"`
	Run       time.Time   `json:"run"`
	Synthetic bool        `json:"synthetic_time,omitempty"`
	Complete  bool        `json:"complete"`
	Files     []FileEntry `json:"files"`
}

// SyntheticCutoff: reference times before this are treated as
// placeholder/debug timestamps (spec 01).
var SyntheticCutoff = time.Date(1990, 1, 1, 0, 0, 0, 0, time.UTC)

// ScanFile indexes every message of one GRIB2 file. varHint, when
// non-empty, names all messages in the file (source adapters know the
// variable from listings); otherwise names resolve from the WMO table
// or fall back to a generated id.
func ScanFile(path, varHint string) (*FileEntry, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	f, err := grib.Open(path)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	defer f.Close()
	fe := &FileEntry{Path: path, Size: st.Size(), MTime: st.ModTime().Unix()}
	for i, m := range f.Messages() {
		h := m.Header()
		name := varHint
		if name == "" {
			name = wmoName(h)
		}
		if name == "" {
			name = fmt.Sprintf("p%d_%d_%d", h.Discipline, h.ParameterCategory, h.ParameterNumber)
		}
		member := -1
		switch m.S4.TemplateNumber() {
		case 1, 11:
			member = int(m.S4.PerturbationNumber())
		}
		valid := validTime(m)
		fe.Msgs = append(fe.Msgs, Msg{
			Msg:       i,
			Var:       name,
			LevelType: h.TypeOfFirstFixedSurface,
			Level:     levelValue(h),
			Member:    member,
			Ref:       h.ReferenceTime,
			Valid:     valid,
			GridTmpl:  h.GridTemplate,
		})
	}
	return fe, nil
}

// validTime computes the absolute valid time of a message. For
// interval products (accumulations, averages; PDT 4.8 / 4.11) the
// valid time is the explicit end-of-overall-interval timestamp; for
// instant products it is reference time + forecast time.
func validTime(m *grib.Message) time.Time {
	h := m.Header()
	if t, ok := intervalEnd(m); ok {
		return t
	}
	return h.ReferenceTime.Add(forecastDuration(h.ForecastTime, h.UnitOfTimeRange))
}

func forecastDuration(v int32, unit uint8) time.Duration {
	switch unit {
	case 0:
		return time.Duration(v) * time.Minute
	case 1:
		return time.Duration(v) * time.Hour
	case 2:
		return time.Duration(v) * 24 * time.Hour
	case 10:
		return time.Duration(v) * 3 * time.Hour
	case 11:
		return time.Duration(v) * 6 * time.Hour
	case 12:
		return time.Duration(v) * 12 * time.Hour
	case 13:
		return time.Duration(v) * time.Second
	default:
		return time.Duration(v) * time.Hour
	}
}

// intervalEnd extracts the end-of-overall-time-interval timestamp from
// PDT 4.8 (det) and 4.11 (ensemble) template bodies. Template() bytes
// start at section-4 octet 10, so idx = octet − 10.
func intervalEnd(m *grib.Message) (time.Time, bool) {
	var off int
	switch m.S4.TemplateNumber() {
	case 8:
		off = 25 // octets 35..41
	case 11:
		off = 28 // octets 38..44 (after ensemble triplet)
	default:
		return time.Time{}, false
	}
	t := m.S4.Template()
	if len(t) < off+7 {
		return time.Time{}, false
	}
	year := int(binary.BigEndian.Uint16(t[off:]))
	mon, day, hour, min, sec := int(t[off+2]), int(t[off+3]), int(t[off+4]), int(t[off+5]), int(t[off+6])
	if year == 0 || mon == 0 || mon > 12 || day == 0 || day > 31 {
		return time.Time{}, false
	}
	return time.Date(year, time.Month(mon), day, hour, min, sec, 0, time.UTC), true
}

func levelValue(h grib.Header) int {
	lv := h.SurfaceLevel()
	if lv != lv { // NaN
		return 0
	}
	switch h.TypeOfFirstFixedSurface {
	case 100: // isobaric, Pa → hPa
		return int(lv / 100)
	default:
		return int(lv)
	}
}

// wmoName maps common WMO parameter triples to catalog names. Small on
// purpose: DWD/STAC adapters carry names from their listings; this
// covers convention-free folder sources for the core fields. Everything
// else gets a generated id and still renders (spec 02).
func wmoName(h grib.Header) string {
	type key struct{ d, c, n uint8 }
	names := map[key]string{
		{0, 0, 0}: "t", {0, 0, 4}: "tmax", {0, 0, 5}: "tmin", {0, 0, 6}: "td",
		{0, 1, 8}: "tot_prec", {0, 1, 52}: "tot_prec", {0, 1, 11}: "h_snow",
		{0, 2, 2}: "u", {0, 2, 3}: "v", {0, 2, 22}: "vmax",
		{0, 3, 0}: "ps", {0, 3, 1}: "pmsl", {0, 3, 4}: "fi", {0, 3, 5}: "fi",
		{0, 3, 6}: "hhl", // height of half levels; deepest = surface height
		{0, 6, 1}: "clct",
		{0, 7, 6}: "cape_ml",
		{2, 0, 7}: "hsurf",
	}
	return names[key{h.Discipline, h.ParameterCategory, h.ParameterNumber}]
}

const IndexFile = "index.json"

func Save(dir string, ri *RunIndex) error {
	raw, err := json.Marshal(ri)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".part-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(dir, IndexFile))
}

func Load(dir string) (*RunIndex, error) {
	raw, err := os.ReadFile(filepath.Join(dir, IndexFile))
	if err != nil {
		return nil, err
	}
	var ri RunIndex
	if err := json.Unmarshal(raw, &ri); err != nil {
		return nil, fmt.Errorf("%s/%s: %w", dir, IndexFile, err)
	}
	return &ri, nil
}
