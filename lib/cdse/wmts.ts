import { getServerEnv } from "@/lib/env";
import { getAccessToken } from "./auth";

/**
 * WMTS tile proxy support (only active when CDSE_WMTS_INSTANCE_ID is set).
 * Builds a GetTile URL for a Sentinel Hub WMS/WMTS instance; the access token
 * is attached server-side by the /api/tiles route and never reaches the client.
 *
 * The layer name below ("1-TRUE-COLOR") matches instances created from the CDSE
 * dashboard defaults — adjust here if your instance uses a different layer ID.
 */
export function hasWmtsInstance(): boolean {
  const env = getServerEnv();
  return Boolean(env.CDSE_WMTS_INSTANCE_ID);
}

export async function fetchWmtsTile(z: number, x: number, y: number): Promise<Buffer> {
  const env = getServerEnv();
  const instanceId = env.CDSE_WMTS_INSTANCE_ID;
  if (!instanceId) {
    throw Object.assign(new Error("WMTS tile mode requires CDSE_WMTS_INSTANCE_ID."), {
      status: 404,
      code: "WMTS_DISABLED",
    });
  }

  const token = await getAccessToken();
  const url = new URL(`https://services.dataspace.copernicus.eu/ogc/wmts/${instanceId}`);
  url.searchParams.set("SERVICE", "WMTS");
  url.searchParams.set("REQUEST", "GetTile");
  url.searchParams.set("VERSION", "1.0.0");
  url.searchParams.set("LAYER", "1-TRUE-COLOR");
  url.searchParams.set("STYLE", "default");
  url.searchParams.set("TILEMATRIXSET", "GoogleMapsCompatible");
  url.searchParams.set("TILEMATRIX", String(z));
  url.searchParams.set("TILEROW", String(y));
  url.searchParams.set("TILECOL", String(x));
  url.searchParams.set("FORMAT", "image/png");
  url.searchParams.set("token", token);

  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    const { mapCdseStatus } = await import("./errors");
    throw mapCdseStatus(response.status, await response.text().catch(() => ""));
  }
  return Buffer.from(await response.arrayBuffer());
}
