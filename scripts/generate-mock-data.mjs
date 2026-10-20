/**
 * Deterministic generator for the hand-made mock GeoJSON used by the demo.
 * Run with: npm run generate:mock-data
 *
 * Districts are rough irregular polygons loosely placed over real Rajasthan
 * districts. Tehsils and ILRs are simple nested subdivisions so the cascade
 * always has sane geometry.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "mock");

/** @typedef {[number, number, number, number]} BBox west,south,east,north */

/** @type {{ id: string; name: string; bbox: BBox; tehsils: { id: string; name: string; ilrs: string[] }[] }[]} */
const DISTRICTS = [
  {
    id: "d-jaipur",
    name: "Jaipur",
    bbox: [75.3, 26.5, 76.2, 27.25],
    tehsils: [
      { id: "t-jaipur-amber", name: "Amber", ilrs: ["Amber North ILR", "Amber South ILR"] },
      { id: "t-jaipur-sanganer", name: "Sanganer", ilrs: ["Sanganer East ILR", "Sanganer West ILR"] },
      { id: "t-jaipur-chaumu", name: "Chomu", ilrs: ["Chomu North ILR", "Chomu South ILR"] },
    ],
  },
  {
    id: "d-jodhpur",
    name: "Jodhpur",
    bbox: [72.55, 25.9, 73.5, 26.7],
    tehsils: [
      { id: "t-jodhpur-bhopalgarh", name: "Bhopalgarh", ilrs: ["Bhopalgarh North ILR", "Bhopalgarh South ILR"] },
      { id: "t-jodhpur-luni", name: "Luni", ilrs: ["Luni East ILR", "Luni West ILR"] },
      { id: "t-jodhpur-phalodi", name: "Phalodi", ilrs: ["Phalodi North ILR", "Phalodi South ILR"] },
    ],
  },
  {
    id: "d-udaipur",
    name: "Udaipur",
    bbox: [73.5, 24.3, 74.4, 25.0],
    tehsils: [
      { id: "t-udaipur-girwa", name: "Girwa", ilrs: ["Girwa North ILR", "Girwa South ILR"] },
      { id: "t-udaipur-kherwara", name: "Kherwara", ilrs: ["Kherwara East ILR", "Kherwara West ILR"] },
      { id: "t-udaipur-salumbar", name: "Salumbar", ilrs: ["Salumbar North ILR", "Salumbar South ILR"] },
    ],
  },
  {
    id: "d-kota",
    name: "Kota",
    bbox: [75.5, 24.9, 76.35, 25.6],
    tehsils: [
      { id: "t-kota-sangod", name: "Sangod", ilrs: ["Sangod North ILR", "Sangod South ILR"] },
      { id: "t-kota-ladpura", name: "Ladpura", ilrs: ["Ladpura East ILR", "Ladpura West ILR"] },
      { id: "t-kota-ramganj", name: "Ramganj Mandi", ilrs: ["Ramganj North ILR", "Ramganj South ILR"] },
    ],
  },
  {
    id: "d-bikaner",
    name: "Bikaner",
    bbox: [72.7, 27.65, 73.9, 28.5],
    tehsils: [
      { id: "t-bikaner-kolayat", name: "Kolayat", ilrs: ["Kolayat North ILR", "Kolayat South ILR"] },
      { id: "t-bikaner-lunkaransar", name: "Lunkaransar", ilrs: ["Lunkaransar East ILR", "Lunkaransar West ILR"] },
      { id: "t-bikaner-nagaur-road", name: "Nagaur Road", ilrs: ["Nagaur Road North ILR", "Nagaur Road South ILR"] },
    ],
  },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Rough 8-vertex ring around a bbox, pushed outward so nested children always
 * stay inside their parent polygon.
 * @param {BBox} bbox
 * @param {() => number} rnd
 * @param {number} amp
 */
function ringFromBbox([w, s, e, n], rnd, amp) {
  const dx = e - w;
  const dy = n - s;
  const midX = (w + e) / 2;
  const midY = (s + n) / 2;
  /** @type {[number, number, number, number][]} */
  const spine = [
    [w, s, -1, -1],
    [midX, s, 0, -1],
    [e, s, 1, -1],
    [e, midY, 1, 0],
    [e, n, 1, 1],
    [midX, n, 0, 1],
    [w, n, -1, 1],
    [w, midY, -1, 0],
  ];
  const ring = spine.map(([x, y, nx, ny]) => [
    Number((x + nx * dx * amp * rnd()).toFixed(5)),
    Number((y + ny * dy * amp * rnd()).toFixed(5)),
  ]);
  ring.push([...ring[0]]);
  return ring;
}

function feature(id, name, properties, ring) {
  return {
    type: "Feature",
    properties: { id, name, ...properties },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

function subdivideColumns([w, s, e, n], count) {
  const width = (e - w) / count;
  return Array.from({ length: count }, (_, i) => [w + i * width, s, w + (i + 1) * width, n]);
}

function subdivideRows([w, s, e, n], count) {
  const height = (n - s) / count;
  return Array.from({ length: count }, (_, j) => [w, s + j * height, e, s + (j + 1) * height]);
}

const districtFeatures = [];
const tehsilFeatures = [];
const ilrFeatures = [];

for (const d of DISTRICTS) {
  const dRnd = mulberry32(hashSeed(d.id));
  districtFeatures.push(feature(d.id, d.name, {}, ringFromBbox(d.bbox, dRnd, 0.05)));

  const tehsilBoxes = subdivideColumns(d.bbox, d.tehsils.length);
  d.tehsils.forEach((t, ti) => {
    const tRnd = mulberry32(hashSeed(t.id));
    const tBox = tehsilBoxes[ti];
    tehsilFeatures.push(
      feature(t.id, t.name, { districtId: d.id, districtName: d.name }, ringFromBbox(tBox, tRnd, 0.03)),
    );

    const ilrBoxes = subdivideRows(tBox, t.ilrs.length);
    t.ilrs.forEach((ilrName, ii) => {
      const ilrId = `${t.id}-ilr${ii + 1}`;
      const iRnd = mulberry32(hashSeed(ilrId));
      ilrFeatures.push(
        feature(
          ilrId,
          ilrName,
          { tehsilId: t.id, tehsilName: t.name, districtId: d.id, districtName: d.name },
          ringFromBbox(ilrBoxes[ii], iRnd, 0.04),
        ),
      );
    });
  });
}

function writeCollection(name, features) {
  const collection = { type: "FeatureCollection", features };
  writeFileSync(join(OUT_DIR, name), JSON.stringify(collection, null, 2) + "\n", "utf8");
  console.log(`wrote data/mock/${name} (${features.length} features)`);
}

mkdirSync(OUT_DIR, { recursive: true });
writeCollection("districts.geojson", districtFeatures);
writeCollection("tehsils.geojson", tehsilFeatures);
writeCollection("ilrs.geojson", ilrFeatures);
