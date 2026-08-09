// lib/enrichment/contact-enrichment-core.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ENRICHMENT WORK, WITH THE TENANT PASSED IN.
//
// This file exists because of a defect this repo has now shipped twice: an
// earlier wave anchored `app/actions/contact-enrichment.ts` on the SESSION
// (`const ctx = await getAgentContext(); if (!ctx.brokerageId) return {…}`) and
// the file's own comment recorded the consequence — "the enrichment cron has no
// session; under RLS the anon client returned nothing anyway". The nightly run
// has been selecting zero contacts and reporting success ever since. The same
// mistake killed the Facebook-audience sync, and the fix there was to give the
// unattended caller its OWN door onto the underlying work rather than a fake
// identity: app/api/cron/sync-facebook-audiences reads brokerage_id off the row
// it is processing and calls the kernel command directly.
//
// So: the WORK lives here and takes `brokerageId` as an argument.
//   • app/actions/contact-enrichment.ts  — the SESSION door (resolves the tenant
//     from getAgentContext, then calls in here).
//   • app/api/cron/contact-enrichment    — the UNATTENDED door (iterates active
//     brokerages and passes each id explicitly; it cannot take a tenant from a
//     caller, because it never reads one from the request).
//
// Nothing in this file reads a session, and nothing in it accepts a tenant from
// an HTTP caller.
//
// ── THE THREE THINGS THE OWNER ASKED FOR ─────────────────────────────────────
//  1. enrich as soon as a new contact comes in  → the create-time lane calls
//     `queueContactEnrichment` (see lib/kernel/crm.ts + the event reactor);
//     this file is the executor.
//  2. also re-check for a life change / other change → `runLifeChangeCheck`.
//  3. NOT while they have an active listing or an active transaction →
//     `isContactInLiveDeal` is consulted at the top of BOTH, immediately before
//     any money is spent, and is never cached across a batch.
//
// ── SPEND ────────────────────────────────────────────────────────────────────
// One enrichment = 1 PeopleData record ($0.10) + ~6 ZenRows scrapes ($0.01 each)
// = roughly $0.16 of third-party spend per contact, per the repo's own
// VENDOR_PRICING table. That is metered on the house rail:
//   • `checkVendorBudget` PRE-FLIGHT (the same gate D-ID, ElevenLabs, the AVM
//     chain and the egress dispatcher use) — an over-budget brokerage stops
//     spending instead of running up the platform's bill.
//   • `trackVendorUsageService` AFTER each vendor call — the same ledger the
//     lead-pipeline enrichment orchestrator writes, so both enrichment lanes
//     roll up into one vendor_usage_tracking number.
// No new metering rail was invented.

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createServiceClient } from "@/lib/supabase/service"
import { PeopleDataClient } from "@/lib/external"
import { OSINTClient } from "@/lib/osint-client"
import { validateEmail, validatePhone } from "@/lib/contact-validation"
import { trackVendorUsageService } from "@/lib/vendor-governance"
import { isContactInLiveDeal, contactsInLiveDeals } from "./deal-suppression"
import { hasUsableIdentifier } from "./identifier-guard"

export { hasUsableIdentifier }

const peopleData = new PeopleDataClient()
const osint = new OSINTClient()

/** Rough per-contact third-party cost, used only to PRE-FLIGHT the vendor budget
 *  (1 PeopleData record @ $0.10 + ~6 ZenRows requests @ $0.01). The ledger records
 *  the real per-call figures via trackVendorUsageService. */
const ESTIMATED_ENRICHMENT_COST_USD = 0.16
/** The life-change check is OSINT-only — no PeopleData record. */
const ESTIMATED_LIFE_CHECK_COST_USD = 0.06
/** OSINT fans out to social (3 platforms) + public records + court + property. */
const OSINT_REQUESTS_PER_SEARCH = 6

/**
 * How long an enriched contact is considered fresh. A contact whose deal ended
 * yesterday should be re-checked; a contact enriched this morning should not be
 * re-billed. Matches the persona-drift lane's re-engagement window.
 */
export const LIFE_CHANGE_CHECK_INTERVAL_DAYS = 30

/**
 * Where an enrichment run was triggered FROM.
 *
 * ── "ghl_sync" IS DELIBERATELY ABSENT (owner's wave-5 ruling) ────────────────
 *   "no ghl on when a contact is syncing to it. we only enrich the contact in
 *    this system."
 *
 * Two separate things, both checked:
 *
 *  · TRIGGER. No enrichment may be entered from a GoHighLevel sync. The live
 *    paths already refuse — lib/ghl-integration.ts:syncContactFromGHL returns
 *    "Inbound CRM sync is disabled — GHL is sync-out only", and
 *    app/api/webhooks/gohighlevel/route.ts verifies the signature and then
 *    ignores the event — and wave 3 deleted both the private GHL queue writer
 *    and the cron's GHL third pass. What survived was this member and one
 *    docstring example: vocabulary that named GHL as a legitimate enrichment
 *    trigger and so invited the path back. Removed, with no replacement.
 *  · DESTINATION. Enrichment output stays in this system. Verified rather than
 *    assumed: the canonical egress choke point lib/crm/sync.ts:syncContactToCRM
 *    takes CRMContactPayload = { firstName, lastName, email, phone, tags,
 *    source, brokerageId, agentId } — no enrichment column, no
 *    enrichment_profile, no life_events — and no module in lib/enrichment calls
 *    it. Nothing needed removing there.
 *
 * A GHL-LINKED CONTACT IS STILL ENRICHABLE. The rule is about the trigger and
 * the destination, not about excluding those contacts: a contact that arrived
 * through the bulk CRM migration importer (lib/crm/import-pull.ts) is enriched
 * here for OUR system like any other, under 'import'.
 */
export type EnrichmentSource = "manual" | "auto" | "import" | "contact_intake" | "deal_ended"

export interface EnrichmentOutcome {
  success: boolean
  enriched: boolean
  /** Set when the contact was skipped rather than enriched. */
  skipped?: "already_enriched" | "live_deal" | "budget" | "not_found" | "no_identifier"
  error?: string
}

export interface LifeChangeOutcome {
  success: boolean
  changesFound: number
  skipped?: "live_deal" | "budget" | "not_found" | "no_identifier"
  error?: string
}

// ─── QUEUE (the create-time lane) ────────────────────────────────────────────

/**
 * THE ONE WRITER of a contact-triggered `lead_enrichment_queue` row.
 *
 * lib/kernel/crm.ts states the rule at the top of the file — "ONLY this file
 * writes to lead_enrichment_queue for contact-triggered enrichment" — and three
 * other places broke it, each with its own subtly different behaviour:
 *
 *   • lib/kernel/crm.ts:enrichContactAfterIntake — a 7-day freshness check on
 *     `last_enriched_at`, but NO guard against an already-pending row, so an
 *     intake that fired twice queued the contact twice and paid twice.
 *   • lib/contact-pipeline/contact-capture.ts:queueContactEnrichmentAndScore —
 *     had the pending/processing idempotency guard the other three lacked, and
 *     no freshness check.
 *   • app/api/widget/intake/route.ts — neither guard.
 *   • lib/ghl-integration.ts:queueContactEnrichment — neither guard, AND it
 *     omitted `brokerage_id` entirely. lead_enrichment_queue.brokerage_id is
 *     nullable, so the insert succeeded; but the drain
 *     (lib/lead-pipeline/enrichment-orchestrator.ts:processEnrichmentQueue)
 *     selects `.eq('brokerage_id', brokerageId)`. Every contact synced from GHL
 *     was queued into a row no drain can ever select. Write-only since it
 *     shipped. That is why `brokerageId` is REQUIRED here and the function
 *     refuses without it rather than writing a row that cannot be processed.
 *
 * This is the merged survivor: the freshness check AND the idempotency guard AND
 * a required tenant — plus the owner's suppression rule, which none of the four
 * had.
 *
 * Cheap and non-blocking by construction: it writes one row and emits one event.
 * No vendor call happens here — the drain spends the money later, and re-checks
 * suppression itself at that point, because a contact can enter a deal between
 * being queued and being processed.
 */
export async function queueContactEnrichment(params: {
  contactId: string
  brokerageId: string
  /** Free-form provenance, e.g. 'contact_intake' | 'contact_captured' |
   *  'widget_intake' | 'import' | 'deal_ended'. No CHECK on this column.
   *  NEVER 'ghl_sync' — a GHL sync is not an enrichment trigger (see
   *  EnrichmentSource above for the ruling and the evidence). */
  triggerType: string
  enrichmentType?: string
  /** Skip if the contact was enriched within this many days. */
  freshnessDays?: number
  supabase?: SupabaseClient<any, any, any>
}): Promise<{
  queued: boolean
  reason?: "already_queued" | "recently_enriched" | "live_deal" | "not_found" | "no_identifier" | "error"
  error?: string
}> {
  const { contactId, brokerageId } = params
  if (!contactId || !brokerageId) {
    // Refusing beats writing an un-drainable row (see the GHL note above).
    return { queued: false, reason: "error", error: "contactId and brokerageId are required" }
  }

  const supabase = params.supabase ?? createServiceClient()
  const freshnessMs = (params.freshnessDays ?? 7) * 24 * 60 * 60 * 1000

  const { data: contact, error: readError } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone, enriched_at, last_enriched_at")
    .eq("id", contactId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (readError) return { queued: false, reason: "error", error: readError.message }
  if (!contact) return { queued: false, reason: "not_found" }

  // Refuse at the QUEUE, not just at the executor. A stub with no identifier
  // would otherwise sit pending forever, be picked up by every drain, and be
  // failed by the drain's own identifier check — burning its retry ladder and
  // filling the queue with rows that can never succeed.
  if (!hasUsableIdentifier(contact)) return { queued: false, reason: "no_identifier" }

  // Both stamps are consulted. `enriched_at` is written by this lane's executor
  // and `last_enriched_at` by the lead-pipeline skip-trace lane; they are
  // different columns on the same row, and reading only one re-buys enrichment
  // the other lane already paid for.
  const stamps = [contact.enriched_at, contact.last_enriched_at]
    .filter(Boolean)
    .map((t) => new Date(t as string).getTime())
    .filter((t) => !Number.isNaN(t))
  if (stamps.length > 0 && Date.now() - Math.max(...stamps) < freshnessMs) {
    return { queued: false, reason: "recently_enriched" }
  }

  // The owner's rule, applied before the row is even written: a contact in a live
  // listing or transaction is not queued at all. (The drain re-checks — this is
  // the cheap early exit, not the enforcement point.)
  const verdict = await isContactInLiveDeal({ contactId, brokerageId, supabase })
  if (verdict.inLiveDeal) {
    return { queued: false, reason: "live_deal", error: verdict.error }
  }

  const { data: existing, error: existingError } = await supabase
    .from("lead_enrichment_queue")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("contact_id", contactId)
    .in("status", ["pending", "processing"])
    .limit(1)
    .maybeSingle()

  // A refused read must not be mistaken for "nothing pending" — that inversion
  // is what turns an idempotency guard into a double-charge.
  if (existingError) return { queued: false, reason: "error", error: existingError.message }
  if (existing?.id) return { queued: false, reason: "already_queued" }

  const enrichments_needed: string[] = ["skip_trace"]
  if (!contact.email) enrichments_needed.push("email_append")
  if (!contact.phone) enrichments_needed.push("phone_append")

  const { error: insertError } = await supabase.from("lead_enrichment_queue").insert({
    contact_id: contactId,
    lead_id: null,
    brokerage_id: brokerageId,
    enrichment_type: params.enrichmentType ?? "skip_trace",
    enrichments_needed,
    status: "pending",
    trigger_type: params.triggerType,
    queued_at: new Date().toISOString(),
    retry_count: 0,
    max_retries: 3,
  })

  if (insertError) return { queued: false, reason: "error", error: insertError.message }

  // Emitted through the canonical kernel emitter so the reactor fan-out runs — a
  // bare lifecycle_events INSERT silently suppresses every downstream channel.
  try {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    const { KernelEvent } = await import("@/lib/kernel/events")
    await emitKernelEvent({
      event: KernelEvent.CONTACT_ENRICHMENT_QUEUED,
      brokerageId,
      entityType: "contact",
      entityId: contactId,
      contactId,
      metadata: { trigger_type: params.triggerType },
      // A contact queued twice in a tight loop should not fan out twice.
      dedupeKey: `enrichment_queued:${contactId}`,
      dedupeWindowSec: 300,
    })
  } catch (err) {
    // The row is written; the event is telemetry. Never fail the queue on it.
    console.error("[enrichment] CONTACT_ENRICHMENT_QUEUED emit failed:", err)
  }

  return { queued: true }
}

/**
 * Criterion 2, event-driven half — queue a LIFE-CHANGE re-check for a contact
 * whose deal has just ended.
 *
 * Called from the reactor on TRANSACTION_CLOSED / TRANSACTION_STAGE_CHANGED /
 * LISTING_STAGE_CHANGED. Those last two fire on every stage move, most of which
 * are mid-deal, so THIS function decides whether the deal has actually ended —
 * by asking `isContactInLiveDeal` rather than by parsing event metadata. "The
 * deal ended" then means exactly "no live deal remains for this contact", which
 * is the condition the ruling names, and a dual-sided client with one deal still
 * running is correctly left alone.
 *
 * `enrichment_type` is 'osint_profile', one of the five values the live
 * lead_enrichment_queue_enrichment_type_check admits. The drain routes that type
 * to `runLifeChangeCheck` (OSINT only) instead of the paid skip-trace path.
 */
export async function queueContactLifeChangeRecheck(params: {
  contactId: string
  brokerageId: string
  triggerType: string
  supabase?: SupabaseClient<any, any, any>
}): Promise<{ queued: boolean; reason?: "live_deal" | "already_queued" | "not_enriched" | "error"; error?: string }> {
  const { contactId, brokerageId } = params
  if (!contactId || !brokerageId) {
    return { queued: false, reason: "error", error: "contactId and brokerageId are required" }
  }

  const supabase = params.supabase ?? createServiceClient()

  // A contact that was never enriched has no baseline to detect a CHANGE
  // against; first enrichment owns that case, not this one. (The same honesty
  // the persona-drift lane keeps: a never-enriched record is not drift.)
  const { data: contact, error: readError } = await supabase
    .from("contacts")
    .select("id, enriched_at, last_enriched_at")
    .eq("id", contactId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (readError) return { queued: false, reason: "error", error: readError.message }
  if (!contact) return { queued: false, reason: "error", error: "Contact not found" }
  if (!contact.enriched_at && !contact.last_enriched_at) {
    // Not enriched yet — queue the FIRST enrichment instead of a re-check.
    const first = await queueContactEnrichment({
      contactId,
      brokerageId,
      triggerType: params.triggerType,
      supabase,
    })
    return first.queued
      ? { queued: true }
      : { queued: false, reason: "not_enriched", error: first.error }
  }

  const verdict = await isContactInLiveDeal({ contactId, brokerageId, supabase })
  if (verdict.inLiveDeal) {
    // Either the stage change was mid-deal, or another deal is still running.
    // Nothing to do — the next deal-end event, or the nightly sweep, will pick
    // this contact up once it is genuinely clear.
    return { queued: false, reason: "live_deal", error: verdict.error }
  }

  const { data: existing, error: existingError } = await supabase
    .from("lead_enrichment_queue")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("contact_id", contactId)
    .in("status", ["pending", "processing"])
    .limit(1)
    .maybeSingle()

  if (existingError) return { queued: false, reason: "error", error: existingError.message }
  if (existing?.id) return { queued: false, reason: "already_queued" }

  const { error: insertError } = await supabase.from("lead_enrichment_queue").insert({
    contact_id: contactId,
    lead_id: null,
    brokerage_id: brokerageId,
    enrichment_type: "osint_profile",
    enrichments_needed: ["life_events"],
    status: "pending",
    trigger_type: params.triggerType,
    queued_at: new Date().toISOString(),
    retry_count: 0,
    max_retries: 3,
  })

  if (insertError) return { queued: false, reason: "error", error: insertError.message }
  return { queued: true }
}

// ─── SHARED PRE-FLIGHT ───────────────────────────────────────────────────────

/**
 * The gate every enrichment entry point crosses. Returns `null` when it is safe
 * to spend, or the outcome to return otherwise.
 *
 * Order matters: the SUPPRESSION check runs before the budget check, because the
 * suppression answer is the owner's rule and must be observed even for a
 * brokerage with unlimited budget.
 */
async function preflight(params: {
  contactId: string
  brokerageId: string
  supabase: SupabaseClient<any, any, any>
  addCost: number
  label: string
}): Promise<{ blocked: true; skipped: "live_deal" | "budget"; error?: string } | { blocked: false }> {
  const verdict = await isContactInLiveDeal({
    contactId: params.contactId,
    brokerageId: params.brokerageId,
    supabase: params.supabase,
  })
  if (verdict.inLiveDeal) {
    console.log(
      `[enrichment] ${params.label} suppressed for ${params.contactId} — ${verdict.reason}` +
        (verdict.entityId ? ` ${verdict.entityId}` : "") +
        (verdict.error ? ` (${verdict.error})` : ""),
    )
    return { blocked: true, skipped: "live_deal", error: verdict.error }
  }

  const { checkVendorBudget } = await import("@/lib/vendor-governance/budget-gate")
  const budget = await checkVendorBudget({ brokerageId: params.brokerageId, addCost: params.addCost })
  if (!budget.allowed) {
    console.warn(
      `[enrichment] ${params.label} blocked for ${params.contactId} — vendor budget ` +
        `${budget.spent}/${budget.budget} for tier ${budget.planTier}`,
    )
    return { blocked: true, skipped: "budget" }
  }

  return { blocked: false }
}

// ─── ENRICH ONE CONTACT ──────────────────────────────────────────────────────

/**
 * Full enrichment of one contact: email/phone validation, PeopleData demographic
 * append, OSINT public/court/property records and life events.
 *
 * `brokerageId` is applied to the initial read AND to every write, so this is
 * safe to run with the service client from an unattended caller. The read
 * destructures `error` — "refused" and "no such contact" are the same shape from
 * supabase-js and only one of them is a reason to give up quietly.
 */
export async function enrichContactRecord(params: {
  contactId: string
  brokerageId: string
  source?: EnrichmentSource
  forceRefresh?: boolean
  supabase?: SupabaseClient<any, any, any>
}): Promise<EnrichmentOutcome> {
  const { contactId, brokerageId } = params
  if (!contactId || !brokerageId) {
    return { success: false, enriched: false, error: "contactId and brokerageId are required" }
  }

  const supabase = params.supabase ?? createServiceClient()

  try {
    const { data: contact, error: readError } = await supabase
      .from("contacts")
      .select("id, brokerage_id, first_name, last_name, email, phone, city, state, enriched_at")
      .eq("id", contactId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (readError) return { success: false, enriched: false, error: readError.message }
    if (!contact) return { success: false, enriched: false, skipped: "not_found", error: "Contact not found" }

    if (contact.enriched_at && !params.forceRefresh) {
      return { success: true, enriched: false, skipped: "already_enriched" }
    }

    // Nothing for a provider to match on — refuse before spending. See
    // hasUsableIdentifier: this is what stops the nightly sweep re-buying a
    // guaranteed miss on every social-DM stub, every night, forever.
    if (!hasUsableIdentifier(contact)) {
      return { success: true, enriched: false, skipped: "no_identifier" }
    }

    const gate = await preflight({
      contactId,
      brokerageId,
      supabase,
      addCost: ESTIMATED_ENRICHMENT_COST_USD,
      label: "enrich",
    })
    if (gate.blocked) {
      return { success: true, enriched: false, skipped: gate.skipped, error: gate.error }
    }

    let enrichmentData: Record<string, any> = {}

    // 1. Validate email (free — provider-side validation, no vendor ledger entry)
    if (contact.email) {
      const emailValidation = await validateEmail(contact.email as string)
      if (emailValidation?.valid) {
        await supabase
          .from("contacts")
          .update({ email_verified: true, email_verification_date: new Date().toISOString() })
          .eq("id", contactId)
          .eq("brokerage_id", brokerageId)
      }
    }

    // 2. Validate phone
    if (contact.phone) {
      const phoneValidation = await validatePhone(contact.phone as string)
      if (phoneValidation?.valid) {
        await supabase
          .from("contacts")
          .update({
            phone_verified: true,
            phone_verification_date: new Date().toISOString(),
            phone_type: phoneValidation.type,
          })
          .eq("id", contactId)
          .eq("brokerage_id", brokerageId)
      }
    }

    // 3. PeopleData — paid, one record.
    const personData = await peopleData.enrich({
      firstName: contact.first_name as string,
      lastName: contact.last_name as string,
      email: (contact.email as string) ?? undefined,
      phone: (contact.phone as string) ?? undefined,
    })

    await trackVendorUsageService({
      vendor: "peopledata",
      systemSource: "skip_trace",
      unitCount: 1,
      brokerageId,
      contactId,
      metadata: { lane: "contact_enrichment", source: params.source ?? "auto", matched: Boolean(personData) },
    })

    if (personData) {
      enrichmentData = {
        ...enrichmentData,
        age_range: personData.ageRange,
        gender: personData.gender,
        marital_status: personData.maritalStatus,
        household_income: personData.householdIncome,
        home_owner_status: personData.homeOwnerStatus,
        home_value_estimate: personData.homeValue,
        occupation: personData.currentTitle,
        linkedin_url: personData.linkedinUrl,
        facebook_url: personData.facebookUrl,
        twitter_url: personData.twitterUrl,
        data_source: "peopledata",
        confidence_score: personData.enrichmentConfidence || 70,
      }
    }

    // 4. OSINT — paid, several scrape requests.
    const osintData = await osint.searchPerson({
      firstName: contact.first_name as string,
      lastName: contact.last_name as string,
      email: (contact.email as string) ?? undefined,
      phone: (contact.phone as string) ?? undefined,
      city: (contact.city as string) ?? undefined,
      state: (contact.state as string) ?? undefined,
    })

    await trackVendorUsageService({
      vendor: "zenrows",
      systemSource: "osint_search",
      unitCount: OSINT_REQUESTS_PER_SEARCH,
      brokerageId,
      contactId,
      metadata: { lane: "contact_enrichment", source: params.source ?? "auto" },
    })

    if (osintData) {
      enrichmentData = {
        ...enrichmentData,
        public_records: osintData.public_records || [],
        court_records: osintData.court_records || [],
        property_records: osintData.property_records || [],
        life_events: osintData.life_events || [],
        last_life_event_detected: osintData.life_events?.length > 0 ? new Date().toISOString() : null,
      }

      if (osintData.social_profiles?.length) {
        const findProfile = (platform: string) =>
          osintData.social_profiles.find((p) => p.platform === platform)?.url
        enrichmentData.linkedin_url = enrichmentData.linkedin_url || findProfile("linkedin")
        enrichmentData.facebook_url = enrichmentData.facebook_url || findProfile("facebook")
        enrichmentData.twitter_url = enrichmentData.twitter_url || findProfile("twitter")
      }
    }

    // 5. Persist. Tenant-anchored on both the PK and the brokerage.
    //
    // The payload is built ABOVE the query rather than inline: the tenant-scope
    // guard reads a fixed window after `.from(`, so burying `.eq("brokerage_id",
    // …)` behind a 20-key payload makes a correctly-scoped write look unscoped
    // (app/actions/home-value.ts carries the same note for the same reason).
    // Keeping the chain short keeps the scope auditable at a glance.
    const enrichmentUpdate = {
      age_range: enrichmentData.age_range,
      gender: enrichmentData.gender,
      marital_status: enrichmentData.marital_status,
      household_income: enrichmentData.household_income,
      home_owner_status: enrichmentData.home_owner_status,
      home_value_estimate: enrichmentData.home_value_estimate,
      length_of_residence: enrichmentData.length_of_residence,
      occupation: enrichmentData.occupation,
      education_level: enrichmentData.education_level,
      linkedin_url: enrichmentData.linkedin_url,
      facebook_url: enrichmentData.facebook_url,
      twitter_url: enrichmentData.twitter_url,
      instagram_url: enrichmentData.instagram_url,
      life_events: enrichmentData.life_events || [],
      last_life_event_detected: enrichmentData.last_life_event_detected,
      public_records: enrichmentData.public_records || [],
      court_records: enrichmentData.court_records || [],
      property_records: enrichmentData.property_records || [],
      data_source: enrichmentData.data_source,
      confidence_score: enrichmentData.confidence_score || 70,
      // Written in the SAME update as the payload. Splitting the tracking
      // stamps into a second round-trip (as the old action did) means a failed
      // second write leaves a contact that looks unenriched and gets re-billed
      // on the next sweep.
      enriched_at: new Date().toISOString(),
      enrichment_source: params.source ?? "auto",
      last_life_change_check: new Date().toISOString(),
    }
    const { error: updateError } = await supabase
      .from("contacts")
      .update(enrichmentUpdate)
      .eq("brokerage_id", brokerageId)
      .eq("id", contactId)

    if (updateError) {
      console.error("[enrichment] failed to save enrichment data:", updateError)
      return { success: false, enriched: false, error: updateError.message }
    }

    return { success: true, enriched: true }
  } catch (error) {
    console.error("[enrichment] enrichContactRecord error:", error)
    return { success: false, enriched: false, error: String(error) }
  }
}

// ─── LIFE-CHANGE RE-CHECK ────────────────────────────────────────────────────

/**
 * Criterion 2 — "also check if a life change or other change happens for the
 * contact". OSINT-only: no PeopleData record is bought, because this asks
 * "what changed?", not "who is this?".
 *
 * New events are appended to contacts.life_events (jsonb) keyed on the event
 * TYPE, which is the identity this codebase gives an element (see
 * markLifeChangeNotified — the array elements carry no id).
 */
export async function runLifeChangeCheck(params: {
  contactId: string
  brokerageId: string
  supabase?: SupabaseClient<any, any, any>
  /** Recorded on the lifecycle event so the reason for the check is auditable. */
  trigger?: string
}): Promise<LifeChangeOutcome> {
  const { contactId, brokerageId } = params
  if (!contactId || !brokerageId) {
    return { success: false, changesFound: 0, error: "contactId and brokerageId are required" }
  }

  const supabase = params.supabase ?? createServiceClient()

  try {
    const { data: contact, error: readError } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, city, state, life_events")
      .eq("id", contactId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (readError) return { success: false, changesFound: 0, error: readError.message }
    if (!contact) return { success: false, changesFound: 0, skipped: "not_found", error: "Contact not found" }

    // The OSINT query is built from `${firstName} ${lastName}` — a placeholder
    // name searches for a person who does not exist.
    if (!hasUsableIdentifier(contact)) {
      return { success: true, changesFound: 0, skipped: "no_identifier" }
    }

    const gate = await preflight({
      contactId,
      brokerageId,
      supabase,
      addCost: ESTIMATED_LIFE_CHECK_COST_USD,
      label: "life-change-check",
    })
    if (gate.blocked) return { success: true, changesFound: 0, skipped: gate.skipped, error: gate.error }

    const osintData = await osint.searchPerson({
      firstName: contact.first_name as string,
      lastName: contact.last_name as string,
      city: (contact.city as string) ?? undefined,
      state: (contact.state as string) ?? undefined,
    })

    await trackVendorUsageService({
      vendor: "zenrows",
      systemSource: "osint_search",
      unitCount: OSINT_REQUESTS_PER_SEARCH,
      brokerageId,
      contactId,
      metadata: { lane: "life_change_check", trigger: params.trigger ?? "scheduled" },
    })

    let changesFound = 0
    const existingEvents: any[] = Array.isArray(contact.life_events) ? (contact.life_events as any[]) : []
    const existingTypes = new Set(existingEvents.map((e: any) => e?.type))
    const merged = [...existingEvents]

    for (const event of osintData?.life_events ?? []) {
      if (existingTypes.has(event.event)) continue
      existingTypes.add(event.event)
      merged.push({
        type: event.event,
        details: event.source,
        detected_at: new Date().toISOString(),
        confidence: 50,
      })
      changesFound++
    }

    // ONE write, whether or not anything changed. The old implementation wrote
    // the whole array once PER new event inside the loop and then wrote the
    // timestamp again afterwards — N+1 round trips, and every one of them a
    // read-modify-write race against the others.
    const update: Record<string, unknown> = { last_life_change_check: new Date().toISOString() }
    if (changesFound > 0) {
      update.life_events = merged
      update.last_life_event_detected = new Date().toISOString()
    }

    const { error: writeError } = await supabase
      .from("contacts")
      .update(update)
      .eq("id", contactId)
      .eq("brokerage_id", brokerageId)

    if (writeError) return { success: false, changesFound: 0, error: writeError.message }

    return { success: true, changesFound }
  } catch (error) {
    console.error("[enrichment] runLifeChangeCheck error:", error)
    return { success: false, changesFound: 0, error: String(error) }
  }
}

// ─── WORK-LIST READERS (tenant explicit) ─────────────────────────────────────

/**
 * Contacts in this brokerage that have never been enriched AND are not in a live
 * deal. The suppression is applied HERE as well as inside `enrichContactRecord`
 * — belt and braces is deliberate: filtering the work list keeps the caller's
 * "processed N" counters honest, and re-checking per contact catches a stage
 * transition that happened while the batch was running.
 */
export async function listUnenrichedContacts(params: {
  brokerageId: string
  limit?: number
  supabase?: SupabaseClient<any, any, any>
}): Promise<{ contacts: Array<{ id: string }>; suppressed: number; error?: string }> {
  const limit = Math.max(1, Math.min(200, params.limit ?? 25))
  const supabase = params.supabase ?? createServiceClient()

  const { data, error } = await supabase
    .from("contacts")
    .select("id")
    .eq("brokerage_id", params.brokerageId)
    .is("enriched_at", null)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) return { contacts: [], suppressed: 0, error: error.message }

  const ids = (data ?? []).map((r) => r.id as string)
  if (ids.length === 0) return { contacts: [], suppressed: 0 }

  const { suppressed, degraded, error: suppErr } = await contactsInLiveDeals({
    contactIds: ids,
    brokerageId: params.brokerageId,
    supabase,
  })
  // degraded === fail-closed: every id is in `suppressed`, so nothing is enriched.
  if (degraded) return { contacts: [], suppressed: ids.length, error: suppErr }

  return {
    contacts: ids.filter((id) => !suppressed.has(id)).map((id) => ({ id })),
    suppressed: suppressed.size,
  }
}

/**
 * Already-enriched contacts in this brokerage whose life-change check has gone
 * stale, excluding anyone in a live deal.
 *
 * `last_life_change_check` is nullable, and in SQL `col < 'x'` is NULL for a NULL
 * column — which filters the row OUT. The .or() names the null case explicitly
 * (the same null-safety defect the lead-lifecycle guard was written for).
 */
export async function listContactsDueForLifeChangeCheck(params: {
  brokerageId: string
  limit?: number
  intervalDays?: number
  supabase?: SupabaseClient<any, any, any>
}): Promise<{ contacts: Array<{ id: string }>; suppressed: number; error?: string }> {
  const limit = Math.max(1, Math.min(200, params.limit ?? 25))
  const days = params.intervalDays ?? LIFE_CHANGE_CHECK_INTERVAL_DAYS
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const supabase = params.supabase ?? createServiceClient()

  const { data, error } = await supabase
    .from("contacts")
    .select("id")
    .eq("brokerage_id", params.brokerageId)
    .not("enriched_at", "is", null)
    .or(`last_life_change_check.is.null,last_life_change_check.lt.${cutoff}`)
    .order("last_life_change_check", { ascending: true, nullsFirst: true })
    .limit(limit)

  if (error) return { contacts: [], suppressed: 0, error: error.message }

  const ids = (data ?? []).map((r) => r.id as string)
  if (ids.length === 0) return { contacts: [], suppressed: 0 }

  const { suppressed, degraded, error: suppErr } = await contactsInLiveDeals({
    contactIds: ids,
    brokerageId: params.brokerageId,
    supabase,
  })
  if (degraded) return { contacts: [], suppressed: ids.length, error: suppErr }

  return {
    contacts: ids.filter((id) => !suppressed.has(id)).map((id) => ({ id })),
    suppressed: suppressed.size,
  }
}
