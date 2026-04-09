import type { NextConfig } from 'next'

// Route tree uses [id] as the universal dynamic segment throughout app/dashboard/**
// Widget CORS headers applied to /widget/* iframe pages and /api/widget/* routes.
// X-Frame-Options is intentionally omitted so any brokerage site can embed the iframe.
// Content-Security-Policy frame-ancestors '*' achieves the same for modern browsers.
const WIDGET_HEADERS = [
  // Allow cross-origin embedding
  { key: 'Content-Security-Policy',   value: "frame-ancestors *; default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src * data:; connect-src *" },
  // Allow cross-origin API calls from the embedded iframe
  { key: 'Access-Control-Allow-Origin',  value: '*' },
  { key: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
  { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
  // Prevent browser from caching widget loader scripts
  { key: 'Cache-Control', value: 'no-store, max-age=0' },
]

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  async headers() {
    return [
      {
        // iframe widget pages — allow embedding from any origin
        source: '/widget/:path*',
        headers: WIDGET_HEADERS,
      },
      {
        // widget API routes — CORS so the embedded iframe can POST
        source: '/api/widget/:path*',
        headers: WIDGET_HEADERS,
      },
    ]
  },
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
  experimental: {
    optimizePackageImports: ['lucide-react', 'zustand'],
  },
  reactStrictMode: true,
  poweredByHeader: false,
  // Reduce aggressive file watching to prevent duplicate dev server spawns
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.watchOptions = {
        ...config.watchOptions,
        aggregateTimeout: 500, // Wait 500ms after last change before rebuilding
        ignored: ['**/node_modules', '**/.git', '**/.next'],
      }
    }
    return config
  },
}

export default nextConfig
