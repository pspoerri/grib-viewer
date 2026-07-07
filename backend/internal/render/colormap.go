// Package render converts wxtiles samples into PNG byte slices via named
// colormaps. Two flavours of colormap live in the registry:
//
//   - Public palettes — viridis, plasma, inferno, magma, the matplotlib
//     "sequential" single-hue maps (greys, purples, blues, greens), the
//     diverging maps (coolwarm, bwr, seismic), and the perceptually-
//     uniform Crameri diverging maps (berlin, managua, vanimo). Plus
//     the legacy domain-specific maps (precip, wind, cloud, solar, snow).
//     These show up in the user-facing colormap picker.
//
//   - Hidden stepped variants — per-temperature-field colormaps with
//     integer-Celsius band boundaries (1 °C default; 2 °C below -30 °C
//     and above +40 °C; 5 °C above +50 °C). These are referenced as
//     defaults by individual fields (t_2m, td_2m, t_l500, …) so the
//     legend looks the same regardless of which physical model served
//     the tile, but they don't clutter the palette dropdown.
package render

import (
	"image/color"
	"math"
	"sort"
)

// Colormap maps a normalized input in [0, 1] to an RGBA color.
type Colormap struct {
	Name  string
	Stops []ColorStop // monotonically increasing by Position
	// Hidden colormaps still serve tiles and legend.png but are filtered
	// out of the user-facing /v1/colormaps list. Used for the per-field
	// stepped temperature variants — they're internal defaults, not
	// palette options the user picks from a dropdown.
	Hidden bool
	// LogScale maps physical value → t logarithmically instead of
	// linearly. Set on accumulation palettes (precip) where
	// the value spans orders of magnitude: a single linear window either
	// drowns light rain (high vmax) or saturates on a downpour (low
	// vmax), and a window scaled by accumulation length made longer
	// windows render *lighter* for the same event. A log window is shared
	// across all accumulation lengths, so light rain stays visible and a
	// bigger total always reads as more colour. The frontend GPU shader
	// and legend mirror this (lib/colormap.ts).
	LogScale bool
}

// ColorStop is one control point of a piecewise-linear gradient.
type ColorStop struct {
	Position float64 // in [0, 1]
	Color    color.RGBA
}

// Sample interpolates the colormap at t, clamped to [0, 1]. NaN becomes
// fully transparent.
func (c *Colormap) Sample(t float64) color.RGBA {
	if math.IsNaN(t) {
		return color.RGBA{}
	}
	if t <= 0 {
		return c.Stops[0].Color
	}
	if t >= 1 {
		return c.Stops[len(c.Stops)-1].Color
	}
	for i := 1; i < len(c.Stops); i++ {
		if t <= c.Stops[i].Position {
			a := c.Stops[i-1]
			b := c.Stops[i]
			f := (t - a.Position) / (b.Position - a.Position)
			return color.RGBA{
				R: lerp8(a.Color.R, b.Color.R, f),
				G: lerp8(a.Color.G, b.Color.G, f),
				B: lerp8(a.Color.B, b.Color.B, f),
				A: lerp8(a.Color.A, b.Color.A, f),
			}
		}
	}
	return c.Stops[len(c.Stops)-1].Color
}

func lerp8(a, b uint8, f float64) uint8 {
	return uint8(float64(a) + (float64(b)-float64(a))*f + 0.5)
}

// rgb is shorthand for an opaque colour stop, used in the palette tables
// below to keep them readable.
func rgb(r, g, b uint8) color.RGBA { return color.RGBA{r, g, b, 255} }

// rgba allows transparency at a stop.
func rgba(r, g, b, a uint8) color.RGBA { return color.RGBA{r, g, b, a} }

// equiStops builds a piecewise-linear set of stops at evenly-spaced
// positions from the given colour list. Used for the matplotlib /
// Crameri palettes whose 9-tuple approximations are accurate enough for
// a screen rendering at any reasonable size.
func equiStops(cs ...color.RGBA) []ColorStop {
	if len(cs) < 2 {
		panic("render: equiStops needs ≥ 2 colours")
	}
	out := make([]ColorStop, len(cs))
	denom := float64(len(cs) - 1)
	for i, c := range cs {
		out[i] = ColorStop{Position: float64(i) / denom, Color: c}
	}
	return out
}

// ---------------------------------------------------------------------------
// Palette catalogue
// ---------------------------------------------------------------------------
// Sequential perceptually-uniform palettes (matplotlib): the canonical
// 9-point samples reproduce the smooth ramp closely enough for legend
// strips and tile rendering. Mat\plotlib's reference uses 256-stop LUTs;
// rounding to nine still keeps Δ-perceptual differences below ~2 JND.

var (
	// Viridis — the matplotlib default sequential palette. Public.
	Viridis = &Colormap{
		Name: "viridis",
		Stops: equiStops(
			rgb(68, 1, 84),
			rgb(72, 35, 116),
			rgb(64, 67, 135),
			rgb(52, 94, 141),
			rgb(41, 120, 142),
			rgb(32, 144, 140),
			rgb(34, 167, 132),
			rgb(121, 209, 81),
			rgb(253, 231, 37),
		),
	}
	// Plasma — bright purple → magenta → orange → yellow.
	Plasma = &Colormap{
		Name: "plasma",
		Stops: equiStops(
			rgb(13, 8, 135),
			rgb(75, 3, 161),
			rgb(125, 3, 168),
			rgb(168, 34, 150),
			rgb(203, 70, 121),
			rgb(229, 107, 93),
			rgb(248, 148, 65),
			rgb(253, 195, 40),
			rgb(240, 249, 33),
		),
	}
	// Inferno — black → purple → red → orange → cream.
	Inferno = &Colormap{
		Name: "inferno",
		Stops: equiStops(
			rgb(0, 0, 4),
			rgb(31, 12, 72),
			rgb(85, 15, 109),
			rgb(136, 34, 106),
			rgb(186, 54, 85),
			rgb(227, 89, 51),
			rgb(249, 140, 10),
			rgb(249, 201, 50),
			rgb(252, 255, 164),
		),
	}
	// Magma — black → purple → pink → orange → cream.
	Magma = &Colormap{
		Name: "magma",
		Stops: equiStops(
			rgb(0, 0, 4),
			rgb(28, 16, 68),
			rgb(79, 18, 123),
			rgb(129, 37, 129),
			rgb(181, 54, 122),
			rgb(229, 80, 100),
			rgb(251, 135, 97),
			rgb(254, 194, 135),
			rgb(252, 253, 191),
		),
	}

	// ── Matplotlib single-hue sequential palettes ────────────────
	Greys = &Colormap{
		Name: "greys",
		Stops: equiStops(
			rgb(255, 255, 255),
			rgb(240, 240, 240),
			rgb(217, 217, 217),
			rgb(189, 189, 189),
			rgb(150, 150, 150),
			rgb(115, 115, 115),
			rgb(82, 82, 82),
			rgb(37, 37, 37),
			rgb(0, 0, 0),
		),
	}
	Purples = &Colormap{
		Name: "purples",
		Stops: equiStops(
			rgb(252, 251, 253),
			rgb(239, 237, 245),
			rgb(218, 218, 235),
			rgb(188, 189, 220),
			rgb(158, 154, 200),
			rgb(128, 125, 186),
			rgb(106, 81, 163),
			rgb(84, 39, 143),
			rgb(63, 0, 125),
		),
	}
	Blues = &Colormap{
		Name: "blues",
		Stops: equiStops(
			rgb(247, 251, 255),
			rgb(222, 235, 247),
			rgb(198, 219, 239),
			rgb(158, 202, 225),
			rgb(107, 174, 214),
			rgb(66, 146, 198),
			rgb(33, 113, 181),
			rgb(8, 81, 156),
			rgb(8, 48, 107),
		),
	}
	Greens = &Colormap{
		Name: "greens",
		Stops: equiStops(
			rgb(247, 252, 245),
			rgb(229, 245, 224),
			rgb(199, 233, 192),
			rgb(161, 217, 155),
			rgb(116, 196, 118),
			rgb(65, 171, 93),
			rgb(35, 139, 69),
			rgb(0, 109, 44),
			rgb(0, 68, 27),
		),
	}

	// ── Diverging palettes ───────────────────────────────────────
	// CoolWarm (Moreland) — perceptually-balanced blue → grey → red.
	CoolWarm = &Colormap{
		Name: "coolwarm",
		Stops: equiStops(
			rgb(59, 76, 192),
			rgb(92, 110, 219),
			rgb(134, 158, 240),
			rgb(178, 198, 250),
			rgb(220, 220, 220),
			rgb(245, 192, 173),
			rgb(246, 138, 110),
			rgb(222, 73, 70),
			rgb(180, 4, 38),
		),
	}
	// BWR — saturated blue/white/red.
	BWR = &Colormap{
		Name: "bwr",
		Stops: []ColorStop{
			{0.0, rgb(0, 0, 255)},
			{0.5, rgb(255, 255, 255)},
			{1.0, rgb(255, 0, 0)},
		},
	}
	// Seismic — dark navy → blue → white → red → dark red.
	Seismic = &Colormap{
		Name: "seismic",
		Stops: []ColorStop{
			{0.00, rgb(0, 0, 76)},
			{0.25, rgb(0, 0, 255)},
			{0.50, rgb(255, 255, 255)},
			{0.75, rgb(255, 0, 0)},
			{1.00, rgb(127, 0, 0)},
		},
	}

	// ── Crameri scientific diverging palettes ────────────────────
	// Berlin — cyan → blue → black → red → pink.
	Berlin = &Colormap{
		Name: "berlin",
		Stops: equiStops(
			rgb(159, 207, 252),
			rgb(78, 158, 217),
			rgb(38, 102, 153),
			rgb(24, 50, 78),
			rgb(20, 20, 20),
			rgb(80, 35, 30),
			rgb(150, 60, 50),
			rgb(218, 124, 110),
			rgb(255, 173, 173),
		),
	}
	// Managua — yellow/tan → black → cyan/teal.
	Managua = &Colormap{
		Name: "managua",
		Stops: equiStops(
			rgb(255, 235, 159),
			rgb(213, 165, 95),
			rgb(159, 100, 65),
			rgb(95, 56, 45),
			rgb(40, 35, 45),
			rgb(38, 70, 100),
			rgb(60, 130, 150),
			rgb(141, 196, 200),
			rgb(220, 248, 245),
		),
	}
	// Vanimo — pink → black → yellow.
	Vanimo = &Colormap{
		Name: "vanimo",
		Stops: equiStops(
			rgb(255, 200, 230),
			rgb(222, 113, 168),
			rgb(153, 60, 110),
			rgb(80, 34, 60),
			rgb(20, 20, 20),
			rgb(60, 50, 30),
			rgb(120, 105, 50),
			rgb(200, 175, 95),
			rgb(250, 240, 175)),
	}

	// ── Domain-specific palettes (kept from earlier registry) ────

	// Precip emulates a common precipitation gradient (transparent → deep blue → red).
	// LogScale: accumulation spans orders of magnitude (drizzle to
	// downpour, 1h to 24h totals) on one shared window — the frontend
	// shader's logColorT implements the mapping.
	Precip = &Colormap{
		Name:     "precip",
		LogScale: true,
		Stops: []ColorStop{
			{0.00, rgba(255, 255, 255, 0)},
			{0.10, rgba(180, 220, 255, 180)},
			{0.30, rgba(60, 120, 220, 220)},
			{0.60, rgb(0, 180, 80)},
			{0.85, rgb(255, 200, 0)},
			{1.00, rgb(220, 30, 30)},
		},
	}
	// Wind is a diverging scale suitable for wind speed.
	Wind = &Colormap{
		Name: "wind",
		Stops: []ColorStop{
			{0.00, rgb(30, 30, 60)},
			{0.25, rgb(40, 100, 180)},
			{0.50, rgb(80, 200, 160)},
			{0.75, rgb(240, 200, 60)},
			{1.00, rgb(220, 60, 40)},
		},
	}
	// VerticalWind is a perceptually-uniform diverging palette
	// (ColorBrewer RdBu reversed) anchored at the centre so the
	// archive's symmetric window [-vmax, +vmax] maps to
	// [downdraft, calm, updraft]. Calm air (≈ 0 m/s) is fully
	// transparent so background terrain / contours read through;
	// weak updrafts / downdrafts fade in via low alpha so the
	// boundary-layer turbulence noise stays subtle and only
	// convective signatures (>~1 m/s) read as solid colour. Red
	// for upward, blue for downward — matches the standard
	// meteorological convention.
	VerticalWind = &Colormap{
		Name: "vertical_wind",
		Stops: []ColorStop{
			{0.00, rgb(5, 48, 97)},           // strong downdraft — deepest blue
			{0.12, rgb(33, 102, 172)},        // dark blue
			{0.25, rgb(67, 147, 195)},        // blue
			{0.38, rgba(146, 197, 222, 210)}, // light blue
			{0.46, rgba(209, 229, 240, 80)},  // pale blue, low alpha
			{0.50, rgba(247, 247, 247, 0)},   // calm — fully transparent
			{0.54, rgba(253, 219, 199, 80)},  // pale red, low alpha
			{0.62, rgba(244, 165, 130, 210)}, // light red
			{0.75, rgb(214, 96, 77)},         // red
			{0.88, rgb(178, 24, 43)},         // dark red
			{1.00, rgb(103, 0, 31)},          // strong updraft — deepest red
		},
	}
	// Cloud is a white-to-gray gradient with alpha.
	Cloud = &Colormap{
		Name: "cloud",
		Stops: []ColorStop{
			{0.00, rgba(255, 255, 255, 0)},
			{1.00, rgba(90, 90, 110, 220)},
		},
	}
	// Clouds is a richer cloud-cover palette than the legacy two-stop
	// `cloud` ramp. The METAR sky-cover bands (FEW ≤ 25 %, SCT 25–50 %,
	// BKN 50–87 %, OVC ≥ 87 %) get distinct visual weights: clear stays
	// fully transparent so the basemap reads through, scattered and
	// broken cloud stay close to pure white (only alpha rises), and
	// overcast lands on a soft mid-grey rather than a dark slate so the
	// overlay reads bright against light basemaps. Keyed in [0, 1] =
	// [0 %, 100 %] cover so the field's archive range maps directly
	// without anchored-palette helpers.
	Clouds = &Colormap{
		Name: "clouds",
		Stops: []ColorStop{
			{0.00, rgba(255, 255, 255, 0)},   // SKC — clear
			{0.10, rgba(255, 255, 255, 70)},  // FEW — wispy cirrus
			{0.25, rgba(255, 255, 255, 140)}, // FEW/SCT boundary
			{0.50, rgba(252, 252, 254, 200)}, // SCT/BKN boundary
			{0.75, rgba(240, 242, 246, 230)}, // BKN — mostly cloudy
			{0.87, rgba(215, 220, 228, 245)}, // BKN/OVC boundary
			{1.00, rgba(170, 178, 190, 250)}, // OVC — thick overcast
		},
	}
	// Relhum — dry brown → blue, used for relative humidity legends.
	Relhum = &Colormap{
		Name: "relhum",
		Stops: []ColorStop{
			{0.00, rgb(170, 110, 60)},
			{0.30, rgb(220, 200, 130)},
			{0.55, rgb(220, 230, 220)},
			{0.80, rgb(80, 150, 200)},
			{1.00, rgb(20, 40, 130)},
		},
	}
	// Solar — warm intensity ramp (transparent → amber → red) for
	// strictly-positive radiation / CAPE fields.
	Solar = &Colormap{
		Name: "solar",
		Stops: []ColorStop{
			{0.00, rgba(255, 255, 210, 0)},
			{0.10, rgba(255, 240, 150, 120)},
			{0.35, rgba(255, 190, 60, 210)},
			{0.65, rgba(235, 110, 30, 240)},
			{1.00, rgb(160, 30, 60)},
		},
	}
	// Snow — cool accumulation ramp (transparent → icy blue → indigo)
	// for snow depth / snow rate.
	Snow = &Colormap{
		Name: "snow",
		Stops: []ColorStop{
			{0.00, rgba(245, 248, 255, 0)},
			{0.10, rgba(210, 230, 255, 150)},
			{0.40, rgba(80, 150, 230, 220)},
			{0.70, rgba(30, 60, 180, 240)},
			{1.00, rgb(70, 30, 130)},
		},
	}

	// Prob — dedicated exceedance-probability palette ("warning
	// ladder"). 0 % is fully transparent so the basemap reads through
	// where the event is impossible; the ramp then runs pale yellow →
	// orange → magenta → deep purple at certain. Deliberately collides
	// with no physical palette so a probability layer can't be misread
	// as a value field. Keyed [0, 1] = [0 %, 100 %].
	Prob = &Colormap{
		Name: "prob",
		Stops: []ColorStop{
			{0.00, rgba(255, 245, 160, 0)},  // impossible — fully transparent
			{0.20, rgba(255, 215, 90, 140)}, // low chance — pale yellow
			{0.45, rgba(250, 140, 70, 217)}, // possible — orange
			{0.70, rgba(225, 60, 110, 242)}, // likely — magenta
			{1.00, rgb(110, 25, 150)},       // certain — deep purple
		},
	}

	// ── Legacy aliases ───────────────────────────────────────────
	// Viridis_Temp is kept as a hidden alias of Viridis so old config
	// strings (?cmap=viridis_temp, derived specs) keep working without
	// duplicating the palette in the user-visible dropdown.
	Viridis_Temp = aliasOf("viridis_temp", Viridis, true)
)

// aliasOf returns a Colormap with the given name and hidden flag that
// shares stops with `src`. Used to register multiple names for the same
// palette without duplicating the stop list.
func aliasOf(name string, src *Colormap, hidden bool) *Colormap {
	return &Colormap{Name: name, Stops: src.Stops, Hidden: hidden}
}

// ---------------------------------------------------------------------------
// Stepped temperature builders
// ---------------------------------------------------------------------------

// SteppedTempBoundaries returns band-boundary positions in [0, 1] for a
// temperature colormap whose archive range is [vminK, vmaxK]. Bands are
// integer-Celsius aligned with widths that vary by zone:
//
//	below -30 °C:    2 °C bands
//	-30 to +40 °C:   1 °C bands
//	+40 to +50 °C:   2 °C bands
//	above +50 °C:    5 °C bands
//
// 1 °C and 1 K are equal step widths, so the same boundaries serve users
// who view the legend in either Celsius or Kelvin. Fahrenheit users see
// bands that are 1.8 °F wide (close enough to 2 °F) without any extra
// machinery — splitting the registry by display unit isn't worth it.
//
// The first and last entries are always 0 and 1 so the colormap covers
// the whole archive window.
func SteppedTempBoundaries(vminK, vmaxK float64) []float64 {
	span := vmaxK - vminK
	if span <= 0 {
		return []float64{0, 1}
	}
	loC := vminK - 273.15
	hiC := vmaxK - 273.15

	// Collect interior boundary positions, deduped (a zone-edge value
	// like -30 °C can be hit by both the 2 °C zone below it and the 1 °C
	// zone above it).
	posSet := map[int64]float64{}
	addC := func(c float64) {
		pos := (c + 273.15 - vminK) / span
		if pos <= 1e-6 || pos >= 1-1e-6 {
			return
		}
		// Quantise the key so floating-point jitter doesn't produce
		// near-duplicate boundaries that confuse makeStepped.
		key := int64(math.Round(pos * 1e9))
		posSet[key] = pos
	}

	zones := []struct{ lo, hi, step float64 }{
		{math.Inf(-1), -30, 2},
		{-30, 40, 1},
		{40, 50, 2},
		{50, math.Inf(1), 5},
	}
	for _, z := range zones {
		rLo := math.Max(loC, z.lo)
		rHi := math.Min(hiC, z.hi)
		if rLo > rHi {
			continue
		}
		first := math.Ceil(rLo/z.step) * z.step
		// rHi+1e-9 to absorb the float epsilon at the closed upper edge.
		for c := first; c <= rHi+1e-9; c += z.step {
			addC(c)
		}
	}

	out := make([]float64, 0, len(posSet)+2)
	out = append(out, 0)
	for _, p := range posSet {
		out = append(out, p)
	}
	sort.Float64s(out)
	out = append(out, 1)
	return out
}

// ---------------------------------------------------------------------------
// Anchored palettes
// ---------------------------------------------------------------------------
//
// Anchored palettes pin colour stops at physically-meaningful threshold
// values (0 °C, 32 m/s, 1013 hPa, …) instead of letting a smooth ramp
// stretch uniformly over [vmin, vmax]. This solves the "everything in
// the everyday range looks the same" problem that vanilla viridis had
// for temperature: the typical 0–30 °C window mapped onto positions
// 0.55–0.78 of viridis, which is a flat teal slab.
//
// All anchored palettes share two helpers (interpolateAnchors,
// buildAnchoredPalette) so the per-field tables stay declarative. Each
// table is a sorted []colorAnchor in the field's natural unit (°C, m/s,
// dBZ, …); the palette function does any unit conversion (K → °C,
// Pa → hPa) before delegating.

// colorAnchor pins a single (physical-value, colour) pair on an
// anchored palette table. Tables are sorted strictly increasing by V.
type colorAnchor struct {
	V     float64
	Color color.RGBA
}

// interpolateAnchors linearly interpolates the anchor table at v,
// clamping at the endpoints. Anchors must be sorted by V ascending.
func interpolateAnchors(anchors []colorAnchor, v float64) color.RGBA {
	if v <= anchors[0].V {
		return anchors[0].Color
	}
	last := len(anchors) - 1
	if v >= anchors[last].V {
		return anchors[last].Color
	}
	for i := 1; i <= last; i++ {
		if v <= anchors[i].V {
			a := anchors[i-1]
			b := anchors[i]
			f := (v - a.V) / (b.V - a.V)
			return color.RGBA{
				R: lerp8(a.Color.R, b.Color.R, f),
				G: lerp8(a.Color.G, b.Color.G, f),
				B: lerp8(a.Color.B, b.Color.B, f),
				A: lerp8(a.Color.A, b.Color.A, f),
			}
		}
	}
	return anchors[last].Color
}

// buildAnchoredPalette returns a smooth Colormap whose stops are placed
// at the anchors that fall inside [lo, hi], mapped onto position [0, 1].
// Synthetic edge stops (interpolated from the anchor table) bracket the
// gradient so it covers the full archive window even when no anchor
// lands exactly on the endpoint.
//
// `name` is the registered colormap id; `hidden` controls whether it
// shows up in the user-facing `/v1/colormaps` listing. lo/hi are in the
// same unit as the anchor table — the caller is responsible for any
// unit conversion (e.g. K → °C, Pa → hPa).
func buildAnchoredPalette(name string, anchors []colorAnchor, lo, hi float64, hidden bool) *Colormap {
	if hi <= lo {
		// Degenerate range — return a 1-colour palette rather than
		// panicking. Sample() handles 2-stop identical lists fine.
		c := interpolateAnchors(anchors, lo)
		return &Colormap{
			Name:   name,
			Stops:  []ColorStop{{0, c}, {1, c}},
			Hidden: hidden,
		}
	}
	stops := make([]ColorStop, 0, len(anchors)+2)
	stops = append(stops, ColorStop{Position: 0, Color: interpolateAnchors(anchors, lo)})
	for _, a := range anchors {
		if a.V <= lo || a.V >= hi {
			continue
		}
		stops = append(stops, ColorStop{
			Position: (a.V - lo) / (hi - lo),
			Color:    a.Color,
		})
	}
	stops = append(stops, ColorStop{Position: 1, Color: interpolateAnchors(anchors, hi)})
	return &Colormap{Name: name, Stops: stops, Hidden: hidden}
}

// ---------------------------------------------------------------------------
// Temperature
// ---------------------------------------------------------------------------

// temperatureAnchors is the canonical weather-style temperature palette,
// keyed in °C rather than in archive-normalised position. Anchors are
// chosen so the everyday 0–30 °C window (where most users actually look)
// gets distinct hue transitions — cyan → green → yellow → orange → red —
// and the visually dominant 0 °C boundary lands on a clean cyan↔green
// hand-off so frozen vs. liquid is instantly readable.
//
// Outside that window the palette degrades gracefully: progressively
// deeper blues into the cold extreme, dark red → magenta → pink into
// the hot extreme. The endpoints (-60 / +60 °C) bracket every archive
// range we currently ingest, so the interpolator almost never has to
// clamp.
var temperatureAnchors = []colorAnchor{
	{-60, rgb(40, 0, 60)},    // very dark purple
	{-50, rgb(80, 10, 110)},  // deep purple
	{-40, rgb(110, 30, 160)}, // violet
	{-30, rgb(70, 50, 180)},  // indigo
	{-20, rgb(40, 90, 220)},  // royal blue
	{-10, rgb(80, 160, 230)}, // sky blue
	{-5, rgb(140, 200, 235)}, // pale blue
	{0, rgb(200, 235, 240)},  // very pale cyan — freezing anchor
	{5, rgb(170, 220, 160)},  // pale green
	{10, rgb(110, 195, 100)}, // green
	{15, rgb(180, 220, 70)},  // lime
	{20, rgb(240, 220, 60)},  // yellow
	{25, rgb(245, 170, 50)},  // orange
	{30, rgb(235, 100, 40)},  // red-orange
	{35, rgb(210, 40, 50)},   // red
	{40, rgb(160, 20, 60)},   // dark red
	{50, rgb(200, 50, 150)},  // pink-magenta
	{60, rgb(255, 230, 250)}, // near-white extreme
}

// TemperaturePalette returns a smooth Colormap whose stops are placed at
// the temperatureAnchors that fall inside [vminK, vmaxK], mapped onto
// position [0, 1]. Synthetic edge stops (interpolated from the anchor
// table) are added so the gradient covers the full archive window even
// when no anchor lands exactly on the endpoint.
//
// The returned palette is named "temperature" and marked Hidden — it's
// used as the source for stepped per-field defaults and as the smooth
// fallback when the runtime `?stepped=0` toggle is set on a field whose
// default is a hidden stepped variant. Not exposed in the user-facing
// /v1/colormaps list because its stops shift with [vminK, vmaxK].
func TemperaturePalette(vminK, vmaxK float64) *Colormap {
	return buildAnchoredPalette("temperature", temperatureAnchors,
		vminK-273.15, vmaxK-273.15, true)
}

// ---------------------------------------------------------------------------
// Wind speed
// ---------------------------------------------------------------------------

// windSpeedAnchors keys colour stops to wind-speed thresholds the
// public learns from forecast TV: Beaufort transitions (calm → light
// breeze → gale → storm) plus Saffir-Simpson hurricane categories at
// the high end. The palette runs dark navy (calm) → deep blue → teal
// → forest-green → ochre → rust → crimson → magenta → violet so the
// everyday 0–10 m/s window has visible hue progression and overlaid
// flow lines (typically drawn in white) read clearly at every speed.
//
// Values are in m/s; sorted strictly increasing.
var windSpeedAnchors = []colorAnchor{
	{0, rgb(15, 20, 40)},      // calm — deep navy
	{2, rgb(25, 45, 80)},      // light air (Bft 1)
	{4, rgb(30, 70, 110)},     // light breeze (Bft 2)
	{6, rgb(25, 95, 115)},     // gentle breeze (Bft 3)
	{8, rgb(30, 110, 90)},     // moderate breeze (Bft 4)
	{11, rgb(60, 125, 45)},    // fresh breeze (Bft 5)
	{14, rgb(135, 135, 30)},   // strong breeze (Bft 6)
	{17, rgb(165, 105, 25)},   // near gale (Bft 7)
	{21, rgb(165, 65, 20)},    // gale (Bft 8–9)
	{25, rgb(155, 30, 35)},    // storm (Bft 10)
	{30, rgb(120, 20, 60)},    // violent storm (Bft 11)
	{35, rgb(100, 15, 95)},    // hurricane Cat 1
	{45, rgb(80, 35, 130)},    // Cat 2
	{60, rgb(55, 55, 150)},    // Cat 3
	{80, rgb(115, 115, 175)},  // Cat 4
	{120, rgb(200, 200, 215)}, // Cat 5+ extreme
}

// WindSpeedPalette returns a smooth Beaufort/Saffir-Simpson-anchored
// colormap for the archive range [vminMS, vmaxMS] in m/s. Surface and
// upper-air wind-speed fields share this palette so the same forecast
// wind speed renders the same colour regardless of model or level.
func WindSpeedPalette(vminMS, vmaxMS float64) *Colormap {
	return buildAnchoredPalette("wind_speed", windSpeedAnchors, vminMS, vmaxMS, true)
}

// ---------------------------------------------------------------------------
// Reflectivity (radar dBZ)
// ---------------------------------------------------------------------------

// reflectivityAnchors mimics the NWS NEXRAD radar palette — the colour
// scheme every TV weather viewer recognises. dBZ thresholds line up
// with practical convective regimes: 20 dBZ ≈ light rain, 40 dBZ ≈
// heavy rain / start of thunderstorm core, 50–60 dBZ ≈ severe
// thunderstorm with hail, ≥ 65 dBZ ≈ damaging hail. Echo below 5 dBZ
// is treated as "no echo" and rendered transparent so the basemap
// shows through.
//
// Values are in dBZ; sorted strictly increasing.
var reflectivityAnchors = []colorAnchor{
	{-10, rgba(0, 0, 0, 0)},      // no echo — transparent
	{5, rgba(150, 200, 230, 80)}, // very light — semi-transparent pale blue
	{15, rgb(100, 175, 220)},     // light rain — light blue
	{20, rgb(70, 200, 200)},      // light-moderate — cyan
	{25, rgb(60, 200, 130)},      // moderate — green
	{30, rgb(120, 220, 80)},      // moderate-heavy — yellow-green
	{35, rgb(220, 220, 70)},      // heavy rain — yellow
	{40, rgb(245, 175, 60)},      // very heavy — orange
	{45, rgb(235, 110, 45)},      // intense / start convection
	{50, rgb(220, 40, 50)},       // severe thunderstorm
	{55, rgb(175, 25, 80)},       // hail likely — dark red
	{60, rgb(200, 70, 200)},      // large hail — magenta
	{65, rgb(160, 60, 200)},      // damaging hail — purple
	{70, rgb(220, 200, 240)},     // extreme — pale lavender
	{80, rgb(255, 255, 255)},     // off-scale top — white
}

// ReflectivityPalette returns a smooth NWS-style radar colormap mapped
// onto [vminDBZ, vmaxDBZ]. Most archives carry [-10, 80] dBZ.
func ReflectivityPalette(vminDBZ, vmaxDBZ float64) *Colormap {
	return buildAnchoredPalette("radar_dbz", reflectivityAnchors, vminDBZ, vmaxDBZ, true)
}

// ---------------------------------------------------------------------------
// Mean sea-level pressure (MSLP)
// ---------------------------------------------------------------------------

// pressureAnchors anchors a diverging palette at 1013 hPa (the long-term
// mean sea-level pressure). High pressure tracks blue/green (anticyclones,
// settled weather); low pressure tracks orange/red (storms, deep cyclones).
// Anchors near 1013 hPa sit in a muted mid-tone band rather than near-
// white so the palette reads on light basemaps without washing out, while
// still letting the meaningful departures (≤ 990 hPa storms, ≥ 1030 hPa
// highs) carry the strongest colour.
//
// Values are in hPa, not Pa — multiply by 100 when feeding archive
// values. Sorted strictly increasing.
var pressureAnchors = []colorAnchor{
	{870, rgb(80, 0, 25)},      // off-scale low — extreme cyclone
	{940, rgb(140, 25, 50)},    // very deep low (cat 4 hurricane)
	{970, rgb(195, 75, 50)},    // major storm
	{990, rgb(215, 140, 65)},   // surface low
	{1005, rgb(205, 180, 145)}, // slight low
	{1013, rgb(180, 180, 180)}, // standard atmosphere — anchor
	{1020, rgb(140, 180, 170)}, // slight high
	{1030, rgb(85, 155, 150)},  // anticyclone
	{1045, rgb(40, 110, 135)},  // strong high
	{1060, rgb(25, 60, 105)},   // siberian high
	{1080, rgb(10, 15, 65)},    // off-scale high — dark navy
}

// PressurePalette returns a smooth diverging colormap anchored at
// 1013 hPa, mapped onto [vminPa, vmaxPa]. Inputs are in pascals so the
// caller can pass the archive's VMin/VMax directly; the function
// converts to hPa internally to match the anchor table.
func PressurePalette(vminPa, vmaxPa float64) *Colormap {
	return buildAnchoredPalette("pressure_mslp", pressureAnchors,
		vminPa/100, vmaxPa/100, true)
}

// ---------------------------------------------------------------------------
// Stepped variants and per-field pre-built palettes
// ---------------------------------------------------------------------------

// BuildSteppedTemperature returns a stepped colormap whose band colours
// come from the canonical temperature-anchored palette (TemperaturePalette)
// and whose band boundaries come from SteppedTempBoundaries. The result
// is named and marked Hidden=true; the registry init installs a variant
// per stepped temperature field.
//
// The point of using TemperaturePalette as the source — instead of a
// generic ramp like viridis — is that recognisable temperatures (0 °C,
// 30 °C, …) always sit on the same colour transitions regardless of the
// archive's [vmin, vmax]. This gives good local contrast in the
// everyday range (0–30 °C maps to cyan→green→yellow→orange) where
// viridis used to flatten everything into one teal band.
func BuildSteppedTemperature(name string, vminK, vmaxK float64) *Colormap {
	cm := makeStepped(name, TemperaturePalette(vminK, vmaxK), SteppedTempBoundaries(vminK, vmaxK))
	cm.Hidden = true
	return cm
}

// makeStepped builds a stepped colormap from a smooth source. boundaries
// is a sorted slice of positions in [0, 1] with len ≥ 2; the i-th band
// spans boundaries[i]..boundaries[i+1] and is painted with the single
// colour source.Sample gives at the band midpoint. Transitions between
// bands use a tiny epsilon (sub-pixel at any realistic render size), so
// the piecewise-linear Sample implementation renders each band as a flat
// plateau without special-casing stepped maps.
func makeStepped(name string, source *Colormap, boundaries []float64) *Colormap {
	const eps = 1e-6
	if len(boundaries) < 2 {
		panic("render: makeStepped needs at least 2 boundaries")
	}
	stops := make([]ColorStop, 0, 2*(len(boundaries)-1))
	for i := 0; i < len(boundaries)-1; i++ {
		lo, hi := boundaries[i], boundaries[i+1]
		c := source.Sample((lo + hi) / 2)
		start := lo
		if i > 0 {
			start = lo + eps
		}
		stops = append(stops,
			ColorStop{Position: start, Color: c},
			ColorStop{Position: hi, Color: c},
		)
	}
	return &Colormap{Name: name, Stops: stops}
}

// ---------------------------------------------------------------------------
// Pre-built stepped temperature variants
// ---------------------------------------------------------------------------
//
// Each per-field stepped colormap pins a (vminK, vmaxK) so the band
// boundaries land on exact integer-Celsius values for that field. The
// names follow the convention `stepped_temp_<id>` so a quick scan of
// fieldsʼ DefaultColormap pointers tells you which range a tile is
// banded against.

var (
	// stepped_temp — broad surface-temperature ramp; covers everything
	// from polar cold extremes to deserts. Used as the picker-visible
	// "discrete temperature legend" choice and as the default for
	// upper-air "t" archives without a level-specific variant.
	Stepped_Temp = BuildSteppedTemperature("stepped_temp", 200, 330)

	// stepped_temp_2m — t_2m at full archive [200, 330] K.
	Stepped_Temp_2m = BuildSteppedTemperature("stepped_temp_2m", 200, 330)

	// Surface temperature variants. Ranges match StandardQuantization.
	Stepped_Temp_Td_2m   = BuildSteppedTemperature("stepped_temp_td_2m", 200, 320)
	Stepped_Temp_Tmax_2m = BuildSteppedTemperature("stepped_temp_tmax_2m", 200, 335)
	Stepped_Temp_Tmin_2m = BuildSteppedTemperature("stepped_temp_tmin_2m", 195, 325)
	Stepped_Temp_T_g     = BuildSteppedTemperature("stepped_temp_t_g", 200, 345)
	Stepped_Temp_T_snow  = BuildSteppedTemperature("stepped_temp_t_snow", 200, 290)

	// Derived surface-temperature variants.
	Stepped_Temp_Wetbulb_2m    = BuildSteppedTemperature("stepped_temp_wetbulb_2m", 240, 310)
	Stepped_Temp_Heat_Index_2m = BuildSteppedTemperature("stepped_temp_heat_index_2m", 250, 330)
	Stepped_Temp_Theta         = BuildSteppedTemperature("stepped_temp_theta", 270, 370)
	Stepped_Temp_Td_l          = BuildSteppedTemperature("stepped_temp_td_l", 220, 310)

	// Per-pressure-level temperature variants. Kept registered so the
	// names stay requestable via ?cmap= even though no field defaults
	// to them anymore (the pressure-level system was removed); the
	// (vmin, vmax) tuples keep band boundaries on integer Celsius.
	Stepped_Temp_L925 = BuildSteppedTemperature("stepped_temp_l925", 253, 308)
	Stepped_Temp_L850 = BuildSteppedTemperature("stepped_temp_l850", 243, 298)
	Stepped_Temp_L700 = BuildSteppedTemperature("stepped_temp_l700", 233, 288)
	Stepped_Temp_L500 = BuildSteppedTemperature("stepped_temp_l500", 218, 268)
	Stepped_Temp_L250 = BuildSteppedTemperature("stepped_temp_l250", 198, 243)
)

// ---------------------------------------------------------------------------
// Pre-built wind-speed variants
// ---------------------------------------------------------------------------
//
// One variant per VMax that fields have used. Surface wind speed and
// gust display at 0–50 m/s; the wider 70/90/120 m/s variants remain
// requestable via ?cmap= for jet-stream-scale ranges. vmax_10m's
// archive carries 0–100 m/s as a safety margin even though the
// derived gust display caps at 50.

// namedWindSpeed builds a Beaufort-anchored wind-speed colormap with a
// stable id, so the per-VMax variants can be declared as package vars
// without clashing on the default "wind_speed" name returned by
// WindSpeedPalette.
func namedWindSpeed(name string, vmaxMS float64) *Colormap {
	cm := WindSpeedPalette(0, vmaxMS)
	cm.Name = name
	return cm
}

var (
	Wind_Speed_V50  = namedWindSpeed("wind_speed_v50", 50)   // surface wind / gust
	Wind_Speed_V70  = namedWindSpeed("wind_speed_v70", 70)   // ~ 700–850 hPa
	Wind_Speed_V90  = namedWindSpeed("wind_speed_v90", 90)   // ~ 500 hPa
	Wind_Speed_V100 = namedWindSpeed("wind_speed_v100", 100) // raw vmax_10m archive
	Wind_Speed_V120 = namedWindSpeed("wind_speed_v120", 120) // jet-stream levels (≤300 hPa)
)

// ---------------------------------------------------------------------------
// Pre-built radar-reflectivity variant
// ---------------------------------------------------------------------------

// Radar_Dbz is the canonical NWS-style dBZ palette mapped onto the
// [-10, +80] dBZ range used by every reflectivity archive. Single
// variant — every model writes dbz_cmax with the same window.
var Radar_Dbz = func() *Colormap {
	cm := ReflectivityPalette(-10, 80)
	cm.Name = "radar_dbz"
	return cm
}()

// ---------------------------------------------------------------------------
// Pre-built mean sea-level pressure variant
// ---------------------------------------------------------------------------

// Pressure_Mslp is the canonical diverging-at-1013-hPa palette mapped
// onto MSLP's [87000, 108000] Pa archive range.
var Pressure_Mslp = func() *Colormap {
	cm := PressurePalette(87000, 108000)
	cm.Name = "pressure_mslp"
	return cm
}()

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// registry maps colormap name to implementation. Built once at package
// init; treat as read-only at request time.
var registry = func() map[string]*Colormap {
	out := map[string]*Colormap{}
	for _, cm := range []*Colormap{
		// Public palettes
		Viridis, Plasma, Inferno, Magma,
		Greys, Purples, Blues, Greens,
		CoolWarm, BWR, Seismic,
		Berlin, Managua, Vanimo,
		Precip, Wind, VerticalWind, Cloud, Clouds, Relhum, Solar, Snow, Prob,
		// Legacy alias (hidden)
		Viridis_Temp,
		// Stepped variants (all hidden)
		Stepped_Temp, Stepped_Temp_2m,
		Stepped_Temp_Td_2m, Stepped_Temp_Tmax_2m, Stepped_Temp_Tmin_2m,
		Stepped_Temp_T_g, Stepped_Temp_T_snow,
		Stepped_Temp_Wetbulb_2m, Stepped_Temp_Heat_Index_2m,
		Stepped_Temp_Theta, Stepped_Temp_Td_l,
		Stepped_Temp_L925, Stepped_Temp_L850, Stepped_Temp_L700,
		Stepped_Temp_L500, Stepped_Temp_L250,
		// Wind / radar / pressure anchored variants (all hidden)
		Wind_Speed_V50, Wind_Speed_V70, Wind_Speed_V90,
		Wind_Speed_V100, Wind_Speed_V120,
		Radar_Dbz, Pressure_Mslp,
	} {
		out[cm.Name] = cm
	}
	return out
}()

// Get returns a colormap by name.
func Get(name string) (*Colormap, bool) {
	cm, ok := registry[name]
	return cm, ok
}

// AllNames returns every registered colormap name including hidden
// stepped variants. Used by tests that want to cover the full registry.
func AllNames() []string {
	out := make([]string, 0, len(registry))
	for name := range registry {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// AllIncludingHidden returns every registered colormap, hidden or not.
// The frontend uses this to seed its client-side palette cache so it can
// decode tiles that name a hidden stepped variant.
func AllIncludingHidden() []*Colormap {
	names := AllNames()
	out := make([]*Colormap, len(names))
	for i, n := range names {
		out[i] = registry[n]
	}
	return out
}
