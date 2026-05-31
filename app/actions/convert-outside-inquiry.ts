"use server"

/**
 * app/actions/convert-outside-inquiry.ts
 *
 * The canonical "convert this unrepresented inquiry to a represented buyer" action.
 *
 * WHY:
 *   The public listing page (`app/listing/[id]/page.tsx`) and the outside-agent showing form
 *   create buyer-type contacts (or contact_id=NULL showing_requests) WITHOUT a `buyer_stage`,
 *   WITHOUT a Buyer Broker Agreement (BBA), and sometimes auto-assigned to the listing's
 *   agent for default routing. Before that buyer can request showings or have an offer
 *   drafted through our pipeline, the BBA gate (`lib/buyer-broker/gate.ts`) requires an
 *   active BBA — NAR August 2024 settlement enforcement.
 *
 *   Previously the conversion was a tribal-knowledge sequence the agent had to execute
 *   manually across multiple screens: reassign contact, set buyer_stage, draft a BBA from
 *   the BBA actions module, link the showing_request if it was an outside-agent submission.
 *   Easy to miss a step → buyer-portal `requestShowing` then mysteriously blocks on the gate.
 *
 * This action collapses all of that into one server-action call:
 *   1. Auth gate via lib/auth/contact-access.ts (same gate the CRM detail page uses)
 *   2. Asserts contact_type='buyer' — refuses to convert a seller or transaction contact
 *   3. Reassigns contact.agent_id to the caller (when applicable) and sets buyer_stage to
 *      the canonical initial state `BUYER_CONTACT_CREATED`
 *   4. Drafts a BBA for (buyer, caller_agent) — IDEMPOTENT (re-running returns the
 *      existing draft/pending/active BBA; the unique partial index on (buyer, agent) WHERE
 *      status='active' is the DB-level backstop)
 *   5. Links a showing_request (if one was passed in — the outside-agent path created it
 *      with contact_id=NULL and the listing agent decided to take the buyer on)
 *   6. Emits BUYER_STATE_CHANGED through the canonical kernel emitter (notifications +
 *      sequence enrollment + portal cards uniformly via the reactor)
 *
 * Idempotency: every step is safe to re-run. Re-calling returns the same BBA id with
 * `bbaCreated: false`, allowing the UI to show "BBA already drafted — send for signature".
 */
import { createServiceClient } from "@/lib/supabase/service"
import { assertCanActOnContact } from "@/lib/auth/contact-access"
import { emitKernelEvent } from "@/lib/kernel/emit"
import { KernelEvent } from "@/lib/kernel/events"
import { revalidatePath } from "next/cache"

export interface ConvertOutsideInquiryInput {
  contactId:         string
  /** Optional — outside-agent showing requests have contact_id=NULL until an in-house agent
   *  takes the buyer on. Pass the id here to link it in the same atomic call. */
  showingRequestId?: string
  /** BBA draft defaults — the agent edits these in the BBA review UI before sending for
   *  signature. None of these are required; sensible defaults apply. */
  bbaTerms?: {
    agreementType?:        "exclusive" | "non_exclusive" | "showing_only" | "open"
    commissionPercentage?: number
    commissionPayer?:      "seller" | "buyer" | "split" | "either"
    geographicScope?:      string
    /** YYYY-MM-DD */
    expirationDate?:       string
  }
}

export interface ConvertOutsideInquiryResult {
  success:     boolean
  error?:      string
  contactId?:  string
  bbaId?:      string
  /** false when the call found an existing draft/pending/active BBA and returned it. */
  bbaCreated?: boolean
  /** Resulting buyer_stage on the contact (after this call). */
  buyerStage?: string
  /** True when contact.agent_id was changed to the caller's agents.id. */
  agentReassigned?: boolean
}

export async function convertOutsideInquiryToRepresentedBuyer(
  input: ConvertOutsideInquiryInput,
): Promise<ConvertOutsideInquiryResult> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const gate = await assertCanActOnContact(input.contactId)
  if (!gate.ok) return { success: false, error: gate.error }

  const svc = createServiceClient()

  // ── 2. Resolve caller's agents.id ────────────────────────────────────────
  // BBA.agent_id is a FK to agents.id (NOT users.id). For agent callers we resolve via
  // users.id → agents row. For non-agent staff (broker / TC / compliance officer acting
  // on behalf of an agent), we fall back to the contact's existing agent_id — they're
  // operationalizing a conversion on behalf of someone who's already assigned.
  const { data: callerAgentRow } = await svc.from("agents")
    .select("id").eq("user_id", gate.userId).maybeSingle()
  const callerAgentId = (callerAgentRow?.id as string | undefined) ?? gate.contact.agent_id
  if (!callerAgentId) {
    return { success: false, error: "No agent context for conversion — caller has no agents row and contact has no assigned agent" }
  }

  // ── 3. Refetch contact (we need contact_type + buyer_stage which the gate doesn't load) ──
  const { data: contact } = await svc.from("contacts")
    .select("id, contact_type, brokerage_id, agent_id, buyer_stage, source")
    .eq("id", input.contactId).single()
  if (!contact) return { success: false, error: "Contact not found" }
  if (contact.contact_type !== "buyer") {
    return { success: false, error: `Contact is contact_type=${contact.contact_type}, not 'buyer' — refusing to convert` }
  }

  // ── 4. Stage + agent_id update ───────────────────────────────────────────
  // Only mutate what actually changes; preserves audit clarity.
  const updates: Record<string, unknown> = {}
  const agentReassigned = contact.agent_id !== callerAgentId
  if (agentReassigned)        updates.agent_id    = callerAgentId
  if (!contact.buyer_stage)   updates.buyer_stage = "BUYER_CONTACT_CREATED"
  if (Object.keys(updates).length > 0) {
    const { error: upErr } = await svc.from("contacts").update(updates).eq("id", input.contactId)
    if (upErr) return { success: false, error: `Failed to update contact: ${upErr.message}` }
  }

  // ── 5. Link the showing_request (outside-agent path) ─────────────────────
  // Only writes when the row's contact_id is still null — prevents stomping on an
  // already-linked showing request from a different conversion call.
  if (input.showingRequestId) {
    await svc.from("showing_requests")
      .update({ contact_id: input.contactId })
      .eq("id", input.showingRequestId)
      .is("contact_id", null)
  }

  // ── 6. BBA — idempotent ──────────────────────────────────────────────────
  // The unique partial index `uq_bba_active_per_buyer_agent` (migration 1062) enforces
  // at most ONE active BBA per (buyer, agent). We additionally guard against duplicate
  // drafts/pending here so the agent doesn't accumulate noise in the BBA inbox.
  const { data: existing } = await svc.from("buyer_broker_agreements")
    .select("id, status")
    .eq("buyer_contact_id", input.contactId)
    .eq("agent_id", callerAgentId)
    .in("status", ["draft", "pending_signature", "active"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  let bbaId: string
  let bbaCreated = false
  if (existing) {
    bbaId = existing.id as string
  } else {
    const t = input.bbaTerms ?? {}
    const { data: newBBA, error: bbaErr } = await svc.from("buyer_broker_agreements")
      .insert({
        brokerage_id:           contact.brokerage_id,
        buyer_contact_id:       input.contactId,
        agent_id:               callerAgentId,
        agreement_type:         t.agreementType        ?? "exclusive",
        commission_percentage:  t.commissionPercentage ?? null,
        commission_payer:       t.commissionPayer      ?? "seller",
        geographic_scope:       t.geographicScope      ?? null,
        expiration_date:        t.expirationDate       ?? null,
        status:                 "draft",
      })
      .select("id").single()
    if (bbaErr || !newBBA) return { success: false, error: `Failed to draft BBA: ${bbaErr?.message ?? "unknown"}` }
    bbaId = newBBA.id as string
    bbaCreated = true
  }

  // ── 7. Kernel event ──────────────────────────────────────────────────────
  // BUYER_STATE_CHANGED is the canonical buyer-lifecycle event the existing reactor +
  // marketing-trigger engine already key off — no need to invent a new event type. Metadata
  // carries the conversion context so downstream listeners can tell this transition apart
  // from a normal stage advance.
  await emitKernelEvent({
    event:       KernelEvent.BUYER_STATE_CHANGED,
    brokerageId: contact.brokerage_id ?? null,
    entityType:  "contact",
    entityId:    input.contactId,
    contactId:   input.contactId,
    metadata: {
      from:               contact.buyer_stage ?? null,
      to:                 (updates.buyer_stage as string | undefined) ?? contact.buyer_stage ?? null,
      via:                "outside_inquiry_conversion",
      bba_id:             bbaId,
      bba_created:        bbaCreated,
      showing_request_id: input.showingRequestId ?? null,
      source:             contact.source,
      agent_reassigned:   agentReassigned,
    },
  })

  revalidatePath(`/crm/contacts/${input.contactId}`)

  return {
    success:         true,
    contactId:       input.contactId,
    bbaId,
    bbaCreated,
    buyerStage:      ((updates.buyer_stage as string | undefined) ?? contact.buyer_stage) ?? "BUYER_CONTACT_CREATED",
    agentReassigned,
  }
}
