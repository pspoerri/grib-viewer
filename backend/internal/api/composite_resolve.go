package api

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pspoerri/grib-viewer/internal/engine"
)

// Composite model-id resolution (spec 03): auto / auto_eps are virtual
// models. Windows for map drapes are fetched per-contributor by the
// client (via /api/composite/{id}); meta/point/grid/data requests that
// name the composite directly resolve to the finest buffered
// contributor carrying the variable.

func isComposite(model string) bool { return model == "auto" || model == "auto_eps" }

// contributors returns buffered, non-synthetic sources sorted
// finest→coarsest, filtered to EPS sources for auto_eps.
func (s *Server) contributors(composite string) []string {
	type c struct {
		id  string
		deg float64
	}
	var out []c
	for _, src := range s.Cfg.Sources {
		info, err := s.Engine.Info(src.ID, "latest")
		if err != nil || info.Synthetic {
			continue
		}
		name := s.servableHeadline(src.ID, info)
		if name == "" {
			continue
		}
		if composite == "auto_eps" && s.Engine.ProductsFor(src.ID, info.RunID, name).Members == 0 {
			continue
		}
		deg, err := s.Engine.NativeDeg(src.ID, info.RunID, name)
		if err != nil {
			continue
		}
		out = append(out, c{src.ID, deg})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].deg < out[j].deg })
	ids := make([]string, len(out))
	for i, e := range out {
		ids[i] = e.id
	}
	return ids
}

// resolveModel maps a composite id (+ variable) to a concrete source.
// base "" resolves to the finest contributor overall.
func (s *Server) resolveModel(model, base string) (string, error) {
	if !isComposite(model) {
		return model, nil
	}
	for _, id := range s.contributors(model) {
		info, err := s.Engine.Info(id, "latest")
		if err != nil {
			continue
		}
		if base == "" || s.Engine.Resolvable(id, info.RunID, base) {
			return id, nil
		}
	}
	return "", fmt.Errorf("no %s contributor serves %q", model, base)
}

func supportsProduct(c engine.ProductCapabilities, spec engine.PlaneSpec) bool {
	if spec.Exceed != nil {
		return c.Chance
	}
	switch spec.Product {
	case "", "p50":
		return c.Median
	case "mean":
		return c.Mean
	case "ctrl":
		return c.Control
	case "spread":
		return c.Spread
	case "p0":
		return c.Min
	case "p100":
		return c.Max
	}
	if strings.HasPrefix(spec.Product, "p") {
		p, err := strconv.Atoi(spec.Product[1:])
		if err != nil {
			return false
		}
		for _, available := range c.Percentiles {
			if p == available {
				return true
			}
		}
		return false
	}
	// Member ids are advanced/debug addressing. A positive member count is
	// enough to choose an ensemble contributor; the engine validates the exact
	// source-specific member number.
	return strings.HasPrefix(spec.Product, "m") && c.Members > 0
}

// resolveModelForPlane chooses the finest contributor that can serve both the
// variable and the requested product. This keeps a unioned composite catalog
// honest when, for example, only a coarser contributor has a control member.
func (s *Server) resolveModelForPlane(model string, spec engine.PlaneSpec) (string, error) {
	if !isComposite(model) {
		return model, nil
	}
	for _, id := range s.contributors(model) {
		info, err := s.Engine.Info(id, "latest")
		if err != nil || !s.Engine.Resolvable(id, info.RunID, spec.Base) {
			continue
		}
		if supportsProduct(s.Engine.ProductsFor(id, info.RunID, spec.Base), spec) {
			return id, nil
		}
	}
	return "", fmt.Errorf("no %s contributor serves %q product %q", model, spec.Base, spec.Product)
}

// compositeResolvable reports whether ANY contributor serves base.
func (s *Server) compositeResolvable(model string) func(string) bool {
	ids := s.contributors(model)
	return func(base string) bool {
		for _, id := range ids {
			info, err := s.Engine.Info(id, "latest")
			if err != nil {
				continue
			}
			if s.Engine.Resolvable(id, info.RunID, base) {
				return true
			}
		}
		return false
	}
}

func maximumProducts(a, b productsDTO) productsDTO {
	out := productsDTO{
		Median: a.Median || b.Median, Mean: a.Mean || b.Mean,
		Control: a.Control || b.Control, Min: a.Min || b.Min,
		Max: a.Max || b.Max, Spread: a.Spread || b.Spread,
		Chance: a.Chance || b.Chance, Members: max(a.Members, b.Members),
	}
	seen := map[int]bool{}
	for _, p := range append(append([]int{}, a.Percentiles...), b.Percentiles...) {
		seen[p] = true
	}
	for p := range seen {
		out.Percentiles = append(out.Percentiles, p)
	}
	sort.Ints(out.Percentiles)
	return out
}

func mergeVariableExposure(dst *varDTO, src varDTO) {
	dst.EPS = dst.EPS || src.EPS
	dst.Products = maximumProducts(dst.Products, src.Products)
	if src.Steps > dst.Steps {
		dst.Steps = src.Steps
	}
}

// compositeModelDTO builds the union catalog for a composite pseudo-model.
// The finest contributor supplies display metadata, while product capabilities
// are the maximum (union) over every accessible contributor.
func (s *Server) compositeModelDTO(id string) *modelDTO {
	ids := s.contributors(id)
	if len(ids) == 0 {
		return nil
	}
	md := &modelDTO{ID: id, LatestRun: s.compositeRunID(id)}
	md.Provider = "GRIB-viewer"
	md.License = "Derived work — see contributors"
	if id == "auto_eps" {
		md.Name = "Auto ensemble"
		md.Description = "ENS-only virtual model. Ensemble planes (median, control, percentiles, probabilities) blend the highest-resolution ensemble contributor per coordinate."
	} else {
		md.Name = "Auto composite"
		md.Description = "Unified virtual model. NWP variables blend the highest-resolution available contributor with feathered boundaries."
	}
	byName := map[string]int{}
	for _, src := range ids {
		sub, err := s.modelDTO(src)
		if err != nil {
			continue
		}
		md.Contributors = append(md.Contributors, src)
		for _, v := range sub.Variables {
			if i, ok := byName[v.Name]; ok {
				mergeVariableExposure(&md.Variables[i], v)
				continue
			}
			byName[v.Name] = len(md.Variables)
			md.Variables = append(md.Variables, v)
		}
	}
	if len(md.Variables) == 0 {
		return nil
	}
	sort.Slice(md.Variables, func(i, j int) bool { return md.Variables[i].Name < md.Variables[j].Name })
	return md
}

func (s *Server) compositeRunID(id string) string {
	h := ""
	for _, src := range s.contributors(id) {
		if info, err := s.Engine.Info(src, "latest"); err == nil {
			h += src + "@" + info.RunID + ";"
		}
	}
	return fmt.Sprintf("%s-%08x", id, fnv32(h))
}

// compositeRunDTO synthesizes /runs/latest for a composite: union
// validity window over contributors, union step counts (finest wins).
func (s *Server) compositeRunDTO(id string) (*runDTO, error) {
	ids := s.contributors(id)
	if len(ids) == 0 {
		return nil, fmt.Errorf("no contributors for %s", id)
	}
	dto := &runDTO{Run: s.compositeRunID(id), Complete: true, Steps: map[string]int{}}
	var lo, hi time.Time
	var ref time.Time
	for _, src := range ids {
		sub, err := s.runDTO(src, "latest", true)
		if err != nil {
			continue
		}
		if sub.ValidFrom != "" {
			f, _ := time.Parse(time.RFC3339, sub.ValidFrom)
			t, _ := time.Parse(time.RFC3339, sub.ValidTo)
			if lo.IsZero() || f.Before(lo) {
				lo = f
			}
			if t.After(hi) {
				hi = t
			}
		}
		if r, err := time.Parse(time.RFC3339, sub.Ref); err == nil && r.After(ref) {
			ref = r
		}
		dto.Complete = dto.Complete && sub.Complete
		for v, n := range sub.Steps {
			if n > dto.Steps[v] {
				dto.Steps[v] = n
			}
		}
	}
	if !lo.IsZero() {
		dto.ValidFrom = lo.Format(time.RFC3339)
		dto.ValidTo = hi.Format(time.RFC3339)
	}
	if !ref.IsZero() {
		dto.Ref = ref.Format(time.RFC3339)
	}
	return dto, nil
}
