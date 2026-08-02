/**
 * lib/onboarding/checkin-cadence.ts
 *
 * TENANT CHECK-IN CADENCE (tenant concierge list #8) — "scheduled check-in
 * prompts for the first week, first month, first quarter." A new account
 * hears from its built-in success manager at the three moments churn is
 * decided: day ~7 (is anything live?), day ~30 (is the team using it?),
 * day ~90 (is it paying for itself?). Each check-in is ONE notification to
 * the account's principals — warm, specific, and honest about what's live
 * vs stalled (facts from the same loader the Onboarding Decision Room
 * uses; nothing invented). Idempotent per (brokerage, window) via the
 * notification's window-tagged title; rides the EXISTING daily
 * onboarding-reminders cron (no new cron). recruiting_manager owns
 * onboarding & tenant success.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { rawRoleVariantsFor } from "@/lib/security/types"

type Svc = SupabaseClient<any, any, any>

export type CheckInWindow = "week_one" | "month_one" | "quarter_one"

/** PURE: which check-in window is this account in right now (null = none)? */
export function checkInWindow(createdAt: string, now: Date): CheckInWindow | null {
  const days = Math.floor((now.getTime() - new Date(createdAt).getTime()) / 86_400_000)
  if (days >= 5 && days <= 10) return "week_one"
  if (days >= 27 && days <= 35) return "month_one"
  if (days >= 85 && days <= 100) return "quarter_one"
  return null
}

/** PURE: the check-in copy — warm, specific, honest about live vs stalled. */
export function composeCheckIn(win: CheckInWindow, facts: { live: string[]; stalled: string[] }): { title: string; body: string } {
  const liveLine = facts.live.length > 0
    ? `Live and working: ${facts.live.join(", ")}.`
    : `Nothing is fully live yet — that's normal at this point, and it's one approval away.`
  const stalledLine = facts.stalled.length > 0
    ? `Worth a look: ${facts.stalled.join(", ")}.`
    : `Nothing looks stuck.`
  const opener =
    win === "week_one" ? `One week in — here's where you stand.` :
    win === "month_one" ? `One month in — a quick pulse on your setup.` :
    `Your first quarter is closing out — the full review is on your Command Center.`
  return {
    title: `Check-in: ${win.replace(/_/g, " ")} [${win}]`,
    body: `${opener} ${liveLine} ${stalledLine} Ask the assistant anything — someone is always here.`,
  }
}

/** LIVE runner — rides the daily onboarding-reminders cron. For each
 *  brokerage inside a window with no prior check-in for that window,
 *  notify the principals (broker/admin users). Best-effort, idempotent. */
export async function runTenantCheckIns(svc: Svc, now = new Date()): Promise<{ sent: number; skipped: number }> {
  let sent = 0, skipped = 0
  const { data: brokerages } = await svc.from("brokerages")
    .select("id, created_at")
    .gte("created_at", new Date(now.getTime() - 105 * 86_400_000).toISOString())
  for (const b of ((brokerages ?? []) as Array<{ id: string; created_at: string }>)) {
    const win = checkInWindow(b.created_at, now)
    if (!win) { skipped++; continue }
    // Idempotence: the window tag in the title is the dedupe key.
    const { data: prior } = await svc.from("notifications")
      .select("id").eq("brokerage_id", b.id).eq("type", "tenant_checkin")
      .ilike("title", `%[${win}]%`).limit(1).maybeSingle()
    if (prior) { skipped++; continue }

    // Honest live/stalled facts — same signals the Decision Room reads.
    const [{ count: contactsCount }, { count: draftsApproved }, { data: social }] = await Promise.all([
      svc.from("contacts").select("id", { count: "exact", head: true }).eq("brokerage_id", b.id),
      svc.from("agent_client_messages").select("id", { count: "exact", head: true }).eq("brokerage_id", b.id).not("approved_at", "is", null),
      svc.from("social_media_accounts").select("id").eq("brokerage_id", b.id).eq("is_active", true).limit(1).maybeSingle(),
    ])
    const live: string[] = []
    const stalled: string[] = []
    if ((contactsCount ?? 0) > 0) live.push(`${contactsCount} contacts in the book`)
    else stalled.push(`no contacts imported yet (the sphere engine is waiting)`)
    if ((draftsApproved ?? 0) > 0) live.push(`${draftsApproved} AI drafts approved`)
    else stalled.push(`no AI drafts reviewed yet (approvals are how the team earns autonomy)`)
    if (social) live.push(`social publishing connected`)
    else stalled.push(`social accounts not connected`)

    const copy = composeCheckIn(win, { live, stalled })
    // Principals first (broker/admin); a solo account with none falls back
    // to its first user — the check-in reaches whoever OWNS the account.
    let { data: principals } = await svc.from("users")
      .select("id").eq("brokerage_id", b.id)
      // broker_owner is a legal user_type but not a canonical role, so the
      // expansion cannot carry it — it is appended rather than dropped.
      .in("user_type", [...rawRoleVariantsFor(["broker", "admin", "superadmin"]), "broker_owner"])
      .limit(2)
    if (!principals || principals.length === 0) {
      const { data: anyUser } = await svc.from("users")
        .select("id").eq("brokerage_id", b.id).order("created_at", { ascending: true }).limit(1)
      principals = anyUser ?? []
    }
    let notified = false
    for (const u of ((principals ?? []) as Array<{ id: string }>).slice(0, 2)) {
      // notifications.priority CHECK vocabulary is low/medium/high/critical (live).
      const { error } = await svc.from("notifications").insert({
        brokerage_id: b.id, user_id: u.id, type: "tenant_checkin",
        title: copy.title, body: copy.body, priority: "medium",
      })
      if (!error) notified = true
    }
    if (notified) sent++; else skipped++
  }
  return { sent, skipped }
}
