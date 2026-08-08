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
import { readFileSync } from "node:fs"
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
} from "../lib/enrichment/deal-vocabulary"
import { hasUsableIdentifier } from "../lib/enrichment/identifier-guard"
import { TERMINAL_TXN_STATUSES } from "../lib/transactions/closing-overdue-policy"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
/** Strip comments so no assertion can be satisfied by prose describing the fix. */
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const SUPPRESSION = "lib/enrichment/deal-suppression.ts"
const CORE        = "lib/enrichment/contact-enrichment-core.ts"
const ACTION      = "app/actions/contact-enrichment.ts"
const CRON        = "app/api/cron/contact-enrichment/route.ts"
const DRAIN       = "lib/lead-pipeline/enrichment-orchestrator.ts"
const REACTOR     = "lib/kernel/event-reactor.ts"

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
  check("lib/ghl-integration.ts's un-drainable copy (no brokerage_id) is gone",
    !code("lib/ghl-integration.ts").includes("lead_enrichment_queue"))
  check("the survivor requires the tenant rather than writing an un-drainable row",
    /queueContactEnrichment[\s\S]{0,900}?if\s*\(!contactId\s*\|\|\s*!brokerageId\)/.test(core))

  console.log("\n[source · the life-change type is one the column admits]")
  check("the re-check queues 'osint_profile', not an invented literal",
    core.includes('enrichment_type: "osint_profile"') && !core.includes('"life_change"'))
  check("...and the drain routes that type to the OSINT-only checker",
    /enrichment_type\s*===\s*'osint_profile'[\s\S]{0,400}?runLifeChangeCheck/.test(code(DRAIN)))
  check("'osint_profile' is in the settled enrichment_type vocabulary",
    (CHECK_VOCABULARIES.lead_enrichment_queue?.enrichment_type ?? []).includes("osint_profile"))
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
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" ENRICHMENT SUPPRESSION — not during a live deal; just before or after")
  console.log("══════════════════════════════════════════════════════════════════════")
  pureLayer()
  sourceLayer()
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
