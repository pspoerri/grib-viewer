// Package vars is the central variable catalog: one table drives wire
// quantization (int16 scale/offset), default colormaps, display ranges,
// temporal classification, and reducer kinds for every known weather
// variable (spec 05). Unknown ids fall back to Generic so arbitrary
// debug output still renders.
package vars

import (
	"strconv"
	"strings"
)

// Temporal classifies how a variable's values relate to time
// (spec 02 "Temporal source types & de-accumulation").
type Temporal int

const (
	// TemporalInstant fields are served as-is.
	TemporalInstant Temporal = iota
	// TemporalAccum fields accumulate since run start (tot_prec and
	// friends); the engine de-accumulates to step rates / window totals.
	TemporalAccum
	// TemporalTavg fields are time-averaged since run start (radiation
	// fluxes); the engine de-averages per step.
	TemporalTavg
	// TemporalStatic fields carry no time axis (hsurf).
	TemporalStatic
)

// ReducerKind selects the type-aware temporal reducer used by daily
// summaries and window-op defaults (spec 05).
type ReducerKind int

const (
	// ReduceMinMax reports {min, max} (+times) — temperature-like.
	ReduceMinMax ReducerKind = iota
	// ReduceMax reports the maximum — gusts, wind, CAPE, reflectivity.
	ReduceMax
	// ReduceMin reports the minimum — visibility.
	ReduceMin
	// ReduceMean reports the arithmetic mean — fluxes, percentages.
	ReduceMean
	// ReduceSum reports the total — accumulations.
	ReduceSum
	// ReducePeriod reports the temporal-OR probability — exceedances.
	ReducePeriod
)

// Field is the catalog row for one variable: metadata, int16 wire
// quantization, and rendering hints.
//
// Encoding formula:  raw   = (value − Offset) / Scale
// Decoding formula:  value = raw × Scale + Offset
//
// −32768 is reserved for NaN / NoData; finite values clamp to ±32767.
// VMin/VMax are colormap hints only — never used for encoding.
type Field struct {
	Name     string
	Units    string
	LongName string
	Colormap string
	Scale    float64 // int16 quantization: raw = (v-Offset)/Scale; 0 = auto-range (engine's job)
	Offset   float64
	VMin     float64 // colormap low bound (hint only)
	VMax     float64 // colormap high bound (hint only)
	Temporal Temporal
	Reducer  ReducerKind
}

// field is a declaration-order-friendly constructor so the catalog
// table below stays one line per variable.
func field(name, units, long, cmap string, scale, offset, vmin, vmax float64, t Temporal, r ReducerKind) Field {
	return Field{
		Name: name, Units: units, LongName: long, Colormap: cmap,
		Scale: scale, Offset: offset, VMin: vmin, VMax: vmax,
		Temporal: t, Reducer: r,
	}
}

// catalog is the canonical per-variable table (spec 05). Scale, Offset,
// VMin, and VMax follow the reference StandardQuantization values.
// Temperature fields default to the hidden "stepped_temp" palette; the
// remaining families use their domain palette (wind/precip/snow/cloud/
// solar/relhum) or plain viridis.
var catalog = buildCatalog()

func buildCatalog() map[string]Field {
	list := []Field{
		// ── Surface temperature (K) ─────────────────────────────
		field("t_2m", "K", "2m temperature", "stepped_temp_2m", 0.01, 270, 200, 330, TemporalInstant, ReduceMinMax),
		field("td_2m", "K", "2m dew point temperature", "stepped_temp_td_2m", 0.01, 260, 200, 320, TemporalInstant, ReduceMinMax),
		field("t_g", "K", "ground temperature (radiative)", "stepped_temp_t_g", 0.01, 270, 200, 345, TemporalInstant, ReduceMinMax),
		field("tmax_2m", "K", "2m max temperature", "stepped_temp_tmax_2m", 0.01, 270, 200, 335, TemporalInstant, ReduceMinMax),
		field("tmin_2m", "K", "2m min temperature", "stepped_temp_tmin_2m", 0.01, 270, 195, 325, TemporalInstant, ReduceMinMax),
		// Soil temperature (levels via t_so_l{N}).
		field("t_so", "K", "soil temperature", "stepped_temp", 0.01, 270, 200, 330, TemporalInstant, ReduceMinMax),

		// ── Bare header-named bases (folder sources) ────────────
		field("t", "K", "temperature", "stepped_temp", 0.01, 250, 180, 330, TemporalInstant, ReduceMinMax),
		field("td", "K", "dew point temperature", "stepped_temp", 0.01, 260, 200, 320, TemporalInstant, ReduceMinMax),
		field("tmax", "K", "max temperature", "stepped_temp", 0.01, 270, 200, 335, TemporalInstant, ReduceMinMax),
		field("tmin", "K", "min temperature", "stepped_temp", 0.01, 270, 195, 325, TemporalInstant, ReduceMinMax),

		// ── Isobaric temperature (per-level offsets recenter the
		//    int16 window on each level's climatology) ────────────
		field("t_300hpa", "K", "300 hPa temperature", "stepped_temp", 0.01, 230, 200, 250, TemporalInstant, ReduceMinMax),
		field("t_500hpa", "K", "500 hPa temperature", "stepped_temp", 0.01, 250, 225, 280, TemporalInstant, ReduceMinMax),
		field("t_850hpa", "K", "850 hPa temperature", "stepped_temp", 0.01, 270, 230, 310, TemporalInstant, ReduceMinMax),

		// ── Surface wind (m s-1) ────────────────────────────────
		field("u_10m", "m s-1", "10m zonal wind", "wind", 0.01, 0, -50, 50, TemporalInstant, ReduceMax),
		field("v_10m", "m s-1", "10m meridional wind", "wind", 0.01, 0, -50, 50, TemporalInstant, ReduceMax),
		field("vmax_10m", "m s-1", "10m max wind gust", "wind_speed_v100", 0.01, 0, 0, 100, TemporalInstant, ReduceMax),
		field("wind_speed_10m", "m s-1", "10m wind speed", "wind_speed_v100", 0.01, 0, 0, 50, TemporalInstant, ReduceMax),

		// Bare wind bases (multi-level / header-named sources).
		field("u", "m s-1", "zonal wind", "wind", 0.01, 0, -150, 150, TemporalInstant, ReduceMax),
		field("v", "m s-1", "meridional wind", "wind", 0.01, 0, -150, 150, TemporalInstant, ReduceMax),
		field("vmax", "m s-1", "max wind gust", "wind_speed_v100", 0.01, 0, 0, 100, TemporalInstant, ReduceMax),
		field("wind", "m s-1", "wind speed", "wind_speed_v100", 0.01, 0, 0, 110, TemporalInstant, ReduceMax),

		// ── Isobaric wind (VMin/VMax widen toward jet speeds) ──
		field("u_300hpa", "m s-1", "300 hPa zonal wind", "wind", 0.01, 0, -110, 110, TemporalInstant, ReduceMax),
		field("u_500hpa", "m s-1", "500 hPa zonal wind", "wind", 0.01, 0, -80, 80, TemporalInstant, ReduceMax),
		field("u_850hpa", "m s-1", "850 hPa zonal wind", "wind", 0.01, 0, -60, 60, TemporalInstant, ReduceMax),
		field("v_300hpa", "m s-1", "300 hPa meridional wind", "wind", 0.01, 0, -110, 110, TemporalInstant, ReduceMax),
		field("v_500hpa", "m s-1", "500 hPa meridional wind", "wind", 0.01, 0, -80, 80, TemporalInstant, ReduceMax),
		field("v_850hpa", "m s-1", "850 hPa meridional wind", "wind", 0.01, 0, -60, 60, TemporalInstant, ReduceMax),
		field("wind_300hpa", "m s-1", "300 hPa wind speed", "wind_speed_v100", 0.01, 0, 0, 110, TemporalInstant, ReduceMax),
		field("wind_500hpa", "m s-1", "500 hPa wind speed", "wind_speed_v100", 0.01, 0, 0, 80, TemporalInstant, ReduceMax),
		field("wind_850hpa", "m s-1", "850 hPa wind speed", "wind_speed_v100", 0.01, 0, 0, 60, TemporalInstant, ReduceMax),

		// ── Precipitation (accumulated since run start) ─────────
		field("tot_prec", "kg m-2", "total precipitation since run start", "precip", 0.01, 0, 0, 300, TemporalAccum, ReduceSum),
		field("rain_gsp", "kg m-2", "grid-scale rain since run start", "precip", 0.01, 0, 0, 200, TemporalAccum, ReduceSum),
		field("rain_con", "kg m-2", "convective rain since run start", "precip", 0.01, 0, 0, 100, TemporalAccum, ReduceSum),
		field("snow_gsp", "kg m-2", "grid-scale snow since run start", "snow", 0.01, 0, 0, 100, TemporalAccum, ReduceSum),
		field("snow_con", "kg m-2", "convective snow since run start", "snow", 0.01, 0, 0, 50, TemporalAccum, ReduceSum),
		field("grau_gsp", "kg m-2", "grid-scale graupel since run start", "snow", 0.01, 0, 0, 50, TemporalAccum, ReduceSum),

		// ── Derived precipitation windows (already de-accumulated,
		//    served as-is → instant) ─────────────────────────────
		field("precip_1h", "mm", "total precipitation last 1h", "precip", 0.01, 0, 0.1, 100, TemporalInstant, ReduceSum),
		field("precip_3h", "mm", "total precipitation last 3h", "precip", 0.01, 0, 0.1, 100, TemporalInstant, ReduceSum),
		field("precip_6h", "mm", "total precipitation last 6h", "precip", 0.01, 0, 0.1, 100, TemporalInstant, ReduceSum),
		field("precip_12h", "mm", "total precipitation last 12h", "precip", 0.01, 0, 0.1, 100, TemporalInstant, ReduceSum),
		field("precip_24h", "mm", "total precipitation last 24h", "precip", 0.01, 0, 0.1, 100, TemporalInstant, ReduceSum),

		// ── Cloud cover (%) ─────────────────────────────────────
		field("clct", "%", "total cloud cover", "clouds", 0.01, 0, 0, 100, TemporalInstant, ReduceMean),
		field("clch", "%", "high-level cloud cover", "clouds", 0.01, 0, 0, 100, TemporalInstant, ReduceMean),
		field("clcm", "%", "mid-level cloud cover", "clouds", 0.01, 0, 0, 100, TemporalInstant, ReduceMean),
		field("clcl", "%", "low-level cloud cover", "clouds", 0.01, 0, 0, 100, TemporalInstant, ReduceMean),

		// ── Pressure (Pa) ───────────────────────────────────────
		field("pmsl", "Pa", "mean sea-level pressure", "pressure_mslp", 1.0, 100000, 87000, 108000, TemporalInstant, ReduceMinMax),
		field("ps", "Pa", "surface pressure", "viridis", 1.0, 80000, 50000, 108000, TemporalInstant, ReduceMinMax),

		// ── Radiation (W m-2, time-averaged since run start) ────
		field("aswdifd_s", "W m-2", "diffuse downward shortwave radiation at surface", "solar", 0.1, 0, 0, 800, TemporalTavg, ReduceMean),
		field("aswdir_s", "W m-2", "direct downward shortwave radiation at surface", "solar", 0.1, 0, 0, 1200, TemporalTavg, ReduceMean),
		field("ghi", "W m-2", "global horizontal irradiance", "solar", 0.1, 0, 0, 1200, TemporalTavg, ReduceMean),

		// ── Humidity ────────────────────────────────────────────
		field("relhum_2m", "%", "2m relative humidity", "relhum", 0.01, 0, 0, 100, TemporalInstant, ReduceMean),

		// ── Convection ──────────────────────────────────────────
		field("cape_ml", "J kg-1", "convective available potential energy (mixed-layer)", "solar", 0.5, 0, 0, 6000, TemporalInstant, ReduceMax),

		// ── Snow / freezing level / ceiling ─────────────────────
		field("h_snow", "m", "snow depth", "snow", 0.01, 0, 0, 30, TemporalInstant, ReduceMinMax),
		field("hzerocl", "m", "freezing level height", "viridis", 1.0, 0, 0, 20000, TemporalInstant, ReduceMinMax),
		field("snowlmt", "m", "snow line altitude", "viridis", 1.0, 0, 0, 20000, TemporalInstant, ReduceMinMax),
		field("ceiling", "m", "cloud ceiling height", "viridis", 1.0, 0, 0, 20000, TemporalInstant, ReduceMinMax),

		// ── Surface / topography ────────────────────────────────
		field("hsurf", "m", "surface elevation", "viridis", 0.5, 0, -500, 9000, TemporalStatic, ReduceMean),

		// ── Visibility ──────────────────────────────────────────
		field("vis", "m", "visibility", "viridis", 5.0, 0, 0, 80000, TemporalInstant, ReduceMin),

		// ── Radar-like ──────────────────────────────────────────
		field("dbz_cmax", "dBZ", "column-max simulated radar reflectivity", "radar_dbz", 0.1, 0, -10, 80, TemporalInstant, ReduceMax),

		// ── Geopotential height (gpm; upstream m² s⁻² ÷ 9.80665
		//    at decode) ────────────────────────────────────────────
		field("fi", "gpm", "geopotential height", "viridis", 0.5, 0, 0, 16000, TemporalInstant, ReduceMinMax),
		field("fi_300hpa", "gpm", "300 hPa geopotential height", "viridis", 0.5, 0, 8400, 9900, TemporalInstant, ReduceMinMax),
		field("fi_500hpa", "gpm", "500 hPa geopotential height", "viridis", 0.5, 0, 4700, 6000, TemporalInstant, ReduceMinMax),
		field("fi_850hpa", "gpm", "850 hPa geopotential height", "viridis", 0.5, 0, 1100, 1700, TemporalInstant, ReduceMinMax),
	}
	out := make(map[string]Field, len(list))
	for _, f := range list {
		out[f.Name] = f
	}
	return out
}

// isobaricBases are the families that accept a `_{lvl}hpa` suffix.
// Levels with curated per-level entries (300/500/850) resolve exactly;
// any other level falls back to the family's bare base entry.
var isobaricBases = map[string]bool{
	"t": true, "td": true, "u": true, "v": true, "fi": true, "wind": true,
}

// Lookup resolves a base variable name (already stripped of
// plane/window/unit suffixes) to its Field.
//
// Level-suffixed forms resolve through their family:
//
//	t_so_l3   → the t_so entry   (soil-depth index 3)
//	t_850hpa  → the curated isobaric entry, or the bare "t" family
//	fi_500hpa → the curated fi entry
//
// ok=false for unknown names.
func Lookup(name string) (Field, bool) {
	if f, ok := catalog[name]; ok {
		return f, true
	}
	// {base}_l{N} — multi-level archive (soil depth, model level).
	if base, level, ok := splitLevelSuffix(name); ok {
		if f, ok := catalog[base]; ok {
			f.Name = name
			f.LongName += " (level " + strconv.Itoa(level) + ")"
			return f, true
		}
		return Field{}, false
	}
	// {base}_{lvl}hpa — isobaric level without a curated entry.
	if base, level, ok := splitHPaSuffix(name); ok && isobaricBases[base] {
		f := catalog[base]
		f.Name = name
		f.LongName = strconv.Itoa(level) + " hPa " + f.LongName
		return f, true
	}
	return Field{}, false
}

// Generic returns a renderable default Field for unknown ids. Scale 0
// means "auto-range" — quantization windowing is the engine's job.
func Generic(name string) Field {
	return Field{
		Name:     name,
		Units:    "",
		LongName: name,
		Colormap: "viridis",
		Scale:    0,
		Offset:   0,
		Temporal: TemporalInstant,
		Reducer:  ReduceMinMax,
	}
}

// splitLevelSuffix returns (base, level, true) for ids of the form
// `{base}_l{N}` where N is all decimal digits (e.g. "t_so_l3").
func splitLevelSuffix(id string) (base string, level int, ok bool) {
	end := len(id)
	for end > 0 && id[end-1] >= '0' && id[end-1] <= '9' {
		end--
	}
	if end == len(id) || end < 2 || id[end-1] != 'l' || id[end-2] != '_' {
		return "", 0, false
	}
	n, err := strconv.Atoi(id[end:])
	if err != nil {
		return "", 0, false
	}
	return id[:end-2], n, true
}

// splitHPaSuffix returns (base, level, true) for ids of the form
// `{base}_{digits}hpa` (e.g. "t_700hpa" → ("t", 700, true)).
func splitHPaSuffix(id string) (base string, level int, ok bool) {
	if !strings.HasSuffix(id, "hpa") {
		return "", 0, false
	}
	rest := id[:len(id)-len("hpa")]
	end := len(rest)
	start := end
	for start > 0 && rest[start-1] >= '0' && rest[start-1] <= '9' {
		start--
	}
	if start == end || start < 2 || rest[start-1] != '_' {
		return "", 0, false
	}
	n, err := strconv.Atoi(rest[start:end])
	if err != nil {
		return "", 0, false
	}
	return rest[:start-1], n, true
}
