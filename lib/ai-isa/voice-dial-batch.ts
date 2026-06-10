// lib/ai-isa/voice-dial-batch.ts
//
// VOICE ISA DIAL-BATCH GATE — the AI ISA's outbound calling, governed by the One Command
// Center. The ISA never dials autonomously: it PROPOSES a batch of consented contacts to
// call (drawn from the transaction-propensity hot-list); a human approves the batch in the
// Command Center; only then do the calls fire — and eligibility is RE-CHECKED at approval
// time, because consent can change between propose and approve.
//
// Voice is for CONTACTS, not leads — contacts carry explicit TCPA consent + an ISA
// re-engage permission, so the rule is unambiguous and provable. The eligibility predicate
// is the single source of truth, applied at BOTH propose and approve so a contact who
// revokes consent in the interim is silently dropped before any dial.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** The consent-relevant fields an ISA voice call requires (all live columns). */
export interface IsaCallConsent {
  tcpa_consent?:        boolean | null
  isa_reengage_allowed?: boolean | null
  dnc_status?:          boolean | null
  phone_opt_out?:       boolean | null
  call_stop_flag?:      boolean | null
  phone?:               string | null
}

/**
 * Pure: may the AI ISA place an outbound call to this contact RIGHT NOW? Conservative —
 * EVERY gate must be clear (consent + ISA permission, no DNC / opt-out / stop, has a phone).
 */
export function eligibleForIsaCall(c: IsaCallConsent): { allowed: boolean; reason?: string } {
  if (!c.tcpa_consent)        return { allowed: false, reason: "no TCPA consent" }
  if (!c.isa_reengage_allowed) return { allowed: false, reason: "ISA re-engagement not permitted" }
  if (c.dnc_status)           return { allowed: false, reason: "on the do-not-call list" }
  if (c.phone_opt_out)        return { allowed: false, reason: "opted out of phone contact" }
  if (c.call_stop_flag)       return { allowed: false, reason: "call-stop flag set" }
  if (!c.phone || !c.phone.trim()) return { allowed: false, reason: "no phone on file" }
  return { allowed: true }
}

export interface DialTarget {
  contact_id: string
  name: string
  phone: string
  propensity_score: number
}

export interface ProposeBatchResult {
  proposed: boolean
  batchId?: string
  eligibleCount?: number
  reason?: string
}

/**
 * Propose an ISA dial batch for the brokerage's highest-propensity CONSENTED contacts.
 * Idempotent: skips if a proposed batch is already pending. Returns the batch id.
 */
export async function proposeIsaDialBatch(
  params: { brokerageId: string; proposedByAgentId?: string | null; script?: string; limit?: number; minScore?: number },
  client?: Svc,
): Promise<ProposeBatchResult> {
  const supabase = client ?? createServiceClient()
  const limit = params.limit ?? 20
  const minScore = params.minScore ?? 50 // warm+ only — don't burn dials on cold contacts

  // Idempotency — one pending proposed batch per brokerage.
  const { data: pending } = await supabase
    .from("ai_isa_call_batches").select("id").eq("brokerage_id", params.brokerageId).eq("status", "proposed").limit(1).maybeSingle()
  if (pending) return { proposed: false, reason: "a proposed batch is already pending" }

  // Rank by propensity (the AI ISA's hot-list), then filter to consented + callable.
  const { rankContactsByPropensity } = await import("@/lib/ai-isa/transaction-propensity")
  const ranked = await rankContactsByPropensity({ brokerageId: params.brokerageId, limit: 500, minScore }, supabase)
  if (ranked.length === 0) return { proposed: false, reason: "no warm+ contacts to call" }

  // Pull consent fields for the ranked contacts and keep only the eligible ones.
  const ids = ranked.map((r) => r.contactId)
  const { data: rows } = await supabase
    .from("contacts")
    .select("id, tcpa_consent, isa_reengage_allowed, dnc_status, phone_opt_out, call_stop_flag, phone")
    .in("id", ids)
  const consentById = new Map((rows ?? []).map((c: any) => [c.id, c as IsaCallConsent]))

  const targets: DialTarget[] = []
  for (const r of ranked) {
    const consent = consentById.get(r.contactId)
    if (!consent) continue
    if (!eligibleForIsaCall(consent).allowed) continue
    targets.push({ contact_id: r.contactId, name: r.name, phone: String(consent.phone), propensity_score: r.result.score })
    if (targets.length >= limit) break
  }
  if (targets.length === 0) return { proposed: false, reason: "no consented, callable contacts in the hot-list" }

  const { data: batch, error } = await supabase.from("ai_isa_call_batches").insert({
    brokerage_id: params.brokerageId,
    proposed_by_agent_id: params.proposedByAgentId ?? null,
    status: "proposed",
    script: params.script ?? "AI ISA re-engagement — warm check-in for high-propensity consented contacts.",
    target_contacts: targets,
    proposed_count: targets.length,
  }).select("id").single()
  if (error || !batch) return { proposed: false, reason: error?.message ?? "insert failed" }
  return { proposed: true, batchId: (batch as any).id, eligibleCount: targets.length }
}

export interface ApproveBatchResult {
  ok: boolean
  /** Targets that STILL pass the consent gate at approval time — the ones that will dial. */
  dialTargets: DialTarget[]
  dialedCount: number
  /** Targets dropped because consent changed between propose and approve. */
  droppedForConsent: number
  error?: string
}

/**
 * Approve a proposed dial batch. RE-CHECKS consent for every target (consent can change
 * after proposal), drops the now-ineligible, marks the batch completed with the dialed
 * count, and returns the targets to dial (the caller fires them via the gated voice path).
 * Idempotent — only a 'proposed' batch transitions.
 */
export async function approveIsaDialBatch(
  params: { batchId: string; brokerageId: string; approverUserId: string },
  client?: Svc,
): Promise<ApproveBatchResult> {
  const supabase = client ?? createServiceClient()

  const { data: batch } = await supabase
    .from("ai_isa_call_batches")
    .select("id, brokerage_id, status, target_contacts")
    .eq("id", params.batchId).eq("brokerage_id", params.brokerageId).maybeSingle()
  if (!batch) return { ok: false, dialTargets: [], dialedCount: 0, droppedForConsent: 0, error: "batch not found" }
  if ((batch as any).status !== "proposed") return { ok: false, dialTargets: [], dialedCount: 0, droppedForConsent: 0, error: `batch is ${(batch as any).status}` }

  const proposed = ((batch as any).target_contacts ?? []) as DialTarget[]
  const ids = proposed.map((t) => t.contact_id)

  // RE-CHECK consent at approval time — the critical guard.
  const { data: rows } = await supabase
    .from("contacts")
    .select("id, tcpa_consent, isa_reengage_allowed, dnc_status, phone_opt_out, call_stop_flag, phone")
    .in("id", ids)
  const consentById = new Map((rows ?? []).map((c: any) => [c.id, c as IsaCallConsent]))

  const dialTargets = proposed.filter((t) => {
    const consent = consentById.get(t.contact_id)
    return consent ? eligibleForIsaCall(consent).allowed : false
  })
  const droppedForConsent = proposed.length - dialTargets.length

  const { error } = await supabase
    .from("ai_isa_call_batches")
    .update({
      status: "completed",
      approved_by: params.approverUserId,
      approved_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      dialed_count: dialTargets.length,
      call_results: { dialed: dialTargets.length, dropped_for_consent: droppedForConsent },
    })
    .eq("id", params.batchId).eq("status", "proposed")
  if (error) return { ok: false, dialTargets: [], dialedCount: 0, droppedForConsent: 0, error: error.message }

  return { ok: true, dialTargets, dialedCount: dialTargets.length, droppedForConsent }
}
