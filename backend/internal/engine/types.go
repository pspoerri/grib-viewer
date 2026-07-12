package engine

import "time"

// GridDef describes a regular lat/lon output grid, node-centered:
// value(row, col) sits at (Lat0 + row*DLat, Lon0 + col*DLon), row 0
// north, col 0 west, DLat < 0, DLon > 0.
type GridDef struct {
	Nx, Ny     int
	Lat0, Lon0 float64
	DLat, DLon float64
}

// ExceedSpec is an exceedance product: P(v > Thr) or P(v < Thr), SI units.
type ExceedSpec struct {
	Thr   float64
	Below bool
}

// PlaneSpec identifies one derivable plane of one variable.
type PlaneSpec struct {
	Base    string // canonical variable id (t_2m, tot_prec, wind_speed_10m, t_850hpa, ...)
	Product string // "" (det/median), "pNN", "mean", "ctrl", "mN", "spread"
	Exceed  *ExceedSpec
}

// WindowReq asks for a bbox window (spec 02 "window assembly").
type WindowReq struct {
	Source, Run string
	Plane       PlaneSpec
	Times       []time.Time // resolved native valid times (>=1)
	Agg         string      // "", "max", "min", "mean", "sum" — folds Times into one frame
	BBox        [4]float64  // south, west, north, east
	MaxCells    int
	WithHeight  bool // join model surface height plane when available
}

// Window is the derived result; api quantizes and encodes it.
type Window struct {
	Grid       GridDef
	Frames     [][]float32 // one per output frame
	FrameTimes []time.Time
	Height     []float32 // optional z_model plane on the same grid
	Synthetic  bool
	Run        time.Time
}

// VarInfo describes one servable variable of a run (catalog row).
type VarInfo struct {
	Name       string
	Steps      []time.Time // sorted valid times
	Members    int         // 0 = deterministic, else member count (incl. control)
	HasControl bool        // member 0 exists at every valid time
	LevelType  uint8
	Level      int
}

// RunView is the resolved, queryable view of one buffered run.
type RunView struct {
	Source    string
	RunID     string
	Run       time.Time
	Synthetic bool
	Complete  bool
	Vars      map[string]*VarInfo
}
