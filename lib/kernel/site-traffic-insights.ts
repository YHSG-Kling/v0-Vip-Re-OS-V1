/**
 * lib/kernel/site-traffic-insights.ts
 *
 * SITE TRAFFIC LEARNING (owner rule: "make sure their website pages learn
 * and adjust to their traffic"). The visitor tables were already recording
 * (website_visitors, site_activity, smart_landing_sessions) — NOTHING read
 * them back. This closes the loop the governed way: pure composeSiteInsights
 * turns the trailing-30d traffic into what a web strategist would say —
 * where visitors go, where they STAY (time-on-page is the honest signal),
 * where they bounce, which source converts — and ONE concrete adjustment
 * suggestion per week, delivered as a GATED principal notification
 * (idempotent per ISO-week; nothing auto-mutates a public page). Rides the
 * existing proactive-intelligence cron. marketing_agent owns the tenant's
 * web presence. NOT server-only (simulator-driven).
 */

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export interface PageTraffic {
  page: string
  visits: number
  avgSeconds: number
}

export interface SiteInsights {
  topPage: PageTraffic | null
  stickiest: PageTraffic | null
  bounciest: PageTraffic | null
  topSource: string | null
  adjustment: string | null
}

/** PURE: what the traffic says, and the ONE adjustment worth making. */
export function composeSiteInsights(rows: Array<{ page: string | null; seconds: number | null; source?: string | null }>): SiteInsights {
  const byPage = new Map<string, { visits: number; totalSeconds: number }>()
  const bySource = new Map<string, number>()
  for (const r of rows) {
    const page = (r.page ?? "").trim()
    if (page) {
      const cur = byPage.get(page) ?? { visits: 0, totalSeconds: 0 }
      cur.visits += 1
      cur.totalSeconds += Math.max(0, r.seconds ?? 0)
      byPage.set(page, cur)
    }
    const src = (r.source ?? "").trim()
    if (src) bySource.set(src, (bySource.get(src) ?? 0) + 1)
  }
  const pages: PageTraffic[] = Array.from(byPage.entries())
    .map(([page, v]) => ({ page, visits: v.visits, avgSeconds: v.visits > 0 ? Math.round(v.totalSeconds / v.visits) : 0 }))

  if (pages.length === 0) return { topPage: null, stickiest: null, bounciest: null, topSource: null, adjustment: null }

  const topPage = [...pages].sort((a, b) => b.visits - a.visits)[0] ?? null
  // Sticky/bouncy verdicts need real sample — never a claim from 2 visits.
  const sampled = pages.filter((p) => p.visits >= 5)
  const stickiest = sampled.length > 0 ? [...sampled].sort((a, b) => b.avgSeconds - a.avgSeconds)[0]! : null
  const bounciest = sampled.length > 1 ? [...sampled].sort((a, b) => a.avgSeconds - b.avgSeconds)[0]! : null
  const topSource = bySource.size > 0 ? [...bySource.entries()].sort((a, b) => b[1] - a[1])[0]![0] : null

  let adjustment: string | null = null
  if (stickiest && bounciest && stickiest.page !== bounciest.page && stickiest.avgSeconds >= bounciest.avgSeconds * 3) {
    adjustment = `Visitors stay ${Math.round(stickiest.avgSeconds / Math.max(1, bounciest.avgSeconds))}× longer on ${stickiest.page} than on ${bounciest.page} — feature that content (or link to it) from ${bounciest.page} before they bounce.`
  } else if (topPage && stickiest && topPage.page !== stickiest.page && stickiest.avgSeconds >= 60) {
    adjustment = `${stickiest.page} holds visitors ${stickiest.avgSeconds}s on average but gets less traffic than ${topPage.page} — promote it from your busiest page.`
  } else if (topSource && topPage) {
    adjustment = `Most visitors arrive from ${topSource} and land on ${topPage.page} — make sure that page answers what a ${topSource} visitor came for.`
  }

  return { topPage, stickiest, bounciest, topSource, adjustment }
}

/** LIVE: weekly, per brokerage with traffic — ONE gated insights notification
 *  to the principals (idempotent per ISO-week via the title tag). */
export async function runSiteTrafficInsights(svc: Svc, now = new Date()): Promise<{ sent: number; skipped: number }> {
  const week = (() => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const day = d.getUTCDay() || 7
    d.setUTCDate(d.getUTCDate() + 4 - day)
    const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
    return `${d.getUTCFullYear()}-W${String(Math.ceil((((d.getTime() - y0.getTime()) / 86_400_000) + 1) / 7)).padStart(2, "0")}`
  })()
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString()
  let sent = 0, skipped = 0

  const { data: visitors } = await svc.from("website_visitors")
    .select("brokerage_id, page_url, time_on_page_seconds, utm_source, referrer")
    .gte("last_seen_at", since).limit(2000)
  const byBrokerage = new Map<string, Array<{ page: string | null; seconds: number | null; source?: string | null }>>()
  for (const v of ((visitors ?? []) as any[])) {
    if (!v.brokerage_id) continue
    const arr = byBrokerage.get(v.brokerage_id) ?? []
    arr.push({ page: v.page_url, seconds: v.time_on_page_seconds, source: v.utm_source ?? v.referrer })
    byBrokerage.set(v.brokerage_id, arr)
  }

  for (const [brokerageId, rows] of byBrokerage) {
    if (rows.length < 10) { skipped++; continue } // honest: no verdicts from a trickle
    const insights = composeSiteInsights(rows)
    if (!insights.adjustment) { skipped++; continue }

    const title = `Your site learned from its traffic [site:${week}]`
    const { data: prior } = await svc.from("notifications")
      .select("id").eq("brokerage_id", brokerageId).eq("type", "site_insights")
      .ilike("title", `%[site:${week}]%`).limit(1).maybeSingle()
    if (prior) { skipped++; continue }

    let { data: principals } = await svc.from("users")
      .select("id").eq("brokerage_id", brokerageId)
      .in("role", ["broker", "admin", "super_admin", "broker_owner"]).limit(2)
    if (!principals || principals.length === 0) {
      const { data: anyUser } = await svc.from("users")
        .select("id").eq("brokerage_id", brokerageId).order("created_at", { ascending: true }).limit(1)
      principals = anyUser ?? []
    }
    const body = [
      insights.topPage ? `Busiest page: ${insights.topPage.page} (${insights.topPage.visits} visits).` : null,
      insights.stickiest ? `Visitors stay longest on ${insights.stickiest.page} (~${insights.stickiest.avgSeconds}s).` : null,
      insights.topSource ? `Most traffic arrives from ${insights.topSource}.` : null,
      `Suggested adjustment: ${insights.adjustment}`,
      `Nothing changes automatically — this is your site's weekly read.`,
    ].filter(Boolean).join(" ")

    let notified = false
    for (const u of ((principals ?? []) as Array<{ id: string }>).slice(0, 2)) {
      const { error } = await svc.from("notifications").insert({
        brokerage_id: brokerageId, user_id: u.id, type: "site_insights",
        title, body, priority: "medium",
      })
      if (!error) notified = true
    }
    if (notified) sent++; else skipped++
  }
  return { sent, skipped }
}
