export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ??
  "https://rajasthan-satellite-imagery-analysi.vercel.app"
).replace(/\/$/, "");

export const SITE_NAME = "Rajasthan Imagery Explorer";
export const SITE_TITLE =
  "Rajasthan Imagery Explorer | Sentinel-2 Satellite Imagery for Rajasthan";
export const SITE_DESCRIPTION =
  "Open-source Sentinel-2 satellite imagery viewer for Rajasthan. Browse by district, tehsil and ILR, compare scenes by cloud cover, view true colour, false colour and NDVI, and download PNG or GeoTIFF.";
export const SITE_KEYWORDS = [
  "Rajasthan satellite imagery",
  "Sentinel-2 Rajasthan",
  "Rajasthan district map",
  "NDVI Rajasthan",
  "Copernicus Sentinel-2 viewer",
  "download GeoTIFF Sentinel-2",
  "Rajasthan tehsil boundaries",
  "satellite imagery India",
];
export const AUTHOR = { name: "Vatsal Mishra", url: "https://github.com/Vatxsal" };
export const REPO_URL =
  "https://github.com/Vatxsal/rajasthan_satellite_imagery_analysis";

// Only index the real production deployment (not Vercel previews / local dev)
export const IS_PRODUCTION_DEPLOY = process.env.VERCEL_ENV
  ? process.env.VERCEL_ENV === "production"
  : process.env.NODE_ENV === "production";

export const absoluteUrl = (path = "/") =>
  `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
