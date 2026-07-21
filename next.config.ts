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
    // Type-checking is owned by the dedicated `npm run type-check` (tsc --noEmit)
    // step that runs FIRST in the guards CI workflow (a required, passing gate).
    // `next build` re-runs tsc a second time during the "Running TypeScript"
    // phase, which OOMed the build (JS heap exhausted at 8 GB on a large app) —
    // redundant work that also blocked the build. Skipping the in-build check
    // lets the build own what only IT can validate (compile + RSC/client
    // boundaries + bundling + static generation — the layer tsc can't see) while
    // type errors stay gated by the standalone tsc job. Both guarantees kept.
    ignoreBuildErrors: true,
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
    // Cap Turbopack's compile-time memory. `next build` uses Turbopack (Rust),
    // which holds compile state in NATIVE memory; on this large app it climbed
    // to the full 16 GB of a standard CI/build container and the VM was killed
    // ~4 min into compile ("runner received a shutdown signal" — a memory kill,
    // not a code error). This is a soft target (bytes) that makes Turbopack GC
    // more aggressively so total RSS stays well under the ceiling. Applies to
    // CI AND Vercel identically — the production build is memory-bounded
    // everywhere. Raise if a genuinely larger working set errors; lower if a
    // smaller build container (e.g. 8 GB) still gets killed.
    turbopackMemoryLimit: 8 * 1024 * 1024 * 1024, // 8 GB (dev only — build now uses webpack)
    // The PRODUCTION BUILD runs on webpack (`next build --webpack`), not
    // Turbopack. Turbopack's native compiler climbed to the full 16 GB of a
    // standard build container and the VM was killed ~5 min into compile — even
    // with turbopackMemoryLimit set (it's a soft cache target; the non-evictable
    // working set for an app this large still blew the ceiling). Webpack holds
    // the graph in the V8 heap (bounded + GC'd) and builds in worker processes —
    // memory-predictable, and the mature path this app used before Next 16 made
    // Turbopack the default. These two flags are the memory levers:
    webpackMemoryOptimizations: true, // drop retained caches → lower peak heap
    // webpackBuildWorker was tried but spawns one worker PER CORE; on a 16 GB CI
    // runner their combined footprint OOMed the container ("external memory
    // pressure" at ~6.7 GB heap, below the 8 GB V8 cap — i.e. total RSS, not the
    // JS heap). A SINGLE-process build holds one module graph bounded by the heap
    // cap (NODE_OPTIONS below) — the lowest-peak-memory config, which fits. Left
    // OFF (default). Slower, but it completes on a constrained runner.
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
    // sharp ships a native libvips binary loaded via @img/sharp-linux-x64.
    // If webpack BUNDLES sharp into a server chunk, the bundled copy can't
    // locate its sibling native binary at runtime — `next build` then dies in
    // "Collecting page data" with: Could not load the "sharp" module using the
    // linux-x64 runtime (first tripped by /api/cron/listing-promo-hybrid-composite,
    // which imports lib/video/composite-attribution.ts → sharp). npm's FLAT
    // node_modules happens to hoist the binary where bundled-sharp still finds
    // it (CI passed), but pnpm's ISOLATED layout (what Vercel uses) hides it —
    // the exact npm-green / pnpm-red split. Externalizing sharp makes Next
    // require() it from its real node_modules location under BOTH package
    // managers, where the native binary resolves. sharp is imported by
    // composite-attribution, photo-intelligence, image-generation,
    // listing-brochure — all server-only.
    "sharp",
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
  ],
  reactStrictMode: true,
  poweredByHeader: false,
  // Next 16 makes Turbopack the default builder; acknowledge it explicitly
  // so the `webpack` block below (used only for the legacy dev watch path)
  // doesn't promote a warning to a build error.
  turbopack: {
    // The @zoom/meetingsdk embedded UMD bundle require()s '@zoom/download-manager'
    // — an unpublished Zoom-internal module (404 on npm) reached only by the full
    // Client-View download path, never by the embedded Component View we use.
    // Point it at an empty stub so dev (Turbopack) resolves it to nothing.
    resolveAlias: {
      '@zoom/download-manager': './lib/stubs/zoom-download-manager.ts',
    },
  },
  webpack: (config, { isServer }) => {
    // Same as the Turbopack alias above, for the production build (webpack):
    // resolve the unpublished '@zoom/download-manager' to an empty module rather
    // than failing "Module not found". jszip (the SDK's other bundle require) is
    // a real package and is installed.
    config.resolve = config.resolve || {}
    config.resolve.alias = { ...(config.resolve.alias || {}), '@zoom/download-manager': false }
    // Reduce aggressive file watching to prevent duplicate dev server spawns
    if (!isServer) {
      config.watchOptions = {
        ...config.watchOptions,
        aggregateTimeout: 1000, // Wait 1s after last change before rebuilding (increased from 500ms)
        poll: 2000, // Check for changes every 2s instead of continuous watching
        ignored: ['**/node_modules', '**/.git', '**/.next'],
      }
    }
    return config
  },
}

// withWorkflow enables the "use workflow" / "use step" directives (Vercel Workflow
// DevKit). Durable workflows live in workflows/*; see workflows/market-insight-workflow.ts.
export default withWorkflow(nextConfig)
