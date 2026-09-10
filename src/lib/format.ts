/** Presentation helpers shared across the UI. */

export function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function percentSaved(before: number, after: number): string {
  if (before <= 0) return "—";
  return `${Math.round(((before - after) / before) * 100)}%`;
}

export function dimensions(w: number, h: number): string {
  return `${w}×${h}`;
}

export function megapixels(n: number): string {
  return `${n.toFixed(n < 10 ? 1 : 0)} MP`;
}

export function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}
