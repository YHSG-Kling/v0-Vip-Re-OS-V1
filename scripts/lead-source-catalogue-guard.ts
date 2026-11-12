/**
 * scripts/lead-source-catalogue-guard.ts — `npm run test:lead-source-catalogue`
 *
 * LANE 89B (wave 89, 2026-09-29). Owner verbatim: "if it is behavioral/intent from posts, those
 * would need to be brought into the linear raw leads and enriched by people data lab along with the
 * rest scraped leads unless we already paid for that lead data with the lead. batchdata has many
 * other quicklists so don't just limit to motivated sellers. exa is also another lead scrapping
 * source. if there is another way to get comparable lead quality for less money at a differnt lead
 * source, then we should explore that."
 *
 * No network. Every set is DERIVED (SourceKeys from ALL_SOURCE_KEYS, quickLists from
 * BATCHDATA_QUICKLISTS, triggers from BATCHDATA_MOTIVATION_TYPES, populations from
 * SOURCE_ACQUISITION) — never a hand list. Every absence assertion carries a POSITIVE CONTROL.
 *   C1  PAID PERSON DATA — one vocabulary: SOURCE_PAID_PERSON_DATA answers for every SourceKey; the
 *       BatchData normalizer reads the provider's `contact` dataset (owner.phoneNumbers / owner.emails)
 *       and stamps paidPersonData only when a contact point ARRIVED; the raw writer stamps
 *       normalized_preview.paid_person_data (one spelling); pipeline-processor skips the PeopleData
 *       call (and its meter) for such a row while the email-seek hook, the post-enrich dedup and
 *       the lead gate still run; every post-intent lane is paid=false and reaches the same path.
 *   C2  BATCHDATA CATALOGUE — every published quickList (38) carries a verdict; seller triggers and
 *       investor-buyer lists round-trip through QUICKLIST_SLUG; `defaultOn` names exactly the
 *       default trio; every trigger has a stacking family; the cron pulls every investor-buyer list.
 *   C3  EXA AS A LEAD SOURCE — every population per territory, produced (not just declared), the
 *       map-level intent no longer labels a seller record 'buyer', list-price cost fallback.
 *   C4  FSBO MARKETPLACE LANE — the cheaper FSBO population (Apify) in every registry, opt-in.
 *   C6  (lane 90B) NOREPLY COST LEAK — THE gate's email rule (leadEmailProblem, whose automated-mailbox
 *       arm is email-verifier.ts::isAutomatedLocalPart: exact / collapsed / token-wise) is applied by the
 *       unknown-sender prefilter BEFORE the classifier and by processRawRecord BEFORE dedup + PeopleData;
 *       `esignature-noreply@` and friends no longer buy a classification or a PDL match.
 *   C7  (lane 90B) SOURCE COST LEDGER — leads.cost_per_record is WRITTEN at promotion (both doors); the
 *       chain raw → lead → contact → person-timeline is closed; every paid cron source stamps its cost.
 *   C5  registration.
 */
import { readFileSync } from "fs"
import { stripComments, blankStrings } from "./strip-comments"
import {
  ALL_SOURCE_KEYS, SOURCE_MAP, SOURCE_VENDOR, SOURCE_PAID_PERSON_DATA, deliversPaidPersonData, expandEnabledSources,
  resolveSourceKey, DEFAULT_MARKET_SOURCES, calculateSourceScore, type SourceKey,
} from "../lib/lead-pipeline/source-intent-map"
import { SOURCE_ACQUISITION, recordAcquisitionIntents, type AcquisitionIntent } from "../lib/lead-pipeline/acquisition-coverage"
import { SCRAPE_KEYWORD_POLICY } from "../lib/lead-pipeline/scrape-keywords"
import {
  BATCHDATA_QUICKLISTS, BATCHDATA_QUICKLIST_CATALOGUE, BATCHDATA_MOTIVATION_TYPES, BATCHDATA_INVESTOR_BUYER_TYPES,
  quickListSlugsFor, triggerForQuickListSlug, batchDataTriggersFor, quickListCatalogueForTrigger, isInvestorBuyerTrigger,
  normalizeBatchDataProperty, ownerContactPointsFromRow, BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD,
} from "../lib/external/batchdata-client"
import { STACK_FAMILY, stackSignals } from "../lib/lead-pipeline/signal-stacking"
import { normalizeBatchDataRecord } from "../lib/lead-pipeline/scraper-parsers"
import { normalizeRawSourceRecord } from "../lib/kernel/scraping"
import { buildExaIntentQueries, normalizeExaResult, sourceExaBuyerIntent, EXA_RESULTS_PER_QUERY, EXA_QUERIES_PER_POPULATION } from "../lib/lead-pipeline/exa-sourcer"
import { exaSearchListCost, EXA_SEARCH_REQUEST_COST_USD, EXA_SEARCH_INCLUDED_RESULTS } from "../lib/external/exa-client"
import { normalizeFsboSiteListing, sourceFsboSiteListings } from "../lib/lead-pipeline/social-sourcer"
import { scrapeFsboSiteListings } from "../lib/external/apify-client"
import { ACTOR_REGISTRY } from "../lib/external/apify-actors"
import { stateNameFromCode } from "../lib/constants/us-states"
// Lane 90B — C6 (the noreply cost leak) + C7 (the cost hop raw → lead → contact).
import { AUTOMATED_LOCAL_PARTS, isAutomatedLocalPart } from "../lib/external/email-verifier"
import { leadEmailProblem } from "../lib/lead-pipeline/canonical-lead-eligibility"
// unknown-sender-identification.ts imports "server-only" (throws outside a Server Component): the
// require-cache shim scripts/lead-email-conversion-simulator.ts uses, then a RUNTIME import in C6 —
// only the pure prefilter is called (no model, no network, no DB).
import { createRequire } from "node:module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")
const stripped = (p: string) => stripComments(read(p))
const code = (p: string) => blankStrings(stripped(p))
const KEYS = ALL_SOURCE_KEYS as SourceKey[]
const INTENTS: AcquisitionIntent[] = ["sell", "buy", "relocate", "realtor_seeking", "investor"]
const ROUTE = "app/api/cron/lead-scraping/route.ts"
const route = stripped(ROUTE)
const MARKET = { city: "Austin", state: "TX" }

// ── C0 · scanner positive control ────────────────────────────────────────────
console.log("\n[C0 · scanner — a tombstone is not a call site]")
check("POSITIVE CONTROL: stripComments drops a comment naming skipTraceWithPeopleData( and keeps live code",
  !/skipTraceWithPeopleData\(/.test(stripComments(`// skipTraceWithPeopleData( was here\nconst a = 1`)) && /const a = 1/.test(stripComments(`// x\nconst a = 1`)))

// ── C1 · paid person data ────────────────────────────────────────────────────
console.log("\n[C1 · PAID PERSON DATA — one vocabulary, PeopleData skipped only for what the vendor sold]")
{
  const declared = Object.keys(SOURCE_PAID_PERSON_DATA).sort()
  check(`SOURCE_PAID_PERSON_DATA answers for exactly ALL_SOURCE_KEYS (${KEYS.length}, derived)`,
    declared.length === KEYS.length && KEYS.every((k) => k in SOURCE_PAID_PERSON_DATA), `${declared.length} vs ${KEYS.length}`)
  const paidKeys = KEYS.filter((k) => SOURCE_PAID_PERSON_DATA[k])
  check(`every paid=true source is a BatchData-vendored source (${paidKeys.join(", ")})`, paidKeys.length > 0 && paidKeys.every((k) => SOURCE_VENDOR[k] === "batchdata"))
  const postIntent = KEYS.filter((k) => ["apify", "zenrows", "zyte", "exa", "tavily"].includes(SOURCE_VENDOR[k]))
  check(`every behavioral/post-intent lane is paid=false → goes through PeopleData (${postIntent.length} lanes)`, postIntent.every((k) => !SOURCE_PAID_PERSON_DATA[k]), postIntent.filter((k) => SOURCE_PAID_PERSON_DATA[k]).join(", "))
  check("deliversPaidPersonData resolves every spelling: batchdata / batchdata_incremental / cash_buyer → true; craigslist / exa / facebook → false",
    ["batchdata", "batchdata_incremental", "cash_buyer", "batchdata_smart_search"].every(deliversPaidPersonData) && !["craigslist", "exa", "facebook", "nextdoor", "fsbo_site"].some(deliversPaidPersonData))
  check("POSITIVE CONTROL: a channel with no SourceKey is never paid", !deliversPaidPersonData("myspace_intent"))

  // The BatchData normalizer reads the provider's `contact` dataset shape.
  const withContact = normalizeBatchDataProperty({
    address: { street: "1 Main St", city: "Austin", state: "TX", zip: "78701" },
    owner: {
      fullName: "Jane Owner",
      phoneNumbers: [{ number: "(512) 555-0100", type: "Mobile", dnc: true, reachable: true }, { number: "5125550101", type: "Landline" }, { number: "5125550100" }],
      emails: ["jane@example.com", "JANE@example.com"],
      enrichedEmails: [{ email: "jane.owner@work.example", tested: true }],
    },
    quickLists: { highEquity: true },
  }, "high_equity")
  check("contact dataset read: owner.phoneNumbers[].number / owner.emails[] / owner.enrichedEmails[].email → phone/email + full lists, deduped (digits / lowercase)",
    withContact.phone === "(512) 555-0100" && withContact.email === "jane@example.com" && withContact.phones?.length === 2 && withContact.emails?.length === 2 && withContact.emails?.includes("jane.owner@work.example"))
  check("a DNC-flagged line is KEPT (the promotion scrub decides reachability, not the reader)", withContact.phones?.[0] === "(512) 555-0100")
  check("…and the record stamps paidPersonData: true", withContact.paidPersonData === true)
  const noContact = normalizeBatchDataProperty({ address: { street: "1 Main St", city: "Austin", state: "TX" }, owner: { fullName: "Jane Owner" } }, "high_equity")
  check("POSITIVE CONTROL: a row WITHOUT the contact dataset (name + address only) stamps paidPersonData: false and no phone/email",
    noContact.paidPersonData === false && noContact.phone === null && noContact.email === null)
  const legacyFlat = normalizeBatchDataProperty({ address: {}, owner: { fullName: "Jane Owner", phone: "5125550199", email: "j@x.io" } }, "vacant")
  check("the legacy flat owner.phone / owner.email shape still reads (paid too)", legacyFlat.phone === "5125550199" && legacyFlat.email === "j@x.io" && legacyFlat.paidPersonData === true)
  check("ownerContactPointsFromRow refuses junk (short numbers, non-emails, null owner)",
    ownerContactPointsFromRow({ phoneNumbers: [{ number: "123" }], emails: ["not-an-email"] }).phones.length === 0
    && ownerContactPointsFromRow({ phoneNumbers: [{ number: "123" }], emails: ["not-an-email"] }).emails.length === 0
    && ownerContactPointsFromRow(null).phones.length === 0)

  // Carried onto the raw shape and stamped by the ONE raw writer.
  const rawRec = normalizeBatchDataRecord(withContact as Record<string, unknown>, MARKET)
  check("normalizeBatchDataRecord carries paidPersonData onto the NormalizedScrapedRecord", rawRec.paidPersonData === true && normalizeBatchDataRecord(noContact as Record<string, unknown>, MARKET).paidPersonData === false)
  const preview = normalizeRawSourceRecord({ record: rawRec, market: { city: "Austin", state: "TX", zip_codes: [] } }).normalized_preview as Record<string, unknown>
  check("normalizeRawSourceRecord stamps normalized_preview.paid_person_data (true here, false for an unpaid row)",
    preview.paid_person_data === true && (normalizeRawSourceRecord({ record: { ...rawRec, paidPersonData: false }, market: { city: "Austin", state: "TX", zip_codes: [] } }).normalized_preview as Record<string, unknown>).paid_person_data === false)
  const kernel = stripped("lib/kernel/scraping.ts")
  check("ONE spelling in the raw writer: both preview builders write `paid_person_data: record.paidPersonData === true` (2 sites), no second spelling",
    (kernel.match(/paid_person_data:\s*record\.paidPersonData === true/g) ?? []).length === 2 && !/paidPersonData:\s*record/.test(kernel) && !/paid_person_data:\s*(true|false)\b/.test(kernel))

  // pipeline-processor: read → skip PDL only; email-seek / dedup / gate unchanged.
  const pp = stripped("lib/lead-pipeline/pipeline-processor.ts")
  check("processRawRecord hands enrichWithPeopleData the stamp bounded by the contract (paid_person_data === true && deliversPaidPersonData(scoringSource))",
    /paidPersonData:\s*rec\.normalized_preview\?\.paid_person_data === true && deliversPaidPersonData\(scoringSource\)/.test(pp))
  const fnAt = pp.indexOf("async function enrichWithPeopleData(")
  const fn = pp.slice(fnAt, pp.indexOf("// ─── Deduplication matching", fnAt))
  const skipAt = fn.indexOf("const skipPeopleData = fields.paidPersonData === true && !!(fields.phone || fields.email)")
  const pdlAt = fn.indexOf("skipTraceWithPeopleData(")
  check("enrichWithPeopleData: skipPeopleData = paid AND (phone OR email), decided BEFORE the PDL call", skipAt > 0 && pdlAt > skipAt)
  // Re-anchored (wave 93, lane 93B2): the SAME guard now also skips PDL after a Versium answer
  // (Versium first, PDL only on a miss) — the rule held: no PDL call and no PDL meter for a paid row.
  check("the PDL call is guarded by the flag (`skipPeopleData [|| versiumAnswered] ? { data: null } : await skipTraceWithPeopleData(`)", /skipPeopleData(?: \|\| versiumAnswered)?\s*\?\s*\{ data: null \}\s*:\s*await skipTraceWithPeopleData\(/.test(fn))
  check("the PDL meter is guarded too (no $0.25 row for a call that never happened)", /if \(!skipPeopleData(?: && !versiumAnswered)? && fields\.brokerageId/.test(fn))
  check("a skipped row is stamped enrichmentSource 'vendor_delivered' + peopleDataSkipped with a vendor-match confidence", /enrichmentSource: 'vendor_delivered'/.test(fn) && /peopleDataSkipped: true/.test(fn) && /enrichmentConfidence: 0\.6/.test(fn))
  const seekAt = fn.indexOf("if (fields.rawRecordId) {")
  const seekBlock = fn.slice(seekAt, seekAt + 80)
  check("the email-seek hook is NOT gated by the skip (a paid phone-only row still gets its email sought)", seekAt > pdlAt && !/skipPeopleData/.test(seekBlock))
  const order = ["recordMatchesTerritory(", "'pre_enrichment'", "await enrichWithPeopleData(", "'post_enrichment'", "evaluateCanonicalLeadEligibility(", ".from('leads')"].map((t) => pp.indexOf(t))
  check("the linear path is unchanged for paid and unpaid rows alike: territory → dedup → enrich → dedup → gate → lead", order.every((x) => x >= 0) && order.every((x, i) => i === 0 || x > order[i - 1]))
  check("POSITIVE CONTROL: an ungated PDL call IS recognised as ungated by the same finder",
    !/skipPeopleData\s*\?\s*\{ data: null \}\s*:\s*await skipTraceWithPeopleData\(/.test(`const enrichmentResult = await skipTraceWithPeopleData({ name })`))
  // Every post-intent lane's records reach the raw writer under its channel (same finder as the coverage guard).
  const writes = (ch: string) => new RegExp(`insertSocial\\(\\s*[\\w.]+\\s*,\\s*${ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,`).test(route) || new RegExp(`sourceChannel:\\s*${ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[,}]`).test(route)
  const postCron = postIntent.filter((k) => SOURCE_ACQUISITION[k].entry === "lead_scraping_cron" && SOURCE_ACQUISITION[k].routeChannel)
  const unwritten = postCron.filter((k) => !writes(SOURCE_ACQUISITION[k].routeChannel!))
  check(`every post-intent cron lane writes raw rows under its channel → the same processRawRecord path (${postCron.length - unwritten.length}/${postCron.length})`, unwritten.length === 0, unwritten.join(", "))
}

// ── C2 · BatchData catalogue ─────────────────────────────────────────────────
console.log("\n[C2 · BATCHDATA — every published quickList judged; triggers, investor lists, defaults, stacking]")
{
  const catalogued = new Set(Object.keys(BATCHDATA_QUICKLIST_CATALOGUE))
  const unjudged = [...BATCHDATA_QUICKLISTS].filter((s) => !catalogued.has(s))
  const phantom = [...catalogued].filter((s) => !BATCHDATA_QUICKLISTS.has(s))
  check(`the catalogue judges EVERY published quickList (${BATCHDATA_QUICKLISTS.size}) and names no phantom`, unjudged.length === 0 && phantom.length === 0, `unjudged=${unjudged.join(",")} phantom=${phantom.join(",")}`)
  check("POSITIVE CONTROL: a flag left out of a catalogue copy is detected", (() => { const copy: Record<string, unknown> = { ...BATCHDATA_QUICKLIST_CATALOGUE }; delete copy["tax-default"]; return [...BATCHDATA_QUICKLISTS].some((s) => !(s in copy)) })())
  check("every entry names a use and a why", Object.values(BATCHDATA_QUICKLIST_CATALOGUE).every((e) => !!e.use && e.why.trim().length > 10))
  const sellerEntries = Object.entries(BATCHDATA_QUICKLIST_CATALOGUE).filter(([, e]) => e.use === "seller_trigger")
  const badSeller = sellerEntries.filter(([slug, e]) => !e.trigger || !(BATCHDATA_MOTIVATION_TYPES as readonly string[]).includes(e.trigger) || quickListSlugsFor([e.trigger])[0] !== slug || triggerForQuickListSlug(slug) !== e.trigger)
  check(`every seller_trigger entry (${sellerEntries.length}) is a pullable BATCHDATA_MOTIVATION_TYPE whose slug round-trips both ways`, badSeller.length === 0, badSeller.map(([s]) => s).join(","))
  const uncatalogued = (BATCHDATA_MOTIVATION_TYPES as readonly string[]).filter((t) => !sellerEntries.some(([, e]) => e.trigger === t))
  check(`…and every BATCHDATA_MOTIVATION_TYPE (${BATCHDATA_MOTIVATION_TYPES.length}) has a seller_trigger entry (bidirectional)`, uncatalogued.length === 0, uncatalogued.join(","))
  const investorEntries = Object.entries(BATCHDATA_QUICKLIST_CATALOGUE).filter(([, e]) => e.use === "investor_buyer")
  check(`every investor_buyer entry (${investorEntries.length}) is in BATCHDATA_INVESTOR_BUYER_TYPES, never a seller trigger, slug round-trips`,
    investorEntries.every(([slug, e]) => !!e.trigger && isInvestorBuyerTrigger(e.trigger) && !(BATCHDATA_MOTIVATION_TYPES as readonly string[]).includes(e.trigger) && quickListSlugsFor([e.trigger])[0] === slug)
    && (BATCHDATA_INVESTOR_BUYER_TYPES as readonly string[]).every((t) => investorEntries.some(([, e]) => e.trigger === t)))
  const defaults = sellerEntries.filter(([, e]) => e.defaultOn).map(([, e]) => e.trigger!).sort()
  check("`defaultOn` names EXACTLY the unconfigured-market trio (batchDataTriggersFor(undefined)) — the two vocabularies agree",
    JSON.stringify(defaults) === JSON.stringify([...batchDataTriggersFor(undefined)].sort()), `${defaults.join(",")} vs ${batchDataTriggersFor(undefined).join(",")}`)
  check("every new trigger is OPT-IN (not in the default trio, not in DEFAULT_MARKET_SOURCES' pull)",
    ["free_and_clear", "out_of_state_owner", "corporate_owned", "trust_owned", "low_equity", "vacant_lot"].every((t) => !batchDataTriggersFor(undefined).includes(t) && quickListCatalogueForTrigger(t)?.defaultOn === false))
  check("entity owners (corporate / trust) are DEFAULT OFF with the gate reason recorded (the lead gate refuses entity names)",
    /gate refuses/i.test(quickListCatalogueForTrigger("corporate_owned")?.why ?? "") && quickListCatalogueForTrigger("trust_owned")?.defaultOn === false)
  const unmapped = (BATCHDATA_MOTIVATION_TYPES as readonly string[]).filter((t) => !STACK_FAMILY[t])
  check("every trigger (old and new) has a stacking family", unmapped.length === 0, unmapped.join(","))
  check("free_and_clear / out_of_state_owner / entity / low_equity / land are ENABLERS (alone they start no stack; with a distress family they tier up)",
    stackSignals(["free_and_clear", "out_of_state_owner", "trust_owned", "low_equity", "vacant_lot"]).count === 0 && stackSignals(["tax_lien", "free_and_clear"]).count === 2 && stackSignals(["pre_foreclosure", "low_equity"]).count === 2)
  check("out_of_state_owner is the SAME family as absentee (one owner, one fact) and free_and_clear the same as high_equity",
    stackSignals(["tax_lien", "absentee", "out_of_state_owner"]).count === 2 && stackSignals(["tax_lien", "high_equity", "free_and_clear"]).count === 2)
  check("config spellings resolve (free-and-clear / out-of-state-owner / in-state-absentee-owner→absentee / llc_owned / underwater / land)",
    JSON.stringify(batchDataTriggersFor(["free-and-clear", "out-of-state-owner", "in-state-absentee-owner", "llc_owned", "underwater", "land"])) === JSON.stringify(["free_and_clear", "out_of_state_owner", "absentee", "corporate_owned", "low_equity", "vacant_lot"]))
  check("POSITIVE CONTROL: fix_and_flip / cash_buyer NEVER enter a seller pull (dropped → default trio)", JSON.stringify(batchDataTriggersFor(["fix_and_flip", "cash_buyer"])) === JSON.stringify(["high_equity", "pre_foreclosure", "absentee"]))
  const stackedRow = normalizeBatchDataRecord(normalizeBatchDataProperty({ address: { street: "2 Elm", city: "Austin", state: "TX" }, owner: { fullName: "Sam Seller" }, quickLists: { taxDefault: true, cashBuyer: true, fixAndFlip: true, freeAndClear: true, trustOwned: true } }, "tax_lien") as Record<string, unknown>, MARKET)
  const sig = stackedRow.intentSignals
  check("a seller pull stamps the new co-occurring triggers (free_and_clear, trust_owned) and never the investor-buyer lists (cash_buyer, fix_and_flip)",
    sig.includes("free_and_clear") && sig.includes("trust_owned") && !sig.includes("cash_buyer") && !sig.includes("fix_and_flip"), sig.join(","))
  // Re-anchored (wave 93, lane 93B — "one pull"): every list is pulled ONCE per cycle for every territory
  // (the pooled want names all of BATCHDATA_INVESTOR_BUYER_TYPES; the pool pulls one per list — the
  // list labels its records), and each territory books ITS share. The rule held: every list, stamped, costed.
  check("the cron pulls EVERY investor-buyer list under batchdata_cash_buyer (one pooled pull per list, stamped with its list) and books the territory's cost per source",
    /triggers: \[\.\.\.BATCHDATA_INVESTOR_BUYER_TYPES\]/.test(route) && /runPooledBatchDataLane\("batchdata_cash_buyer", cashWants, bdDeps\)/.test(route)
    && /intentSignals: \[list, "investor"\]/.test(route) && /list: String\(raw\.motivationType\)/.test(route) && /source: "batchdata_cash_buyer", cost: investorCostUsd/.test(route))
  const page = stripped("app/dashboard/admin/markets/page.tsx")
  check("the admin 'Motivated signals' picker still DERIVES its options from BATCHDATA_MOTIVATION_TYPES (every new trigger is toggleable with no second edit)", /BATCHDATA_MOTIVATION_TYPES\.filter\(\(t\) => t !== "expired"\)/.test(page))
  // Lane 90B — quickListCatalogueForTrigger was exported as "the admin picker's caption source" and no
  // picker read it (orphan census, category A). The RULE: the options builder reads it per BatchData
  // trigger and the client renders the caption; every picker option resolves to a judged entry.
  const pickerClient = stripped("app/dashboard/admin/markets/markets-client.tsx")
  const optionsAt = page.indexOf("const MOTIVATED_SIGNAL_OPTIONS")
  check("the picker's options builder reads quickListCatalogueForTrigger(value) for each BatchData trigger (caption / quickList / defaultOn)",
    optionsAt > 0 && page.indexOf("quickListCatalogueForTrigger(value)", optionsAt) > optionsAt && /caption:\s*entry\?\.why \?\? null/.test(page) && /quickList:\s*entry\?\.quickList \?\? null/.test(page))
  check("…and the client renders the caption per trigger (o.caption) beside the published quickList (o.quickList)", /\{o\.caption \?/.test(pickerClient) && /o\.quickList/.test(pickerClient))
  const pickerTriggers = (BATCHDATA_MOTIVATION_TYPES as readonly string[]).filter((t) => t !== "expired")
  const captionless = pickerTriggers.filter((t) => !(quickListCatalogueForTrigger(t)?.why ?? "").trim())
  check(`every picker trigger resolves to a judged catalogue entry with a caption (${pickerTriggers.length - captionless.length}/${pickerTriggers.length})`, captionless.length === 0, captionless.join(","))
  check("POSITIVE CONTROL: a trigger with no quickList resolves to null (the picker would show no caption, never a fabricated one)", quickListCatalogueForTrigger("divorce") === null && quickListCatalogueForTrigger("time_travel") === null)
  check("POSITIVE CONTROL: the finder flags a builder that ignores the catalogue", !/quickListCatalogueForTrigger\(value\)/.test(`BATCHDATA_MOTIVATION_TYPES.filter((t) => t !== "expired").map((value) => ({ value, source: "batchdata" as const }))`))
  check(`each pull is booked at the published per-record price ($${BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD}); the catalogue prices FSBO against the cheaper lane`, BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD === 0.05 && /fsbo_site_listing/.test(BATCHDATA_QUICKLIST_CATALOGUE["for-sale-by-owner"].why))
}

// ── C3 · Exa as a lead source ────────────────────────────────────────────────
console.log("\n[C3 · EXA — every population per territory, produced not just declared]")
{
  const declared = SOURCE_ACQUISITION.exa_buyer_intent.intents
  check(`SOURCE_ACQUISITION.exa_buyer_intent declares all five populations (${declared.join("/")})`, INTENTS.every((i) => declared.includes(i)))
  const qs = buildExaIntentQueries(MARKET)
  check(`buildExaIntentQueries renders ≥1 and ≤${EXA_QUERIES_PER_POPULATION} queries per DECLARED population, all carrying the territory`,
    declared.every((i) => { const n = qs.filter((q) => q.population === i).length; return n >= 1 && n <= EXA_QUERIES_PER_POPULATION }) && qs.every((q) => q.query.includes("Austin, TX")))
  check("POSITIVE CONTROL: a market with no city and no state yields ZERO queries (territory-honest)", buildExaIntentQueries({ city: null, state: null }).length === 0)
  const fx = (text: string, i: number) => normalizeExaResult({ id: `e${i}`, url: `https://forum.example/${i}`, title: text, text, author: "janeroe", publishedDate: "2026-09-01" }, MARKET)
  const producers: Record<AcquisitionIntent, string> = {
    sell: "Thinking of selling my house in Austin — what is my home worth? For sale by owner maybe.",
    buy: "We are pre-approved and house hunting in Austin, first time home buyers.",
    relocate: "Relocating to Austin for a new job in January, need to buy a home.",
    realtor_seeking: "Looking for a realtor in Austin — any recommendations for a real estate agent?",
    investor: "Real estate investor looking for a rental property or a fix and flip in Austin, cash buyer.",
  }
  const unproduced = INTENTS.filter((i) => !recordAcquisitionIntents(fx(producers[i], INTENTS.indexOf(i))).includes(i))
  check(`normalizeExaResult PRODUCES each population from its own text (${INTENTS.length - unproduced.length}/${INTENTS.length})`, unproduced.length === 0, unproduced.join(","))
  check("POSITIVE CONTROL: noise produces no population", recordAcquisitionIntents(fx("love this song", 9)).length === 0)
  check("a seller result is a SELLER record and the map-level lead type is 'unknown' (a seller no longer promotes as buyer)",
    fx(producers.sell, 0).intentType === "seller" && SOURCE_MAP.exa_buyer_intent.leadType === "unknown" && SOURCE_MAP.exa_buyer_intent.intentType === "unknown")
  check("seller / realtor-seeking / investor signals now BOOST the Exa lane's score", calculateSourceScore("exa_buyer_intent", ["selling", "must_sell"]) > calculateSourceScore("exa_buyer_intent", []) && calculateSourceScore("exa_buyer_intent", ["need_a_realtor"]) > calculateSourceScore("exa_buyer_intent", []))
  check("the SourceKey / vendor / gate token are unchanged (ledger continuity): exa_buyer_intent → exa", SOURCE_VENDOR.exa_buyer_intent === "exa" && expandEnabledSources(["exa_buyer_intent"]).has("exa") && resolveSourceKey("exa") === "exa_buyer_intent")
  check(`list-price fallback: ${EXA_SEARCH_INCLUDED_RESULTS} results = $${EXA_SEARCH_REQUEST_COST_USD}, 20 results = $0.017 (was 0.005 × rows = $0.10)`,
    exaSearchListCost(10) === EXA_SEARCH_REQUEST_COST_USD && Math.abs(exaSearchListCost(20) - 0.017) < 1e-9 && exaSearchListCost(0) === EXA_SEARCH_REQUEST_COST_USD && EXA_RESULTS_PER_QUERY === EXA_SEARCH_INCLUDED_RESULTS)
  const exaClient = stripped("lib/external/exa-client.ts")
  check("exaSearch uses the provider's own costDollarsTotal when present and the list-price fallback otherwise (no 0.005 × rows)", /exaSearchListCost\(params\.numResults \?\? rows\.length\)/.test(exaClient) && !/0\.005 \* rows\.length/.test(exaClient))
  check("POSITIVE CONTROL: the old fallback shape is recognisable", /0\.005 \* rows\.length/.test(`cost: 0.005 * rows.length`))
  await (async () => {
    const saved = process.env.EXA_API_KEY
    delete process.env.EXA_API_KEY
    const r = await sourceExaBuyerIntent(MARKET)
    if (saved !== undefined) process.env.EXA_API_KEY = saved
    check("no EXA_API_KEY ⇒ no call, no records, $0 (fail closed)", r.records.length === 0 && r.cost === 0)
  })()
}

// ── C4 · FSBO marketplace lane ───────────────────────────────────────────────
console.log("\n[C4 · FSBO MARKETPLACE — the cheaper FSBO population, opt-in, every registry]")
{
  check("fsbo_site_listing is a SourceKey in every registry (SOURCE_MAP / SOURCE_VENDOR / SOURCE_ACQUISITION / SCRAPE_KEYWORD_POLICY / SOURCE_PAID_PERSON_DATA)",
    KEYS.includes("fsbo_site_listing") && SOURCE_VENDOR.fsbo_site_listing === "apify" && SOURCE_ACQUISITION.fsbo_site_listing.intents.includes("sell") && SCRAPE_KEYWORD_POLICY.fsbo_site_listing.reads === false && SOURCE_PAID_PERSON_DATA.fsbo_site_listing === false)
  check("it is its OWN gate token and OPT-IN (not in DEFAULT_MARKET_SOURCES); aliases resolve", expandEnabledSources(["fsbo_site_listing"]).has("fsbo_site_listing") && !DEFAULT_MARKET_SOURCES.includes("fsbo_site_listing") && resolveSourceKey("forsalebyowner") === "fsbo_site_listing")
  check("ACTOR_REGISTRY.fsbo_site has ≥2 candidates, memo23 (by-city, monitoring mode) first", ACTOR_REGISTRY.fsbo_site?.length >= 2 && ACTOR_REGISTRY.fsbo_site[0] === "memo23/forsalebyowner-scraper")
  const owner = normalizeFsboSiteListing({ id: "L1", url: "https://www.forsalebyowner.com/listing/L1", addressLine1: "12 Oak St", city: "Austin", state: "TX", zip: "78704", priceAmount: "425000", listedBy: "Jane Roe", ownerPhone: "(512) 555-0142", ownerFinancing: true, status: "for_sale", description: "Price reduced! Owner financing available." }, MARKET)
  check("an owner listing → seller, fsbo/by_owner + owner_financing + price_reduced signals, name split, phone kept, address anchored",
    owner.source === "fsbo_site_listing" && owner.intentType === "seller" && owner.firstName === "Jane" && owner.lastName === "Roe" && owner.phone === "(512) 555-0142" && owner.propertyAddress === "12 Oak St" && ["fsbo", "by_owner", "owner_financing", "price_reduced"].every((s) => owner.intentSignals.includes(s)))
  check("…and it is NOT paid person data (the phone is scraped, never sold) → PeopleData still runs", owner.paidPersonData !== true)
  const agent = normalizeFsboSiteListing({ id: "L2", listedBy: "Sam Realty Group", title: "Just listed by your Realtor", status: "sold" }, MARKET)
  check("POSITIVE CONTROL: an agent-posted / sold card is DAMPED (agent_listing + sold), never scored as an owner", agent.intentSignals.includes("agent_listing") && agent.intentSignals.includes("sold") && !agent.intentSignals.includes("owner"))
  check("a short/junk phone is dropped, never stored", normalizeFsboSiteListing({ id: "L3", listedBy: "Jo Bloggs", phone: "555" }, MARKET).phone === undefined)
  await (async () => {
    // Wave 93 (lane 93B): the sourcer takes a LIST of locations (one actor run for every territory).
    const r1 = await sourceFsboSiteListings([{ city: "", state: "" }])
    const r2 = await scrapeFsboSiteListings({ city: "", state: "TX" })
    check("no territory city/state ⇒ no call, $0 (both the sourcer and the client)", r1.records.length === 0 && r1.cost === 0 && r2.listings.length === 0 && r2.cost === 0)
  })()
  check("the slug uses the site's own city-state form via stateNameFromCode (TX → texas)", stateNameFromCode("TX") === "Texas" && stateNameFromCode("zz") === null)
  const loopAt = route.indexOf("for (const market of markets)")
  const gateAt = route.indexOf('enabledSources.has("fsbo_site_listing")')
  // Re-anchored (wave 93, lane 93B — "one pull"): the actor runs ONCE per cycle for every territory in
  // the pooled phase (runPooledFsboLane → sourceFsboSiteListings(locations), slugs via stateNameFromCode);
  // the loop still gates the source per territory and writes ITS share with ITS cost.
  check("the cron gates it INSIDE the resolved-territory loop and writes its channel with the batch cost (pooled: one run for every territory)",
    gateAt > loopAt && loopAt > 0 && /await insertSocial\(records, "fsbo_site_listing", "social_intent", cost\)/.test(route)
    && /runPooledFsboLane\(fsboMarkets, \{ run: \(locations\) => sourceFsboSiteListings\(locations\) \}, stateNameFromCode\)/.test(route)
    && /const fsboShare = pooled\.fsbo\.get\(market\.id\)/.test(route))
  check("the social block's enable set includes it (a market that opts in only to this lane still runs the block)", /enabledSources\.has\("fsbo_site_listing"\)\s*\n/.test(route.slice(route.indexOf("const socialSourcesEnabled ="), route.indexOf("if (socialSourcesEnabled)"))))
}

// ── C6 · lane 90B — the automated-mailbox rule runs BEFORE any spend, in ONE place ───────────────
console.log("\n[C6 · NOREPLY COST LEAK — THE gate's email rule is applied before the classifier and before PeopleData]")
{
  // The base rule matched the local part EXACTLY — this inline copy of it is the positive control
  // (it must still miss what the rule now catches).
  const baseExactRule = (email: string) => AUTOMATED_LOCAL_PARTS.has(email.split("@")[0].toLowerCase())
  const leaks = ["esignature-noreply@google.com", "noreply-dmarc@x.io", "notifications-noreply@bank.example", "no_reply@x.io", "noreply+abc123@shop.example", "bounces.jane@x.io"]
  check("isAutomatedLocalPart catches exact / separator-collapsed / token-wise automated parts (6 shapes the base rule passed)",
    leaks.every((e) => isAutomatedLocalPart(e.split("@")[0])) && leaks.every((e) => leadEmailProblem(e) === "automated_mailbox"), leaks.filter((e) => leadEmailProblem(e) !== "automated_mailbox").join(","))
  check("POSITIVE CONTROL: the base exact-match rule misses every one of them (the leak lane 89E §7 named)", leaks.every((e) => !baseExactRule(e)) && baseExactRule("noreply@x.io"))
  check("…and real people still pass: jane.doe@, j-p.smith@, info@ (role), maria_gonzalez+home@", ["jane.doe@gmail.com", "j-p.smith@x.io", "info@smithhomes.com", "maria_gonzalez+home@x.io"].every((e) => leadEmailProblem(e) === null))
  // The unknown-sender PREFILTER calls THE rule (no second syntax/automated test of its own).
  const { preFilterAutomatedSender } = await import("../lib/lead-pipeline/unknown-sender-identification")
  const pre = preFilterAutomatedSender({ fromEmail: "esignature-noreply@google.com" })
  check("preFilterAutomatedSender drops esignature-noreply@google.com as automated_local_part BEFORE any model call (was: passed to the classifier + PDL)", pre.isAutomated && pre.reason === "automated_local_part")
  check("…and a disposable mailbox (mailinator) is dropped up front as disposable_domain; invalid syntax still reads invalid_syntax; a person passes",
    preFilterAutomatedSender({ fromEmail: "x@mailinator.com" }).reason === "disposable_domain" && preFilterAutomatedSender({ fromEmail: "jane@gmail" }).reason === "invalid_syntax" && !preFilterAutomatedSender({ fromEmail: "jane.doe@gmail.com" }).isAutomated)
  const unknownMod = stripped("lib/lead-pipeline/unknown-sender-identification.ts")
  const preAt = unknownMod.indexOf("export function preFilterAutomatedSender(")
  const preBody = unknownMod.slice(preAt, unknownMod.indexOf("return { isAutomated: false, reason: null }", preAt))
  check("the prefilter's syntax/disposable/automated verdict IS leadEmailProblem (one call), with no file-local EMAIL_RE or AUTOMATED_LOCAL_PARTS.has test left",
    /const problem = leadEmailProblem\(email\)/.test(preBody) && !/EMAIL_RE\.test/.test(preBody) && !/AUTOMATED_LOCAL_PARTS\.has/.test(preBody))
  const orchAt = unknownMod.indexOf("export async function identifyAndRouteUnknownSender(")
  const preCall = unknownMod.indexOf("preFilterAutomatedSender(", orchAt)
  const classifyCall = unknownMod.indexOf("classifyUnknownSenderIntent", orchAt)
  const landCall = unknownMod.indexOf("landUnknownSenderRaw)(", orchAt)
  check("order inside identifyAndRouteUnknownSender: prefilter → classifier → raw landing (enrichment) — the rejection sits before both spends", orchAt > 0 && preCall > orchAt && classifyCall > preCall && landCall > classifyCall)
  // The RAW pipeline (every scraped source) applies the same rule to its enrichment anchor.
  const pp = stripped("lib/lead-pipeline/pipeline-processor.ts")
  const fnAt = pp.indexOf("export async function processRawRecord(")
  const usableAt = pp.indexOf("const usableEmail        = emailProblem === null ? email : null", fnAt)
  const enrichAt = pp.indexOf("await enrichWithPeopleData(", fnAt)
  const dedupAt = pp.indexOf("const preEnrichLookup =", fnAt)
  check("processRawRecord decides usableEmail = leadEmailProblem(email) === null BEFORE the pre-enrich dedup and BEFORE enrichWithPeopleData",
    usableAt > fnAt && dedupAt > usableAt && enrichAt > dedupAt)
  check("…the anchor, the dedup lookup and the enrichment call read usableEmail; the promotion gate still sees the raw address (`enriched.email ?? email`) so its reason stays honest",
    /const hasEmail\s*=\s*!!usableEmail\?\.trim\(\)/.test(pp) && /const preEnrichLookup = \{ first_name: firstName, last_name: lastName, email: usableEmail, phone \}/.test(pp)
    && /first_name: firstName, last_name: lastName, email: usableEmail, phone, city, state,/.test(pp) && /email:\s*enriched\.email \?\? email,/.test(pp))
  check("POSITIVE CONTROL: the finder flags the old shape (email handed straight to enrichment)", /email, phone, city, state,/.test(`first_name: firstName, last_name: lastName, email, phone, city, state,`) && !/email: usableEmail/.test(`email, phone, city, state,`))
}

// ── C7 · lane 90B — the platform cost follows the person raw → lead → contact ────────────────────
console.log("\n[C7 · SOURCE COST LEDGER — cost_per_record is written at EVERY hop, and lead intelligence reads it]")
{
  const pp = stripped("lib/lead-pipeline/pipeline-processor.ts")
  const promoter = stripped("lib/lead-promotion/lead-promoter.ts")
  const leadInsertAt = pp.indexOf(".from('leads')\n    .insert({")
  const leadInsert = pp.slice(leadInsertAt, pp.indexOf(".select()", leadInsertAt))
  check("pipeline-processor's lead insert carries cost_per_record from the raw row (the writerless hop: the column was read by contact-creator + person-timeline and written by nobody)",
    leadInsertAt > 0 && /cost_per_record:\s*rec\.cost_per_record \?\? null/.test(leadInsert))
  check("lead-promoter (the hand-promotion door) selects and inserts it too (parity)", /first_name, last_name, email, phone, cost_per_record'\)/.test(promoter) && /cost_per_record:\s*\(rawRecord as any\)\?\.cost_per_record/.test(promoter))
  check("POSITIVE CONTROL: an insert without the column is flagged by the same finder", !/cost_per_record:\s*rec\.cost_per_record/.test(`.from('leads').insert({ source: rec.source, raw_record_id: rawRecordId })`))
  const kernel = stripped("lib/kernel/scraping.ts")
  const contactCreator = stripped("lib/contact-promotion/contact-creator.ts")
  const timeline = stripped("lib/lead-intelligence/person-timeline.ts")
  check("the chain is closed: raw (ingestRawSourceBatch stamps cost_per_record) → lead (above) → contact (contact-creator carries data.lead.cost_per_record) → lead intelligence (person-timeline reads raw + lead cost_per_record and the vendor ledger)",
    /cost_per_record:\s*costPerRecord/.test(kernel) && /cost_per_record:\s*data\.lead\.cost_per_record \?\? null/.test(contactCreator)
    && /cost_per_record, acquisition_cost, raw_record_id/.test(timeline) && /costPerRecord: r\.cost_per_record \?\? null/.test(timeline) && /platformPaidAcquisitionCost/.test(timeline))
  // Every cron source's spend is stamped per record — the same finder the coverage guard uses (L5), re-run
  // here so the two proofs cannot drift: a paid cron source whose write carries `batchCostUsd: null` is a gap.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const carriesCost = (ch: string) => {
    const c = esc(ch)
    const ins = new RegExp(`insertSocial\\(\\s*[\\w.]+\\s*,\\s*${c}\\s*,\\s*"[a-z_]+"\\s*,\\s*([^,)]+)`).exec(route)
    if (ins) return ins[1].trim() !== "null"
    const at = route.search(new RegExp(`sourceChannel:\\s*${c}\\s*[,}]`))
    if (at < 0) return false
    const m = /batchCostUsd:\s*([^,\n]+)/.exec(route.slice(at, route.indexOf("})", at)))
    return !!m && m[1].trim() !== "null"
  }
  const paidCron = KEYS.filter((k) => SOURCE_VENDOR[k] !== "internal" && SOURCE_ACQUISITION[k].entry === "lead_scraping_cron" && SOURCE_ACQUISITION[k].routeChannel)
  const costless = paidCron.filter((k) => !carriesCost(SOURCE_ACQUISITION[k].routeChannel!))
  check(`every paid cron source stamps its batch cost per raw row (${paidCron.length - costless.length}/${paidCron.length})`, costless.length === 0, costless.join(","))
  check("the BatchData pulls keep the pull's FULL cost when the listing-status window drops stale rows (billed rows are booked; the ledger never under-reports)", /cost: r\.cost, staleDropped: r\.records\.length - fresh\.length/.test(stripped("lib/external/batchdata-client.ts")))
  console.log("\n  SOURCE MATRIX (source · territory · dedup · enrichment · cost/record · scheduled) — derived from the registries")
  for (const k of KEYS) {
    const a = SOURCE_ACQUISITION[k]
    const territory = a.entry === "lead_scraping_cron" ? "cron-loop" : a.entry === "batchdata_push" ? "push-match" : a.entry === "intent_campaign" ? "own-territory" : "own-mailbox"
    const enrich = SOURCE_PAID_PERSON_DATA[k] ? "vendor_delivered" : "peopledata"
    console.log(`    ${k.padEnd(28)} ${territory.padEnd(13)} ${(a.routeChannel === null && SOURCE_VENDOR[k] === "internal" && a.entry === "lead_scraping_cron" ? "signal-only" : "raw+lead+contact").padEnd(17)} ${enrich.padEnd(17)} ${(SOURCE_VENDOR[k] === "internal" ? "$0" : "stamped").padEnd(8)} ${a.entry === "lead_scraping_cron" || a.entry === "intent_campaign" ? "dispatcher" : "event"}`)
  }
}

// ── C5 · registration ────────────────────────────────────────────────────────
console.log("\n[C5 · registration]")
{
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
  const guard = pkg.scripts.guard ?? ""
  check("package.json registers test:lead-source-catalogue", pkg.scripts["test:lead-source-catalogue"] === "tsx scripts/lead-source-catalogue-guard.ts")
  check("guard runs it AFTER test:scrapers (ordering only)", guard.indexOf("npm run test:scrapers") >= 0 && guard.indexOf("npm run test:lead-source-catalogue") > guard.indexOf("npm run test:scrapers"))
  check("MAINTENANCE_DOMAINS owns it with coOwners", /lead_source_catalogue:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:lead-source-catalogue",\s*coOwners:/.test(read("lib/kernel/manager-registry.ts")))
  check("no migration was needed: the new sources are opt-in (DEFAULT_MARKET_SOURCES unchanged in shape) and none reads a keyword type", !DEFAULT_MARKET_SOURCES.includes("fsbo_site_listing") && SCRAPE_KEYWORD_POLICY.fsbo_site_listing.reads === false)
}

console.log(`\n  denominators: ${KEYS.length} SourceKeys · ${KEYS.filter((k) => SOURCE_PAID_PERSON_DATA[k]).length} paid-person-data sources · ${BATCHDATA_QUICKLISTS.size} published quickLists (${Object.values(BATCHDATA_QUICKLIST_CATALOGUE).filter((e) => e.use === "seller_trigger").length} seller triggers · ${BATCHDATA_INVESTOR_BUYER_TYPES.length} investor lists · ${Object.values(BATCHDATA_QUICKLIST_CATALOGUE).filter((e) => e.use === "fact_filter").length} facts · ${Object.values(BATCHDATA_QUICKLIST_CATALOGUE).filter((e) => e.use === "listing_feed").length} feed · ${Object.values(BATCHDATA_QUICKLIST_CATALOGUE).filter((e) => e.use === "farm").length} farm) · ${BATCHDATA_MOTIVATION_TYPES.length} BatchData triggers · ${buildExaIntentQueries(MARKET).length} Exa queries/territory`)
console.log("  blind spots: whether a live BatchData account is LICENSED for the contact dataset is only measurable with a paid call (no network here) — an unlicensed account stamps paid_person_data:false and PeopleData runs as before; the FSBO actors' field names are read from their store pages, not a live run; the enrichment DRAIN's own PeopleData demographics leg (enrichment-orchestrator Step 5b, post-lead) is unchanged and still bills per match")
console.log(`\n${"─".repeat(50)}\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ LEAD_SOURCE_CATALOGUE_FAIL"); process.exit(1) }
console.log(" ✅ LEAD_SOURCE_CATALOGUE_PASS")
