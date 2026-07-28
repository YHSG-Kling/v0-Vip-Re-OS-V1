// lib/lead-pipeline/reactivation-enroller.ts
//
// AI-ISA REACTIVATION ENROLLER — the live driver that replaces the hand-built ladder runners.
// It finds quiet contacts AND leads and ENROLLS them into the multi-channel reactivation sequence
// (the real sequencer then conducts the managers' channels). Honors an explicit future-intent date
// (don't nag before "reach me later"); the sequence's own response-driven stop terminates it the
// moment they reply, and de-confliction keeps it from over-touching. Leads are brokerage/AI-ISA
// owned (no personal agent) — the executor sends lead steps as a system send. Idempotent:
// enrollContact's duplicate-active guard means a contact is never enrolled twice. Never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { ensureReactivationSequence } from "./reactivation-sequence-installer"
import { enrollContact } from "@/lib/campaign-sequences/enrollment-engine"
import { followupSuppresses } from "./reactivation-cadence"
import { NOT_CONVERTED_FILTER } from "@/lib/lead-pipeline/lead-lifecycle"

type Svc = ReturnType<typeof createServiceClient>

export const CONTACT_DORMANT_DAYS = 7
export const LEAD_DORMANT_DAYS = 10

export interface ReactivationEnrollInput {
  brokerageId: string
  now?: string
  limit?: number
}

export interface ReactivationEnrollResult {
  sequenceId: string | null
  enrolledContacts: number
  enrolledLeads: number
  scanned: number
}

export async function runReactivationEnrollment(input: ReactivationEnrollInput, client?: Svc): Promise<ReactivationEnrollResult> {
  const svc = client ?? createServiceClient()
  const now = input.now ?? new Date().toISOString()
  const nowMs = new Date(now).getTime()
  const out: ReactivationEnrollResult = { sequenceId: null, enrolledContacts: 0, enrolledLeads: 0, scanned: 0 }

  const seq = await ensureReactivationSequence(input.brokerageId, svc)
  if (!seq.sequenceId) return out
  out.sequenceId = seq.sequenceId
  const limit = input.limit ?? 100

  const dormant = (lastTouch: string | null | undefined, created: string | null | undefined, days: number): boolean => {
    const t = lastTouch ?? created
    if (!t) return false
    return (nowMs - new Date(t).getTime()) / 86_400_000 >= days
  }

  // ── Quiet CONTACTS (assigned, contactable, re-engage allowed) ──
  const { data: contacts } = await svc
    .from("contacts")
    .select("id, agent_id, status, dnc_status, isa_reengage_allowed, last_contacted_at, created_at, next_followup_at")
    .eq("brokerage_id", input.brokerageId)
    .not("agent_id", "is", null)
    .eq("dnc_status", false)
    .neq("status", "archived")
    .neq("status", "inactive")
    .not("isa_reengage_allowed", "eq", false)
    .limit(limit)

  for (const c of (contacts ?? []) as any[]) {
    if (followupSuppresses(c.next_followup_at, now)) continue
    if (!dormant(c.last_contacted_at, c.created_at, CONTACT_DORMANT_DAYS)) continue
    out.scanned++
    const r = await enrollContact({ sequenceId: seq.sequenceId, contactId: c.id, brokerageId: input.brokerageId })
    if (r.success) out.enrolledContacts++
  }

  // ── Quiet LEADS (AI-ISA owned, pre-conversion) — brokerage/AI-ISA assigned, email/direct-mail only ──
  const { data: leads } = await svc
    .from("leads")
    .select("id, status, lifecycle_state, last_contacted_at, created_at, next_followup_at, dnc_status")
    .eq("brokerage_id", input.brokerageId)
    .eq("ai_isa_owner", true)
    .or(NOT_CONVERTED_FILTER)
    .not("dnc_status", "is", true) // m233: leads now carry DNC — never reactivate a suppressed lead
    .not("status", "in", '("archived","inactive","dead")')
    .limit(limit)

  for (const l of (leads ?? []) as any[]) {
    if (followupSuppresses(l.next_followup_at, now)) continue
    if (!dormant(l.last_contacted_at, l.created_at, LEAD_DORMANT_DAYS)) continue
    out.scanned++
    const r = await enrollContact({ sequenceId: seq.sequenceId, leadId: l.id, brokerageId: input.brokerageId })
    if (r.success) out.enrolledLeads++
  }

  return out
}
