#!/usr/bin/env tsx
/**
 * scripts/person-spend-attribution-simulator.ts   (npm run test:person-spend-attribution)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 87F (wave 87) — LEAD INTELLIGENCE = HISTORY + SOURCE COST, proven on the REAL code
 * (no DB, no network; only the service-client edge is faked with scripts/in-memory-supabase.ts).
 *
 * Blind spots this lane found and closed:
 *   A · meterVendorSpend could not name a person. vendor_usage_tracking.lead_id was never set by it,
 *       so acquisition-cost.ts (enrichment spend BY lead_id) saw only $0 osint_free rows; raw-stage
 *       PeopleData spend was attributable to nobody. → `attribution` {leadId|contactId|rawRecordId}.
 *   B · usage-logger's replay fingerprint named no contact / raw row / market, so two different
 *       people's identical charges inside five minutes collapsed into one ledger row. → the event's
 *       own metadata is part of the fingerprint; a TRUE replay still dedupes (positive control).
 *   C · every paid enrichment booking in the enrichment files now passes `attribution` (static rule
 *       over comment- and string-blanked source; a specimen without it is caught).
 *   D · ONE reader, lib/lead-intelligence/person-spend.ts — lead_id ∪ raw rows ∪ contact, tenant-
 *       pinned, fail-closed (no brokerage → "not measured", never $0).
 *   E · acquisition-cost carries raw-stage + lead-stage enrichment spend through conversion (and
 *       never counts post-conversion contact spend as acquisition). RE-ANCHORED by lane 88B (owner:
 *       "spend should be what the tenant spent for that lead, not … raw lead acquisition, enrichment
 *       which are platform paid"): that spend is the PLATFORM-paid figure (platformPaidCost); the
 *       tenant's acquisitionCost excludes it. Full tenant/platform split: test:tenant-paid-lead-spend.
 *   F · person timeline completeness: dedup decisions, enrichment, ISA qualification and consent
 *       join the scrape → … → conversion history; `spend` splits at conversion; the agent-facing view
 *       carries NO cost key (the conversion event used to ship acquisitionCost as summary_safe).
 *   G · the enrichment persona summary no longer borrows client_message (Sonnet) — its own haiku row.
 *
 * Rule, not waypoint: no migration number, row count or date is pinned; times derive from the clock.
 * Run: npx tsx scripts/person-spend-attribution-simulator.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { blankComments, blankStrings } from "./strip-comments"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

const G = globalThis as any
G.__87F = { svc: null as MemClient | null }
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__87F.svc",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

const BRK = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const LEAD = "a1000000-0000-4000-8000-000000000001"
const RAW = "b1000000-0000-4000-8000-000000000001"
const CONTACT = "c1000000-0000-4000-8000-000000000001"
const NOW = Date.now()
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString()

/** Balanced-paren body of every `name(` call in blanked source. */
function callBodies(src: string, name: string): string[] {
  const out: string[] = []
  const re = new RegExp(`\\b${name}\\(`, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let depth = 0
    let i = m.index + m[0].length - 1
    const start = i
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++
      else if (src[i] === ")") { depth--; if (depth === 0) break }
    }
    out.push(src.slice(start, i + 1))
  }
  return out
}

async function main() {
  // ── A · the gateway names the person ──────────────────────────────────────────
  console.log("\n[A · meterVendorSpend attribution → lead_id column / metadata keys]")
  const { meterVendorSpend } = await import("../lib/vendor-governance/meter-vendor")
  const seen: any[] = []
  const logger = async (e: any) => { seen.push(e); return { success: true, usageId: "u" } }
  await meterVendorSpend({ vendorName: "peopledata", usageType: "skip_trace", cost: 0.25, brokerageId: BRK, attribution: { leadId: LEAD } }, { logger })
  ok("leadId rides the event's leadId (→ vendor_usage_tracking.lead_id)", seen[0]?.leadId === LEAD)
  await meterVendorSpend({ vendorName: "peopledata", usageType: "skip_trace", cost: 0.25, brokerageId: BRK, metadata: { lane: "x" }, attribution: { contactId: CONTACT, rawRecordId: RAW } }, { logger })
  ok("contactId / rawRecordId ride request_metadata beside the caller's own keys",
    seen[1]?.metadata?.contactId === CONTACT && seen[1]?.metadata?.rawRecordId === RAW && seen[1]?.metadata?.lane === "x" && seen[1]?.leadId === undefined)
  await meterVendorSpend({ vendorName: "peopledata", usageType: "skip_trace", cost: 0.25, brokerageId: BRK }, { logger })
  ok("CONTROL: no attribution → no lead_id and no invented person keys", seen[2]?.leadId === undefined && !("contactId" in (seen[2]?.metadata ?? {})))
  ok("CONTROL: zero cost still books nothing", (await meterVendorSpend({ vendorName: "peopledata", usageType: "skip_trace", cost: 0, brokerageId: BRK, attribution: { leadId: LEAD } }, { logger })) === false && seen.length === 3)

  // ── B · replay fingerprint ─────────────────────────────────────────────────────
  console.log("\n[B · usage-logger — different people are different events; a true replay still dedupes]")
  const { logVendorUsage } = await import("../lib/vendor-governance/usage-logger")
  G.__87F.svc = memSupabase({ vendor_usage_tracking: [], automation_errors: [] })
  const ev = (contactId: string) => ({
    vendorName: "peopledata", usageType: "skip_trace", unitCount: 1, estimatedCost: 0.25,
    systemSource: "skip_trace", brokerageId: BRK, metadata: { contactId, lane: "contact_enrichment" }, timestamp: new Date(),
  })
  await logVendorUsage(ev(CONTACT))
  const rows = G.__87F.svc.tables.vendor_usage_tracking as Row[]
  for (const r of rows) r.created_at = new Date().toISOString()
  await logVendorUsage(ev("c1000000-0000-4000-8000-000000000002"))
  ok("two DIFFERENT contacts' identical $0.25 matches inside the window → TWO ledger rows", rows.length === 2, `rows=${rows.length}`)
  for (const r of rows) r.created_at = r.created_at ?? new Date().toISOString()
  const replay = await logVendorUsage(ev(CONTACT))
  ok("POSITIVE CONTROL: an exact replay of the first event is still skipped (idempotency intact)",
    rows.length === 2 && /Duplicate/.test(String(replay.error ?? "")), `rows=${rows.length} err=${replay.error}`)
  const reordered = await logVendorUsage({ ...ev(CONTACT), metadata: { lane: "contact_enrichment", contactId: CONTACT } })
  ok("key order in metadata never makes a replay look new", rows.length === 2 && /Duplicate/.test(String(reordered.error ?? "")))
  const loggerSrc = blankStrings(blankComments(read("lib/vendor-governance/usage-logger.ts")))
  const fpBody = (src: string) => { const i = src.indexOf("function generateEventFingerprint"); return i < 0 ? "" : src.slice(i, src.indexOf("\n}", i)) }
  ok("rule: the fingerprint reads the event's metadata", /event\.metadata/.test(fpBody(loggerSrc)))
  const specimen = "function generateEventFingerprint(event) {\n  const parts = [event.vendorName, event.leadId]\n  return parts.join('|')\n}"
  ok("POSITIVE CONTROL: a fingerprint that ignores metadata (the base-tree shape) is caught", !/event\.metadata/.test(fpBody(specimen)))

  // ── C · every paid enrichment booking names its person ────────────────────────
  console.log("\n[C · static rule — every enrichment meter call passes attribution]")
  const ENRICHMENT_FILES: Array<{ file: string; fn: string }> = [
    { file: "lib/lead-pipeline/enrichment-orchestrator.ts", fn: "meterVendorSpend" },
    { file: "lib/lead-pipeline/perplexity-enrichment.ts", fn: "meterVendorSpend" },
    { file: "lib/enrichment/contact-enrichment-core.ts", fn: "meterVendorSpend" },
    { file: "lib/enrichment/household-financials.ts", fn: "meter" },
    { file: "lib/enrichment/reverse-skip-trace.ts", fn: "meter" },
  ]
  let calls = 0
  const offenders: string[] = []
  for (const { file, fn } of ENRICHMENT_FILES) {
    const src = blankComments(read(file))
    for (const body of callBodies(src, fn)) {
      if (!/\bvendorName\b/.test(body)) continue // a reference, not a booking
      calls++
      if (!/\battribution\b/.test(body)) offenders.push(`${file}: ${body.slice(0, 80).replace(/\s+/g, " ")}`)
    }
  }
  // pipeline-processor: only the raw-stage PeopleData booking inside enrichWithPeopleData is enrichment.
  {
    const src = blankComments(read("lib/lead-pipeline/pipeline-processor.ts"))
    const start = src.indexOf("async function enrichWithPeopleData")
    const scope = start < 0 ? "" : src.slice(start, src.indexOf("\nasync function ", start + 10) > 0 ? src.indexOf("\nasync function ", start + 10) : undefined)
    for (const body of callBodies(scope, "meterVendorSpend")) { calls++; if (!/\battribution\b/.test(body)) offenders.push(`pipeline-processor.ts raw stage: ${body.slice(0, 60)}`) }
    ok("the raw-stage research call forwards the raw row to enrichViaPerplexity", /enrichViaPerplexity\(\{[\s\S]{0,300}rawRecordId/.test(scope))
  }
  ok(`every paid enrichment booking names its person (${calls} bookings across ${ENRICHMENT_FILES.length + 1} files)`, calls >= 8 && offenders.length === 0, offenders.join("\n      "))
  const bad = callBodies("meterVendorSpend({ vendorName: 'batchdata', usageType: 'skip_trace', cost, brokerageId })", "meterVendorSpend")
  ok("POSITIVE CONTROL: a booking without attribution is flagged", bad.length === 1 && !/\battribution\b/.test(bad[0]))
  const tomb = blankComments("// meterVendorSpend({ vendorName: 'x' })\nconst a = 1")
  ok("POSITIVE CONTROL: a tombstone comment is not a booking", callBodies(tomb, "meterVendorSpend").length === 0)

  // ── D · the one reader ─────────────────────────────────────────────────────────
  console.log("\n[D · readPersonVendorSpend — lead_id ∪ raw ∪ contact, tenant-pinned, fail-closed]")
  const spendMod = await import("../lib/lead-intelligence/person-spend")
  const ledger = (): Row[] => [
    { id: "v-raw", vendor_name: "peopledata", usage_type: "skip_trace", total_cost: 0.25, created_at: iso(72), brokerage_id: BRK, lead_id: null, request_metadata: { rawRecordId: RAW, system_source: "lead_scraping" } },
    { id: "v-lead", vendor_name: "batchdata", usage_type: "skip_trace", total_cost: 0.07, created_at: iso(48), brokerage_id: BRK, lead_id: LEAD, request_metadata: { system_source: "skip_trace" } },
    { id: "v-contact", vendor_name: "versium", usage_type: "household_financials", total_cost: 0.1, created_at: iso(1), brokerage_id: BRK, lead_id: null, request_metadata: { contactId: CONTACT, system_source: "skip_trace" } },
    { id: "v-foreign", vendor_name: "peopledata", usage_type: "skip_trace", total_cost: 9, created_at: iso(2), brokerage_id: OTHER, lead_id: null, request_metadata: { rawRecordId: RAW, contactId: CONTACT } },
    { id: "v-unrelated", vendor_name: "zenrows", usage_type: "zillow", total_cost: 3, created_at: iso(2), brokerage_id: BRK, lead_id: null, request_metadata: { market_id: "m1" } },
  ]
  const svcD = memSupabase({ vendor_usage_tracking: ledger() })
  const got = await spendMod.readPersonVendorSpend(svcD, { brokerageId: BRK, leadIds: [LEAD], rawRecordIds: [RAW], contactId: CONTACT })
  const ids = got.rows.map((r) => r.id).sort()
  ok("reads the raw-stage, lead-stage and contact-stage rows for this person", JSON.stringify(ids) === JSON.stringify(["v-contact", "v-lead", "v-raw"]), ids.join(","))
  ok("CONTROL: another tenant's row carrying the same ids is NOT read", !ids.includes("v-foreign"))
  ok("CONTROL: a market-level scrape booking is not a person's spend", !ids.includes("v-unrelated"))
  const noTenant = await spendMod.readPersonVendorSpend(svcD, { brokerageId: null, leadIds: [], rawRecordIds: [RAW], contactId: CONTACT })
  ok("no brokerage → raw/contact reads skipped and measured=false (never an un-pinned read, never a clean $0)", noTenant.rows.length === 0 && noTenant.measured === false)
  const refused = await spendMod.readPersonVendorSpend(memSupabase({}, { refuse: { vendor_usage_tracking: "permission denied" } }), { brokerageId: BRK, leadIds: [LEAD], rawRecordIds: [], contactId: null })
  ok("a refused ledger read → measured=false with the refusal named", refused.measured === false && /permission denied/.test(refused.warnings.join(";")))
  const convertedAt = iso(24)
  const sum = spendMod.summarizePersonSpend(got.rows, convertedAt)
  ok("summary splits at conversion: raw + lead before ($0.32), contact after ($0.10)", sum.beforeConversionUsd === 0.32 && sum.afterConversionUsd === 0.1 && sum.totalUsd === 0.42, JSON.stringify(sum))
  ok("not yet converted → everything is acquisition-phase", spendMod.summarizePersonSpend(got.rows, null).afterConversionUsd === 0)

  // ── E · acquisition cost through conversion ─────────────────────────────────────
  console.log("\n[E · resolveLeadAcquisitionCost carries raw + lead enrichment spend into the PLATFORM-paid cost (lane 88B)]")
  const { resolveLeadAcquisitionCost } = await import("../lib/contact-promotion/acquisition-cost")
  const svcE = memSupabase({
    leads: [{ id: LEAD, brokerage_id: BRK, raw_record_id: null, source_raw_ids: [RAW] }],
    raw_scraped_leads: [{ id: RAW, lead_id: LEAD, brokerage_id: BRK }],
    vendor_usage_tracking: ledger(),
    ad_campaigns: [],
  })
  const acq = await resolveLeadAcquisitionCost(svcE, { leadId: LEAD, brokerageId: BRK, costPerRecord: 0.5, campaignAttributionId: null })
  ok("enrichment spend = raw-stage PeopleData + lead-stage skip trace ($0.32)", acq.enrichmentSpend === 0.32, `got ${acq.enrichmentSpend}`)
  ok("platform-paid cost = record $0.50 + enrichment $0.32 = $0.82 (post-conversion contact spend excluded)", acq.platformPaidCost === 0.82, `got ${acq.platformPaidCost}`)
  ok("…and none of it is the TENANT's acquisition cost (no campaign → null, never $0.82)", acq.acquisitionCost === null, `got ${acq.acquisitionCost}`)
  const svcBase = memSupabase({ leads: [{ id: LEAD, brokerage_id: BRK }], raw_scraped_leads: [], vendor_usage_tracking: [
    { id: "v-unattributed", vendor_name: "peopledata", total_cost: 0.25, brokerage_id: BRK, lead_id: null, request_metadata: { entityType: "lead", entityId: LEAD } },
  ], ad_campaigns: [] })
  const base = await resolveLeadAcquisitionCost(svcBase, { leadId: LEAD, brokerageId: BRK, costPerRecord: 0.5, campaignAttributionId: null })
  ok("POSITIVE CONTROL: a booking that names no person (the base-tree meterVendorSpend shape) is invisible to acquisition cost — which is why the writers now attribute",
    base.enrichmentSpend === null && base.platformPaidCost === 0.5 && base.acquisitionCost === null)

  // ── F · person timeline completeness + contact-view redaction ────────────────────
  console.log("\n[F · buildPersonTimeline — dedup / enrichment / qualification / consent / spend; no cost in the agent view]")
  const tl = await import("../lib/lead-intelligence/person-timeline")
  const svcF = memSupabase({
    leads: [{ id: LEAD, brokerage_id: BRK, contact_id: CONTACT, converted_at: convertedAt, source: "zillow", source_channel: "zillow_fsbo", acquisition_cost: 0.82, cost_per_record: 0.5, raw_record_id: RAW }],
    contact_lead_history: [{ contact_id: CONTACT, lead_id: LEAD, contact_brokerage_id: BRK, converted_at: convertedAt }],
    raw_scraped_leads: [{ id: RAW, lead_id: LEAD, brokerage_id: BRK, source: "zillow", source_channel: "zillow_fsbo", created_at: iso(80), cost_per_record: 0.5, raw_data: {} }],
    lead_deduplication_log: [
      { id: "d1", brokerage_id: BRK, raw_record_id: RAW, lead_id: null, stage: "pre_enrichment", action_taken: "passed", match_score: 0, created_at: iso(79) },
      { id: "d2", brokerage_id: BRK, raw_record_id: RAW, lead_id: LEAD, stage: "post_enrichment", action_taken: "passed", match_score: 12, created_at: iso(70) },
      { id: "d-foreign", brokerage_id: OTHER, raw_record_id: RAW, lead_id: LEAD, stage: "post_enrichment", action_taken: "merged", created_at: iso(70) },
    ],
    ai_isa_qualifications: [{ id: "q1", brokerage_id: BRK, lead_id: LEAD, contact_id: null, stage: "qualified", qualification_result: "seller 1-3 months", qualification_score: 82, qualified_at: iso(30) }],
    contact_consent_events: [{ id: "k1", brokerage_id: BRK, lead_id: LEAD, contact_id: null, consent_type: "sms", consent_source: "web_form", consented: true, created_at: iso(60) }],
    vendor_usage_tracking: ledger(),
    form_submissions: [], intelligent_outreach_log: [], ai_isa_calls: [], voice_calls: [], ai_isa_activities: [],
    lead_conversation_history: [], assignment_log: [], activities: [],
  })
  const built = await tl.buildPersonTimeline({ leadId: LEAD, brokerageId: BRK, client: svcF })
  const types = new Set(built.events.map((e) => e.type))
  for (const t of ["scrape_source", "dedup_decision", "enrichment", "qualification", "consent", "conversion"]) ok(`timeline carries a ${t} event`, types.has(t as any), [...types].join(","))
  ok("dedup decisions are read by the raw row AND the lead, deduped, tenant-pinned (2, not 3)",
    built.events.filter((e) => e.type === "dedup_decision").length === 2)
  ok("the pipeline reads in order: scrape → dedup → enrichment(raw) → … → qualification → conversion",
    (() => { const o = built.events.map((e) => e.id); return o.indexOf(`raw:${RAW}`) < o.indexOf("dedup:d1") && o.indexOf("dedup:d1") < o.indexOf("enrichment:v-raw") && o.indexOf("qualification:q1") < o.indexOf(`conversion:${CONTACT}`) })())
  ok("platform-paid spend on the result: $0.32 before conversion, $0.10 after, measured", built.platformPaidSpend?.beforeConversionUsd === 0.32 && built.platformPaidSpend?.afterConversionUsd === 0.1 && built.platformPaidSpend?.measured === true, JSON.stringify(built.platformPaidSpend))
  const conv = built.events.find((e) => e.type === "conversion")
  ok("the summary_safe conversion event no longer carries acquisitionCost", !conv?.detail || !("acquisitionCost" in conv.detail))
  const agentView = tl.redactForContactView(built)
  const costKeys = agentView.flatMap((e) => Object.keys(e.detail ?? {})).filter((k) => /cost|spend|usd|price|budget/i.test(k))
  ok("agent-facing view: no cost key on ANY event (post-conversion enrichment included)", costKeys.length === 0, costKeys.join(","))
  ok("agent-facing view keeps post-conversion enrichment as history (vendor, not price)", agentView.some((e) => e.id === "enrichment:v-contact"))
  ok("agent-facing view drops raw pre-conversion provenance (scrape, dedup, raw-stage enrichment)",
    !agentView.some((e) => e.type === "scrape_source" || e.type === "dedup_decision" || e.id === "enrichment:v-raw"))
  const specimenView = tl.redactForContactView({ ...built, events: [{ id: "s", type: "conversion", occurredAt: iso(0), summary: "x", sensitivity: "summary_safe", detail: { acquisitionCost: 5, costUsd: 1, keep: true } }] })
  ok("POSITIVE CONTROL: a summary_safe event carrying cost keys is stripped of them, other keys kept",
    specimenView.length === 1 && specimenView[0].detail?.keep === true && !("acquisitionCost" in (specimenView[0].detail ?? {})))
  const routeSrc = blankComments(read("app/api/contacts/[contactId]/lead-history/route.ts"))
  ok("the contact-facing route forwards the REDACTED events only — never spend / acquisitionCost",
    /redactForContactView\(built\)/.test(routeSrc) && !/built\.spend|built\.platformPaid|built\.acquisitionCost/.test(routeSrc))

  // ── G · routing ──────────────────────────────────────────────────────────────────
  console.log("\n[G · enrichment persona summary on its own cheap row]")
  const { AI_TASK_ROUTING } = await import("../lib/ai/models")
  const row = (AI_TASK_ROUTING as any).enrichment_persona_summary
  ok("enrichment_persona_summary is a routed row on a Haiku-class model", !!row && /haiku|mini/.test(String(row.model)), JSON.stringify(row))
  const orch = blankStrings(blankComments(read("lib/lead-pipeline/enrichment-orchestrator.ts")))
  const orchRaw = blankComments(read("lib/lead-pipeline/enrichment-orchestrator.ts"))
  ok("the orchestrator's persona summary uses it, and no longer borrows client_message",
    /feature:\s*'enrichment_persona_summary'/.test(orchRaw) && !/feature:\s*'client_message'/.test(orchRaw) && orch.length > 0)

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
  console.log(" PERSON_SPEND_ATTRIBUTION_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
