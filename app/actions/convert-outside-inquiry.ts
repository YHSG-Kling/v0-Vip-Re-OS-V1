"use server"

/**
 * app/actions/convert-outside-inquiry.ts
 *
 * The canonical "convert this unrepresented inquiry to a represented buyer" action.
 *
 * ⚠️ NAR Code of Ethics Article 16 (interference with exclusive representation)
 *    explicitly forbids converting a buyer who is already represented by another
 *    agent. Two hard guards enforce this:
 *      1. `attestUnrepresented: true` is REQUIRED — the calling agent must
 *         explicitly attest they confirmed the buyer is not currently working
 *         with another real estate agent. The UI surface (ContactQuickActions)
 *         prompts the agent before passing this flag.
 *      2. Any associated showing_request row with `source='external_agent'`
 *         (the outside-buyer-agent path) BLOCKS the conversion. An outside
 *         agent submitting a showing request on our listing means the buyer
 *         is the OUTSIDE agent's client — not a candidate for in-house
 *         representation. We facilitate the showing; we don't take the buyer.
 *
 * WHY:
 *   The public listing page and the outside-agent showing form create
 *   buyer-type inquiries WITHOUT a `buyer_stage` and WITHOUT a Buyer Broker
 *   Agreement (BBA). Before that buyer can request showings or have an offer
 *   drafted through our pipeline, the BBA gate (`lib/buyer-broker/gate.ts`)
 *   requires an active BBA — NAR August 2024 settlement enforcement.
 *
 *   Previously the conversion was a tribal-knowledge sequence the agent had
 *   to execute manually across multiple screens with no ethical-conflict
 *   detection. This action collapses the conversion into one server-action
 *   call AND blocks unethical conversions at the source.
 *
 * What this action does (when the guards pass):
 *   1. Auth gate via lib/auth/contact-access.ts (same gate the CRM detail page uses)
 *   2. Ethical guards (Article 16) — see top of file
 *   3. Asserts contact_type='buyer' — refuses to convert a seller or transaction contact
 *   4. Reassigns contact.agent_id to the caller (when applicable) and sets buyer_stage to
 *      the canonical initial state `BUYER_CONTACT_CREATED`
 *   5. Drafts a BBA for (buyer, caller_agent) — IDEMPOTENT
 *   6. Links a showing_request if provided AND it's NOT an external_agent source
 *   7. Emits BUYER_STATE_CHANGED through the canonical kernel emitter
 *
 * SELLER-PROSPECT NOTE:
 *   The analog for a seller prospect (agent courting a homeowner who hasn't yet
 *   signed a listing agreement) is the existing `createListing` flow in
 *   app/actions/ai-listing-intake.ts — that action creates a listings row in
 *   `draft` / `LEAD` lifecycle_stage with the seller_contact_id; a separate
 *   listing_agreements row is then drafted, sent for signature, and signed
 *   → at which point the listings row advances to LISTING_AGREEMENT_SIGNED
 *   (see lib/esign-webhooks/finalize-packet.ts:331). No separate "convert
 *   seller prospect" action is needed — the existing intake flow IS the path.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { assertCanActOnContact } from "@/lib/auth/contact-access"
import { emitKernelEvent } from "@/lib/kernel/emit"
import { KernelEvent } from "@/lib/kernel/events"
import { revalidatePath } from "next/cache"

export interface ConvertOutsideInquiryInput {
  contactId:         string
  /** REQUIRED ETHICAL ATTESTATION. The calling agent must confirm (via UI prompt or
   *  in-person/phone conversation with the buyer) that the buyer is not currently
   *  represented by another real estate agent. NAR Code of Ethics Article 16 forbids
   *  interference with another REALTOR's exclusive representation. The server action
   *  REJECTS the call if this is not `true`. */
  attestUnrepresented: boolean
  /** Optional — outside-agent showing requests have contact_id=NULL until an in-house agent
   *  takes the buyer on. Pass the id here to link it in the same atomic call. NOTE:
   *  showing_requests with source='external_agent' are NEVER linkable via this action
   *  (the outside agent represents the buyer — see top-of-file ethical guards). */
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

  // ── 1a. Ethical attestation (NAR Code of Ethics Article 16) ──────────────
  // Hard fail when the caller didn't pass the attestation. The UI surface (window.confirm
  // in ContactQuickActions) is the human-facing checkpoint; this is the wire-level guard
  // that ensures even a programmatic caller can't bypass the disclosure.
  if (input.attestUnrepresented !== true) {
    return {
      success: false,
      error: "Refused: caller must attest the buyer is not currently represented by another agent. NAR Code of Ethics Article 16 forbids interference with another REALTOR's exclusive representation.",
    }
  }

  const svc = createServiceClient()

  // ── 1b. Block known outside-agent paths ──────────────────────────────────
  // (a) A passed-in showing_request with source='external_agent' means an outside
  //     buyer-agent submitted this — the outside agent owns the buyer relationship.
  // (b) If ANY existing showing_request for this contact has source='external_agent',
  //     the contact came in through that channel and is owned by the outside agent.
  // Both produce the same refusal — we facilitate the showing, we don't take the buyer.
  // The two lookups are independent and run in parallel so the gate adds one round-trip
  // of latency instead of two.
  const [passedInRes, contactRowsRes] = await Promise.all([
    input.showingRequestId
      ? svc.from("showing_requests")
          .select("id, source, buyer_agent_name, buyer_agent_email")
          .eq("id", input.showingRequestId).maybeSingle()
      : Promise.resolve({ data: null }),
    svc.from("showing_requests")
      .select("id, buyer_agent_name, buyer_agent_email")
      .eq("contact_id", input.contactId)
      .eq("source", "external_agent")
      .limit(1),
  ])
  if (passedInRes.data?.source === "external_agent") {
    const r = passedInRes.data as { buyer_agent_name?: string; buyer_agent_email?: string }
    return {
      success: false,
      error: `Refused: this showing request was submitted by an outside buyer-agent (${r.buyer_agent_name ?? r.buyer_agent_email ?? "unknown"}). The outside agent represents the buyer — converting them to in-house representation would violate NAR Code of Ethics Article 16. Facilitate the showing; do not convert.`,
    }
  }
  if (contactRowsRes.data && contactRowsRes.data.length > 0) {
    const row = contactRowsRes.data[0] as { buyer_agent_name?: string; buyer_agent_email?: string }
    return {
      success: false,
      error: `Refused: this contact has an existing outside-agent showing request (agent: ${row.buyer_agent_name ?? row.buyer_agent_email ?? "unknown"}). The buyer is represented by another agent — NAR Code of Ethics Article 16 forbids conversion.`,
    }
  }

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

  // ── 3. Refetch contact (we need contact_type + buyer_stage + the representation
  //       disclosure stored on enrichment_profile, which the gate doesn't load) ──
  // Use maybeSingle so a race (contact deleted between gate.assertCanActOnContact and
  // here) returns a graceful error instead of throwing an unhandled exception.
  const { data: contact } = await svc.from("contacts")
    .select("id, contact_type, brokerage_id, agent_id, buyer_stage, source, enrichment_profile")
    .eq("id", input.contactId).maybeSingle()
  if (!contact) return { success: false, error: "Contact not found" }
  if (contact.contact_type !== "buyer") {
    return { success: false, error: `Contact is contact_type=${contact.contact_type}, not 'buyer' — refusing to convert` }
  }

  // ── 3a. Self-disclosed representation block ──
  // If the buyer told us on the public form that they're already working with another
  // agent (or refused to say), we cannot proceed with conversion regardless of the
  // agent's attestation. The disclosure is the buyer's authoritative statement.
  const disclosed = (contact.enrichment_profile as { representation_disclosure?: { status?: string } } | null)
    ?.representation_disclosure?.status
  if (disclosed === "represented") {
    return {
      success: false,
      error: "Refused: this buyer self-disclosed on the listing page that they're already working with another real estate agent. NAR Code of Ethics Article 16 forbids interference with their existing agency relationship. Facilitate the showing through their agent; do not convert.",
    }
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
        // buyer_broker_agreements.created_by is NOT NULL on the live schema — stamp the
        // user who initiated the conversion (the agent or staff member who clicked
        // "Convert to my buyer"). Caught by the e2e walk against live DB.
        created_by:             gate.userId,
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
