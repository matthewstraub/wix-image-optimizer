import { useEffect, useState } from "react";
import {
  applyTheme,
  readPreference,
  savePreference,
  watchSystem,
  type ThemePreference,
} from "../lib/theme";

const OPTIONS: Array<{ id: ThemePreference; label: string; title: string }> = [
  { id: "light", label: "Light", title: "Always light" },
  { id: "system", label: "Auto", title: "Follow the system setting" },
  { id: "dark", label: "Dark", title: "Always dark" },
];

export default function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(readPreference);

  useEffect(() => {
    applyTheme(preference);
    savePreference(preference);
  }, [preference]);

  // Only relevant while on "system"; an explicit choice should survive the
  // user flipping their desktop theme.
  useEffect(() => {
    if (preference !== "system") return;
    return watchSystem(() => applyTheme("system"));
  }, [preference]);

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="inline-flex rounded-lg border border-neutral-200 p-0.5 dark:border-neutral-800"
    >
      {OPTIONS.map(option => {
        const active = option.id === preference;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            onClick={() => setPreference(option.id)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              active
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
