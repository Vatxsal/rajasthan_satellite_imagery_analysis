import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Public_Sans } from "next/font/google";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";
import ThemeSync from "@/components/shell/ThemeSync";
import ViewportSync from "@/components/shell/ViewportSync";

const publicSans = Public_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-public-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Rajasthan Imagery Explorer",
  description: "Satellite imagery catalogue explorer for Rajasthan.",
};

export const viewport: Viewport = {
  themeColor: "#F6F5F1",
  width: "device-width",
  initialScale: 1,
  // Lets CSS env(safe-area-inset-*) reach the layout on notched phones.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <body className={`${publicSans.variable} ${plexMono.variable} font-sans`}>
        {/* Tile origins race the first map render — warm the connections
            (CORS-mode so MapLibre's crossOrigin image requests reuse them). */}
        <link rel="preconnect" href="https://tiles.openfreemap.org" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://server.arcgisonline.com" crossOrigin="anonymous" />
        <ThemeSync />
        <ViewportSync />
        {children}
      </body>
    </html>
  );
}
