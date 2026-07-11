/**
 * lib/referrals/partner-agreement-watch.ts
 *
 * PARTNER AGREEMENT EXPIRY WATCH — the referral-partner increment that
 * closes a silent lapse: referral_partners carries agreement_end_date
 * (written from the partner UI), but NOTHING watched it — a referral fee
 * agreement or partnership term could expire unnoticed, and the next
 * referral would arrive with no enforceable agreement behind it (a real
 * commission-dispute exposure).
 *
 * The Sphere of Influence manager (partner-relationship owner) sweeps
 * ACTIVE partners whose agreement ends within the renewal window (30d)
 * or has already lapsed, and raises ONE gated renewal escalation per
 * partner: a notification to the owning agent + the
 * partner_agreement_lapsing signal on the bus ("lapsing" → escalation
 * kind, same family as license_lapsing). Nothing auto-renews, nothing
 * auto-contacts the partner — the human owns the conversation.
 *
 * The window decision is PURE; the sweep dedupes per open (partner)
 * signal so an unactioned renewal never spams. Rides the referral-asks
 * cron beside the reciprocity tracker — no new cron.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export const RENEWAL_WINDOW_DAYS = 30

export type AgreementUrgency = "lapsed" | "expiring" | "current" | "untracked"

/** PURE: where does this agreement stand relative to today? */
export function agreementUrgency(agreementEndDate: string | null | undefined, todayIso: string): AgreementUrgency {
  if (!agreementEndDate) return "untracked"
  const end = Date.parse(String(agreementEndDate).slice(0, 10))
  const today = Date.parse(todayIso.slice(0, 10))
  if (Number.isNaN(end) || Number.isNaN(today)) return "untracked"
  if (end < today) return "lapsed"
  if (end - today <= RENEWAL_WINDOW_DAYS * 86_400_000) return "expiring"
  return "current"
}

export interface AgreementWatchResult {
  scanned: number
  lapsed: number
  expiring: number
  escalated: number
}

export async function runPartnerAgreementWatch(
  svc: Svc,
  input: { brokerageId: string },
): Promise<AgreementWatchResult> {
  const out: AgreementWatchResult = { scanned: 0, lapsed: 0, expiring: 0, escalated: 0 }
  const todayIso = new Date().toISOString()

  const { data: partners } = await svc
    .from("referral_partners")
    .select("id, partner_name, partner_type, agreement_type, agreement_end_date, agent_id, user_id, total_referrals_received")
    .eq("brokerage_id", input.brokerageId)
    .neq("active", false)
    .not("agreement_end_date", "is", null)
    .limit(1000)

  for (const p of ((partners ?? []) as any[])) {
    out.scanned++
    const urgency = agreementUrgency(p.agreement_end_date, todayIso)
    if (urgency !== "lapsed" && urgency !== "expiring") continue
    if (urgency === "lapsed") out.lapsed++
    else out.expiring++

    // One open renewal escalation per partner (publishManagerSignal dedupes
    // per open (to, type, entity) — an unactioned renewal stands).
    const endDate = String(p.agreement_end_date).slice(0, 10)
    const name = p.partner_name ?? "A referral partner"
    const received = Number(p.total_referrals_received ?? 0)
    const message = urgency === "lapsed"
      ? `${name}'s ${String(p.agreement_type ?? "referral").replace(/_/g, " ")} agreement LAPSED on ${endDate}${received > 0 ? ` — they've sent ${received} referral${received === 1 ? "" : "s"}` : ""}. A referral arriving now has no enforceable agreement behind it; renew or retire the partnership.`
      : `${name}'s ${String(p.agreement_type ?? "referral").replace(/_/g, " ")} agreement ends ${endDate}${received > 0 ? ` — they've sent ${received} referral${received === 1 ? "" : "s"}` : ""}. Renew before it lapses so the next referral is covered.`

    try {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      const sig = await publishManagerSignal({
        brokerageId: input.brokerageId,
        fromManager: "sphere_of_influence",
        toManager: "compliance_officer",
        signalType: "partner_agreement_lapsing",
        message,
        entityType: "referral_partner",
        entityId: p.id,
        payload: { partner_id: p.id, agreement_end_date: endDate, urgency },
      }, svc)
      if (sig.ok && !sig.reason) {
        // Fresh escalation (not the open-signal dedupe): notify the owning agent too.
        const ownerUserId = (p.user_id as string | null) ?? null
        if (ownerUserId) {
          await svc.from("notifications").insert({
            user_id: ownerUserId,
            brokerage_id: input.brokerageId,
            type: "partner_agreement_lapsing",
            title: urgency === "lapsed" ? "Partner agreement lapsed" : "Partner agreement expiring",
            body: message,
            entity_type: "referral_partner",
            entity_id: p.id,
            priority: urgency === "lapsed" ? "high" : "medium",
          }).then(() => {}, () => {})
        }
        out.escalated++
      }
    } catch { /* best-effort per partner */ }
  }

  return out
}
