/**
 * Light/dark theming.
 *
 * Defaults to whatever the OS is set to, with an explicit override the user
 * can pick and that persists.
 *
 * Tailwind's `dark:` variant normally compiles to a `prefers-color-scheme`
 * media query, which cannot be overridden from JavaScript. index.css
 * redefines it as a class selector instead, so the single source of truth is
 * the `dark` class on <html> — set here.
 *
 * `color-scheme` is set alongside it, and that part matters: it is what tells
 * the browser to render native controls in the right theme. Without it the
 * range sliders and select menus in the Advanced panel stay light while
 * everything around them goes dark.
 */

export type ThemePreference = "light" | "dark" | "system";

export const THEME_KEY = "wix-image-optimizer:theme";

const isPreference = (value: unknown): value is ThemePreference =>
  value === "light" || value === "dark" || value === "system";

export function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return isPreference(stored) ? stored : "system";
  } catch {
    // Safari in private mode throws on localStorage access.
    return "system";
  }
}

export function systemPrefersDark(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** The theme actually in force, once "system" is resolved. */
export function resolveTheme(preference: ThemePreference): "light" | "dark" {
  if (preference === "system") return systemPrefersDark() ? "dark" : "light";
  return preference;
}

export function applyTheme(preference: ThemePreference): void {
  const resolved = resolveTheme(preference);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

export function savePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, preference);
  } catch {
    // Non-fatal: the theme still applies for this session.
  }
}

/**
 * Re-apply when the OS flips, but only while the preference is "system" —
 * an explicit choice should survive the user switching their desktop theme.
 * Returns an unsubscribe function.
 */
export function watchSystem(onChange: () => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const query = matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
