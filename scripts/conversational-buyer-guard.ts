#!/usr/bin/env tsx
/**
 * scripts/conversational-buyer-guard.ts   (npm run test:conversational-buyer — no network, no live DB)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 147, LANE 147C — the Deli-inspired conversational buyer experience, INSIDE the existing
 * buyer search (owner ruling 16, contract C10). Proves the journey end to end on pure functions
 * and an in-memory supabase (scripts/in-memory-supabase.ts):
 *
 *   A  natural language (typed or spoken) → criteria + lifestyle asks + deal-breakers + the
 *      "what you didn't say" questions; the questions can never ask a protected-class question
 *   B  the turn merge: per-field provenance (said | inferred | default), a reason quoting the
 *      buyer, refinement semantics (refine / also / instead), buyer words outrank behaviour
 *   C  THE ONE STORE: saveBuyerCriteria / loadBuyerCriteria round trip; a said value survives the
 *      behaviour learner overwriting its column (and the override is reported); m895 not applied
 *      degrades BY NAME; a foreign-tenant row and an update matching nothing are refused
 *   D  explainable match { matches, misses, unknowns }: every match/miss has a data source, every
 *      unknown has none — and UNKNOWNS ARE NEVER RENDERED AS FACTS (the neighbourly explanation,
 *      the voice turn and the model-draft validator all hold the line), with positive controls
 *   E  search composition: stored criteria fill what a query left unsaid; the query wins; the
 *      refined shortlist moves when the criteria move
 *   F  feedback → learning: saved / dismissed / toured / a note become changes WITH REASONS; a
 *      said field only receives a PROPOSAL; deal-breakers are never learned silently; a rejected
 *      value is never re-proposed; accept / undo behave
 *   G  showing / agent action: the agent hears material changes and tour asks, not keystrokes; the
 *      bus dedupes to one open signal per contact; next-best experiences map to existing surfaces
 *   H  wiring over COMMENT-STRIPPED source (CLAUDE.md §2), each with a positive control
 *   I  prompt quality: both LLM prompts carry role / context / facts / must-not / decision /
 *      output contract / escalation (a one-line prompt fails the checker)
 *
 * BLIND SPOTS (published, §2): no live search runs here (searchPropertiesCore builds its own
 * service client — buyer-nl-search-simulator.ts Layer 2 covers the live path when creds exist);
 * the model calls are not exercised (no tenant/key in a proof — the deterministic fallbacks and the
 * validators that guard the model's output are); the browser speech APIs are not driven (the voice
 * turn PLAN is); the compliance-exemption check reads DIRECT imports of the two filter files only
 * (scripts/compliance-scope-simulator.ts walks the full graph).
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"
import { parseBuyerCriteria } from "../lib/buyer-search/parse-buyer-criteria"
import { clarifyingQuestions, extractLifestyleAsks, detectStatedDealBreakers, detectSupplementalCity, extractCriteriaFromTranscript, type ConversationCriteria } from "../lib/buyer-search/conversation-criteria"
import {
  loadBuyerCriteria, saveBuyerCriteria, recordCriteriaChanges, settleCriteriaChange, provenanceOf,
  type BuyerCriteria,
} from "../lib/buyer-search/buyer-criteria"
import {
  applyConversationTurn, learnFromBehaviour, applyLearnedChanges, applyAcceptedChange, revertChange, applyCorrection,
  shouldNotifyAgent, criteriaChips, nextBestExperiences, voiceTurnPlan, narrateFitExplanation,
  intentWithStoredCriteria, fitCriteriaFor, emptyCriteria, EXPLANATION_SYSTEM, type HomeSignal,
} from "../lib/buyer-search/conversational-search"
import { explainCriteriaFit, composeNeighbourlyExplanation, numbersAreGrounded, restatesUnknown, type ListingFitFacts } from "../lib/buyer-search/explanation-generator"
import { BUYER_SHOPPABLE_LISTING_STATUSES } from "../lib/buyer-search/search-engine"
import { parseNaturalLanguageQuery } from "../lib/buyer-search/intent-parser"
import { scanFairHousing } from "../lib/buyer-search/fair-housing"

const root = process.cwd()
const code = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))
let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const AT = "2026-10-31T12:00:00.000Z"
const BRK = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const CONTACT = "33333333-3333-4333-8333-333333333333"
/** Protected-class / steering vocabulary no question or explanation WE author may carry. */
const PROTECTED = /\b(kids?|children|family|families|school|schools|church|temple|mosque|synagogue|religio\w*|race|racial|ethnic\w*|national origin|disab\w*|age|older|senior|young|couple|married|single (?:mom|dad|parent)|safe|safety|crime|demographic\w*)\b/i

async function main() {
  console.log("\n CONVERSATIONAL BUYER (wave 147C, contract C10)\n")

  // ── A ─────────────────────────────────────────────────────────────────────
  console.log("[A · natural language / voice → criteria, lifestyle, deal-breakers, what you didn't say]")
  const SAID = "3 bed under 600k in Frisco TX with lots of natural light, an open floor plan, less yard, and an easy commute to Plano Medical Center under 30 minutes. No HOA please."
  const p1 = await parseBuyerCriteria(SAID, { brokerageId: null, allowModelAssist: false })
  check("price / beds / city / state captured from the buyer's words", p1.criteria.maxPrice === 600000 && p1.criteria.minBeds === 3 && (p1.criteria.cities ?? []).includes("Frisco") && p1.criteria.state === "TX", JSON.stringify(p1.criteria))
  const kinds = p1.lifestyle.map((l) => `${l.kind}/${l.direction}`)
  check("lifestyle asks: natural light (more), open floor plan, outdoor space (less), commute with target + 30 min", kinds.includes("natural_light/more") && p1.lifestyle.some((l) => l.label === "open floor plan") && kinds.includes("outdoor_space/less")
    && p1.lifestyle.some((l) => l.kind === "commute" && l.target === "Plano Medical Center" && l.maxMinutes === 30), JSON.stringify(p1.lifestyle.map((l) => [l.kind, l.label, l.target, l.maxMinutes])))
  check("every lifestyle ask carries the buyer's literal words as evidence", p1.lifestyle.every((l) => l.evidence.length > 0 && SAID.includes(l.evidence.replace(/…$/, "").slice(0, 40))))
  check("deal-breaker captured from 'No HOA please'", p1.dealBreakers.includes("hoa"))
  check("no clarifying question when location, price and beds were all said", p1.clarifications.every((q) => !["location", "price", "beds"].includes(q.about)), JSON.stringify(p1.clarifications))
  const vague = await parseBuyerCriteria("something with lots of light", { brokerageId: null, allowModelAssist: false })
  check("'what you didn't say': a vague ask returns the location and price questions (text: at most 2)", vague.clarifications.length === 2 && vague.clarifications[0].about === "location" && vague.clarifications[1].about === "price", JSON.stringify(vague.clarifications))
  check("voice turn-taking: at most ONE question per spoken turn", clarifyingQuestions(vague.criteria, vague.lifestyle, { channel: "voice" }).length === 1)
  check("a commute with no destination asks where the commute is to", clarifyingQuestions({ cities: ["Frisco"], maxPrice: 1, minBeds: 3 }, extractLifestyleAsks("I hate a long commute"), { max: 5 }).some((q) => q.about === "commute_target"))
  check("a stated must-have is not asked again", !clarifyingQuestions({ cities: ["X"], maxPrice: 1, minBeds: 1, features: ["pool"] }, [], { text: "we need a pool", max: 5 }).some((q) => q.about === "must_or_nice"))
  // Every question the generator CAN return — exhaustively, over all gap combinations.
  const allQs = new Set<string>()
  for (const c of [{}, { listingType: "rent" as const }, { cities: ["X"] }, { cities: ["X"], maxPrice: 1 }, { features: ["garage"] }] as ConversationCriteria[]) {
    for (const q of clarifyingQuestions(c, extractLifestyleAsks("my commute matters"), { max: 10 })) allQs.add(q.question)
  }
  const badQ = [...allQs].filter((q) => PROTECTED.test(q) || scanFairHousing(q).flagged.length > 0)
  check(`no clarifying question touches a protected class or steering topic (${allQs.size} distinct questions scanned)`, allQs.size >= 5 && badQ.length === 0, badQ.join(" | "))
  check("POSITIVE CONTROL: the protected-topic finder catches a family/school question", PROTECTED.test("Do you have kids who need good schools?"))
  check("schools and places of worship are never captured as amenities (capture is not steering; there is no such kind)", extractLifestyleAsks("near good schools and close to my church").every((l) => l.kind !== "nearby_amenity"))
  check("a buyer-stated accessibility need is captured (said, never inferred)", extractLifestyleAsks("we need a step-free entry").some((l) => l.kind === "accessibility") && extractLifestyleAsks("3 bed in Austin").length === 0)
  check("'more light, less yard' is two refinements", (() => { const a = extractLifestyleAsks("more light, less yard"); return a.some((x) => x.kind === "natural_light" && x.direction === "more") && a.some((x) => x.kind === "outdoor_space" && x.direction === "less") })())
  check("'not a condo, no pool' → two deal-breakers", (() => { const d = detectStatedDealBreakers("not a condo, no pool").dealBreakers; return d.includes("condo") && d.includes("pool") })())
  check("PARSER FIX: 'in Frisco TX' keeps Frisco (the trailing state code no longer rejects the city); 'in Texas' is still no city", detectSupplementalCity("homes in Frisco TX") === "Frisco" && detectSupplementalCity("somewhere in Texas") === null)
  const neg = extractCriteriaFromTranscript("3 bed in Austin, no pool, less yard, and a garage")
  check("PARSER FIX: a negated feature is not a must-have ('no pool', 'less yard' dropped; 'a garage' kept)", !(neg.criteria.features ?? []).includes("pool") && !(neg.criteria.features ?? []).includes("yard") && (neg.criteria.features ?? []).includes("garage"), JSON.stringify(neg.criteria.features))
  check("POSITIVE CONTROL: an un-negated pool and yard are still must-haves", (() => { const f = extractCriteriaFromTranscript("3 bed in Austin with a pool and a yard").criteria.features ?? []; return f.includes("pool") && f.includes("yard") })())

  // ── B ─────────────────────────────────────────────────────────────────────
  console.log("\n[B · the turn: per-field provenance, reasons quoting the buyer, refinement semantics]")
  const t1 = applyConversationTurn(null, p1, { text: SAID, channel: "voice", at: AT, trigger: "stated" })
  const c1 = t1.next
  check("every stated field is provenance 'said' with the buyer's quote", (["maxPrice", "minBeds", "cities", "dealBreakers", "lifestyle"] as const).every((f) => c1.provenance?.[f]?.source === "said" && !!c1.provenance?.[f]?.evidence))
  check("every change is 'applied' (undoable) with a reason that quotes the buyer", t1.changes.length >= 5 && t1.changes.every((c) => c.status === "applied" && /^You said "/.test(c.reason)))
  check("listing type never stated → reads as 'default', not 'said'", provenanceOf(c1, "listingType") === "default")
  const p2 = await parseBuyerCriteria("actually under 550k, and light matters more than the yard now", { brokerageId: null, allowModelAssist: false })
  const t2 = applyConversationTurn(c1, p2, { text: "actually under 550k, and light matters more than the yard now", channel: "portal", at: AT, trigger: "stated" })
  check("a refinement overwrites the scalar and records previous → next", t2.next.maxPrice === 550000 && t2.changes.some((c) => c.field === "maxPrice" && c.previous === 600000 && c.proposed === 550000))
  check("a stated reprioritisation reorders the lifestyle asks (light first, yard last) as a priority_change", (t2.next.lifestyle ?? [])[0]?.kind === "natural_light" && (t2.next.lifestyle ?? []).slice(-1)[0]?.kind === "outdoor_space" && t2.changes.some((c) => c.trigger === "priority_change"))
  check("a turn never erases what it did not talk about (beds, city, HOA untouched)", t2.next.minBeds === 3 && t2.next.cities.includes("Frisco") && t2.next.dealBreakers.includes("hoa"))
  const t3 = applyConversationTurn(t2.next, await parseBuyerCriteria("also look in Plano", { brokerageId: null, allowModelAssist: false }), { text: "also look in Plano", channel: "portal", at: AT, trigger: "stated" })
  check("'also look in Plano' grows a said list", JSON.stringify(t3.next.cities) === JSON.stringify(["Frisco", "Plano"]), JSON.stringify(t3.next.cities))
  const t4 = applyConversationTurn(t3.next, await parseBuyerCriteria("just in McKinney instead", { brokerageId: null, allowModelAssist: false }), { text: "just in McKinney instead", channel: "portal", at: AT, trigger: "stated" })
  check("'just in McKinney instead' replaces the list", JSON.stringify(t4.next.cities) === JSON.stringify(["McKinney"]), JSON.stringify(t4.next.cities))
  const learned: BuyerCriteria = { ...emptyCriteria(), cities: ["Allen"] }
  const t5 = applyConversationTurn(learned, await parseBuyerCriteria("homes in Frisco", { brokerageId: null, allowModelAssist: false }), { text: "homes in Frisco", channel: "email", at: AT, trigger: "stated" })
  check("a buyer's words outrank behaviour: an inferred city list is REPLACED by the said one", JSON.stringify(t5.next.cities) === JSON.stringify(["Frisco"]) && provenanceOf(learned, "cities") === "inferred")
  const same = applyConversationTurn(t4.next, await parseBuyerCriteria("3 bedrooms", { brokerageId: null, allowModelAssist: false }), { text: "3 bedrooms", channel: "portal", at: AT, trigger: "stated" })
  check("repeating a value records no change (no flood of change rows)", same.changes.length === 0)
  const corr = applyCorrection(c1, "minBeds", 4, AT, "portal")
  check("a direct correction is said, trigger 'corrected', undoable", corr.next.minBeds === 4 && corr.change?.trigger === "corrected" && corr.change.status === "applied")

  // ── C ─────────────────────────────────────────────────────────────────────
  console.log("\n[C · THE ONE STORE — round trip, said survives the learner, m895 degrade, tenancy]")
  const db = memSupabase({ property_preferences: [], buyer_criteria_changes: [] }, { uuidIds: true })
  const saved = await saveBuyerCriteria(db as never, { brokerageId: BRK, contactId: CONTACT, criteria: c1 })
  check("save writes values + provenance (m895 present)", saved.ok && saved.provenancePersisted && db.tables.property_preferences.length === 1, JSON.stringify(saved))
  const row = db.tables.property_preferences[0]
  check("a SAID price goes to the explicit preferred_price_max column", row.preferred_price_max === 600000 && row.inferred_max_price === 600000)
  const back = await loadBuyerCriteria(db as never, CONTACT, { brokerageId: BRK })
  check("load returns the criteria with their provenance (portal, email, voice all read this one row)", back?.maxPrice === 600000 && back?.provenance?.maxPrice?.source === "said" && (back?.lifestyle ?? []).length === c1.lifestyle!.length)
  row.preferred_price_max = 690000; row.inferred_max_price = 690000 // the behaviour learner's ±15% band overwrote the column
  const afterLearner = await loadBuyerCriteria(db as never, CONTACT, { brokerageId: BRK })
  check("a said value SURVIVES the learner overwriting its column, and the override is reported", afterLearner?.maxPrice === 600000 && (afterLearner?.saidOverridesColumn ?? []).includes("maxPrice"))
  check("tenant bound on the read: the other brokerage reads nothing", (await loadBuyerCriteria(db as never, CONTACT, { brokerageId: OTHER })) === null)
  const foreign = await saveBuyerCriteria(db as never, { brokerageId: OTHER, contactId: CONTACT, criteria: c1 })
  check("a save under a different tenant than the row's is REFUSED", !foreign.ok && /different brokerage/.test(foreign.error ?? ""))
  const noM895 = memSupabase({ property_preferences: [] }, { uuidIds: true, missingColumns: { property_preferences: ["criteria_provenance", "lifestyle_preferences", "listing_type"] } })
  const s2 = await saveBuyerCriteria(noM895 as never, { brokerageId: BRK, contactId: CONTACT, criteria: c1 })
  check("m895 NOT applied: values still saved, provenance degrade stated BY NAME", s2.ok && !s2.provenancePersisted && /m895/.test(s2.note ?? ""), JSON.stringify(s2))
  const l2 = await loadBuyerCriteria(noM895 as never, CONTACT, { brokerageId: BRK })
  check("m895 NOT applied: load falls back to the legacy columns and says every value reads as inferred", l2?.maxPrice === 600000 && /m895/.test(l2?.note ?? "") && provenanceOf(l2!, "maxPrice") === "inferred")
  const legacyDb = memSupabase({ property_preferences: [{ id: "pp-legacy", contact_id: CONTACT, brokerage_id: BRK, inferred_cities: ["Allen"], criteria_provenance: {}, lifestyle_preferences: [], listing_type: null }] })
  const legacy = await loadBuyerCriteria(legacyDb as never, CONTACT, { brokerageId: BRK })
  check("POSITIVE CONTROL: a legacy row with no provenance never reads as 'said'", !!legacy && provenanceOf(legacy, "cities") === "inferred" && provenanceOf(legacy, "listingType") === "default")
  const rec = await recordCriteriaChanges(db as never, { brokerageId: BRK, contactId: CONTACT, changes: t1.changes, actorUserId: null })
  check("change rows recorded with reason + provenance + status", rec.persisted && rec.ids.length === t1.changes.length && db.tables.buyer_criteria_changes.every((r) => r.reason && r.status === "applied" && r.provenance === "said"))
  const noM896 = memSupabase({}, { missingTables: ["buyer_criteria_changes"] })
  const r896 = await recordCriteriaChanges(noM896 as never, { brokerageId: BRK, contactId: CONTACT, changes: t1.changes })
  check("m896 NOT applied: change history degrade stated BY NAME (never a fake 'saved')", !r896.persisted && /m896/.test(r896.note ?? ""))
  const settleForeign = await settleCriteriaChange(db as never, { brokerageId: OTHER, contactId: CONTACT, changeId: rec.ids[0], status: "rejected", decidedByUserId: null })
  check("a decision under another tenant matches nothing and is a FAILURE, not a quiet success", !settleForeign.ok)
  const settleOk = await settleCriteriaChange(db as never, { brokerageId: BRK, contactId: CONTACT, changeId: rec.ids[0], status: "rejected", decidedByUserId: null })
  const settleAgain = await settleCriteriaChange(db as never, { brokerageId: BRK, contactId: CONTACT, changeId: rec.ids[0], status: "rejected", decidedByUserId: null })
  check("a decision settles once; the second is refused as already decided", settleOk.ok && !settleAgain.ok)

  // ── D ─────────────────────────────────────────────────────────────────────
  console.log("\n[D · explainable match — matches / misses / unknowns; unknowns never rendered as facts]")
  const homes: Array<{ label: string; facts: ListingFitFacts }> = [
    { label: "12 Elm St", facts: { price: 575000, bedrooms: 3, bathrooms: 2, property_type: "single_family", city: "Frisco", hoa_dues: 0, public_remarks: "Sun-filled rooms and an open floor plan on a quiet cul-de-sac.", lot_size: 0.18 } },
    { label: "9 Oak Ct", facts: { price: 640000, bedrooms: 2, bathrooms: 2, property_type: "single_family", city: "Frisco", hoa_dues: null, public_remarks: null } },
    { label: "4 Pine Rd", facts: { price: 520000, bedrooms: 4, bathrooms: 3, property_type: "condo", city: "Plano", hoa_dues: 250, public_remarks: "Updated kitchen." } },
  ]
  const fits = homes.map((h) => ({ ...h, fit: explainCriteriaFit(h.facts, c1) }))
  const all = fits.flatMap((f) => [...f.fit.matches, ...f.fit.misses].map((i) => ({ ...i, bucket: "decided" })).concat(f.fit.unknowns.map((i) => ({ ...i, bucket: "unknown" }))))
  check("every match / miss cites a data source; every unknown cites none", all.every((i) => (i.bucket === "decided" ? i.source !== "none" : i.source === "none")))
  const elm = fits[0].fit
  check("12 Elm: price, beds, city, no-HOA match from listing data", ["maxPrice", "minBeds", "cities", "dealBreakers"].every((f) => elm.matches.some((m) => m.field === f && m.source === "listing")))
  check("12 Elm: natural light + open plan match ONLY as the listing agent's words, attributed as such", elm.matches.filter((m) => m.source === "listing_remarks").length >= 2 && elm.matches.filter((m) => m.source === "listing_remarks").every((m) => /listing description mentions/.test(m.detail)))
  check("12 Elm: commute and yard are UNKNOWN (no source measures them)", elm.unknowns.some((u) => u.field === "lifestyle:commute") && elm.unknowns.some((u) => u.field === "lifestyle:outdoor_space"))
  const oak = fits[1].fit
  check("9 Oak: over budget and short a bedroom → two misses with the facts", oak.misses.some((m) => m.field === "maxPrice" && /\$40k over/.test(m.detail)) && oak.misses.some((m) => m.field === "minBeds"))
  check("9 Oak: no remarks → natural light UNKNOWN; HOA dues null → HOA UNKNOWN (absence of data is not a 'no')", oak.unknowns.some((u) => u.field === "lifestyle:natural_light") && oak.unknowns.some((u) => u.field === "dealBreakers"))
  const pine = fits[2].fit
  check("4 Pine: HOA dues $250 → a miss on 'No HOA'; Plano → a location miss", pine.misses.some((m) => m.field === "dealBreakers" && /\$250/.test(m.detail)) && pine.misses.some((m) => m.field === "cities"))
  check("said asks lead every bucket", fits.every((f) => { const r = (x: string | null) => (x === "said" ? 0 : 1); return [f.fit.matches, f.fit.misses, f.fit.unknowns].every((b) => b.every((it, i) => i === 0 || r(b[i - 1].provenance) <= r(it.provenance))) }))
  const oakVoice = composeNeighbourlyExplanation(oak, "9 Oak Ct")
  check("UNKNOWNS NEVER AS FACTS: the narrative says nothing about an unknown ask; the unknowns sentence names it as unknown", !restatesUnknown(oakVoice.narrative, oak) && /can't tell you/.test(oakVoice.unknownsSentence ?? "") && /natural light/i.test(oakVoice.unknownsSentence ?? ""))
  check("POSITIVE CONTROL: a draft claiming 'bright natural light' for 9 Oak is caught", restatesUnknown("A bright home with lovely natural light", oak) === "Natural light")
  const explainedAll = fits.map((f) => composeNeighbourlyExplanation(f.fit, f.label))
  check("the neighbourly explanations WE author pass the steering check and carry no protected-class wording", explainedAll.every((e) => scanFairHousing(`${e.headline} ${e.narrative} ${e.unknownsSentence ?? ""}`).flagged.length === 0 && !PROTECTED.test(`${e.headline} ${e.narrative}`)))
  check("numbers grounded: a draft with a number the facts lack is rejected; one with only fact numbers passes", !numbersAreGrounded("It is listed at $499k", JSON.stringify(homes[0].facts)) && numbersAreGrounded("Listed at 575000 with 3 bedrooms", JSON.stringify(homes[0].facts)))
  const noTenant = await narrateFitExplanation({ brokerageId: null, listingLabel: "9 Oak Ct", fit: oak, facts: homes[1].facts as never })
  check("no tenant → no model call; deterministic explanation + a stated reason; unknowns sentence still present", noTenant.via === "deterministic" && /No tenant/.test(noTenant.note ?? "") && !!noTenant.unknownsSentence)

  // ── E ─────────────────────────────────────────────────────────────────────
  console.log("\n[E · search composition — the one store fills the query; the shortlist moves with the criteria]")
  const q = parseNaturalLanguageQuery("anything with a pool")
  const filled = intentWithStoredCriteria(q, c1)
  check("stored criteria fill what the query left unsaid (price, beds, city)", filled.maxPrice === 600000 && filled.minBeds === 3 && (filled.cities ?? []).includes("Frisco"))
  const q2 = intentWithStoredCriteria(parseNaturalLanguageQuery("4 bed under 700k in Austin"), c1)
  check("the query's own words win over the store", q2.maxPrice === 700000 && q2.minBeds === 4 && (q2.cities ?? []).includes("Austin") && !(q2.cities ?? []).includes("Frisco"))
  const fc = fitCriteriaFor(parseNaturalLanguageQuery("3 bed under 500k in Austin"), null)
  check("with no store, the query's fields are explained as 'said'", fc.provenance?.maxPrice?.source === "said" && fc.maxPrice === 500000)
  const shortlist = (crit: BuyerCriteria) => homes.filter((h) => explainCriteriaFit(h.facts, crit).misses.length === 0).map((h) => h.label)
  const before = shortlist(c1)
  const refined = shortlist(t2.next)
  check("refined shortlist: 12 Elm stays, 9 Oak / 4 Pine stay out; tightening to $550k drops 12 Elm ($575k)", before.includes("12 Elm St") && !before.includes("9 Oak Ct") && !refined.includes("12 Elm St"), `${before} → ${refined}`)
  check("buyers shop ACTIVE listings only (archived never reaches the buyer search)", JSON.stringify(BUYER_SHOPPABLE_LISTING_STATUSES) === JSON.stringify(["active"]))

  // ── F ─────────────────────────────────────────────────────────────────────
  console.log("\n[F · feedback → learning with reasons the buyer can accept or undo]")
  const hist: HomeSignal[] = [
    { kind: "saved", price: 640000, city: "Frisco", propertyType: "single_family", listingRef: "a" },
    { kind: "toured", price: 655000, city: "Frisco", propertyType: "single_family", listingRef: "b" },
    { kind: "dismissed", price: 400000, city: "Plano", propertyType: "condo", listingRef: "c" },
    { kind: "dismissed", price: 420000, city: "Plano", propertyType: "condo", listingRef: "d" },
  ]
  const drafts = learnFromBehaviour(c1, hist, { channel: "portal" })
  const priceD = drafts.find((d) => d.field === "maxPrice")
  check("saving 2 homes above a SAID limit → a PROPOSAL (never applied), reason names the count and the amounts", !!priceD && priceD.status === "proposed" && /2 homes above your \$600k/.test(priceD.reason) && priceD.proposed === 655000, JSON.stringify(priceD))
  const inferredMax: BuyerCriteria = { ...c1, provenance: { ...c1.provenance, maxPrice: undefined } }
  delete (inferredMax.provenance as Record<string, unknown>).maxPrice
  check("the same pattern on an INFERRED limit may be applied (still undoable)", learnFromBehaviour(inferredMax, hist, { channel: "portal" }).find((d) => d.field === "maxPrice")?.status === "applied")
  const condoD = drafts.find((d) => d.field === "dealBreakers")
  check("passing on 2 condos → a deal-breaker PROPOSAL (deal-breakers are never learned silently)", !!condoD && condoD.status === "proposed" && /passed on 2 condos/.test(condoD.reason))
  check("one save is a whim — no change from a single signal", learnFromBehaviour(c1, hist.slice(0, 1), { channel: "portal" }).length === 0)
  check("a REJECTED value is never proposed again", !learnFromBehaviour(c1, hist, { channel: "portal", prior: [{ field: "maxPrice", proposed: 655000, status: "rejected" }] }).some((d) => d.field === "maxPrice"))
  const appliedNever = applyLearnedChanges(c1, [{ ...priceD!, status: "applied" }], AT)
  check("applyLearnedChanges never overwrites a said value even if handed one", appliedNever.maxPrice === 600000)
  const accepted = applyAcceptedChange(c1, { field: "maxPrice", proposed: 655000, reason: priceD!.reason }, AT, "portal")
  check("accepting a proposal makes the value the buyer's own ('said', reason kept)", accepted.maxPrice === 655000 && accepted.provenance?.maxPrice?.source === "said" && /Accepted:/.test(String(accepted.provenance?.maxPrice?.evidence)))
  const undone = revertChange(t2.next, { field: "maxPrice", previous: 600000, proposed: 550000 }, AT, "portal")
  check("undoing an applied change restores the previous value", undone.maxPrice === 600000)
  check("undo never clobbers a newer value (the field already moved on)", revertChange(accepted, { field: "maxPrice", previous: 600000, proposed: 550000 }, AT, "portal").maxPrice === 655000)
  const notePs = await parseBuyerCriteria("too small, we need at least 4 bedrooms", { brokerageId: null, allowModelAssist: false })
  const noteTurn = applyConversationTurn(c1, notePs, { text: "too small, we need at least 4 bedrooms", channel: "portal", at: AT, trigger: "feedback" })
  check("a feedback note is the buyer's words → a said change with trigger 'feedback'", noteTurn.next.minBeds === 4 && noteTurn.changes.some((c) => c.field === "minBeds" && c.trigger === "feedback"))

  // ── G ─────────────────────────────────────────────────────────────────────
  console.log("\n[G · showing / agent action — informed, not flooded]")
  check("a tour ask notifies the agent", shouldNotifyAgent({ changes: [], requested: "showing" }).notify)
  check("a material said change (price) notifies the agent", shouldNotifyAgent({ changes: t2.changes }).notify)
  check("lifestyle-only changes do NOT notify (no keystroke flood)", !shouldNotifyAgent({ changes: [{ field: "lifestyle", status: "applied", provenance: "said" }] }).notify)
  check("proposals still waiting on the buyer do NOT notify", !shouldNotifyAgent({ changes: [{ field: "maxPrice", status: "proposed", provenance: "inferred" }] }).notify)
  check("a turn with no change does not notify", !shouldNotifyAgent({ changes: [] }).notify)
  const { publishManagerSignal } = await import("../lib/kernel/manager-signals")
  const bus = memSupabase({ manager_signals: [] }, { uuidIds: true })
  const sig = { brokerageId: BRK, fromManager: "ai_isa", toManager: "shopping_agent", signalType: "qualification_criteria_captured", message: "Buyer updated their search", entityType: "contact", entityId: CONTACT, contactId: CONTACT, payload: { source: "buyer_portal_conversation" } }
  const s1 = await publishManagerSignal(sig as never, bus as never)
  // The live column DEFAULT is 'open'; the in-memory table has no defaults, so it is stamped here.
  bus.tables.manager_signals.forEach((r) => { if (r.status == null) r.status = "open" })
  const s2b = await publishManagerSignal(sig as never, bus as never)
  check("the bus dedupes: a second update while the first is open is ONE signal for the agent", s1.ok && s2b.ok && /deduped/.test(s2b.reason ?? "") && bus.tables.manager_signals.length === 1, JSON.stringify([s1, s2b]))
  const nbe = nextBestExperiences({ resultsCount: 3, clarifications: [], criteria: c1, savedCount: 2 })
  check("next-best experiences map to existing surfaces (tour, compare, keep-watching alert, agent)", ["request_showing", "compare_homes", "save_alert", "ask_agent"].every((k) => nbe.some((n) => n.key === k)))
  const vp = voiceTurnPlan({ results: fits.map((f) => ({ label: f.label, price: f.facts.price, fit: f.fit })), clarifications: [] })
  check("voice turn: three homes at most, ends with exactly ONE question", (vp.spoken.match(/\?/g) ?? []).length === 1 && vp.spoken.trim().endsWith("?"))
  check("voice turn: unknowns are spoken as unknown ('can't tell me'), never as fact", /can't tell me about/.test(vp.spoken) && !restatesUnknown(vp.spoken.replace(/can't tell me about[^.]*\./g, ""), oak))
  const chips = criteriaChips(c1)
  check("criteria chips carry provenance for the buyer to see and edit", chips.some((c) => c.field === "maxPrice" && c.provenance === "said") && chips.some((c) => c.field === "listingType" && c.provenance === "default"))

  // ── H ─────────────────────────────────────────────────────────────────────
  console.log("\n[H · wiring — comment-stripped source, each with a positive control]")
  const portal = code("app/actions/portal-nl-search.ts")
  // The bound is the contact row's tenant — that row is read ONLY under the gate's tenant
  // (`.eq("brokerage_id", access.brokerageId)`, held by test:portal-nl-search-gate).
  const loadAt = portal.search(/loadBuyerCriteria\(svc,\s*input\.contactId,\s*\{\s*brokerageId:\s*\(contact as \{ brokerage_id: string \| null \}\)\.brokerage_id\s*\}\)/)
  const searchAt = portal.search(/searchPropertiesCore\s*\(/)
  check("portal search reads THE ONE STORE under the gate's tenant BEFORE the search and passes it in", loadAt > 0 && searchAt > loadAt && /criteria:\s*storedCriteria/.test(portal))
  check("portal search still has exactly ONE success exit", (portal.match(/return\s*\{\s*ok:\s*true/g) ?? []).length === 1)
  const eng = code("lib/buyer-search/search-engine.ts")
  check("engine: the renter's market reaches the external router", /listingType:\s*enrichedIntent\.listingType === 'rent' \? 'rental' : 'sale'/.test(eng))
  check("engine: every result carries its fit and the steering-checked neighbourly voice", /explainCriteriaFit\(/.test(eng) && /\bfit,/.test(eng) && /explanation_voice:\s*voiceScan\.clean/.test(eng))
  check("engine: listings filtered on the shoppable-status list (not a bare literal)", /\.in\('status',\s*\[\.\.\.BUYER_SHOPPABLE_LISTING_STATUSES\]\)/.test(eng) && !/\.eq\('status',\s*'active'\)/.test(eng))
  check("POSITIVE CONTROL: the status finder sees the old bare literal", /\.eq\('status',\s*'active'\)/.test(".eq('status', 'active')"))
  const acts = code("app/actions/buyer-search/conversational-search.ts")
  const exported = [...acts.matchAll(/export\s+async\s+function\s+(\w+)\s*\(/g)].map((m) => m[1])
  const bodyOf = (name: string) => { const i = acts.indexOf(`function ${name}(`); return i < 0 ? "" : acts.slice(i, acts.indexOf("\nexport ", i + 10) > 0 ? acts.indexOf("\nexport ", i + 10) : undefined) }
  const ungated = exported.filter((n) => { const b = bodyOf(n); const gate = b.search(/await\s+gateBuyer\(/); const svc = b.search(/createServiceClient\(|\.from\(/); return gate < 0 || (svc >= 0 && svc < gate) })
  check(`every exported conversation door gates before any privileged read (${exported.length} doors)`, exported.length === 7 && ungated.length === 0, ungated.join(", "))
  check("'keep watching' rides the EXISTING alert proposal rail (inactive until the agent approves), ledgered", /proposeWrittenCriteriaAlert\(/.test(bodyOf("buyerKeepWatchingAction")) && /buyer_search\.alert\.propose/.test(bodyOf("buyerKeepWatchingAction")) && !/is_active:\s*true/.test(acts))
  check("the shared gate is requireContactAccess, and the tenant is the gate's (never the body's)", /await\s+requireContactAccess\(contactId\)/.test(acts) && !/input\.(brokerageId|userId|agentId|actorUserId)/.test(acts))
  check("POSITIVE CONTROL: the body-tenant finder sees an IDOR shape", /input\.(brokerageId|userId|agentId|actorUserId)/.test("const b = input.brokerageId"))
  const turnSrc = code("lib/buyer-search/criteria-turn.ts")
  const names = [...`${acts}\n${turnSrc}`.matchAll(/\baction:\s*"([^"]+)"/g)].map((m) => m[1])
  check(`every criteria write is ledgered under a domain.entity.action name (${names.join(", ")})`, names.length >= 3 && names.includes("buyer_search.criteria.update") && names.every((n) => /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(n)) && /withActionLedger/.test(acts) && /withActionLedger/.test(turnSrc))
  check("the portal doors and the email/SMS listener write criteria through the ONE ledgered writer", /persistCriteriaChanges\(/.test(acts) && /recordStatedCriteriaTurn\(/.test(acts) && /recordStatedCriteriaTurn\(/.test(code("lib/buyer-search/written-criteria-alert.ts")) && !/saveBuyerCriteria\(/.test(code("lib/buyer-search/written-criteria-alert.ts")))
  check("the agent hears through the manager bus (deduped), only behind shouldNotifyAgent", /publishManagerSignal\(/.test(acts) && (acts.match(/verdict\.notify/g) ?? []).length >= 4)
  const ui = code("app/portal/[contactId]/search/PortalNlSearch.tsx")
  check("the portal conversation runs the turn THEN the one search door", ui.indexOf("buyerConversationTurnAction({") > 0 && ui.indexOf("await portalNaturalSearchAction(") > ui.indexOf("await buyerConversationTurnAction("))
  const voiceSrc = code("lib/buyer-search/voice-turn.ts")
  check("the voice turn module is client-safe (type-only imports)", [...voiceSrc.matchAll(/^import\s+(?!type\b)/gm)].length === 0)
  const gen = code("lib/buyer-search/explanation-generator.ts")
  const narrativeBody = gen.slice(gen.indexOf("function generateNarrative("), gen.indexOf("function lowerFirst("))
  const mainBody = gen.slice(gen.indexOf("export function generateMatchExplanation("), gen.indexOf("function describeLocation("))
  const INVENTED = /move-in ready|consistent demand|employment centers|growing family|uncompromising|strong resale|perfect for building|immediate availability/i
  check("no invented listing facts in the copy we author (narrative + bullets)", narrativeBody.length > 200 && mainBody.length > 200 && !INVENTED.test(narrativeBody) && !INVENTED.test(mainBody))
  check("POSITIVE CONTROL: the invented-fact finder sees the retired closing", INVENTED.test("It's move-in ready and positioned in a neighborhood"))
  const filterFiles = ["lib/buyer-search/buyer-criteria.ts", "lib/buyer-search/conversation-criteria.ts"]
  check("the FILTER lane imports no content gate (capture is not steering)", filterFiles.every((f) => !/from\s+["'][^"']*(fair-housing|content-guardian|kernel\/compliance)/.test(code(f))))
  for (const m of ["supabase/migrations/m895-property-preferences-criteria-provenance.sql", "supabase/migrations/m896-buyer-criteria-changes.sql"]) {
    const first = existsSync(join(root, m)) ? readFileSync(join(root, m), "utf8").split("\n")[0] : ""
    check(`${m.split("/").pop()}: line 1 is the lane stamp or the APPLIED LIVE stamp (the rule, not the waypoint)`, first.startsWith("-- WRITTEN, NOT APPLIED (wave 147, lane 147C)") || first.startsWith("-- ── APPLIED LIVE "))
  }

  // ── J ─────────────────────────────────────────────────────────────────────
  console.log("\n[J · one store across channels — portal, email, SMS through ONE ledgered writer]")
  const SELLER = "44444444-4444-4444-8444-444444444444"
  const xdb = memSupabase(
    { contacts: [{ id: CONTACT, brokerage_id: BRK, contact_type: "buyer" }, { id: SELLER, brokerage_id: BRK, contact_type: "seller" }], property_preferences: [], buyer_criteria_changes: [], agent_action_ledger: [], property_alerts: [] },
    { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } },
  )
  const { recordStatedCriteriaTurn, persistCriteriaChanges } = await import("../lib/buyer-search/criteria-turn")
  const pt = await recordStatedCriteriaTurn(xdb as never, { brokerageId: BRK, contactId: CONTACT, text: "3 bed under 600k in Frisco", channel: "portal", actor: { type: "user", userId: null }, idempotencyKey: "k-portal-1", allowModelAssist: false, ledgerClient: xdb })
  const ledger = xdb.tables.agent_action_ledger
  check("a portal turn writes the store and leaves ONE ledger row (buyer_search.criteria.update, executed, CONVERSATION_RESPONSE)", pt.changes.length >= 3 && ledger.length === 1 && ledger[0].action === "buyer_search.criteria.update" && ledger[0].status === "executed" && ledger[0].reason_code === "CONVERSATION_RESPONSE", JSON.stringify(ledger[0] ?? null).slice(0, 200))
  const prefWrites = () => xdb.writes.filter((w) => w.table === "property_preferences").length
  const before2 = prefWrites()
  const cur = await loadBuyerCriteria(xdb as never, CONTACT, { brokerageId: BRK })
  const again = await persistCriteriaChanges(xdb as never, { brokerageId: BRK, contactId: CONTACT, next: { ...cur!, minBeds: 5 }, drafts: [], actor: { type: "user" }, idempotencyKey: "k-portal-1", trigger: "stated", channel: "portal", reasonDetail: "retry", ledgerClient: xdb })
  check("the same idempotency key REPLAYS: nothing is written a second time, and it is not an error", !again.acted && again.error === null && prefWrites() === before2)
  const { proposeWrittenCriteriaAlert } = await import("../lib/buyer-search/written-criteria-alert")
  await proposeWrittenCriteriaAlert(xdb, { brokerageId: BRK, contactId: CONTACT, agentUserId: null, messageRef: null, body: "Actually we'd like to stay under 550k" })
  const afterEmail = await loadBuyerCriteria(xdb as never, CONTACT, { brokerageId: BRK })
  check("an EMAIL refinement reaches the same store, provenance said / channel email", afterEmail?.maxPrice === 550000 && afterEmail?.provenance?.maxPrice?.source === "said" && afterEmail?.provenance?.maxPrice?.channel === "email")
  await proposeWrittenCriteriaAlert(xdb, { brokerageId: BRK, contactId: CONTACT, agentUserId: null, messageRef: "SM-147C-1", body: "no HOA please" })
  const afterSms = await loadBuyerCriteria(xdb as never, CONTACT, { brokerageId: BRK })
  const changeRows = xdb.tables.buyer_criteria_changes.length
  check("an SMS reaches the same store (channel sms) without erasing the earlier email / portal values", afterSms?.dealBreakers.includes("hoa") === true && afterSms?.provenance?.dealBreakers?.channel === "sms" && afterSms?.maxPrice === 550000 && afterSms?.minBeds === 3)
  await proposeWrittenCriteriaAlert(xdb, { brokerageId: BRK, contactId: CONTACT, agentUserId: null, messageRef: "SM-147C-1", body: "no HOA please" })
  check("a re-delivered SMS webhook (same MessageSid) applies nothing twice", xdb.tables.buyer_criteria_changes.length === changeRows)
  await proposeWrittenCriteriaAlert(xdb, { brokerageId: BRK, contactId: SELLER, agentUserId: null, messageRef: null, body: "we'd list at 600k in Frisco" })
  check("a SELLER's words never become buyer criteria (buyer-side contacts only)", !xdb.tables.property_preferences.some((r) => r.contact_id === SELLER))
  check("every criteria write in this layer is ledgered (one row per distinct change set, all executed)", xdb.tables.agent_action_ledger.length === 3 && xdb.tables.agent_action_ledger.every((r) => r.status === "executed" && r.action === "buyer_search.criteria.update"), JSON.stringify(xdb.tables.agent_action_ledger.map((r) => [r.idempotency_key, r.status])))

  // ── I ─────────────────────────────────────────────────────────────────────
  console.log("\n[I · prompt quality — both LLM prompts are expert and structured]")
  const SECTIONS = [/ROLE:/, /BUSINESS CONTEXT:/, /(FACTS YOU MAY RELY ON|WHAT YOU MAY RELY ON):/, /(YOU MUST NOT|WHAT YOU MUST NOT DO):/, /THE DECISION YOU OWN:/, /OUTPUT CONTRACT:/, /ESCALATION:/]
  const structured = (p: string) => SECTIONS.every((re) => re.test(p)) && p.length > 1200
  const parser = readFileSync(join(root, "lib/buyer-search/parse-buyer-criteria.ts"), "utf8")
  const parsePrompt = parser.slice(parser.indexOf("const SYSTEM = ["), parser.indexOf('].join("\\n")', parser.indexOf("const SYSTEM = [")))
  check("criteria-parsing prompt: role, context, facts, must-not, decision, output contract, escalation", structured(parsePrompt), `${parsePrompt.length} chars`)
  check("explanation prompt: role, context, facts, must-not, decision, output contract, escalation", structured(EXPLANATION_SYSTEM))
  check("both prompts carry the fair-housing boundary and the do-not-invent rule", /familial status|household/i.test(parsePrompt) && /never guess|Never guess/i.test(parsePrompt) && /invent/i.test(EXPLANATION_SYSTEM) && /demographics/i.test(EXPLANATION_SYSTEM))
  check("POSITIVE CONTROL: a one-line prompt fails the structure check", !structured("You extract a home buyer's search criteria from their own message."))

  console.log(`\n RESULT: ${pass} passed, ${fail} failed${fail ? ` — ${failures.join(" | ")}` : ""}`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
