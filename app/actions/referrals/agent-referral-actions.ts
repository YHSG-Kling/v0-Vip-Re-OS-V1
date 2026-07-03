"use server"

// Agent-to-agent client referral network — the same-brokerage agent directory (for the map), creating a
// referral, and the referring agent's outbound referrals + earned fees.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { listReferralAgents, createAgentReferral, type AgentDirectoryEntry, type OutboundReferral } from "@/lib/referrals/agent-referral"

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

  // My outbound referrals + earned fees (referral distributions booked to me).
  const { data: refs } = await svc.from("referrals")
    .select("id, status, referral_fee_pct, referred_contact_id, agent_id, contacts:referred_contact_id(first_name, last_name), receiver:agent_id(users(first_name, last_name))")
    .eq("brokerage_id", ctx.brokerageId).eq("referring_agent_id", ctx.agentId).order("created_at", { ascending: false }).limit(200)
  const { data: dists } = await svc.from("commission_distributions")
    .select("calculated_amount").eq("brokerage_id", ctx.brokerageId).eq("agent_id", ctx.agentId).eq("distribution_type", "referral")
  const earnedTotal = ((dists ?? []) as any[]).reduce((s, d) => s + Number(d.calculated_amount ?? 0), 0)

  const outbound: OutboundReferral[] = ((refs ?? []) as any[]).map((r) => {
    const c = Array.isArray(r.contacts) ? r.contacts[0] : r.contacts
    const rec = Array.isArray(r.receiver) ? r.receiver[0] : r.receiver
    const recU = rec ? (Array.isArray(rec.users) ? rec.users[0] : rec.users) : null
    return {
      id: r.id,
      contactName: c ? [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || null : null,
      receivingAgentName: recU ? [recU.first_name, recU.last_name].filter(Boolean).join(" ").trim() || null : null,
      status: r.status,
      feePct: r.referral_fee_pct ?? null,
      earnedFee: r.status === "closed" ? null : null, // per-referral fee is booked as a distribution on close
    }
  })

  return { ok: true, agents, outbound, earnedTotal: Math.round(earnedTotal * 100) / 100 }
}

export async function createAgentReferralAction(input: { receivingAgentId: string; contactId: string; feePct?: number; notes?: string }): Promise<{ ok: boolean; error?: string; referralId?: string }> {
  const ctx = await resolveAgent()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  const svc = createServiceClient()
  return createAgentReferral(svc, {
    brokerageId: ctx.brokerageId, referringAgentId: ctx.agentId,
    receivingAgentId: input.receivingAgentId, contactId: input.contactId, feePct: input.feePct, notes: input.notes,
  })
}
