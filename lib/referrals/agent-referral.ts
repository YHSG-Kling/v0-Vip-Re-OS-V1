// lib/referrals/agent-referral.ts
//
// AGENT-TO-AGENT REFERRALS — an agent whose client is moving out of their area refers them to another
// agent in the SAME (multi-location or nationwide) brokerage, and earns a referral fee when that deal
// closes. Runs on the existing referrals table (additive columns, no parallel system) and books the fee
// on the canonical commission_distributions rail (distribution_type 'referral') via the referral-closer.
// The agent directory (grouped by location) feeds the map so an agent can find the right person to refer.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** PURE: the referral fee owed to the referring agent = the deal commission × the agreed fee %. */
export function computeReferralFee(dealCommission: number | null, feePct: number | null): number {
  const gross = Math.max(0, Number(dealCommission ?? 0))
  const pct = Math.min(100, Math.max(0, Number(feePct ?? 0)))
  return Math.round(gross * (pct / 100) * 100) / 100
}

export interface AgentDirectoryEntry {
  agentId: string
  name: string
  city: string | null
  state: string | null
  locationId: string | null
  locationName: string | null
}

export interface OutboundReferral {
  id: string
  contactName: string | null
  receivingAgentName: string | null
  status: string
  feePct: number | null
  earnedFee: number | null
}

/**
 * The same-brokerage agents an agent can refer to, with their location (for the map / directory).
 * Excludes the requesting agent. Ordered by state then city so the map/directory groups naturally.
 */
export async function listReferralAgents(svc: Svc, params: { brokerageId: string; excludeAgentId?: string }): Promise<AgentDirectoryEntry[]> {
  // City/state live on the agent's LOCATION (agents has no city/state), so the map groups by office.
  const { data: agents } = await svc.from("agents")
    .select("id, location_id, user_id, users(first_name, last_name), locations:location_id(name, city, state)")
    .eq("brokerage_id", params.brokerageId).eq("is_active", true).not("user_id", "is", null).limit(2000)
  const out: AgentDirectoryEntry[] = []
  for (const a of (agents ?? []) as any[]) {
    if (params.excludeAgentId && a.id === params.excludeAgentId) continue
    const u = Array.isArray(a.users) ? a.users[0] : a.users
    const loc = Array.isArray(a.locations) ? a.locations[0] : a.locations
    out.push({
      agentId: a.id,
      name: [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() || "An agent",
      city: loc?.city ?? null, state: loc?.state ?? null, locationId: a.location_id ?? null, locationName: loc?.name ?? null,
    })
  }
  return out.sort((x, y) => (x.state ?? "").localeCompare(y.state ?? "") || (x.city ?? "").localeCompare(y.city ?? "") || x.name.localeCompare(y.name))
}

export interface CreateAgentReferralInput {
  brokerageId: string
  referringAgentId: string
  receivingAgentId: string
  contactId: string
  /** The agreed referral fee % — negotiated between the agents, never assumed by the platform. */
  feePct: number
  notes?: string
}

/** Create an agent-to-agent referral. The fee % is whatever the two agents agree — the platform never
 *  assumes one. The fee is booked when the deal closes. */
export async function createAgentReferral(svc: Svc, input: CreateAgentReferralInput): Promise<{ ok: boolean; referralId?: string; error?: string }> {
  if (input.referringAgentId === input.receivingAgentId) return { ok: false, error: "An agent can't refer to themselves." }
  const feePct = input.feePct
  if (!(feePct > 0) || feePct > 100) return { ok: false, error: "Enter the agreed referral fee (1-100%)." }
  // One open referral per (contact, referring→receiving) — don't double-book the same hand-off.
  const { data: existing } = await svc.from("referrals").select("id")
    .eq("brokerage_id", input.brokerageId).eq("referred_contact_id", input.contactId)
    .eq("referring_agent_id", input.referringAgentId).not("status", "in", "(closed,lost)").limit(1).maybeSingle()
  if (existing) return { ok: true, referralId: (existing as any).id }

  const { data, error } = await svc.from("referrals").insert({
    brokerage_id: input.brokerageId,
    agent_id: input.receivingAgentId,           // the agent who now works the client
    referring_agent_id: input.referringAgentId, // the agent who sent them (earns the fee)
    referred_contact_id: input.contactId,
    referral_fee_pct: feePct,
    referral_source: "agent_referral",
    // referrals.status CHECK: received/contacted/qualified/assigned/under_contract/closed/lost —
    // a fresh referral starts 'received' (the closer treats anything not closed/lost as open).
    status: "received",
    notes: input.notes ?? null,
  }).select("id").single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, referralId: (data as any).id }
}
