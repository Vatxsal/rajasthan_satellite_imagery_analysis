import assert from "node:assert/strict";
import test from "node:test";
import { summaryCacheKey } from "../lib/cache";
import {
  SUMMARY_IMAGES_NOTE,
  SUMMARY_RESPONSE_SCHEMA,
  SUMMARY_SYSTEM_PROMPT,
  buildSummaryPrompt,
  summaryLanguageLine,
  summaryOutputSchema,
} from "../lib/analysis/prompt";
import { codedError, generateStructuredJson } from "../lib/server/gemini";
import type { CompareStats } from "../lib/analysis/types";

function sampleStats(): CompareStats {
  return {
    metadata: {
      areaName: "Ajmer",
      areaLevel: "district",
      dateA: "2026-08-02",
      dateB: "2026-10-22",
      gapDays: 81,
      sceneA: { date: "2026-08-02", cloudCover: 3.2, satellite: "S2B", tileCount: 4 },
      sceneB: { date: "2026-10-22", cloudCover: 8.1, satellite: "S2A", tileCount: 4 },
      width: 800,
      height: 700,
      metersPerPixel: 10.4,
      coarse: false,
      sensitivity: "medium",
      minPatchHa: 0.2,
      thresholds: {
        waterGainDMndwi: 0.15,
        waterLossDMndwi: -0.15,
        vegLossDNdvi: -0.2,
        vegGainDNdvi: 0.2,
        bareBuiltDNdbi: 0.1,
        bareBuiltDNdviMax: 0.25,
      },
      generatedAt: "2026-10-28T12:00:00.000Z",
    },
    classes: [
      { code: 0, label: "No change", color: [0, 0, 0], pixels: 500000, areaHa: 5000, areaKm2: 50, pctOfValid: 96 },
      { code: 2, label: "Vegetation loss", color: [220, 38, 38], pixels: 12000, areaHa: 120, areaKm2: 1.2, pctOfValid: 2.3 },
    ],
    validPct: 98.5,
    areaHa: 5200,
    validHa: 5122,
    changedHa: 120,
    tehsils: [
      {
        tehsilId: "teh-1",
        name: "Kishangarh",
        pixelsByClass: { 2: 8000 },
        changedHa: 80,
        validPixels: 20000,
        insidePixels: 20500,
      },
    ],
    hotspots: [
      {
        centroid: [74.86, 26.58],
        bbox: [74.85, 26.57, 74.87, 26.59],
        areaHa: 36,
        classCode: 2,
        classLabel: "Vegetation loss",
        tehsilName: "Kishangarh",
        polygon: null,
      },
    ],
    changeBbox: [74.85, 26.57, 74.87, 26.59],
    negligible: false,
  };
}

function validSummaryJson(): string {
  return JSON.stringify({
    overview:
      "Vegetation loss dominated the interval, mostly around Kishangarh. AI-generated summary - verify against the maps.",
    keyChanges: ["Vegetation loss: 120.0 ha (2.3%)"],
    whereChangesOccurred: ["Kishangarh: 80.0 ha"],
    visualObservations: ["No imagery was supplied for this request."],
    reliabilityAndCaveats: ["Valid data 98.5% of the area."],
    suggestedNextChecks: ["Re-check with another date pair."],
  });
}

function geminiResponse(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function baseOptions(fetchFn: typeof fetch) {
  return {
    apiKey: "test-key",
    model: "gemini-test",
    systemInstruction: SUMMARY_SYSTEM_PROMPT,
    prompt: "language=en\n" + buildSummaryPrompt(sampleStats()),
    responseSchema: SUMMARY_RESPONSE_SCHEMA,
    retries: 1,
    retryDelayMs: 0,
    fetchFn,
  };
}

test("summary cache key separates language and image flags", () => {
  const base = { analysisKey: "abc123", language: "en" as const, includeImages: true };
  const same = summaryCacheKey({ ...base });
  assert.equal(same, summaryCacheKey({ ...base }));
  assert.notEqual(same, summaryCacheKey({ ...base, language: "hi" }));
  assert.notEqual(same, summaryCacheKey({ ...base, includeImages: false }));
  assert.notEqual(
    summaryCacheKey({ ...base }),
    summaryCacheKey({ analysisKey: "different", language: "en", includeImages: true }),
  );
  assert.match(same, /^[0-9a-f]{64}$/);
});

test("summary prompt only carries whitelisted stats text", () => {
  const prompt = buildSummaryPrompt(sampleStats());
  assert.match(prompt, /Ajmer/);
  assert.match(prompt, /2026-08-02/);
  assert.match(prompt, /2026-10-22/);
  assert.match(prompt, /Kishangarh/);
  assert.match(prompt, /Vegetation loss: 120\.0 ha/);
  assert.match(prompt, /near Kishangarh/);
  assert.doesNotMatch(prompt, /base64/i);
});

test("system prompt + language + images note contract", () => {
  assert.match(SUMMARY_SYSTEM_PROMPT, /AI-generated summary - verify against the maps\./);
  assert.match(SUMMARY_SYSTEM_PROMPT, /Devanagari/);
  assert.equal(summaryLanguageLine("hi"), "language=hi");
  assert.match(SUMMARY_IMAGES_NOTE, /date A true colour/);
});

test("response schema mirrors the zod shape", () => {
  const parsed = summaryOutputSchema.safeParse({
    overview: "x",
    keyChanges: ["a"],
    whereChangesOccurred: ["b"],
    visualObservations: ["c"],
    reliabilityAndCaveats: ["d"],
    suggestedNextChecks: ["e"],
  });
  assert.equal(parsed.success, true);

  const emptyLists = summaryOutputSchema.safeParse({
    overview: "x",
    keyChanges: [],
    whereChangesOccurred: ["b"],
    visualObservations: ["c"],
    reliabilityAndCaveats: ["d"],
    suggestedNextChecks: ["e"],
  });
  assert.equal(emptyLists.success, false, "empty bullet lists must be rejected");

  const schema = SUMMARY_RESPONSE_SCHEMA as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  assert.deepEqual(
    [...(schema.required ?? [])].sort(),
    [
      "keyChanges",
      "overview",
      "reliabilityAndCaveats",
      "suggestedNextChecks",
      "visualObservations",
      "whereChangesOccurred",
    ].sort(),
  );
  assert.ok(schema.properties?.overview);
});

test("generateStructuredJson parses the nested Gemini envelope", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return geminiResponse(validSummaryJson());
  }) as typeof fetch;
  const value = await generateStructuredJson(baseOptions(fetchFn));
  assert.equal(calls, 1);
  const parsed = summaryOutputSchema.safeParse(value);
  assert.equal(parsed.success, true);
});

test("generateStructuredJson retries a 5xx once then succeeds", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    if (calls === 1) return new Response("busy", { status: 503 });
    return geminiResponse(validSummaryJson());
  }) as typeof fetch;
  const value = await generateStructuredJson(baseOptions(fetchFn));
  assert.equal(calls, 2);
  assert.equal(summaryOutputSchema.safeParse(value).success, true);
});

test("generateStructuredJson maps 429 to AI_RATE_LIMITED and keeps retry-after", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return new Response("slow down", { status: 429, headers: { "retry-after": "30" } });
  }) as typeof fetch;
  await assert.rejects(
    () => generateStructuredJson(baseOptions(fetchFn)),
    (error: Error & { status?: number; code?: string }) => {
      assert.equal(error.code, "AI_RATE_LIMITED");
      assert.equal(error.status, 429);
      assert.match(error.message, /30s/);
      return true;
    },
  );
  assert.equal(calls, 2, "429 is retryable - both attempts used");
});

test("generateStructuredJson: 400 is not retried", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return new Response("bad model", { status: 400 });
  }) as typeof fetch;
  await assert.rejects(
    () => generateStructuredJson(baseOptions(fetchFn)),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "AI_UPSTREAM_ERROR");
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("generateStructuredJson: empty candidates -> AI_BAD_OUTPUT", async () => {
  const fetchFn = (async () => geminiResponse("")) as typeof fetch;
  await assert.rejects(
    () => generateStructuredJson({ ...baseOptions(fetchFn), retries: 0 }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "AI_BAD_OUTPUT");
      return true;
    },
  );
});

test("generateStructuredJson: non-JSON inner text -> AI_BAD_OUTPUT", async () => {
  const fetchFn = (async () => geminiResponse("not-json")) as typeof fetch;
  await assert.rejects(
    () => generateStructuredJson({ ...baseOptions(fetchFn), retries: 0 }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "AI_BAD_OUTPUT");
      return true;
    },
  );
});

test("codedError carries status + code", () => {
  const error = codedError(504, "AI_TIMEOUT", "timed out") as Error & {
    status?: number;
    code?: string;
  };
  assert.equal(error.status, 504);
  assert.equal(error.code, "AI_TIMEOUT");
  assert.equal(error.message, "timed out");
});
