// Pure helper for the add-layer ensembleMode seed (Task 5). The layer
// builder seeds a new layer's `ensembleMode` from the selectedModel-derived
// default so a layer added on a composite routes to the active flavor
// (auto → det, auto_eps → eps); a physical-model add leaves it undefined
// (ensembleMode is ignored on physical models).
import { isCompositeModel } from "../api/types.ts";
import { compositeEpsState } from "./epsMode.ts";

/** The `ensembleMode` to seed a freshly added layer with, derived from the
 *  active `selectedModel`. Composite → "det"/"eps" matching the composite
 *  flavor; physical model → undefined. */
export function seedEnsembleMode(
  selectedModel: string,
): "det" | "eps" | undefined {
  if (!isCompositeModel(selectedModel)) return undefined;
  return compositeEpsState(selectedModel) ? "eps" : "det";
}
