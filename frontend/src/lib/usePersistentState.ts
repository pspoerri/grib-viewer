import { useEffect, useState } from "react";

// usePersistentState wraps useState with localStorage-backed
// persistence. Used for user preferences that should survive a reload
// (time format, unit overrides). Invalid JSON or storage failures
// silently fall back to the initial value rather than crash — the
// preference is a comfort-feature, not a correctness requirement.
export function usePersistentState<T>(
  key: string,
  initial: T,
  validate?: (raw: unknown) => raw is T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved === null) return initial;
      const parsed = JSON.parse(saved);
      if (validate && !validate(parsed)) return initial;
      return parsed as T;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full, disabled, or private mode — ignore.
    }
  }, [key, value]);

  return [value, setValue];
}
