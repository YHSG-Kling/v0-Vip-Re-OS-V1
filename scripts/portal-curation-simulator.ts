/**
 * scripts/portal-curation-simulator.ts
 *
 * Guards the portal curation invariant that drives the client experience:
 *
 *   1. Every PORTAL_UPDATE_TEMPLATES key is a real KernelEvent (no typos / dead keys).
 *   2. INTERNAL events (lead-acquisition, CRM, ISA, commission/billing, cron, provisioning,
 *      content/marketing tooling, AI mesh, integrations, scraping) are NEVER templated — they must
 *      stay off the client portal. This is the rule the portal is built on: the template map is the
 *      gate (writePortalUpdate no-ops when an event has no template).
 *   3. The curated client-facing milestones we intend to show stay covered (regression guard so a
 *      refactor can't silently drop a card buyers/sellers rely on).
 *
 * Pure source analysis (event-fanout.ts is server-only and can't be imported here), so it runs
 * anywhere via `npx tsx scripts/portal-curation-simulator.ts` with no DB or network.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderTemplateText } from "../lib/kernel/portal-template-render"

const ROOT = process.cwd()
const eventsSrc  = readFileSync(join(ROOT, "lib/kernel/events.ts"), "utf8")
const fanoutSrc  = readFileSync(join(ROOT, "lib/kernel/event-fanout.ts"), "utf8")

// All KernelEvent enum member names.
const allEvents = new Set(
  Array.from(eventsSrc.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*=\s*['"][a-z0-9_.]+['"]/gm)).map(m => m[1]),
)

// Templated events = PORTAL_UPDATE_TEMPLATES keys [KernelEvent.X].
const templated = new Set(
  Array.from(fanoutSrc.matchAll(/\[KernelEvent\.([A-Z][A-Z0-9_]+)\]\s*:/g)).map(m => m[1]),
)

// Prefixes/names that are unambiguously INTERNAL (back-office) and must never produce a client card.
const INTERNAL_PREFIXES = [
  "SCRAPE_", "SCRAPING_", "RAW_RECORD_", "RAW_LEAD_", "LEAD_", "CONTACT_", "ISA_", "AI_ISA_",
  "COMMISSION_", "CAP_", "SUBSCRIPTION_", "BILLING_", "USAGE_", "CRON_", "USER_", "AGENT_SESSION_",
  "AGENT_TASK_", "AGENT_HANDOFF_", "AGENT_ESCALATED", "VIDEO_", "VOICE_", "SCRIPT_", "SNIPPET_",
  "AD_", "MARKETING_CAMPAIGN_", "SOCIAL_", "BLOG_", "NEWSLETTER_", "EMAIL_CAMPAIGN_", "PODCAST_",
  "DIRECT_MAIL_", "INTEGRATION_", "OAUTH_", "CRM_SYNC_", "ENRICHMENT_", "BRAND_COMPLIANCE_",
  "DAILY_BRIEFING_", "COACHING_", "KB_ARTICLE_", "MEMORY_CONTEXT_", "PROMPT_", "AI_FEEDBACK_",
  "AI_METRICS_", "PREDICTION_", "BEHAVIORAL_PATTERN_", "ACCOUNTING_", "EXPENSE_", "REPORT_",
  "TEAM_ROLLUP_", "BROKERAGE_PL_", "RECRUITING_", "GAMIFICATION_", "OMNIPRESENCE_", "CAMPAIGN_ROI_",
  "SYSTEM_SYNC_", "PORTAL_VIEW_", "PORTAL_ACCESSED", "PORTAL_MODULE_", "PORTAL_EDUCATION_",
]
const isInternal = (e: string) => INTERNAL_PREFIXES.some(p => e === p || e.startsWith(p))

// Curated client-facing milestones we expect to remain covered.
const EXPECTED_CLIENT = [
  // listings
  "LISTING_CREATED", "COMING_SOON_SENT", "LISTING_PUBLISHED", "LISTING_UNDER_CONTRACT",
  "LISTING_STAGE_CHANGED", "LISTING_EXPIRED", "LISTING_CANCELLED",
  // offers
  "OFFER_SUBMITTED", "OFFER_ACCEPTED", "OFFER_REJECTED", "OFFER_COUNTER_SENT",
  "OFFER_OS_SUBMITTED", "OFFER_OS_ACCEPTED",
  // transaction milestones
  "EARNEST_MONEY_RECEIVED", "INSPECTION_ORDERED", "APPRAISAL_ORDERED", "APPRAISAL_COMPLETED",
  "FINANCING_CLEAR_TO_CLOSE", "CD_RECEIVED", "CLOSING_SCHEDULED", "TRANSACTION_STAGE_CHANGED",
  "TRANSACTION_CLOSED",
  // buyer home-search
  "PROPERTY_MATCH_FOUND", "SEARCH_ALERT_TRIGGERED", "PROPERTY_ALERT_MATCHED", "TOUR_SCHEDULED",
  "TOUR_COMPLETED", "SHOWING_SCHEDULED",
  // activity
  "OPEN_HOUSE_SCHEDULED", "SHOWING_FEEDBACK_RECEIVED",
  // esign & docs
  "OFFER_OS_ESIGN_COMPLETED", "ESIGN_SIGNED_COMPLETED", "DOCUMENT_REQUESTED",
  // lifetime / post-close
  "REVIEW_REQUEST_SENT", "ANNIVERSARY_TRIGGERED", "MARKET_UPDATE_SENT", "SELLER_UPDATE_SENT",
]

let pass = 0
let fail = 0
const fails: string[] = []
const ok = (cond: boolean, msg: string) => { if (cond) { pass++ } else { fail++; fails.push(msg) } }

// 1. No dead keys.
for (const t of templated) ok(allEvents.has(t), `template key is not a real KernelEvent: ${t}`)

// 2. No internal event is templated.
for (const t of templated) ok(!isInternal(t), `INTERNAL event must not be on client portal: ${t}`)

// 3. Curated client milestones stay covered.
for (const e of EXPECTED_CLIENT) {
  ok(allEvents.has(e), `expected client event missing from enum: ${e}`)
  ok(templated.has(e), `expected client milestone lost its portal template: ${e}`)
}

// 4. Metadata interpolation (the real renderTemplateText) — proactive, date-specific notices.
ok(renderTemplateText("due {earnest_money_due}", { earnest_money_due: "2026-06-01" }) === "due 2026-06-01",
   "renderTemplateText fills a present key")
ok(renderTemplateText("close {closing_date}", {}) === "close TBD",
   "renderTemplateText renders a missing key as TBD")
ok(renderTemplateText("close {closing_date}", { closing_date: "" }) === "close TBD",
   "renderTemplateText renders a blank key as TBD")
ok(renderTemplateText("no tokens here", { a: 1 }) === "no tokens here",
   "renderTemplateText leaves token-free text unchanged")
ok(renderTemplateText("{earnest_money_due} & {inspection_deadline}", { earnest_money_due: "6/1", inspection_deadline: "6/10" }) === "6/1 & 6/10",
   "renderTemplateText fills multiple tokens")
ok(renderTemplateText("held by {title_company}", { title_company: { name: "x" } }) === "held by TBD",
   "renderTemplateText renders an object value as TBD (never [object Object])")
ok(renderTemplateText("paid {amount}", { amount: 0 }) === "paid 0",
   "renderTemplateText renders numeric 0 (not TBD)")

// 5. Audience gating — domain semantics: listings/showings = seller side; properties/tours = buyer side.
function blockOf(eventName: string): string {
  const start = fanoutSrc.indexOf(`[KernelEvent.${eventName}]`)
  if (start < 0) return ""
  const next = fanoutSrc.indexOf("[KernelEvent.", start + 1)
  return fanoutSrc.slice(start, next < 0 ? start + 600 : next)
}
const SELLER_AUDIENCE = ["SHOWING_SCHEDULED", "SHOWING_FEEDBACK_RECEIVED", "OPEN_HOUSE_SCHEDULED"]
const BUYER_AUDIENCE  = ["TOUR_SCHEDULED", "PROPERTY_MATCH_FOUND", "SEARCH_ALERT_TRIGGERED", "PROPERTY_ALERT_MATCHED"]
for (const e of SELLER_AUDIENCE) ok(/audience:\s*"seller"/.test(blockOf(e)), `${e} must be audience:"seller" (listing/showing = seller side)`)
for (const e of BUYER_AUDIENCE)  ok(/audience:\s*"buyer"/.test(blockOf(e)),  `${e} must be audience:"buyer" (property/tour = buyer side)`)

console.log(`[portal-curation] events=${allEvents.size} templated=${templated.size} expectedClient=${EXPECTED_CLIENT.length}`)
console.log(`[portal-curation] internal events in enum (gated off portal): ${Array.from(allEvents).filter(isInternal).length}`)
if (fails.length) { console.log("FAILURES:"); fails.forEach(f => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
