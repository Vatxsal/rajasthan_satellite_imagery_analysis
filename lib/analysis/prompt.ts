/**
 * Gemini prompt plumbing for the optional AI summary.
 * STRICT boundary: only whitelisted, already-computed numbers leave the app
 * (never imagery, never raw pixels, never user data). The model EXPLAINS the
 * deterministic statistics — it never computes or invents them.
 */
import { classLabel } from "./config";
import type { CompareStats } from "./types";

export const SUMMARY_MODEL_FALLBACK = "gemini-3.8-flash";

export const SUMMARY_SYSTEM_PROMPT = `You are a geospatial analyst writing a short plain-language briefing about detected land-surface changes between two Sentinel-2 scenes over Rajasthan, India.

You receive ONLY pre-computed statistics from a deterministic raster analysis. Your job is to explain those numbers clearly - never compute, estimate, or invent additional figures, places, or causes not present in the input.

Rules:
- 180 words maximum, plain language a general reader understands.
- Lead with what changed most, then where (name tehsils and hotspots from the input).
- Quote the dates exactly as given; mention the valid-data percentage when it is below 70 and note that clouds or partial coverage reduce confidence.
- Use only the exact class labels and areas provided (hectares). Do not convert units or round beyond the given values.
- If the input says change is negligible, say plainly that no significant change was detected at the current sensitivity settings, and mention the thresholds that were applied.
- Neutral factual tone: no alarm, no praise, no policy advice, no causes you were not given.
- Plain short lines are fine; no markdown tables, no code, no emoji.
- End with exactly this sentence on its own line: AI-generated summary - verify against the maps.`;

/** Whitelisted, size-bounded prompt for one summary request. */
export function buildSummaryPrompt(stats: CompareStats): string {
  const m = stats.metadata;
  const lines: string[] = [];

  lines.push(`Area: ${m.areaName} (${m.areaLevel} level)`);
  lines.push(`Dates: A ${m.dateA} to B ${m.dateB} (${m.gapDays} days apart)`);
  lines.push(
    `Resolution: ${m.metersPerPixel.toFixed(1)} m/pixel${m.coarse ? " (coarser than native 10 m because the area is large)" : ""}`,
  );
  lines.push(`Valid data: ${stats.validPct.toFixed(1)}% of the area is analysable`);
  lines.push(`Area: ${stats.areaHa.toFixed(1)} ha total, ${stats.validHa.toFixed(1)} ha analysable`);
  lines.push(`Detected change: ${stats.changedHa.toFixed(1)} ha (negligible: ${stats.negligible ? "yes" : "no"})`);
  lines.push(
    `Sensitivity: ${m.sensitivity} (thresholds: |dNDVI| >= ${Math.abs(m.thresholds.vegGainDNdvi).toFixed(2)}, |dMNDWI| >= ${Math.abs(m.thresholds.waterGainDMndwi).toFixed(2)}, dNDBI >= ${m.thresholds.bareBuiltDNdbi.toFixed(2)}, minimum patch ${m.minPatchHa} ha)`,
  );

  lines.push("", "Change classes (area and share of analysable area):");
  for (const cls of stats.classes) {
    if (cls.code === 0) {
      lines.push(`- ${cls.label}: ${cls.areaHa.toFixed(1)} ha (${cls.pctOfValid.toFixed(1)}%)`);
    } else if (cls.code !== 6 && cls.pixels > 0) {
      lines.push(`- ${cls.label}: ${cls.areaHa.toFixed(1)} ha (${cls.pctOfValid.toFixed(1)}%)`);
    } else if (cls.code === 6 && cls.pixels > 0) {
      lines.push(`- ${cls.label}: ${cls.areaHa.toFixed(1)} ha (excluded from shares)`);
    }
  }

  if (stats.tehsils && stats.tehsils.length > 0) {
    const rows = [...stats.tehsils]
      .sort((x, y) => y.changedHa - x.changedHa)
      .slice(0, 15);
    lines.push("", "Per-tehsil breakdown (hectares of change, largest first):");
    for (const row of rows) {
      const dominant = Object.entries(row.pixelsByClass)
        .sort((x, y) => y[1] - x[1])
        .map(([code]) => classLabel(Number(code)))[0];
      lines.push(`- ${row.name}: ${row.changedHa.toFixed(1)} ha${dominant ? ` (mostly ${dominant})` : ""}`);
    }
    if (stats.tehsils.length > rows.length) {
      lines.push(`- ... and ${stats.tehsils.length - rows.length} more tehsils with smaller changes`);
    }
  }

  if (stats.hotspots.length > 0) {
    lines.push("", "Top hotspots (largest patches):");
    for (const h of stats.hotspots.slice(0, 10)) {
      lines.push(
        `- ${h.classLabel}: ${h.areaHa.toFixed(1)} ha near ${h.tehsilName ?? "area centre"} at ${h.centroid[1].toFixed(4)}N ${h.centroid[0].toFixed(4)}E`,
      );
    }
  }

  return lines.join("\n");
}
