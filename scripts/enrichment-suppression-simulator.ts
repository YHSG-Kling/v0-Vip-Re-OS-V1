#!/usr/bin/env tsx
/**
 * scripts/enrichment-suppression-simulator.ts   (npm run test:enrichment-suppression)
 * ─────────────────────────────────────────────────────────────────────────────
 * ENRICHMENT MUST NOT RUN DURING A LIVE DEAL — AND MUST RUN BEFORE AND AFTER ONE.
 *
 * The owner's ruling, verbatim:
 *   "contact enrichment should happen as soon as a new contact comes in and also
 *    check if a life change or other change happens for the contact but not if
 *    they have an active listing or an active transaction; just before or after."
 *
 * Three things could go wrong here, and only one of them is loud:
 *
 *  1. TOO NARROW — a stage or status missing from the ACTIVE set means paid
 *     third-party lookups fire at a client who is mid-closing. Silent.
 *  2. TOO BROAD — a terminal state treated as active means the contact is never
 *     enriched again after their first deal. Also silent: it looks exactly like
 *     "we have no data on this person", forever.
 *  3. FAIL-OPEN — supabase-js RESOLVES a refused query, so `const { data }`
 *     reads "RLS said no" as "no rows", i.e. as "not in a deal". For a
 *     suppression check that inversion switches the gate OFF at precisely the
 *     moment it cannot be verified.
 *
 * The classifier partitions BOTH vocabularies EXHAUSTIVELY (BEFORE / ACTIVE /
 * AFTER) rather than negating a terminal set, and the PURE layer below asserts
 * the partition equals the live CHECK snapshot with no gaps and no overlaps. A
 * migration that adds a state fails this guard instead of silently landing in
 * whichever bucket a negation happened to put it.
 *
 * THE CONCRETE TRAP THIS GUARD EXISTS FOR. lib/transactions/closing-overdue-policy.ts
 * already exports TERMINAL_TXN_STATUSES = {closed, lost, cancelled, terminated,
 * withdrawn, dead}. Four of those six are literals transactions_status_check
 * cannot hold, and it OMITS 'funded' and 'archived', which are terminal. Reusing
 * it as "not terminal ⇒ active" — the obvious implementation — would suppress
 * enrichment forever on every funded and every archived deal. The last PURE
 * assertion below pins that, so nobody "simplifies" the classifier into it.
 *
 * SOURCE layer: every enrichment entry point actually consults the predicate,
 * the predicate fails closed, and the unattended cron does not route through the
 * session-gated server action (which is how it died the first time).
 * PURE layer: the partition and the classifier behaviour.
 * LIVE layer (creds-gated): the CHECK constraints really do admit exactly the
 * values the classifier partitions.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  LISTING_STAGES_BEFORE,
  LISTING_STAGES_ACTIVE,
  LISTING_STAGES_AFTER,
  LISTING_STATUSES_ACTIVE,
  LISTING_STATUSES_INACTIVE,
  TXN_STATUSES_BEFORE,
  TXN_STATUSES_ACTIVE,
  TXN_STATUSES_AFTER,
  TXN_STAGES_ACTIVE,
  TXN_STAGES_AFTER,
  isListingLive,
  isTransactionLive,
  leadDealLinkage,
} from "../lib/enrichment/deal-vocabulary"
import { hasUsableIdentifier } from "../lib/enrichment/identifier-guard"
import {
  LEAD_ENRICHMENT_FRESHNESS_DAYS,
  leadEnrichmentIsFresh,
  leadHasEnrichmentEvidence,
} from "../lib/enrichment/lead-freshness"
import { TERMINAL_TXN_STATUSES } from "../lib/transactions/closing-overdue-policy"
// ── free OSINT selection (wave 5) ────────────────────────────────────────────
import { planEnrichmentLane } from "../lib/external/osint-free"
import { VENDOR_PRICING, normalizeVendorCost } from "../lib/vendor-governance/cost-normalizer"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
/** Strip comments so no assertion can be satisfied by prose describing the fix. */
const code = (p: string) => stripComments(src(p))

const SUPPRESSION = "lib/enrichment/deal-suppression.ts"
const CORE        = "lib/enrichment/contact-enrichment-core.ts"
const ACTION      = "app/actions/contact-enrichment.ts"
const CRON        = "app/api/cron/contact-enrichment/route.ts"
const DRAIN       = "lib/lead-pipeline/enrichment-orchestrator.ts"
const REACTOR     = "lib/kernel/event-reactor.ts"
// ─── Track A (wave 5) ────────────────────────────────────────────────────────
const LEAD_CORE   = "lib/enrichment/lead-enrichment-core.ts"
const LEAD_CRON   = "app/api/cron/enrichment-processor/route.ts"
const LEAD_HANDLERS = "lib/kernel/lead-acquisition-handlers.ts"

/** Exhaustive, disjoint partition of a vocabulary. */
function partitions(label: string, buckets: readonly (readonly string[])[], live: readonly string[]) {
  const seen = new Set<string>()
  let overlap = false
  for (const b of buckets) for (const v of b) {
    if (seen.has(v)) overlap = true
    seen.add(v)
  }
  check(`${label}: no value is in two buckets`, !overlap)
  const missing = live.filter((v) => !seen.has(v))
  const extra = [...seen].filter((v) => !live.includes(v))
  check(`${label}: every value the CHECK admits is classified${missing.length ? ` (missing ${missing.join(",")})` : ""}`,
    missing.length === 0)
  check(`${label}: no classified value is outside the CHECK${extra.length ? ` (extra ${extra.join(",")})` : ""}`,
    extra.length === 0)
}

function pureLayer() {
  console.log("\n[pure · the partition covers the settled vocabulary exactly]")
  partitions("listings.lifecycle_stage",
    [LISTING_STAGES_BEFORE, LISTING_STAGES_ACTIVE, LISTING_STAGES_AFTER],
    CHECK_VOCABULARIES.listings?.lifecycle_stage ?? [])
  partitions("listings.status",
    [LISTING_STATUSES_ACTIVE, LISTING_STATUSES_INACTIVE],
    CHECK_VOCABULARIES.listings?.status ?? [])
  partitions("transactions.status",
    [TXN_STATUSES_BEFORE, TXN_STATUSES_ACTIVE, TXN_STATUSES_AFTER],
    CHECK_VOCABULARIES.transactions?.status ?? [])
  partitions("transactions.stage",
    [TXN_STAGES_ACTIVE, TXN_STAGES_AFTER],
    CHECK_VOCABULARIES.transactions?.stage ?? [])

  console.log("\n[pure · 'just before' — a listing that has not been signed is not a live deal]")
  check("a listing at LEAD is not live",
    !isListingLive({ lifecycle_stage: "LEAD", status: "draft" }))
  check("a listing at SELLER_DECISION is not live (still deciding)",
    !isListingLive({ lifecycle_stage: "SELLER_DECISION", status: "draft" }))
  check("LISTING_AGREEMENT_INITIATED is not yet live (initiated ≠ signed)",
    !isListingLive({ lifecycle_stage: "LISTING_AGREEMENT_INITIATED", status: "draft" }))

  console.log("\n[pure · the deal is live from the signature onward]")
  check("LISTING_AGREEMENT_SIGNED is live even though status is still 'draft'",
    isListingLive({ lifecycle_stage: "LISTING_AGREEMENT_SIGNED", status: "draft" }))
  check("MLS_ACTIVE is live", isListingLive({ lifecycle_stage: "MLS_ACTIVE", status: "active" }))
  check("UNDER_CONTRACT is live", isListingLive({ lifecycle_stage: "UNDER_CONTRACT", status: "pending" }))
  check("CLOSING_PREP is live", isListingLive({ lifecycle_stage: "CLOSING_PREP", status: "pending" }))

  console.log("\n[pure · 'or after' — a terminal stage is DECISIVE over a stale status]")
  // listing-status-sync only writes `status` at market-state boundaries and
  // webhooks write it ad-hoc, so a stale 'active' on a CLOSED listing is
  // reachable. If status could veto a terminal stage, that past client would
  // never be enriched again.
  check("CLOSED wins over a stale status='active'",
    !isListingLive({ lifecycle_stage: "CLOSED", status: "active" }))
  check("LIFETIME_CUSTOMER is not live (post-close)",
    !isListingLive({ lifecycle_stage: "LIFETIME_CUSTOMER", status: "sold" }))
  check("LISTING_EXPIRED is not live", !isListingLive({ lifecycle_stage: "LISTING_EXPIRED", status: "expired" }))
  check("LISTING_CANCELLED is not live", !isListingLive({ lifecycle_stage: "LISTING_CANCELLED", status: "withdrawn" }))
  check("SELLER_DECLINED is not live", !isListingLive({ lifecycle_stage: "SELLER_DECLINED", status: "withdrawn" }))

  console.log("\n[pure · a live status still suppresses when the stage machine has not moved]")
  check("status='active' with a pre-signature stage is treated as live (either signal is enough)",
    isListingLive({ lifecycle_stage: "LEAD", status: "active" }))

  console.log("\n[pure · transactions]")
  check("status='lead' is not live", !isTransactionLive({ status: "lead", stage: null }))
  check("status='qualifying' is not live", !isTransactionLive({ status: "qualifying", stage: null }))
  check("status='under_contract' is live", isTransactionLive({ status: "under_contract", stage: "UNDER_CONTRACT" }))
  check("status='clear_to_close' is live", isTransactionLive({ status: "clear_to_close", stage: "CLOSING_PREP" }))
  check("a null status with an active stage is live (stage is the fallback signal)",
    isTransactionLive({ status: null, stage: "INSPECTION" }))

  console.log("\n[pure · the omission that makes the existing terminal set unusable]")
  // THE trap. Both of these are 'after the deal' and BOTH are missing from
  // TERMINAL_TXN_STATUSES, so `!TERMINAL_TXN_STATUSES.has(status)` calls them live.
  check("status='funded' is NOT live (money has moved — the deal is over)",
    !isTransactionLive({ status: "funded", stage: "CLOSING_PREP" }))
  check("status='archived' is NOT live", !isTransactionLive({ status: "archived", stage: null }))
  check("a terminal status wins over a stale non-null stage",
    !isTransactionLive({ status: "closed", stage: "CLOSING_PREP" }))
  check("TERMINAL_TXN_STATUSES still omits 'funded' — the reason it is not reused here",
    !TERMINAL_TXN_STATUSES.has("funded"))
  check("TERMINAL_TXN_STATUSES still omits 'archived'", !TERMINAL_TXN_STATUSES.has("archived"))
  check("...and it still names literals the live CHECK cannot hold",
    ["cancelled", "terminated", "dead"].some(
      (v) => TERMINAL_TXN_STATUSES.has(v) && !(CHECK_VOCABULARIES.transactions?.status ?? []).includes(v)))

  console.log("\n[pure · nothing is bought for a contact nobody can look up]")
  check("a social-DM stub ('Social Lead', no email/phone) has no usable identifier",
    !hasUsableIdentifier({ first_name: "Social", last_name: "Lead", email: null, phone: null }))
  check("an email alone is enough", hasUsableIdentifier({ first_name: null, last_name: null, email: "a@b.com" }))
  check("a phone alone is enough", hasUsableIdentifier({ first_name: null, last_name: null, phone: "5125550123" }))
  check("a real full name is enough", hasUsableIdentifier({ first_name: "Dana", last_name: "Kling" }))
  check("a first name alone is not", !hasUsableIdentifier({ first_name: "Dana", last_name: "" }))

  // ═══ TRACK A — THE LEAD LANE (wave 5) ══════════════════════════════════════
  //   "enrichment also needs to still happen with raw leads"  (owner)
  console.log("\n[pure · a lead is asked the deal question through its CONTACT, never as itself]")
  // The schema fact this rests on: no `listings.lead_id`, no
  // `transactions.lead_id` — thirty-seven tables carry an FK to `leads` and
  // neither deal table is among them. So the question is unanswerable in the
  // lead's own id space and leadDealLinkage is the named resolution step that
  // stops anyone writing `leadId ?? contactId` in the I/O layer.
  check("an unconverted lead is UNLINKED — nothing in listings/transactions can point at it",
    leadDealLinkage({ contact_id: null }).kind === "unlinked")
  check("a lead with no contact_id key at all is unlinked",
    leadDealLinkage({}).kind === "unlinked")
  check("a converted lead RESOLVES to its contacts.id",
    leadDealLinkage({ contact_id: "c-1" }).kind === "resolve")
  check("...and the resolved id is the CONTACT id, not the lead id",
    (leadDealLinkage({ contact_id: "c-1" }) as { contactId?: string }).contactId === "c-1")
  // `.eq("id","")` on a uuid column raises 22P02, which a fail-closed predicate
  // reads as "cannot tell" and suppresses forever. Empty/blank is unlinked.
  check("an empty-string contact_id is unlinked, never passed through (22P02)",
    leadDealLinkage({ contact_id: "" }).kind === "unlinked")
  check("a whitespace-only contact_id is unlinked too",
    leadDealLinkage({ contact_id: "   " }).kind === "unlinked")

  console.log("\n[pure · a lead is 'enriched' by EVIDENCE, not by the stamp its create door wrote]")
  // THE LEAD-SIDE TRAP, and the mirror of the terminal-set trap above.
  // pipeline-processor.ts:486 and lead-promoter.ts:107 both write
  // `enrichment_status:'completed'` + `last_enriched_at: now` at INSERT, before
  // any provider has answered — and pipeline-processor calls
  // enrichWithPeopleData(...).catch(() => ({data:null})), so a MISS is stamped
  // identically to a hit. A freshness gate reading the timestamp alone would
  // refuse to queue those leads today and forever: "too broad ⇒ enrichment never
  // runs", reached from the opposite direction.
  // leads.enrichment_profile is jsonb NOT NULL default '{}'; neither create door
  // writes it and only a real drain success does (enrichment-orchestrator:301).
  check("an untouched lead ({} profile) has NO enrichment evidence",
    !leadHasEnrichmentEvidence({ enrichment_profile: {} }))
  check("a null profile has no evidence", !leadHasEnrichmentEvidence({ enrichment_profile: null }))
  check("an array is not an evidence blob", !leadHasEnrichmentEvidence({ enrichment_profile: [] }))
  check("a populated profile IS evidence",
    leadHasEnrichmentEvidence({ enrichment_profile: { provider: "peopledata" } }))

  const NOW = Date.parse("2026-08-09T12:00:00.000Z")
  const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()
  check("THE TRAP: stamped 'enriched just now' with an EMPTY profile is NOT fresh (the create-door lie)",
    !leadEnrichmentIsFresh({ last_enriched_at: daysAgo(0), enrichment_profile: {} }, { now: NOW }))
  check("a genuinely enriched lead inside the window IS fresh (not re-bought)",
    leadEnrichmentIsFresh({ last_enriched_at: daysAgo(1), enrichment_profile: { provider: "peopledata" } }, { now: NOW }))
  check("...and outside the window is not",
    !leadEnrichmentIsFresh(
      { last_enriched_at: daysAgo(LEAD_ENRICHMENT_FRESHNESS_DAYS + 1), enrichment_profile: { provider: "peopledata" } },
      { now: NOW }))
  check("evidence with an unparseable stamp is not fresh (we cannot date it — re-check)",
    !leadEnrichmentIsFresh({ last_enriched_at: "not-a-date", enrichment_profile: { provider: "x" } }, { now: NOW }))
  check("evidence with a NULL stamp is not fresh",
    !leadEnrichmentIsFresh({ last_enriched_at: null, enrichment_profile: { provider: "x" } }, { now: NOW }))
  check("a FUTURE stamp is clock skew, not freshness",
    !leadEnrichmentIsFresh({ last_enriched_at: daysAgo(-5), enrichment_profile: { provider: "x" } }, { now: NOW }))
}

function sourceLayer() {
  console.log("\n[source · the predicate fails CLOSED]")
  const supp = code(SUPPRESSION)
  check("both reads destructure error",
    (supp.match(/const\s*\{\s*data:\s*\w+,\s*error:\s*\w+\s*\}\s*=\s*await\s+supabase/g) ?? []).length >= 2)
  check("...and an unreadable table returns inLiveDeal: true",
    /inLiveDeal:\s*true,\s*reason:\s*"unreadable"/.test(supp))
  check("no unchecked `const { data } = await supabase` remains",
    !/const\s*\{\s*data\s*\}\s*=\s*await\s+supabase/.test(supp))
  check("the batch form fails closed by suppressing EVERY id",
    /suppressed:\s*new Set\(ids\),\s*degraded:\s*true/.test(supp))
  check("all FIVE contact foreign keys are queried",
    ["contact_id", "seller_contact_id", "buyer_contact_id"].every((c) => supp.includes(c)) &&
    /buyer_contact_id\.eq\./.test(supp) && /seller_contact_id\.eq\./.test(supp))
  check("the predicate is tenant-scoped on both tables",
    (supp.match(/\.eq\("brokerage_id",\s*brokerageId\)/g) ?? []).length >= 2)

  console.log("\n[source · EVERY enrichment entry point consults it]")
  const core = code(CORE)
  check("the shared pre-flight calls isContactInLiveDeal", /preflight[\s\S]{0,600}?isContactInLiveDeal/.test(core))
  check("enrichContactRecord goes through the pre-flight",
    /export async function enrichContactRecord[\s\S]{0,4000}?await preflight\(/.test(core))
  check("runLifeChangeCheck goes through the pre-flight",
    /export async function runLifeChangeCheck[\s\S]{0,3000}?await preflight\(/.test(core))
  check("queueContactEnrichment refuses to queue a contact in a live deal",
    /export async function queueContactEnrichment[\s\S]{0,3000}?isContactInLiveDeal[\s\S]{0,300}?reason:\s*"live_deal"/.test(core))
  check("the work-list readers exclude live deals in bulk",
    (core.match(/contactsInLiveDeals\(/g) ?? []).length >= 2)
  check("the queue drain re-checks before spending", code(DRAIN).includes("isContactInLiveDeal"))

  console.log("\n[source · suppression is not the only bound on spend]")
  check("the core pre-flights the house vendor budget gate", core.includes("checkVendorBudget"))
  check("...and ledgers on the house vendor rail", core.includes("trackVendorUsageService"))
  check("no new metering table was invented",
    !/from\(["'](?:enrichment_usage|enrichment_spend|enrichment_meter)["']\)/.test(core))
  check("the cron caps the whole run, not just each tenant", code(CRON).includes("RUN_VENDOR_CALL_BUDGET"))

  console.log("\n[source · the unattended door does not route through the session gate]")
  const cron = code(CRON)
  check("the cron does NOT import from app/actions/contact-enrichment",
    !/from\s+["']@\/app\/actions\/contact-enrichment["']/.test(cron))
  check("...it imports the tenant-explicit library instead",
    /from\s+["']@\/lib\/enrichment\/contact-enrichment-core["']/.test(cron))
  check("...and reads its tenant list from the database, never from the request",
    /from\("brokerages"\)[\s\S]{0,200}?is_active/.test(cron) && !/request\.(json|url)/.test(cron))
  check("it still verifies the cron secret", cron.includes("verifyCronAuth"))
  check("no fake identity is asserted", !/["']system["']/.test(cron))

  console.log("\n[source · the session door is still a session door]")
  const action = code(ACTION)
  const gated = ["enrichContact", "enrichContactsBatch", "checkContactLifeChanges",
    "getUnenrichedContacts", "getContactsNeedingLifeChangeCheck", "getRecentLifeChanges",
    "markLifeChangeNotified", "getContactInsights"]
  for (const fn of gated) {
    const m = new RegExp(`export async function ${fn}\\b[\\s\\S]{0,900}?getAgentContext\\(\\)`).test(action)
    check(`${fn} resolves the tenant from the session`, m)
  }
  check("the batch cap survives", /ENRICH_BATCH_MAX\s*=\s*\d+/.test(action))
  check("no helper is exported from the \"use server\" file (every export is async)",
    !/^export (?!async function|type|interface)/m.test(action))

  console.log("\n[source · criterion 1 — create-time, event-driven]")
  const reactor = code(REACTOR)
  check("the reactor enqueues enrichment on CONTACT_CREATED / CONTACT_CAPTURED",
    /CONTACT_CREATED[\s\S]{0,400}?CONTACT_CAPTURED[\s\S]{0,800}?queueContactEnrichment/.test(reactor))
  check("criterion 2 — the reactor re-checks when a deal ENDS",
    /DEAL_END_EVENTS[\s\S]{0,900}?queueContactLifeChangeRecheck/.test(reactor))
  check("the create hook cannot fail contact creation (guarded)",
    /queueContactEnrichment\([\s\S]{0,400}?\}\s*catch/.test(reactor))

  // EVERY DIRECTLY-HOOKED DOOR, BY NAME.
  //
  // The reactor is the chokepoint for any door that emits CONTACT_CREATED /
  // CONTACT_CAPTURED, and the assertion above pins it. But the wave-3 sweep found
  // 19 create-doors and only 4 of them queued enrichment; 8 emit no kernel event
  // at all and had to be hooked directly. A direct hook is exactly the kind of
  // wiring that rots silently — delete the call and nothing errors, no test goes
  // red, the contact is simply never enriched and nobody finds out. So each one is
  // named here rather than trusted to the chokepoint it does not pass through.
  for (const door of [
    "app/actions/agent-public-profile.ts",       // public agent profile capture
    "app/api/open-house/attend/route.ts",        // open-house sign-in (public)
    "lib/kernel/open-house.ts",                  // open-house attendee → contact
    "lib/ads/ad-lead-intake.ts",                 // paid-ad lead intake
    "lib/kernel/lead-magnets.ts",                // lead-magnet download capture
    "lib/kernel/listings.ts",                    // seller contact on a new listing
    "lib/contact-promotion/contact-creator.ts",  // lead → contact promotion
    "lib/services/contact-management.service.ts",// CRM manual add
  ]) {
    check(`direct door still queues enrichment: ${door}`,
      /queueContactEnrichment\s*\(/.test(code(door)))
  }

  console.log("\n[source · one queue writer, not four]")
  // Each of these used to hold its own private copy with a different set of guards.
  for (const f of [
    "lib/kernel/crm.ts",
    "lib/contact-pipeline/contact-capture.ts",
    "app/api/widget/intake/route.ts",
  ]) {
    check(`${f} no longer writes lead_enrichment_queue directly`,
      !/from\((["'])lead_enrichment_queue\1\)[\s\S]{0,120}?\.insert\(/.test(code(f)))
  }
  // lib/ghl-integration.ts is DELETED entirely (2026-08-27 — a duplicate of
  // services/goHighLevelService.ts whose last importer was the removed
  // app/api/webhooks/ghl route). The un-drainable queue write it once carried
  // cannot return through a file that no longer exists, so the claim moves to
  // the survivor, which must never pick the write up. The tombstone check
  // reads RAW source on purpose — a tombstone IS a comment (§2).
  check("lib/ghl-integration.ts stays deleted, tombstoned at the survivor",
    !existsSync(join(process.cwd(), "lib/ghl-integration.ts")) &&
    src("services/goHighLevelService.ts").includes("lib/ghl-integration.ts"))
  check("the surviving GHL egress module writes no enrichment queue row",
    !code("services/goHighLevelService.ts").includes("lead_enrichment_queue"))
  check("the survivor requires the tenant rather than writing an un-drainable row",
    /queueContactEnrichment[\s\S]{0,900}?if\s*\(!contactId\s*\|\|\s*!brokerageId\)/.test(core))

  console.log("\n[source · the life-change type is one the column admits]")
  check("the re-check queues 'osint_profile', not an invented literal",
    core.includes('enrichment_type: "osint_profile"') && !core.includes('"life_change"'))
  check("...and the drain routes that type to the OSINT-only checker",
    /enrichment_type\s*===\s*'osint_profile'[\s\S]{0,400}?runLifeChangeCheck/.test(code(DRAIN)))
  check("'osint_profile' is in the settled enrichment_type vocabulary",
    (CHECK_VOCABULARIES.lead_enrichment_queue?.enrichment_type ?? []).includes("osint_profile"))

  leadSourceLayer()
}

// ═══════════════════════════════════════════════════════════════════════════
// TRACK A — THE LEAD LANE (wave 5)
//
//   "enrichment also needs to still happen with raw leads"
//   "no ghl on when a contact is syncing to it. we only enrich the contact in
//    this system."
//
// The drain has handled both tracks since it was written (enrichment-orchestrator
// line 2, and it derives entityType from entry.lead_id). The gap was DOOR
// COVERAGE — enumerated the way wave 3 enumerated contacts, there are exactly
// three `leads` INSERT sites in app/ + lib/ and none of them queued anything.
// ═══════════════════════════════════════════════════════════════════════════
function leadSourceLayer() {
  const leadCore = code(LEAD_CORE)
  const supp     = code(SUPPRESSION)
  const reactor  = code(REACTOR)

  console.log("\n[source · the lead predicate RESOLVES, it does not substitute]")
  check("isLeadInLiveDeal exists on the one suppression import site",
    /export async function isLeadInLiveDeal/.test(supp))
  check("...and it reads leads.contact_id rather than re-keying the contact predicate",
    /isLeadInLiveDeal[\s\S]{0,1800}?leadDealLinkage\(/.test(supp))
  check("...and hands the CONTACT id to isContactInLiveDeal",
    /leadDealLinkage[\s\S]{0,900}?isContactInLiveDeal\(\s*\{\s*contactId:\s*linkage\.contactId/.test(supp))
  // The substitution that would break everything: leads.id and contacts.id are
  // disjoint, so a `??` between them asks a question about the wrong row.
  check("no `leadId ?? contactId` (or the reverse) coercion anywhere in the predicate",
    !/leadId\s*\?\?\s*contactId/.test(supp) && !/contactId\s*\?\?\s*leadId/.test(supp))
  check("the lead read is tenant-scoped",
    /from\("leads"\)[\s\S]{0,300}?\.eq\("brokerage_id",\s*brokerageId\)/.test(supp))
  check("the lead read destructures error and fails CLOSED",
    /error:\s*leadError[\s\S]{0,300}?inLiveDeal:\s*true/.test(supp))
  check("a lead that cannot be found in this tenant fails CLOSED, not open",
    /if\s*\(!lead\)\s*\{[\s\S]{0,200}?inLiveDeal:\s*true/.test(supp))

  console.log("\n[source · one guarded lead-queue writer, and every guard is present]")
  check("queueLeadEnrichment requires the tenant rather than writing an un-drainable row",
    /export async function queueLeadEnrichment[\s\S]{0,900}?if\s*\(!leadId\s*\|\|\s*!brokerageId\)/.test(leadCore))
  check("it refuses a lead with no usable identifier", /hasUsableIdentifier\(lead\)/.test(leadCore))
  check("it uses the EVIDENCE freshness test, not last_enriched_at alone",
    /leadEnrichmentIsFresh\(/.test(leadCore) &&
    !/last_enriched_at[\s\S]{0,80}?new Date\([\s\S]{0,40}?\)\.getTime\(\)\s*<\s*fresh/.test(leadCore))
  check("it applies the owner's suppression BEFORE writing the row",
    /isLeadInLiveDeal\([\s\S]{0,200}?\)[\s\S]{0,200}?reason:\s*"live_deal"/.test(leadCore))
  check("it has the pending/processing idempotency guard",
    /\.eq\("lead_id",\s*leadId\)[\s\S]{0,200}?\.in\("status",\s*\["pending",\s*"processing"\]\)/.test(leadCore))
  check("...and a refused idempotency read is an error, not 'nothing pending'",
    /if\s*\(existingError\)\s*return\s*\{\s*queued:\s*false,\s*reason:\s*"error"/.test(leadCore))
  check("it writes contact_id: null so the drain routes the row to the LEAD path",
    /lead_id:\s*leadId,\s*\n\s*contact_id:\s*null/.test(leadCore))
  check("the queued enrichment_type is one the CHECK admits",
    /enrichmentType\s*\?\?\s*"skip_trace"/.test(leadCore) &&
    (CHECK_VOCABULARIES.lead_enrichment_queue?.enrichment_type ?? []).includes("skip_trace"))
  // Every caller is a lead-CREATE door. Creating a lead must never fail because
  // of enrichment, so the writer's contract is "never throws".
  check("queueLeadEnrichment cannot throw (whole body wrapped, catch returns an outcome)",
    /export async function queueLeadEnrichment[\s\S]{0,600}?try\s*\{[\s\S]{0,9000}?\}\s*catch\s*\(error\)\s*\{[\s\S]{0,400}?return\s*\{\s*queued:\s*false/.test(leadCore))
  check("...and the door helper voids it as well", /export function queueLeadEnrichmentBestEffort[\s\S]{0,400}?void queueLeadEnrichment/.test(leadCore))

  console.log("\n[source · leads are higher-volume, so the money is bounded at the QUEUE too]")
  check("the lead core pre-flights the house vendor budget gate", leadCore.includes("checkVendorBudget"))
  check("an over-budget tenant queues ZERO lead rows",
    /if\s*\(!budget\.allowed\)[\s\S]{0,300}?reason:\s*"budget"/.test(leadCore))
  check("a hard per-tenant backlog cap exists", /MAX_PENDING_LEAD_ENRICHMENTS\s*=\s*\d+/.test(leadCore))
  check("...counted over lead_id rows only, so a lead surge cannot hide behind the contact track",
    /\.not\("lead_id",\s*"is",\s*null\)/.test(leadCore))
  check("...and an unreadable backlog count fails CLOSED (we do not add to a queue we cannot size)",
    /if\s*\(countError\)[\s\S]{0,300}?reason:\s*"error"/.test(leadCore))
  check("the lead cost figure is the skip-trace-only one, not the contact lane's OSINT figure",
    /ESTIMATED_LEAD_ENRICHMENT_COST_USD\s*=\s*0\.1\b/.test(leadCore))
  check("no new metering table was invented for the lead lane",
    !/from\(["'](?:lead_enrichment_usage|enrichment_spend|enrichment_meter)["']\)/.test(leadCore))
  check("the drain's own per-tenant ceiling is untouched", /BATCH_SIZE\s*=\s*10/.test(code(DRAIN)))

  console.log("\n[source · the drain really does run both tracks]")
  check("the drain derives the entity type from lead_id", /entry\.lead_id\s*\?\s*'lead'\s*:\s*'contact'/.test(code(DRAIN)))
  check("...and has a lead write path", code(DRAIN).includes("peopleDataProfileToLeadColumns"))
  check("...and fails a row that references neither", /!entry\.lead_id\s*&&\s*!entry\.contact_id/.test(code(DRAIN)))

  console.log("\n[source · criterion 1 for leads — create-time, event-driven]")
  check("the reactor enqueues lead enrichment on RAW_RECORD_PROMOTED / LEAD_CAPTURED",
    /RAW_RECORD_PROMOTED[\s\S]{0,300}?LEAD_CAPTURED[\s\S]{0,1200}?queueLeadEnrichment/.test(reactor))
  // RAW_RECORD_PROMOTED's entity is the RAW RECORD (raw_scraped_leads.id), not
  // the lead. Using entityId would hand a raw-record id to a leads-keyed query —
  // the same disjoint-id-space error the whole lane exists to avoid.
  check("...reading the lead id from metadata.lead_id, not from entityId",
    /LEAD_CREATE_EVENTS[\s\S]{0,900}?metadata[\s\S]{0,120}?lead_id/.test(reactor))
  check("the lead create hook cannot fail lead creation (guarded)",
    /queueLeadEnrichment\([\s\S]{0,400}?\}\s*catch/.test(reactor))

  // EVERY DIRECTLY-HOOKED LEAD DOOR, BY NAME.
  //
  // Enumerated exhaustively in docs/wave5-lead-enrichment.md: three `leads`
  // INSERT sites exist in app/ + lib/. One (lib/lead-pipeline/pipeline-processor.ts)
  // emits RAW_RECORD_PROMOTED and is covered by the chokepoint asserted above.
  // The other two emit NOTHING and are hooked directly — and a direct hook rots
  // silently: delete the call and nothing errors, no test goes red, the lead is
  // simply never enriched and nobody finds out. So each is named here rather
  // than trusted to a chokepoint it does not pass through.
  console.log("\n[source · every lead door that emits no event is hooked, by name]")
  for (const door of [
    "lib/kernel/crm.ts",                    // createLeadOnlyRecordForAcquisitionSource
    "lib/lead-promotion/lead-promoter.ts",  // promoteRawRecordToLead
  ]) {
    check(`direct lead door still queues enrichment: ${door}`,
      /queueLeadEnrichmentBestEffort\s*\(/.test(code(door)))
  }
  // The chokepoint door is asserted the other way round: it must NOT grow a
  // private queue write, and it must keep emitting the event the reactor listens
  // for.
  check("the live pipeline door still emits RAW_RECORD_PROMOTED (the chokepoint's input)",
    /KernelEvent\.RAW_RECORD_PROMOTED[\s\S]{0,300}?lead_id:\s*newLead\.id/.test(code("lib/lead-pipeline/pipeline-processor.ts")))
  check("...and writes no private lead_enrichment_queue row of its own",
    !/from\((["'])lead_enrichment_queue\1\)[\s\S]{0,120}?\.insert\(/.test(code("lib/lead-pipeline/pipeline-processor.ts")))
  // The platform-parked case: a platform-origin lead is born brokerage_id NULL
  // and only gets a tenant on distribution, so the promoter must not queue it
  // under the SCRAPING brokerage (wrong tenant's budget and wrong tenant's
  // suppression check).
  check("the promoter queues under the lead's OWN tenant, never the scraping one",
    /if\s*\(initialBrokerageId\)[\s\S]{0,600}?brokerageId:\s*initialBrokerageId/.test(code("lib/lead-promotion/lead-promoter.ts")))

  console.log("\n[source · one lead-queue writer, not two]")
  check("lib/kernel/lead-acquisition-handlers.ts no longer writes lead_enrichment_queue directly",
    !/from\((["'])lead_enrichment_queue\1\)[\s\S]{0,160}?\.insert\(/.test(code(LEAD_HANDLERS)))
  check("...it routes through the guarded survivor instead",
    /queueLeadEnrichment\(/.test(code(LEAD_HANDLERS)))

  console.log("\n[source · the lead net is an UNATTENDED door, bounded, tenant never from the request]")
  const leadCron = code(LEAD_CRON)
  check("the drain cron tops the lead queue up from the net",
    /listLeadsNeedingEnrichment\(/.test(leadCron))
  check("...bounded per brokerage", /LEAD_NET_PER_BROKERAGE/.test(leadCron))
  check("...and it stops asking once the tenant hits its backlog or budget bound",
    /reason\s*===\s*'backlog'\s*\|\|\s*[\s\S]{0,40}?'budget'/.test(leadCron))
  check("it verifies the cron secret", leadCron.includes("verifyCronAuth"))
  check("...reads its tenant list from the database, never from the request",
    /from\('brokerages'\)[\s\S]{0,200}?is_active/.test(leadCron) && !/request\.(json|url)/.test(leadCron))
  check("no fake identity is asserted", !/["']system["']/.test(leadCron))
  // The work list keys on evidence, not on the timestamp the create doors lie
  // with — a `last_enriched_at IS NULL` net would return almost nothing and look
  // healthy while enriching no one.
  check("the net keys on enrichment EVIDENCE, not on a null last_enriched_at",
    /leadHasEnrichmentEvidence\(/.test(leadCore) &&
    !/\.is\("last_enriched_at",\s*null\)/.test(leadCore))
  check("...and skips converted leads, which the contact lane already owns",
    /\.eq\("is_active",\s*true\)/.test(leadCore))

  console.log("\n[source · GHL is not a trigger, and enrichment output never leaves this system]")
  //   "no ghl on when a contact is syncing to it. we only enrich the contact in
  //    this system."  — checked as TWO separate claims.
  const contactCore = code(CORE)
  check("EnrichmentSource no longer admits 'ghl_sync' as a trigger",
    /export type EnrichmentSource\s*=/.test(contactCore) && !/["']ghl_sync["']/.test(contactCore))
  check("no enrichment module names a ghl_sync trigger anywhere",
    ![CORE, LEAD_CORE, SUPPRESSION, "lib/enrichment/lead-freshness.ts", "lib/enrichment/identifier-guard.ts"]
      .some((f) => /["']ghl_sync["']/.test(code(f))))
  // The syncContactFromGHL refusal stub was deleted WITH lib/ghl-integration.ts
  // (2026-08-27): the ruling "GHL is sync-out only" is enforced where inbound
  // actually arrives — the verified no-op webhook ack (next check) — and no
  // module may re-create an inbound GHL contact-sync entry point.
  check("no GHL inbound contact-sync entry point exists anywhere",
    !existsSync(join(process.cwd(), "lib/ghl-integration.ts")) &&
    !/syncContactFromGHL/.test(code("services/goHighLevelService.ts")))
  check("...and the GHL webhook still ignores inbound events",
    /one-way OUT only/.test(code("app/api/webhooks/gohighlevel/route.ts")))
  check("the surviving GHL egress writes no enrichment queue row (wave-3 deletion holds)",
    !code("services/goHighLevelService.ts").includes("lead_enrichment_queue"))
  // DESTINATION half. syncContactToCRM is the ONE outbound choke point; its
  // payload type is the whole surface that can reach a third-party CRM.
  const crmSync = code("lib/crm/sync.ts")
  const payload = crmSync.match(/export interface CRMContactPayload\s*\{[\s\S]*?\}/)?.[0] ?? ""
  check("the CRM egress payload type was found", payload.length > 0)
  check("...and carries NO enrichment output",
    payload.length > 0 &&
    !/enrichment|life_events|household_income|age_range|public_records|court_records|peopledata/i.test(payload))
  check("no enrichment module pushes anything to the CRM egress rail",
    ![CORE, LEAD_CORE, SUPPRESSION].some((f) => /syncContactToCRM|goHighLevelService|ghl-integration/.test(code(f))))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log("\n[live] ⊘ skipped (no SUPABASE creds) — the pure layer proved the partition")
    return
  }
  console.log("\n[live · the CHECK constraints admit exactly what the classifier partitions]")
  const svc = createClient(url, key, { auth: { persistSession: false } })

  // Assert against REAL ROWS: every value present in the live tables must be one
  // the classifier knows. (Empty tables are expected pre-rollout — an empty
  // result is not evidence the partition is right, which is why the PURE layer
  // carries the real proof and this layer only catches drift once data exists.)
  const { data: listings, error: lErr } = await svc
    .from("listings").select("lifecycle_stage, status").limit(500)
  if (lErr) {
    check("live: listings readable", false)
  } else {
    const known = new Set<string>([...LISTING_STAGES_BEFORE, ...LISTING_STAGES_ACTIVE, ...LISTING_STAGES_AFTER])
    const unknown = (listings ?? [])
      .map((r) => (r as { lifecycle_stage: string | null }).lifecycle_stage)
      .filter((s): s is string => !!s && !known.has(s))
    check(`live: every lifecycle_stage on real listings is classified${unknown.length ? ` (saw ${[...new Set(unknown)].join(",")})` : ""}`,
      unknown.length === 0)
  }

  const { data: txns, error: tErr } = await svc
    .from("transactions").select("status, stage").limit(500)
  if (tErr) {
    check("live: transactions readable", false)
  } else {
    const knownStatus = new Set<string>([...TXN_STATUSES_BEFORE, ...TXN_STATUSES_ACTIVE, ...TXN_STATUSES_AFTER])
    const unknown = (txns ?? [])
      .map((r) => (r as { status: string | null }).status)
      .filter((s): s is string => !!s && !knownStatus.has(s))
    check(`live: every transactions.status on real rows is classified${unknown.length ? ` (saw ${[...new Set(unknown)].join(",")})` : ""}`,
      unknown.length === 0)
  }

  // ── The schema fact the whole lead-side suppression decision rests on ──────
  // A raw lead cannot be in a live deal because neither deal table can reference
  // one. This is asserted by ASKING for the column: PostgREST answers a missing
  // column with an error (42703), so absence is provable here and — unlike a row
  // count — an EMPTY table is not a false pass. If a migration ever adds
  // listings.lead_id or transactions.lead_id, this goes red and isLeadInLiveDeal
  // must learn to query it directly instead of only resolving leads.contact_id.
  console.log("\n[live · no deal table can reference a lead — the basis for resolving via contact_id]")
  for (const table of ["listings", "transactions"] as const) {
    const { error } = await svc.from(table).select("lead_id").limit(1)
    check(`live: ${table} has NO lead_id column (suppression must resolve leads.contact_id)`,
      !!error)
  }
  // ...and the bridge that DOES exist is still there.
  const { error: bridgeErr } = await svc.from("leads").select("id, contact_id").limit(1)
  check("live: leads.contact_id (the only bridge to the deal tables) still exists", !bridgeErr)

  // The lead lane writes lead_id rows; the drain selects on both columns.
  const { error: queueErr } = await svc
    .from("lead_enrichment_queue").select("id, lead_id, contact_id, brokerage_id").limit(1)
  check("live: lead_enrichment_queue still carries BOTH lead_id and contact_id", !queueErr)
}

// ═══════════════════════════════════════════════════════════════════════════
// FREE OSINT SELECTION (wave 5) — owner: "there is a free osint selection".
//
// The enrichment lane must be able to run a FREE OSINT option, not only the paid
// one — WITHOUT ever letting free place-keyed data close a person-keyed row as a
// success. These checks pin both halves: the selection is real, and its boundary
// is enforced.
// ═══════════════════════════════════════════════════════════════════════════
function freeOsintLaneLayer() {
  const LANE = "lib/external/osint-free.ts"
  const drain = code(DRAIN)
  const lane = code(LANE)

  console.log("\n[pure · the lane router routes BY QUESTION, not by vendor preference]")
  const addr = { address: "1 Main St", city: "Austin", state: "TX", zip: "78701" }
  const skip = planEnrichmentLane({ enrichmentType: "skip_trace", input: addr, paidAllowed: true })
  check("skip_trace still REQUIRES the paid person lane", skip.paid.required && skip.paid.run)
  check("...and the free lane rides along at $0 rather than being skipped", skip.free.run)
  check("...and the row is stamped with BOTH lanes", skip.label === "osint_free+peopledata")

  const prop = planEnrichmentLane({ enrichmentType: "property_match", input: addr, paidAllowed: true })
  check("property_match is answered by the FREE lane", prop.free.run && prop.label === "osint_free")
  check("...and never escalates to the paid person provider", !prop.paid.required && !prop.paid.run)

  for (const t of ["phone_validation", "osint_profile"]) {
    const p = planEnrichmentLane({ enrichmentType: t, input: addr, paidAllowed: true })
    check(`${t} is person-keyed — the free lane is NOT offered for it`, !p.free.run && p.paid.required)
  }
  check("duplicate_check gets no external lane at all",
    planEnrichmentLane({ enrichmentType: "duplicate_check", input: addr, paidAllowed: true }).label === "none")
  check("an unknown enrichment_type is given NO lane (the CHECK should have stopped it)",
    planEnrichmentLane({ enrichmentType: "made_up", input: addr, paidAllowed: true }).label === "none")

  console.log("\n[pure · a withheld paid lane is never disguised as a completed enrichment]")
  const blocked = planEnrichmentLane({
    enrichmentType: "skip_trace", input: addr, paidAllowed: false, paidBlockedReason: "budget exhausted",
  })
  check("budget-blocked skip_trace still reports the paid lane as REQUIRED", blocked.paid.required)
  check("...but not RUN", !blocked.paid.run)
  check("...and says why", /WITHHELD/.test(blocked.paid.reason))
  const noAddr = planEnrichmentLane({ enrichmentType: "property_match", input: {}, paidAllowed: true })
  check("a record with no address parts gets no free lane either (no fabricated coverage)",
    !noAddr.free.run && noAddr.label === "none")

  console.log("\n[pure · free is priced at ZERO, so metering it cannot inflate the budget ledger]")
  check("VENDOR_PRICING carries an osint_free row", !!VENDOR_PRICING["osint_free"])
  check("...rated at exactly $0", normalizeVendorCost("osint_free", 7) === 0)
  check("the paid key the drain meters MATCHES the pricing table (not the $0.01 unknown-vendor fallback)",
    normalizeVendorCost("peopledata", 1) === 0.10)

  console.log("\n[source · the drain actually SELECTS the free lane, before spending]")
  check("the drain imports the lane router", /planEnrichmentLane/.test(drain))
  check("...and executes the free lane", /runFreeOsintLane\(/.test(drain))
  // Order matters more than proximity here: the budget must be read, then the
  // lane planned, and only then may money be spent. Asserted by INDEX so the
  // (long) free-lane block between them cannot break the check.
  const iBudget = drain.indexOf("checkVendorBudget")
  const iPlan = drain.indexOf("planEnrichmentLane({")
  const iSpend = drain.indexOf("skipTraceWithPeopleData({")
  check("...pre-flighting the house budget gate BEFORE the paid call",
    iBudget > -1 && iPlan > iBudget && iSpend > iPlan)
  check("...importing the server-only budget gate DYNAMICALLY (plain-tsx guards import this module)",
    /await import\(['"]@\/lib\/vendor-governance\/budget-gate['"]\)/.test(drain))
  check("the free lane is metered as vendor 'osint_free'", /vendor:\s*'osint_free'/.test(drain))
  check("...and the paid lane with the LOWERCASE pricing key", /vendor:\s*'peopledata'/.test(drain))
  check("...the capitalised 'PeopleData' key (which no pricing row matched) is gone",
    !/vendor:\s*'PeopleData'/.test(drain))

  console.log("\n[source · every result says which lane produced it]")
  check("the queue result carries a lane stamp", /lane:\s*plan\.label/.test(drain))
  check("leads.enrichment_provider records the lane, not a hardcoded vendor",
    /enrichment_provider:\s*plan\.label/.test(drain))
  check("a budget-withheld row is marked withheld, NOT completed",
    /person_enrichment:\s*'withheld_budget'/.test(drain) && /status:\s*'skipped'/.test(drain))
  check("a free-only row states the person lane was not applicable",
    /person_enrichment:\s*'not_applicable'/.test(drain))
  check("a no-match paid row states no_match even when free data landed",
    /person_enrichment:\s*'no_match'/.test(drain))
  check("free facts stay in their own namespaced block, never merged into person fields",
    /osint_free:\s*freeBlock/.test(drain) && /area_median_home_value_zip/.test(drain))

  console.log("\n[source · a keyless provider being DOWN is not a finding about the record]")
  const probe = code("lib/external/free-probe.ts")
  check("the probe primitive distinguishes unreachable from no_data",
    /"unreachable"/.test(probe) && /"no_data"/.test(probe))
  check("...and not_attempted from both", /"not_attempted"/.test(probe))
  check("...and the lane branches on unreachable when summarising availability",
    /outcome === "unreachable"/.test(lane))
  check("each free module reports through the probe primitive rather than swallowing to null",
    ["lib/external/nominatim-geocode.ts", "lib/external/census-appreciation.ts", "lib/external/osint-neighborhood.ts"]
      .every((f) => /gatewayProbe/.test(code(f))))
  check("the drain retries a free-only row whose providers were unreachable",
    /provider_unavailable/.test(drain))
  check("the boundary is written down — the free lane is NOT a cheap skip trace",
    /PAID_ONLY_ANSWERS/.test(lane) && /NOT A CHEAP/.test(src(LANE)) && /person_court_records/.test(lane))

  console.log("\n[source · no decommissioned provider was resurrected]")
  const posture = code("lib/platform/provider-posture.ts")
  check("vapi and heygen are still excluded from the derived registry",
    /DECOMMISSIONED_PROVIDERS\s*=\s*new Set<string>\(\["vapi",\s*"heygen"\]\)/.test(posture))
  check("osint_free is still the keyless posture row the lane binds to",
    /KEYLESS_PROVIDERS[\s\S]{0,200}?osint_free/.test(posture) && /runFreeOsintLane/.test(posture))
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" ENRICHMENT SUPPRESSION — not during a live deal; just before or after")
  console.log("══════════════════════════════════════════════════════════════════════")
  pureLayer()
  sourceLayer()
  freeOsintLaneLayer()
  await liveLayer()
  console.log(`\n${"═".repeat(70)}`)
  console.log(`ENRICHMENT SUPPRESSION — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of fails) console.log(`  · ${f}`)
    console.log("\nToo narrow and paid lookups fire at a client mid-closing.")
    console.log("Too broad and the contact is never enriched again after their")
    console.log("first deal — which looks exactly like 'no data yet', forever.")
    process.exit(1)
  }
  console.log("✅ ENRICHMENT_SUPPRESSION_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
