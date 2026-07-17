/**
 * lib/kernel/crm.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 0 — Canonical CRM commands for the Contact OS.
 *
 * Ownership rules:
 *   - ONLY this file writes the dedup / merge decision to contacts.
 *   - ONLY this file writes contact_suppression_list via applyContactSuppressionState().
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

export interface SuppressionStateParams {
  contactId: string
  brokerageId: string
  channel: "email" | "sms" | "phone" | "mail"
  reason: string
  source: string
  email?: string | null
  phone?: string | null
}

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
    action_taken: "merged_into_existing",
    match_score: 90,
    stage: "contact",
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

  return { success: true, data: { leadId: data.id } }
}

// ─── COMMAND 6: convertLeadToContact ─────────────────────────────────────────
/**
 * Converts a leads row to a full contacts row after consent is established.
 * Sets leads.contact_id, creates the contact, writes lifecycle events.
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
    .select("id, first_name, last_name, email, phone, phone_digits, lead_type, source, source_family, source_channel, source_subtype, motivation_type")
    .eq("id", params.leadId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!lead) {
    return { success: false, error: "Lead not found" }
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

  // Link lead → contact
  await supabase
    .from("leads")
    .update({
      contact_id:      result.contactId,
      lifecycle_state: "assigned",
      converted_at:    now,
      updated_at:      now,
    })
    .eq("id", params.leadId)

  // Lifecycle event
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

  // Write referral_sources row for audit
  await supabase.from("referral_sources").insert({
    brokerage_id: params.brokerageId,
    contact_id:   params.contactId,
    source_type:  lead.source ?? "lead",
    source_label: lead.source_family ?? "acquisition",
    created_at:   new Date().toISOString(),
  })

  return { success: true }
}

// ─── COMMAND 8: enrichContactAfterIntake ─────────────────────────────────────
/**
 * Queues the contact for enrichment. Non-blocking — caller should void this.
 * Writes a lead_enrichment_queue row with enrichments_needed based on missing fields.
 */
export async function enrichContactAfterIntake(params: {
  contactId: string
  brokerageId: string
}): Promise<CRMResult> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()

  const { data: contact } = await supabase
    .from("contacts")
    .select("email, phone, last_enriched_at")
    .eq("id", params.contactId)
    .maybeSingle()

  if (!contact) return { success: false, error: "Contact not found" }

  // Only enrich if not recently enriched (within 7 days)
  if (contact.last_enriched_at) {
    const age = Date.now() - new Date(contact.last_enriched_at as string).getTime()
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    if (age < sevenDays) return { success: true, data: { skipped: true } }
  }

  const enrichments_needed: string[] = ["skip_trace"]
  if (!contact.email) enrichments_needed.push("email_append")
  if (!contact.phone) enrichments_needed.push("phone_append")

  await supabase.from("lead_enrichment_queue").insert({
    contact_id:         params.contactId,
    brokerage_id:       params.brokerageId,
    enrichment_type:    "skip_trace",
    enrichments_needed,
    status:             "pending",
    trigger_type:       "contact_intake",
    queued_at:          now,
    max_retries:        3,
  })

  await supabase.from("lifecycle_events").insert({
    entity_type:  "contact",
    entity_id:    params.contactId,
    event_type:   KernelEvent.CONTACT_ENRICHMENT_QUEUED,
    brokerage_id: params.brokerageId,
    created_at:   now,
  })

  return { success: true }
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

  // Lifecycle event
  await supabase.from("lifecycle_events").insert({
    entity_type:  "contact",
    entity_id:    params.contactId,
    event_type:   KernelEvent.CONTACT_UPDATED,
    brokerage_id: params.brokerageId,
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

  const { error } = await query

  if (error) {
    return { success: false, error: error.message }
  }

  await supabase.from("lifecycle_events").insert({
    entity_type:  "contact",
    entity_id:    params.contactId,
    event_type:   KernelEvent.CONTACT_ARCHIVED,
    brokerage_id: params.brokerageId,
    created_at:   now,
    metadata:     { reason: params.reason ?? "manual" },
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

// ─── COMMAND 14: applyContactSuppressionState ────────────────────────────────
/**
 * Applies a suppression state to a contact across one channel.
 * Writes to contact_suppression_list, updates the contact's opt-out flags,
 * and writes a consent event for audit.
 *
 * Called by: unsubscribe handlers, SMS STOP processor, DNC ingestion, manual admin.
 */
export async function applyContactSuppressionState(
  params: SuppressionStateParams
): Promise<CRMResult> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()

  // Write suppression list entry
  await supabase.from("contact_suppression_list").insert({
    brokerage_id:       params.brokerageId,
    contact_id:         params.contactId,
    email:              params.email ?? null,
    phone:              params.phone ?? null,
    channel:            params.channel,
    suppression_reason: params.reason,
    source:             params.source,
    created_at:         now,
  })

  // Update contact opt-out flags
  const updates: Record<string, unknown> = { updated_at: now }
  if (params.channel === "email") {
    updates.email_unsubscribed    = true
    updates.email_unsubscribed_at = now
    updates.email_opt_out         = true
  } else if (params.channel === "sms") {
    updates.sms_unsubscribed    = true
    updates.sms_unsubscribed_at = now
    updates.sms_opt_out         = true
    updates.sms_unsubscribed    = true
  } else if (params.channel === "phone") {
    updates.call_stop_flag = true
    updates.dnc_status     = true
  } else if (params.channel === "mail") {
    updates.direct_mail_opt_out = true
  }

  await supabase
    .from("contacts")
    .update(updates)
    .eq("id", params.contactId)
    .eq("brokerage_id", params.brokerageId)

  // Consent event for audit
  await supabase.from("contact_consent_events").insert({
    contact_id:     params.contactId,
    brokerage_id:   params.brokerageId,
    consent_type:   params.channel === "email" ? "email_unsubscribe" : `${params.channel}_opt_out`,
    consent_text:   `${params.source}: ${params.reason}`,
    consent_source: params.source,
    consented:      false,
    created_at:     now,
  })

  // Lifecycle event
  await supabase.from("lifecycle_events").insert({
    entity_type:  "contact",
    entity_id:    params.contactId,
    event_type:   KernelEvent.CONTACT_SUPPRESSION_APPLIED,
    brokerage_id: params.brokerageId,
    created_at:   now,
    metadata:     { channel: params.channel, reason: params.reason, source: params.source },
  })

  return { success: true }
}
