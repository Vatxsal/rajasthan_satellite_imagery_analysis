import type { Metadata } from "next";
import Link from "next/link";
import { REPO_URL } from "@/lib/seo";

export const metadata: Metadata = {
  title: "About",
  description:
    "What Rajasthan Imagery Explorer is, how to search Sentinel-2 scenes by district, tehsil or ILR, its data sources and attribution, and its MIT license.",
  alternates: { canonical: "/about" },
};

const attribution = [
  {
    label: "Sentinel-2 data",
    body: "© ESA / Copernicus data via the Copernicus Data Space Ecosystem — subject to the Copernicus licensing terms; include attribution when republishing imagery.",
    href: "https://dataspace.copernicus.eu/",
  },
  {
    label: "Basemaps",
    body: "OpenFreeMap positron style (OpenMapTiles / © OpenStreetMap contributors, ODbL) and Esri World Imagery (Esri, Maxar, Earthstar Geographics) — keep the attribution line visible when publishing screenshots.",
    href: "https://openfreemap.org/",
  },
  {
    label: "Geocoding",
    body: "Nominatim search — © OpenStreetMap contributors, ODbL; usage follows their usage policy.",
    href: "https://nominatim.org/",
  },
  {
    label: "Boundaries",
    body: "Datameet Census 2011 compilations (Census of India open data) — credit Datameet / Census of India.",
    href: "https://datameet.org",
  },
];

export default function AboutPage() {
  return (
    <div className="min-h-dvh bg-bg text-text">
      <main className="mx-auto max-w-3xl px-6 py-12">
        <Link href="/" className="text-sm text-accent underline">
          Back to the explorer
        </Link>

        <h1 className="mt-6 text-xl font-semibold tracking-tight">About Rajasthan Imagery Explorer</h1>

        <section className="mt-8">
          <h2 className="text-lg font-semibold">What it is</h2>
          <p className="mt-2 text-muted">
            An open-source web dashboard for browsing Copernicus Sentinel-2 satellite imagery over
            Rajasthan. It searches Sentinel-2 Level-2A scenes, groups them into one card per
            acquisition day, and lets you filter by cloud cover and date. Scenes render as true
            colour, false colour or NDVI composites clipped to your selected area, and can be
            downloaded as PNG or GeoTIFF.
          </p>
        </section>

        <section className="mt-8">
          <h2 className="text-lg font-semibold">How to use it</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
            <li>
              Pick a <strong className="text-text">District</strong> (optionally drilling into{" "}
              <strong className="text-text">Tehsil</strong> or{" "}
              <strong className="text-text">ILR</strong>) in the Areas panel.
            </li>
            <li>
              Click <strong className="text-text">Search imagery</strong> to query the Sentinel-2
              catalogue for that area and date range.
            </li>
            <li>
              Select a scene from the results to clip and overlay it on the map, with cloud cover
              shown per day.
            </li>
            <li>
              Open the download menu on the scene to save a PNG or GeoTIFF, or jump to the same
              scene in Copernicus Browser.
            </li>
          </ol>
        </section>

        <section className="mt-8">
          <h2 className="text-lg font-semibold">Data sources and attribution</h2>
          <ul className="mt-2 space-y-3">
            {attribution.map((item) => (
              <li key={item.label} className="rounded-lg border border-border bg-surface p-4">
                <p className="text-sm">
                  <strong>
                    <a
                      href={item.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent underline"
                    >
                      {item.label}
                    </a>
                  </strong>
                  : {item.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-8">
          <h2 className="text-lg font-semibold">Open source</h2>
          <p className="mt-2 text-muted">
            The source code is on{" "}
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              GitHub
            </a>{" "}
            under the{" "}
            <a
              href={`${REPO_URL}/blob/main/LICENSE`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              MIT license
            </a>{" "}
            © Vatsal Mishra.
          </p>
        </section>

        <p className="mt-10">
          <Link href="/" className="text-sm text-accent underline">
            Back to the explorer
          </Link>
        </p>
      </main>
    </div>
  );
}
