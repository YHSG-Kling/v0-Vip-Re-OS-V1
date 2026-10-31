"use server"

// Agent-to-agent client referral network — the same-brokerage agent directory (for the map), creating a
// referral, and the referring agent's outbound referrals + earned fees.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { listReferralAgents, createAgentReferral, computeReferralFee, type AgentDirectoryEntry, type OutboundReferral } from "@/lib/referrals/agent-referral"
import { referralCommissionFor } from "@/lib/agents/referral-closer"

async function resolveAgent(): Promise<{ ok: true; brokerageId: string; agentId: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const svc = createServiceClient()
  const { data: agent } = await svc.from("agents").select("id, brokerage_id").eq("user_id", user.id).maybeSingle()
  if (!agent?.brokerage_id || !(agent as any).id) return { ok: false, error: "No agent profile" }
  return { ok: true, brokerageId: (agent as any).brokerage_id, agentId: (agent as any).id }
}

export async function getReferralNetwork(): Promise<{
  ok: boolean; error?: string; agents?: AgentDirectoryEntry[]; outbound?: OutboundReferral[]; earnedTotal?: number
}> {
  const ctx = await resolveAgent()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  const svc = createServiceClient()

  const agents = await listReferralAgents(svc, { brokerageId: ctx.brokerageId, excludeAgentId: ctx.agentId })

  // My outbound referrals + earned fees (referral distributions booked to me by the waterfall's step 03b).
  //
  // WAVE 143 (lane 143C): `earnedFee` was a constant null (`r.status === "closed" ? null : null`) and `earnedTotal` summed
  // every referral row INCLUDING voided ones. Now: the fee booked for the deal each referral closed on (the link
  // referrals.transaction_id, m812), LIVE rows only; an open referral shows what the agreed percent would pay on the
  // referral's own recorded value, or nothing when no figure is recorded.
  const REF_COLS = "id, status, referral_fee_pct, referred_contact_id, agent_id, commission_amount, commission_potential, value_estimate, contacts:referred_contact_id(first_name, last_name), receiver:agent_id(users(first_name, last_name))"
  let refsRes = await svc.from("referrals")
    .select(`${REF_COLS}, transaction_id`)
    .eq("brokerage_id", ctx.brokerageId).eq("referring_agent_id", ctx.agentId).order("created_at", { ascending: false }).limit(200)
  // m812 not applied yet: the link column is absent - read the list without it (earned per referral then shows nothing, the total stays true).
  if (refsRes.error && /transaction_id|does not exist|schema cache/i.test(refsRes.error.message)) {
    refsRes = await svc.from("referrals")
      .select(REF_COLS)
      .eq("brokerage_id", ctx.brokerageId).eq("referring_agent_id", ctx.agentId).order("created_at", { ascending: false }).limit(200) as typeof refsRes
  }
  if (refsRes.error) return { ok: false, error: `Could not read your referrals: ${refsRes.error.message}` }
  const refs = refsRes.data
  const { data: dists, error: distsError } = await svc.from("commission_distributions")
    .select("calculated_amount, transaction_id, status").eq("brokerage_id", ctx.brokerageId).eq("agent_id", ctx.agentId).eq("distribution_type", "referral")
  if (distsError) return { ok: false, error: `Could not read your referral income: ${distsError.message}` }
  const liveDists = ((dists ?? []) as any[]).filter((d) => String(d.status ?? "").toLowerCase() !== "voided")
  const earnedTotal = liveDists.reduce((s, d) => s + Number(d.calculated_amount ?? 0), 0)
  const earnedByTxn = new Map<string, number>()
  for (const d of liveDists) if (d.transaction_id) earnedByTxn.set(d.transaction_id, (earnedByTxn.get(d.transaction_id) ?? 0) + Number(d.calculated_amount ?? 0))

  const outbound: OutboundReferral[] = ((refs ?? []) as any[]).map((r) => {
    const c = Array.isArray(r.contacts) ? r.contacts[0] : r.contacts
    const rec = Array.isArray(r.receiver) ? r.receiver[0] : r.receiver
    const recU = rec ? (Array.isArray(rec.users) ? rec.users[0] : rec.users) : null
    const earned = r.transaction_id ? earnedByTxn.get(r.transaction_id) ?? null : null
    const basis = referralCommissionFor(r)
    return {
      id: r.id,
      contactName: c ? [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || null : null,
      receivingAgentName: recU ? [recU.first_name, recU.last_name].filter(Boolean).join(" ").trim() || null : null,
      status: r.status,
      feePct: r.referral_fee_pct ?? null,
      earnedFee: earned === null ? null : Math.round(earned * 100) / 100,
      expectedFee: r.status === "closed" || basis === null || r.referral_fee_pct == null ? null : computeReferralFee(basis, Number(r.referral_fee_pct)),
    }
  })

  return { ok: true, agents, outbound, earnedTotal: Math.round(earnedTotal * 100) / 100 }
}

export async function createAgentReferralAction(input: { receivingAgentId: string; contactId: string; feePct: number; notes?: string }): Promise<{ ok: boolean; error?: string; referralId?: string }> {
  const ctx = await resolveAgent()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  const svc = createServiceClient()
  return createAgentReferral(svc, {
    brokerageId: ctx.brokerageId, referringAgentId: ctx.agentId,
    receivingAgentId: input.receivingAgentId, contactId: input.contactId, feePct: input.feePct, notes: input.notes,
  })
}
