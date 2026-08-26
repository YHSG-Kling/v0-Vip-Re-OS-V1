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
    // Server Actions default to a 1MB request body — a base64-encoded PDF (~+33%)
    // caps real uploads at ~750KB, so CDA templates + brokerage commission-agreement
    // forms (uploadCdaTemplateFile / uploadCommissionAgreementFormAction, which send
    // the PDF as base64 through a Server Action) would fail for ordinary multi-page
    // documents. Raise the ceiling to cover typical real-estate paperwork.
    serverActions: {
      bodySizeLimit: '8mb',
    },
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
    // ── webpackBuildWorker: ON, and the comment that used to sit here was wrong ──
    //
    // What stood here said: "webpackBuildWorker was tried but spawns one worker
    // PER CORE; on a 16 GB CI runner their combined footprint OOMed the
    // container." That is NOT what this flag does in the installed Next
    // (16.2.7), and the mistake is worth naming because it is what kept the
    // build in its single-heap configuration while compile demand grew into the
    // ceiling documented in .github/workflows/build.yml.
    //
    // READ THE SOURCE, not the folklore — node_modules/next/dist/build/
    // webpack-build/index.js, webpackBuildWithWorker():
    //
    //     const ORDERED_COMPILER_NAMES = ['server', 'edge-server', 'client']
    //     for (const compilerName of compilerNames) {
    //       const worker = new Worker(join(__dirname, 'impl.js'), {
    //         numWorkers: 1, ...                     // ← ONE worker
    //       })
    //       const curResult = await worker.workerMain({ ... })   // ← awaited
    //       await worker.end()   // "destroy worker so it's not sticking around
    //                            //  using memory"  (their comment)
    //     }
    //
    // One worker at a time, SEQUENTIALLY, per COMPILER — not per core. The
    // per-core worker pool that really did OOM this runner is a different
    // phase entirely: "Collecting page data", which is bounded by `cpus: 1`
    // below and is untouched by this flag.
    //
    // WHY IT WAS OFF, AND WHY IT COULD NEVER HAVE TURNED ITSELF ON HERE.
    // next/dist/build/index.js:850 —
    //     const useBuildWorker = config.experimental.webpackBuildWorker
    //       || (config.experimental.webpackBuildWorker === undefined && !config.webpack)
    // The default is `undefined`, so the worker path is taken only when there is
    // NO custom webpack function. This config has one (the sharp external + the
    // @zoom/download-manager alias below) — and even if it did not, withWorkflow()
    // installs its own: node_modules/@workflow/next/dist/index.js:321-338 assigns
    // `nextConfig.webpack = (...)` unconditionally to add its loader. So
    // `!config.webpack` is permanently false here and the flag can only ever be
    // turned on EXPLICITLY, which is what this line does.
    //
    // THE GUARD THAT DEFAULT IS PROTECTING DOES NOT APPLY. It exists because a
    // webpack function cannot be serialized across a process boundary — but the
    // worker does not receive a serialized config. It re-reads next.config.ts
    // from disk: webpack-build/impl.js, workerMain() —
    //     /// load the config because it's not serializable
    //     const config = NextBuildContext.config = await loadConfig(
    //       PHASE_PRODUCTION_BUILD, NextBuildContext.dir, { ... })
    // so the sharp external and the zoom alias are present in every worker.
    //
    // MEASURED, not argued (local repro on a 4-core/16 GB box, the ubuntu-latest
    // shape, same NODE_OPTIONS and same placeholder env as the build workflow):
    //   OFF — all three compilers share one heap:
    //         peak 8413 MB heap used / 9356 MB committed / 13291 MB RSS,
    //         killed at 8m08s by the cgroup OOM killer (exit 137).
    //   ON  — one compiler per process, torn down between:
    //         see .github/workflows/build.yml for the recorded figures.
    // The reason it works is arithmetic: peak becomes the LARGEST single
    // compiler instead of the SUM of three, and the ~4 GB of non-old-space RSS
    // overhead is released with each worker rather than accumulating.
    webpackBuildWorker: true,

    // PAGE-DATA COLLECTION IS A SEPARATE PHASE WITH ITS OWN WORKER POOL, and
    // turning webpackBuildWorker off does not touch it. That is why the build kept
    // dying AFTER a clean compile: the log reads
    //   ✓ Compiled with warnings in 8.6min
    //   Collecting page data using 3 workers ...
    //   ##[error]The runner has received a shutdown signal
    // — a memory kill of the runner, seconds into the phase, with the compile
    // already finished and successful.
    //
    // The arithmetic is the whole story. Those workers are child processes and
    // they INHERIT the job's NODE_OPTIONS, which sets --max-old-space-size=12288
    // for the benefit of the single compile process. So three page-data workers
    // are each permitted a 12 GB old space on a 16 GB runner. That survives only
    // while the module graph is small enough that they never actually claim it,
    // which is exactly why this presented for a long time as an intermittent
    // ~20-25% flake and then became 100% reproducible once the graph grew: it was
    // never random, it was a threshold.
    //
    // cpus:1 collects page data in ONE worker, which is the same single-process
    // strategy already chosen for compile above (and what the build workflow's own
    // comment says it wants: "Single-process webpack build"). Serial is slower —
    // page data for a large route tree — but the job's ceiling is 40 minutes and a
    // build that finishes in 20 beats one that is killed at 9.
    //
    // Deliberately NOT fixed by lowering NODE_OPTIONS instead: the one compile
    // process genuinely needs the large heap, and shrinking it to make three
    // workers fit would trade a reliable page-data phase for an unreliable
    // compile. Bound the parallelism, not the heap.
    cpus: 1,
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
    // DO NOT SET `config.cache.maxMemoryGenerations = 0` HERE. It is the obvious
    // next idea after reading Next's webpack-config.js, which hardcodes
    //     maxMemoryGenerations: dev ? 0 : Infinity
    // for the filesystem cache — i.e. in a production build no cache entry is
    // ever evicted from the heap. Since webpackBuildWorker puts each compiler in
    // its OWN PROCESS, a memory cache one of them fills cannot be read by the
    // next, so dropping it looks free.
    //
    // IT WAS MEASURED AND IT IS THE WORST OF THE THREE CONFIGURATIONS TRIED.
    // Same box, same tree, same NODE_OPTIONS, caches dropped before each run:
    //   webpackBuildWorker alone      → 7968 MB used / 8921 MB committed (87.1%
    //                                   of the 10240 cap), died at 505s on the
    //                                   local box's smaller ceiling.
    //   webpackBuildWorker + this     → 9718 MB used / 10263 MB committed —
    //                                   100.2% OF CAP — FATAL ERROR: Ineffective
    //                                   mark-compacts, at 291s. Nearly TWICE the
    //                                   heap and in HALF the time.
    // The GC log says why: `average mu = 0.072`, so the process spent 93% of its
    // wall time collecting. Evicting a pack-file-cache entry does not free it —
    // it forces immediate serialization, and the serializer's buffers plus the
    // garbage that churn creates cost far more than the records retained.
    // Recorded rather than silently dropped, because the reasoning above is sound
    // and someone will have it again.
    if (isServer) {
      // Force sharp to stay EXTERNAL on the server build: emit `require("sharp")`
      // at runtime (resolved from node_modules, where its native
      // @img/sharp-linux-x64 binary sits as a sibling) instead of BUNDLING sharp
      // into a server chunk. A bundled sharp can't locate that binary and the
      // build dies in "Collecting page data" with: Could not load the "sharp"
      // module using the linux-x64 runtime.
      //
      // serverExternalPackages: ["sharp"] does exactly this and works in a plain
      // `next build --webpack` (verified locally: 0 sharp warnings, full build).
      // But on Vercel the "Applying modifyConfig from Vercel" step (composed with
      // the withWorkflow wrapper) does not carry serverExternalPackages through,
      // so sharp was still bundled there — the local-green / Vercel-red split.
      // Pinning the external HERE, inside the webpack callback Next always runs,
      // is not reachable by that config rewrite. The binary is installed under
      // pnpm (@img/sharp-linux-x64 is in pnpm-lock.yaml); the only problem was
      // bundling, which this prevents.
      const existing = config.externals || []
      config.externals = [
        ...(Array.isArray(existing) ? existing : [existing]),
        { sharp: 'commonjs sharp' },
      ]
    }
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
