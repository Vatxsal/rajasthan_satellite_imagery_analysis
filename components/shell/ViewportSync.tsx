"use client";

import { useVisualViewport } from "@/lib/hooks/useVisualViewport";

/** Mounts the visualViewport → CSS var sync (keyboard-aware sheets/dialogs). */
export default function ViewportSync() {
  useVisualViewport();
  return null;
}
