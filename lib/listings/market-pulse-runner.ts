// lib/listings/market-pulse-runner.ts
// ─────────────────────────────────────────────────────────────────────────────
// MARKET PULSE writer (Campaign Orchestrator domain). Once per week, distill recent home-BUYER forum
// chatter into a seller-safe "what buyers want now" pulse and store it for the seller portal. National
// (one pulse per week, shared by every brokerage) so the expensive scrape + AI distill runs ONCE per
// week, not per brokerage. Idempotent on (scope, pulse_week); best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { FALLBACK_MARKET_PULSE, sanitizeMarketPulse, marketPulseWeek, buildMarketPulsePrompt, type MarketPulse } from "./market-pulse"

type Svc = ReturnType<typeof createServiceClient>

const BUYER_SUBREDDITS = ["FirstTimeHomeBuyer", "RealEstate", "Homebuying"]

export interface MarketPulseResult { generated: boolean; reused: boolean; insightCount: number; sourceCount: number }

export async function ensureNationalMarketPulse(client?: Svc, opts?: { now?: Date }): Promise<MarketPulseResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const week = marketPulseWeek(now)
  try {
    // Idempotent per week — only scrape + distill once.
    const { data: existing } = await svc.from("market_pulse")
      .select("id").eq("scope", "national").eq("pulse_week", week).limit(1).maybeSingle()
    if (existing) return { generated: false, reused: true, insightCount: 0, sourceCount: 0 }

    // Scrape recent buyer-forum thread titles (each subreddit best-effort).
    const { fetchTopThreads } = await import("@/lib/content-intel/reddit-scraper")
    const titles: string[] = []
    for (const sub of BUYER_SUBREDDITS) {
      try {
        const threads = await fetchTopThreads({ subreddit: sub, window: "week" })
        for (const t of threads) if (t.title) titles.push(t.title)
      } catch { /* one subreddit failing never blocks the pulse */ }
    }

    // Distill via the gateway → seller-safe sanitized pulse; fall back to the evergreen floor.
    let pulse: MarketPulse | null = null
    if (titles.length >= 5) {
      try {
        const { generateTextRouted } = await import("@/lib/ai/models")
        const { text } = await generateTextRouted({ feature: "market_pulse", prompt: buildMarketPulsePrompt(titles), temperature: 0.4, maxTokens: 500 })
        pulse = sanitizeMarketPulse(parseJson(text), week)
      } catch { /* gateway down → fallback */ }
    }
    const finalPulse: MarketPulse = pulse ?? { ...FALLBACK_MARKET_PULSE, week }

    const { error } = await svc.from("market_pulse").upsert({
      scope: "national", brokerage_id: null, pulse_week: week,
      insights: finalPulse, source_count: titles.length, generated_at: now.toISOString(),
    }, { onConflict: "scope,pulse_week" })
    return { generated: !error, reused: false, insightCount: finalPulse.insights.length, sourceCount: titles.length }
  } catch {
    return { generated: false, reused: false, insightCount: 0, sourceCount: 0 }
  }
}

function parseJson(text: string): unknown {
  try {
    let s = text.trim()
    if (s.startsWith("```json")) s = s.slice(7)
    if (s.startsWith("```")) s = s.slice(3)
    if (s.endsWith("```")) s = s.slice(0, -3)
    return JSON.parse(s.trim())
  } catch { return null }
}
