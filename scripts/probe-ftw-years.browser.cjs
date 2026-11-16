/**
 * Untracked probe: which agri-year layers does the live FTW IN_RJ PMTiles
 * archive actually publish? Reads one known-good Rajasthan z13 tile and lists
 * the MVT layer names (fields are keyed by year layer: 2024 / 2025 / …).
 * Run: node .probe-ftw-2026.cjs
 */
require("./.test-build/scripts/alias-hook.js"); // installs the "@/" resolver
const { httpRangeReader, tilesForBbox } = require("./.test-build/lib/fields/query.js");
const { PmtilesReader } = require("./.test-build/lib/fields/pmtiles.js");
const { decodeMvt } = require("./.test-build/lib/fields/mvt.js");

const FTW =
  "https://data.source.coop/ftw/global-data/predictions/vectors/alpha/results-by-admin-conf/admin:country_code=IN/IN_RJ.pmtiles";

(async () => {
  const reader = new PmtilesReader(httpRangeReader(FTW));
  const header = await reader.getHeader();
  console.log("header zoom:", header.minZoom, "→", header.maxZoom);
  const tiles = tilesForBbox([75.76171875, 26.9, 75.8056640625, 26.91], 13);
  console.log("probe tiles:", tiles.length);
  for (const tile of tiles) {
    const bytes = await reader.getTile(13, tile.x, tile.y);
    if (!bytes) {
      console.log(`z13/${tile.x}/${tile.y}: EMPTY`);
      continue;
    }
    const layers = decodeMvt(bytes);
    const summary = [...layers.entries()]
      .map(([name, layer]) => `${name}(${layer.features.length})`)
      .join(", ");
    console.log(`z13/${tile.x}/${tile.y}: ${summary}`);
  }
  const years = new Set();
  for (const tile of tiles) {
    const bytes = await reader.getTile(13, tile.x, tile.y);
    if (bytes) for (const name of decodeMvt(bytes).keys()) years.add(name);
  }
  console.log("YEARS:", [...years].sort().join(", "));
  console.log("HAS_2026:", years.has("2026"));
})().catch((error) => {
  console.error("PROBE FAIL:", error.message);
  process.exit(1);
});
