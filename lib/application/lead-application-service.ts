import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { ZenrowsClient, BatchDataClient, PeopleDataClient } from "@/lib/external"
import { calculateLeadScore } from "@/lib/services/lead-management.service"
import { NotFoundError } from "@/lib/errors"
import { resolveAgentForContact } from "@/lib/lead-assignment/contact-assignment"

// ─────────────────────────────────────────────────────────────────────────────
// LEAD APPLICATION SERVICE — business model
//
// Inbound data enters the system through TWO lanes, distinguished by whether
// the source captured TCPA consent at acquisition time:
//
//   LANE A — RAW SCRAPED (no consent at source)
//     BatchData motivated sellers, ZenRows (Nextdoor, Google Search), Apify
//     (Facebook groups, Reddit, public real-estate scrapes, Yelp, Maps), OSINT
//     (LinkedIn, court records). These land in `raw_scraped_leads`
//     (platform-owned RLS) and flow through the pipeline:
//       territory → identity → pre-dedup → enrich → post-dedup → promotion.
//     On promotion a `leads` row is created (brokerage-assigned, unconsented).
//     AI-ISA may email + send direct mail (when mailing_address_verified) but
//     phone/SMS are TCPA-gated. On qualification + consent, the lead is
//     promoted to `contacts` (agent-assigned).
//
//   LANE B — CONSENTED AT SOURCE (forms / Facebook ads / real-estate sites)
//     Lead-capture forms, paid social opt-ins, Zillow/Realtor.com/etc.
//     The source provider already captured TCPA consent, so these rows
//     SKIP `raw_scraped_leads` and `leads` entirely and land directly in
//     `contacts` with tcpa_consent=true stamped. They are deduped against
//     existing contacts in the brokerage on email + phone_digits, enrichment
//     is enqueued, and AI-ISA outreach is auto-enabled UNLESS the row's
//     status indicates an active relationship (representation,
//     active_transaction, under_contract) where outreach would be inappropriate.
//
// AGENT ASSIGNMENT (both lanes)
//   Every contact requires an owner agent (agents.id, NOT users.id — per
//   migration 111). Assignment runs through resolveAgentForContact in
//   lib/lead-assignment/contact-assignment.ts with precedence:
//     1. row's owner_agent_id (form-attached / agent-tagged paid social)
//     2. solo-agent brokerages → the solo agent
//     3. brokerage assignment_rules in priority order
//     4. load-balance fallback on active brokerage agents
//   The CRM (/crm) lists contacts only — leads live in admin lead-management
//   at /app/leads until consent + assignment promotes them to contacts.
//
// AI-ISA AUTO-ENROLLMENT
//   New contacts default to ai_isa_enabled=true so ISA outreach starts
//   automatically. Contacts that already represent an active relationship
//   (status ∈ representation / active_transaction / under_contract / client /
//   lifetime_customer) default to ai_isa_enabled=false; the assigned agent
//   can manually re-enable ISA per contact if they want it on.
//
// Function map below:
//   • serviceGetLeads / serviceGetLead — query `leads` (Lane A, post-promotion)
//                                        for the admin CRM view at /app/leads.
//   • serviceEnrichLead               — flag a `leads` row as enriched
//                                       (sets enrichment_status / confidence).
//   (lead → contact promotion is the kernel command convertLeadToContact, used
//    by the lead-lifecycle action — consolidated; the former service variants
//    were removed.)
//   • serviceRejectLead               — mark a `leads` row rejected with reason
//                                       in notes (no dedicated columns).
//   • serviceImportLeads              — Lane B entry point. Writes directly to
//                                       `contacts` with consent stamped, dedup,
//                                       and resolveAgentForContact. NEVER
//                                       bypass dedup; NEVER route Lane B
//                                       through raw_scraped_leads.
// ─────────────────────────────────────────────────────────────────────────────

// Types inlined here — canonical home for lead domain types (no upward imports)
export type LeadScore = 'hot' | 'warm' | 'cold' | 'unqualified'
export type LeadIntent = 'buying' | 'selling' | 'both' | 'renting' | 'investing' | 'unknown'
export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'nurturing' | 'converted' | 'lost' | 'inactive'
export type LeadSource = 'website' | 'referral' | 'social_media' | 'paid_ads' | 'open_house' | 'cold_call' | 'zillow' | 'realtor' | 'other'
export type Lead = {
  id: string
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  score?: LeadScore
  intent?: LeadIntent
  status?: LeadStatus
  source?: LeadSource
  agent_id?: string
  brokerage_id?: string
  created_at?: string
  updated_at?: string
  [key: string]: any
}

export async function serviceGetLeads(
  agentId: string,
  brokerageId: string,
  params?: {
    search?: string
    score?: LeadScore
    intent?: LeadIntent
    status?: LeadStatus
    source?: LeadSource
    page?: number
    limit?: number
    sortBy?: string
    sortOrder?: "asc" | "desc"
    adminView?: boolean
  }
) {
  const supabase = await createClient()

  const page = params?.page || 1
  const limit = params?.limit || 10
  const offset = (page - 1) * limit

  let query = supabase
    .from("leads")
    .select("*", { count: "exact" })
    .eq("brokerage_id", brokerageId)

  // Admin/broker view: show all leads in brokerage; agent view: scope to own leads
  if (!params?.adminView) {
    query = query.eq("agent_id", agentId)
  }

  if (params?.search) {
    query = query.or(
      `first_name.ilike.%${params.search}%,last_name.ilike.%${params.search}%,email.ilike.%${params.search}%,phone.ilike.%${params.search}%`
    )
  }
  if (params?.score) query = query.eq("lead_score", params.score)
  if (params?.intent) query = query.eq("lead_type", params.intent)
  if (params?.status) query = query.eq("status", params.status)
  if (params?.source) query = query.eq("source", params.source)

  const sortBy = params?.sortBy || "created_at"
  const sortOrder = params?.sortOrder || "desc"
  query = query.order(sortBy, { ascending: sortOrder === "asc" })
  query = query.range(offset, offset + limit - 1)

  const { data, error, count } = await query
  if (error) throw error

  return {
    leads: data || [],
    total: count || 0,
    page,
    limit,
    totalPages: Math.ceil((count || 0) / limit),
  }
}

export async function serviceGetLead(agentId: string, brokerageId: string, id: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("id", id)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (error) throw error
  return data
}

export async function serviceEnrichLead(agentId: string, brokerageId: string, leadId: string) {
  const supabase = await createClient()

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (leadError) throw leadError

  // TODO: Call AI enrichment service (email validation, phone lookup, social profiles)
  const { data, error } = await supabase
    .from("leads")
    .update({
      enrichment_status: "enriched",
      last_enriched_at: new Date().toISOString(),
      enrichment_confidence: 0.8,
      updated_at: new Date().toISOString(),
    })
    .eq("id", leadId)
    .select()
    .single()

  if (error) throw error

  revalidatePath("/leads")
  return data
}

export async function serviceRejectLead(
  agentId: string,
  brokerageId: string,
  leadId: string,
  reason?: string
) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("leads")
    .update({
      status: "rejected",
      // leads has no dedicated rejection_reason / rejected_at columns; record
      // the reason in notes and rely on updated_at for the timestamp.
      notes: reason ? `Rejected: ${reason}` : "Rejected",
      updated_at: new Date().toISOString(),
    })
    .eq("id", leadId)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .select()
    .single()

  if (error) throw error

  revalidatePath("/leads")
  return data
}

// Lane B import: forms / Facebook ads / real-estate-site exports land here.
// The source captured TCPA consent already, so each row goes directly into
// `contacts` with tcpa_consent=true stamped, deduped against existing
// contacts in the brokerage on email + phone_digits.
//
// Agent assignment per the user's product rules:
//   - If the row carries an explicit owner agent (form attached to an
//     agent's landing page, agent-tagged FB ad), that agent stays.
//   - Solo-agent brokerage → assigned to the solo agent.
//   - Otherwise → brokerage assignment rules, then load-balance fallback.
//   See lib/lead-assignment/contact-assignment.ts.
//
// AI-ISA outreach is auto-enabled UNLESS the imported row carries a status
// that signals an active client relationship — those rows would inherit
// `ai_isa_enabled=false` and the agent can re-enable it manually later if
// they want ISA outreach despite the existing relationship.
//
// Returns { imported, deduped, unassigned } counts. Enrichment runs
// asynchronously through the existing contact-enrichment path.
export async function serviceImportLeads(
  agentId: string,
  brokerageId: string,
  leads: Array<Partial<Lead> & { owner_agent_id?: string | null }>
) {
  const supabase = await createClient()

  if (!leads?.length) return { imported: 0, deduped: 0, unassigned: 0 }

  // Statuses where AI-ISA outreach must NOT auto-enable (active relationship).
  // Matches RESTRICTED_STATES in the Vapi webhook + compliance authority gate.
  const RESTRICTED_STATUSES = new Set([
    "representation",
    "active_transaction",
    "under_contract",
    "client",
    "lifetime_customer",
  ])

  // Mirror the generation expression on contacts.phone_digits
  // (regexp_replace(phone, '\\D', '', 'g')) so our lookup matches the
  // stored value exactly. Slicing to last-10 here would miss contacts
  // saved with country code prefixes.
  const normalizeDigits = (p?: string | null) =>
    p ? p.replace(/\D/g, "") : null

  let imported = 0
  let deduped = 0
  let unassigned = 0

  for (const lead of leads) {
    const email = lead.email?.trim().toLowerCase() ?? null
    const phoneDigits = normalizeDigits(lead.phone)

    // Dedup: lookup any existing contact in this brokerage matching either
    // email or phone_digits. No unique constraint exists on contacts(email),
    // so this guard runs in application code.
    let existingId: string | null = null
    if (email || phoneDigits) {
      let dedupQuery = supabase
        .from("contacts")
        .select("id")
        .eq("brokerage_id", brokerageId)
        .is("deleted_at", null)

      if (email && phoneDigits) {
        dedupQuery = dedupQuery.or(`email.eq.${email},phone_digits.eq.${phoneDigits}`)
      } else if (email) {
        dedupQuery = dedupQuery.eq("email", email)
      } else if (phoneDigits) {
        dedupQuery = dedupQuery.eq("phone_digits", phoneDigits)
      }

      const { data: existing } = await dedupQuery.limit(1).maybeSingle()
      existingId = existing?.id ?? null
    }

    if (existingId) {
      deduped++
      continue
    }

    const incomingStatus = (lead.status ?? "new").toString().toLowerCase()
    const aiIsaEnabled = !RESTRICTED_STATUSES.has(incomingStatus)
    const sourceLabel = lead.source ?? "admin_import"

    // Resolve the owner agent (agents.id) per the precedence in
    // resolveAgentForContact. If no agent exists in the brokerage at all,
    // count this as unassigned and skip — the contact can't be persisted
    // without an owner (the CRM treats agent_id as required for routing).
    const ownerAgentId = lead.owner_agent_id ?? null
    const assignment = await resolveAgentForContact({
      brokerageId,
      ownerAgentId,
      source: sourceLabel,
      propertyZipCode: (lead as Record<string, unknown>).property_zip_code as string | null | undefined,
    })

    if (!assignment.agentId) {
      unassigned++
      console.error(
        `[serviceImportLeads] no eligible agent in brokerage ${brokerageId}; skipping import row`
      )
      continue
    }

    const { error: insertErr } = await supabase.from("contacts").insert({
      brokerage_id: brokerageId,
      agent_id: assignment.agentId, // agents.id, not users.id
      first_name: lead.first_name ?? "Unknown",
      last_name: lead.last_name ?? "Contact",
      email,
      phone: lead.phone ?? null,
      // phone_digits is a generated column derived from `phone` — do not set.
      source: sourceLabel,
      source_family: "contact_direct",
      contact_type: "lead",
      status: incomingStatus || "new",
      // Lane B: consent was captured at source. Stamp it explicitly.
      tcpa_consent: true,
      tcpa_consent_at: new Date().toISOString(),
      tcpa_consent_source: sourceLabel,
      // Auto-enroll into AI-ISA unless restricted-status.
      ai_isa_enabled: aiIsaEnabled,
      // Enrichment runs through the existing PeopleData queue.
      enrichment_source: null,
      metadata: {
        imported_via: "serviceImportLeads",
        imported_by_agent_id: agentId,
        assignment_method: assignment.method,
        assignment_rule_id: assignment.ruleId ?? null,
        original: lead as Record<string, unknown>,
      },
    })

    if (insertErr) {
      // Don't abort the batch on a single row failure — log and continue.
      console.error("[serviceImportLeads] insert failed:", insertErr.message)
      continue
    }

    imported++
  }

  revalidatePath("/leads")
  revalidatePath("/crm")
  return { imported, deduped, unassigned }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSOLIDATED (Data Steward audit): the former "LEADS-WIDE SERVICE FUNCTIONS"
// block (serviceCreateLead / serviceGetLeadsFull / serviceUpdateLead /
// serviceAssignLead / serviceScrape{Zillow,Nextdoor,BatchData,FacebookGroup,
// Craigslist}Leads / serviceEnrichLeadFull / serviceGetLeadsDashboardStats)
// was REMOVED after a full dependency investigation: zero callers anywhere
// (barrel re-export only), written against a schema `leads` never had
// (lead_status / lead_source / temperature / intent_type / assigned_agent_id /
// scraped_at / engagement_score), and it violated the canonical business
// process — scrapers must ingest through raw_scraped_leads → processRawRecord
// (AI-ISA owns leads until qualification), and assignment must run through the
// assignment engine + handleLeadAssigned (qualification gate + contact
// conversion). Canonical equivalents:
//   scraping      → lib/kernel/scraping.ts ingestRawSourceBatch + pipeline-processor
//   assignment    → lib/lead-assignment/assignment-engine evaluateAndAssignLead
//   enrichment    → lib/lead-pipeline/enrichment-orchestrator
//   lead queries  → serviceGetLeads above
// ─────────────────────────────────────────────────────────────────────────────
