import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import AuthCard from "@/components/login/AuthCard";
import LoginHero, { type DistrictMarker } from "@/components/login/LoginHero";
import { AUTH_COOKIE, sessionSecret } from "@/lib/auth/config";
import { nextPathOrFallback, sanitizeNextPath } from "@/lib/auth/nextPath";
import { verifySession } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/env";
import "./login.css";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "");
const SITE_DESCRIPTION =
  "See Rajasthan change, from space: compare any two dates at 10 m detail and get an AI-written change report in your inbox.";

export const metadata: Metadata = {
  title: "Sign in · Rajasthan Imagery Explorer",
  description: SITE_DESCRIPTION,
  openGraph: {
    title: "Rajasthan Imagery Explorer",
    description: SITE_DESCRIPTION,
    ...(SITE_URL ? { url: SITE_URL } : {}),
    siteName: "Rajasthan Imagery Explorer",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Rajasthan Imagery Explorer" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Rajasthan Imagery Explorer",
    description: SITE_DESCRIPTION,
    images: ["/og.png"],
  },
};

/* ------------------------------------------------------------------ map */

interface RajasthanOutline {
  /** All district rings in one path (viewBox 0 0 width height). */
  path: string;
  width: number;
  height: number;
  markers: DistrictMarker[];
  districtCount: number;
  tehsilCount: number;
}

interface GeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

interface GeoJsonFeature {
  properties: { id?: string; name?: string };
  geometry: GeoJsonGeometry;
}

interface GeoJsonFile {
  features: GeoJsonFeature[];
}

const OUTLINE_TOLERANCE = 4;
const MARKER_DISTRICTS = ["Jaipur", "Jodhpur", "Udaipur", "Kota"];

type Point = [number, number];

/** Douglas-Peucker simplification in projected space. */
function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const dx = last[0] - first[0];
  const dy = last[1] - first[1];
  const length = Math.hypot(dx, dy);
  let maxDistance = 0;
  let splitIndex = 0;

  if (length < 1e-9) {
    // Closed ring: split at the point farthest from the start.
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index]!;
      const distance = Math.hypot(point[0] - first[0], point[1] - first[1]);
      if (distance > maxDistance) {
        maxDistance = distance;
        splitIndex = index;
      }
    }
    if (maxDistance > tolerance && splitIndex > 0) {
      const left = simplify(points.slice(0, splitIndex + 1), tolerance);
      const right = simplify(points.slice(splitIndex), tolerance);
      return left.slice(0, -1).concat(right);
    }
    return [first];
  }

  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index]!;
    const distance = Math.abs(
      dy * point[0] - dx * point[1] + last[0] * first[1] - last[1] * first[0],
    ) / length;
    if (distance > maxDistance) {
      maxDistance = distance;
      splitIndex = index;
    }
  }

  if (maxDistance > tolerance && splitIndex > 0) {
    const left = simplify(points.slice(0, splitIndex + 1), tolerance);
    const right = simplify(points.slice(splitIndex), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function walkCoordinates(coordinates: unknown, visit: (lon: number, lat: number) => void): void {
  if (!Array.isArray(coordinates)) return;
  if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
    visit(coordinates[0] as number, coordinates[1] as number);
    return;
  }
  for (const child of coordinates) walkCoordinates(child, visit);
}

function geometryRings(geometry: GeoJsonGeometry): unknown[][] {
  const { type, coordinates } = geometry;
  if (type === "Polygon") return coordinates as unknown[][];
  if (type === "MultiPolygon") return (coordinates as unknown[][][]).flat();
  return [];
}

/**
 * Memoized per-server-process computation of the hero SVG: projects the
 * district GeoJSON (equirectangular with a cos(26.5°) width correction),
 * simplifies every ring, and derives marker positions for four districts.
 * The path stays a single <path d> so the draw-in animation is one stroke.
 */
let outlineCache: RajasthanOutline | null = null;

function loadOutline(): RajasthanOutline {
  if (outlineCache) return outlineCache;

  const file = path.join(process.cwd(), "data", "boundaries", "districts.geojson");
  const geo = JSON.parse(fs.readFileSync(file, "utf8")) as GeoJsonFile;
  const tehsilsFile = path.join(process.cwd(), "data", "boundaries", "tehsils.geojson");
  const tehsils = JSON.parse(fs.readFileSync(tehsilsFile, "utf8")) as GeoJsonFile;

  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const feature of geo.features) {
    walkCoordinates(feature.geometry.coordinates, (lon, lat) => {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    });
  }

  const k = Math.cos((26.5 * Math.PI) / 180);
  const spanX = (maxLon - minLon) * k;
  const spanY = maxLat - minLat;
  const scale = 1_000 / spanX;
  const width = Math.round(spanX * scale);
  const height = Math.round(spanY * scale);

  const project = (lon: number, lat: number): Point => [
    (lon - minLon) * k * scale,
    (maxLat - lat) * scale,
  ];

  let pathData = "";
  for (const feature of geo.features) {
    for (const ring of geometryRings(feature.geometry)) {
      const projected: Point[] = [];
      for (const position of ring) {
        const pair = position as [number, number];
        projected.push(project(pair[0], pair[1]));
      }
      // Drop the duplicated closing vertex before simplifying.
      const open =
        projected.length > 1 &&
        Math.hypot(
          projected[0]![0] - projected[projected.length - 1]![0],
          projected[0]![1] - projected[projected.length - 1]![1],
        ) < 1e-9
          ? projected.slice(0, -1)
          : projected;
      const simple = simplify(open, OUTLINE_TOLERANCE);
      let d = "";
      let previous: [string, string] | null = null;
      let drawn = 0;
      for (const [rawX, rawY] of simple) {
        const x = rawX.toFixed(1);
        const y = rawY.toFixed(1);
        if (previous && previous[0] === x && previous[1] === y) continue;
        d += drawn === 0 ? `M${x} ${y}` : `L${x} ${y}`;
        previous = [x, y];
        drawn += 1;
      }
      if (drawn > 2) pathData += `${d}Z`;
    }
  }

  const markers: DistrictMarker[] = [];
  for (const name of MARKER_DISTRICTS) {
    const feature = geo.features.find((item) => item.properties.name === name);
    if (!feature) continue;
    let lonSum = 0;
    let latSum = 0;
    let count = 0;
    walkCoordinates(feature.geometry.coordinates, (lon, lat) => {
      lonSum += lon;
      latSum += lat;
      count += 1;
    });
    if (count === 0) continue;
    const [x, y] = project(lonSum / count, latSum / count);
    markers.push({ name, x: Math.round(x), y: Math.round(y) });
  }

  outlineCache = {
    path: pathData,
    width,
    height,
    markers,
    districtCount: geo.features.length,
    tehsilCount: tehsils.features.length,
  };
  return outlineCache;
}

/* ----------------------------------------------------------------- page */

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  const env = getServerEnv();
  const secret = sessionSecret(env);

  // Already signed in: /login redirects away (honouring a deep link).
  const token = cookies().get(AUTH_COOKIE)?.value;
  if (token && secret) {
    const session = await verifySession(token, secret);
    if (session) redirect(nextPathOrFallback(searchParams.next));
  }

  const next = sanitizeNextPath(searchParams.next);
  const outline = loadOutline();
  const guestEnabled = env.GUEST_ENABLED;
  const accessEnabled = Boolean(env.EMAIL_FIXED_RECIPIENT?.trim()) && env.ACCESS_REQUEST_DAILY_CAP > 0;
  const captchaRequired = Boolean(env.TURNSTILE_SECRET_KEY);
  const turnstileSiteKey = env.TURNSTILE_SITE_KEY ?? null;

  return (
    <div className="min-h-dvh bg-bg text-text">
      <a
        href="#auth-card"
        className="sr-only rounded bg-accent px-3 py-2 text-sm font-medium text-accent-fg focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
      >
        Skip to sign in
      </a>

      <div className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col lg:flex-row">
        <LoginHero
          districtsPath={outline.path}
          mapWidth={outline.width}
          mapHeight={outline.height}
          markers={outline.markers}
          districtCount={outline.districtCount}
          tehsilCount={outline.tehsilCount}
        />

        <div
          className="flex shrink-0 items-center justify-center border-t border-border px-5 py-10 lg:w-[500px] lg:border-l lg:border-t-0 lg:py-8"
          style={{ animationDelay: "180ms" }}
        >
          <AuthCard
            next={next}
            guestEnabled={guestEnabled}
            accessEnabled={accessEnabled}
            captchaRequired={captchaRequired}
            turnstileSiteKey={turnstileSiteKey}
          />
        </div>
      </div>

      <footer className="border-t border-border px-5 py-4 text-center text-[11px] text-muted lg:text-left">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-1 sm:flex-row sm:justify-between">
          <span>Contains modified Copernicus Sentinel data.</span>
          <span>
            Guest access uses a first-party session cookie only — no trackers, no third parties.
          </span>
        </div>
      </footer>
    </div>
  );
}
