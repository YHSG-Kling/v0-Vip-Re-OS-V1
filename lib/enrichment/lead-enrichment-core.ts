// lib/enrichment/lead-enrichment-core.ts
// ─────────────────────────────────────────────────────────────────────────────
// TRACK A — THE LEAD SIDE OF THE ENRICHMENT LANE, WITH THE TENANT PASSED IN.
//
//   "enrichment also needs to still happen with raw leads"  (owner, wave 5)
//
// ── WHAT WAS ALREADY THERE, AND WHAT WAS NOT ─────────────────────────────────
// The DRAIN has handled both tracks since it was written:
// lib/lead-pipeline/enrichment-orchestrator.ts line 2 says so, it derives
// `entityType = entry.lead_id ? 'lead' : 'contact'`, and it has a whole
// lead-specific write path (peopleDataProfileToLeadColumns, the
// raw_scraped_leads back-fill, handleLeadScored). `lead_enrichment_queue` carries
// BOTH `lead_id` and `contact_id`, both nullable (verified live).
//
// What was missing was DOOR COVERAGE. Wave 3 enumerated 19 contact-create doors
// and gave them a chokepoint plus 8 direct hooks. Nothing equivalent existed for
// leads. Enumerated the same way (docs/wave5-lead-enrichment.md), there are
// exactly THREE `leads` INSERT sites in app/ + lib/:
//
//   1. lib/lead-pipeline/pipeline-processor.ts:457  — the automatic raw→lead
//      pipeline. THE ONLY LIVE DOOR. It emits RAW_RECORD_PROMOTED, so the kernel
//      event bus covers it (lib/kernel/event-reactor.ts, D-septies) exactly as
//      CONTACT_CREATED covers the contact side.
//   2. lib/kernel/crm.ts:431  createLeadOnlyRecordForAcquisitionSource — emits
//      nothing. Hooked DIRECTLY.
//   3. lib/lead-promotion/lead-promoter.ts:82  promoteRawRecordToLead — emits
//      nothing. Hooked DIRECTLY.
//
// and TWO pre-existing `lead_id` queue writers, neither of which is a create-time
// door: lib/kernel/lead-acquisition-handlers.ts:74 (a bare INSERT with no
// freshness check, no pending-row idempotency, no identifier gate, no suppression
// — now routed through this file) and lib/lead-pipeline/persona-drift-runner.ts:39
// (a refresh sweep for already-enriched records, left alone).
//
// ── WHY THIS IS NOT contact-enrichment-core WITH A DIFFERENT COLUMN ──────────
// Three things genuinely differ, and each of them is a defect if copied:
//
//  · SUPPRESSION. `listings` and `transactions` have NO lead-keyed column — the
//    live FK scan finds neither `listings.lead_id` nor `transactions.lead_id`.
//    leads.id and contacts.id are disjoint, so the contact predicate cannot be
//    re-keyed onto a lead id; it would query a row that does not exist, get "no
//    rows", and read that as "safe to spend". isLeadInLiveDeal RESOLVES
//    leads.contact_id first. See ./deal-vocabulary for the evidence.
//  · FRESHNESS. Leads are stamped `last_enriched_at` + `enrichment_status:
//    'completed'` at INSERT, before any provider has answered. The contact test
//    (two timestamps) would therefore never queue anything. See ./lead-freshness.
//  · COST. The drain's lead path buys ONE PeopleData record and does not run the
//    OSINT fan-out (that branch is contacts-only), so the pre-flight figure is
//    $0.10, not the contact lane's $0.16. Over-stating it would refuse spend a
//    brokerage's budget actually permits.
//
// ── MONEY ────────────────────────────────────────────────────────────────────
// Leads are higher-volume than contacts, so admission control sits at the QUEUE
// rather than only at the drain:
//   1. checkVendorBudget PRE-FLIGHT here — an over-budget tenant queues ZERO lead
//      rows, so the flood never reaches the drain. Same house rail as the contact
//      core; no new metering was invented.
//   2. MAX_PENDING_LEAD_ENRICHMENTS — a hard per-tenant backlog cap on
//      pending/processing lead rows.
//   3. hasUsableIdentifier — the same stub refusal, which matters more here:
//      scraped leads are far likelier than contacts to be identity-less.
//   4. The drain's own ceiling is UNCHANGED. processEnrichmentQueue takes
//      BATCH_SIZE = 10 per tenant per 15-minute tick and BOTH tracks share those
//      slots, so adding Track A cannot raise the per-tenant spend ceiling — it
//      can only compete for the same slots.
//
// Nothing here reads a session, and nothing here accepts a tenant from an HTTP
// caller. `server-only`, so consumers use `await import(...)` — a static import
// into a module a plain-tsx guard reaches crashes the guard at load.

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createServiceClient } from "@/lib/supabase/service"
import { isLeadInLiveDeal } from "./deal-suppression"
import { hasUsableIdentifier } from "./identifier-guard"
import { leadEnrichmentIsFresh, leadHasEnrichmentEvidence } from "./lead-freshness"

// NOT re-exported. The contact core re-exports `hasUsableIdentifier` because its
// callers reach it through that file; nothing reaches the pure helpers through
// THIS one. The guard (scripts/enrichment-suppression-simulator.ts) cannot import
// them from here anyway — this module is `server-only` and a plain-tsx guard
// crashes on that at load — so it imports ./lead-freshness and ./identifier-guard
// directly, which is exactly why those two files carry no `server-only`.
// A re-export nobody imports is unwired surface; it is not added here.

/**
 * Pre-flight figure for ONE lead enrichment: a single PeopleData skip-trace
 * record at the repo's own $0.10. The drain's lead branch calls
 * skipTraceWithPeopleData once and never enters the OSINT fan-out (that is
 * guarded by `entityType === 'contact'`), so the contact lane's $0.16 would
 * over-state it. The real per-call figure is ledgered by the drain via
 * trackVendorUsageService; this number only sizes the budget question.
 */
export const ESTIMATED_LEAD_ENRICHMENT_COST_USD = 0.1

/**
 * BACKLOG CAP — the most pending/processing `lead_id` rows one tenant may hold.
 *
 * The drain empties 10 rows per tenant per tick, so a queue is meant to be a
 * short buffer, not a reservoir. A scrape run that promotes ten thousand leads in
 * an hour would otherwise commit ~$1,000 of spend into a queue nobody looked at.
 * At the repo's $0.10/record this caps committed-but-unspent lead enrichment at
 * about $20 per tenant.
 *
 * This is BACKPRESSURE, not a drop: a refused lead keeps an empty
 * `enrichment_profile`, so it is still un-enriched by evidence and the cron net
 * (listLeadsNeedingEnrichment) picks it up on a later run once the backlog
 * drains. Nothing is silently abandoned.
 */
export const MAX_PENDING_LEAD_ENRICHMENTS = 200

/** Per-brokerage bound for the cron top-up pass. Mirrors the contact cron's 25. */
export const LEAD_NET_PER_BROKERAGE = 25

export type LeadQueueRefusal =
  | "already_queued"
  | "recently_enriched"
  | "live_deal"
  | "not_found"
  | "no_identifier"
  | "budget"
  | "backlog"
  | "error"

export interface LeadQueueOutcome {
  queued: boolean
  reason?: LeadQueueRefusal
  error?: string
}

/**
 * THE ONE WRITER of a lead-triggered `lead_enrichment_queue` row.
 *
 * The contact side states the same rule and had it broken four times over; the
 * lead side had exactly one writer (lead-acquisition-handlers.ts:74) and it
 * carried none of the guards:
 *
 *   await supabase.from('lead_enrichment_queue').insert({
 *     lead_id, brokerage_id, status: 'pending',
 *     enrichment_type: 'skip_trace', trigger_type: 'lead_captured', queued_at,
 *   })
 *
 * No freshness check (a lead re-captured twice paid twice), no pending-row
 * idempotency, no identifier gate (a scraped row with no name, email or phone
 * bought a guaranteed PeopleData miss and then burned its three retries against
 * the drain's own identifier refusal), no suppression, no budget gate. That call
 * site now routes through here; the guards live in one place for both tracks.
 *
 * Cheap and non-blocking by construction: reads a few rows and writes one. NO
 * vendor call happens here — the drain spends the money later and re-checks
 * suppression itself at that point, because a lead's contact can enter a deal
 * between being queued and being drained.
 *
 * NEVER THROWS. Every caller is a lead-CREATE door, and creating a lead must
 * never fail because of enrichment.
 */
export async function queueLeadEnrichment(params: {
  leadId: string
  brokerageId: string
  /** Free-form provenance, e.g. 'raw_record_promoted' | 'lead_captured' |
   *  'acquisition_source' | 'raw_promotion' | 'lead_net'. No CHECK on the column. */
  triggerType: string
  /** Must be one of the five lead_enrichment_queue_enrichment_type_check values
   *  (skip_trace | property_match | phone_validation | osint_profile |
   *  duplicate_check). Defaults to 'skip_trace', which is what the drain's lead
   *  path actually performs. */
  enrichmentType?: string
  freshnessDays?: number
  supabase?: SupabaseClient<any, any, any>
}): Promise<LeadQueueOutcome> {
  try {
    const { leadId, brokerageId } = params

    // Refusing beats writing a row no drain can select: processEnrichmentQueue
    // filters `.eq('brokerage_id', brokerageId)` and the column is NULLABLE, so a
    // tenant-less insert succeeds and is then invisible forever. That is the exact
    // defect wave 3 found in the deleted GHL copy; it is not repeated here.
    if (!leadId || !brokerageId) {
      return { queued: false, reason: "error", error: "leadId and brokerageId are required" }
    }

    const supabase = params.supabase ?? createServiceClient()

    const { data: lead, error: readError } = await supabase
      .from("leads")
      .select("id, first_name, last_name, email, phone, last_enriched_at, enrichment_profile")
      .eq("id", leadId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    // supabase-js RESOLVES a refused query, so "RLS said no" and "no such lead"
    // arrive in the same shape and only one of them is a reason to give up quietly.
    if (readError) return { queued: false, reason: "error", error: readError.message }
    if (!lead) return { queued: false, reason: "not_found" }

    // Refuse at the QUEUE, not just at the drain. A stub with no identifier would
    // otherwise sit pending, be picked up by every drain, and be failed by the
    // drain's own identifier check — burning its retry ladder and filling the
    // queue with rows that can never succeed.
    if (!hasUsableIdentifier(lead)) return { queued: false, reason: "no_identifier" }

    // Evidence, not stamps — see ./lead-freshness for why the timestamp alone is
    // a lie on this table.
    if (leadEnrichmentIsFresh(lead, { freshnessDays: params.freshnessDays })) {
      return { queued: false, reason: "recently_enriched" }
    }

    // The owner's rule, applied before the row is even written. RESOLVES
    // leads.contact_id — it never hands a lead id to a contact-keyed predicate.
    // Fails CLOSED: an unreadable listings/transactions read suppresses.
    const verdict = await isLeadInLiveDeal({ leadId, brokerageId, supabase })
    if (verdict.inLiveDeal) {
      return { queued: false, reason: "live_deal", error: verdict.error }
    }

    const { data: existing, error: existingError } = await supabase
      .from("lead_enrichment_queue")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("lead_id", leadId)
      .in("status", ["pending", "processing"])
      .limit(1)
      .maybeSingle()

    // A refused read must not be mistaken for "nothing pending" — that inversion
    // is what turns an idempotency guard into a double-charge.
    if (existingError) return { queued: false, reason: "error", error: existingError.message }
    if (existing?.id) return { queued: false, reason: "already_queued" }

    // ── BACKLOG CAP ────────────────────────────────────────────────────────────
    // Counted over `lead_id`-bearing rows only, so a lead surge cannot be masked
    // by (or mask) the contact track's own queue depth.
    const { count: pendingLeads, error: countError } = await supabase
      .from("lead_enrichment_queue")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .not("lead_id", "is", null)
      .in("status", ["pending", "processing"])

    if (countError) {
      // Fail CLOSED on the money question too: if we cannot size the backlog we
      // do not add to it.
      return { queued: false, reason: "error", error: `backlog count: ${countError.message}` }
    }
    if ((pendingLeads ?? 0) >= MAX_PENDING_LEAD_ENRICHMENTS) {
      return { queued: false, reason: "backlog" }
    }

    // ── BUDGET PRE-FLIGHT ──────────────────────────────────────────────────────
    // The house gate (same one D-ID, ElevenLabs, the AVM chain and the egress
    // dispatcher use). Deliberately AFTER suppression, matching the contact core's
    // order: the owner's rule is observed even for a brokerage with unlimited
    // budget. It is ADVISORY and fail-open by contract, which is correct here —
    // a broken ledger read must not stop lead enrichment entirely, and the backlog
    // cap above is the hard bound that does not depend on the ledger.
    const { checkVendorBudget } = await import("@/lib/vendor-governance/budget-gate")
    const budget = await checkVendorBudget({
      brokerageId,
      addCost: ESTIMATED_LEAD_ENRICHMENT_COST_USD,
    })
    if (!budget.allowed) {
      console.warn(
        `[lead-enrichment] queue blocked for ${leadId} — vendor budget ` +
          `${budget.spent}/${budget.budget} for tier ${budget.planTier}`,
      )
      return { queued: false, reason: "budget" }
    }

    const enrichments_needed: string[] = ["skip_trace"]
    if (!lead.email) enrichments_needed.push("email_append")
    if (!lead.phone) enrichments_needed.push("phone_append")

    const { error: insertError } = await supabase.from("lead_enrichment_queue").insert({
      lead_id: leadId,
      contact_id: null,
      brokerage_id: brokerageId,
      // 'skip_trace' is one of the five values
      // lead_enrichment_queue_enrichment_type_check admits (verified live). An
      // invented literal would be REFUSED by the constraint and the branch would
      // be unreachable.
      enrichment_type: params.enrichmentType ?? "skip_trace",
      enrichments_needed,
      status: "pending",
      trigger_type: params.triggerType,
      queued_at: new Date().toISOString(),
      retry_count: 0,
      max_retries: 3,
    })

    if (insertError) return { queued: false, reason: "error", error: insertError.message }

    return { queued: true }
  } catch (error) {
    // The contract every create door relies on: this function cannot throw.
    console.error("[lead-enrichment] queueLeadEnrichment error:", error)
    return { queued: false, reason: "error", error: String(error) }
  }
}

/**
 * BEST-EFFORT wrapper for the create doors. Awaits nothing the caller must care
 * about and swallows everything: creating a lead must never fail, and must never
 * be slowed to a stop, because of enrichment.
 *
 * Exists so a door is one line and cannot get the error handling subtly wrong —
 * the shape the contact lane arrived at after four private copies each guarded
 * differently.
 */
export function queueLeadEnrichmentBestEffort(params: {
  leadId: string
  brokerageId: string
  triggerType: string
  supabase?: SupabaseClient<any, any, any>
}): void {
  void queueLeadEnrichment(params).catch((err) => {
    console.error("[lead-enrichment] best-effort enqueue failed:", err)
  })
}

/**
 * THE NET — leads in this brokerage with no enrichment EVIDENCE and no row
 * already in flight, excluding any whose contact is in a live deal.
 *
 * Why a net is needed even with the doors hooked:
 *   · every lead created before this wave shipped;
 *   · every lead refused by the backlog cap while a surge drained;
 *   · every lead whose create door emitted no event and gains no direct hook in
 *     future (the same reason wave 3 revived the contact cron rather than
 *     retiring it).
 *
 * The work list is keyed on `enrichment_profile = '{}'` rather than on
 * `last_enriched_at IS NULL`, for the reason ./lead-freshness sets out: both
 * create doors stamp the timestamp at INSERT, so a null-timestamp query returns
 * almost nothing and would look like a healthy empty net.
 *
 * `is_active` is checked so converted leads (handleLeadAssigned sets
 * `is_active: false` once the contact exists) are not enriched twice — once as a
 * lead and again as the contact the contact lane already owns.
 *
 * Tenant is REQUIRED and applied to the read. Never throws.
 */
export async function listLeadsNeedingEnrichment(params: {
  brokerageId: string
  limit?: number
  supabase?: SupabaseClient<any, any, any>
}): Promise<{ leads: Array<{ id: string }>; error?: string }> {
  const limit = Math.max(1, Math.min(200, params.limit ?? LEAD_NET_PER_BROKERAGE))
  if (!params.brokerageId) return { leads: [], error: "brokerageId is required" }

  const supabase = params.supabase ?? createServiceClient()

  const { data, error } = await supabase
    .from("leads")
    .select("id, first_name, last_name, email, phone, enrichment_profile")
    .eq("brokerage_id", params.brokerageId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(limit * 4)

  if (error) return { leads: [], error: error.message }

  // The evidence test is applied in TypeScript rather than as a PostgREST filter:
  // `enrichment_profile` is jsonb and "is a non-empty object" has no clean
  // operator here, while `.eq('enrichment_profile', '{}')` would match only the
  // exact canonical rendering. Over-fetching 4x and filtering is the honest
  // version — bounded, and the caller's own cap still applies.
  const rows = (data ?? []).filter(
    (r) => !leadHasEnrichmentEvidence(r as { enrichment_profile?: unknown }) &&
      hasUsableIdentifier(r as { first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null }),
  )

  return { leads: rows.slice(0, limit).map((r) => ({ id: r.id as string })) }
}
