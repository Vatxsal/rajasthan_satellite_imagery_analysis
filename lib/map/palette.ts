import type { ThemeId } from "@/store/useTheme";

/**
 * Map overlay colors, mirrored from the CSS design tokens
 * (see app/globals.css). MapLibre paints cannot read CSS variables,
 * so each theme keeps an explicit palette here.
 */
export interface MapPalette {
  accent: string;
  accentFillOpacity: number;
  text: string;
  textMuted: string;
}

export const MAP_PALETTES: Record<ThemeId, MapPalette> = {
  light: {
    accent: "#C2410C",
    accentFillOpacity: 0.1,
    text: "#1B1D22",
    textMuted: "#6B6E76",
  },
  dark: {
    accent: "#F0713A",
    accentFillOpacity: 0.1,
    text: "#E8E6E1",
    textMuted: "#9A9DA6",
  },
};

/**
 * Boundary line colors per theme. The basemap style itself is never swapped
 * (it stays the light Positron style), so dark mode draws light-coloured
 * boundary lines with a dark casing beneath — that keeps effective contrast
 * against both the light basemap and satellite imagery. Light mode keeps the
 * original flat look (casing width 0).
 *
 * NOTE: MapLibre has no `line-halo-*` paint properties (halos only exist on
 * symbol layers as `text-halo-*`), so `haloColor`/`haloWidth` are rendered as
 * a separate wider "casing" line layer stacked directly under each line.
 */
export interface BoundaryLineStyle {
  color: string;
  haloColor: string;
  haloWidth: number;
  width: number;
}

export interface BoundaryLineTheme {
  districts: BoundaryLineStyle;
  tehsils: BoundaryLineStyle;
  ilrs: BoundaryLineStyle;
  /** Subtle state-wide outline, shown only in the "All Rajasthan" view. */
  state: BoundaryLineStyle;
}

export const BOUNDARY_LINE_THEMES: Record<ThemeId, BoundaryLineTheme> = {
  light: {
    districts: { color: "#1B1D22", haloColor: "#FFFFFF", haloWidth: 0, width: 1.5 },
    tehsils: { color: "#1B1D22", haloColor: "#FFFFFF", haloWidth: 0, width: 1 },
    ilrs: { color: "#6B6E76", haloColor: "#FFFFFF", haloWidth: 0, width: 1 },
    state: { color: "#6B6E76", haloColor: "#FFFFFF", haloWidth: 0, width: 2 },
  },
  dark: {
    districts: { color: "#E8E6E1", haloColor: "#14151A", haloWidth: 3, width: 1.5 },
    tehsils: { color: "#9A9DA6", haloColor: "#14151A", haloWidth: 2.5, width: 1 },
    ilrs: { color: "#9A9DA6", haloColor: "#14151A", haloWidth: 2.5, width: 1 },
    state: { color: "#6B6E76", haloColor: "#14151A", haloWidth: 0, width: 2 },
  },
};
