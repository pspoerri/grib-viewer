import { useCallback, useEffect, useRef, useState } from "react";
import { searchLocations, type SearchResult } from "../api/geocode";
export type { SearchResult } from "../api/geocode";





interface Props {
  /** Fly the map to the picked result and open the point popup there. */
  onPick: (r: SearchResult) => void;
}

/**
 * Floating location-search pill (top center). Collapsed to a button;
 * expands into an input with a debounced result dropdown. Picking a
 * result (click or Enter) recenters the map and opens the
 * point-inspector at the result's coordinates.
 */
export default function LocationSearch({ onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const debounceTimer = useRef<number | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const runSearch = useCallback((q: string) => {
    ctrlRef.current?.abort();
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setBusy(false);
      setError(false);
      return;
    }
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setBusy(true);
    setError(false);
    searchLocations(trimmed, ctrl.signal, 8)
      .then((out) => {
        if (ctrl.signal.aborted) return;
        setResults(out);
        setHighlight(0);
        setBusy(false);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        console.error("Location search failed:", err);
        setResults([]);
        setBusy(false);
        setError(true);
      });
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const q = e.target.value;
      setQuery(q);
      if (debounceTimer.current) window.clearTimeout(debounceTimer.current);
      debounceTimer.current = window.setTimeout(() => runSearch(q), 300);
    },
    [runSearch],
  );

  useEffect(
    () => () => {
      if (debounceTimer.current) window.clearTimeout(debounceTimer.current);
      ctrlRef.current?.abort();
    },
    [],
  );

  const pick = useCallback(
    (r: SearchResult) => {
      onPick(r);
      setOpen(false);
      setQuery("");
      setResults([]);
    },
    [onPick],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      switch (e.key) {
        case "Escape":
          setOpen(false);
          e.preventDefault();
          return;
        case "ArrowDown":
          setHighlight((h) => Math.min(results.length - 1, h + 1));
          e.preventDefault();
          return;
        case "ArrowUp":
          setHighlight((h) => Math.max(0, h - 1));
          e.preventDefault();
          return;
        case "Enter":
          if (results[highlight]) pick(results[highlight]);
          else runSearch(query);
          e.preventDefault();
          return;
      }
    },
    [results, highlight, pick, runSearch, query],
  );

  return (
    <div className="location-search" ref={rootRef}>
      {!open && (
        <button
          type="button"
          className="location-search-btn"
          onClick={() => setOpen(true)}
          title="Search locations"
          aria-label="Search locations"
        >
          <SearchGlyph />
        </button>
      )}
      {open && (
        <div className="location-search-panel">
          <div className="location-search-inputrow">
            <SearchGlyph />
            <input
              ref={inputRef}
              type="text"
              className="location-search-input"
              placeholder="Search place…"
              value={query}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
            />
            {busy && <span className="loading-indicator" aria-hidden="true" />}
            <button
              type="button"
              className="close-btn"
              onClick={() => setOpen(false)}
              aria-label="Close search"
            >
              &times;
            </button>
          </div>
          {error && (
            <div className="location-search-empty">Search failed</div>
          )}
          {!error && results.length === 0 && query.trim().length >= 2 && !busy && (
            <div className="location-search-empty">No matches</div>
          )}
          {results.length > 0 && (
            <ul className="location-search-results" role="listbox">
              {results.map((r, i) => (
                <li key={`${r.placeName}-${i}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === highlight}
                    className={`location-search-result${
                      i === highlight ? " active" : ""
                    }`}
                    onPointerEnter={() => setHighlight(i)}
                    onClick={() => pick(r)}
                  >
                    <span className="location-search-result-name">
                      {r.text}
                    </span>
                    <span className="location-search-result-detail">
                      {[
                        r.kind,
                        r.placeName.startsWith(`${r.text}, `)
                          ? r.placeName.slice(r.text.length + 2)
                          : r.placeName,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SearchGlyph() {
  return (
    <svg
      className="location-search-glyph"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="6.5"
        cy="6.5"
        r="4.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <line
        x1="10.2"
        y1="10.2"
        x2="14.2"
        y2="14.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
