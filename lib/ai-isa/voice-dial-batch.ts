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
  params: { brokerageId: string; agentId?: string | null; script?: string; limit?: number; minScore?: number },
  client?: Svc,
): Promise<ProposeBatchResult> {
  const supabase = client ?? createServiceClient()
  const limit = params.limit ?? 20
  const minScore = params.minScore ?? 50 // warm+ only — don't burn dials on cold contacts
  const agentId = params.agentId ?? null

  // Idempotency — one pending proposed batch per (brokerage, agent). The AGENT who owns
  // the contacts is the approver, so batches are scoped per-agent (see approval routing).
  let pendingQ = supabase
    .from("ai_isa_call_batches").select("id").eq("brokerage_id", params.brokerageId).eq("status", "proposed")
  pendingQ = agentId ? pendingQ.eq("proposed_by_agent_id", agentId) : pendingQ.is("proposed_by_agent_id", null)
  const { data: pending } = await pendingQ.limit(1).maybeSingle()
  if (pending) return { proposed: false, reason: "a proposed batch is already pending for this agent" }

  // Rank by propensity (the AI ISA's hot-list), then filter to consented + callable +
  // (when agent-scoped) owned by THIS agent so they approve only their own contacts.
  const { rankContactsByPropensity } = await import("@/lib/ai-isa/transaction-propensity")
  const ranked = await rankContactsByPropensity({ brokerageId: params.brokerageId, limit: 500, minScore }, supabase)
  if (ranked.length === 0) return { proposed: false, reason: "no warm+ contacts to call" }

  const ids = ranked.map((r) => r.contactId)
  const { data: rows } = await supabase
    .from("contacts")
    .select("id, agent_id, tcpa_consent, isa_reengage_allowed, dnc_status, phone_opt_out, call_stop_flag, phone")
    .in("id", ids)
  const byId = new Map((rows ?? []).map((c: any) => [c.id, c as IsaCallConsent & { agent_id: string | null }]))

  const targets: DialTarget[] = []
  for (const r of ranked) {
    const c = byId.get(r.contactId)
    if (!c) continue
    if (agentId && c.agent_id !== agentId) continue          // agent-scoped: only this agent's contacts
    if (!eligibleForIsaCall(c).allowed) continue
    targets.push({ contact_id: r.contactId, name: r.name, phone: String(c.phone), propensity_score: r.result.score })
    if (targets.length >= limit) break
  }
  if (targets.length === 0) return { proposed: false, reason: "no consented, callable contacts in the hot-list" }

  const { data: batch, error } = await supabase.from("ai_isa_call_batches").insert({
    brokerage_id: params.brokerageId,
    proposed_by_agent_id: agentId,
    status: "proposed",
    script: params.script ?? "AI ISA re-engagement — warm check-in for high-propensity consented contacts.",
    target_contacts: targets,
    proposed_count: targets.length,
  }).select("id").single()
  if (error || !batch) return { proposed: false, reason: error?.message ?? "insert failed" }
  return { proposed: true, batchId: (batch as any).id, eligibleCount: targets.length }
}

/** One placed-call result, per dial target. `voiceCallId` is the voice_calls row id (a uuid
 *  FK), NOT the vendor's string id — null when no voice_calls row was created. */
export interface DialOutcome { contactId: string; placed: boolean; voiceCallId: string | null; error?: string }

/** The vendor boundary — places one outbound call. Injectable so a test never dials a real
 *  number (same seam as the `client?` DB param). The DEFAULT is the real, TCPA-gated
 *  initiateVoiceCall; the recorded ai_isa_calls row is REAL either way. */
export type DialExecutor = (target: DialTarget, ctx: { brokerageId: string; agentId: string | null }) => Promise<DialOutcome>

const realDialExecutor: DialExecutor = async (target, ctx) => {
  const { initiateVoiceCall } = await import("@/lib/voice-engine/call-executor")
  const res = await initiateVoiceCall(
    { contactId: target.contact_id, initiatorRole: "ai", callType: "outbound", vendor: "vapi_isa", agentId: ctx.agentId ?? undefined },
    target.phone,
  )
  // ai_isa_calls.voice_call_id FKs to voice_calls(id) — use callId (the row id), not the
  // vendor string. Only set it when initiateVoiceCall actually created a voice_calls row.
  return { contactId: target.contact_id, placed: res.success, voiceCallId: res.success ? (res.callId ?? null) : null, error: res.error }
}

export interface ApproveBatchResult {
  ok: boolean
  /** Targets that STILL pass the consent gate at approval time. */
  dialTargets: DialTarget[]
  /** Calls actually PLACED by the vendor (0 when no voice provider is configured). */
  dialedCount: number
  /** Governed dial ATTEMPTS recorded into ai_isa_calls (placed or not). */
  attemptedCount: number
  /** Targets dropped because consent changed between propose and approve. */
  droppedForConsent: number
  error?: string
}

/**
 * Approve a proposed dial batch. RE-CHECKS consent for every target (consent can change
 * after proposal), drops the now-ineligible, DIALS each remaining target through the gated
 * voice executor, records every governed attempt into ai_isa_calls, and marks the batch
 * completed with the placed count. Idempotent — only a 'proposed' batch transitions.
 */
export async function approveIsaDialBatch(
  params: { batchId: string; brokerageId: string; approverUserId: string; executor?: DialExecutor },
  client?: Svc,
): Promise<ApproveBatchResult> {
  const supabase = client ?? createServiceClient()
  const executor = params.executor ?? realDialExecutor

  const { data: batch } = await supabase
    .from("ai_isa_call_batches")
    .select("id, brokerage_id, status, target_contacts, script, proposed_by_agent_id")
    .eq("id", params.batchId).eq("brokerage_id", params.brokerageId).maybeSingle()
  if (!batch) return { ok: false, dialTargets: [], dialedCount: 0, attemptedCount: 0, droppedForConsent: 0, error: "batch not found" }
  if ((batch as any).status !== "proposed") return { ok: false, dialTargets: [], dialedCount: 0, attemptedCount: 0, droppedForConsent: 0, error: `batch is ${(batch as any).status}` }

  const proposed = ((batch as any).target_contacts ?? []) as DialTarget[]
  const script = ((batch as any).script as string | null) ?? null
  const agentId = ((batch as any).proposed_by_agent_id as string | null) ?? null
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

  // Claim the batch first (proposed → completed) so a concurrent approve can't double-dial.
  const { data: claimed } = await supabase
    .from("ai_isa_call_batches")
    .update({ status: "completed", approved_by: params.approverUserId, approved_at: new Date().toISOString(), completed_at: new Date().toISOString() })
    .eq("id", params.batchId).eq("status", "proposed").select("id").maybeSingle()
  if (!claimed) return { ok: false, dialTargets: [], dialedCount: 0, attemptedCount: 0, droppedForConsent: 0, error: "batch already actioned" }

  // Dial each consented target + record the governed attempt into ai_isa_calls.
  let placed = 0
  const results: DialOutcome[] = []
  for (const t of dialTargets) {
    let outcome: DialOutcome
    try { outcome = await executor(t, { brokerageId: params.brokerageId, agentId }) }
    catch (e) { outcome = { contactId: t.contact_id, placed: false, voiceCallId: null, error: (e as Error).message } }
    if (outcome.placed) placed += 1
    results.push(outcome)
    await supabase.from("ai_isa_calls").insert({
      brokerage_id: params.brokerageId,
      contact_id: t.contact_id,
      voice_call_id: outcome.voiceCallId,
      script_used: script ? script.slice(0, 500) : null,
      ai_response_summary: (outcome.placed ? "call placed via AI ISA dial batch" : (outcome.error ?? "not placed")).slice(0, 500),
    })
  }

  await supabase.from("ai_isa_call_batches").update({
    dialed_count: placed,
    call_results: { attempted: dialTargets.length, placed, dropped_for_consent: droppedForConsent, outcomes: results },
  }).eq("id", params.batchId)

  return { ok: true, dialTargets, dialedCount: placed, attemptedCount: dialTargets.length, droppedForConsent }
}

/**
 * TWO-TIER approval push for dial batches — AGENT FIRST. The agent who owns the contacts
 * (proposed_by_agent_id) is alerted on every proposed batch; the brokerage's managers are
 * escalated only when a batch has sat unapproved ≥ escalationHours (default 4h). Idempotent
 * per (user, batch, type). Returns the counts for each tier.
 */
export async function enqueueDialBatchNotifications(
  brokerageId: string, client?: Svc, opts: { escalationHours?: number } = {},
): Promise<{ agentAlerts: number; managerEscalations: number }> {
  const supabase = client ?? createServiceClient()
  const escalationHours = opts.escalationHours ?? 4
  const now = Date.now()

  const { data: batches } = await supabase
    .from("ai_isa_call_batches")
    .select("id, proposed_by_agent_id, proposed_count, proposed_at")
    .eq("brokerage_id", brokerageId).eq("status", "proposed").limit(200)
  const rows = (batches ?? []) as Array<{ id: string; proposed_by_agent_id: string | null; proposed_count: number; proposed_at: string | null }>
  if (rows.length === 0) return { agentAlerts: 0, managerEscalations: 0 }

  const { data: mgrs } = await supabase.from("users").select("id")
    .eq("brokerage_id", brokerageId).in("user_type", ["broker", "broker_admin", "admin"]).limit(20)
  const managerIds = ((mgrs ?? []) as Array<{ id: string }>).map((m) => m.id)

  const already = async (userId: string, batchId: string, type: string) => {
    const { data } = await supabase.from("notifications").select("id")
      .eq("user_id", userId).eq("type", type).eq("entity_id", batchId).limit(1).maybeSingle()
    return !!data
  }
  const agentUserFor = async (agentId: string | null): Promise<string | null> => {
    if (!agentId) return null
    const { data } = await supabase.from("agents").select("user_id").eq("id", agentId).maybeSingle()
    return (data as { user_id: string | null } | null)?.user_id ?? null
  }

  let agentAlerts = 0, managerEscalations = 0
  for (const b of rows) {
    const ageHours = b.proposed_at ? (now - new Date(b.proposed_at).getTime()) / 3_600_000 : 0
    // TIER 1 — the responsible agent (front line).
    const agentUserId = await agentUserFor(b.proposed_by_agent_id)
    if (agentUserId && !(await already(agentUserId, b.id, "dial_batch_approval"))) {
      const { error } = await supabase.from("notifications").insert({
        user_id: agentUserId, brokerage_id: brokerageId, type: "dial_batch_approval",
        title: "AI ISA wants to call your contacts",
        body: `${b.proposed_count} consented contact${b.proposed_count === 1 ? "" : "s"} ready to dial — review & approve.`,
        entity_type: "ai_isa_call_batch", entity_id: b.id, priority: "medium", is_read: false,
      })
      if (!error) agentAlerts += 1
    }
    // TIER 2 — manager escalation past 4h.
    if (ageHours >= escalationHours) {
      for (const mid of managerIds) {
        if (mid === agentUserId) continue
        if (await already(mid, b.id, "dial_batch_escalation")) continue
        const { error } = await supabase.from("notifications").insert({
          user_id: mid, brokerage_id: brokerageId, type: "dial_batch_escalation",
          title: "Overdue dial batch — AI ISA",
          body: `A ${b.proposed_count}-contact dial batch has waited ${Math.round(ageHours)}h without approval. Tap to step in.`,
          entity_type: "ai_isa_call_batch", entity_id: b.id, priority: "high", is_read: false,
        })
        if (!error) managerEscalations += 1
      }
    }
  }
  return { agentAlerts, managerEscalations }
}
