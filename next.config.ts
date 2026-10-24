import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Proxy the Python tool-plane (FastAPI :8000) so the UI works on :3000
  // directly, not only behind the Caddy :81 gateway (XTransformPort).
  async rewrites() {
    return [
      {
        source: "/pyapi/:path*",
        destination: "http://127.0.0.1:8000/pyapi/:path*",
      },
    ];
  },
};

export default nextConfig;
