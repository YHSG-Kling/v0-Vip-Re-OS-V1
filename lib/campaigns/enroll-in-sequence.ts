// lib/campaigns/enroll-in-sequence.ts
// ─────────────────────────────────────────────────────────────────────────────
// The single enrollment writer for `sequence_enrollments`, taking its tenant
// EXPLICITLY so both an interactive caller and an unattended one can use it.
//
// WHY THIS EXISTS (w6s3). `app/actions/campaign-sequences.ts:enrollContactInSequence`
// was the only writer, and it omitted `brokerage_id` entirely while allowing
// `contact_id: null`. Verified against the live schema (project hrvaqgvukzxfskkcrwbt):
// `sequence_enrollments.brokerage_id` is **NOT NULL with no default** and
// `sequence_enrollments.contact_id` is **NOT NULL** too. Every enrollment the product
// ever attempted therefore failed with a not-null violation — and `lib/kernel/ai-isa.ts`
// awaited it inside a `try {} catch {}` that swallowed the failure, so the AI ISA
// reported "not ready now → enrolled in long-term nurture" while enrolling nobody.
// The lead-only branch could never have worked at all.
//
// Adding a session gate to the action alone would have broken the kernel caller, which
// runs without a session and carries its brokerage in an explicit ctx. So the gate
// lives at the action and the WRITE lives here: the kernel passes its own brokerageId
// and gets its own door, never a fake identity.

import { createServiceClient } from "@/lib/supabase/service"
import type { SequenceEnrollment } from "@/lib/campaigns/sequence-constants"

export interface EnrollInSequenceParams {
  sequenceId: string
  /** The tenant. NOT NULL on the table — the caller must resolve it, never guess. */
  brokerageId: string
  /** contacts.id. NOT NULL on the table; when only a lead is known, pass leadId instead. */
  contactId?: string | null
  /** leads.id. Resolved to its `leads.contact_id` because contact_id is NOT NULL. */
  leadId?: string | null
  /** users.id of whoever caused the enrollment, when there is one. */
  enrolledBy?: string | null
}

export async function enrollInSequence(
  params: EnrollInSequenceParams,
): Promise<{ enrollment: SequenceEnrollment | null; error?: string }> {
  const { sequenceId, brokerageId } = params
  if (!sequenceId) return { enrollment: null, error: "Sequence is required" }
  if (!brokerageId) return { enrollment: null, error: "Brokerage is required" }
  if (!params.contactId && !params.leadId) {
    return { enrollment: null, error: "Must provide contact or lead ID" }
  }

  const service = createServiceClient()

  // The sequence must belong to the named tenant. This is the last line of defence
  // for the kernel lane, which has no session to gate on.
  const { data: seq, error: seqError } = await service
    .from("campaign_sequences")
    .select("id, brokerage_id")
    .eq("id", sequenceId)
    .maybeSingle()
  if (seqError) return { enrollment: null, error: seqError.message }
  if (!seq || seq.brokerage_id !== brokerageId) {
    return { enrollment: null, error: "Sequence not found in this brokerage" }
  }

  // Resolve the contact. `contact_id` is NOT NULL, so a lead with no contact row
  // cannot be enrolled — say so rather than attempting a write that will be refused.
  let contactId = params.contactId ?? null
  if (!contactId && params.leadId) {
    const { data: lead, error: leadError } = await service
      .from("leads")
      .select("contact_id, brokerage_id")
      .eq("id", params.leadId)
      .maybeSingle()
    if (leadError) return { enrollment: null, error: leadError.message }
    if (!lead) return { enrollment: null, error: "Lead not found" }
    if (lead.brokerage_id && lead.brokerage_id !== brokerageId) {
      return { enrollment: null, error: "Lead not found in this brokerage" }
    }
    contactId = (lead.contact_id as string | null) ?? null
    if (!contactId) {
      return {
        enrollment: null,
        error: "This lead has no contact record yet, and a sequence enrollment must name one",
      }
    }
  }

  // The contact must be this tenant's too — the enrollment drives outbound sends
  // at that person.
  const { data: contactRow, error: contactError } = await service
    .from("contacts")
    .select("id")
    .eq("id", contactId as string)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (contactError) return { enrollment: null, error: contactError.message }
  if (!contactRow) return { enrollment: null, error: "Contact not found in this brokerage" }

  const { data, error } = await service
    .from("sequence_enrollments")
    .insert({
      sequence_id: sequenceId,
      contact_id: contactId,
      lead_id: params.leadId ?? null,
      brokerage_id: brokerageId,
      enrolled_by: params.enrolledBy ?? null,
      status: "active",
      current_step: 1,
      enrolled_at: new Date().toISOString(),
    })
    .select()
    .maybeSingle()

  if (error) return { enrollment: null, error: error.message }
  if (!data) return { enrollment: null, error: "The enrollment was not created" }

  // Counter bump is best-effort and must never turn a real enrollment into a failure.
  const { error: rpcError } = await service.rpc("increment_sequence_enrollments", { seq_id: sequenceId })
  if (rpcError) console.error("[enroll-in-sequence] enrollment counter not incremented:", rpcError.message)

  return { enrollment: data as SequenceEnrollment }
}
