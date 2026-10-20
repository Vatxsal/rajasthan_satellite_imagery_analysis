import type { MetadataRoute } from "next";
import { IS_PRODUCTION_DEPLOY, SITE_URL, absoluteUrl } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  if (!IS_PRODUCTION_DEPLOY) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return {
    // /api/ is blocked so crawlers never spend Copernicus render quota
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/"] }],
    sitemap: absoluteUrl("/sitemap.xml"),
    host: SITE_URL,
  };
}
