"use client";

import { useEffect } from "react";
import { getMainMap } from "@/lib/compare/bridge";
import {
  addFieldsLayers,
  bindFieldsInteractions,
  syncFieldsMap,
} from "@/lib/fields/mapBridge";
import { useFieldsStore } from "@/store/useFieldsStore";

/**
 * Keeps the fields map layers in sync with the fields store. Layer creation
 * on style.load is owned by MapCanvas.addAppLayers → addFieldsLayers; this
 * component only pushes data/visibility/paint after store mutations. Pointer
 * emphasis (hover feature-state) is bound once per map instance here.
 */
export default function FieldsMapController() {
  const fields = useFieldsStore((s) => s.fields);
  const pattern = useFieldsStore((s) => s.pattern);
  const visible = useFieldsStore((s) => s.visible);
  const selectedFieldId = useFieldsStore((s) => s.selectedFieldId);
  const colorBy = useFieldsStore((s) => s.colorBy);
  const renderMode = useFieldsStore((s) => s.renderMode);
  const filterClasses = useFieldsStore((s) => s.filterClasses);

  useEffect(() => {
    const map = getMainMap();
    if (!map) return;
    try {
      // Re-ensure layers exist (style may have reloaded without addAppLayers
      // completing yet); no-op when the source is already present beyond sync.
      if (!map.getSource("fields-boundaries")) addFieldsLayers(map);
      else syncFieldsMap(map);
      bindFieldsInteractions(map);
    } catch {
      // Map disposed mid-sync.
    }
  }, [fields, pattern, visible, selectedFieldId, colorBy, renderMode, filterClasses]);

  return null;
}
