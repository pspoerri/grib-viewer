/**
 * v2style — synthesize the v1 `WeatherStyle` the App.tsx state machine consumes
 * (the RFC3339 timesteps axis, legend window, open-at anchor) from a v2 `/meta`
 * response. This is the keystone of the port: `activeTimestep` is an index into
 * `metadata["weather-api:timesteps"]`, and that SAME index maps to the frame
 * the manager fetches, so the entire TimeBar / StatusBadge / keyboard / window
 * machinery keeps working unchanged. `sources`/`layers` stay empty — the
 * drape (wxLayerManager) fetches /data windows itself and never reads `sources`.
 */
import type { WeatherStyle } from "./types.js";
import type { V2VarMeta } from "./v2client.js";

/** First timestep ≥ nowMs (the frame to open at), else the last. */
function anchorIso(timesteps: string[], nowMs: number): string {
  if (timesteps.length === 0) return "";
  for (const ts of timesteps) {
    if (Date.parse(ts) >= nowMs) return ts;
  }
  return timesteps[timesteps.length - 1];
}

export function v2WeatherStyle(
  meta: V2VarMeta,
  nowMs: number = Date.now(),
): WeatherStyle {
  const timesteps = meta.timesteps ?? [];
  const synthetic = !!meta.synthetic_time;
  return {
    version: 8,
    name: `wx-v2-${meta.model ?? ""}-${meta.name}`,
    sources: {},
    layers: [],
    metadata: {
      "weather-api:run": meta.run ?? "",
      "weather-api:model": meta.model ?? "",
      "weather-api:variable": meta.name,
      "weather-api:units": meta.units,
      "weather-api:colormap": meta.colormap ?? "",
      "weather-api:vmin": meta.vmin,
      "weather-api:vmax": meta.vmax,
      "weather-api:timesteps": timesteps,
      "weather-api:active_timestep": timesteps[0] ?? "",
      // Synthetic runs have no meaningful "now" — anchor at the first step
      // (lead +0h) instead of the wall clock.
      "weather-api:start": synthetic
        ? (timesteps[0] ?? "")
        : anchorIso(timesteps, nowMs),
      "weather-api:synthetic": synthetic,
    },
  };
}
