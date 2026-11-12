#!/usr/bin/env tsx
/**
 * scripts/tenant-paid-lead-spend-guard.ts   (npm run test:tenant-paid-lead-spend)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 88B (wave 88). Owner, verbatim: "spend should be what the tenant spent for that lead, not
 * what was included in their subscription like raw lead acquisition, enrichment which are platform
 * paid."
 *
 * Proven on the REAL code (no DB, no network — only the service-client edge is faked with
 * scripts/in-memory-supabase.ts):
 *   A · ONE payer vocabulary (source-conversion-learning.ts LEAD_COST_PAYER): computeLeadAcquisitionCost
 *       = TENANT-paid parts only (the tenant's campaign cost share); computePlatformPaidLeadCost = raw
 *       cost_per_record + enrichment; tenantPaidLeadSpend never falls back to cost_per_record.
 *   B · resolveLeadAcquisitionCost (the conversion-time writer of leads/contacts.acquisition_cost)
 *       returns the tenant figure as acquisitionCost and the platform figure apart.
 *   C · the lead page's timeline: a TENANT scope reads redactForTenantLeadDesk (no platform-paid
 *       spend, no platform cost keys on any event, tenant acquisitionCost kept); only a PLATFORM
 *       scope reads the raw result.
 *   D · tenant ROI / source readers (source-conversion-runner, source-analytics, kernel reporting)
 *       sum tenantPaidLeadSpend — no `acquisition_cost ?? cost_per_record`, no cost_per_record
 *       into a tenant total; the platform ledger reconcile (leadCostBySource) reads cost_per_record
 *       only, and source-analytics returns it to a platform-staff session only.
 *   E · loadSourceConversions end-to-end: a scraped source the tenant paid nothing for is $0 tenant
 *       spend (ROI null → never "costing more than it returns"); a campaign source keeps its spend.
 *
 * Every absence rule carries a POSITIVE CONTROL (the retired shape is still recognised). Rule, not
 * waypoint: no migration number, row count or date is pinned.
 * Blind spots: static rules read comment-stripped source of the NAMED readers (a new tenant report
 * under another file name is not scanned — the census list is printed below); the in-memory client
 * has no `count`, so the campaign even-split denominator falls to 1 (one lead on the campaign here).
 * Run: npx tsx scripts/tenant-paid-lead-spend-guard.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"

const ROOT = process.cwd()
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

const G = globalThis as any
G.__88B = { svc: null as MemClient | null }
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__88B.svc",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

const BRK = "11111111-1111-4111-8111-111111111111"
const LEAD = "a1000000-0000-4000-8000-000000000001"
const RAW = "b1000000-0000-4000-8000-000000000001"
const CONTACT = "c1000000-0000-4000-8000-000000000001"
const CAMPAIGN = "d1000000-0000-4000-8000-000000000001"
const NOW = Date.now()
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString()

async function main() {
  // ── A · the payer vocabulary ─────────────────────────────────────────────────────
  console.log("\n[A · one payer per part — tenant vs platform]")
  const L = await import("../lib/lead-pipeline/source-conversion-learning")
  const scraped = { costPerRecord: 0.5, enrichmentSpend: 0.32, campaignCostShare: null }
  ok("a scraped + enriched lead costs the TENANT nothing (null — no tenant-paid part)", L.computeLeadAcquisitionCost(scraped) === null)
  ok("…and the PLATFORM $0.82 (raw record $0.50 + enrichment $0.32)", L.computePlatformPaidLeadCost(scraped) === 0.82)
  const campaign = { costPerRecord: 0.5, enrichmentSpend: 0.32, campaignCostShare: 25 }
  ok("a campaign lead's tenant cost is its OWN ad-spend share ($25), never + the platform's $0.82", L.computeLeadAcquisitionCost(campaign) === 25)
  ok("the platform figure is unchanged by the tenant's ad spend ($0.82)", L.computePlatformPaidLeadCost(campaign) === 0.82)
  // POSITIVE CONTROL — the retired all-parts sum is exactly what the tenant used to be shown.
  const retiredSum = [campaign.costPerRecord, campaign.enrichmentSpend, campaign.campaignCostShare].reduce((a, b) => a + (b ?? 0), 0)
  ok("POSITIVE CONTROL: the retired single sum would have billed the tenant $25.82 — the split is what moved it", Math.round(retiredSum * 100) / 100 === 25.82 && L.computeLeadAcquisitionCost(campaign) !== 25.82)
  ok("tenantPaidLeadSpend: a row with only the platform's cost_per_record is $0 tenant spend (no fallback)",
    L.tenantPaidLeadSpend({ acquisition_cost: null, cost_per_record: 0.5 } as any) === 0)
  ok("tenantPaidLeadSpend: the tenant's acquisition_cost is its spend", L.tenantPaidLeadSpend({ acquisition_cost: 25 }) === 25)

  // ── B · the conversion-time writer ───────────────────────────────────────────────
  console.log("\n[B · resolveLeadAcquisitionCost splits tenant-paid from platform-paid]")
  const { resolveLeadAcquisitionCost } = await import("../lib/contact-promotion/acquisition-cost")
  const ledger = () => [
    { id: "v-raw", vendor_name: "peopledata", usage_type: "person_match", total_cost: 0.25, brokerage_id: BRK, lead_id: null, created_at: iso(75), request_metadata: { rawRecordId: RAW, system_source: "lead_enrichment" } },
    { id: "v-lead", vendor_name: "batchdata", usage_type: "skip_trace", total_cost: 0.07, brokerage_id: BRK, lead_id: LEAD, created_at: iso(50), request_metadata: { system_source: "enrichment" } },
  ]
  const svcB = memSupabase({
    leads: [{ id: LEAD, brokerage_id: BRK, raw_record_id: RAW, source_raw_ids: [], campaign_attribution_id: CAMPAIGN }],
    raw_scraped_leads: [{ id: RAW, lead_id: LEAD, brokerage_id: BRK }],
    vendor_usage_tracking: ledger(),
    ad_campaigns: [{ id: CAMPAIGN, brokerage_id: BRK, lifetime_budget: 40, daily_budget: null }],
  })
  const acq = await resolveLeadAcquisitionCost(svcB, { leadId: LEAD, brokerageId: BRK, costPerRecord: 0.5, campaignAttributionId: CAMPAIGN })
  ok("acquisitionCost (→ leads/contacts.acquisition_cost) = the tenant's campaign share only ($40)", acq.acquisitionCost === 40, `got ${acq.acquisitionCost}`)
  ok("platformPaidCost = raw $0.50 + enrichment $0.32 = $0.82 — returned apart, never on the tenant figure", acq.platformPaidCost === 0.82, `got ${acq.platformPaidCost}`)
  const noCampaign = await resolveLeadAcquisitionCost(svcB, { leadId: LEAD, brokerageId: BRK, costPerRecord: 0.5, campaignAttributionId: null })
  ok("a platform-sourced lead converts with acquisitionCost NULL (not $0.82)", noCampaign.acquisitionCost === null && noCampaign.platformPaidCost === 0.82)
  const creator = code("lib/contact-promotion/contact-creator.ts")
  const retiredCarry = /acquisition_cost:\s*acquisition\.acquisitionCost\s*\?\?\s*data\.lead\.cost_per_record/
  ok("contact-creator carries the tenant figure with no cost_per_record fallback", /acquisition_cost:\s*acquisition\.acquisitionCost\s*\?\?\s*null/.test(creator) && !retiredCarry.test(creator))
  ok("POSITIVE CONTROL: the carry finder recognises the retired fallback", retiredCarry.test("acquisition_cost: acquisition.acquisitionCost ?? data.lead.cost_per_record ?? null"))

  // ── C · the lead page ────────────────────────────────────────────────────────────
  console.log("\n[C · lead page: tenant scope sees ITS spend; platform scope sees the platform's]")
  const tl = await import("../lib/lead-intelligence/person-timeline")
  const convertedAt = iso(20)
  const svcC = memSupabase({
    leads: [{ id: LEAD, brokerage_id: BRK, contact_id: CONTACT, converted_at: convertedAt, source: "zillow", source_channel: "zillow_fsbo", acquisition_cost: 40, cost_per_record: 0.5, raw_record_id: RAW, campaign_attribution_id: CAMPAIGN }],
    contact_lead_history: [{ contact_id: CONTACT, lead_id: LEAD, contact_brokerage_id: BRK, converted_at: convertedAt }],
    raw_scraped_leads: [{ id: RAW, lead_id: LEAD, brokerage_id: BRK, source: "zillow", source_channel: "zillow_fsbo", created_at: iso(80), cost_per_record: 0.5, raw_data: {} }],
    vendor_usage_tracking: ledger(),
    lead_deduplication_log: [], ai_isa_qualifications: [], contact_consent_events: [],
    form_submissions: [], intelligent_outreach_log: [], ai_isa_calls: [], voice_calls: [], ai_isa_activities: [],
    lead_conversation_history: [], assignment_log: [], activities: [], ad_campaigns: [],
  })
  const built = await tl.buildPersonTimeline({ leadId: LEAD, brokerageId: BRK, client: svcC })
  ok("timeline acquisitionCost = leads.acquisition_cost ($40 tenant-paid)", built.acquisitionCost === 40, `got ${built.acquisitionCost}`)
  ok("platform view: platformPaidAcquisitionCost = raw $0.50 + pre-conversion enrichment $0.32", built.platformPaidAcquisitionCost === 0.82, `got ${built.platformPaidAcquisitionCost}`)
  ok("platform view: platformPaidSpend carries the vendor ledger ($0.32)", built.platformPaidSpend?.totalUsd === 0.32)
  const tenantView = tl.redactForTenantLeadDesk(built)
  const platformKeys = tenantView.events.flatMap((e) => Object.keys(e.detail ?? {})).filter((k) => k === "costPerRecord" || k === "costUsd")
  ok("tenant view: no platform-paid spend fields", tenantView.platformPaidSpend === null && tenantView.platformPaidAcquisitionCost === null)
  ok("tenant view: no platform-paid cost key on ANY event (scrape costPerRecord, enrichment costUsd)", platformKeys.length === 0, platformKeys.join(","))
  ok("tenant view: the tenant's OWN acquisitionCost and the full history are kept", tenantView.acquisitionCost === 40 && tenantView.events.length === built.events.length)
  const rawKeys = built.events.flatMap((e) => Object.keys(e.detail ?? {})).filter((k) => k === "costPerRecord" || k === "costUsd")
  ok("POSITIVE CONTROL: the un-redacted result DOES carry those keys (the redaction is what removes them)", rawKeys.length > 0)
  const legacyLead = memSupabase({
    leads: [{ id: LEAD, brokerage_id: BRK, contact_id: null, converted_at: null, source: "zillow", acquisition_cost: null, cost_per_record: 0.5, raw_record_id: null }],
    raw_scraped_leads: [], vendor_usage_tracking: [], lead_deduplication_log: [], ai_isa_qualifications: [], contact_consent_events: [],
    form_submissions: [], intelligent_outreach_log: [], ai_isa_calls: [], voice_calls: [], ai_isa_activities: [],
    lead_conversation_history: [], assignment_log: [], activities: [], contact_lead_history: [],
  })
  const legacy = await tl.buildPersonTimeline({ leadId: LEAD, brokerageId: BRK, client: legacyLead })
  ok("a lead with only cost_per_record shows NO tenant acquisition cost (the retired fallback showed $0.50)", legacy.acquisitionCost === null && legacy.platformPaidAcquisitionCost === 0.5)
  const page = code("app/leads/[leadId]/page.tsx")
  ok("lead page: platform scope is resolved from the session's visibility (vis.scope.kind === \"platform\")", /const platformView = vis\.scope\.kind === "platform"/.test(page))
  ok("lead page: every other scope renders redactForTenantLeadDesk", /platformView \? fullTimeline : redactForTenantLeadDesk\(fullTimeline\)/.test(page))
  ok("lead page: the platform-paid line renders only under platformView", /platformView && \(timeline\.platformPaidSpend/.test(page) && !/timeline\.spend\b/.test(page))

  // ── D · tenant ROI / source readers ──────────────────────────────────────────────
  console.log("\n[D · tenant reports sum TENANT-paid spend; the platform reconcile stays platform-only]")
  const TENANT_READERS = ["lib/lead-pipeline/source-conversion-runner.ts", "app/actions/source-analytics.ts", "lib/kernel/reporting.ts"]
  const retiredFallback = /acquisition_cost\s*\?\?\s*[\w.()]*cost_per_record/
  const platformIntoTenantTotal = /(total_spend|\.spend)\s*\+=\s*[^\n;]*cost_per_record/
  for (const f of TENANT_READERS) {
    const src = code(f)
    ok(`${f}: sums tenantPaidLeadSpend, no cost_per_record fallback, no cost_per_record into a tenant total`,
      /tenantPaidLeadSpend\(/.test(src) && !retiredFallback.test(src) && !platformIntoTenantTotal.test(src))
  }
  ok("POSITIVE CONTROL: the fallback finder recognises `(l as any).acquisition_cost ?? l.cost_per_record ?? 0`", retiredFallback.test("m.total_spend += (l as any).acquisition_cost ?? l.cost_per_record ?? 0"))
  ok("POSITIVE CONTROL: the total finder recognises `b.total_spend += c.cost_per_record ?? 0`", platformIntoTenantTotal.test("b.total_spend += c.cost_per_record ?? 0"))
  const { leadCostBySource } = await import("../lib/lead-pipeline/source-cost-ledger")
  const recon = leadCostBySource([{ source: "batchdata_motivated", acquisition_cost: 40, cost_per_record: 0.05 }], [{ vendor_name: "batchdata", total_cost: 0.05 }])
  ok("platform reconcile (leadCostBySource) reads the platform's cost_per_record ($0.05), never the tenant's $40 ad share",
    recon.bySource[0]?.recordedCostUsd === 0.05)
  const sa = code("app/actions/source-analytics.ts")
  const gate = sa.indexOf("if (platformViewer) {")
  ok("source-analytics: the platform ledger read + reconcile run ONLY inside `if (platformViewer)`",
    gate > 0 && sa.indexOf('.from("vendor_usage_tracking")') > gate && sa.indexOf("leadCostBySource(") > gate)
  ok("source-analytics: platformViewer comes from the SESSION's platform_role (isPlatformStaffIdentity), fail-closed on a refused read",
    /platformViewer = !viewerErr && isPlatformStaffIdentity\(/.test(sa) && /supabase\.auth\.getUser\(\)/.test(sa))

  // ── E · the source learner end to end ────────────────────────────────────────────
  console.log("\n[E · loadSourceConversions — scraped sources cost the tenant $0]")
  const { loadSourceConversions } = await import("../lib/lead-pipeline/source-conversion-runner")
  const leadRows = [
    ...Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, brokerage_id: BRK, source: "zillow_fsbo", contact_id: i < 3 ? `cs${i}` : null, cost_per_record: 0.5, acquisition_cost: null, created_at: iso(10) })),
    ...Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, brokerage_id: BRK, source: "facebook_ads", contact_id: i < 3 ? `cc${i}` : null, cost_per_record: null, acquisition_cost: i < 3 ? 25 : null, created_at: iso(10) })),
  ]
  const svcE = memSupabase({ leads: leadRows, transactions: [] })
  const scored = await loadSourceConversions(BRK, {}, svcE as any)
  const z = scored.sources["zillow_fsbo"]
  const fb = scored.sources["facebook_ads"]
  ok("a scraped source (platform-paid $0.50/record) carries $0 tenant cost per contact and a null ROI — never a tenant money pit",
    !!z && z.costPerContact === 0 && z.roiMultiple === null, JSON.stringify(z))
  ok("a campaign source keeps the tenant's own spend ($75 over 3 contacts = $25/contact)", !!fb && fb.costPerContact === 25, JSON.stringify(fb))

  console.log(`\n  census: tenant readers scanned = ${TENANT_READERS.length} (${TENANT_READERS.join(", ")}); platform reconcile = lib/lead-pipeline/source-cost-ledger.ts::leadCostBySource`)
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
  console.log(" TENANT_PAID_LEAD_SPEND_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
