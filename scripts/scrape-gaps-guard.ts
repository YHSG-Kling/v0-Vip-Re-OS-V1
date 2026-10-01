/**
 * scripts/scrape-gaps-guard.ts — `npm run test:scrape-gaps`
 *
 * LANE 88G (wave 88, 2026-09-28). Owner: "lead scrapping lane can be changed if necessary and
 * beneficial." Closes lane-87F's eight scraping gaps where beneficial and cheap, preferring data the
 * platform ALREADY BUYS (BatchData quickLists / filters) over any new vendor.
 *
 * No network, no paid call. Every list is DERIVED from the code or the generated schema cache.
 *   S1  ONE quickList reader: the provider's OBJECT of camelCase flags (and the legacy array) → the
 *       published slugs; the old array-only read is the positive control (it loses everything).
 *   S2  the record carries its WHOLE stack: normalizeBatchDataProperty keeps the quickLists + listing
 *       prices; normalizeBatchDataRecord stamps every co-occurring trigger + price_reduced; expired
 *       detection now works on the object shape.
 *   S3  new triggers from data we already buy (auction, mailing_vacant, failed_listing) + tax
 *       spellings — each resolves to a PUBLISHED quickList and round-trips through the inverse map.
 *   S4  stacking rule: distinct families, enablers only tier up, per-family boost, cap, clamp.
 *   S5  stacking against the DB (a fake client): duplicate-of-lead delta, idempotency stamp, refused
 *       read applies nothing, zero-row update reported; promotion reads sibling duplicates.
 *   S6  pipeline wiring: stacked score reaches the lead insert; every duplicate-of-lead branch stacks;
 *       dedup verdicts unchanged; the dedup-log writer reads its error.
 *   S7  OSINT court lane: cost-down type selection, freshness, caption party per type, type scoring.
 *   S8  text distress lexicon: the dead price_reduced / must_sell boosts now fire.
 *   S9  cron: motivated pull runs on defaults with no params row; OSINT gets its types; every lane
 *       still books through bookSourceSpend.
 *   S10 admin door: the motivated-params writer names ONLY live columns (the four phantom columns
 *       were PGRST204 on every save — positive control); the picker's options are derived.
 *   S11 price cuts on the active-listing feed + m676 (index covers the new type; CHECK covers every
 *       stage the pipeline logs).
 *   S12 just-sold farm asks for the BLOCK, not the house.
 *   S13 registration (package.json after test:scrapers; MAINTENANCE_DOMAINS owner).
 * Every absence assertion carries a POSITIVE CONTROL (CLAUDE.md §2).
 */
import { readFileSync, readdirSync } from "fs"
import { join } from "path"
import { stripComments, blankStrings } from "./strip-comments"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import {
  quickListSlugsFromRow, triggerForQuickListSlug, normalizeBatchDataProperty, batchDataTriggersFor,
  quickListSlugsFor, BATCHDATA_MOTIVATION_TYPES, BATCHDATA_QUICKLISTS, neighborStreetQuery,
} from "../lib/external/batchdata-client"
import { normalizeBatchDataRecord } from "../lib/lead-pipeline/scraper-parsers"
import {
  stackSignals, applyStackBoost, stackDuplicateOntoLead, readRawSignalStack,
  STACK_BOOST_CAP, STACK_BOOST_PER_EXTRA_FAMILY, STACK_FAMILY,
} from "../lib/lead-pipeline/signal-stacking"
import { calculateSourceScore } from "../lib/lead-pipeline/source-intent-map"
import {
  osintRecordTypesFor, isFreshFiling, OSINT_FILING_MAX_AGE_DAYS, BATCHDATA_SERVED_RECORD_TYPES, OSINT_ONLY_RECORD_TYPES,
} from "../lib/lead-pipeline/osint-sourcer"
import { partyForRecordType, ALL_RECORD_TYPES } from "../lib/osint-client"
import { distressSignalsFromText } from "../lib/lead-pipeline/scrape-keywords"
import { normalizeCraigslistItem } from "../lib/lead-pipeline/social-sourcer"
import { detectPriceCut } from "../lib/kernel/listings-batchdata-feed"
import { BATCHDATA_SIGNAL_TYPES, PRICE_REDUCED_SIGNAL_TYPE } from "../lib/external/batchdata-seller-signals"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf8")
const stripped = (p: string) => stripComments(read(p))

// ─── S1 ──────────────────────────────────────────────────────────────────────
console.log("\n[S1 · ONE quickList reader, both wire shapes]")
{
  const objectRow = { quickLists: { taxDefault: true, vacant: true, absenteeOwnerOutOfState: true, ownerOccupied: false, notARealFlag: true } }
  const slugs = quickListSlugsFromRow(objectRow)
  check("object of camelCase flags → published slugs (true flags only)", slugs.includes("tax-default") && slugs.includes("vacant") && !slugs.includes("owner-occupied"), slugs.join(","))
  check("the word-order exception maps (absenteeOwnerOutOfState → out-of-state-absentee-owner)", slugs.includes("out-of-state-absentee-owner"))
  check("an unknown flag is DROPPED, never invented", !slugs.some((s) => !BATCHDATA_QUICKLISTS.has(s)))
  check("the legacy ARRAY shape still reads", quickListSlugsFromRow({ quickLists: ["preforeclosure", "vacant"] }).join(",") === "preforeclosure,vacant")
  // POSITIVE CONTROL — the defect this reader replaces: the old array-only read loses the whole set.
  const oldRead = Array.isArray((objectRow as any).quickLists) ? (objectRow as any).quickLists : []
  check("POSITIVE CONTROL: the old `Array.isArray(p.quickLists)` read returns NOTHING for the object shape", oldRead.length === 0)
  const clientSrc = stripped("lib/external/batchdata-client.ts")
  check("normalizeBatchDataProperty reads quickLists through the ONE reader (no array-only read left)",
    /const quickLists = quickListSlugsFromRow\(p\)/.test(clientSrc) && !/Array\.isArray\(p\.quickLists\)/.test(clientSrc))
}

// ─── S2 ──────────────────────────────────────────────────────────────────────
console.log("\n[S2 · the record carries its whole stack]")
const market = { city: "Tampa", state: "FL" }
{
  const row = {
    address: { street: "12 Oak St", city: "Tampa", state: "FL", zip: "33602" },
    owner: { firstName: "Dana", lastName: "Reyes" },
    quickLists: { taxDefault: true, vacant: true, absenteeOwner: true, ownerOccupied: false },
    listing: { price: 310000, maxListPrice: 349000, daysOnMarket: 121, status: "Canceled" },
  }
  const p = normalizeBatchDataProperty(row, "tax_lien")
  check("the property keeps every quickList it is on", ["tax-default", "vacant", "absentee-owner"].every((s) => p.quickLists?.includes(s)), (p.quickLists ?? []).join(","))
  check("the listing prices are read (price / maxListPrice / daysOnMarket)", p.listing?.price === 310000 && p.listing?.maxListPrice === 349000 && p.listing?.daysOnMarket === 121)
  const rec = normalizeBatchDataRecord(p as Record<string, unknown>, market)
  const sig = rec.intentSignals ?? []
  check("the raw record stamps the pulling trigger AND every co-occurring trigger", ["tax_lien", "vacant", "absentee"].every((s) => sig.includes(s)), sig.join(","))
  check("a list price below the listing's own max list price stamps price_reduced", sig.includes("price_reduced"))
  check("non-motivation quickLists (owner-occupied …) never enter the signals", !sig.some((s) => /owner.?occupied/.test(s)))
  check("…and a stacked record scores above the same record stamped with its trigger alone",
    calculateSourceScore("batchdata_motivated", sig) > calculateSourceScore("batchdata_motivated", ["tax_lien"]))
  const canceled = normalizeBatchDataRecord(normalizeBatchDataProperty({ ...row, quickLists: { canceledListing: true } }, "high_equity") as Record<string, unknown>, market)
  check("expired/canceled detection works on the OBJECT shape (was blind: the list was always empty)", canceled.source === "expired_listing")
  const noCut = normalizeBatchDataRecord(normalizeBatchDataProperty({ ...row, listing: { price: 349000, maxListPrice: 349000 } }, "tax_lien") as Record<string, unknown>, market)
  check("CONTROL: price equal to max list price is NOT a cut", !(noCut.intentSignals ?? []).includes("price_reduced"))
}

// ─── S3 ──────────────────────────────────────────────────────────────────────
console.log("\n[S3 · new triggers from data we already buy]")
{
  const triggers = batchDataTriggersFor(["tax_delinquent", "change_of_address", "foreclosure_auction", "stale_listing"])
  check("tax_delinquent → tax_lien, change_of_address → mailing_vacant, foreclosure_auction → auction, stale_listing → failed_listing",
    ["tax_lien", "mailing_vacant", "auction", "failed_listing"].every((t) => triggers.includes(t)), triggers.join(","))
  const newOnes = ["auction", "mailing_vacant", "failed_listing"]
  check("each new trigger is a pullable BatchData motivation type", newOnes.every((t) => (BATCHDATA_MOTIVATION_TYPES as readonly string[]).includes(t)))
  const slugs = quickListSlugsFor(newOnes)
  check("each resolves to a PUBLISHED quickList (active-auction / mailing-address-vacant / failed-listing)",
    slugs.length === 3 && slugs.every((s) => BATCHDATA_QUICKLISTS.has(s)), slugs.join(","))
  const nonRound = (BATCHDATA_MOTIVATION_TYPES as readonly string[]).filter((t) => {
    const s = quickListSlugsFor([t])[0]
    return !s || triggerForQuickListSlug(s) !== t
  })
  check(`every motivation trigger (${BATCHDATA_MOTIVATION_TYPES.length}) round-trips slug → trigger (one vocabulary both ways)`, nonRound.length === 0, nonRound.join(","))
  check("POSITIVE CONTROL: a slug no trigger maps to (owner-occupied) inverts to null", triggerForQuickListSlug("owner-occupied") === null)
  check("the default trio is unchanged for an unconfigured market (cost-safe)", batchDataTriggersFor(undefined).join(",") === "high_equity,pre_foreclosure,absentee")
  check("divorce / bankruptcy / eviction still fall to OSINT (no quickList)", batchDataTriggersFor(["divorce", "bankruptcy", "eviction"]).join(",") === "high_equity,pre_foreclosure,absentee")
}

// ─── S4 ──────────────────────────────────────────────────────────────────────
console.log("\n[S4 · stacking rule]")
{
  check("one family = no boost", stackSignals(["divorce"]).boost === 0)
  check("two spellings of ONE family stay one (pre_foreclosure + notice_of_default + lis_pendens)", stackSignals(["pre_foreclosure", "notice_of_default", "lis_pendens"]).count === 1)
  check(`two distress families = +${STACK_BOOST_PER_EXTRA_FAMILY}`, stackSignals(["divorce", "tax_lien"]).boost === STACK_BOOST_PER_EXTRA_FAMILY)
  check("an ENABLER alone never starts a stack (absentee + high_equity = 0)", stackSignals(["absentee", "high_equity"]).count === 0)
  check("an enabler tiers up a distress stack (tax_lien + absentee = 2 families)", stackSignals(["tax_lien", "absentee"]).count === 2)
  check(`the boost is capped at ${STACK_BOOST_CAP}`, stackSignals(["divorce", "tax_lien", "probate", "vacant", "eviction", "bankruptcy", "code_violation"]).boost === STACK_BOOST_CAP)
  check("unknown spellings contribute nothing", stackSignals(["looking_to_buy", "selling", ""]).count === 0)
  check("applyStackBoost clamps at 100", applyStackBoost(95, stackSignals(["divorce", "tax_lien", "probate"])) === 100)
  const unmappedCourt = (ALL_RECORD_TYPES as readonly string[]).filter((t) => !["marriage", "new_mover", "relocation", "building_permit"].includes(t) && !STACK_FAMILY[t])
  check("every DISTRESS court record type has a stacking family (derived from ALL_RECORD_TYPES)", unmappedCourt.length === 0, unmappedCourt.join(","))
  const unmappedTriggers = (BATCHDATA_MOTIVATION_TYPES as readonly string[]).filter((t) => !STACK_FAMILY[t])
  check("every BatchData motivation trigger has a stacking family", unmappedTriggers.length === 0, unmappedTriggers.join(","))
}

// ─── S5 — fake DB ────────────────────────────────────────────────────────────
type Row = Record<string, any>
function fakeDb(tables: Record<string, Row[]>, refuse: Set<string> = new Set(), dropUpdates = false) {
  const get = (r: Row, path: string) => {
    const m = /^([a-z_]+)->>?([a-z_]+)$/.exec(path)
    if (m) return r[m[1]]?.[m[2]]
    return r[path]
  }
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []
      let patch: Row | null = null
      let lim = Infinity
      const q: any = {
        select() { return q },
        update(p: Row) { patch = p; return q },
        eq(c: string, v: unknown) { filters.push((r) => get(r, c) === v); return q },
        in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(get(r, c))); return q },
        not(c: string, _op: string, _v: unknown) { filters.push((r) => get(r, c) != null); return q },
        limit(n: number) { lim = n; return q },
        maybeSingle() { return run().then((res: any) => ({ data: res.data?.[0] ?? null, error: res.error })) },
        then(ok: any, bad: any) { return run().then(ok, bad) },
      }
      const run = async () => {
        if (refuse.has(table)) return { data: null, error: { message: `${table} refused (test)` } }
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, lim)
        if (patch) { if (dropUpdates) return { data: [], error: null }; for (const r of rows) Object.assign(r, patch); return { data: rows.map((r) => ({ id: r.id })), error: null } }
        return { data: rows, error: null }
      }
      return q
    },
  }
}

async function s5() {
  console.log("\n[S5 · stacking against the DB (fake client)]")
  const base = () => ({
    leads: [{ id: "L1", lead_score: 70 }],
    raw_scraped_leads: [
      { id: "R1", lead_id: "L1", normalized_preview: { intentSignals: ["divorce"] } },
      { id: "R2", lead_id: null, normalized_preview: { intentSignals: ["tax_lien", "vacant"] } },
    ],
    lead_deduplication_log: [] as Row[],
  })
  let t = base()
  const r1 = await stackDuplicateOntoLead(fakeDb(t), { leadId: "L1", rawRecordId: "R2", signals: ["tax_lien", "vacant"] })
  check("a duplicate adding two NEW families raises the lead by the stack DELTA (0 → 12)", r1.applied && r1.delta === 2 * STACK_BOOST_PER_EXTRA_FAMILY && t.leads[0].lead_score === 70 + 2 * STACK_BOOST_PER_EXTRA_FAMILY, JSON.stringify(r1))
  t.lead_deduplication_log.push({ id: "D1", raw_record_id: "R2", duplicate_of_lead_id: "L1", match_details: { signal_stack: { families: r1.families } } })
  const again = await stackDuplicateOntoLead(fakeDb(t), { leadId: "L1", rawRecordId: "R2", signals: ["tax_lien", "vacant"] })
  check("IDEMPOTENT: the same raw row stacks once (the dedup log's signal_stack is the stamp)", !again.applied && t.leads[0].lead_score === 82, again.reason ?? "")
  t.raw_scraped_leads.push({ id: "R3", lead_id: null, normalized_preview: { intentSignals: ["divorce"] } })
  const same = await stackDuplicateOntoLead(fakeDb(t), { leadId: "L1", rawRecordId: "R3", signals: ["divorce"] })
  check("a duplicate carrying only a family the lead already has moves nothing", !same.applied && same.delta === 0 && t.leads[0].lead_score === 82)
  t = base()
  const refused = await stackDuplicateOntoLead(fakeDb(t, new Set(["raw_scraped_leads"])), { leadId: "L1", rawRecordId: "R2", signals: ["tax_lien"] })
  check("FAIL-CLOSED: a refused read applies NOTHING and says why", !refused.applied && /refused/.test(refused.reason ?? "") && t.leads[0].lead_score === 70)
  t = base()
  const zero = await stackDuplicateOntoLead(fakeDb(t, new Set(), true), { leadId: "L1", rawRecordId: "R2", signals: ["tax_lien"] })
  check("a zero-row update is REPORTED, never read as success (CLAUDE.md §3)", !zero.applied && /matched no row/.test(zero.reason ?? ""))
  const none = await stackDuplicateOntoLead(fakeDb(base()), { leadId: "L1", rawRecordId: "R2", signals: ["looking_to_buy"] })
  check("a row with no stackable signal is a no-op", !none.applied)
  const promo = await readRawSignalStack(fakeDb({
    lead_deduplication_log: [{ raw_record_id: "S9", match_details: { duplicate_of_raw_id: "P1" } }],
    raw_scraped_leads: [{ id: "S9", normalized_preview: { intentSignals: ["eviction"] } }],
  }), "P1", ["tax_lien"])
  check("PROMOTION reads its logged duplicates: own tax_lien + a sibling's eviction = 2 families", promo.stack.count === 2 && promo.siblingRawIds.join() === "S9" && promo.measured)
  const promoRefused = await readRawSignalStack(fakeDb({}, new Set(["lead_deduplication_log"])), "P1", ["tax_lien"])
  check("…a refused sibling read stacks only the row's own signals and says measured:false", promoRefused.stack.count === 1 && promoRefused.measured === false)
}

// ─── S6 ──────────────────────────────────────────────────────────────────────
function s6() {
  console.log("\n[S6 · pipeline wiring]")
  const src = blankStrings(stripped("lib/lead-pipeline/pipeline-processor.ts"))
  const raw = stripped("lib/lead-pipeline/pipeline-processor.ts")
  const iStack = raw.indexOf("readRawSignalStack(supabase, rawRecordId")
  const iInsert = raw.indexOf(".from('leads')\n    .insert(")
  check("the promotion reads the stack BEFORE the lead insert", iStack > 0 && iInsert > 0 && iStack < iInsert, `stack@${iStack} insert@${iInsert}`)
  check("the lead is born with the STACKED score and urgency from it", /lead_score:\s+stackedScore,/.test(raw) && /scoreToUrgencyLevel\(stackedScore\)/.test(raw))
  const calls = (src.match(/stackOntoDuplicateLead\(supabase,/g) ?? []).length
  check("every duplicate-of-lead branch stacks (pre-enrich + post-enrich merge + post-enrich keep = 3)", calls === 3, `calls=${calls}`)
  check("dedup VERDICTS are unchanged — each stacked branch still sets its duplicate status first",
    /'duplicate_pre_enrich'[\s\S]{0,200}stackOntoDuplicateLead/.test(raw) && (raw.match(/'duplicate_post_enrich'[\s\S]{0,120}stackOntoDuplicateLead/g) ?? []).length === 2)
  check("contacts are never stacked (a contact is an agent's book)", /if \(dup\.type !== 'lead'\) return null/.test(raw))
  // Rule, not waypoint: the dedup-log write's refusal is READ or LEDGERED (lane 88F moved it onto
  // sentinelWrite, which ledgers a refusal) — either shape passes, a bare awaited insert does not.
  const dedupLogReadsRefusal = (src: string) =>
    /const \{ error \} = await supabase\.from\('lead_deduplication_log'\)\.insert\(log\)/.test(src)
    || /sentinelWrite\(supabase, supabase\.from\('lead_deduplication_log'\)\.insert\(log\)/.test(src)
  check("the dedup-log writer READS or LEDGERS its refusal (supabase-js resolves refusals)", dedupLogReadsRefusal(raw))
  check("POSITIVE CONTROL: a bare awaited dedup-log insert is flagged", !dedupLogReadsRefusal(`await supabase.from('lead_deduplication_log').insert(log)`))
  const fixture = "async function x(){ await supabase.from('lead_deduplication_log').insert(log) }"
  check("POSITIVE CONTROL: the finder rejects the old swallow shape", !/const \{ error \} = await supabase\.from\('lead_deduplication_log'\)\.insert\(log\)/.test(fixture))
}

// ─── S7 ──────────────────────────────────────────────────────────────────────
function s7() {
  console.log("\n[S7 · OSINT court lane]")
  const withBd = osintRecordTypesFor(null, { batchdataRuns: true })
  check("default with BatchData running skips the recorder types BatchData already sells", BATCHDATA_SERVED_RECORD_TYPES.every((t) => !withBd.includes(t)), withBd.join(","))
  check("…and keeps every court-only type (divorce, bankruptcy, eviction, probate …)", OSINT_ONLY_RECORD_TYPES.every((t) => withBd.includes(t)))
  const noBd = osintRecordTypesFor([], { batchdataRuns: false })
  check("a market WITHOUT BatchData still searches foreclosure / tax-lien filings", BATCHDATA_SERVED_RECORD_TYPES.every((t) => noBd.includes(t)))
  check("obituary / building_permit are never searched by default (a court index answers neither)", !withBd.includes("obituary") && !withBd.includes("building_permit") && !noBd.includes("obituary"))
  check("cost-down is measured: default searches fewer types than the old all-types sweep", withBd.length < (ALL_RECORD_TYPES as readonly string[]).length, `${withBd.length} < ${ALL_RECORD_TYPES.length}`)
  const named = osintRecordTypesFor(["eviction", "pre_probate", "high_equity"], { batchdataRuns: true })
  check("a market naming court types gets EXACTLY those (aliases resolved; BatchData-only triggers ignored)", named.join(",") === "eviction,probate", named.join(","))
  const now = Date.parse("2026-09-28T00:00:00Z")
  check(`freshness: a filing older than ${OSINT_FILING_MAX_AGE_DAYS} days is dropped`, !isFreshFiling("2026-06-01", now))
  check("…a recent one and an undated one are kept (undated cannot be judged)", isFreshFiling("2026-09-20", now) && isFreshFiling(null, now) && isFreshFiling("filed recently", now))
  check("eviction → the landlord (plaintiff)", partyForRecordType("Jane Smith v. Robert Tenant", "eviction") === "Jane Smith")
  check("foreclosure → the owner (defendant)", partyForRecordType("Wells Fargo Bank NA vs. Maria Lopez", "foreclosure") === "Maria Lopez")
  check("probate → the decedent named after 'Estate of'", partyForRecordType("In re the Estate of Harold Greene, Deceased", "probate") === "Harold Greene")
  check("bankruptcy → the debtor ('In re')", partyForRecordType("In re Kevin Park", "bankruptcy") === "Kevin Park")
  check("divorce → the first spouse", partyForRecordType("In re the Marriage of Ann Lee and Tom Lee", "divorce") === "Ann Lee")
  check("POSITIVE CONTROL: a caption with no name-like party is refused", partyForRecordType("v. 12", "eviction") === null)
  check("a court TYPE now scores (divorce filing > an untyped OSINT row)", calculateSourceScore("osint_signal", ["divorce"]) > calculateSourceScore("osint_signal", []))
}

// ─── S8 ──────────────────────────────────────────────────────────────────────
function s8() {
  console.log("\n[S8 · text distress lexicon]")
  const d = distressSignalsFromText("PRICE REDUCED — must sell fast, divorce forces sale, tenants not paying")
  check("reads price cut / urgency / divorce / eviction from one post", ["price_reduced", "must_sell", "divorce", "eviction"].every((s) => d.includes(s)), d.join(","))
  check("NEGATIVE CONTROL: a plain listing yields nothing", distressSignalsFromText("Beautiful 3 bed 2 bath home, great schools").length === 0)
  const cl = normalizeCraigslistItem({ id: "x1", title: "FSBO 3br house - price reduced, must sell", description: "owner relocating" }, market)
  check("the social normalizer stamps them (withTextSignals)", (cl.intentSignals ?? []).includes("price_reduced") && (cl.intentSignals ?? []).includes("must_sell"), (cl.intentSignals ?? []).join(","))
  check("…so the long-dead craigslist price_reduced / must_sell boosts now score",
    calculateSourceScore("craigslist_fsbo", cl.intentSignals ?? []) > calculateSourceScore("craigslist_fsbo", ["fsbo", "by_owner"]))
}

// ─── S9 ──────────────────────────────────────────────────────────────────────
function s9() {
  console.log("\n[S9 · cron wiring]")
  const cron = blankStrings(stripped("app/api/cron/lead-scraping/route.ts"))
  const cronRaw = stripped("app/api/cron/lead-scraping/route.ts")
  check("the motivated pull no longer REQUIRES a params row (the row could never be written)", !/lead_scraping_motivated_params\?\.length > 0/.test(cronRaw))
  check("POSITIVE CONTROL: the finder recognises the old gate", /lead_scraping_motivated_params\?\.length > 0/.test("if (x && market.lead_scraping_motivated_params?.length > 0) {"))
  check("no row ⇒ the default trio (signal_types [] → batchDataTriggersFor default); is_active=false still turns it off",
    (cronRaw.match(/\?\? \{ is_active: true, signal_types: \[\] \}/g) ?? []).length === 2 && /is_active !== false/.test(cronRaw) && /is_active === false\) continue/.test(cronRaw))
  check("OSINT receives its selected types", /osintRecordTypesFor\(/.test(cron) && /\{ recordTypes: osintTypes \}/.test(cronRaw))
  for (const s of ["batchdata_motivated", "expired_listing", "osint_signal", "batchdata_cash_buyer"]) {
    check(`cost still booked per source: bookSourceSpend({ source: "${s}" …`, cronRaw.includes(`bookSourceSpend({ source: "${s}"`))
  }
}

// ─── S10 ─────────────────────────────────────────────────────────────────────
function s10() {
  console.log("\n[S10 · admin door writes live columns only]")
  const live = new Set(SCHEMA_SNAPSHOT.lead_scraping_motivated_params ?? [])
  check("schema cache knows lead_scraping_motivated_params", live.size > 0)
  const actions = stripped("app/actions/lead-scraping-config.ts")
  const s = actions.indexOf("export async function createMotivatedParams")
  const e = actions.indexOf("export async function getScrapingJobs", s)
  check("the motivated-params writers are located (both, in order)", s >= 0 && e > s && actions.slice(s, e).includes("export async function updateMotivatedParams"))
  const block = actions.slice(s, e)
  const written = new Set<string>()
  // Every key of the insert literal (spread fragments included) up to its `.select()`, plus every
  // `patch.<col> =` of the update — blankStrings so a string value can never read as a key.
  const blanked = blankStrings(block)
  for (const m of blanked.matchAll(/\.insert\(\{([\s\S]*?)\}\)\s*\.select\(/g)) for (const k of m[1].matchAll(/(?:^|[\s{,])([a-z_]+)\s*:/g)) written.add(k[1])
  for (const m of blanked.matchAll(/patch\.([a-z_]+)\s*=/g)) written.add(m[1])
  check("the four columns the cron reads are all WRITTEN by the door (signal_types, facebook_group_urls, reddit_subreddits, lookback_days)",
    ["signal_types", "facebook_group_urls", "reddit_subreddits", "lookback_days"].every((c) => written.has(c)), [...written].join(","))
  const phantom = [...written].filter((k) => !live.has(k))
  check(`every column the motivated-params writers name is LIVE (${[...written].join(",")})`, written.size >= 3 && phantom.length === 0, phantom.join(","))
  const oldPayload = ["motivation_types", "min_equity_percent", "max_days_on_market", "include_expired_listings", "include_fsbo"]
  check("POSITIVE CONTROL: the old payload's five columns are all absent from the live table (why every save was PGRST204)", oldPayload.every((k) => !live.has(k)))
  const client = stripped("app/dashboard/admin/markets/markets-client.tsx")
  check("the panel no longer sends a phantom column", oldPayload.every((k) => !client.includes(k)))
  const page = stripped("app/dashboard/admin/markets/page.tsx")
  check("the picker's options are DERIVED from BATCHDATA_MOTIVATION_TYPES + ALL_RECORD_TYPES (no hand list)",
    /BATCHDATA_MOTIVATION_TYPES\.filter/.test(page) && /ALL_RECORD_TYPES as readonly string\[\]/.test(page) && /signalTypeOptions=\{MOTIVATED_SIGNAL_OPTIONS\}/.test(page))
}

// ─── S11 ─────────────────────────────────────────────────────────────────────
function s11() {
  console.log("\n[S11 · price cuts + m676]")
  check("an active listing whose list price dropped ≥1% is a cut", detectPriceCut({ previousStatus: "active", status: "active", previousPrice: 400000, price: 379000, maxListPrice: 400000 }).cut)
  check("CONTROL: a status change is a transition, not a cut", !detectPriceCut({ previousStatus: "active", status: "expired", previousPrice: 400000, price: 379000 }).cut)
  check("CONTROL: an unknown previous price is never a cut", !detectPriceCut({ previousStatus: "active", status: "active", previousPrice: null, price: 379000 }).cut)
  check("CONTROL: the provider's max list price must corroborate (an AVM fallback never reads as a cut)", !detectPriceCut({ previousStatus: "active", status: "active", previousPrice: 450000, price: 379000, maxListPrice: 379000 }).cut)
  const feed = stripped("lib/kernel/listings-batchdata-feed.ts")
  // Re-anchored wave 92 (lane 92B): the feed is a RentCast sweep — a RentCast listing row's `price`
  // IS the list price and carries no AVM, so there is no fallback to read as a cut.
  check("the feed stores the LIST price (the RentCast listing row's price — never an AVM)", /list_price: l\.price \?\? null,/.test(feed) && !/estimatedValue/.test(feed))
  check("a price cut files PRICE_REDUCED_SIGNAL_TYPE, weak, attach-only (matched lead/contact)", /signalType: PRICE_REDUCED_SIGNAL_TYPE,\s+strength: "weak"/.test(feed) && feed.indexOf("findLeadOrContactByAddress(supabase") < feed.indexOf("signalType: PRICE_REDUCED_SIGNAL_TYPE"))
  check("the type is declared through the seller-signal spec (BATCHDATA_SIGNAL_TYPES)", BATCHDATA_SIGNAL_TYPES.includes(PRICE_REDUCED_SIGNAL_TYPE))
  const migs = readdirSync(join(root, "supabase/migrations"))
  const m676 = migs.find((f) => f.startsWith("m676-"))
  check("m676 exists", !!m676)
  if (m676) {
    const sql = read(`supabase/migrations/${m676}`)
    check("m676's index lists every seller-signal type this code writes", BATCHDATA_SIGNAL_TYPES.every((t) => sql.includes(`'${t}'`)), BATCHDATA_SIGNAL_TYPES.filter((t) => !sql.includes(`'${t}'`)).join(","))
    // Derive every stage the pipeline LOGS (logDeduplication({ … stage: '<x>' …})) from stripped source.
    const proc = stripped("lib/lead-pipeline/pipeline-processor.ts")
    const stages = new Set<string>()
    for (const m of proc.matchAll(/logDeduplication\(\{([\s\S]*?)\}, supabase\)/g)) {
      const st = /stage:\s*'([a-z_]+)'/.exec(m[1]); if (st) stages.add(st[1])
    }
    const checkPart = sql.slice(sql.indexOf("lead_deduplication_log_stage_check\n  CHECK"), sql.indexOf("PART B"))
    const missing = [...stages].filter((s) => !checkPart.includes(`'${s}'`))
    check(`m676's stage CHECK admits every stage the pipeline logs (${stages.size} derived)`, stages.size >= 6 && missing.length === 0, missing.join(","))
    check("POSITIVE CONTROL: a stage the CHECK does not list is caught by the same finder", !checkPart.includes("'no_such_stage'"))
    check("m676's first line carries a migration status header (written-by-lane or applied stamp)", /^-- ── (WRITTEN|APPLIED LIVE)\b/.test(sql.split("\n")[0]))
  }
}

// ─── S12 ─────────────────────────────────────────────────────────────────────
function s12() {
  console.log("\n[S12 · just-sold farm asks for the block]")
  check("the neighbour query drops the house number (the BLOCK, not the house)", neighborStreetQuery("123 Main St", "Tampa", "FL") === "Main St, Tampa, FL")
  check("…and unit suffixes", neighborStreetQuery("88B Palm Ave Unit 4", "Tampa", "FL") === "Palm Ave, Tampa, FL")
  check("POSITIVE CONTROL: a PO box / bare number yields no query", neighborStreetQuery("PO Box 12", "Tampa", "FL") === null && neighborStreetQuery("123", null, null) === null)
  const farm = stripped("lib/kernel/neighbor-farm.ts")
  check("the farm scraper sends the street query sized to the farm and skips the sold home itself",
    /neighborStreetQuery\(params\.listingAddress/.test(farm) && /take: params\.maxResults \+ 1/.test(farm) && /=== ownKey\) continue/.test(farm))
  check("owner-occupied is read through the ONE quickList reader", /quickListSlugsFromRow\(p\)\.includes\("owner-occupied"\)/.test(farm))
}

// ─── S13 ─────────────────────────────────────────────────────────────────────
function s13() {
  console.log("\n[S13 · registration]")
  const pkg = JSON.parse(read("package.json"))
  check("package.json registers test:scrape-gaps", pkg.scripts?.["test:scrape-gaps"] === "tsx scripts/scrape-gaps-guard.ts")
  const guard: string = pkg.scripts?.guard ?? ""
  const iS = guard.indexOf("npm run test:scrapers"), iG = guard.indexOf("npm run test:scrape-gaps")
  check("the guard chain runs it AFTER test:scrapers (ordering, never adjacency)", iS >= 0 && iG > iS)
  check("exactly once in the chain", guard.split("npm run test:scrape-gaps ").length - 1 + (guard.endsWith("npm run test:scrape-gaps") ? 1 : 0) === 1)
  const dom = (MAINTENANCE_DOMAINS as Record<string, { manager: string; proof: string; coOwners?: string[] }>).scrape_gaps
  check("MAINTENANCE_DOMAINS.scrape_gaps names this proof and an owner", !!dom && dom.proof === "test:scrape-gaps" && !!dom.manager)
}

async function main() {
  await s5()
  s6(); s7(); s8(); s9(); s10(); s11(); s12(); s13()
  console.log(`\n  denominators: ${BATCHDATA_MOTIVATION_TYPES.length} BatchData triggers · ${BATCHDATA_QUICKLISTS.size} published quickLists · ${(ALL_RECORD_TYPES as readonly string[]).length} court record types · ${Object.keys(STACK_FAMILY).length} stack spellings · ${BATCHDATA_SIGNAL_TYPES.length} seller-signal types`)
  console.log(`\n  RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log("\n FAILURES:"); for (const f of fails) console.log(`   · ${f}`); process.exit(1) }
  console.log("  ✅ SCRAPE_GAPS_PASS")
}
main().catch((e) => { console.error(e); process.exit(1) })
