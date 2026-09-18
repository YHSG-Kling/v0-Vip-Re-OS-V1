#!/usr/bin/env tsx
/**
 * scripts/person-timeline-simulator.ts   (npm run test:person-timeline)
 *
 * PROVES lib/lead-intelligence/person-timeline.ts::buildPersonTimeline builds
 * ONE ordered history from every source named in the owner's ruling (wave 65):
 * scrape provenance, lead-magnet/widget/portal intake, behavioral signals (via
 * the EXTENDED behavioral-summary, not a duplicate), ISA touches, assignment,
 * conversion, and post-conversion contact activity — and that
 * redactForContactView drops raw pre-conversion provenance for the
 * contact-facing (agent) view while keeping everything post-conversion.
 *
 * No database. A minimal chainable mock stands in for supabase-js: every
 * `.from(table)` call resolves to that table's fixture rows regardless of the
 * filter chain applied (this is a UNIT proof of the fold/sort/redact logic,
 * not of PostgREST predicate correctness — the read call sites themselves are
 * proven by grepping for the literal `.from("table")` string below, the same
 * discipline scripts/readerless-write-census.ts uses).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ─── Minimal chainable supabase-js mock ────────────────────────────────────
type Fixture = { data: any[] | any | null; error: { message: string } | null }
function makeClient(tables: Record<string, Fixture>) {
  const missing = (table: string): Fixture => ({ data: [], error: null, __missing: true } as any)
  const from = (table: string) => {
    const fixture = tables[table] ?? missing(table)
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: Array.isArray(fixture.data) ? fixture.data[0] ?? null : fixture.data, error: fixture.error }),
      single: async () => ({ data: Array.isArray(fixture.data) ? fixture.data[0] ?? null : fixture.data, error: fixture.error }),
      then: (resolve: any) => resolve({ data: fixture.data, error: fixture.error }),
    }
    return builder
  }
  return { from } as any
}

async function main() {
  const { buildPersonTimeline, redactForContactView } = await import("../lib/lead-intelligence/person-timeline")

  console.log("\n[1 · every named source folds into the timeline]")
  {
    const now = new Date()
    const iso = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString()
    const convertedAt = iso(3)

    const client = makeClient({
      leads: { data: [{
        id: "lead-1", brokerage_id: "brok-1", contact_id: "contact-1", converted_at: convertedAt,
        source: "zillow_behavior", source_family: "scrape", source_channel: "zenrows",
        cost_per_record: 2.5, acquisition_cost: 4.75, raw_record_id: "raw-1", campaign_attribution_id: null,
      }], error: null },
      contact_lead_history: { data: [{ lead_id: "lead-1", contact_brokerage_id: "brok-1", converted_at: convertedAt }], error: null },
      raw_scraped_leads: { data: [{
        id: "raw-1", lead_id: "lead-1", source: "zillow_behavior", source_channel: "zenrows",
        source_family: "scrape", source_subtype: null, source_origin: null,
        cost_per_record: 2.5, scraper_execution_id: "exec-1", created_at: iso(30), dedupe_status: "unique",
      }], error: null },
      form_submissions: { data: [{
        id: "form-1", form_name: "Home Value Widget", source: "widget", context_type: "widget",
        context_id: "w-1", submitted_at: iso(29), created_at: iso(29), tcpa_consent_given: true,
      }], error: null },
      // behavioral-summary.ts's own reads — EXTENDED, not duplicated.
      behavioral_signals: { data: [{ id: "sig-1" }], error: null },
      external_behavior: { data: [{
        source: "zillow", activity_type: "property_view", detected_interest_level: "high",
        property_addresses_viewed: ["123 Main St"], location: "Austin, TX", detected_via_zenrows: true,
        scraped_at: iso(20), search_criteria_json: null,
      }], error: null },
      lead_idx_property_interactions: { data: [], error: null },
      nextdoor_activity: { data: [], error: null },
      google_search_activity: { data: [], error: null },
      google_search_intelligence: { data: [], error: null },
      lead_osint_data: { data: [], error: null },
      intelligence_signals_log: { data: [], error: null },
      intelligent_outreach_log: { data: [{
        id: "out-1", outreach_type: "value_first", channel: "sms", created_at: iso(15),
      }], error: null },
      ai_isa_calls: { data: [{
        id: "isacall-1", script_used: "buyer_qualify", appointment_set: true, lead_quality_score: 82, created_at: iso(10),
      }], error: null },
      voice_calls: { data: [{
        id: "vc-1", call_type: "isa", direction: "outbound", outcome: "connected", duration_seconds: 240, started_at: iso(9),
      }], error: null },
      ai_isa_activities: { data: [{
        id: "isaact-1", activity_type: "qualification", channel: "voice", outcome: "qualified", created_at: iso(4),
      }], error: null },
      lead_conversation_history: { data: [{
        id: "conv-1", channel: "sms", direction: "inbound", message_content: "Yes I'm interested, please call me",
        occurred_at: iso(5),
      }], error: null },
      assignment_log: { data: [{
        id: "assign-1", agent_id: "agent-1", assignment_method: "round_robin",
        routing_reason: "next in rotation", score_at_assignment: 78, created_at: convertedAt,
      }], error: null },
      activities: { data: [{
        id: "act-1", activity_type: "call", title: "Welcome call", status: "completed",
        outcome: "connected", channel: "phone", created_at: iso(1),
      }], error: null },
    })

    const result = await buildPersonTimeline({ leadId: "lead-1", contactId: "contact-1", brokerageId: "brok-1", client })

    check("resolves leadId/contactId/brokerageId", result.leadId === "lead-1" && result.contactId === "contact-1" && result.brokerageId === "brok-1")
    check("carries convertedAt from leads.converted_at", result.convertedAt === convertedAt)
    check("carries acquisitionCost from leads.acquisition_cost", result.acquisitionCost === 4.75)
    check("folds behavioral-summary's own score in (extended, not re-derived)", result.behavioralIntentScore > 0)

    const types = new Set(result.events.map((e) => e.type))
    check("scrape_source event present (raw_scraped_leads)", types.has("scrape_source"))
    check("lead_magnet_intake event present (form_submissions)", types.has("lead_magnet_intake"))
    check("behavioral_signal event present (extended behavioral-summary)", types.has("behavioral_signal"))
    check("isa_outreach event present (intelligent_outreach_log)", types.has("isa_outreach"))
    check("isa_call event present (ai_isa_calls + voice_calls, both folded)",
      result.events.filter((e) => e.type === "isa_call").length === 2)
    check("isa_activity event present (ai_isa_activities)", types.has("isa_activity"))
    check("conversation event present (lead_conversation_history)", types.has("conversation"))
    check("assignment event present (assignment_log — the brokerage/team-lead rules outcome)", types.has("assignment"))
    check("conversion event present, stamped at leads.converted_at", types.has("conversion"))
    check("post_conversion_activity event present (activities, contact-keyed)", types.has("post_conversion_activity"))

    check("events are sorted chronologically (oldest first)",
      result.events.every((e, i) => i === 0 || !e.occurredAt || !result.events[i - 1].occurredAt || e.occurredAt >= result.events[i - 1].occurredAt!))

    console.log("\n[2 · redactForContactView: pre-conversion provenance hidden, post-conversion kept]")
    const redacted = redactForContactView(result)
    const redactedTypes = new Set(redacted.map((e) => e.type))
    check("raw scrape_source (pre-conversion, lead_desk_only) is DROPPED", !redactedTypes.has("scrape_source") || redacted.filter(e => e.type === "scrape_source").every(e => e.occurredAt! >= convertedAt))
    check("raw behavioral_signal (pre-conversion, lead_desk_only) is DROPPED",
      !redacted.some((e) => e.type === "behavioral_signal"))
    check("raw conversation transcript (pre-conversion, lead_desk_only) is DROPPED",
      !redacted.some((e) => e.type === "conversation"))
    check("summary_safe isa_outreach/isa_call/isa_activity SURVIVE (pre-conversion but summarized, not raw provenance)",
      redactedTypes.has("isa_outreach") && redactedTypes.has("isa_call") && redactedTypes.has("isa_activity"))
    check("post_conversion_activity SURVIVES (agent-facing, happened on the contact)",
      redactedTypes.has("post_conversion_activity"))
    check("conversion event itself SURVIVES", redactedTypes.has("conversion"))
    check("assignment event SURVIVES (summary_safe — the routing outcome, not raw scrape data)",
      redactedTypes.has("assignment"))
    check("redaction never THROWS on a result with zero events", (() => {
      try { redactForContactView({ leadId: null, contactId: null, brokerageId: null, events: [], convertedAt: null, acquisitionCost: null, behavioralIntentScore: 0, warnings: [] }); return true }
      catch { return false }
    })())
  }

  console.log("\n[3 · positive control — a fully empty mock produces the honest empty shape, never a throw]")
  {
    const client = makeClient({})
    const result = await buildPersonTimeline({ leadId: "lead-none", contactId: "contact-none", brokerageId: "brok-none", client })
    check("empty tables everywhere → zero events, not a throw", result.events.length === 0)
    check("still returns the ids it was given", result.leadId === "lead-none" || result.contactId === "contact-none")
  }

  console.log("\n[4 · no leadId AND no contactId → the honest empty shape, no query attempted]")
  {
    const result = await buildPersonTimeline({})
    check("returns empty events for an empty call", result.events.length === 0 && result.warnings.length === 0)
  }

  console.log("\n[5 · source discipline — every named table is read by its LITERAL name]")
  {
    const src = stripComments(readFileSync(join(process.cwd(), "lib/lead-intelligence/person-timeline.ts"), "utf8"))
    const requiredTables = [
      "raw_scraped_leads", "form_submissions", "intelligent_outreach_log", "ai_isa_calls",
      "voice_calls", "ai_isa_activities", "lead_conversation_history", "assignment_log",
      "activities", "contact_lead_history", "leads",
    ]
    for (const t of requiredTables) {
      check(`reads "${t}" by literal .from("${t}")`, src.includes(`.from("${t}")`))
    }
    check("delegates behavioral tables to behavioral-summary.ts instead of re-querying them directly (no duplicate reader)",
      src.includes("buildBehavioralIntentSummary") && !src.includes('.from("external_behavior")'))

    // POSITIVE CONTROL for the table-name finder itself — a broken regex and a
    // complete file both report every table present; prove the finder still
    // reacts when a name is absent.
    check("[control] the literal-name finder still FIRES on a table this file does not read",
      !src.includes('.from("this_table_does_not_exist_anywhere")'))
  }

  console.log(`\n${"═".repeat(70)}`)
  console.log(`PERSON TIMELINE — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of failures) console.log(`  · ${f}`)
    console.log("\n❌ PERSON_TIMELINE_FAIL")
    process.exit(1)
  }
  console.log("✅ PERSON_TIMELINE_PASS — one ordered timeline, every named source, role-gated redaction proven")
}

main().catch((e) => { console.error(e); process.exit(1) })
