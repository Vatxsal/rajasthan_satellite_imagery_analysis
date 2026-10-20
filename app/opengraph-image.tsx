import { ImageResponse } from "next/og";

export const alt = "Rajasthan Imagery Explorer: Sentinel-2 satellite imagery for Rajasthan";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: 80,
          background: "#F6F5F1",
          color: "#1B1D22",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ width: 120, height: 10, background: "#C2410C", marginBottom: 40 }} />
        <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.1 }}>
          Rajasthan Imagery Explorer
        </div>
        <div style={{ fontSize: 34, marginTop: 28, color: "#6B6E76" }}>
          Sentinel-2 satellite imagery by District, Tehsil and ILR
        </div>
        <div style={{ fontSize: 28, marginTop: 56, color: "#C2410C" }}>
          True colour · False colour · NDVI · PNG &amp; GeoTIFF
        </div>
      </div>
    ),
    { ...size }
  );
}
