/**
 * lib/lead-intelligence/person-timeline.ts
 *
 * ONE TIMELINE PER PERSON, first touch through post-conversion (owner ruling,
 * wave 65, verbatim): "lead intelligence is information into the interaction
 * and history of a person so this comes from if they came in as a scrape that
 * history from there until the conversion of the contact and after, also if
 * they came in from a lead magnet, etc. and if we found from scraping their
 * online behavior, which the intelligence's goal is to get them to transact
 * and where they came from for lead cost tracking."
 *
 * buildPersonTimeline({ leadId | contactId }) reads every existing table BY
 * NAME (so the readerless-write census credits them as read) and folds them
 * into one chronologically ordered event list:
 *
 *   scrape_source      raw_scraped_leads          (source, source_channel,
 *                                                   cost_per_record, scraper_execution_id)
 *   lead_magnet_intake form_submissions            (widget / lead-magnet / portal / open-house)
 *   behavioral_signal  lib/lead-intelligence/behavioral-summary.ts
 *                        (EXTENDED, not duplicated — external_behavior, IDX,
 *                        nextdoor, google search, OSINT)
 *   isa_touch          intelligent_outreach_log, ai_isa_calls, voice_calls,
 *                        ai_isa_activities, lead_conversation_history
 *   assignment         assignment_log              (brokerage/team-lead rules)
 *   conversion         leads.converted_at + contact_id (the LINK
 *                        lib/contact-promotion/history-carry.ts stamps)
 *   post_conversion    activities (contact_id)      (agent/ISA activity after
 *                                                     the person became a contact)
 *
 * ROLE GATING IS THE CALLER'S JOB, NOT A SECOND COPY OF IT. Every event below
 * carries `sensitivity: "lead_desk_only" | "summary_safe"` so ONE build serves
 * both surfaces (owner ruling / CLAUDE.md §5): the lead-desk lead detail page
 * (app/leads/[leadId]) renders everything; the contact detail page (agent-
 * facing) filters to `summary_safe` and to `occurredAt >= convertedAt` — raw
 * scrape/behavioral provenance never reaches an agent. `redactForContactView`
 * below does exactly that filter so no caller has to reimplement it.
 *
 * NEVER THROWS. Every table read is independent and best-effort — a refused
 * read drops that source from the timeline (with a warning), never the whole
 * page.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { buildBehavioralIntentSummary } from "./behavioral-summary"

type Svc = ReturnType<typeof createServiceClient>

export type TimelineEventType =
  | "scrape_source"
  | "lead_magnet_intake"
  | "behavioral_signal"
  | "isa_outreach"
  | "isa_call"
  | "isa_activity"
  | "conversation"
  | "assignment"
  | "conversion"
  | "post_conversion_activity"

export interface TimelineEvent {
  id: string
  type: TimelineEventType
  occurredAt: string | null
  summary: string
  /** Raw provenance (source names, scrape channel, OSINT payload shape, cost) —
   *  LEAD-DESK ONLY. Never rendered to an agent/contact-facing role. */
  sensitivity: "lead_desk_only" | "summary_safe"
  detail?: Record<string, unknown>
}

export interface PersonTimelineResult {
  leadId: string | null
  contactId: string | null
  brokerageId: string | null
  /** Chronological, oldest first. */
  events: TimelineEvent[]
  /** = leads.converted_at once the person converted; events at/after this are
   *  "post-conversion" for the summarized contact-facing view. */
  convertedAt: string | null
  acquisitionCost: number | null
  behavioralIntentScore: number
  warnings: string[]
}

interface Params {
  leadId?: string | null
  contactId?: string | null
  brokerageId?: string | null
  client?: Svc
}

const EMPTY = (leadId: string | null, contactId: string | null, brokerageId: string | null): PersonTimelineResult => ({
  leadId, contactId, brokerageId, events: [], convertedAt: null, acquisitionCost: null,
  behavioralIntentScore: 0, warnings: [],
})

export async function buildPersonTimeline(params: Params): Promise<PersonTimelineResult> {
  let leadId = params.leadId ?? null
  let contactId = params.contactId ?? null
  let brokerageId = params.brokerageId ?? null
  const warnings: string[] = []

  // Short-circuit BEFORE constructing a service client — a caller-less,
  // id-less call must never require live Supabase env vars just to return the
  // honest empty shape (this also keeps the function safe to import from a
  // plain `tsx` guard simulator, same reasoning as contact-creator.ts's
  // dynamic import of server-only enrichment).
  if (!leadId && !contactId) return EMPTY(null, null, brokerageId)
  const svc = params.client ?? createServiceClient()

  // ── Resolve the missing half of the pair, and the anchor row ─────────────
  let convertedAt: string | null = null
  let acquisitionCost: number | null = null
  let leadRow: Record<string, any> | null = null

  if (leadId) {
    const { data, error } = await svc.from("leads")
      .select("id, brokerage_id, contact_id, converted_at, source, source_family, source_channel, source_subtype, cost_per_record, acquisition_cost, raw_record_id, campaign_attribution_id")
      .eq("id", leadId).maybeSingle()
    if (error) warnings.push(`leads read refused: ${error.message}`)
    else if (data) {
      leadRow = data
      contactId = contactId ?? (data.contact_id as string | null)
      brokerageId = brokerageId ?? (data.brokerage_id as string | null)
      convertedAt = (data.converted_at as string | null) ?? null
      acquisitionCost = (data.acquisition_cost as number | null) ?? (data.cost_per_record as number | null) ?? null
    }
  }
  // A contact may trace to MULTIPLE leads (re-scraped, re-imported). Every
  // lead id sharing this contact contributes its own scrape/assignment/
  // conversion events — contact_lead_history (migration 039) is the lineage
  // join, already the sanctioned projection for exactly this (see
  // app/api/contacts/[contactId]/lead-history/route.ts).
  let allLeadIds: string[] = leadId ? [leadId] : []
  if (contactId) {
    // contact_lead_history (migration 039) has NO plain `brokerage_id` — its
    // tenant column is `contact_brokerage_id` (verified against
    // scripts/schema-snapshot.ts; the view also carries a lead-side
    // `contact_agent_id`, same naming convention). Selecting the wrong name
    // would be a live SELECT-time refusal, not a silent miss.
    const { data: lineage, error } = await svc.from("contact_lead_history")
      .select("lead_id, contact_brokerage_id, converted_at")
      .eq("contact_id", contactId)
    if (error) warnings.push(`contact_lead_history read refused: ${error.message}`)
    else {
      const rows = (lineage ?? []) as Array<{ lead_id: string | null; contact_brokerage_id: string | null; converted_at: string | null }>
      const ids = rows.map((r) => r.lead_id).filter((v): v is string => !!v)
      if (ids.length > 0) allLeadIds = [...new Set([...allLeadIds, ...ids])]
      brokerageId = brokerageId ?? (rows.find((r) => r.contact_brokerage_id)?.contact_brokerage_id ?? null)
      const earliestConvertedAt = rows.map((r) => r.converted_at).filter((v): v is string => !!v).sort()[0] ?? null
      convertedAt = convertedAt ?? earliestConvertedAt
    }
  }

  if (!brokerageId) {
    // Without a tenant anchor nothing below can be safely scoped — CLAUDE.md
    // §4 fail-closed. Return what was already resolved rather than reading
    // brokerage-scoped tables un-pinned.
    warnings.push("no brokerage_id resolved — brokerage-scoped sources (form_submissions, assignment_log, ad_campaigns) skipped")
  }

  const events: TimelineEvent[] = []

  // ── 1. SCRAPE SOURCE — raw_scraped_leads (per lead id) ────────────────────
  if (allLeadIds.length > 0) {
    // NOT SELECTED: raw_scraped_leads.cost_per_record. The column exists
    // (scripts/schema-snapshot.ts) but its only writer — the scraper insert in
    // lib/kernel/scraping.ts (SCRAPING IS FROZEN this wave, not editable here)
    // — never stamps it; reading it here would create a NEW one-sided
    // read-with-no-writer pair (opposite-missing 1b, confirmed live against
    // this build: `grep cost_per_record lib/kernel/scraping.ts` finds no
    // writer). CLAUDE.md §1 forbids inventing a reader to paper over a gap in
    // frozen code — reported, not silenced. `leads.cost_per_record` (used
    // below and by lib/contact-promotion/acquisition-cost.ts) IS written, by
    // the pipeline-processor promotion step, so lead-level cost is still
    // faithfully represented on the conversion event.
    const { data, error } = await svc.from("raw_scraped_leads")
      .select("id, lead_id, source, source_channel, source_family, source_subtype, source_origin, scraper_execution_id, created_at, dedupe_status")
      .in("lead_id", allLeadIds)
    if (error) warnings.push(`raw_scraped_leads read refused: ${error.message}`)
    else {
      for (const r of (data ?? []) as Array<Record<string, any>>) {
        events.push({
          id: `raw:${r.id}`,
          type: "scrape_source",
          occurredAt: r.created_at ?? null,
          summary: `Sourced via ${r.source ?? "an unknown source"}${r.source_channel ? ` (${r.source_channel})` : ""}`,
          sensitivity: "lead_desk_only",
          detail: {
            source: r.source, sourceFamily: r.source_family, sourceChannel: r.source_channel,
            sourceSubtype: r.source_subtype, sourceOrigin: r.source_origin,
            scraperExecutionId: r.scraper_execution_id, dedupeStatus: r.dedupe_status,
          },
        })
      }
    }
  } else if (leadRow) {
    // No raw_scraped_leads row reached this lead (a direct intake, not a
    // scrape) — still record the lead's own first-touch source honestly.
    events.push({
      id: `lead-origin:${leadRow.id}`,
      type: "scrape_source",
      occurredAt: null,
      summary: `First recorded via ${leadRow.source ?? "an unrecorded source"}${leadRow.source_channel ? ` (${leadRow.source_channel})` : ""}`,
      sensitivity: "lead_desk_only",
      detail: { source: leadRow.source, sourceFamily: leadRow.source_family, sourceChannel: leadRow.source_channel },
    })
  }

  // ── 2. LEAD MAGNET / WIDGET / PORTAL / OPEN-HOUSE INTAKE — form_submissions ─
  if (contactId && brokerageId) {
    const { data, error } = await svc.from("form_submissions")
      .select("id, form_name, source, context_type, context_id, submitted_at, created_at, tcpa_consent_given")
      .eq("brokerage_id", brokerageId)
      .eq("contact_id", contactId)
    if (error) warnings.push(`form_submissions read refused: ${error.message}`)
    else {
      for (const r of (data ?? []) as Array<Record<string, any>>) {
        events.push({
          id: `form:${r.id}`,
          type: "lead_magnet_intake",
          occurredAt: r.submitted_at ?? r.created_at ?? null,
          summary: `Submitted "${r.form_name ?? "a form"}"${r.source ? ` via ${r.source}` : ""}${r.context_type ? ` (${r.context_type})` : ""}`,
          sensitivity: "summary_safe",
          detail: { formName: r.form_name, source: r.source, contextType: r.context_type, contextId: r.context_id, tcpaConsentGiven: r.tcpa_consent_given },
        })
      }
    }
  }

  // ── 3. BEHAVIORAL SIGNALS — EXTENDED from lib/lead-intelligence/behavioral-summary.ts ─
  // Never duplicated: this calls the one reader for external_behavior, IDX,
  // nextdoor, google search and OSINT, and folds its rows into timeline events.
  let behavioralIntentScore = 0
  if (contactId) {
    const summary = await buildBehavioralIntentSummary(contactId, brokerageId, svc)
    behavioralIntentScore = summary.behavioralIntentScore
    for (const r of summary.externalBehavior) {
      events.push({
        id: `ext-behavior:${contactId}:${r.scrapedAt ?? Math.random()}`,
        type: "behavioral_signal",
        occurredAt: r.scrapedAt,
        summary: `External behavior: ${r.activityType ?? "activity"} via ${r.source ?? "unknown source"}${r.interestLevel ? ` (interest: ${r.interestLevel})` : ""}`,
        sensitivity: "lead_desk_only",
        detail: { source: r.source, propertyAddressesViewed: r.propertyAddressesViewed, location: r.location, viaZenrows: r.viaZenrows },
      })
    }
    for (const r of summary.idxInteractions) {
      events.push({
        id: `idx:${contactId}:${r.occurredAt ?? Math.random()}`,
        type: "behavioral_signal",
        occurredAt: r.occurredAt,
        summary: `IDX property interaction: ${r.interactionType ?? "activity"}${r.propertyAddress ? ` — ${r.propertyAddress}` : ""}`,
        sensitivity: "lead_desk_only",
        detail: { mlsNumber: r.mlsNumber, viewDurationSeconds: r.viewDurationSeconds },
      })
    }
    for (const r of summary.nextdoorActivity) {
      events.push({
        id: `nextdoor:${contactId}:${Math.random()}`,
        type: "behavioral_signal",
        occurredAt: null,
        summary: `Nextdoor activity: ${r.activityType ?? "activity"}${r.neighborhood ? ` in ${r.neighborhood}` : ""}`,
        sensitivity: "lead_desk_only",
        detail: { keywords: r.keywords, relevanceScore: r.relevanceScore },
      })
    }
    for (const r of summary.googleSearchActivity) {
      events.push({
        id: `google-search:${contactId}:${Math.random()}`,
        type: "behavioral_signal",
        occurredAt: null,
        summary: `Google search intent: ${r.detectedIntent ?? "unspecified"}${r.searchLocation ? ` near ${r.searchLocation}` : ""}`,
        sensitivity: "lead_desk_only",
        detail: { searchTerms: r.searchTerms },
      })
    }
    if (summary.osintSignalCount > 0) {
      events.push({
        id: `osint:${contactId}`,
        type: "behavioral_signal",
        occurredAt: null,
        summary: `${summary.osintSignalCount} OSINT enrichment source(s): ${summary.osintSources.join(", ") || "unspecified"}`,
        sensitivity: "lead_desk_only",
      })
    }
  }

  // ── 4. ISA TOUCHES — intelligent_outreach_log, ai_isa_calls, voice_calls, ai_isa_activities ─
  if (contactId) {
    const [outreachRes, isaCallsRes, voiceCallsRes, isaActivitiesRes] = await Promise.all([
      svc.from("intelligent_outreach_log")
        .select("id, outreach_type, channel, created_at")
        .eq("contact_id", contactId),
      svc.from("ai_isa_calls")
        .select("id, script_used, appointment_set, lead_quality_score, created_at")
        .eq("contact_id", contactId),
      svc.from("voice_calls")
        .select("id, call_type, direction, outcome, duration_seconds, started_at")
        .eq("contact_id", contactId),
      svc.from("ai_isa_activities")
        .select("id, activity_type, channel, outcome, created_at")
        .eq("contact_id", contactId),
    ])
    if (outreachRes.error) warnings.push(`intelligent_outreach_log read refused: ${outreachRes.error.message}`)
    for (const r of (outreachRes.data ?? []) as Array<Record<string, any>>) {
      events.push({
        id: `outreach:${r.id}`,
        type: "isa_outreach",
        occurredAt: r.created_at ?? null,
        summary: `Value-first outreach sent: ${r.outreach_type ?? "outreach"}${r.channel ? ` via ${r.channel}` : ""}`,
        sensitivity: "summary_safe",
      })
    }
    if (isaCallsRes.error) warnings.push(`ai_isa_calls read refused: ${isaCallsRes.error.message}`)
    for (const r of (isaCallsRes.data ?? []) as Array<Record<string, any>>) {
      events.push({
        id: `isa-call:${r.id}`,
        type: "isa_call",
        occurredAt: r.created_at ?? null,
        summary: `AI ISA call${r.appointment_set ? " — appointment set" : ""}${typeof r.lead_quality_score === "number" ? ` (quality ${r.lead_quality_score})` : ""}`,
        sensitivity: "summary_safe",
      })
    }
    if (voiceCallsRes.error) warnings.push(`voice_calls read refused: ${voiceCallsRes.error.message}`)
    for (const r of (voiceCallsRes.data ?? []) as Array<Record<string, any>>) {
      events.push({
        id: `voice-call:${r.id}`,
        type: "isa_call",
        occurredAt: r.started_at ?? null,
        summary: `${r.direction ?? "Call"} ${r.call_type ?? "voice"} call${r.outcome ? ` — ${r.outcome}` : ""}${typeof r.duration_seconds === "number" ? ` (${r.duration_seconds}s)` : ""}`,
        sensitivity: "summary_safe",
      })
    }
    if (isaActivitiesRes.error) warnings.push(`ai_isa_activities read refused: ${isaActivitiesRes.error.message}`)
    for (const r of (isaActivitiesRes.data ?? []) as Array<Record<string, any>>) {
      events.push({
        id: `isa-activity:${r.id}`,
        type: "isa_activity",
        occurredAt: r.created_at ?? null,
        summary: `AI ISA ${r.activity_type ?? "activity"}${r.channel ? ` via ${r.channel}` : ""}${r.outcome ? ` — ${r.outcome}` : ""}`,
        sensitivity: "summary_safe",
      })
    }
  }

  // Conversation transcript — lead-side only (lead_conversation_history is
  // keyed on lead_id, per app/leads/[leadId]/page.tsx). LEAD-DESK ONLY: it is
  // the raw inbound/outbound transcript, not a summarized touch.
  if (allLeadIds.length > 0) {
    const { data, error } = await svc.from("lead_conversation_history")
      .select("id, channel, direction, message_content, occurred_at")
      .in("lead_id", allLeadIds)
    if (error) warnings.push(`lead_conversation_history read refused: ${error.message}`)
    else {
      for (const r of (data ?? []) as Array<Record<string, any>>) {
        events.push({
          id: `conversation:${r.id}`,
          type: "conversation",
          occurredAt: r.occurred_at ?? null,
          summary: `${r.direction === "inbound" ? "Received" : "Sent"} ${r.channel ?? "message"}: "${String(r.message_content ?? "").slice(0, 140)}"`,
          sensitivity: "lead_desk_only",
        })
      }
    }
  }

  // ── 5. ASSIGNMENT — assignment_log (the brokerage/team-lead rules outcome) ─
  if (allLeadIds.length > 0 && brokerageId) {
    const { data, error } = await svc.from("assignment_log")
      .select("id, agent_id, assignment_method, routing_reason, score_at_assignment, created_at")
      .eq("brokerage_id", brokerageId)
      .in("lead_id", allLeadIds)
    if (error) warnings.push(`assignment_log read refused: ${error.message}`)
    else {
      for (const r of (data ?? []) as Array<Record<string, any>>) {
        events.push({
          id: `assignment:${r.id}`,
          type: "assignment",
          occurredAt: r.created_at ?? null,
          summary: `Assigned via ${r.assignment_method ?? "assignment rules"}${typeof r.score_at_assignment === "number" ? ` (score ${r.score_at_assignment})` : ""}`,
          sensitivity: "summary_safe",
          detail: { routingReason: r.routing_reason },
        })
      }
    }
  }

  // ── 6. CONVERSION — the lead→contact link itself ──────────────────────────
  if (convertedAt && contactId) {
    events.push({
      id: `conversion:${contactId}`,
      type: "conversion",
      occurredAt: convertedAt,
      summary: "Converted from lead to contact (ISA qualification / positive intent)",
      sensitivity: "summary_safe",
      detail: { acquisitionCost },
    })
  }

  // ── 7. POST-CONVERSION CONTACT ACTIVITY — activities (contact_id) ─────────
  if (contactId && brokerageId) {
    const { data, error } = await svc.from("activities")
      .select("id, activity_type, title, status, outcome, channel, created_at")
      .eq("brokerage_id", brokerageId)
      .eq("contact_id", contactId)
    if (error) warnings.push(`activities read refused: ${error.message}`)
    else {
      for (const r of (data ?? []) as Array<Record<string, any>>) {
        events.push({
          id: `activity:${r.id}`,
          type: "post_conversion_activity",
          occurredAt: r.created_at ?? null,
          summary: `${r.activity_type ?? "Activity"}${r.title ? `: ${r.title}` : ""}${r.status ? ` (${r.status})` : ""}`,
          sensitivity: "summary_safe",
        })
      }
    }
  }

  events.sort((a, b) => {
    if (!a.occurredAt && !b.occurredAt) return 0
    if (!a.occurredAt) return -1
    if (!b.occurredAt) return 1
    return a.occurredAt.localeCompare(b.occurredAt)
  })

  return {
    leadId: leadId ?? allLeadIds[0] ?? null,
    contactId,
    brokerageId,
    events,
    convertedAt,
    acquisitionCost,
    behavioralIntentScore,
    warnings,
  }
}

/**
 * Contact-facing / agent view: post-conversion events in full, pre-conversion
 * events SUMMARIZED (summary_safe only, raw scrape/behavioral provenance
 * dropped) — owner ruling + CLAUDE.md §5 ("agents see contacts only... history
 * stops on the lead and continues on the contact"). The lead-desk page renders
 * `result.events` directly; this is for the contact detail surface.
 */
export function redactForContactView(result: PersonTimelineResult): TimelineEvent[] {
  return result.events.filter((e) => {
    if (e.sensitivity === "summary_safe") return true
    // A lead_desk_only event still counts once it happened AT/AFTER conversion
    // — post-conversion is contact territory regardless of source table.
    if (result.convertedAt && e.occurredAt && e.occurredAt >= result.convertedAt) return true
    return false
  })
}
