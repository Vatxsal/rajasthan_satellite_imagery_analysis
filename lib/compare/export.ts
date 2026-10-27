import type { CompareStats, Hotspot, TehsilZonalStat } from "@/lib/analysis/types";
import { CLASS_BY_CODE, classLabel } from "@/lib/analysis/config";

/**
 * Client-side exports for a completed comparison: overlay files come from the
 * overlay route; CSV / GeoJSON are built from the stats the analyze stream
 * already delivered (no extra server work).
 */

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function saveText(text: string, filename: string, mime: string): void {
  saveBlob(new Blob([text], { type: mime }), filename);
}

/** change_<dateA>_<dateB>.png | .tif — same naming as the overlay route. */
export async function downloadOverlayFile(
  overlayUrl: string,
  format: "png" | "geotiff",
  dates: { dateA: string; dateB: string },
): Promise<void> {
  const separator = overlayUrl.includes("?") ? "&" : "?";
  const response = await fetch(`${overlayUrl}${separator}format=${format}`);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? "The change map file is unavailable. Run the analysis again.");
  }
  const blob = await response.blob();
  saveBlob(blob, `change_${dates.dateA}_${dates.dateB}.${format === "png" ? "png" : "tif"}`);
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function dominantClass(row: TehsilZonalStat): string {
  let bestCode = -1;
  let bestPixels = 0;
  for (const key of Object.keys(row.pixelsByClass)) {
    const code = Number(key);
    const def = CLASS_BY_CODE[code];
    if (!def?.change) continue;
    const pixels = row.pixelsByClass[code] ?? 0;
    if (pixels > bestPixels) {
      bestPixels = pixels;
      bestCode = code;
    }
  }
  return bestCode >= 0 && bestPixels > 0 ? classLabel(bestCode) : "—";
}

/** Full statistics dump: metadata, totals, classes, tehsils, hotspots. */
export function buildStatsCsv(stats: CompareStats): string {
  const { metadata } = stats;
  const rows: Array<Array<string | number>> = [
    ["Change detection statistics"],
    ["Area", metadata.areaName],
    ["Level", metadata.areaLevel],
    ["Date A (earlier)", metadata.dateA],
    ["Date B (later)", metadata.dateB],
    ["Gap (days)", metadata.gapDays],
    ["Sensitivity", metadata.sensitivity],
    ["Minimum patch (ha)", metadata.minPatchHa],
    ["Resolution (m/px)", metadata.metersPerPixel],
    ["Coarse grid", metadata.coarse ? "yes" : "no"],
    ["Valid data (%)", stats.validPct],
    ["Analysed area (ha)", stats.areaHa],
    ["Valid area (ha)", stats.validHa],
    ["Changed area (ha)", stats.changedHa],
    ["Negligible change", stats.negligible ? "yes" : "no"],
    ["Generated", metadata.generatedAt],
    [],
    ["Class", "Code", "Area (ha)", "Area (km2)", "% of valid"],
    ...stats.classes.map((cls) => [cls.label, cls.code, cls.areaHa, cls.areaKm2, cls.pctOfValid]),
  ];

  if (stats.tehsils && stats.tehsils.length > 0) {
    rows.push([], ["Tehsil", "Changed (ha)", "Dominant change", "Valid pixels", "Inside pixels"]);
    for (const row of stats.tehsils) {
      rows.push([row.name, row.changedHa, dominantClass(row), row.validPixels, row.insidePixels]);
    }
  }

  if (stats.hotspots.length > 0) {
    rows.push([], ["Hotspot", "Class", "Area (ha)", "Tehsil", "Centroid lon", "Centroid lat"]);
    stats.hotspots.forEach((hotspot, index) => {
      rows.push([
        index + 1,
        hotspot.classLabel,
        hotspot.areaHa,
        hotspot.tehsilName ?? "",
        hotspot.centroid[0],
        hotspot.centroid[1],
      ]);
    });
  }

  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function downloadStatsCsv(stats: CompareStats): void {
  const { dateA, dateB } = stats.metadata;
  saveText(buildStatsCsv(stats), `change_${dateA}_${dateB}_stats.csv`, "text/csv;charset=utf-8");
}

/** Top-10 hotspots as a GeoJSON FeatureCollection (point + bbox props). */
export function buildHotspotsGeoJson(stats: CompareStats): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = stats.hotspots.map((hotspot: Hotspot, index) => ({
    type: "Feature",
    properties: {
      rank: index + 1,
      classCode: hotspot.classCode,
      classLabel: hotspot.classLabel,
      areaHa: hotspot.areaHa,
      tehsilName: hotspot.tehsilName,
      bbox: hotspot.bbox.join(" "),
    },
    geometry: { type: "Point", coordinates: hotspot.centroid },
  }));
  return { type: "FeatureCollection", features };
}

export function downloadHotspotsGeoJson(stats: CompareStats): void {
  const { dateA, dateB } = stats.metadata;
  saveText(
    JSON.stringify(buildHotspotsGeoJson(stats), null, 2),
    `change_${dateA}_${dateB}_hotspots.geojson`,
    "application/geo+json",
  );
}
