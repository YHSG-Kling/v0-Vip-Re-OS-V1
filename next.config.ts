import type { NextConfig } from 'next'
import { withWorkflow } from 'workflow/next'

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
  async redirects() {
    return [
      // Unified CRM: every contact lives under /crm/contacts/[id]. Old URLs
      // (saved bookmarks, voice-cockpit email links sent before the cutover,
      // /dashboard/contacts legacy links) redirect permanently to the new
      // canonical path so nothing 404s.
      {
        source:      '/contacts',
        destination: '/crm',
        permanent:   true,
      },
      {
        source:      '/contacts/:path*',
        destination: '/crm/contacts/:path*',
        permanent:   true,
      },
      {
        source:      '/dashboard/contacts',
        destination: '/crm',
        permanent:   true,
      },
      {
        source:      '/dashboard/contacts/:path*',
        destination: '/crm/contacts/:path*',
        permanent:   true,
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
  // Skip bundling for packages that ship platform-specific native binaries
  // or otherwise can't be analysed by Turbopack. They get plain Node
  // `require()` at server runtime instead of being walked + chunked.
  //
  // Why each is here:
  //   @remotion/* — the Remotion renderer + bundler depend on platform-
  //     specific @remotion/compositor-* native modules and esbuild
  //     binaries; walking those crashes Turbopack on the unparseable
  //     binary + the missing other-platform variants.
  //   @rspack/core — pulled by @remotion/bundler; uses node:worker_threads.
  //   esbuild + @esbuild/* — Remotion's esbuild prebuild ships native
  //     binaries + a README.md in its bin/ dir that Turbopack chokes on.
  //   @sparticuz/chromium-min, ffmpeg-static — also native + already
  //     handled via vercel.json's includeFiles override per route.
  serverExternalPackages: [
    "@remotion/bundler",
    "@remotion/renderer",
    "@remotion/compositor-darwin-arm64",
    "@remotion/compositor-darwin-x64",
    "@remotion/compositor-linux-x64-gnu",
    "@remotion/compositor-linux-x64-musl",
    "@remotion/compositor-linux-arm64-gnu",
    "@remotion/compositor-linux-arm64-musl",
    "@remotion/compositor-win32-x64-msvc",
    "@rspack/core",
    "esbuild",
    "@sparticuz/chromium-min",
    "ffmpeg-static",
    // Wave 39: sharp is a native image module (used by lib/video/
    // composite-attribution + lib/ai/image-generation). Turbopack can't
    // bundle the .node binary; sharp is loaded via Node require() at
    // runtime. Same posture as the Remotion natives above.
    "sharp",
    "bcrypt",
    "bufferutil",
    "utf-8-validate",
  ],
  reactStrictMode: true,
  poweredByHeader: false,
  // Next 16 makes Turbopack the default builder; acknowledge it explicitly
  // so the `webpack` block below (used only for the legacy dev watch path)
  // doesn't promote a warning to a build error.
  turbopack: {},
  // Reduce aggressive file watching to prevent duplicate dev server spawns
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.watchOptions = {
        ...config.watchOptions,
        aggregateTimeout: 1000, // Wait 1s after last change before rebuilding (increased from 500ms)
        poll: 2000, // Check for changes every 2s instead of continuous watching
        ignored: ['**/node_modules', '**/.git', '**/.next'],
      }
    }
    return code
  },
}

// withWorkflow enables the "use workflow" / "use step" directives (Vercel Workflow
// DevKit). Durable workflows live in workflows/*; see workflows/market-insight-workflow.ts.
export default withWorkflow(nextConfig)
