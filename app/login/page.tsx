import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Fraunces } from "next/font/google";
import AccessPanel from "@/components/login/AccessPanel";
import LandingCopy from "@/components/login/LandingCopy";
import LandingSwipe from "@/components/login/LandingSwipe";
import { AUTH_COOKIE, sessionSecret } from "@/lib/auth/config";
import { nextPathOrFallback, sanitizeNextPath } from "@/lib/auth/nextPath";
import { verifySession } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/env";
import "./login.css";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "");
const SITE_DESCRIPTION =
  "See Rajasthan change, from space: compare any two dates at 10 m detail and get an AI-written change report in your inbox.";

// Page-scoped display face: only /login pays the extra font request, and the
// variable lands on the page root so `font-display` utilities resolve.
const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-fraunces",
  display: "swap",
});

/** Sentinel-2 native resolution (m) and nominal revisit (days). */
const RESOLUTION_M = 10;
const REVISIT_DAYS = 5;

export const metadata: Metadata = {
  title: "Sign in · Rajasthan Imagery Explorer",
  description: SITE_DESCRIPTION,
  openGraph: {
    title: "Rajasthan Imagery Explorer",
    description: SITE_DESCRIPTION,
    ...(SITE_URL ? { url: SITE_URL } : {}),
    siteName: "Rajasthan Imagery Explorer",
    images: [
      {
        url: "/landing/og-swipe.jpg",
        width: 1200,
        height: 630,
        alt: "Before/after Sentinel-2 comparison of Sambhar Lake, Rajasthan",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Rajasthan Imagery Explorer",
    description: SITE_DESCRIPTION,
    images: ["/landing/og-swipe.jpg"],
  },
};

/* ------------------------------------------------------------------ data */

interface GeoJsonFile {
  features: { properties: { id?: string; name?: string } }[];
}

interface LandingFacts {
  districtCount: number;
  tehsilCount: number;
}

/** District/tehsil counts straight from the boundary files (never hard-coded). */
let factsCache: LandingFacts | null = null;

function loadLandingFacts(): LandingFacts {
  if (factsCache) return factsCache;
  const read = (name: string): GeoJsonFile =>
    JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "data", "boundaries", name), "utf8"),
    ) as GeoJsonFile;
  factsCache = {
    districtCount: read("districts.geojson").features.length,
    tehsilCount: read("tehsils.geojson").features.length,
  };
  return factsCache;
}

interface SwipeSlot {
  date: string;
  file: string;
}

interface SwipeFacts {
  site: string;
  bbox: [number, number, number, number];
  credit: string;
  before: SwipeSlot;
  after: SwipeSlot;
  width: number;
  height: number;
}

/** The shipped Sambhar Lake swipe sheet (data/landing/swipe.json). */
let swipeCache: SwipeFacts | null = null;

function loadSwipeFacts(): SwipeFacts {
  if (swipeCache) return swipeCache;
  const raw = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "data", "landing", "swipe.json"), "utf8"),
  ) as {
    site: string;
    bbox: number[];
    credit: string;
    before: { date: string; file: string; width: number; height: number };
    after: { date: string; file: string; width: number; height: number };
  };
  swipeCache = {
    site: raw.site,
    bbox: [raw.bbox[0]!, raw.bbox[1]!, raw.bbox[2]!, raw.bbox[3]!],
    credit: raw.credit,
    before: { date: raw.before.date, file: raw.before.file },
    after: { date: raw.after.date, file: raw.after.file },
    width: raw.after.width,
    height: raw.after.height,
  };
  return swipeCache;
}

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function formatDate(iso: string): string {
  return dateFormat.format(new Date(`${iso}T00:00:00Z`));
}

/**
 * Pick a round ground distance (km) whose scale bar lands at 10–35% of the
 * image width, computed from the swipe bbox at its mid-latitude.
 */
function scaleBarFor(bbox: [number, number, number, number]): { km: number; percent: number } {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const midLat = (minLat + maxLat) / 2;
  const groundKm = (maxLon - minLon) * 111.32 * Math.cos((midLat * Math.PI) / 180);
  for (const km of [1, 2, 5, 10, 20, 50, 100]) {
    const percent = (km / groundKm) * 100;
    if (percent >= 10 && percent <= 35) return { km, percent };
  }
  return { km: 10, percent: (10 / groundKm) * 100 };
}

/* ----------------------------------------------------------------- page */

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string; mode?: string };
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
  const facts = loadLandingFacts();
  const swipe = loadSwipeFacts();
  const scale = scaleBarFor(swipe.bbox);
  const beforeDate = formatDate(swipe.before.date);
  const afterDate = formatDate(swipe.after.date);

  const guestEnabled = env.GUEST_ENABLED;
  const accessEnabled = Boolean(env.EMAIL_FIXED_RECIPIENT?.trim()) && env.ACCESS_REQUEST_DAILY_CAP > 0;
  const captchaRequired = Boolean(env.TURNSTILE_SECRET_KEY);
  const turnstileSiteKey = env.TURNSTILE_SITE_KEY ?? null;

  return (
    <div className={`${fraunces.variable} flex min-h-dvh flex-col bg-bg text-text`}>
      <a
        href="#auth-card"
        className="sr-only rounded bg-accent px-3 py-2 text-sm font-medium text-accent-fg focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
      >
        Skip to sign in
      </a>

      {/* LCP: the "after" frame is the full-bleed base image — warm it. */}
      <link rel="preload" as="image" href={swipe.after.file} />

      <main className="flex flex-1 flex-col lg:grid lg:grid-cols-12">
        <section className="flex min-w-0 flex-col lg:col-span-7">
          <LandingSwipe
            className="relative aspect-[4/3] w-full shrink-0 overflow-hidden bg-surface-2 lg:aspect-auto lg:min-h-0 lg:flex-1"
            beforeSrc={swipe.before.file}
            afterSrc={swipe.after.file}
            beforeLabel={beforeDate}
            afterLabel={afterDate}
            site={swipe.site}
            bbox={swipe.bbox}
            imageWidth={swipe.width}
            imageHeight={swipe.height}
            scaleKm={scale.km}
            scalePercent={scale.percent}
          />

          {/* Paper band: overlaps the image edge (headline sits partly over it).
              @container makes the @md: facts grid below query band width. */}
          <div className="@container relative z-10 -mt-4 border-t border-border bg-bg px-5 pb-7 pt-4 lg:-mt-12 lg:px-10 lg:pb-9 lg:pt-5">
            <p className="rse-rise mono-nums text-[11px] leading-4 text-muted" style={{ animationDelay: "60ms" }}>
              {swipe.site} · {beforeDate} → {afterDate} · {swipe.credit}
            </p>
            <LandingCopy
              districtCount={facts.districtCount}
              tehsilCount={facts.tehsilCount}
              resolutionM={RESOLUTION_M}
              revisitDays={REVISIT_DAYS}
            />
          </div>
        </section>

        <aside className="flex border-t border-border px-5 py-8 lg:col-span-5 lg:border-l lg:border-t-0 lg:px-10 lg:py-12">
          <AccessPanel
            next={next}
            guestEnabled={guestEnabled}
            accessEnabled={accessEnabled}
            captchaRequired={captchaRequired}
            turnstileSiteKey={turnstileSiteKey}
            guestTtlHours={env.SESSION_TTL_GUEST_HOURS}
            ssoTtlHours={env.SESSION_TTL_SSO_HOURS}
            initialMode={searchParams.mode === "request" ? "request" : "sso"}
          />
        </aside>
      </main>

      <footer className="border-t border-border px-5 py-4 text-center text-[11px] text-muted lg:text-left">
        <div className="flex flex-col gap-1 sm:flex-row sm:justify-between">
          <span>Contains modified Copernicus Sentinel data.</span>
          <span>
            Guest access uses a first-party session cookie only — no trackers, no third parties.
          </span>
        </div>
      </footer>
    </div>
  );
}
