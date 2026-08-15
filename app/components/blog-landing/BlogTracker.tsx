"use client"

import { useEffect } from "react"

/**
 * Wave 31 — fires POST /api/blog/track-view exactly once on mount.
 * Uses keepalive:true so the request survives a quick close/navigate;
 * silently ignores network failures (tracker is best-effort, never
 * blocks page load). Source detection mirrors the WordPress-injected
 * tracker script from Wave 30: explicit utm_source > referrer hostname
 * heuristic > 'direct'. The ai_overview bucket captures arrivals from
 * ChatGPT browsing, Perplexity, Gemini, Google AI Overviews — the GEO
 * citation signal.
 */
export function BlogTracker({
  blogPostId,
  personaSnapshot,
  contactId,
  utmSource,
}: {
  blogPostId:       string
  personaSnapshot:  string | null
  contactId:        string | null
  utmSource:        string | null
}) {
  useEffect(() => {
    const source = utmSource ?? guessSource(typeof document !== "undefined" ? document.referrer : "")
    void fetch("/api/blog/track-view", {
      method:    "POST",
      headers:   { "Content-Type": "application/json" },
      body:      JSON.stringify({
        blog_post_id:     blogPostId,
        source,
        referrer:         typeof document !== "undefined" ? document.referrer || null : null,
        contact_id:       contactId,
        persona_snapshot: personaSnapshot,
      }),
      keepalive: true,
    }).catch(() => { /* tracker is best-effort */ })
  // Intentional: fire ONCE on mount; subsequent re-renders should not re-fire.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

function guessSource(referrer: string): string {
  if (!referrer) return "direct"
  let host = ""
  try { host = new URL(referrer).hostname } catch { return "unknown" }
  if (host.includes("newsletter") || referrer.includes("utm_source=newsletter")) return "newsletter"
  if (host.includes("facebook") || host.includes("twitter") || host.includes("linkedin") || host.includes("x.com")) return "social_post"
  if (host.includes("google") || host.includes("bing")) return "organic"
  if (host.includes("openai") || host.includes("perplexity") || host.includes("chat.") || host.includes("gemini")) return "ai_overview"
  return "unknown"
}
