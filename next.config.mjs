const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  // 'unsafe-eval' is required by MapLibre GL JS (expression/worker compilation);
  // 'unsafe-inline' by Next.js bootstrap + MapLibre control styles.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data: https://tiles.openfreemap.org",
  "img-src 'self' data: blob: https://server.arcgisonline.com https://tiles.openfreemap.org",
  "connect-src 'self' https://tiles.openfreemap.org https://server.arcgisonline.com https://nominatim.openstreetmap.org ws://localhost:3000 ws://127.0.0.1:3000",
  "manifest-src 'self'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allows building alongside a running dev server (e.g. NEXT_DIST_DIR=.next-verify).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  webpack: (config) => {
    config.module.rules.push({
      test: /\.geojson$/,
      type: "json",
    });
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
