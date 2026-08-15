/**
 * types/next-augment.d.ts
 *
 * Workaround for a Next.js 16.1.6 bug. Its build-time type generator
 * emits `import type { PrefetchForTypeCheckInternal } from
 * 'next/dist/build/segment-config/app/app-segment-config.js'` into the
 * auto-generated .next/types/app/**\/page.ts files, but the matching
 * runtime module only exports `InstantConfigForTypeCheckInternal` —
 * the generator's name doesn't match the export name.
 *
 * Without this augmentation, `next build` (both Turbopack and webpack)
 * fails the TypeScript check on every routable page that has the
 * generated wrapper. The error is not actionable in user code; the
 * mismatch is internal to Next.
 *
 * Reaccess once Next ships a patch (track 16.1.7+). When the upstream
 * export name lines up with the generator, this file can be deleted.
 */
declare module "next/dist/build/segment-config/app/app-segment-config.js" {
  // Same shape as the real InstantConfigForTypeCheckInternal — broad
  // enough that any value Next's framework code generates satisfies
  // it. We don't try to mirror the (unstable, internal) actual type.
  export type PrefetchForTypeCheckInternal = unknown
}
