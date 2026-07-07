import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapConfig, PresetTopic } from "../api/mapConfig";
import {
  TOPICS,
  findPreset,
  findTopicForPresetId,
  parseIsobarLevel,
  swapIsobarLevel,
} from "../api/mapConfig";
import type { AvailableVariable } from "../api/v2catalog";

interface Props {
  activePreset: string | null;
  userPresets: MapConfig[];
  availableVariables: AvailableVariable[];
  onLoadPreset: (id: string) => void;
  onDeleteUserPreset: (id: string) => void;
  /** Toggles the side controls panel (settings / layer customisation). */
  menuOpen: boolean;
  onToggleMenu: () => void;
  /** Counter the parent bumps on every map / timeline interaction.
   *  Triggers an immediate dismissal of the variants strip on
   *  mobile so the user gets an unobstructed view of whatever
   *  they're inspecting. Desktop ignores this hint. */
  hideHint: number;
  /** Active upper-air pressure level (hPa), derived by App from the
   *  live layers. Null when no layer is isobaric. */
  upperHeight: number | null;
  /** Rewrite every level-bearing layer to this pressure level. */
  onSetUpperHeight: (hPa: number) => void;
}

/** A preset is renderable when at least one of its visible-by-default
 *  layers points at a variable the active model can serve. Layers
 *  hidden by default (visible: false) are quick-switch alternates and
 *  don't count toward "rendering". If every visible layer is
 *  unavailable the preset would land on a blank map, so we drop it
 *  from the bar rather than serve a dead button. */
function presetHasRenderableVariable(
  preset: MapConfig,
  availableVariables: AvailableVariable[],
): boolean {
  if (availableVariables.length === 0) return true; // /variables not loaded yet — show everything.
  const visible = preset.layers.filter((l) => l.visible !== false);
  const candidates = visible.length > 0 ? visible : preset.layers;
  for (const layer of candidates) {
    const info = availableVariables.find((v) => v.name === layer.variable);
    if (!info) continue;
    if (info.available) return true;
  }
  return false;
}

/** Resolve the sub-options that belong to a topic. Built-in topics
 *  read their preset ids from the static TOPICS list; the synthetic
 *  Custom topic returns the user's saved presets. Presets are filtered
 *  against the "any renderable variable" check, so a preset whose
 *  primary variable isn't ingested on this model never reaches the
 *  bar. */
function topicOptions(
  topic: PresetTopic,
  userPresets: MapConfig[],
  availableVariables: AvailableVariable[],
): MapConfig[] {
  if (topic.id === "custom") return userPresets;
  return topic.presetIds
    .map((id) => findPreset(id))
    .filter((p): p is MapConfig => !!p)
    .filter((p) => presetHasRenderableVariable(p, availableVariables));
}

/** Live media-query subscription. Returns true when the viewport is
 *  ≤720 CSS px wide — the same breakpoint the rest of the bar uses
 *  to drop labels and pad spacing for touch targets. */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 720px)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 720px)");
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

const MOBILE_HIDE_DELAY_MS = 20_000;

/** Pressure levels offered by the shared upper-air height selector,
 *  high-to-low so the segmented control reads 850 / 500 / 300. */
const UPPER_LEVELS = [850, 500, 300];

export default function PresetBar({
  activePreset,
  userPresets,
  availableVariables,
  onLoadPreset,
  onDeleteUserPreset,
  menuOpen,
  onToggleMenu,
  hideHint,
  upperHeight,
  onSetUpperHeight,
}: Props) {
  const activeTopic = findTopicForPresetId(activePreset, userPresets);
  const activeTopicDef = TOPICS.find((t) => t.id === activeTopic);
  const subOptions = useMemo(
    () =>
      activeTopicDef
        ? topicOptions(activeTopicDef, userPresets, availableVariables)
        : [],
    [activeTopicDef, userPresets, availableVariables],
  );
  const isMobile = useIsMobile();

  // Sub-row visibility on mobile: hidden by default, revealed for
  // MOBILE_HIDE_DELAY_MS after each interaction with the bar. On
  // desktop the sub-row is always visible — the timer is a no-op.
  const [shown, setShown] = useState(false);
  const timerRef = useRef<number | null>(null);
  const armHideTimer = useCallback(() => {
    if (!isMobile) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(
      () => setShown(false),
      MOBILE_HIDE_DELAY_MS,
    );
  }, [isMobile]);
  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );
  const reveal = useCallback(() => {
    setShown(true);
    armHideTimer();
  }, [armHideTimer]);

  // Dismiss on parent-driven interactions (map pan/zoom, timestep
  // change, etc.). Skip the initial render so the strip stays open
  // when a fresh page load lands on a topic. Subscription pattern —
  // we're synchronizing internal state with an external "interaction
  // happened" signal from the parent, so a setState in the effect is
  // intentional here.
  const initialHintRef = useRef(true);
  useEffect(() => {
    if (initialHintRef.current) {
      initialHintRef.current = false;
      return;
    }
    if (!isMobile) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShown(false);
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [hideHint, isMobile]);

  const subVisible = shown || !isMobile;

  // Shared upper-air height selector. The 850/500/300 buttons gate on
  // availableVariables: a level is enabled when the active phenomenon's
  // primary level-bearing variable is advertised at that level on the
  // current model. The control hides when the topic isn't Upper air, no
  // layer is isobaric, or no level is available.
  const heightOptions = useMemo(() => {
    if (activeTopic !== "upperair" || upperHeight == null) return [];
    const preset = activePreset ? findPreset(activePreset) : undefined;
    const probe =
      preset?.layers.find(
        (l) => l.displayMode === "tiles" && parseIsobarLevel(l.variable) != null,
      ) ?? preset?.layers.find((l) => parseIsobarLevel(l.variable) != null);
    if (!probe) return [];
    return UPPER_LEVELS.map((hPa) => {
      const candidate = swapIsobarLevel(probe.variable, hPa);
      const info = availableVariables.find((v) => v.name === candidate);
      // Catalog not loaded yet → enable all; otherwise gate on the
      // advertised availability of the candidate id.
      const enabled = availableVariables.length === 0 ? true : !!info?.available;
      return { hPa, enabled };
    });
  }, [activeTopic, activePreset, availableVariables, upperHeight]);
  const showHeightStrip = heightOptions.some((o) => o.enabled);

  return (
    <div className="preset-bar" role="toolbar" aria-label="Map presets">
      <div className="preset-bar-top">
        <button
          type="button"
          className={`preset-menu-btn ${menuOpen ? "open" : ""}`}
          onClick={onToggleMenu}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-pressed={menuOpen}
          title="Settings & layer customisation"
        >
          <span />
          <span />
          <span />
        </button>
        {activeTopic && subVisible && (subOptions.length > 0 || showHeightStrip) && (
          <div className="preset-sub-wrap">
            {subOptions.length > 0 && (
            <div className="preset-sub-strip" role="tablist">
            {subOptions.map((opt) => {
              const isActive = activePreset === opt.id;
              return (
                <div key={opt.id} className="preset-sub-cell">
                  <button
                    type="button"
                    className={`preset-sub-btn ${isActive ? "active" : ""}`}
                    onClick={() => {
                      onLoadPreset(opt.id);
                      reveal();
                    }}
                    title={opt.description ?? opt.label}
                    aria-pressed={isActive}
                    role="tab"
                  >
                    {opt.label}
                  </button>
                  {opt.user && (
                    <button
                      type="button"
                      className="preset-sub-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (
                          window.confirm(
                            `Delete saved preset "${opt.label}"?`,
                          )
                        ) {
                          onDeleteUserPreset(opt.id);
                        }
                      }}
                      title="Delete saved preset"
                      aria-label={`Delete preset ${opt.label}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
            </div>
            )}
            {activeTopic === "upperair" && showHeightStrip && (
              <div
                className="preset-height-strip"
                role="group"
                aria-label="Pressure level"
              >
                {heightOptions.map(({ hPa, enabled }) => {
                  const isActive = upperHeight === hPa;
                  return (
                    <button
                      key={hPa}
                      type="button"
                      className={`preset-sub-btn preset-height-btn${
                        isActive ? " active" : ""
                      }`}
                      disabled={!enabled}
                      aria-pressed={isActive}
                      title={`${hPa} hPa`}
                      onClick={() => {
                        onSetUpperHeight(hPa);
                        reveal();
                      }}
                    >
                      {hPa} hPa
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
      {TOPICS.map((topic) => {
        const isCustomEmpty =
          topic.id === "custom" && userPresets.length === 0;
        // Hide a topic whose presets are all unrenderable on the
        // current model (no available variable). The Custom topic is
        // never hidden — clicking it opens the side panel even when
        // empty so users can start authoring.
        if (topic.id !== "custom") {
          const renderable = topicOptions(topic, userPresets, availableVariables);
          if (renderable.length === 0) return null;
        }
        const active = activeTopic === topic.id;
        return (
          <button
            key={topic.id}
            type="button"
            className={`preset-topic-btn ${active ? "active" : ""}`}
            title={
              isCustomEmpty
                ? "Saved presets — open settings to create one"
                : topic.label
            }
            aria-label={topic.label}
            aria-pressed={active}
            onClick={() => {
              if (isCustomEmpty) {
                onToggleMenu();
                return;
              }
              if (active) {
                // Re-tap on the active topic toggles the mobile
                // sub-row back into view (or restarts its timer).
                // On desktop this is a no-op visually.
                reveal();
                return;
              }
              if (topic.id === "custom") {
                onLoadPreset(userPresets[0].id);
              } else {
                // Land on the first available preset within the topic
                // rather than the static defaultPresetId — the latter
                // may itself be filtered out (e.g. wind topic on a
                // model without surface wind would still default to
                // "wind"). Falls back to defaultPresetId so existing
                // behaviour is preserved when every preset is available.
                const opts = topicOptions(topic, userPresets, availableVariables);
                onLoadPreset(opts[0]?.id ?? topic.defaultPresetId);
              }
              reveal();
            }}
          >
            <span className="preset-topic-glyph" aria-hidden>
              {topic.icon}
            </span>
          </button>
        );
      })}
    </div>
  );
}
