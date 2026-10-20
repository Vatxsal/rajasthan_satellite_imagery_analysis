const REPO = "https://github.com/Vatxsal/rajasthan_satellite_imagery_analysis";

export default function SeoIntro() {
  return (
    <>
      <section className="sr-only" aria-label="About this app">
        <h2>Rajasthan Imagery Explorer: Sentinel-2 satellite imagery</h2>
        <p>
          Rajasthan Imagery Explorer is an open-source web dashboard for browsing Copernicus
          Sentinel-2 satellite imagery over Rajasthan. It queries Sentinel-2 Level-2A scenes and
          groups them into daily mosaics with cloud cover, after you select an area through the
          District &rarr; Tehsil &rarr; ILR hierarchy. Scenes can be compared and viewed as true
          colour, false colour, or NDVI composites clipped to your selection, then downloaded as
          PNG or GeoTIFF, with deep links to Copernicus Browser. District, tehsil and ILR boundary
          layers, vector and imagery basemaps, and address search are included.
        </p>
        <nav aria-label="Site links">
          <a href="/about">About this app</a>
          <a href={REPO}>Source code on GitHub</a>
        </nav>
      </section>
      <noscript>
        <div className="bg-surface p-4 text-sm text-muted">
          The interactive satellite map requires JavaScript.{" "}
          <a className="text-accent underline" href="/about">
            About this app
          </a>
        </div>
      </noscript>
    </>
  );
}
