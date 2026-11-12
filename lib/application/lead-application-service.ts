import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
// Wave 148 (lane 148B): the import rides THE one contact door (which runs resolveAgentForContact itself).
import { captureContact } from "@/lib/contact-pipeline/contact-capture"
import { normalizeContactIntent, type ContactIntent } from "@/lib/contact-types"
import { statusForNewContact } from "@/lib/contact-promotion/qualification"

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
// WAVE 149 (lane 149A — owner ruling 3): intent is buyer | seller | both. TOMBSTONE: 'buying' | 'selling' | 'renting' |
// 'investing' | 'unknown' stood here — a second spelling of intent (leads.lead_type is written 'buyer' / 'seller', so a
// `lead_type = 'buying'` filter matched nothing) plus a persona ('investing' → contact_persona 'investor') and two non-intents.
export type LeadIntent = ContactIntent
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

/**
 * THE ONE BROKERAGE LEAD LIST.
 *
 * ── MERGED IN (wave 14), BEFORE the duplicate was retired ────────────────────
 * app/actions/leads.ts used to export a second `getLeads` over the same table,
 * with the same session-derived brokerage scope and a DIFFERENT filter
 * vocabulary. It had no caller — its apparent one was a comment in the deleted
 * app/api/leads/list/route.ts, the string-literal false positive class the
 * wired-surface guard was hardened against. Per CLAUDE.md §1 the survivor takes
 * the capability FIRST and the duplicate goes second, so the six filters that
 * lived only there are here now:
 *
 *   lifecycleState        → leads.lifecycle_state (the ISA pipeline vocabulary;
 *                           NOT the same column as `status`, which is the lead-desk
 *                           disposition. Both are kept because both have writers.)
 *   urgencyLevel          → leads.urgency_level
 *   assignedAgentId       → leads.agent_id, as an admin-view NARROWING. Under
 *                           adminView:false the agent scope already pins the
 *                           caller's own rows and this cannot widen it.
 *   aiIsaOwner            → leads.ai_isa_owner
 *   minimumViableForIsa   → leads.minimum_viable_for_isa
 *   activeOnly            → leads.is_active
 *
 * `activeOnly` is OPT-IN rather than the retired function's unconditional
 * `.eq("is_active", true)`. Silently adopting that default here would have
 * removed rows from the live /app/leads table the moment this shipped — a
 * behaviour change dressed as a merge. The caller asks for it.
 *
 * NOT merged, deliberately: the retired function's ROLE LADDER
 * (TENANT_ADMIN_USER_TYPES + 'isa', which admits team_lead and isa but not
 * platform staff) differs from this lane's (LEAD_DESK_ROLES + platform staff).
 * Widening or narrowing an access roster is an owner ruling, not a merge — the
 * same call already recorded on the getLead tombstone in
 * app/actions/lead-management.ts.
 */
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
    /** ── merged from the retired app/actions/leads.ts:getLeads ── */
    lifecycleState?: string
    urgencyLevel?: string
    assignedAgentId?: string
    aiIsaOwner?: boolean
    minimumViableForIsa?: boolean
    activeOnly?: boolean
    /**
     * TEAM ROW SCOPE — the agents.id list of the caller's own team(s), supplied
     * by lib/auth/lead-visibility.ts and NEVER by a request body.
     *
     * A NARROWING only, and structurally incapable of widening: it is an
     * additional `.in("agent_id", …)` on top of the brokerage pin and (on the
     * agent view) on top of the caller's own agent pin, so it can only
     * intersect. It exists because the owner's ruling admits `team_lead` to the
     * lead desk while "teams see only their own board" still holds — an
     * admission with no row scope would hand every team lead the brokerage's
     * whole desk. An EMPTY array means "a team with no agents", which correctly
     * matches nothing; `undefined` means brokerage or platform scope, i.e. no
     * team narrowing at all. The two must not be collapsed.
     */
    teamAgentIds?: string[]
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
  if (params?.intent) {
    // ONE intent reader (lib/contact-types.ts): a legacy 'buying' from an old client still filters on the stored 'buyer'.
    const intent = normalizeContactIntent(params.intent)
    if (intent) query = query.eq("lead_type", intent)
  }
  if (params?.status) query = query.eq("status", params.status)
  if (params?.source) query = query.eq("source", params.source)

  // ── the merged filters ──────────────────────────────────────────────────────
  if (params?.lifecycleState) query = query.eq("lifecycle_state", params.lifecycleState)
  if (params?.urgencyLevel) query = query.eq("urgency_level", params.urgencyLevel)
  // NARROWING ONLY. On the agent view agent_id is already pinned above to the
  // caller's own id, so this second .eq() can only intersect with it — a caller
  // naming somebody else's agent id gets an empty page, never their leads.
  if (params?.assignedAgentId) query = query.eq("agent_id", params.assignedAgentId)
  // TEAM ROW SCOPE. Applied after every other filter and never in place of one —
  // it intersects, it cannot widen. `[]` (a team with no agents) becomes an
  // impossible filter rather than an empty `.in()` list, whose PostgREST spelling
  // is not a filter at all.
  if (params?.teamAgentIds !== undefined) {
    query = params.teamAgentIds.length > 0
      ? query.in("agent_id", params.teamAgentIds)
      : query.eq("agent_id", "00000000-0000-0000-0000-000000000000")
  }
  if (params?.aiIsaOwner !== undefined) query = query.eq("ai_isa_owner", params.aiIsaOwner)
  if (params?.minimumViableForIsa !== undefined) {
    query = query.eq("minimum_viable_for_isa", params.minimumViableForIsa)
  }
  if (params?.activeOnly) query = query.eq("is_active", true)

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
// Each row goes through THE one contact door (captureContact — dedupe, merge,
// assignment, enrichment). Consent is recorded ONLY when the uploaded row itself
// attests it (wave 148: the old blanket tcpa_consent=true was a fabricated consent).
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
  // Matches REPRESENTATION_LOCK_STATES (lib/kernel/compliance.ts authority gate).
  const RESTRICTED_STATUSES = new Set([
    "representation",
    "active_transaction",
    "under_contract",
    "client",
    "lifetime_customer",
  ])

  let imported = 0
  let deduped = 0
  let unassigned = 0

  for (const lead of leads) {
    const incomingStatus = (lead.status ?? "new").toString().toLowerCase()
    const aiIsaEnabled = !RESTRICTED_STATUSES.has(incomingStatus)
    // Owner ruling 3 (wave 149A): the import's stated intent, read through the ONE intent reader — buyer | seller | both, else NULL.
    const importedIntent = normalizeContactIntent((lead.lead_type as string | null | undefined) ?? lead.intent ?? null)

    // OWNER RULING, verbatim: "invitation from a lead converting to a contact makes
    // sense for status qualified but any other new contacts coming in from forms,
    // lead magnets, other real estate sites, etc. haven't been qualified yet."
    //
    // AN IMPORT IS ONE OF THOSE DOORS, and this is the door where the claim is
    // cheapest to forge: `lead.status` is caller-supplied all the way from
    // app/actions/lead-management.ts:209 `importLeads`, which is a "use server"
    // export and therefore a PUBLIC HTTP ENDPOINT (CLAUDE.md §4). An uploaded row
    // that simply said `status: "qualified"` is NOT believed — `contacts.status =
    // 'qualified'` is EARNED by the lead→contact CONVERSION path alone
    // (lib/portal/portal-invite-core.ts stampQualifiedIfLeadConverted). Only the
    // qualified spelling is refused, and only for what gets STORED.
    const storedStatus = statusForNewContact(incomingStatus, "new")
    const sourceLabel = lead.source ?? "admin_import"

    // CONSENT IS NEVER FABRICATED (wave 148, lane 148B — owner ruling 3). TOMBSTONE: this door stamped
    // `tcpa_consent: true` on EVERY imported row ("Lane B: consent was captured at source") — a claim with no wording, no
    // time and no evidence behind it, which the dispatch TCPA gate then believed. A row carries consent only when the
    // import itself ATTESTS it (an explicit `tcpa_consent: true` column on the uploaded row), recorded as the importing
    // agent's attestation with whatever wording the row carried — never invented.
    const attested = (lead as Record<string, unknown>).tcpa_consent === true
    const attestedText = String((lead as Record<string, unknown>).tcpa_consent_text ?? "").trim()

    // ONE DOOR (wave 148, lane 148B — owner ruling 4; lane 147Z Still open 1). TOMBSTONE (orphan doctrine §1.1): the
    // email / phone_digits `.or()` dedupe (error unread, the raw value spliced into the filter), the resolveAgentForContact
    // call and the contacts INSERT that stood here were a second contact writer. Merged onto THE one survivor —
    // lib/contact-pipeline/contact-capture.ts captureContact — riding this door's own session client (the injected-client
    // contract; RLS stays the gate). Preserved: the owner precedence (a row's owner_agent_id, else the brokerage rules —
    // captureContact calls the same resolveAgentForContact), the assignment attribution and the import provenance in
    // metadata, ai_isa_enabled off for an active-relationship status, the stored status, source / source_family, the
    // enrichment queue (captureContact's). CHANGED, on purpose: a row matching an existing contact is MERGED fill-if-empty
    // (its new facts land, nothing is overwritten, conflicts go to notes) instead of silently skipped — it is still counted
    // as `deduped`. A row with no eligible agent is still counted `unassigned` and skipped.
    try {
      const captured = await captureContact({
        brokerageId,
        ownerAgentId: lead.owner_agent_id ?? null,
        creatorUserId: null,
        source: sourceLabel,
        source_family: "contact_direct",
        // TOMBSTONE (wave 149, lane 149A — owner ruling 3, m935): `contact_type: "lead"` stood here. The imported row's intent
        // is read from what the import says (buyer / buying / seller / both …) through the ONE intent reader; unknown → NULL.
        ...(importedIntent ? { contact_type: importedIntent } : {}),
        status: storedStatus,
        ai_isa_enabled: aiIsaEnabled,
        first_name: lead.first_name ?? null,
        last_name: lead.last_name ?? null,
        email: lead.email?.trim().toLowerCase() ?? null,
        phone: lead.phone ?? null,
        tcpa_consent: attested,
        tcpa_consent_source: attested ? `import_attested:${sourceLabel}` : null,
        tcpa_consent_text: attested ? (attestedText || `[import attested consent by agent ${agentId ?? "unknown"}; no wording supplied]`) : null,
        metadata: {
          imported_via: "serviceImportLeads",
          imported_by_agent_id: agentId,
          original: lead as Record<string, unknown>,
        },
      }, { client: supabase })
      if (captured.action === "merged") deduped++
      else imported++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/no eligible agent/i.test(message)) {
        unassigned++
        console.error(`[serviceImportLeads] no eligible agent in brokerage ${brokerageId}; skipping import row`)
      } else {
        // Don't abort the batch on a single row failure — log and continue.
        console.error("[serviceImportLeads] capture failed:", message)
      }
    }
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
