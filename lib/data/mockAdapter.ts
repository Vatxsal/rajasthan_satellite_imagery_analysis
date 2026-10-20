import { districtsFc, ilrsFc, tehsilsFc } from "./boundaries";
import type { DataAdapter } from "./adapter";
import type {
  BBox,
  CompositeId,
  District,
  Ilr,
  Scene,
  SearchParams,
  Tehsil,
} from "./types";

const MOCK_DELAY_MS = 500;

const SATELLITES = [
  "IRS-P6 LISS-4",
  "Sentinel-2A MSI",
  "Landsat-9 OLI",
  "RISAT-1A SAR-X",
];

const delay = (ms = MOCK_DELAY_MS) => new Promise((resolve) => setTimeout(resolve, ms));

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function bboxOfPolygon(geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): BBox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  // Districts may be MultiPolygon (Ajmer, Jodhpur, Rajsamand, Chittaurgarh);
  // outer rings only — holes are always inside them.
  const polygons =
    geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  for (const polygon of polygons) {
    for (const [x, y] of polygon[0]) {
      west = Math.min(west, x);
      south = Math.min(south, y);
      east = Math.max(east, x);
      north = Math.max(north, y);
    }
  }
  return [west, south, east, north];
}

function toDistrict(f: GeoJSON.Feature): District {
  const p = f.properties as { id: string; name: string };
  const geometry = f.geometry as GeoJSON.Polygon;
  return { id: p.id, name: p.name, geometry, bbox: bboxOfPolygon(geometry) };
}

function toTehsil(f: GeoJSON.Feature): Tehsil {
  const p = f.properties as { id: string; name: string; districtId: string };
  const geometry = f.geometry as GeoJSON.Polygon;
  return {
    id: p.id,
    name: p.name,
    districtId: p.districtId,
    geometry,
    bbox: bboxOfPolygon(geometry),
  };
}

function toIlr(f: GeoJSON.Feature): Ilr {
  const p = f.properties as {
    id: string;
    name: string;
    tehsilId: string;
    districtId: string;
  };
  const geometry = f.geometry as GeoJSON.Polygon;
  return {
    id: p.id,
    name: p.name,
    tehsilId: p.tehsilId,
    districtId: p.districtId,
    geometry,
    bbox: bboxOfPolygon(geometry),
  };
}

const districtFeatures = [...districtsFc.features].sort((a, b) =>
  String(a.properties?.name).localeCompare(String(b.properties?.name)),
);
const tehsilFeatures = [...tehsilsFc.features].sort((a, b) =>
  String(a.properties?.name).localeCompare(String(b.properties?.name)),
);
const ilrFeatures = [...ilrsFc.features].sort((a, b) =>
  String(a.properties?.name).localeCompare(String(b.properties?.name)),
);

const districts: District[] = districtFeatures.map(toDistrict);
const tehsils: Tehsil[] = tehsilFeatures.map(toTehsil);
const ilrs: Ilr[] = ilrFeatures.map(toIlr);

function parseIsoDay(value: string): number {
  const [y, m, d] = value.split("-").map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
}

function toIsoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(isoDay: string, days: number): string {
  return toIsoDay(parseIsoDay(isoDay) + days * 86_400_000);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.round((parseIsoDay(toIso) - parseIsoDay(fromIso)) / 86_400_000));
}

const THUMBNAIL_PALETTES: Record<CompositeId, string[]> = {
  "true-color": ["#3f5d3a", "#6b7f4b", "#8a7a55", "#4a6b45", "#c2b280", "#33506b"],
  "false-color": ["#8f2f2f", "#c45c4a", "#5a3a6b", "#a88b4a", "#6e3b2f", "#d17b5a"],
  ndvi: ["#1f6b3a", "#4f9a3c", "#9ec93c", "#d6d24a", "#8a6b2f", "#2f7a55"],
};

/** Deterministic mock thumbnail so the results list looks like a catalogue. */
function buildThumbnail(seed: number, composite: CompositeId, cloudy: boolean): string {
  const rnd = mulberry32(seed);
  const palette = THUMBNAIL_PALETTES[composite];
  let cells = "";
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const fill = palette[Math.floor(rnd() * palette.length)];
      cells += `<rect x="${col * 24}" y="${row * 24}" width="24" height="24" fill="${fill}"/>`;
    }
  }
  let clouds = "";
  if (cloudy) {
    const blobs = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < blobs; i++) {
      const cx = 10 + rnd() * 76;
      const cy = 10 + rnd() * 76;
      const r = 8 + rnd() * 14;
      clouds += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="#ffffff" fill-opacity="0.45"/>`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">${cells}${clouds}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function sceneCode(satellite: string): string {
  if (satellite.startsWith("IRS-P6")) return "LSS4";
  if (satellite.startsWith("Sentinel")) return "S2AM";
  if (satellite.startsWith("Landsat")) return "L9OLI";
  return "RS1AX";
}

interface ResolvedArea {
  districtId: string;
  bbox: BBox;
}

function resolveArea(params: SearchParams): ResolvedArea | null {
  if (params.ilrId) {
    const ilr = ilrs.find((i) => i.id === params.ilrId);
    if (ilr) return { districtId: ilr.districtId, bbox: ilr.bbox };
  }
  if (params.tehsilId) {
    const tehsil = tehsils.find((t) => t.id === params.tehsilId);
    if (tehsil) return { districtId: tehsil.districtId, bbox: tehsil.bbox };
  }
  if (params.districtId) {
    const district = districts.find((d) => d.id === params.districtId);
    if (district) return { districtId: district.id, bbox: district.bbox };
  }
  return null;
}

export const mockAdapter: DataAdapter = {
  async getDistricts(): Promise<District[]> {
    await delay();
    return districts.map((d) => ({ ...d }));
  },

  async getTehsils(districtId: string): Promise<Tehsil[]> {
    await delay();
    return tehsils.filter((t) => t.districtId === districtId).map((t) => ({ ...t }));
  },

  async getIlrs(tehsilId: string): Promise<Ilr[]> {
    await delay();
    return ilrs.filter((i) => i.tehsilId === tehsilId).map((i) => ({ ...i }));
  },

  async searchScenes(params: SearchParams): Promise<Scene[]> {
    await delay();

    const days = daysBetween(params.fromDate, params.toDate);
    const area = resolveArea(params);
    const seed = hashSeed(
      [
        params.districtId ?? "-",
        params.tehsilId ?? "-",
        params.ilrId ?? "-",
        params.fromDate,
        params.toDate,
        params.composite,
      ].join("|"),
    );
    const rnd = mulberry32(seed);

    const candidateCount = 26;
    const scenes: Scene[] = [];

    for (let i = 0; i < candidateCount; i++) {
      const date = addDays(params.fromDate, Math.floor(rnd() * (days + 1)));
      const cloudCover = Math.round(Math.pow(rnd(), 2.2) * 72);
      const satellite = SATELLITES[Math.floor(rnd() * SATELLITES.length)];

      let districtId: string;
      let bbox: BBox;
      if (area) {
        districtId = area.districtId;
        bbox = area.bbox;
      } else {
        const district = districts[Math.floor(rnd() * districts.length)];
        districtId = district.id;
        bbox = district.bbox;
      }

      const id = `${seed.toString(16)}-${i}`;
      const code = `${satellite.split(" ")[0].toUpperCase()}_${sceneCode(satellite)}_${date.replaceAll("-", "")}_${(seed ^ (i * 0x9e3779b1))
        .toString(16)
        .toUpperCase()
        .padStart(8, "0")
        .slice(0, 8)}`;

      scenes.push({
        id,
        sceneId: code,
        date,
        cloudCover,
        satellite,
        composite: params.composite,
        districtId,
        bbox,
        thumbnail: buildThumbnail(hashSeed(id), params.composite, cloudCover > 25),
      });
    }

    return scenes
      .filter((s) => s.cloudCover <= params.maxCloudCover)
      .sort((a, b) => a.cloudCover - b.cloudCover || (a.date < b.date ? 1 : -1))
      .slice(0, 18);
  },
};
