/**
 * app/robots.ts — Wave 39 GEO.
 *
 * The opposite of the default "block the AI bots" posture: we EXPLICITLY
 * welcome the AI-search crawlers so the public /v/[slug] video pages get
 * read + cited by ChatGPT browse / Perplexity / Google AI Overviews /
 * Claude. Dashboard / API / auth surfaces stay disallowed.
 */
import type { MetadataRoute } from "next"
import { AI_CRAWLER_BOTS } from "@/lib/geo/video-landing"

import { siteUrl } from "@/lib/platform/site-url"

const DISALLOW = ["/dashboard", "/api/", "/admin", "/portal", "/settings", "/login", "/signup"]
const ALLOW = ["/v/", "/p/", "/listing", "/open-house", "/home-value"]

export default function robots(): MetadataRoute.Robots {
  const base = { allow: ALLOW, disallow: DISALLOW }
  return {
    rules: [
      { userAgent: "*", ...base },
      // Explicit welcome for the AI crawlers (signals intent even though
      // "*" already permits them).
      ...AI_CRAWLER_BOTS.map((ua) => ({ userAgent: ua, ...base })),
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
    host: siteUrl(),
  }
}
