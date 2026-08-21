/**
 * lib/kernel/crm.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 0 — Canonical CRM commands for the Contact OS.
 *
 * Ownership rules:
 *   - ONLY this file writes the dedup / merge decision to contacts.
 *   - contact_suppression_list is written by lib/kernel/compliance/check-suppression.ts
 *     `addSuppression` — NOT by this file. The rule that used to stand here named
 *     `applyContactSuppressionState()`, which had zero callers and has been deleted
 *     as a duplicate (tombstone at COMMAND 14 below).
 *   - ONLY this file writes to lead_enrichment_queue for contact-triggered enrichment.
 *   - ONLY this file writes lead_deduplication_log rows.
 *   - Server actions call these commands — they do not duplicate the logic.
 *
 * Schema FK rules (from live schema):
 *   - contacts.agent_id → agents.id  (NOT users.id — always resolve via agents table)
 *   - contacts.id is the canonical contact PK (NOT contact_id, which is a legacy alias)
 *   - contacts.source, source_family, source_channel, source_subtype — all exist
 *   - leads.contact_id → contacts.id for lead-to-contact linkage
 *   - lead_deduplication_log.duplicate_of_contact_id → contacts.id
 *   - activities table (NOT activity_log) for timeline entries
 *   - notifications table for agent notifications (not a separate notify table)
 *
 * All queries use maybeSingle(), not single(). Never throws — returns structured results.
 * All IDs passed in are string (UUID). No number IDs.
 * All events use KernelEvent enum values — no string literals.
 */

"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"

// ─── INPUT / OUTPUT CONTRACTS ─────────────────────────────────────────────────

/** Normalized phone: digits only, no spaces/dashes/parens */
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "")
}

/** Normalized email: lowercased and trimmed */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export interface ContactSourceAttribution {
  source?: string           // e.g. 'website_form', 'open_house', 'referral'
  source_family?: string    // e.g. 'organic', 'paid', 'referral'
  source_channel?: string   // e.g. 'email', 'social', 'direct'
  source_subtype?: string   // e.g. 'google_ads', 'zillow', 'sphere'
  campaign_attribution_id?: string
  source_agent_id?: string  // agent who sourced this contact
}

export interface CreateContactParams {
  first_name: string
  last_name: string
  email?: string | null
  phone?: string | null
  city?: string | null
  state?: string | null
  zip_code?: string | null
  contact_type?: "buyer" | "seller" | "both" | "investor" | "vendor" | "lender"
  status?: string
  contact_persona?: string
  notes?: string
  preferred_channel?: string
  tcpa_consent?: boolean
  /** agents.id — NOT users.id */
  agent_id: string
  brokerage_id: string
  team_id?: string
  source?: ContactSourceAttribution
}

export interface CRMContactResult {
  success: boolean
  contact?: Record<string, unknown>
  contactId?: string
  isDuplicate?: boolean
  mergedIntoId?: string
  error?: string
}

export interface DeduplicateResult {
  isDuplicate: boolean
  existingContactId?: string
  matchField?: "email" | "phone" | "both"
  matchScore?: number
}

/* `SuppressionStateParams` was the input type of `applyContactSuppressionState`
 * and went with it (tombstone at COMMAND 14). The live shape is the inline
 * parameter object of `addSuppression`,
 * lib/kernel/compliance/check-suppression.ts:263. */

export interface CRMResult {
  success: boolean
  error?: string
  data?: Record<string, unknown>
}

// ─── COMMAND 1: resolveCanonicalPerson ────────────────────────────────────────
/**
 * Checks for a dedup match on normalized email and/or phone.
 * Returns the existing contact ID if a match is found — caller decides merge vs update.
 */
export async function resolveCanonicalPerson(params: {
  email?: string | null
  phone?: string | null
  brokerageId: string
}): Promise<DeduplicateResult> {
  const supabase = createServiceClient()

  const orClauses: string[] = []
  if (params.email) {
    const normalized = normalizeEmail(params.email)
    orClauses.push(`email.eq.${normalized}`)
  }
  if (params.phone) {
    const digits = normalizePhone(params.phone)
    if (digits.length >= 7) {
      orClauses.push(`phone_digits.eq.${digits}`)
    }
  }

  if (orClauses.length === 0) {
    return { isDuplicate: false }
  }

  const { data } = await supabase
    .from("contacts")
    .select("id, email, phone_digits")
    .eq("brokerage_id", params.brokerageId)
    .is("deleted_at", null)
    .or(orClauses.join(","))
    .limit(1)
    .maybeSingle()

  if (!data) {
    return { isDuplicate: false }
  }

  const matchedEmail = params.email && data.email === normalizeEmail(params.email)
  const matchedPhone = params.phone && data.phone_digits === normalizePhone(params.phone)

  return {
    isDuplicate: true,
    existingContactId: data.id as string,
    matchField:
      matchedEmail && matchedPhone
        ? "both"
        : matchedEmail
        ? "email"
        : "phone",
    matchScore: matchedEmail && matchedPhone ? 100 : 80,
  }
}

// ─── COMMAND 2: mergeOrUpdateContactIfDuplicate ───────────────────────────────
/**
 * If a duplicate is found, update the existing contact with any non-null new fields
 * and write a dedup log row. Returns the existing contact with merged data.
 */
export async function mergeOrUpdateContactIfDuplicate(params: {
  existingContactId: string
  updates: Partial<{
    first_name: string
    last_name: string
    email: string
    phone: string
    contact_type: string
    status: string
    source: string
    source_family: string
    source_channel: string
    source_subtype: string
    campaign_attribution_id: string
  }>
  brokerageId: string
  rawRecordId?: string
}): Promise<CRMContactResult> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()

  // Only apply non-null updates that would enrich the existing record
  const mergeUpdates: Record<string, unknown> = { updated_at: now }
  for (const [key, val] of Object.entries(params.updates)) {
    if (val != null && val !== "") {
      mergeUpdates[key] = val
    }
  }

  if (params.updates.phone) {
    mergeUpdates.phone_digits = normalizePhone(params.updates.phone)
  }

  const { data, error } = await supabase
    .from("contacts")
    .update(mergeUpdates)
    .eq("id", params.existingContactId)
    .eq("brokerage_id", params.brokerageId)
    .select()
    .maybeSingle()

  if (error || !data) {
    return { success: false, error: error?.message ?? "Merge update failed" }
  }

  // Write dedup log
  await supabase.from("lead_deduplication_log").insert({
    brokerage_id: params.brokerageId,
    duplicate_of_contact_id: params.existingContactId,
    raw_record_id: params.rawRecordId ?? null,
    // lead_deduplication_log.action_taken says 'merged'.
    action_taken: "merged",
    match_score: 90,
    // lead_deduplication_log.stage is (pre_enrichment|post_enrichment|
    // viability_gate|lead_creation) — the point in the pipeline, not the
    // record kind. This dedupe happens as the record is created.
    stage: "lead_creation",
    created_at: now,
  })

  // Lifecycle event
  await supabase.from("lifecycle_events").insert({
    entity_type: "contact",
    entity_id: params.existingContactId,
    event_type: KernelEvent.CONTACT_MERGED,
    brokerage_id: params.brokerageId,
    created_at: now,
  })

  return {
    success: true,
    contact: data as Record<string, unknown>,
    contactId: data.id as string,
    isDuplicate: true,
    mergedIntoId: params.existingContactId,
  }
}

// ─── COMMAND 3: createOrUpdateContactFromDirectIntake ────────────────────────
/**
 * The canonical entry point for any consented direct intake:
 * web forms, open house sign-ins, QR scans, business card scans, portal invites.
 *
 * Flow:
 *   1. resolveCanonicalPerson() — dedup check
 *   2a. If duplicate: mergeOrUpdateContactIfDuplicate()
 *   2b. If new: insert contact row
 *   3. enrichContactAfterIntake() — queue enrichment (non-blocking)
 *   4. notifyAssignedAgentForNextAction() — non-blocking
 *   5. Emit CONTACT_CREATED or CONTACT_MERGED event
 */
export async function createOrUpdateContactFromDirectIntake(
  params: CreateContactParams
): Promise<CRMContactResult> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()

  // ── 1. Dedup ──────────────────────────────────────────────────────────────
  const dedup = await resolveCanonicalPerson({
    email: params.email ?? null,
    phone: params.phone ?? null,
    brokerageId: params.brokerage_id,
  })

  if (dedup.isDuplicate && dedup.existingContactId) {
    return mergeOrUpdateContactIfDuplicate({
      existingContactId: dedup.existingContactId,
      updates: {
        first_name: params.first_name,
        last_name: params.last_name,
        email: params.email ?? undefined,
        phone: params.phone ?? undefined,
        contact_type: params.contact_type,
        status: params.status,
        source: params.source?.source,
        source_family: params.source?.source_family,
        source_channel: params.source?.source_channel,
        source_subtype: params.source?.source_subtype,
        campaign_attribution_id: params.source?.campaign_attribution_id,
      },
      brokerageId: params.brokerage_id,
    })
  }

  // ── 2. Insert new contact ────────────────────────────────────────────────
  const phone_digits = params.phone ? normalizePhone(params.phone) : null
  const email_normalized = params.email ? normalizeEmail(params.email) : null

  const { data, error } = await supabase
    .from("contacts")
    .insert({
      // tenant anchor (scope burn-down): the tenant + owner stamps lead the row
      brokerage_id:            params.brokerage_id,
      agent_id:                params.agent_id,     // agents.id — already correct FK
      first_name:              params.first_name,
      last_name:               params.last_name,
      email:                   email_normalized,
      phone:                   params.phone ?? null,
      phone_digits:            phone_digits,
      city:                    params.city ?? null,
      state:                   params.state ?? null,
      zip_code:                params.zip_code ?? null,
      contact_type:            params.contact_type ?? "buyer",
      status:                  params.status ?? "new",
      contact_persona:         params.contact_persona ?? null,
      notes:                   params.notes ?? null,
      preferred_channel:       params.preferred_channel ?? null,
      tcpa_consent:            params.tcpa_consent ?? false,
      tcpa_consent_at:         params.tcpa_consent ? now : null,
      tcpa_consent_source:     params.source?.source ?? null,
      team_id:                 params.team_id ?? null,
      source:                  params.source?.source ?? null,
      source_family:           params.source?.source_family ?? null,
      source_channel:          params.source?.source_channel ?? null,
      source_subtype:          params.source?.source_subtype ?? null,
      campaign_attribution_id: params.source?.campaign_attribution_id ?? null,
      source_agent_id:         params.source?.source_agent_id ?? null,
      created_at:              now,
      updated_at:              now,
    })
    .select()
    .maybeSingle()

  if (error || !data) {
    return { success: false, error: error?.message ?? "Insert failed" }
  }

  const contactId = data.id as string

  // ── 3. Emit CONTACT_CREATED through the canonical kernel emitter — INSERT into
  //       lifecycle_events + reactor fan-out (notifications + sequences + portal cards
  //       + per-side Managed Agent spawn) in one call. A bare lifecycle_events INSERT
  //       silently suppressed every downstream channel — most importantly the Buyer
  //       Concierge / Listing Concierge spawn that should kick the MOMENT a buyer/
  //       seller-type contact is created. Catches the silent-suppression pattern audit.
  await emitKernelEvent({
    event:       KernelEvent.CONTACT_CREATED,
    brokerageId: params.brokerage_id,
    entityType:  "contact",
    entityId:    contactId,
    contactId,
    agentUserId: (params as { user_id?: string }).user_id,
    metadata:    { source: params.source ?? null },
  })

  // ── 4. Create first activity (intake note) ──────────────────────────────
  await supabase.from("activities").insert({
    brokerage_id:  params.brokerage_id,
    agent_id:      params.agent_id,
    contact_id:    contactId,
    activity_type: "intake",
    title:         "Contact Created",
    description:   `New contact created via ${params.source?.source ?? "manual entry"}`,
    entity_type:   "contact",
    status:        "completed",
  })

  // ── 5. Queue enrichment (non-blocking) ──────────────────────────────────
  void enrichContactAfterIntake({ contactId, brokerageId: params.brokerage_id }).catch(() => {})

  // ── 6. Notify agent (non-blocking) ──────────────────────────────────────
  void notifyAssignedAgentForNextAction({
    contactId,
    agentId:     params.agent_id,
    brokerageId: params.brokerage_id,
    contactName: `${params.first_name} ${params.last_name}`,
  }).catch(() => {})

  return {
    success: true,
    contact:   data as Record<string, unknown>,
    contactId,
    isDuplicate: false,
  }
}

// ─── COMMAND 4: createContactManually ────────────────────────────────────────
/**
 * Thin wrapper for agent-initiated manual creates from the CRM UI.
 * Delegates to createOrUpdateContactFromDirectIntake with source='manual'.
 */
export async function createContactManually(
  params: Omit<CreateContactParams, "source"> & {
    source_label?: string
  }
): Promise<CRMContactResult> {
  return createOrUpdateContactFromDirectIntake({
    ...params,
    source: {
      source:          params.source_label ?? "manual",
      source_family:   "manual",
      source_channel:  "direct",
      source_subtype:  "agent_entry",
    },
  })
}

// ─── COMMAND 5: createLeadOnlyRecordForAcquisitionSource ─────────────────────
/**
 * Creates a leads row (not a contacts row) for scraped / unconsented acquisition.
 * Track A (lead-first). Never creates a contact row — that is done by convertLeadToContact().
 */
export async function createLeadOnlyRecordForAcquisitionSource(params: {
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  lead_type?: string
  source?: string
  source_family?: string
  source_channel?: string
  motivation_type?: string
  agent_id: string
  brokerage_id: string
  raw_record_id?: string
}): Promise<CRMResult> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()

  const phone_digits = params.phone ? normalizePhone(params.phone) : null

  const { data, error } = await supabase
    .from("leads")
    .insert({
      // tenant anchor (scope burn-down): the tenant + owner stamps lead the row
      brokerage_id:     params.brokerage_id,
      agent_id:         params.agent_id,
      first_name:       params.first_name ?? null,
      last_name:        params.last_name ?? null,
      email:            params.email ? normalizeEmail(params.email) : null,
      phone:            params.phone ?? null,
      phone_digits:     phone_digits,
      lead_type:        params.lead_type ?? "buyer",
      source:           params.source ?? "scraper",
      source_family:    params.source_family ?? "acquisition",
      source_channel:   params.source_channel ?? "digital",
      motivation_type:  params.motivation_type ?? null,
      lifecycle_state:  "raw",
      is_active:        true,
      raw_record_id:    params.raw_record_id ?? null,
      created_at:       now,
      updated_at:       now,
    })
    .select("id")
    .maybeSingle()

  if (error || !data) {
    return { success: false, error: error?.message ?? "Lead insert failed" }
  }

  // ── LEAD ENRICHMENT (wave 5, DIRECT HOOK) ──────────────────────────────────
  // "enrichment also needs to still happen with raw leads" (owner).
  //
  // This is one of the three `leads` INSERT sites in app/ + lib/ and it emits NO
  // kernel event, so the reactor chokepoint (event-reactor.ts D-septies, on
  // RAW_RECORD_PROMOTED / LEAD_CAPTURED) cannot see it. A direct hook is what a
  // door without an event gets — and a direct hook rots silently, so this one is
  // named individually in scripts/enrichment-suppression-simulator.ts, which
  // fails if the call disappears.
  //
  // BEST-EFFORT AND VOIDED: creating a lead must never fail because of
  // enrichment. queueLeadEnrichment never throws either, so this is belt and
  // braces on purpose. Imported dynamically because
  // lib/enrichment/lead-enrichment-core.ts is `server-only` and a static import
  // would drag that into every module graph reaching this file — including the
  // plain-tsx guards, which crash on `server-only` at load. Same pattern as
  // queueContactEnrichment below.
  try {
    const { queueLeadEnrichmentBestEffort } = await import("@/lib/enrichment/lead-enrichment-core")
    queueLeadEnrichmentBestEffort({
      leadId:      data.id,
      brokerageId: params.brokerage_id,
      triggerType: "acquisition_source",
    })
  } catch (err) {
    console.error("[crm] lead enrichment enqueue failed:", err)
  }

  return { success: true, data: { leadId: data.id } }
}

// ─── COMMAND 6: convertLeadToContact ─────────────────────────────────────────
/**
 * Converts a leads row to a full contacts row after consent is established.
 * Sets leads.contact_id, creates the contact, writes lifecycle events.
 *
 * QUALIFICATION GATE (owner, round 37): "leads are promoted and converted to
 * contacts once qualified." This command is the canonical MANUAL conversion
 * lane (lead-desk actions ride it), so it REFUSES any lead the AI ISA has not
 * marked lead_stage='qualified'. The automatic lane (Engine 2 →
 * handleLeadAssigned) enforces the same gate in assignment-engine Step 2 —
 * both doors check server-side; neither can convert an unqualified lead.
 * Idempotent: an already-converted lead returns its existing contact.
 */
export async function convertLeadToContact(params: {
  leadId: string
  brokerageId: string
  agentId: string
  tcpaConsent: boolean
  consentSource: string
}): Promise<CRMContactResult> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()

  const { data: lead } = await supabase
    .from("leads")
    .select("id, first_name, last_name, email, phone, phone_digits, lead_type, source, source_family, source_channel, source_subtype, motivation_type, lead_stage, contact_id")
    .eq("id", params.leadId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!lead) {
    return { success: false, error: "Lead not found" }
  }

  // Idempotent short-circuit — already converted, return the existing contact.
  if ((lead as { contact_id?: string | null }).contact_id) {
    return { success: true, contactId: (lead as { contact_id?: string | null }).contact_id ?? undefined, isDuplicate: true }
  }

  // SERVER-SIDE REFUSAL of unqualified leads — conversion only once the AI ISA
  // (or the canonical handoff acceptance) marked the lead qualified.
  if ((lead as { lead_stage?: string | null }).lead_stage !== "qualified") {
    return {
      success: false,
      error:
        "Lead has not been qualified by the AI ISA — leads convert to contacts only once qualified " +
        `(lead_stage='${(lead as { lead_stage?: string | null }).lead_stage ?? "new"}').`,
    }
  }

  // Map lead_type → a VALID contacts.contact_type (CHECK: buyer|seller|both|
  // investor|vendor|lender). A raw cast of lead_type (e.g. "motivated_seller")
  // would violate the CHECK. Derive persona from motivation_type.
  const lt = (lead.lead_type ?? "").toLowerCase()
  const contactType: "buyer" | "seller" | "both" | "investor" =
    lt.includes("seller") ? "seller" : lt === "investor" ? "investor" : lt === "both" ? "both" : "buyer"
  const mt = (lead.motivation_type ?? "").toLowerCase()
  const contactPersona =
    mt === "probate" ? "probate"
    : mt === "divorce" ? "divorce"
    : (mt === "foreclosure" || mt === "pre_foreclosure") ? "motivated_seller"
    : mt === "fsbo" ? "fsbo"
    : undefined

  const result = await createOrUpdateContactFromDirectIntake({
    first_name:    lead.first_name ?? "Unknown",
    last_name:     lead.last_name ?? "",
    email:         lead.email ?? null,
    phone:         lead.phone ?? null,
    contact_type:  contactType,
    contact_persona: contactPersona,
    tcpa_consent:  params.tcpaConsent,
    agent_id:      params.agentId,
    brokerage_id:  params.brokerageId,
    source: {
      source:         lead.source ?? "lead_conversion",
      source_family:  lead.source_family ?? "acquisition",
      source_channel: lead.source_channel ?? "digital",
      source_subtype: lead.source_subtype ?? null,
    },
  })

  if (!result.success || !result.contactId) {
    return result
  }

  // ── Link lead → contact, THEN close the lead out ──────────────────────────
  //
  // THE CONVERTER GAP (closed here). Three converters exist and they did not
  // agree on what a conversion writes. This one — the MANUAL lead-desk lane —
  // stamped `contact_id`, `lifecycle_state` and `converted_at` and stopped:
  // it never set `is_active=false`, never released `ai_isa_owner`, and never
  // closed `sequence_enrollments`. So a lead converted through this door stayed
  // ACTIVE and stayed ENROLLED, and therefore sailed through every downstream
  // "is_active === false" stop the other two converters relied on. That is the
  // leak that let the AI ISA, the stale-lead sweeps and the campaign sequences
  // keep working a person who had already become a client.
  //
  // Closed by DELEGATION, not by a third copy (CLAUDE.md §6): the deactivation
  // is `lib/contact-promotion/lead-deactivator.ts:deactivateLead`, the same one
  // the promotion service uses. One implementation, three callers.
  //
  // NOT reconciled here, and deliberately reported rather than quietly changed:
  // `lifecycle_state`. This writes 'assigned'; `LEAD_CONVERTED_STATE`
  // (lib/lead-pipeline/lead-lifecycle.ts:51) is 'representation' and NOTHING
  // writes it. Moving this to 'representation' is not a one-liner — the
  // transition graph in lib/kernel/lead-acquisition-handlers.ts:19-24 admits
  // only assigned→appointment→representation, that file declares itself the
  // column's ONLY writer, and the readers of 'assigned' live in files this lane
  // does not own. The conversion GUARD therefore keys on `contact_id`, which is
  // the one marker every converter writes and every reader can trust.
  await supabase
    .from("leads")
    .update({
      contact_id:      result.contactId,
      lifecycle_state: "assigned",
      converted_at:    now,
      updated_at:      now,
    })
    .eq("id", params.leadId)

  // is_active=false + ai_isa_owner=false + sequence_enrollments closed.
  // Best-effort by construction: the contact EXISTS, and a deactivation failure
  // must not unwind a successful conversion — but it is READ and reported, never
  // swallowed, because an active converted lead is the exact shape this whole
  // guard exists to prevent.
  {
    const { deactivateLead } = await import("@/lib/contact-promotion/lead-deactivator")
    const deactivated = await deactivateLead(supabase, params.leadId)
    if (!deactivated.success) {
      console.error(
        `[crm] lead ${params.leadId} converted to contact ${result.contactId} but was NOT deactivated: ${deactivated.error ?? "unknown error"} — ` +
          `the lead is still is_active=true and may still be picked up by lead-keyed sweeps.`,
      )
    }
  }

  // PROMOTE THE NEW CONTACT INTO THE AGENT'S RETARGETING AUDIENCE.
  //
  // MERGED ONTO THIS SURVIVOR (§1) from the automatic lane, which has always done
  // it (lib/kernel/lead-acquisition-handlers.ts, inside handleLeadAssigned) while
  // this MANUAL lane never did. `onLeadConvertedForAudience` had exactly ONE
  // caller in the tree, and it was that one — so a lead a broker converted by hand
  // stayed out of the agent's Meta audience while an identical lead converted
  // automatically went in. Same business fact, two outcomes, decided by which
  // button someone pressed.
  //
  // agentUserId IS A users.id, AND params.agentId IS AN agents.id. Those id spaces
  // are DISJOINT here (23503 on the FK), so the agents row is crossed via
  // `user_id` rather than passing agentId straight through — passing it would not
  // error, it would just silently match no audience row and promote nobody, which
  // is how this kind of wire looks connected while doing nothing.
  //
  // Non-blocking and best-effort by construction: a retargeting push must never
  // unwind a completed conversion. The failure is logged, not swallowed.
  if (!result.isDuplicate) {
    try {
      const { data: agentRow, error: agentErr } = await supabase
        .from("agents")
        .select("user_id")
        .eq("id", params.agentId)
        .maybeSingle()
      const agentUserId = (agentRow as { user_id?: string | null } | null)?.user_id ?? null
      if (agentErr) {
        console.error(`[crm] audience promote skipped — agents.user_id unreadable for ${params.agentId}: ${agentErr.message}`)
      }
      const { onLeadConvertedForAudience } = await import("@/lib/audiences/audience-sync")
      void onLeadConvertedForAudience({
        contactId:   result.contactId as string,
        leadId:      params.leadId,
        brokerageId: params.brokerageId,
        agentUserId,
      }).catch((e) => {
        console.error("[crm] FB audience promote failed:", e)
      })
    } catch { /* best-effort */ }
  }

  // Lifecycle event
  //
  // VOCABULARY SPLIT, MEASURED AND LEFT IN PLACE DELIBERATELY. This lane emits
  // CONTACT_LEAD_CONVERTED while the automatic lane emits
  // LEAD_CONVERTED_TO_CONTACT for the very same fact, and processKernelEvent
  // routes by matching notification_rules.trigger_event against the event STRING
  // — so a rule written for one name can never fire for the other. Measured on
  // the live database before deciding: 42 notification rules, all active, ZERO
  // referencing either name, and zero lifecycle_events rows carrying either. So
  // nothing is silently failing today and renaming an emitted event mid-wave
  // would be a change with no evidence behind it. It is a latent trap for
  // whoever configures the first conversion notification, and it is filed rather
  // than guessed at.
  await supabase.from("lifecycle_events").insert({
    entity_type:  "lead",
    entity_id:    params.leadId,
    event_type:   KernelEvent.CONTACT_LEAD_CONVERTED,
    brokerage_id: params.brokerageId,
    created_at:   now,
    metadata:     { contact_id: result.contactId },
  })

  // A newly-created converted lead was qualified + consented, so AI-ISA keeps
  // engaging the contact until an agent toggles it off (merged from the retired
  // serviceConvertLeadToContact). Skip on a dedup-merge so we never silently
  // re-enable ISA on an existing contact an agent had toggled off.
  if (!result.isDuplicate) {
    await supabase.from("contacts").update({ ai_isa_enabled: true }).eq("id", result.contactId)
  }

  return result
}

// ─── COMMAND 7: attachLeadOriginHistoryToContact ──────────────────────────────
/**
 * Attaches historical lead origin data to an existing contact without overwriting
 * the existing source attribution. Used when a lead and contact are linked retroactively.
 */
export async function attachLeadOriginHistoryToContact(params: {
  contactId: string
  leadId: string
  brokerageId: string
}): Promise<CRMResult> {
  const supabase = createServiceClient()

  const { data: lead } = await supabase
    .from("leads")
    .select("source, source_family, source_channel, source_subtype, campaign_attribution_id, created_at")
    .eq("id", params.leadId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!lead) {
    return { success: false, error: "Lead not found" }
  }

  // Only set source fields that aren't already populated on the contact
  const { data: contact } = await supabase
    .from("contacts")
    .select("source, source_family")
    .eq("id", params.contactId)
    .maybeSingle()

  if (!contact) {
    return { success: false, error: "Contact not found" }
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (!contact.source && lead.source)               updates.source = lead.source
  if (!contact.source_family && lead.source_family) updates.source_family = lead.source_family
  if (lead.source_channel)                          updates.source_channel = lead.source_channel
  if (lead.source_subtype)                          updates.source_subtype = lead.source_subtype
  if (lead.campaign_attribution_id)                 updates.campaign_attribution_id = lead.campaign_attribution_id

  await supabase
    .from("contacts")
    .update(updates)
    .eq("id", params.contactId)
    .eq("brokerage_id", params.brokerageId)

  // Keep-one: the same values already land on contacts.source/source_family above,
  // which is the read surface for attribution — the referral_sources insert was a
  // redundant write-only ledger and has been removed.

  return { success: true }
}

// ─── COMMAND 8: enrichContactAfterIntake ─────────────────────────────────────
/**
 * Queues the contact for enrichment. Non-blocking — caller should void this.
 *
 * MERGED, then delegated. The body used to be a fourth private copy of "write a
 * lead_enrichment_queue row", and the four copies had disagreed for a long time:
 * this one had a 7-day freshness check but no guard against an already-pending
 * row (so a double intake queued twice and paid twice), contact-capture's copy
 * had the pending guard but no freshness check, the widget route had neither,
 * and lib/ghl-integration.ts had neither AND omitted brokerage_id, which made
 * every GHL-synced contact's queue row invisible to the drain.
 *
 * The survivor is
 * lib/enrichment/contact-enrichment-core.ts:queueContactEnrichment — it carries
 * BOTH guards, requires the tenant, consults BOTH enrichment stamps
 * (`enriched_at` and `last_enriched_at` are different columns owned by different
 * lanes), and applies the owner's live-deal suppression rule, which none of the
 * four copies had.
 *
 * This export is kept: it is the CRM kernel's name for the operation and
 * createOrUpdateContactFromDirectIntake calls it. Its `CRMResult` contract is
 * unchanged — success with `data.skipped` when nothing was queued.
 */
export async function enrichContactAfterIntake(params: {
  contactId: string
  brokerageId: string
}): Promise<CRMResult> {
  const { queueContactEnrichment } = await import("@/lib/enrichment/contact-enrichment-core")
  const result = await queueContactEnrichment({
    contactId:   params.contactId,
    brokerageId: params.brokerageId,
    triggerType: "contact_intake",
  })

  if (result.queued) return { success: true, data: { queued: true } }
  if (result.reason === "not_found") return { success: false, error: "Contact not found" }
  if (result.reason === "error") return { success: false, error: result.error }
  // already_queued | recently_enriched | live_deal — nothing to do, not a failure.
  return { success: true, data: { skipped: true, reason: result.reason } }
}

// ─── COMMAND 9: notifyAssignedAgentForNextAction ──────────────────────────────
/**
 * Creates an in-app notification for the assigned agent when a new contact lands.
 * Non-blocking — caller should void this.
 */
export async function notifyAssignedAgentForNextAction(params: {
  contactId: string
  agentId: string
  brokerageId: string
  contactName: string
}): Promise<CRMResult> {
  const supabase = createServiceClient()

  // Resolve users.id from agents.id for the notification
  const { data: agent } = await supabase
    .from("agents")
    .select("user_id")
    .eq("id", params.agentId)
    .maybeSingle()

  if (!agent?.user_id) return { success: false, error: "Agent not found" }

  await supabase.from("notifications").insert({
    user_id:      agent.user_id,
    brokerage_id: params.brokerageId,
    type:         "new_contact",
    title:        "New Contact Added",
    body:         `${params.contactName} was added to your CRM. Review and set next action.`,
    entity_type:  "contact",
    entity_id:    params.contactId,
    priority:     "medium",
    channel:      "in_app",
    is_read:      false,
    created_at:   new Date().toISOString(),
  })

  await supabase.from("lifecycle_events").insert({
    entity_type:  "contact",
    entity_id:    params.contactId,
    event_type:   KernelEvent.CONTACT_AGENT_NOTIFIED,
    brokerage_id: params.brokerageId,
    created_at:   new Date().toISOString(),
  })

  return { success: true }
}

// ─── COMMAND 10: updateContactRecord ─────────────────────────────────────────
/**
 * Updates a contact record. Validates the actor owns/manages the contact.
 * Writes a lifecycle event on update. Returns updated contact.
 */
export async function updateContactRecord(params: {
  contactId: string
  brokerageId: string
  agentId?: string
  userType?: string
  /** The REAL accountable actor (users.id) — under staff act-as this is the
   *  impersonator, so lifecycle_events.actor_user_id names who really wrote. */
  actorUserId?: string | null
  updates: Partial<{
    first_name: string
    last_name: string
    email: string
    phone: string
    contact_type: string
    status: string
    contact_persona: string
    buyer_stage: string
    notes: string
    preferred_channel: string
    tcpa_consent: boolean
  }>
}): Promise<CRMContactResult> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()

  const updatePayload: Record<string, unknown> = {
    ...params.updates,
    updated_at: now,
  }

  if (params.updates.phone) {
    updatePayload.phone_digits = normalizePhone(params.updates.phone)
  }
  if (params.updates.email) {
    updatePayload.email = normalizeEmail(params.updates.email)
  }

  let query = supabase
    .from("contacts")
    .update(updatePayload)
    .eq("id", params.contactId)
    .eq("brokerage_id", params.brokerageId)
    .is("deleted_at", null)

  // Agents can only update their own contacts
  if (params.userType === "agent" && params.agentId) {
    query = query.eq("agent_id", params.agentId)
  }

  const { data, error } = await query.select().maybeSingle()

  if (error || !data) {
    return { success: false, error: error?.message ?? "Update failed or contact not found" }
  }

  // Lifecycle event — actor_user_id names the REAL actor (act-as seam: the
  // impersonating staff member, never the tenant identity they act as).
  await supabase.from("lifecycle_events").insert({
    entity_type:  "contact",
    entity_id:    params.contactId,
    event_type:   KernelEvent.CONTACT_UPDATED,
    brokerage_id: params.brokerageId,
    actor_user_id: params.actorUserId ?? null,
    created_at:   now,
    metadata:     { updated_fields: Object.keys(params.updates) },
  })

  return {
    success: true,
    contact:   data as Record<string, unknown>,
    contactId: data.id as string,
  }
}

// ─── COMMAND 11: archiveContactRecord ────────────────────────────────────────
/**
 * Soft-deletes a contact by setting deleted_at. Preserves all history.
 * Writes a lifecycle event. Does NOT delete activities, conversations, or tasks.
 */
export async function archiveContactRecord(params: {
  contactId: string
  brokerageId: string
  agentId?: string
  userType?: string
  /** The REAL accountable actor (users.id) — under staff act-as this is the
   *  impersonator, so lifecycle_events.actor_user_id names who really archived. */
  actorUserId?: string | null
  reason?: string
}): Promise<CRMResult> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()

  let query = supabase
    .from("contacts")
    .update({ deleted_at: now, updated_at: now })
    .eq("id", params.contactId)
    .eq("brokerage_id", params.brokerageId)
    .is("deleted_at", null)

  if (params.userType === "agent" && params.agentId) {
    query = query.eq("agent_id", params.agentId)
  }

  // 🐛 A CONTROL THAT REPORTED SUCCESS WITHOUT DOING THE THING.
  // The predicates above are the authorization: wrong tenant, an agent who does not
  // own the contact, or an already-archived row all match ZERO rows. A zero-row
  // UPDATE is not an error in Postgres, so `error` was null, this returned
  // { success: true }, AND it wrote a CONTACT_ARCHIVED lifecycle event — an audit
  // trail asserting an archive that never happened, and a UI free to tell the user
  // their contact was removed while the record stayed live and reachable.
  // `.select("id")` makes the affected rows observable so the outcome is the truth.
  // `contact_user_id` and `agent_id` come back too — ABSORBED (wave 14) from the
  // retired app/api/contacts/delete route, which recorded the portal-login fact.
  const { data: archived, error } = await query.select("id, contact_user_id, agent_id")

  if (error) {
    return { success: false, error: error.message }
  }

  if (!archived?.length) {
    // Deliberately does not distinguish "does not exist" from "not yours" — that
    // difference is itself an id-enumeration oracle across tenants.
    return { success: false, error: "Contact not found, already archived, or not yours to archive" }
  }

  await supabase.from("lifecycle_events").insert({
    entity_type:  "contact",
    entity_id:    params.contactId,
    event_type:   KernelEvent.CONTACT_ARCHIVED,
    brokerage_id: params.brokerageId,
    actor_user_id: params.actorUserId ?? null,
    created_at:   now,
    metadata:     { reason: params.reason ?? "manual" },
  })

  // ── ABSORBED (wave 14) from app/api/contacts/delete/route.ts ────────────────
  // That route wrote an `activities` row on removal; this command wrote only a
  // lifecycle_events row. They are not the same surface: loadContactWorkspace()
  // (COMMAND 12, below) builds the contact timeline from `activities` and never
  // reads lifecycle_events, so an archive done through this lane left NO trace on
  // the timeline the CRM actually renders — the record vanished with no entry
  // saying who removed it or when. The retired route also carried one fact worth
  // keeping: a contact with a `contact_user_id` still has a live auth user after
  // the archive, because archiving deliberately does NOT delete the login (that is
  // an admin action). Both are recorded here now.
  // Vocabulary follows the intake activity written by createContactManually above
  // (activity_type/title/description/entity_type/status) — the route's
  // `notes: JSON.stringify(...)` spelling is deliberately NOT ported, because the
  // timeline reader selects title/description and would have shown nothing.
  const archivedRow = archived[0] as { contact_user_id?: string | null; agent_id?: string | null }
  await supabase.from("activities").insert({
    brokerage_id:  params.brokerageId,
    agent_id:      params.agentId ?? archivedRow.agent_id ?? null,
    contact_id:    params.contactId,
    activity_type: "contact_archived",
    title:         "Contact Archived",
    description:   archivedRow.contact_user_id
      ? `Contact archived (${params.reason ?? "manual"}). Portal login retained — deleting the auth user is a separate admin action.`
      : `Contact archived (${params.reason ?? "manual"}).`,
    entity_type:   "contact",
    status:        "completed",
    completed_at:  now,
    agent_user_id: params.actorUserId ?? null,
    metadata:      {
      reason:          params.reason ?? "manual",
      archived_by:     params.actorUserId ?? null,
      contact_user_id: archivedRow.contact_user_id ?? null,
    },
    created_at:    now,
  })

  return { success: true }
}

// ─── COMMAND 12: loadContactWorkspace ────────────────────────────────────────
/**
 * Returns the full contact workspace for the CRM detail view.
 * Runs 6 parallel queries — never blocks on a slow one.
 * All queries use maybeSingle() or limit(N).
 */
export async function loadContactWorkspace(params: {
  contactId: string
  brokerageId: string
  agentId?: string
  userType?: string
}): Promise<{
  success: boolean
  contact?: Record<string, unknown>
  activities?: Record<string, unknown>[]
  conversations?: Record<string, unknown>[]
  tasks?: Record<string, unknown>[]
  suppression?: Record<string, unknown>[]
  notes?: Record<string, unknown>[]
  error?: string
}> {
  const supabase = createServiceClient()

  let contactQuery = supabase
    .from("contacts")
    .select("*")
    .eq("id", params.contactId)
    .eq("brokerage_id", params.brokerageId)
    .is("deleted_at", null)

  if (params.userType === "agent" && params.agentId) {
    contactQuery = contactQuery.eq("agent_id", params.agentId)
  }

  const [
    { data: contact },
    { data: activities },
    { data: conversations },
    { data: tasks },
    { data: suppression },
  ] = await Promise.all([
    contactQuery.maybeSingle(),
    supabase
      .from("activities")
      .select("id, activity_type, title, description, created_at, status, agent_id")
      .eq("contact_id", params.contactId)
      .eq("brokerage_id", params.brokerageId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("conversations")
      .select("id, type, status, last_message_at, unread_count, sentiment, message_count")
      .eq("contact_id", params.contactId)
      .eq("brokerage_id", params.brokerageId)
      .order("last_message_at", { ascending: false })
      .limit(20),
    supabase
      .from("tasks")
      .select("id, title, status, due_date, priority, description, assigned_to_agent_id")
      .eq("contact_id", params.contactId)
      .eq("brokerage_id", params.brokerageId)
      .is("completed_at", null)
      .order("due_date", { ascending: true })
      .limit(20),
    supabase
      .from("contact_suppression_list")
      .select("id, channel, suppression_reason, source, created_at")
      .eq("contact_id", params.contactId)
      .eq("brokerage_id", params.brokerageId)
      .limit(10),
  ])

  if (!contact) {
    return { success: false, error: "Contact not found or no access" }
  }

  return {
    success:       true,
    contact:       contact as Record<string, unknown>,
    activities:    (activities ?? []) as Record<string, unknown>[],
    conversations: (conversations ?? []) as Record<string, unknown>[],
    tasks:         (tasks ?? []) as Record<string, unknown>[],
    suppression:   (suppression ?? []) as Record<string, unknown>[],
  }
}

// ─── COMMAND 13: generateContactFollowupDraft ─────────────────────────────────
/**
 * Generates an AI follow-up draft for a contact and saves it to ai_message_drafts.
 * Uses the existing agent AI tool pattern — writes draft_body, status='pending'.
 * Caller must pass in the generated body (from an AI action) — this command persists it.
 */
export async function generateContactFollowupDraft(params: {
  contactId: string
  agentUserId: string
  brokerageId: string
  channel: "email" | "sms"
  draftBody: string
  draftSubject?: string
  triggerEvent?: string
}): Promise<CRMResult> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("ai_message_drafts")
    .insert({
      agent_user_id: params.agentUserId,
      brokerage_id:  params.brokerageId,
      contact_id:    params.contactId,
      channel:       params.channel,
      draft_body:    params.draftBody,
      draft_subject: params.draftSubject ?? null,
      status:        "pending",
      trigger_event: params.triggerEvent ?? "manual_followup",
      created_at:    new Date().toISOString(),
    })
    .select("id")
    .maybeSingle()

  if (error || !data) {
    return { success: false, error: error?.message ?? "Draft insert failed" }
  }

  await supabase.from("lifecycle_events").insert({
    entity_type:  "contact",
    entity_id:    params.contactId,
    event_type:   KernelEvent.CONTACT_FOLLOWUP_DRAFT_GENERATED,
    brokerage_id: params.brokerageId,
    created_at:   new Date().toISOString(),
    metadata:     { draft_id: data.id, channel: params.channel },
  })

  return { success: true, data: { draftId: data.id } }
}

// ─── COMMAND 14: applyContactSuppressionState — REMOVED (duplicate) ──────────
/* ─────────────────────────────────────────────────────────────────────────────
 * TOMBSTONE — `applyContactSuppressionState` was DELETED as a DUPLICATE.
 *
 * SURVIVOR: `addSuppression` at lib/kernel/compliance/check-suppression.ts:263.
 *
 * It is the survivor because it is the one that RUNS. `applyContactSuppressionState`
 * had ZERO callers: `grep -rn applyContactSuppressionState` over app/ lib/
 * components/ scripts/ returned this definition, this file's header line, and the
 * re-export in lib/kernel/index.ts — nothing invoked it, ever. `addSuppression`
 * has three live callers (app/api/unsubscribe/route.ts, app/api/sms/inbound-optout/
 * route.ts, lib/direct-mail/mail-unsubscribe.ts). The header rule at the top of
 * this file — "ONLY this file writes contact_suppression_list via
 * applyContactSuppressionState()" — was never true of the running product, and is
 * corrected there.
 *
 * MERGED ONTO THE SURVIVOR BEFORE DELETING — this copy was the more CORRECT of
 * the two on three counts, and all three were carried across:
 *   1. `channel === 'mail'` → `contacts.direct_mail_opt_out`. The survivor had no
 *      'mail' arm at all, so a direct-mail opt-out set no contact flag and the two
 *      live mail senders (app/actions/ai-isa/engage-contact.ts:492/612,
 *      app/api/cron/farm-mail-weekly) kept sending.
 *   2. `channel === 'phone'` → `dnc_status` as well as `call_stop_flag`. The
 *      survivor wrote only `call_stop_flag`. (The survivor additionally now writes
 *      `phone_opt_out`, which NEITHER copy had and which lib/lead-intent/
 *      lead-opt-out.ts and app/actions/ai-isa/process-opt-out.ts both key on.)
 *   3. A per-channel `consent_type` instead of a two-way branch over a four-member
 *      union. The survivor ledgered a MAIL opt-out and a PHONE/DNC request both as
 *      'sms_stop'.
 *
 * NOT MERGED, deliberately and with the reason stated:
 *   · `.eq('brokerage_id', …)` on the `contacts` UPDATE. The other predicate is
 *     `.eq('id', …)` — the PRIMARY KEY, which already identifies exactly one row in
 *     exactly one tenant. A second predicate cannot narrow a PK lookup; it can only
 *     turn a legitimate opt-out into a zero-row miss when the caller's brokerageId
 *     and the contact's disagree. The survivor instead SELECTS THE UPDATED ID BACK,
 *     which is what actually catches a miss (a zero-row UPDATE is not an error).
 *   · The raw `lifecycle_events` INSERT. It bypassed lib/events/event-helpers.ts —
 *     the canonical emitter — so it wrote a row without the `source`/`dedupe_key`
 *     shape that path stamps, and `KernelEvent.CONTACT_SUPPRESSION_APPLIED` has
 *     ZERO consumers repo-wide (grep: this file and the enum declaration at
 *     lib/kernel/events.ts:521, nothing else). Copying it across would have merged a
 *     defect and added a write nothing reads. If an owner wants a suppression event,
 *     it should be emitted through event-helpers, and that is a decision, not a gap.
 *
 * ALSO FIXED IN THE SURVIVOR AND PRESENT IN NEITHER COPY: both discarded all three
 * write results and returned without checking them. supabase-js RESOLVES refusals,
 * so a foreign-key violation on the suppression row read as success — which is how
 * the unsubscribe endpoint came to report suppressions it had not performed. The
 * survivor now returns AddSuppressionResult and every caller checks it.
 * ───────────────────────────────────────────────────────────────────────────── */
