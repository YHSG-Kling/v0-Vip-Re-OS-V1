// lib/agents/referral-closer.ts
//
// SPHERE MANAGER — referral closing loop. The Sphere Manager owns lifetime/closed/
// past-client relationships and the referral engine that compounds them. When a
// referred client's deal CLOSES, this closes the loop AUTONOMOUSLY:
//   · marks the matching open referral closed + records its commission
//   · credits the referring partner's lifetime value
//   · PROPOSES a partner thank-you into the client-message gate (human approves →
//     sends; thank_you_sent only flips when the human actually releases it)
//
// Mirrors the offer-strategy outcome loop: real terminal state → automatic
// bookkeeping + a governed deliverable, never an autonomous send. Idempotent (a
// referral already closed is a no-op). No fabricated commissions — uses the
// referral's own recorded/potential value, else leaves it null.

import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"

type Svc = ReturnType<typeof createServiceClient>

export interface ReferralRowLite {
  commission_amount?:   number | null
  commission_potential?: number | null
  value_estimate?:      number | null
}

/** Pure: the commission to record on close — recorded > potential > estimate > null.
 *  Never fabricates a number; a referral with no value figure closes at null. */
export function referralCommissionFor(r: ReferralRowLite): number | null {
  if (r.commission_amount != null) return Number(r.commission_amount)
  if (r.commission_potential != null) return Number(r.commission_potential)
  if (r.value_estimate != null) return Number(r.value_estimate)
  return null
}

export interface CloseReferralResult {
  closed: boolean
  referralId?: string
  commission?: number | null
  thankYouProposed: boolean
  reason?: string
}

/**
 * When a transaction closes, close the matching open referral and propose a partner
 * thank-you into the gate. Idempotent + best-effort (never fails the close path).
 */
export async function closeReferralOnDealClose(
  supabase: Svc,
  params: { transactionId: string; brokerageId: string },
): Promise<CloseReferralResult> {
  const { transactionId, brokerageId } = params

  const { data: txn } = await supabase
    .from("transactions")
    .select("id, brokerage_id, status, contact_id, buyer_contact_id, seller_contact_id, commission_amount")
    .eq("id", transactionId)
    .maybeSingle()
  const t = txn as {
    brokerage_id: string; status: string | null
    contact_id: string | null; buyer_contact_id: string | null; seller_contact_id: string | null
    commission_amount: number | null
  } | null
  if (!t || t.brokerage_id !== brokerageId) return { closed: false, thankYouProposed: false, reason: "transaction not found" }
  if (t.status !== "closed") return { closed: false, thankYouProposed: false, reason: "transaction not closed" }

  const contactIds = [t.contact_id, t.buyer_contact_id, t.seller_contact_id].filter(Boolean) as string[]
  if (contactIds.length === 0) return { closed: false, thankYouProposed: false, reason: "no contact on transaction" }

  // Find an OPEN referral for any of the transaction's contacts.
  const { data: ref } = await supabase
    .from("referrals")
    .select("id, partner_id, status, commission_amount, commission_potential, value_estimate, referred_contact_id, referral_name, thank_you_sent")
    .eq("brokerage_id", brokerageId)
    .in("referred_contact_id", contactIds)
    .not("status", "in", "(closed,lost)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  const r = ref as {
    id: string; partner_id: string | null; status: string
    commission_amount: number | null; commission_potential: number | null; value_estimate: number | null
    referred_contact_id: string | null; referral_name: string | null; thank_you_sent: boolean | null
  } | null
  if (!r) return { closed: false, thankYouProposed: false, reason: "no open referral for this deal" }

  const commission = referralCommissionFor(r)

  // Close the referral (idempotent — only when not already closed).
  await supabase
    .from("referrals")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
      converted_at: new Date().toISOString(),
      commission_amount: commission,
      updated_at: new Date().toISOString(),
    })
    .eq("id", r.id)
    .neq("status", "closed")

  // Credit the referring partner's lifetime value + received count.
  if (r.partner_id && commission != null) {
    const { data: p } = await supabase
      .from("referral_partners")
      .select("total_value_generated, total_referrals_received, partner_name")
      .eq("id", r.partner_id).maybeSingle()
    const partner = p as { total_value_generated: number | null; total_referrals_received: number | null; partner_name: string | null } | null
    if (partner) {
      await supabase.from("referral_partners").update({
        total_value_generated: (partner.total_value_generated ?? 0) + commission,
        total_referrals_received: (partner.total_referrals_received ?? 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq("id", r.partner_id)
    }
  }

  // Propose a partner thank-you into the gate — unless one was already sent.
  let thankYouProposed = false
  if (!r.thank_you_sent) {
    const partnerName = await resolvePartnerName(supabase, r.partner_id)
    const body = buildPartnerThankYou(partnerName, r.referral_name)
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId, agentKind: "sphere_of_influence", entityType: "referral", entityId: r.id,
      recipientContactId: r.referred_contact_id ?? null, audience: "agent",
      subject: "Thank you for the referral — it just closed!",
      body,
      rationale: `Referral closed${commission != null ? ` ($${Math.round(commission).toLocaleString()} value)` : ""} — review/edit the partner thank-you before it sends.`,
      channel: "portal",
    }, supabase)
    thankYouProposed = res.ok
  }

  return { closed: true, referralId: r.id, commission, thankYouProposed }
}

async function resolvePartnerName(supabase: Svc, partnerId: string | null): Promise<string> {
  if (!partnerId) return "there"
  const { data } = await supabase.from("referral_partners").select("partner_name").eq("id", partnerId).maybeSingle()
  return sanitizeProperNoun((data as { partner_name?: string } | null)?.partner_name ?? "", 60) ?? "there"
}

/** Pure: the partner-safe thank-you copy. */
export function buildPartnerThankYou(partnerName: string, referralName: string | null): string {
  const who = sanitizeProperNoun(partnerName, 60) ?? "there"
  const ref = referralName ? sanitizeProperNoun(referralName, 80) : null
  return [
    `Hi ${who},`,
    `Wonderful news — the referral${ref ? ` for ${ref}` : ""} you sent us just closed! Thank you for the trust; it genuinely means a lot.`,
    `We'd love to return the favor whenever we can. Here's to many more.`,
  ].join("\n\n")
}
