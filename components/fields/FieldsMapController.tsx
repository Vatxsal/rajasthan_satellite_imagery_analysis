"use client";

import { useEffect } from "react";
import { getMainMap } from "@/lib/compare/bridge";
import { addFieldsLayers, syncFieldsMap } from "@/lib/fields/mapBridge";
import { useFieldsStore } from "@/store/useFieldsStore";

/**
 * Keeps the fields map layers in sync with the fields store. Layer creation
 * on style.load is owned by MapCanvas.addAppLayers → addFieldsLayers; this
 * component only pushes data/visibility/paint after store mutations.
 */
export default function FieldsMapController() {
  const fields = useFieldsStore((s) => s.fields);
  const pattern = useFieldsStore((s) => s.pattern);
  const visible = useFieldsStore((s) => s.visible);
  const selectedFieldId = useFieldsStore((s) => s.selectedFieldId);

  useEffect(() => {
    const map = getMainMap();
    if (!map) return;
    try {
      // Re-ensure layers exist (style may have reloaded without addAppLayers
      // completing yet); no-op when the source is already present beyond sync.
      if (!map.getSource("fields-boundaries")) addFieldsLayers(map);
      else syncFieldsMap(map);
    } catch {
      // Map disposed mid-sync.
    }
  }, [fields, pattern, visible, selectedFieldId]);

  return null;
}
