/**
 * The visual system: one place for every colour, size and duration.
 *
 * Colour carries meaning here rather than decoration. A request keeps the same
 * hue from arrival to completion, so the eye can follow one through the system,
 * and the palette's three signal colours mean exactly one thing each — accent
 * for healthy flow, warn for pressure, danger for loss.
 */

/**
 * Read a design token from the stylesheet.
 *
 * The canvas cannot use CSS, so its colours have to exist in JavaScript — but
 * duplicating the hex values here would give the project two palettes that
 * drift apart the first time one is edited. This reads the real custom
 * properties instead, leaving `style.css` the single source of truth.
 *
 * The fallback covers the test environment, where there is no document.
 */
function token(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

export const theme = {
  colour: {
    bg: token("--bg", "#0B0F14"),
    panel: token("--panel", "#11161D"),
    panelRaised: token("--panel-raised", "#161C25"),
    line: token("--line", "#1F2833"),
    lineStrong: token("--line-strong", "#2C3846"),

    text: token("--text", "#E6EDF3"),
    textMuted: token("--text-muted", "#8B98A8"),
    textFaint: token("--text-faint", "#77869A"),

    accent: token("--accent", "#22D3EE"),
    accentDim: token("--accent-dim", "#0E7490"),
    good: "#34D399",
    warn: "#FBBF24",
    danger: token("--danger", "#F87171"),
    violet: "#A78BFA",

    /**
     * Tenants get distinct hues so weighted fair queueing is legible at a
     * glance. Chosen far apart in hue and close in lightness, so no tenant
     * looks more important than another.
     */
    tenants: ["#22D3EE", "#A78BFA", "#F472B6", "#FBBF24", "#34D399"],
  },

  radius: { sm: 3, md: 6, lg: 10 },
  space: (n: number) => n * 8,

  font: {
    mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },

  /**
   * Motion durations. Deliberately short: this UI animates continuously, and
   * anything slower than ~200 ms reads as lag rather than as animation.
   */
  motion: { fast: 120, base: 200, slow: 320 },
} as const;

/** Colour a latency value against its budget: green → amber → red. */
export function latencyColour(seconds: number, budget: number): string {
  const ratio = budget === 0 ? 0 : seconds / budget;
  if (ratio < 0.5) return theme.colour.good;
  if (ratio < 1) return theme.colour.warn;
  return theme.colour.danger;
}

/** Colour offered load: the interesting threshold is 1.0, not 100% CPU. */
export function loadColour(load: number): string {
  if (load < 0.7) return theme.colour.good;
  if (load < 1) return theme.colour.warn;
  return theme.colour.danger;
}

export function tenantColour(tenant: number): string {
  const palette = theme.colour.tenants;
  return palette[tenant % palette.length];
}

/** Format a duration for display, choosing a unit that keeps 3 significant figures. */
export function formatDuration(seconds: number): string {
  if (seconds === 0) return "0";
  if (seconds < 0.001) return `${(seconds * 1e6).toFixed(0)}µs`;
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
  if (seconds < 10) return `${seconds.toFixed(2)}s`;
  return `${seconds.toFixed(1)}s`;
}

export function formatRate(perSecond: number): string {
  if (perSecond >= 1000) return `${(perSecond / 1000).toFixed(1)}k/s`;
  if (perSecond >= 10) return `${perSecond.toFixed(0)}/s`;
  return `${perSecond.toFixed(1)}/s`;
}
