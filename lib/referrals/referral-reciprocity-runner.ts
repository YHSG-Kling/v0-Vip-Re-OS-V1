// lib/referrals/referral-reciprocity-runner.ts
//
// Live side of the REFERRAL-RECIPROCITY TRACKER (Sphere of Influence). For each referral
// partner: count INBOUND (referral_partners.total_referrals_received) and, ONLY when the
// partner is linked to a marketplace vendor, count OUTBOUND from vendor_bookings — so the
// reciprocity verdict is honest (a partner with no link is "untracked", never "you sent 0").
// Best-effort BOOTSTRAP: an unlinked partner whose name EXACTLY matches one vendor is linked
// automatically (high-confidence only). On a one-sided relationship the Sphere fires ONE
// gated agent nudge + an inter-manager bus signal so the agent reciprocates/thanks the
// partner. Idempotent per (partner, status) within a slow window. Read-mostly.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import {
  buildReciprocityReport,
  normalizeName,
  type PartnerReciprocityInput,
  type PartnerReciprocity,
} from "./referral-reciprocity"
import { generatePersonaCopy, type CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

export interface ReciprocityRunInput {
  brokerageId: string
  copyGenerator?: CopyGenerator
  escalate?: boolean
  /** attempt the exact-name vendor auto-link bootstrap (default true) */
  autoLink?: boolean
}

export interface ReciprocityRunResult {
  partnersScanned: number
  linked: number
  flagged: number
  escalated: number
  untracked: number
  report: PartnerReciprocity[]
}

const OUTBOUND_STATUSES = ["booked", "confirmed", "completed", "scheduled"]
const RECENT_ALERT_DAYS = 30

export async function runReferralReciprocity(input: ReciprocityRunInput, client?: Svc): Promise<ReciprocityRunResult> {
  const svc = client ?? createServiceClient()
  const out: ReciprocityRunResult = { partnersScanned: 0, linked: 0, flagged: 0, escalated: 0, untracked: 0, report: [] }

  const { data: partners } = await svc
    .from("referral_partners")
    .select("id, partner_name, partner_type, total_referrals_received, vendor_id, agent_id, user_id, active")
    .eq("brokerage_id", input.brokerageId)
    .neq("active", false)
    .limit(1000)

  const rows = (partners ?? []) as any[]
  if (rows.length === 0) return out

  // BOOTSTRAP: exact-name vendor link for unlinked partners (high-confidence only).
  let vendorByName: Map<string, string> | null = null
  if (input.autoLink !== false && rows.some((r) => !r.vendor_id)) {
    const { data: vendors } = await svc.from("vendors").select("id, name").eq("brokerage_id", input.brokerageId).limit(2000)
    vendorByName = new Map()
    const collisions = new Set<string>()
    for (const v of (vendors ?? []) as any[]) {
      const key = normalizeName(v.name)
      if (!key) continue
      if (vendorByName.has(key)) collisions.add(key) // ambiguous name → never auto-link
      else vendorByName.set(key, v.id)
    }
    for (const c of collisions) vendorByName.delete(c)
  }

  const inputs: PartnerReciprocityInput[] = []
  for (const p of rows) {
    out.partnersScanned++
    let vendorId: string | null = p.vendor_id ?? null

    if (!vendorId && vendorByName) {
      const match = vendorByName.get(normalizeName(p.partner_name))
      if (match) {
        const { error } = await svc.from("referral_partners").update({ vendor_id: match }).eq("id", p.id)
        if (!error) { vendorId = match; out.linked++ }
      }
    }

    // Outbound is measurable ONLY when linked — otherwise null (untracked, never "0").
    let sent: number | null = null
    if (vendorId) {
      const { count } = await svc
        .from("vendor_bookings")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", input.brokerageId)
        .eq("vendor_id", vendorId)
        .in("status", OUTBOUND_STATUSES)
      sent = count ?? 0
    }

    inputs.push({
      partnerId: p.id,
      partnerName: p.partner_name ?? null,
      partnerType: p.partner_type ?? null,
      received: Number(p.total_referrals_received ?? 0),
      sent,
    })
  }

  const report = buildReciprocityReport(inputs)
  out.report = report.partners
  out.untracked = report.untracked.length

  if (input.escalate === false) { out.flagged = report.flagged.length; return out }

  const agentByPartner = new Map<string, string | null>()
  for (const p of rows) agentByPartner.set(p.id, p.agent_id ?? p.user_id ?? null)

  for (const f of report.flagged) {
    out.flagged++
    const escalated = await escalateImbalance(svc, {
      brokerageId: input.brokerageId,
      partner: f,
      agentUserId: agentByPartner.get(f.partnerId) ?? null,
      copyGenerator: input.copyGenerator,
    })
    if (escalated) out.escalated++
  }

  return out
}

async function escalateImbalance(
  svc: Svc,
  args: { brokerageId: string; partner: PartnerReciprocity; agentUserId: string | null; copyGenerator?: CopyGenerator },
): Promise<boolean> {
  const { partner } = args
  // IDEMPOTENCY: one nudge per (partner, status) within the slow reciprocity window.
  const dedupeKey = `RECIPROCITY:${partner.partnerId}:${partner.status}`
  const sinceIso = new Date(Date.now() - RECENT_ALERT_DAYS * 86_400_000).toISOString()
  const { data: prior } = await svc
    .from("notifications")
    .select("id")
    .eq("entity_id", partner.partnerId)
    .eq("type", "referral_reciprocity")
    .ilike("body", `%${dedupeKey}%`)
    .gte("created_at", sinceIso)
    .limit(1)
    .maybeSingle()
  if (prior) return false

  const draft = await generatePersonaCopy(
    {
      goal:
        partner.status === "one_sided_inbound"
          ? "a short internal nudge to the agent that a referral partner keeps sending business and hasn't been reciprocated or thanked, so the agent protects the relationship"
          : "a short internal nudge to the agent that they keep sending a partner business without reciprocation, suggesting a direct two-way-referral conversation",
      facts: [partner.message],
      channel: "portal",
      persona: { audience: "agent", situation: "referral partner reciprocity imbalance" },
      words: 50,
    },
    { body: partner.message },
    { generator: args.copyGenerator },
  )

  let escalated = false
  try {
    if (args.agentUserId) {
      await svc.from("notifications").insert({
        user_id: args.agentUserId, brokerage_id: args.brokerageId, type: "referral_reciprocity",
        title: partner.status === "one_sided_inbound" ? "Reciprocate a top referrer" : "One-way referral relationship",
        body: `${draft.body}\n\n[${dedupeKey}]`,
        entity_type: "referral_partner", entity_id: partner.partnerId, priority: "medium",
      }).then(() => {}, () => {})
    }
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const sig = await publishManagerSignal({
      brokerageId: args.brokerageId, fromManager: "sphere_of_influence", toManager: "campaign_orchestrator",
      signalType: "referral_reciprocity", message: draft.body,
      entityType: "referral_partner", entityId: partner.partnerId,
      payload: { status: partner.status, received: partner.received, sent: partner.sent, imbalance: partner.imbalance },
    }, svc)
    escalated = sig.ok || !!args.agentUserId
  } catch { /* best-effort */ }
  return escalated
}
