/**
 * scripts/acquisition-door-guard.ts — ONE RAWDATA ACQUISITION DOOR (wave 151, lane 151C).
 *
 * Owner, verbatim: "lead acquisitions should be checking how old the activity is because you don't want to bring in old
 * and stale data. raw leads and providers should follow an if then so if a provider is hooked up from platform, the
 * provider will pull in raw leads from scrapers and/or a list provider and you set it up way too strict which could
 * possibly block providers completely … if at all possible check the formula before deciding to pull in a lead, not just
 * that they are coming from a list."
 *
 *   A  FRESHNESS per signal type (lib/lead-pipeline/freshness.ts): a week-old moving post is fresh; a seven-year-old
 *      article is stale; an old deed is property HISTORY (held for intent, kept as evidence); an owner record ages from
 *      its verification, not the deed; contradiction / TTL hold; undated kept at 0.5; one window with the OSINT filing rule.
 *   B  THE IF / THEN DOOR (source-discovery-planner.ts resolveSourceDoor / paidPullApproval): a configured, licensed
 *      platform provider within budget is NOT blocked for want of a plan line (the L6.7 over-restriction, re-asserted);
 *      an unconfigured provider is refused honestly by NAME; pending-rights / closed-doors / no-budget / platform-pool
 *      each refuse with their own reason; the approved plan still wins first; the keyless public source is free; the
 *      tenant door opens only connected + healthy + authorized; a value hold closes an open door.
 *   C  THE REAL POOLED PULL rides the door: without a plan line, a configured BatchData connection within budget pulls
 *      (the wave-150 refusal is gone) and an unconfigured one issues ZERO paid requests.
 *   D  STALE IS HELD, NEVER BOUGHT: the producer counts a stale post per rule and writes an old deed as held history
 *      (evidence.freshness); the pipeline holds before enrichment (stripped source: the gate sits before
 *      enrichWithPeopleData); a replay re-verifies (last_verified_at); the planner holds a line the value formula holds and
 *      approvePlanLines refuses it.
 *   E  DUPLICATES ARE NOT RE-BOUGHT (pre-pull-dedup.ts): a known source id / known person / fresh prior provider answer is
 *      skipped; two owners of ONE property stay TWO people (property key = relation, never a merge); a property lookup
 *      on a known property is skipped; no identity is fabricated; the aggregate preview is a count, not contacts.
 *   F  THE PRE-PULL VALUE FORMULA (pre-pull-value.ts): monotone in every factor; an unknown price refuses a paid pull;
 *      budget binds; the disclaimer rides every verdict; never a probability; measured outcomes drive the yield.
 *   G  STAGE CONTRACT (stripped source): the cron and the producer write no leads / contacts; processRawRecord is the one
 *      promotion caller through the canonical gate; captureContact never routes through the producer; the cron names its
 *      door and its default budget literal equals the door's default; only leads_promoted counts Leads; one
 *      enrichment_status spelling in lib/lead-pipeline (+ the honest 'partial'), the readers' word.
 *
 * Positive controls: every absence scan runs its finder on a planted specimen; the unconfigured-provider refusal is paired
 * with the configured-provider admission on the SAME inputs; the pooled lane's zero is paired with a run that requests.
 *
 * BLIND SPOTS (published): the in-memory client models the m961 UNIQUE but not a CHECK violation (the pre-m967 'held_stale'
 * fallback path is asserted from stripped source, not exercised); the tenant door is exercised with FACTS (no acquisition
 * vendor is tenant-connectable today, so production passes none); env presence is injected (`env`), never the real one;
 * the value weights are configuration, unvalidated by construction.
 */
import { readFileSync } from "fs"
import { join } from "path"
import { createRequire } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"

const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* not installed */ }

const ROOT = process.cwd()
let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const stripped = (p: string) => stripComments(read(p))
const DAY = 86_400_000
const NOW = new Date("2026-11-09T12:00:00Z")
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString()

async function main() {
  const fr = await import("../lib/lead-pipeline/freshness")
  const pl = await import("../lib/lead-pipeline/source-discovery-planner")
  const pp = await import("../lib/lead-pipeline/pooled-pull")
  const pv = await import("../lib/lead-pipeline/pre-pull-value")
  const pd = await import("../lib/lead-pipeline/pre-pull-dedup")
  const ps = await import("../lib/lead-pipeline/processing-status")
  const er = await import("../lib/lead-pipeline/enrichment-retry")
  const fm = await import("../lib/lead-pipeline/fuzzy-matcher")
  const sid = await import("../lib/identity/subject-identity")
  const { ingestRawSourceBatch } = await import("../lib/kernel/scraping")
  const T1 = "11111111-1111-4111-8111-111111111111"
  const T2 = "22222222-2222-4222-8222-222222222222"
  const MARKET = "33333333-3333-4333-8333-333333333333"

  console.log("\n[A] freshness per signal type")
  const post = fr.evaluateFreshness({ source: "reddit_relocation", signalAt: ago(7), observedAt: ago(0), now: NOW })
  check("a social post about moving LAST WEEK is fresh (expressed_intent_post, anchored on its own date)", post.verdict === "fresh" && post.signalClass === "expressed_intent_post" && post.anchor === "signal_at" && !post.hold, `${post.verdict}/${post.signalClass}`)
  const article = fr.evaluateFreshness({ source: "exa_buyer_intent", subjectKind: "market", signalAt: ago(7 * 365), observedAt: ago(0), now: NOW })
  check("a SEVEN-YEAR-OLD article is stale — held, never bought", article.verdict === "stale" && article.hold && article.signalClass === "market_article" && article.score === 0, `${article.verdict}`)
  const deed = fr.evaluateFreshness({ source: "osint_signal", intentSignals: ["deed_transfer"], signalAt: ago(3 * 365), observedAt: ago(0), now: NOW })
  check("an OLD DEED is property HISTORY, not a fresh intention (held for intent spend, kept as evidence)", deed.verdict === "history" && deed.hold && deed.propertyHistory && !deed.intentFresh && deed.signalClass === "ownership_transfer", `${deed.verdict}/${deed.signalClass}`)
  const freshDeed = fr.evaluateFreshness({ source: "osint_signal", intentSignals: ["deed_transfer"], signalAt: ago(20), observedAt: ago(0), now: NOW })
  check("POSITIVE CONTROL: a deed recorded three weeks ago is fresh under the same policy", freshDeed.verdict === "fresh" && !freshDeed.hold)
  const owner = fr.evaluateFreshness({ source: "batchdata_motivated", intentSignals: ["high_equity", "senior_owner"], signalAt: null, observedAt: ago(10), lastVerifiedAt: ago(3), now: NOW })
  check("an OWNER RECORD ages from its verification (last_verified_at), never from the deed — long tenure is the signal", owner.signalClass === "owner_profile_pull" && owner.anchor === "last_verified_at" && owner.verdict === "fresh" && owner.ageDays !== null && owner.ageDays < 4)
  const staleOwner = fr.evaluateFreshness({ source: "batchdata_motivated", signalAt: null, observedAt: ago(400), now: NOW })
  check("…and an owner record not re-verified for 400 days is stale (re-verify before any spend)", staleOwner.verdict === "stale" && staleOwner.hold)
  const filing = fr.evaluateFreshness({ source: "batchdata_motivated", intentSignals: ["pre_foreclosure"], signalAt: ago(75), observedAt: ago(0), now: NOW })
  check("a pre-foreclosure FILING on a vendor pull is judged as a filing (stale past 60 days — 'already worked')", filing.signalClass === "public_record_filing" && filing.verdict === "stale" && filing.hold)
  check("the filing window agrees with the OSINT sourcer's constant (one vocabulary)", (() => { const m = /OSINT_FILING_MAX_AGE_DAYS = (\d+)/.exec(stripped("lib/lead-pipeline/osint-sourcer.ts")); return !!m && fr.FRESHNESS_POLICIES.public_record_filing.staleDays === Number(m[1]) })())
  const expiredTtl = fr.evaluateFreshness({ source: "reddit_relocation", signalAt: ago(3), observedAt: ago(3), ttlExpiresAt: ago(1), now: NOW })
  check("a lapsed TTL holds even a young signal (re-observe before any spend)", expiredTtl.hold && /TTL/.test(expiredTtl.holdReason ?? ""))
  const contradicted = fr.evaluateFreshness({ source: "reddit_relocation", signalAt: ago(5), observedAt: ago(5), contradictedAt: ago(1), now: NOW })
  check("newer contradictory evidence outranks a fresh signal (contradicted, held)", contradicted.verdict === "contradicted" && contradicted.hold)
  const over = fr.evaluateFreshness({ source: "zenrows_zillow", signalAt: ago(10), observedAt: ago(10), stillActive: false, now: NOW })
  check("an event known to be over is contradicted whatever its age", over.verdict === "contradicted" && over.hold)
  const undated = fr.evaluateFreshness({ source: "facebook_group", signalAt: null, observedAt: null, now: NOW })
  check("an UNDATED post is kept at 0.5 (the wave-91 rule), not held", undated.verdict === "undated" && undated.score === 0.5 && !undated.hold)
  const narrowed = fr.evaluateFreshness({ source: "reddit_relocation", signalAt: ago(45), observedAt: ago(0), sourceWindowDays: 30, now: NOW })
  check("a NARROWER per-source window still narrows the policy (45 days old, 30-day window → stale)", narrowed.verdict === "stale")
  const outside = fr.evaluateFreshness({ source: "reddit_relocation", signalAt: ago(2), observedAt: ago(0), territoryRelevant: false, now: NOW })
  check("territory relevance weighs the score (×0.5) but never decides the hold — the territory gate owns refusal", !outside.hold && outside.score <= 0.5 && /territory gate/.test(outside.why))
  check("every policy anchors on the date that counts (events on signal_at, pulled populations on last_verified_at)", fr.FRESHNESS_POLICIES.expressed_intent_post.anchor === "signal_at" && fr.FRESHNESS_POLICIES.owner_profile_pull.anchor === "last_verified_at" && fr.FRESHNESS_POLICIES.investor_population.anchor === "last_verified_at" && fr.FRESHNESS_POLICIES.ownership_transfer.beyondStale === "history")
  check("the m967 CHECK vocabulary equals FRESHNESS_VERDICTS (one vocabulary)", (() => {
    const sql = read("supabase/migrations/m967-rawdata-freshness-verdict-and-held-stale.sql")
    const m = /raw_scraped_leads_freshness_verdict_check CHECK \(freshness_verdict IN \(([^)]*)\)/.exec(sql)
    const words = (m?.[1] ?? "").match(/'([a-z_]+)'/g)?.map((w) => w.slice(1, -1)) ?? []
    return words.length === fr.FRESHNESS_VERDICTS.length && fr.FRESHNESS_VERDICTS.every((w) => words.includes(w))
  })())
  check("the m967 processing_status CHECK equals RAW_PROCESSING_STATUSES (held_stale included, nothing dropped)", (() => {
    const sql = read("supabase/migrations/m967-rawdata-freshness-verdict-and-held-stale.sql")
    const m = /raw_scraped_leads_processing_status_check CHECK \(processing_status IN \(([^)]*)\)/.exec(sql)
    const words = (m?.[1] ?? "").match(/'([a-z_]+)'/g)?.map((w) => w.slice(1, -1)) ?? []
    return words.length === ps.RAW_PROCESSING_STATUSES.length && ps.RAW_PROCESSING_STATUSES.every((w) => words.includes(w)) && (ps.REJECTION_STATUSES as readonly string[]).includes("held_stale")
  })())
  check("m967 line 1 carries the lane stamp", read("supabase/migrations/m967-rawdata-freshness-verdict-and-held-stale.sql").split("\n")[0] === "-- WRITTEN, NOT APPLIED (wave 151, lane 151C) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL")

  console.log("\n[B] the IF / THEN door")
  const noPlans: never[] = []
  const bd = (over: Partial<import("../lib/lead-pipeline/source-discovery-planner").PlatformProviderDoor> = {}) => ({ vendor: "batchdata", configured: true, credentialNames: ["BATCHDATA_API_KEY"], activation: "dormant_survivor" as const, survivorDoors: "owner_confirmation_pending" as const, monthlyBudgetUsd: 100, remainingBudgetUsd: 60, ...over })
  const open = pl.resolveSourceDoor({ source: "batchdata_motivated", brokerageId: T1, plans: noPlans, platform: bd(), now: NOW })
  check("IF a platform-connected, licensed provider is configured within budget → NOT blocked for want of a plan line (the L6.7 over-restriction, re-asserted)", open.allowed && open.door === "platform_provider" && open.maxSpendUsd === 100 && open.approvedAt === "2026-11-01T00:00:00.000Z", JSON.stringify({ door: open.door, reason: open.reason }))
  check("…the trail says the plan door was tried first and why it closed", open.tried.length === 1 && /approved plan/.test(open.tried[0]))
  const dark = pl.resolveSourceDoor({ source: "batchdata_motivated", brokerageId: T1, plans: noPlans, platform: bd({ configured: false }), now: NOW })
  check("POSITIVE CONTROL: the SAME inputs with the credential absent → a REAL unavailable, naming the credential by NAME (never a value)", !dark.allowed && dark.door === "unavailable" && /BATCHDATA_API_KEY absent by name/.test(dark.reason) && !/sk-|key=/.test(dark.reason), dark.reason)
  const pending = pl.resolveSourceDoor({ source: "batchdata_motivated", brokerageId: T1, plans: noPlans, platform: bd({ activation: "dormant_pending_rights" }), now: NOW })
  check("a dormant-pending-rights provider is refused even when a key is present (R9)", !pending.allowed && /pending rights/.test(pending.reason))
  const closed = pl.resolveSourceDoor({ source: "batchdata_motivated", brokerageId: T1, plans: noPlans, platform: bd({ survivorDoors: "closed" }), now: NOW })
  check("a survivor whose live doors the owner closed is refused (L6.5)", !closed.allowed && /closed the survivor/.test(closed.reason))
  const spent = pl.resolveSourceDoor({ source: "batchdata_motivated", brokerageId: T1, plans: noPlans, platform: bd({ remainingBudgetUsd: 0 }), now: NOW })
  check("a spent territory budget refuses the platform door (within budget means within budget)", !spent.allowed && /budget is spent/.test(spent.reason))
  const noCeiling = pl.resolveSourceDoor({ source: "batchdata_motivated", brokerageId: T1, plans: noPlans, platform: bd({ monthlyBudgetUsd: null, remainingBudgetUsd: null }), now: NOW })
  check("no known budget ceiling refuses (a paid pull needs a ceiling — fail closed)", !noCeiling.allowed && /needs a ceiling/.test(noCeiling.reason))
  const pool = pl.resolveSourceDoor({ source: "batchdata_motivated", brokerageId: null, plans: noPlans, platform: bd(), now: NOW })
  check("a platform-pool territory (no tenant) is refused with the owner decision named (L6.7)", !pool.allowed && /L6\.7/.test(pool.reason))
  const approvedRow = { id: "plan-1", brokerage_id: T1, status: "approved", valid_until: ago(-30), lines: [{ source: "batchdata_motivated", status: "approved", approvedAt: ago(2), maxSpendUsd: 20 }] }
  const planned = pl.resolveSourceDoor({ source: "batchdata_motivated", brokerageId: T1, plans: [approvedRow], platform: bd(), now: NOW })
  check("an approved plan line still wins FIRST (its own ceiling and approval date)", planned.allowed && planned.door === "approved_plan" && planned.maxSpendUsd === 20 && planned.planId === "plan-1")
  const scraper = pl.resolveSourceDoor({ source: "exa_buyer_intent", brokerageId: T1, plans: noPlans, platform: { vendor: "exa", configured: true, credentialNames: ["EXA_API_KEY"], activation: "active", monthlyBudgetUsd: 100, remainingBudgetUsd: 100 }, now: NOW })
  check("a platform-connected research / scraper lane (public_web, named terms) opens the same way", scraper.allowed && scraper.door === "platform_provider" && /public_web/.test(scraper.reason))
  const tenantOpen = pl.resolveSourceDoor({ source: "batchdata_motivated", brokerageId: T1, plans: noPlans, platform: bd({ configured: false }), tenant: { vendor: "batchdata", status: "connected", healthy: true, authorized: true }, now: NOW })
  check("ELSE IF a tenant-owned connection is connected + healthy + authorized → the tenant door", tenantOpen.allowed && tenantOpen.door === "tenant_provider")
  const tenantUnauth = pl.resolveSourceDoor({ source: "batchdata_motivated", brokerageId: T1, plans: noPlans, platform: bd({ configured: false }), tenant: { vendor: "batchdata", status: "connected", healthy: true, authorized: false }, now: NOW })
  check("…connected but not authorized for acquisition is refused, said so", !tenantUnauth.allowed && /not authorized/.test(tenantUnauth.reason))
  const tenantUnreadable = pl.resolveSourceDoor({ source: "batchdata_motivated", brokerageId: T1, plans: noPlans, platform: bd({ configured: false }), tenant: { vendor: "batchdata", status: "unreadable", healthy: false, authorized: false }, now: NOW })
  check("…an unreadable connection store is refused, never substituted", !tenantUnreadable.allowed && /could not be read/.test(tenantUnreadable.reason))
  const osint = pl.resolveSourceDoor({ source: "osint_signal", brokerageId: T1, plans: noPlans, now: NOW })
  check("ELSE a permissible keyless public source is free (no vendor cost)", osint.allowed && osint.door === "public_source" && osint.maxSpendUsd === 0 && !osint.paid)
  const firstParty = pl.resolveSourceDoor({ source: "site_visitor_intent", brokerageId: T1, plans: noPlans, now: NOW })
  check("first-party data needs no door at all", firstParty.allowed && firstParty.door === "first_party")
  const unknownRights = pl.resolveSourceDoor({ source: "mystery_feed", brokerageId: T1, plans: noPlans, platform: bd(), now: NOW })
  check("a source no vendor contract names is unavailable (rights never guessed)", !unknownRights.allowed && /never guessed/.test(unknownRights.reason))
  const heldValue = pl.resolveSourceDoor({ source: "batchdata_motivated", brokerageId: T1, plans: noPlans, platform: bd(), value: { ...pv.evaluatePrePullValue({ factors: { territoryMatch: 1, freshness: 0.01, sourceReliability: 0.01, expectedNewUsableFields: 0.01, identityMatchLikelihood: 0.01, usefulOpportunityFactor: 0.01 }, cost: { recordCount: 100, providerUnitUsd: 0.05, paid: true } }) }, now: NOW })
  check("a pre-pull value HOLD closes an otherwise open platform door", !heldValue.allowed && heldValue.door === "platform_provider" && /value formula holds/.test(heldValue.reason))
  check("paidPullApproval without a door context is the wave-150 rule unchanged (plans only → refused without a line)", !pl.paidPullApproval(noPlans, { brokerageId: T1, source: "batchdata_motivated" }, NOW).allowed)
  check("paidPullApproval WITH the door context admits the configured platform provider and carries its ceiling", (() => { const v = pl.paidPullApproval(noPlans, { brokerageId: T1, source: "batchdata_motivated" }, NOW, { platform: bd() }); return v.allowed && v.door === "platform_provider" && v.maxSpendUsd === 100 })())
  // The production facts loader — env is INJECTED (never the real one), activation stated.
  const factsOn = await pp.platformProviderDoorFacts("batchdata", { env: { BATCHDATA_API_KEY: "present" }, activation: { batchdata: { state: "dormant_survivor", survivorDoors: "owner_confirmation_pending" } } })
  const factsOff = await pp.platformProviderDoorFacts("batchdata", { env: {}, activation: { batchdata: { state: "dormant_survivor" } } })
  check("the facts loader reads presence by NAME (on / off) and never carries a value", factsOn.configured && !factsOff.configured && factsOn.credentialNames.includes("BATCHDATA_API_KEY") && !JSON.stringify(factsOn).includes("present"))
  const apify = await pp.platformProviderDoorFacts("apify", { env: { APIFY_API_TOKEN: "x" }, activation: {} })
  check("a scraper-fleet vendor resolves its own credential name (not the whole fleet's) and reads as a live platform lane", apify.configured && apify.credentialNames.join() === "APIFY_API_TOKEN" && apify.activation === "scraper_fleet")
  const { PROVIDER_TENANCY } = await import("../lib/providers/tenancy-matrix")
  const fleet = PROVIDER_TENANCY.find((p) => p.provider === "scrapers")!.envVars
  check("every scraper-fleet credential name is one the tenancy matrix declares (one registry)", ["apify", "zenrows", "zyte"].every((v) => pp.platformCredentialNames(v).every((n) => fleet.includes(n))))
  const withBudget = pp.withTerritoryBudget(factsOn, { monthly_budget_usd: null, spend_this_month: 30 })
  const defaultBudget = pp.withTerritoryBudget(factsOn, { monthly_budget_usd: null, spend_this_month: 0 })!.monthlyBudgetUsd
  check("a territory naming no budget runs on the cron's default ceiling ($100) minus its spend", defaultBudget === 100 && withBudget?.monthlyBudgetUsd === 100 && withBudget?.remainingBudgetUsd === 70)

  console.log("\n[C] the real pooled pull rides the door")
  const calls: Array<{ zips: string[] }> = []
  const deps = (approval: (b: string | null, lane: string, t?: any) => any) => ({
    search: async (opts: any) => { calls.push({ zips: opts.searchCriteria?.address?.zip?.inList ?? [] }); return { records: [], cost: 0 } },
    dateWindow: () => ({}), statusWindow: () => true,
    geographyCriteria: (_k: any, v: readonly string[]) => ({ address: { zip: { inList: [...v] } } }),
    maxTake: 500, maxInList: 100, approval,
  }) as any
  const wants = [{ territory: { id: "terr-A", brokerage_id: T1, state: "FL", zip_codes: ["32501"], monthly_budget_usd: 100, spend_this_month: 10 }, triggers: ["high_equity"], lookbackDays: null }]
  calls.length = 0
  const rOn = await pp.runPooledBatchDataLane("batchdata_motivated", wants as any, deps((b, lane, t) => pl.paidPullApproval(noPlans, { brokerageId: b, source: lane }, NOW, { platform: pp.withTerritoryBudget(factsOn, t) })))
  check("NO plan line, configured BatchData within budget → the territory IS pulled (the wave-150 refusal is gone)", calls.some((c) => c.zips.includes("32501")) && rOn.ledger.unapprovedTerritories === 0, JSON.stringify(rOn.errors))
  calls.length = 0
  const rOff = await pp.runPooledBatchDataLane("batchdata_motivated", wants as any, deps((b, lane, t) => pl.paidPullApproval(noPlans, { brokerageId: b, source: lane }, NOW, { platform: pp.withTerritoryBudget(factsOff, t) })))
  check("POSITIVE CONTROL: the SAME want with the credential absent → ZERO paid requests, the reason named per territory", calls.length === 0 && rOff.ledger.unapprovedTerritories === 1 && rOff.errors.some((e) => /terr-A not pulled — provider unavailable/.test(e)), JSON.stringify(rOff.errors))
  const ppSrc = stripped("lib/lead-pipeline/pooled-pull.ts")
  check("production deps open the door with the platform facts + the territory's budget (read once per cycle)", /const platformDoor = await platformProviderDoorFacts\("batchdata"\)/.test(ppSrc) && /paidPullApproval\(plans, \{ brokerageId, source: lane \}, new Date\(\), \{ platform: withTerritoryBudget\(platformDoor, territory \?\? null\) \}\)/.test(ppSrc) && /deps\.approval\(w\.territory\.brokerage_id, lane, w\.territory\)/.test(ppSrc))

  console.log("\n[D] stale is held, never bought")
  const geo = { city: "Pensacola", state: "FL", zip_codes: ["32501"] }
  const rec = (over: Record<string, unknown>) => ({
    sourceRecordId: "reddit-t3_x", source: "reddit_relocation", behaviorType: "social_intent", intentType: "buyer", intentSignals: ["moving to"],
    firstName: "Dana", lastName: "Whitfield", email: "dana.whitfield@example.org", city: "Pensacola", state: "FL", zip: "32501",
    sourceUrl: "https://www.reddit.com/r/Pensacola/comments/abc", rawPayload: { created_utc: Math.floor(Date.now() / 1000) - 7 * 86_400 }, ...over,
  }) as any
  const db = () => memSupabase({ raw_scraped_leads: [], scraper_executions: [], lifecycle_events: [] }, { unique: { raw_scraped_leads: [["idempotency_key"]] } })
  const dbF = db()
  const freshRun = await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "reddit_relocation", sourceFamily: "social_intent", sourceChannel: "reddit_relocation", records: [rec({})], executionId: "e", marketGeo: geo, client: dbF as any })
  const freshRow: any = dbF.tables.raw_scraped_leads[0]
  check("a week-old moving post is WRITTEN pending with its freshness evidence + verdict column + verification anchor", freshRun.inserted === 1 && freshRow?.processing_status === "pending" && freshRow?.freshness_verdict === "fresh" && freshRow?.evidence?.freshness?.signal_class === "expressed_intent_post" && !!freshRow?.last_verified_at)
  const dbS = db()
  // 7 years old: the wave-91 source window (60 days) cuts it first — counted under its rule; a 45-day-old post sneaks past
  // a 60-day window but a 14/60 policy reads it as aging (kept), so the policy's own cut is shown on a signal class with a
  // window the source does not narrow: a 100-day-old anonymous question through a channel with no source window.
  const staleRun = await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "reddit_relocation", sourceFamily: "social_intent", sourceChannel: "reddit_relocation", records: [rec({ sourceRecordId: "reddit-t3_old", rawPayload: { created_utc: Math.floor(Date.now() / 1000) - 7 * 365 * 86_400 } })], executionId: "e", marketGeo: geo, client: dbS as any, recencyDays: null })
  check("a seven-year-old post is NOT written — held by the policy, counted under its signal class (recencyDays null: the policy alone cut it)", staleRun.inserted === 0 && staleRun.skipped_stale === 1 && staleRun.skipped_stale_reasons.expressed_intent_post === 1 && dbS.tables.raw_scraped_leads.length === 0, JSON.stringify(staleRun.skipped_stale_reasons))
  const dbH = db()
  const deedRun = await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "osint_signal", sourceFamily: "public_record", sourceChannel: "osint_signal", records: [rec({ source: "osint_signal", sourceRecordId: "deed-1", behaviorType: "public_record", intentSignals: ["deed_transfer"], propertyAddress: "12 Palafox St", rawPayload: { filingDate: ago(3 * 365), date: ago(3 * 365) } })], executionId: "e", marketGeo: geo, client: dbH as any, recencyDays: null })
  const deedRow: any = dbH.tables.raw_scraped_leads[0]
  check("an OLD DEED is written as HELD HISTORY (processing_status held_stale, verdict history, the reason on the row) — evidence kept, never pending", deedRun.inserted === 1 && deedRun.held_history === 1 && deedRow?.processing_status === "held_stale" && deedRow?.freshness_verdict === "history" && /property history/.test(deedRow?.error_message ?? ""), JSON.stringify({ run: deedRun, row: deedRow && { s: deedRow.processing_status, v: deedRow.freshness_verdict } }))
  const dbR = db()
  await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "reddit_relocation", sourceFamily: "social_intent", sourceChannel: "reddit_relocation", records: [rec({})], executionId: "e", marketGeo: geo, client: dbR as any })
  const replay = await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "reddit_relocation", sourceFamily: "social_intent", sourceChannel: "reddit_relocation", records: [rec({})], executionId: "e", marketGeo: geo, client: dbR as any })
  check("a REPLAY re-verifies the held observation (last_verified_at bumped, counted) and stays ONE row", replay.replayed === 1 && replay.reverified === 1 && dbR.tables.raw_scraped_leads.length === 1 && dbR.writes.some((w) => w.table === "raw_scraped_leads" && w.op === "update" && "last_verified_at" in w.payload))
  const dbL = memSupabase({ raw_scraped_leads: [], scraper_executions: [], lifecycle_events: [] }, { missingColumns: { raw_scraped_leads: ["freshness_verdict", "last_verified_at"] } })
  const lag = await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "reddit_relocation", sourceFamily: "social_intent", sourceChannel: "reddit_relocation", records: [rec({})], executionId: "e", marketGeo: geo, client: dbL as any })
  check("m967 not applied → the row is still written, the verdict rides evidence.freshness, the lag is COUNTED (m961 columns kept)", lag.inserted === 1 && lag.freshness_columns_absent === 1 && lag.envelope_columns_absent === 0 && dbL.tables.raw_scraped_leads[0]?.evidence?.freshness?.verdict === "fresh" && dbL.tables.raw_scraped_leads[0]?.freshness_verdict === undefined && !!dbL.tables.raw_scraped_leads[0]?.idempotency_key, JSON.stringify(lag))
  const proc = stripped("lib/lead-pipeline/pipeline-processor.ts")
  const holdAt = proc.indexOf("setStatus(supabase, rawRecordId, 'held_stale'")
  const spendAt = proc.indexOf("await enrichWithPeopleData(")
  const subjectAt = proc.indexOf("subjectKindLeadProblem(subjectKind)")
  check("the pipeline HOLDS (held_stale + reason) AFTER the subject gate and BEFORE the paid enrichment", holdAt > 0 && spendAt > 0 && subjectAt > 0 && subjectAt < holdAt && holdAt < spendAt, `subject@${subjectAt} hold@${holdAt} spend@${spendAt}`)
  check("…reading the m961 / m967 anchors (signal_at, observed_at, last_verified_at, ttl_expires_at) through evaluateFreshness", /evaluateFreshness\(\{[\s\S]{0,600}lastVerifiedAt: rec\.last_verified_at/.test(proc) && /ttlExpiresAt: rec\.ttl_expires_at/.test(proc))
  check("the producer's pre-m967 fallbacks exist (freshness columns absent → evidence only; CHECK refuses held_stale → pending + the pipeline gate)", /isFreshnessColumnAbsent\(insertError\)/.test(stripped("lib/kernel/scraping.ts")) && /insertError\?\.code === '23514' && \/processing_status\/\.test/.test(stripped("lib/kernel/scraping.ts")))
  // The planner holds a line the value formula holds, and approval refuses it.
  const territory = { id: "m1", brokerageId: T1, label: "Pensacola, FL" }
  const thin = pl.planSourceDiscovery({ territory, budgetUsd: 100, enabledSources: ["batchdata_motivated"] as any, history: { batchdata_motivated: { rawRows: 400, promoted: 0, duplicates: 390, costUsd: 20, heldStale: 0 } }, previews: { batchdata_motivated: { count: 400, at: NOW.toISOString(), via: "own history" } }, quotes: { batchdata_motivated: { unitUsd: 0.05, basis: "catalogue" } }, now: NOW })
  const thinLine = thin.lines.find((l) => l.source === "batchdata_motivated")!
  check("a source whose history is 97% duplicates and 0 promotions is HELD by the value formula (never proposed)", thinLine.status === "held" && thinLine.value?.decision === "hold" && /value formula/.test(thinLine.why), `${thinLine.status}: ${thinLine.why}`)
  check("…and approvePlanLines refuses the held line (stale / low-value candidates are never purchased)", !pl.approvePlanLines(thin.lines, ["batchdata_motivated"], { userId: "u", mayCommitSpend: true }).ok)
  const healthy = pl.planSourceDiscovery({ territory, budgetUsd: 100, enabledSources: ["batchdata_motivated"] as any, history: { batchdata_motivated: { rawRows: 400, promoted: 40, duplicates: 30, costUsd: 20, heldStale: 0 } }, previews: { batchdata_motivated: { count: 400, at: NOW.toISOString(), via: "own history" } }, quotes: { batchdata_motivated: { unitUsd: 0.05, basis: "catalogue" } }, marketGap: { monthsOfSupply: 2.1 }, now: NOW })
  const healthyLine = healthy.lines.find((l) => l.source === "batchdata_motivated")!
  check("POSITIVE CONTROL: a healthy line (10% promoted) stays PROPOSED with its value, freshness and aggregate preview on it", healthyLine.status === "proposed" && healthyLine.value?.decision === "proceed" && healthyLine.freshness.factor > 0.9 && healthyLine.dedupPreview?.kind === "aggregate_preview" && healthyLine.dedupPreview.identityFabricated === false && healthyLine.value.expectedUsableRecords >= 30, JSON.stringify({ s: healthyLine.status, d: healthyLine.value?.decision, u: healthyLine.value?.expectedUsableRecords }))
  check("every plan publishes the formula's disclaimer as a blind spot", healthy.blindSpots.some((b) => /never a probability/.test(b)) && healthy.plannerVersion === "source-discovery@2")

  console.log("\n[E] duplicates are not re-bought; two owners of one property stay two people")
  const known: import("../lib/lead-pipeline/pre-pull-dedup").KnownAcquisitionKeys = {
    sourceRecordIds: new Set(["batchdata_motivated|bd-1"]),
    personKeys: new Set(["email:maria@lopez.org"]),
    propertyKeys: new Set([sid.subjectIdentityKeys({ propertyAddress: "12 Palafox St", zip: "32501" })[0]]),
    priorProviderResults: new Map([["phone:8505551111", { provider: "peopledata", at: ago(10) }], ["phone:8505552222", { provider: "peopledata", at: ago(200) }]]),
    scope: { brokerageId: T1, includesPlatformPool: true },
  }
  const plan = pd.planPrePullDedup([
    { ref: "known-id", source: "batchdata_motivated", sourceRecordId: "bd-1", email: "new@x.org" },
    { ref: "known-person", source: "batchdata_motivated", sourceRecordId: "bd-2", email: "MARIA@lopez.org" },
    { ref: "fresh-prior", source: "batchdata_motivated", sourceRecordId: "bd-3", phone: "(850) 555-1111" },
    { ref: "old-prior", source: "batchdata_motivated", sourceRecordId: "bd-4", phone: "(850) 555-2222" },
    { ref: "owner-two", source: "batchdata_motivated", sourceRecordId: "bd-5", propertyAddress: "12 palafox street", zip: "32501-1234", email: "robert@chen.org", lastName: "Chen" },
    { ref: "stale", source: "reddit_relocation", sourceRecordId: "r-9", email: "s@x.org", signalAt: ago(400) },
    { ref: "anon", source: "reddit_relocation", sourceRecordId: "" },
  ], known, { lookupKind: "person", now: NOW })
  const v = (ref: string) => plan.verdicts.find((x) => x.ref === ref)!
  check("a KNOWN SOURCE ID is never re-bought", v("known-id").action === "skip" && v("known-id").reason === "known_source_id")
  check("a KNOWN PERSON (case-blind email) is never re-bought", v("known-person").action === "skip" && v("known-person").reason === "known_person")
  check("a FRESH prior provider answer (10 days) is reused, not re-bought; a 200-day-old one is re-asked", v("fresh-prior").reason === "prior_provider_result_fresh" && v("old-prior").action === "buy")
  check("the SECOND OWNER of a known property is BOUGHT as a new person with a same_property RELATION (never merged into owner one)", v("owner-two").action === "buy" && v("owner-two").relations.some((r) => r.startsWith("same_property:")) && v("owner-two").reason === "new", JSON.stringify(v("owner-two")))
  check("a stale candidate is held (not bought) by its own freshness policy", v("stale").action === "skip" && v("stale").reason === "stale_candidate")
  check("a candidate with no identifier is bought as new and reported undeduplicable — no identity is fabricated", v("anon").action === "buy" && v("anon").reason === "undeduplicable")
  check("the overlap ratio and the judged-against set are published", plan.overlapRatio === Math.round((4 / 7) * 100) / 100 && plan.judgedAgainst.personKeys === 1 && plan.skipped === 4, String(plan.overlapRatio))
  const propPlan = pd.planPrePullDedup([{ ref: "p", source: "rentcast", propertyAddress: "12 Palafox St", zip: "32501" }], known, { lookupKind: "property", now: NOW })
  check("for a PROPERTY lookup the known property IS the duplicate (not re-bought)", propPlan.verdicts[0].action === "skip" && propPlan.verdicts[0].reason === "known_property")
  const m1 = fm.calculateFuzzyMatch({ first_name: "Maria", last_name: "Lopez", email: "maria@lopez.org" }, { first_name: "Robert", last_name: "Chen", email: "robert@chen.org" })
  check("the pipeline's confident-match rule never merges two different owners of one address (no strong identifier in common)", !fm.isConfidentMatch(m1))
  const hhKeys = sid.subjectIdentityKeys({ lastName: "Lopez", propertyAddress: "12 Palafox St", mailingAddress: "12 Palafox St", zip: "32501", email: "maria@lopez.org" })
  check("a household / property key is a DIFFERENT key from the person key (an owner with many properties is one person; a property with many owners is many)", hhKeys.some((k) => k.startsWith("hh:")) && hhKeys.some((k) => k.startsWith("email:")) && hhKeys.some((k) => k.startsWith("addr:")))
  const preview = pd.previewAggregateList({ source: "batchdata_motivated", count: 1200, unitUsd: 0.05, knownOverlapRatio: 0.25, freshness: { factor: 0.95, policy: "owner_profile_pull@fresh90/stale365" }, via: "provider count" })
  check("an aggregate-geography list gets a cost / count / freshness PREVIEW first — a count, never contacts", preview.estimatedCostUsd === 60 && preview.expectedNewRecords === 900 && preview.identityFabricated === false && /a count, not contacts/.test(preview.why))
  // The reader on the in-memory client: tenant-pinned, error read.
  const dbK = memSupabase({
    raw_scraped_leads: [{ id: "r1", brokerage_id: T1, market_id: MARKET, source: "batchdata_motivated", source_record_id: "bd-1", external_ids: { identity_keys: `${sid.subjectIdentityKeys({ propertyAddress: "12 Palafox St", zip: "32501" })[0]} email:held@x.org` } }],
    leads: [{ id: "l1", brokerage_id: T1, email: "lead@x.org", phone: null, enrichment_profile: { provider: "peopledata", age_range: "35-44" }, last_enriched_at: ago(3) }, { id: "l2", brokerage_id: T2, email: "other@tenant.org", phone: null, enrichment_profile: {}, last_enriched_at: null }],
    contacts: [{ id: "c1", brokerage_id: T1, email: "contact@x.org", phone: null, deleted_at: null }],
  })
  const loaded = await pd.loadKnownAcquisitionKeys(dbK as any, { brokerageId: T1, marketIds: [MARKET] }, { candidates: [
    { ref: "a", source: "batchdata_motivated", sourceRecordId: "bd-1", email: "lead@x.org" }, { ref: "b", source: "x", email: "contact@x.org" }, { ref: "c", source: "x", email: "other@tenant.org" }, { ref: "d", source: "x", propertyAddress: "12 Palafox St", zip: "32501" },
  ] })
  check("the reader loads this tenant's known source ids, persons (leads + contacts + raw keys), properties and the lead's REAL prior enrichment", !!loaded && loaded.sourceRecordIds.has("batchdata_motivated|bd-1") && loaded.personKeys.has("email:lead@x.org") && loaded.personKeys.has("email:contact@x.org") && loaded.personKeys.has("email:held@x.org") && loaded.propertyKeys.size === 1 && loaded.priorProviderResults.get("email:lead@x.org")?.provider === "peopledata")
  check("…and never another tenant's person", !!loaded && !loaded.personKeys.has("email:other@tenant.org"))
  const refused = await pd.loadKnownAcquisitionKeys(memSupabase({ raw_scraped_leads: [] }, { refuse: { raw_scraped_leads: "permission denied" } }) as any, { brokerageId: T1, marketIds: [MARKET] }, { candidates: [{ ref: "a", source: "x", sourceRecordId: "1" }] })
  check("a refused read returns null (the caller cannot dedup against a half-set — fail closed on spend)", refused === null)

  console.log("\n[F] the pre-pull value formula")
  const base = { factors: { territoryMatch: 1, freshness: 0.9, sourceReliability: 0.5, expectedNewUsableFields: 0.8, identityMatchLikelihood: 0.6, usefulOpportunityFactor: 0.7 }, cost: { recordCount: 400, providerUnitUsd: 0.05, paid: true }, budget: { authorizedUsd: 100 } }
  const v0 = pv.evaluatePrePullValue(base)
  check("a worthwhile pull proceeds with an itemized cost and an expected usable COUNT", v0.decision === "proceed" && v0.totalCostUsd === 20 && v0.expectedUsableRecords > 0 && v0.score > 0 && v0.score <= 1)
  const less = pv.evaluatePrePullValue({ ...base, factors: { ...base.factors, freshness: 0.3 } })
  check("the score is monotone in every factor (lower freshness → lower score)", less.score < v0.score)
  check("…and in overlap (more already held → lower score, fewer usable)", (() => { const o = pv.evaluatePrePullValue({ ...base, adjustments: { knownOverlapRatio: 0.5 } }); return o.score < v0.score && o.expectedUsableRecords < v0.expectedUsableRecords })())
  check("a ZERO factor kills the pull (the product semantics survive the normalization)", pv.evaluatePrePullValue({ ...base, factors: { ...base.factors, territoryMatch: 0 } }).score === 0)
  check("an unknown PRICE refuses a paid pull (never at an unknown price)", pv.evaluatePrePullValue({ ...base, cost: { recordCount: 400, providerUnitUsd: null, paid: true } }).decision === "refuse")
  check("a budget that funds nothing holds; one that funds part proceeds and says how many fit", pv.evaluatePrePullValue({ ...base, budget: { authorizedUsd: 0.01 } }).decision === "hold" && (() => { const p = pv.evaluatePrePullValue({ ...base, budget: { authorizedUsd: 5 } }); return p.decision === "proceed" && (p.affordableRecords ?? 0) > 0 && (p.affordableRecords ?? 999) < 400 })())
  check("high uncertainty on a costly pull (above the $25 preview threshold) → PREVIEW FIRST; the same uncertainty on a $20 pull proceeds", pv.evaluatePrePullValue({ ...base, cost: { recordCount: 1000, providerUnitUsd: 0.05, paid: true }, adjustments: { uncertainty: 0.7 } }).decision === "preview_first" && pv.evaluatePrePullValue({ ...base, adjustments: { uncertainty: 0.7 } }).decision === "proceed")
  check("the measured usable ratio drives the yield when history exists (identity × reliability only when it does not)", pv.evaluatePrePullValue({ ...base, adjustments: { observedUsableRatio: 0.1 } }).expectedUsableRecords === 36 && pv.evaluatePrePullValue({ ...base, adjustments: { observedUsableRatio: null } }).expectedUsableRecords === 108)
  check("unknown factors read as 0.5 and raise uncertainty, visibly", (() => { const u = pv.evaluatePrePullValue({ ...base, factors: { ...base.factors, sourceReliability: null, identityMatchLikelihood: null } }); return !u.factors.sourceReliability.known && u.factors.sourceReliability.value === 0.5 && u.uncertainty >= 0.3 && u.reasons.some((r) => /unknown/.test(r)) })())
  check("the disclaimer rides EVERY verdict and the calibration says unvalidated", [v0, less].every((x) => x.disclaimer === pv.PRE_PULL_VALUE_DISCLAIMER && x.calibration === "unvalidated") && /never a probability/.test(pv.PRE_PULL_VALUE_DISCLAIMER))
  const obs = pv.factorsFromObservedOutcomes({ rawRows: 400, promoted: 40, duplicates: 30 })
  // 400 rows / 40 promoted / 30 duplicates, k = MIN_SOURCE_SAMPLE (8), unknown 0.5: usable (40+4)/408 = 0.11, overlap 30/408 = 0.07, identity (70+4)/408 = 0.18.
  check("measured prior outcomes → observed factors (shrunk toward unknown on the sample), labelled territory_history", obs.basis === "territory_history" && obs.observedUsableRatio === 0.11 && obs.knownOverlapRatio === 0.07 && obs.identityMatchLikelihood === 0.18 && obs.identityMatchLikelihood! > obs.observedUsableRatio!)
  check("no history → every observed factor unknown (null), labelled no_history", pv.factorsFromObservedOutcomes(null).basis === "no_history" && pv.factorsFromObservedOutcomes({ rawRows: 0, promoted: 0, duplicates: 0 }).sourceReliability === null)
  check("the weights are CONFIGURATION (exponents) — doubling one reorders the score, nothing is learned in code", pv.evaluatePrePullValue(base, { ...pv.PRE_PULL_VALUE_CONFIG, weights: { ...pv.PRE_PULL_VALUE_CONFIG.weights, freshness: 3 } }).score !== v0.score)

  console.log("\n[G] stage contract — a pulled record is a Raw Lead, never a Lead (stripped source)")
  const cron = stripped("app/api/cron/lead-scraping/route.ts")
  const producer = stripped("lib/kernel/scraping.ts")
  const leadWriter = /from\(\s*['"](leads|contacts)['"]\s*\)\s*\.(insert|upsert)\(|createLead\(/
  check("POSITIVE CONTROL: the lead-writer finder sees a planted insert and a planted createLead()", leadWriter.test(`await svc.from('leads').insert({})`) && leadWriter.test("const l = await createLead(x)"))
  check("the cron writes NO leads / contacts (its one 'createLead' mention is a tombstone comment — stripped away)", !leadWriter.test(cron.replace(/\s+/g, " ")) && /createLead\(\)/.test(read("app/api/cron/lead-scraping/route.ts")))
  check("the producer writes NO leads / contacts", !leadWriter.test(producer.replace(/\s+/g, " ")))
  check("the cron's default territory budget literal equals the ONE default the door reads (monthly_budget_usd ?? 100 == withTerritoryBudget's default)", (cron.match(/monthly_budget_usd \?\? (\d+)/g) ?? []).length > 0 && (cron.match(/monthly_budget_usd \?\? (\d+)/g) ?? []).every((m) => Number(m.split("?? ")[1]) === defaultBudget))
  check("only leads_promoted counts Leads in the cron's result (the raw counters' rename is recorded Outside-lane — one-pull-guard pins the old names)", /leads_promoted/.test(cron) && /total_leads_created/.test(cron))
  check("the pipeline's promotion runs through the canonical gate with the subject kind (the ONE door to Lead)", /evaluateCanonicalLeadEligibility\(\{[\s\S]{0,400}subject_kind: subjectKind/.test(proc))
  check("the consented first-party door never routes through the producer (C8 captureContact)", !/ingestRawSourceBatch\(/.test(stripped("lib/contact-pipeline/contact-capture.ts")) && /export async function captureContact\(/.test(stripped("lib/contact-pipeline/contact-capture.ts")))
  check("the cron names its door explicitly (actor cron) and its paid tokens ask the door before enabledSources", /actor:\s*\{ type: "cron" \}/.test(cron) && cron.indexOf("resolveSourceDoor({") < cron.indexOf("const enabledSources = expandEnabledSources(configuredSources.filter((v) => !closedTokens.includes(v)))"))
  check("an alias of a pooled lane that runs its own per-territory pull (batchdata_incremental) asks the door (the wave-150 gate skipped it)", /PER_TERRITORY_ALIASES_OF_POOLED_LANES/.test(cron) && /"batchdata_incremental"/.test(cron))
  check("a pass-through gate token (zillow_behavior) resolves to its ZenRows sources' vendor contract", (await import("../lib/lead-pipeline/source-intent-map")).sourceKeysForGateToken("zillow_behavior").length === 3 && (await import("../lib/lead-pipeline/source-intent-map")).sourceKeysForGateToken("recruiting_intent").length === 0)
  const statusLiteral = /enrichment_status['"]?\s*[:=]\s*['"](completed|enriched)['"]/
  check("POSITIVE CONTROL: the status-spelling finder sees a planted 'completed'", statusLiteral.test("enrichment_status: 'completed',"))
  const pipelineFiles = ["lib/lead-pipeline/pipeline-processor.ts", "lib/lead-pipeline/enrichment-orchestrator.ts"]
  check("ONE enrichment_status spelling in lib/lead-pipeline (the governance readers' 'complete'); no 'completed' / 'enriched' literal remains", pipelineFiles.every((f) => !statusLiteral.test(blankStrings(stripped(f)).replace(/\s+/g, " ")) && !statusLiteral.test(stripped(f))), pipelineFiles.filter((f) => statusLiteral.test(stripped(f))).join(","))
  check("a provider that did not answer is 'partial' (retryable), an answered pass with no gap is 'complete'", er.leadEnrichmentStatusFor({ providerAnswered: false, gapsRemain: false }) === "partial" && er.leadEnrichmentStatusFor({ providerAnswered: true, gapsRemain: true }) === "partial" && er.leadEnrichmentStatusFor({ providerAnswered: true, gapsRemain: false }) === "complete")
  check("the governance readers test the SAME word the pipeline now writes", /enrichment_status !== 'complete'/.test(stripped("lib/lead-governance/promotion-readiness.ts")) && /enrichment_status !== 'complete'/.test(stripped("lib/lead-governance/routing-evaluator.ts")) && (er.LEAD_ENRICHMENT_STATUSES as readonly string[]).includes("complete"))
  check("the pipeline writes the status through the one rule at both doors (insert + merge)", (proc.match(/leadEnrichmentStatusFor\(/g) ?? []).length >= 2)

  console.log(`\nACQUISITION DOOR — ${passed} passed, ${failed} failed ${failed === 0 ? "✅ ACQUISITION_DOOR_PASS" : "❌ ACQUISITION_DOOR_FAIL"}`)
  console.log(`RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
