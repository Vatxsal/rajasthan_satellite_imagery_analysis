/**
 * Gemini prompt plumbing for the optional AI summary.
 * STRICT boundary: only whitelisted, already-computed numbers leave the app
 * (never raw pixels — the optional preview images are fixed ≤768 px JPEGs the
 * server renders itself; never user data). The model EXPLAINS the deterministic
 * statistics — it never computes or invents them.
 */
import { z } from "zod";
import { classLabel } from "./config";
import type { CompareStats, SummaryLanguage } from "./types";

export const SUMMARY_MODEL_FALLBACK = "gemini-3.8-flash";

export type { SummaryLanguage };

/** Structured output contract (UI + tests use the zod shape, Gemini the JSON schema). */
export const SUMMARY_SYSTEM_PROMPT = `You are a geospatial analyst writing a short plain-language briefing about detected land-surface changes between two Sentinel-2 scenes over Rajasthan, India.

You receive ONLY pre-computed statistics from a deterministic raster analysis, and optionally three small preview images (date A true colour, date B true colour, and the classified change overlay). Explain the numbers clearly - never compute, estimate, or invent additional figures, places, or causes not present in the input.

Output rules:
- Respond with a single JSON object matching the requested schema and nothing else.
- overview: 60-90 words, plain language a general reader understands. Lead with what changed most, then where (name tehsils and hotspots from the input). Quote the dates exactly as given. If the input says change is negligible, say plainly that no significant change was detected at the current sensitivity settings and mention the thresholds that were applied. End overview with exactly this sentence: "AI-generated summary - verify against the maps."
- keyChanges: 2-5 short bullet strings using only the exact class labels and areas (hectares) provided. Do not convert units or round beyond the given values.
- whereChangesOccurred: 2-5 short bullet strings naming tehsils/hotspots from the input; if none were given, state where change was detected in general terms from the provided bbox context only.
- visualObservations: 2-5 short bullet strings based ONLY on the supplied images (texture, colour contrasts, patch shapes, clouds). If no images were supplied, return exactly one item: "No imagery was supplied for this request."
- reliabilityAndCaveats: 1-4 short bullet strings; mention valid-data percentage when it is below 70 and that clouds or partial coverage reduce confidence; always note that thresholds and minimum patch size filter what is shown.
- suggestedNextChecks: 1-4 short bullet strings of practical follow-ups (re-check with another date pair, raise/lower sensitivity, open the hotspot in a GIS, compare with field reports).
- Every list must contain at least one item. Neutral factual tone: no alarm, no praise, no policy advice, no causes you were not given. No markdown, no code, no emoji in the string values.

Language:
- When the request says language=en, write all string values in English.
- When the request says language=hi, write all string values in Hindi using the Devanagari script (keep class labels, dates and numbers exactly as provided).`;

/** Gemini REST responseSchema (OpenAPI-style subset) mirroring summaryOutputSchema. */
export const SUMMARY_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    overview: { type: "STRING" },
    keyChanges: { type: "ARRAY", items: { type: "STRING" } },
    whereChangesOccurred: { type: "ARRAY", items: { type: "STRING" } },
    visualObservations: { type: "ARRAY", items: { type: "STRING" } },
    reliabilityAndCaveats: { type: "ARRAY", items: { type: "STRING" } },
    suggestedNextChecks: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: [
    "overview",
    "keyChanges",
    "whereChangesOccurred",
    "visualObservations",
    "reliabilityAndCaveats",
    "suggestedNextChecks",
  ],
  propertyOrdering: [
    "overview",
    "keyChanges",
    "whereChangesOccurred",
    "visualObservations",
    "reliabilityAndCaveats",
    "suggestedNextChecks",
  ],
};

const stringList = z.array(z.string().min(1).max(500)).min(1).max(8);

/** Validated shape of the summary the UI receives. */
export const summaryOutputSchema = z.object({
  overview: z.string().min(1).max(4000),
  keyChanges: stringList,
  whereChangesOccurred: stringList,
  visualObservations: stringList,
  reliabilityAndCaveats: stringList,
  suggestedNextChecks: stringList,
});

export type SummaryOutput = z.infer<typeof summaryOutputSchema>;

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

/** Language directive prepended to the user turn (keeps the stats text verbatim). */
export function summaryLanguageLine(language: SummaryLanguage): string {
  return `language=${language}`;
}

/** Note appended to the prompt when the three preview images are attached. */
export const SUMMARY_IMAGES_NOTE =
  "Attached images, in order: (1) date A true colour, (2) date B true colour, (3) classified change overlay on date B. Base your visualObservations only on them.";
