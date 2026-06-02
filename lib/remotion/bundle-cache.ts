/**
 * lib/remotion/bundle-cache.ts
 *
 * Module-level cache for the Remotion bundle. Bundling Chromium-driven
 * compositions takes 30-90s; without caching, EVERY render endpoint
 * invocation re-bundles. With this cache, the first request in a process
 * lifetime bundles; subsequent requests reuse the same serveUrl.
 *
 * On Vercel functions the process lives ~15 minutes (warm) → a brokerage
 * doing 4 listing-promo renders in a row gets one bundle + three reuses,
 * saving ~2-3 minutes of compute per batch.
 *
 * The cache is keyed by entryPoint path so different compositions (e.g.
 * remotion/index.ts for marketing reels vs. remotion/index-internal.ts in
 * the future) cache independently.
 */
import "server-only"
import { bundle } from "@remotion/bundler"

const cache = new Map<string, Promise<string>>()

export async function getBundle(entryPoint: string): Promise<string> {
  let p = cache.get(entryPoint)
  if (!p) {
    p = bundle({ entryPoint }).catch((err: unknown) => {
      // On failure, evict so the next caller retries instead of inheriting
      // the rejected promise forever.
      cache.delete(entryPoint)
      throw err
    })
    cache.set(entryPoint, p)
  }
  return p
}
