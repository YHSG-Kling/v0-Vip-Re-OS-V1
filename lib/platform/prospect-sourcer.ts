/**
 * lib/platform/prospect-sourcer.ts
 *
 * THE PLATFORM HUNTS ITS OWN CUSTOMERS (owner correction: the platform
 * does no real-estate deals — it looks for agents/teams/brokerages to
 * SELL THE OS TO). This is the growth funnel's missing SOURCING loop:
 * the same scraping muscle the tenants get, pointed at OS-BUYING intent
 * — people publicly shopping for real-estate tech ("best CRM for
 * realtors", "<competitor> alternative", "AI assistant for real estate")
 * or running teams/brokerages and asking for tooling.
 *
 * HONEST + provider-gated like every scraper: rides the same Apify
 * Reddit lane the recruit-sourcer uses (unconfigured = clean zero, never
 * fabricated prospects); pseudonymous handles are captured with their
 * source URL so platform staff can engage IN THE THREAD — nothing
 * auto-sends, and no prospect is ever invented from a keyword alone.
 * Tier interest is INFERRED from the language (team/brokerage terms) and
 * defaults to solo_agent. Idempotent by email when present, else by
 * source-record dedupe key in interest_note.
 *
 * Each weekly pass ends with ONE platform-staff digest (deduped per ISO
 * week) carrying the new prospects + a composed outreach draft each
 * (composeProspectOutreach — the funnel's own composer). Rides the daily
 * lead-scraping cron behind an ISO-week gate; platform staff work the
 * funnel from /dashboard/superadmin (platform_prospects CRUD already
 * exists). NOT server-only (simulator-driven).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { composeProspectOutreach, type ProspectRole } from "@/lib/platform/growth-funnel"

type Svc = SupabaseClient<any, any, any>

/** OS-buying intent — tech-shopping language, NOT deal/switch language
 *  (that belongs to the tenants' recruit pipeline). */
export const OS_INTENT_TERMS: string[] = [
  "best crm for real estate",
  "best crm for realtors",
  "real estate crm recommendation",
  "lofty alternative",
  "moxiworks alternative",
  "realscout alternative",
  "follow up boss alternative",
  "kvcore alternative",
  "ai assistant for real estate",
  "ai for realtors",
  "automate my real estate business",
  "transaction management software",
  "brokerage software recommendation",
  "team crm real estate",
]

/** PURE: infer the tier a prospect is shopping for from their language. */
export function inferProspectRole(text: string): ProspectRole {
  const t = text.toLowerCase()
  if (/\b(brokerage|broker owner|my brokerage|our office|multi.?office|franchise)\b/.test(t)) return "brokerage"
  if (/\b(my team|our team|team lead|team of \d+|team crm)\b/.test(t)) return "team"
  return "solo_agent"
}

/** PURE: the stable dedupe key for a pseudonymous prospect (no email). */
export function prospectDedupeKey(source: string, recordId: string): string {
  return `src:${source}:${recordId}`
}

export interface ProspectSourceResult {
  scanned: number
  captured: number
  digestSent: boolean
  errors: string[]
}

/** ISO week label (matches the podcast auto-run convention). */
export function isoWeekOf(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

/**
 * The weekly platform hunt. Idempotent per ISO week (digest-notification
 * keyed); provider-gated (no Apify = clean zero).
 */
export async function sourcePlatformProspects(
  svc: Svc,
  opts: { now?: Date } = {},
): Promise<ProspectSourceResult> {
  const out: ProspectSourceResult = { scanned: 0, captured: 0, digestSent: false, errors: [] }
  const now = opts.now ?? new Date()
  const week = isoWeekOf(now)

  // ISO-week idempotency — one hunt per week, keyed on the digest marker.
  const { data: already } = await svc.from("notifications")
    .select("id")
    .eq("type", "platform_prospect_digest")
    .ilike("body", `%[week:${week}]%`)
    .limit(1)
    .maybeSingle()
  if (already) return out

  const captured: Array<{ name: string; role: ProspectRole; note: string; sourceUrl: string | null }> = []

  try {
    const { scrapeRedditPosts } = await import("@/lib/external/apify-client")
    const reddit = await scrapeRedditPosts({
      subreddits: ["realtors", "RealEstate", "realestateinvesting"],
      keywords: OS_INTENT_TERMS,
      limit: 60,
    }).catch(() => ({ posts: [] as Array<Record<string, any>> }))

    for (const post of (reddit.posts ?? [])) {
      out.scanned++
      const text = `${post.title ?? ""} ${post.body ?? ""}`
      const matched = OS_INTENT_TERMS.find((t) => text.toLowerCase().includes(t))
      if (!matched) continue
      const handle = (post.author ?? post.username ?? "").toString().trim()
      if (!handle) continue
      const recordId = String(post.post_id ?? post.id ?? post.url ?? handle)
      const dedupe = prospectDedupeKey("reddit_os_intent", recordId)

      // Idempotent by dedupe key (pseudonymous — no email to conflict on).
      const { data: dup } = await svc.from("platform_prospects")
        .select("id").ilike("interest_note", `%${dedupe}%`).limit(1).maybeSingle()
      if (dup) continue

      const role = inferProspectRole(text)
      const note = `OS-buying intent ("${matched}") on r/${post.subreddit ?? "realtors"}. Engage in-thread: ${post.url ?? "(no url)"} [${dedupe}]`
      const { error } = await svc.from("platform_prospects").insert({
        name: `u/${handle}`,
        email: null,
        company: null,
        role_interest: role,
        source: "reddit_os_intent",
        status: "new",
        interest_note: note,
      })
      if (!error) {
        out.captured++
        captured.push({ name: `u/${handle}`, role, note: `"${matched}"`, sourceUrl: post.url ?? null })
      }
    }
  } catch (e: any) {
    out.errors.push(`reddit_os_intent: ${e?.message ?? String(e)}`)
  }

  // ONE weekly digest to platform staff — the new prospects + a composed
  // outreach draft each. Human-sent, never automated to the prospect.
  try {
    const { data: brandRow } = await svc.from("platform_settings").select("product_brand").limit(1).maybeSingle()
    const brandName = ((brandRow as any)?.product_brand?.name as string | null) ?? null
    const { data: staff } = await svc.from("users")
      .select("id")
      .in("platform_role", ["superadmin", "marketing", "support"])
      .limit(10)
    const staffRows = (staff ?? []) as Array<{ id: string }>
    if (staffRows.length > 0) {
      const lines = captured.length > 0
        ? captured.slice(0, 10).map((c) => {
            const draft = composeProspectOutreach({ name: c.name, roleInterest: c.role, company: null, brandName })
            return `· ${c.name} (${c.role}) — ${c.note}${c.sourceUrl ? ` — ${c.sourceUrl}` : ""}\n  Draft: ${draft.subject}`
          }).join("\n")
        : "No new OS-intent prospects captured this week (provider-gated: zero also means the scrape lane isn't configured)."
      for (const s of staffRows) {
        await svc.from("notifications").insert({
          user_id: s.id,
          type: "platform_prospect_digest",
          title: `🎯 Platform prospects — week ${week}: ${captured.length} new`,
          body: `${lines}\n\nWork the funnel in the superadmin growth board. Nothing auto-sends. [week:${week}]`,
          priority: "medium",
          is_read: false,
        }).then(() => {}, () => {})
      }
      out.digestSent = true
    }
  } catch (e: any) {
    out.errors.push(`digest: ${e?.message ?? String(e)}`)
  }

  return out
}
