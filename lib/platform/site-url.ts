/**
 * lib/platform/site-url.ts
 *
 * THE ONE PUBLIC-ORIGIN RESOLVER (owner rule: the domain is not decided —
 * it must never be hardcoded). Four routes (sitemap, robots, llms.txt,
 * /v/[slug]) and the citation monitor each carried their own copy of this
 * function with a hardcoded fallback domain baked in; keep-one, env-only:
 *
 *   1. NEXT_PUBLIC_APP_URL — the explicit production origin (the go-live
 *      gate already requires it).
 *   2. VERCEL_URL — the deployment's own host (previews work unconfigured).
 *   3. "" — relative URLs in bare dev; never an invented domain.
 */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL
  if (explicit && explicit.trim()) return explicit.trim().replace(/\/$/, "")
  const vercel = process.env.VERCEL_URL
  if (vercel && vercel.trim()) return `https://${vercel.trim().replace(/\/$/, "")}`
  return ""
}
