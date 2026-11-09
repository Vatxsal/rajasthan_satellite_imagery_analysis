/**
 * Fixture data for the report template: used by `npm run email:preview`
 * (writes .email-preview/*.html) and `npm run email:test` (sends one
 * through the configured provider to EMAIL_TEST_RECIPIENT).
 */
import jpeg from "jpeg-js";
import { CLASS_DEFS } from "../../analysis/config";
import type { SummaryData } from "../../analysis/types";
import type { ReportSourceInput, ReportStatsSource } from "./data";

export const DEEP_LINK =
  "http://localhost:3000/?a=t-jaipur-bassi&l=tehsil&A=2026-10-10&B=2026-10-25&s=medium&m=0.2&im=composite&tab=events";
export const SITE_URL = "http://localhost:3000";

export function solidJpegBuffer(width: number, height: number, rgb: [number, number, number]): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  }
  return jpeg.encode({ data, width, height }, 70).data;
}

export function solidJpegDataUri(width: number, height: number, rgb: [number, number, number]): string {
  return `data:image/jpeg;base64,${solidJpegBuffer(width, height, rgb).toString("base64")}`;
}

const CONFIDENCE = ["high", "medium", "low"] as const;

function makeFeature(index: number, place: string): GeoJSON.Feature {
  const def = CLASS_DEFS[index % 5];
  const id = `ev_${(0x1a2b3c00 + index * 97)
    .toString(16)
    .slice(0, 8)
    .padStart(8, "0")}`;
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [75.7123 + index * 0.011, 26.8531 - index * 0.009] },
    properties: {
      id,
      label: def.label,
      classCode: def.code,
      classLabel: def.label,
      areaHa: Math.round((8.4 + index * 23.7) * 10) / 10,
      centroid: [75.7123 + index * 0.011, 26.8531 - index * 0.009],
      bbox: [75.7, 26.84, 75.73, 26.86],
      confidence: CONFIDENCE[index % 3],
      tehsilName: place,
      subLabel: index % 4 === 0 ? "Likely harvest / crop cycle" : null,
      tags: index % 4 === 0 ? ["crop-cycle"] : [],
    },
  };
}

function normalStats(): ReportStatsSource {
  const changeDefs = CLASS_DEFS.filter((def) => def.change);
  const areas = [64.2, 41.8, 298.5, 55.1, 27.1];
  return {
    classes: changeDefs.map((def, index) => {
      const areaHa = areas[index];
      return {
        code: def.code,
        label: def.label,
        color: def.color,
        pixels: Math.round(areaHa * 100),
        areaHa,
        areaKm2: areaHa / 100,
        pctOfValid: (areaHa / 4820) * 100,
      };
    }),
    validPct: 96.2,
    validHa: 4820,
    changedHa: 486.7,
    tehsils: [
      { tehsilId: "t-jaipur-bassi", name: "Bassi", pixelsByClass: { 2: 21000 }, changedHa: 186.4, validPixels: 400000, insidePixels: 420000 },
      { tehsilId: "t-jaipur-amber", name: "Amber", pixelsByClass: { 2: 12000 }, changedHa: 121.9, validPixels: 300000, insidePixels: 310000 },
      { tehsilId: "t-jaipur-ku", name: "Kotputli", pixelsByClass: { 3: 8000 }, changedHa: 88.2, validPixels: 250000, insidePixels: 260000 },
      { tehsilId: "t-jaipur-chomu", name: "Chomu", pixelsByClass: { 5: 5000 }, changedHa: 54.7, validPixels: 200000, insidePixels: 210000 },
      { tehsilId: "t-jaipur-jhotwara", name: "Jhotwara", pixelsByClass: { 1: 3000 }, changedHa: 35.5, validPixels: 180000, insidePixels: 185000 },
      { tehsilId: "t-jaipur-sanganer", name: "Sanganer", pixelsByClass: { 3: 2000 }, changedHa: 22.1, validPixels: 150000, insidePixels: 155000 },
    ],
    eventsTotal: 214,
  };
}

function zeroStats(): ReportStatsSource {
  return {
    classes: [],
    validPct: 94.8,
    validHa: 4820,
    changedHa: 0,
    tehsils: [],
    eventsTotal: 0,
  };
}

const SUMMARY_EN: SummaryData = {
  overview:
    "Between 10 and 25 October 2026, 486.7 ha of change was detected across the area — mostly vegetation loss consistent with kharif harvest and a few bare/built-up expansions.",
  keyChanges: [
    "Vegetation loss dominated: 298.5 ha (61% of changed area).",
    "A 55 ha bare/built-up patch appeared east of the main track.",
  ],
  whereChangesOccurred: [
    "North-west of Bassi town, along the canal strip",
    "Scattered fields south of the Amber road",
  ],
  visualObservations: [
    "Brown, harvested fields replace green canopy between the two dates.",
    "Reservoir edge shrank slightly (water loss 41.8 ha).",
  ],
  reliabilityAndCaveats: [
    "12% of the area was cloud-masked on 25 October.",
    "Confidence tiers mark pixels with a persistent signal only.",
  ],
  suggestedNextChecks: [
    "Inspect the top patch on the live map with its link.",
    "Re-run when the next cloud-free scene arrives.",
  ],
};

const SUMMARY_HI: SummaryData = {
  overview:
    "10 से 25 अक्तूबर 2026 के बीच क्षेत्र में 486.7 हे. परिवर्तन मिला — अधिकतर वनस्पति हानि, जो खरीफ कटाई से मेल खाती है, और कुछ नंगा/निर्माण विस्तार।",
  keyChanges: [
    "वनस्पति हानि प्रमुख: 298.5 हे. (परिवर्तन का 61%)।",
    "मुख्य मार्ग के पूर्व में 55 हे. का नंगा/निर्माण पैच।",
  ],
  whereChangesOccurred: [
    "बासी शहर के उत्तर-पश्चिम, नहर पट्टी के साथ",
    "आमेर सड़क के दक्षिण में बिखरे खेत",
  ],
  visualObservations: ["दोनों तिथियों में हरा कैनोपी भूरे कटे खेतों से बदला।"],
  reliabilityAndCaveats: [
    "25 अक्तूबर को क्षेत्र का 12% बादल-मास्क था।",
    "विश्वास स्तर केवल स्थायी संकेत वाले पिक्सल दर्शाते हैं।",
  ],
  suggestedNextChecks: ["लाइव नक्शे पर शीर्ष पैच देखें।", "अगली स्पष्ट दृश्य पर दोबारा चलाएँ।"],
};

function baseInput(overrides: Partial<ReportSourceInput>): ReportSourceInput {
  return {
    language: "en",
    mode: "open",
    requestedAt: "2026-11-06T10:00:00.000Z",
    areaName: "Bassi",
    areaLevel: "tehsil",
    dateA: "2026-10-10",
    dateB: "2026-10-25",
    gapDays: 15,
    sensitivity: "medium",
    minPatchHa: 0.2,
    inputMode: "composite",
    rules: "legacy",
    stats: normalStats(),
    events: Array.from({ length: 10 }, (_, index) =>
      makeFeature(index, index % 3 === 0 ? "Bassi" : "Amber"),
    ),
    summary: SUMMARY_EN,
    includeSummary: true,
    summaryUnavailable: false,
    image: {
      src: solidJpegDataUri(700, 500, [122, 130, 140]),
      width: 700,
      height: 500,
      alt: "Change map",
    },
    deepLink: DEEP_LINK,
    siteUrl: SITE_URL,
    generatedAt: "2026-11-05T09:30:00.000Z",
    ...overrides,
  };
}

export interface ReportFixture {
  name: string;
  input: ReportSourceInput;
}

export function buildFixtures(): ReportFixture[] {
  return [
    { name: "all-events", input: baseInput({}) },
    {
      name: "zero-events",
      input: baseInput({
        areaName: "Ganganagar",
        areaLevel: "district",
        stats: zeroStats(),
        events: [],
        summary: {
          ...SUMMARY_EN,
          overview: "No significant change survived the thresholds for this date pair.",
          keyChanges: [],
        },
      }),
    },
    {
      name: "long-names",
      input: baseInput({
        areaName:
          "Pindwara–Shivpura Integrated Land Reclamation Block (Phase II, includes Revdar and Kankroli extensions)",
        events: [
          makeFeature(1, "Rajsamand–Nathdwara–Kankroli–Sukhet–Ghata Rajsamand belt"),
          makeFeature(2, "A very long tehsil name that should truncate gracefully in the table cell"),
          ...Array.from({ length: 8 }, (_, index) => makeFeature(index + 3, "Bassi")),
        ],
        stats: {
          ...normalStats(),
          validHa: 184220.5,
          changedHa: 12486.9,
          tehsils: normalStats().tehsils!.map((row, index) => ({
            ...row,
            name:
              index === 0
                ? "Kankroli (including Sukhet and Ghata revenue circles)"
                : row.name,
            changedHa: row.changedHa * 10,
          })),
        },
      }),
    },
    {
      name: "hindi",
      input: baseInput({
        language: "hi",
        summary: SUMMARY_HI,
      }),
    },
    {
      name: "no-summary",
      input: baseInput({
        summary: null,
        summaryUnavailable: true,
      }),
    },
    {
      name: "no-image",
      input: baseInput({
        image: null,
      }),
    },
    {
      name: "fixed-mode",
      input: baseInput({
        mode: "fixed",
      }),
    },
    {
      name: "fixed-mode-hindi",
      input: baseInput({
        mode: "fixed",
        language: "hi",
        summary: SUMMARY_HI,
      }),
    },
    {
      name: "fused-evidence",
      input: baseInput({
        rules: "fused",
        evidence: {
          s1: { orbit: "ASC" },
          s1WindowDays: 6,
          worldCover: true,
          terrain: true,
          demInstance: "COPERNICUS_30",
        },
      }),
    },
  ];
}
