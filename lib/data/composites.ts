import type { CompositeId } from "./types";

export interface CompositeOption {
  id: CompositeId;
  label: string;
  hint: string;
}

/** Band / composite presets. UI-only for now (no rendering pipeline yet). */
export const COMPOSITE_OPTIONS: CompositeOption[] = [
  {
    id: "true-color",
    label: "True colour (RGB)",
    hint: "Natural appearance — 4/3/2 or B4/B3/B2",
  },
  {
    id: "false-color",
    label: "False colour (CIR)",
    hint: "Vegetation in red — NIR/R/G",
  },
  {
    id: "ndvi",
    label: "NDVI (preview)",
    hint: "Vegetation index — UI placeholder only",
  },
];
