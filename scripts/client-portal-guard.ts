/**
 * scripts/client-portal-guard.ts — THE CLIENT PORTAL DOES MORE (wave 149, lane 149B, owner rulings 2, 4, 5).
 * `test:client-portal`
 *
 * Owner: "Client portal must do more than showing requests, home search and passing on a request." Every capability a
 * buyer expects is listed below with its VERDICT and the door that serves it; this guard proves each advertised
 * capability resolves to a wired door (the surface file imports the door, the door exists), that every stored persona
 * gets its OWN layout (ruling 2), and that the yard / acreage minimum is the buyer's (ruling 5, C27).
 *
 *   A. CAPABILITY → DOOR — each row's surface carries the door token and the door file exports it (stripped source)
 *   B. PERSONA LAYOUT — every contacts.contact_persona value (live CHECK cache) resolves to its own layout
 *   C. C27 PARSER — the buyer's stated lot minimum, in their unit, with their words; nothing invented
 *   D. C27 FIT — the verdict comes ONLY from the buyer's minimum; without one the lot is a FACT and the buyer is asked
 *   E. CENSUS — no platform yard / acreage bar left in the matcher (stripped source), with a positive control
 *   F. PROMPT STANDARD — the explanation prompt carries the yard-and-land rule
 *
 * BLIND SPOTS (published): the portal is not rendered in a browser (a door is "wired" when the surface imports and
 * calls it); a capability marked PARTIAL in CAPABILITIES is listed with what is missing, not proven complete; the C27
 * parser is lexical — a minimum said in words it does not know ("an acre and a bit") is NOT captured, which is the safe
 * failure (the AI asks); requirement 5's "no hardcoded answer tables" is proven for the yard / acreage bar only — the
 * buyer-question answers (commute, schools) ride the C18 explanation and the arbiter, whose prompts are their own proofs.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { PERSONA_CONFIGS, getPersonaConfig, offersFamilySearch } from "../lib/portal/persona-config"
import { extractLifestyleAsks } from "../lib/buyer-search/conversation-criteria"

const resolvePortalPersonaKey = (p: string, side: "buyer" | "seller" = "buyer") => getPersonaConfig(p, side).id
/** The stated minimum, as the criteria store records it (the lifestyle ask's lotMinimum). */
const statedLotMinimum = (s: string) => extractLifestyleAsks(s).find((a) => a.kind === "outdoor_space")?.lotMinimum ?? null
import { explainCriteriaFit, composeNeighbourlyExplanation } from "../lib/buyer-search/explanation-generator"
import { claimsFromFit, describeListingSource, validateClaims, validLotMinimum } from "../lib/buyer-search/explanation-evidence"
import { emptyCriteria, EXPLANATION_SYSTEM } from "../lib/buyer-search/conversational-search"

const root = process.cwd()
const code = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))
let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const P = "app/portal/[contactId]"
type Verdict = "BUILT" | "PARTIAL" | "BUILT (149B)" | "WIRED (149B)" | "BUILT (149J)" | "BUILT (151J)"
interface Capability { key: string; verdict: Verdict; surface: string; door: string; token: string; missing?: string }

/** The audit (lane 149B notes "Verdict per requirement" carries the same table). `token` must appear in BOTH the
 *  surface and the door's stripped source (the surface imports/calls it; the door defines it). */
const CAPABILITIES: Capability[] = [
  { key: "conversational discovery", verdict: "BUILT", surface: `${P}/search/PortalNlSearch.tsx`, door: "app/actions/buyer-search/conversational-search.ts", token: "buyerConversationTurnAction" },
  { key: "smart matching", verdict: "BUILT", surface: `${P}/search/PortalNlSearch.tsx`, door: "app/actions/portal-nl-search.ts", token: "portalNaturalSearchAction" },
  { key: "top matches", verdict: "BUILT", surface: `${P}/components/TopMatchesPanel.tsx`, door: "app/actions/buyer-portal-matches.ts", token: "buyer-portal-matches" },
  { key: "saved listings + reactions", verdict: "BUILT", surface: `${P}/search/PortalNlSearch.tsx`, door: "app/actions/buyer-search/conversational-search.ts", token: "buyerHomeFeedbackAction" },
  { key: "saved searches / alerts", verdict: "BUILT", surface: `${P}/search/SavedSearchControls.tsx`, door: "app/actions/property-alerts/alert-actions.ts", token: "alert-actions" },
  { key: "why this home (evidence, maps)", verdict: "BUILT", surface: `${P}/search/PortalNlSearch.tsx`, door: "app/actions/buyer-search/conversational-search.ts", token: "explainHomeForBuyerAction" },
  { key: "comparisons", verdict: "BUILT", surface: `${P}/properties/CompareHomesCard.tsx`, door: "app/actions/buyer-offer-tools.ts", token: "buyer-offer-tools" },
  { key: "neighbourhood + lifestyle", verdict: "BUILT", surface: `${P}/properties/[propertyId]/NeighborhoodLifestyleCard.tsx`, door: "app/actions/smart-insights.ts", token: "smart-insights" },
  { key: "value / equity education", verdict: "BUILT", surface: `${P}/market-updates/page.tsx`, door: "app/actions/portal-lifetime.ts", token: "getMarketUpdates" },
  { key: "affordability", verdict: "BUILT", surface: `${P}/resources/portal-financial-tools.tsx`, door: "app/actions/calculators.ts", token: "calculators" },
  { key: "showing requests + tours", verdict: "BUILT", surface: `${P}/showings/page.tsx`, door: "app/actions/portal-tours.ts", token: "portal-tours" },
  { key: "personal agent video", verdict: "BUILT", surface: `${P}/components/PortalWelcomeVideo.tsx`, door: "lib/portal/welcome-video.ts", token: "portalWelcomeVideoFor" },
  { key: "education", verdict: "BUILT", surface: `${P}/learn/page.tsx`, door: "app/actions/portal-education.ts", token: "portal-education" },
  { key: "questions to the agent", verdict: "BUILT", surface: `${P}/messages/page.tsx`, door: "app/actions/portal-messages.ts", token: "portal-messages" },
  { key: "ask my assistant (from my own file)", verdict: "WIRED (149B)", surface: `${P}/buyer-home.tsx`, door: `${P}/assistant/page.tsx`, token: "/assistant" },
  { key: "offer / transaction visibility", verdict: "BUILT", surface: `${P}/transaction/[transactionId]/page.tsx`, door: "app/actions/transactions.ts", token: "transactions" },
  { key: "documents", verdict: "BUILT", surface: `${P}/documents/page.tsx`, door: "lib/kernel/deal-document-visibility.ts", token: "isClientVisibleDealDocument" },
  { key: "journey tasks", verdict: "BUILT", surface: `${P}/journey/journey-checklist.tsx`, door: "app/actions/journey-tasks.ts", token: "journey-tasks" },
  { key: "lifetime relationship", verdict: "BUILT", surface: `${P}/lifetime-home.tsx`, door: "app/actions/portal-lifetime.ts", token: "portal-lifetime" },
  { key: "family collaborative search (C28)", verdict: "BUILT (149B)", surface: `${P}/search/ShareWithFamilyCard.tsx`, door: "app/actions/collaborative-search.ts", token: "shareHomesWithFamilyAction" },
  { key: "collaborator view (C28)", verdict: "BUILT (149B)", surface: "app/search/join/page.tsx", door: "app/actions/collaborative-search.ts", token: "acceptInvitation" },
  { key: "family opinions → buyer (C28)", verdict: "BUILT (149B)", surface: `${P}/search/ShareWithFamilyCard.tsx`, door: "app/actions/collaborative-search.ts", token: "loadFamilyFeedbackAction" },
  // Flipped wave 149Z (lane 149B Outside-lane 1): lane 149J built the portal opt-out on the contact-self door
  // (updateContactProfile → portalChannelWithdrawals → the ONE opt-out writer writeOptOut, source 'portal'), gated by the
  // contact's own access, instead of a processPortalOptOut twin. §A' below holds the door to the writer.
  { key: "communication preferences", verdict: "BUILT (149J)", surface: "app/components/portal/PortalSettingsPage.tsx", door: "app/actions/portal-settings.ts", token: "updateContactProfile" },
  // Wave 151 (lane 151J): a saved HOME is its own subscription — the watch re-reads the source (metered re-reads behind
  // approval), diffs the last verified state and hands a change to the ONE arbiter door; the card says when it was checked.
  { key: "saved-home alerts (last verified state on the card)", verdict: "BUILT (151J)", surface: `${P}/search/page.tsx`, door: "lib/portal/saved-homes.ts", token: "savedHomeVerificationLine" },
  // Wave 151 (lane 151J, row 77): a tour ask on a saved home with NO listing row → the survivor showing door + an agent task.
  { key: "showing request on an outside saved home (row 77)", verdict: "BUILT (151J)", surface: `${P}/search/PortalNlSearch.tsx`, door: "app/actions/buyer-search/conversational-search.ts", token: "buyerHomeFeedbackAction" },
]

/** PURE: a capability resolves when both files exist and both carry the token in stripped source. */
function resolves(c: Capability): { ok: boolean; why: string } {
  if (!existsSync(join(root, c.surface))) return { ok: false, why: `surface missing: ${c.surface}` }
  if (!existsSync(join(root, c.door))) return { ok: false, why: `door missing: ${c.door}` }
  if (!code(c.surface).includes(c.token)) return { ok: false, why: `surface does not reach ${c.token}` }
  if (!code(c.door).includes(c.token) && !c.door.includes(c.token)) return { ok: false, why: `door does not define ${c.token}` }
  return { ok: true, why: "" }
}

console.log("\n A. CAPABILITY → DOOR")
for (const c of CAPABILITIES.filter((x) => x.verdict !== "PARTIAL")) {
  const r = resolves(c)
  check(`${c.key} [${c.verdict}] → ${c.door}`, r.ok, r.why)
}
for (const c of CAPABILITIES.filter((x) => x.verdict === "PARTIAL")) {
  check(`${c.key} [PARTIAL] is published with what is missing`, !!c.missing && c.missing.length > 20)
}
{
  const door = code("app/actions/portal-settings.ts")
  check("A' communication preferences: the portal door records a channel withdrawal through the ONE opt-out writer (writeOptOut, source 'portal') under the contact's own access, and reads its result",
    /requireContactAccess\(/.test(door) && /writeOptOut\(svc, access\.brokerageId, \{[^}]*source: "portal"/.test(door) && /if \(!res\.success\) return \{ success: false/.test(door))
}
check("POSITIVE CONTROL: a capability whose surface never calls its door does NOT resolve", !resolves({ key: "x", verdict: "BUILT", surface: `${P}/learn/page.tsx`, door: "app/actions/collaborative-search.ts", token: "shareHomesWithFamilyAction" }).ok)
check("POSITIVE CONTROL: a capability whose door file is absent does NOT resolve", !resolves({ key: "x", verdict: "BUILT", surface: `${P}/learn/page.tsx`, door: "app/actions/no-such-door.ts", token: "portal-education" }).ok)

console.log("\n B. PERSONA LAYOUT — every stored persona, its own layout (ruling 2)")
const stored = CHECK_VOCABULARIES.contacts?.contact_persona ?? []
check("the live persona vocabulary is read from the CHECK cache (non-empty)", stored.length >= 14, String(stored.length))
const expectOwn = stored.filter((p) => p !== "other")
for (const p of expectOwn) {
  const key = resolvePortalPersonaKey(p, "buyer")
  check(`persona "${p}" → its own layout "${key}"`, !!PERSONA_CONFIGS[key] && (key !== "first_time_buyer" || p === "first_time"))
}
check("every layout key still resolves to itself (none removed, none remapped)", Object.keys(PERSONA_CONFIGS).every((k) => resolvePortalPersonaKey(k) === k && getPersonaConfig(k).id === PERSONA_CONFIGS[k].id))
check("seller side: first_time / luxury resolve to the seller layouts", resolvePortalPersonaKey("first_time", "seller") === "first_time_seller" && resolvePortalPersonaKey("luxury", "seller") === "luxury_seller")
check("POSITIVE CONTROL: the old direct lookup mis-resolved a stored persona (military → the first-time buyer's layout)", (() => { const direct = (k: string) => (PERSONA_CONFIGS as Record<string, { id: string } | undefined>)[k] ?? PERSONA_CONFIGS.first_time_buyer; return direct("military").id === "first_time_buyer" })())
check("the commonest buyer persona (stored 'first_time') now gets the family board; upsize too", offersFamilySearch("first_time") && offersFamilySearch("upsize"))

console.log("\n C. C27 PARSER — the buyer's minimum, their unit, their words")
const lm = (s: string) => statedLotMinimum(s)
check("'at least 2 acres' → 2 acres, high, words kept", lm("we want at least 2 acres")?.value === 2 && lm("we want at least 2 acres")?.unit === "acres" && lm("we want at least 2 acres")?.confidence === "high" && /2 acres/.test(lm("we want at least 2 acres")?.literal ?? ""))
check("'half an acre' → 0.5 acres", lm("half an acre would be lovely")?.value === 0.5)
check("'a quarter-acre lot' → 0.25 acres", lm("a quarter-acre lot is plenty")?.value === 0.25)
check("'1/2 acre' → 0.5 acres", lm("a 1/2 acre yard")?.value === 0.5)
// Re-asserted to the RULE (wave 150, lane 150W, §6 one vocabulary): the buyer's square-feet minimum is spelled in the
// listing's own lot_size_unit vocabulary (derived from the live CHECK cache, never a pinned literal).
check("'a 10,000 sq ft lot' → 10000 in the listings.lot_size_unit square-feet spelling (their unit)", lm("a 10,000 sq ft lot")?.value === 10000 && (CHECK_VOCABULARIES.listings?.lot_size_unit ?? []).filter((u) => u !== "acres").includes(String(lm("a 10,000 sq ft lot")?.unit)))
check("a HOUSE size is never a lot minimum ('2,000 sq ft home with a yard')", lm("a 2,000 sq ft home with a yard") === null)
check("a MAXIMUM is not a minimum ('under an acre', 'no more than 2 acres')", lm("under an acre please") === null && lm("no more than 2 acres") === null)
check("a hedge keeps the number with low confidence ('about an acre or so')", lm("about an acre or so")?.value === 1 && lm("about an acre or so")?.confidence === "low")
check("NOTHING INVENTED: 'a big yard' / 'room for the dog' → no minimum", lm("a big yard for the kids") === null && lm("room for the dog to run") === null)
check("every parsed minimum passes the contract check (stated_by buyer)", ["at least 2 acres", "half an acre", "a 10,000 sq ft lot"].every((s) => validLotMinimum(lm(s))))
check("POSITIVE CONTROL: the contract check refuses an AI-stated or unit-less minimum", !validLotMinimum({ value: 1, unit: "acres", stated_by: "ai", literal: "x", confidence: "high" }) && !validLotMinimum({ value: 1, unit: "hectares", stated_by: "buyer", literal: "x", confidence: "high" }))
const asks = extractLifestyleAsks("We'd love half an acre and a quiet street")
check("the lifestyle ask carries the minimum (and the derived acres the older readers take)", asks.some((a) => a.kind === "outdoor_space" && a.lotMinimum?.value === 0.5 && a.minAcres === 0.5))
const big = extractLifestyleAsks("a bigger yard please")
check("'a bigger yard' is an outdoor-space ask with NO minimum", big.some((a) => a.kind === "outdoor_space" && !a.lotMinimum && !a.minAcres))

console.log("\n D. C27 FIT — the buyer's bar or none")
const crit = (s: string) => ({ ...emptyCriteria(), lifestyle: extractLifestyleAsks(s) }) as never
const lot018 = { price: 500000, lot_size: 0.18, city: "Frisco" } as never
const rentcast = { price: 600000, lot_size_sqft: 26136, facts_source: "provider:rentcast", city: "Frisco" } as never // 0.6 acre
const noBar = explainCriteriaFit(lot018, crit("a bigger yard please"), null)
const yardItems = (f: ReturnType<typeof explainCriteriaFit>, b: "matches" | "misses" | "unknowns" | "facts") => (f[b] ?? []).filter((i) => i.field === "lifestyle:outdoor_space")
check("no stated minimum → the lot is a FACT (no match, no miss), with acres + unit basis", yardItems(noBar, "facts").length === 1 && !yardItems(noBar, "matches").length && !yardItems(noBar, "misses").length && /0\.18 acre/.test(yardItems(noBar, "facts")[0].detail) && /doesn't record the unit/.test(yardItems(noBar, "facts")[0].evidence?.caveat ?? ""))
check("…and the buyer is asked how much yard feels right", /yours to say/.test(yardItems(noBar, "facts")[0].detail))
const voice = composeNeighbourlyExplanation(noBar, "12 Elm St")
check("the follow-up question asks for the buyer's size (acres or square feet)", /How much yard or land would feel right/.test(voice.followUpQuestion) && /0\.18-acre lot/.test(voice.narrative))
const lessNoBar = explainCriteriaFit(lot018, crit("less yard please"), null)
check("'less yard' with no stated size → a fact, not a platform verdict", yardItems(lessNoBar, "facts").length === 1 && !yardItems(lessNoBar, "matches").length)
const halfMiss = explainCriteriaFit(lot018, crit("at least half an acre"), null)
check("stated 'at least half an acre' vs 0.18 acre → a MISS that repeats the buyer's number", yardItems(halfMiss, "misses").length === 1 && /under the 0\.50 acre you said/.test(yardItems(halfMiss, "misses")[0].detail))
const halfMatch = explainCriteriaFit(rentcast, crit("at least half an acre"), null)
check("stated 'at least half an acre' vs a 0.6-acre RentCast lot → a MATCH", yardItems(halfMatch, "matches").length === 1)
const sqftMiss = explainCriteriaFit(lot018, crit("a lot of at least 10,000 sq ft"), null)
check("a square-feet minimum is said back in square feet", yardItems(sqftMiss, "misses").length === 1 && /10,000 sq ft you said/.test(yardItems(sqftMiss, "misses")[0].detail))
const ambiguous = explainCriteriaFit({ price: 1, lot_size: 500 } as never, crit("at least 2 acres"), null)
check("unknown lot data stays UNKNOWN even with a stated minimum", yardItems(ambiguous, "unknowns").length === 1)
const claims = claimsFromFit(noBar, describeListingSource("platform", { brokerageName: "Acme Realty" }))
check("the lot fact is a C18 claim with verdict 'fact' and its evidence; all claims validate", claims.some((c) => c.topic === "outdoor_space" && c.verdict === "fact" && c.evidence_source === "listing") && validateClaims(claims).ok, JSON.stringify(validateClaims(claims).problems))

console.log("\n E. CENSUS — no platform yard bar in the matcher")
const gen = code("lib/buyer-search/explanation-generator.ts")
const BAR = /\b(ACREAGE_MIN_ACRES|ROOMY_LOT_ACRES|SMALL_LOT_ACRES)\b|lot\.acres\s*[<>]=?\s*0\.\d+/
check("the matcher holds no invented yard / acreage bar (stripped source)", !BAR.test(gen), (gen.match(BAR) ?? [""])[0])
check("POSITIVE CONTROL: the census sees a planted bar", BAR.test("const ROOMY_LOT_ACRES = 0.25") && BAR.test("return lot.acres >= 0.25 ? a : b"))

console.log("\n F. PROMPT STANDARD — the yard-and-land rule")
check("the explanation prompt tells the model never to invent a bar and to ask the buyer", /YARD AND LAND RULE/.test(EXPLANATION_SYSTEM) && /never invents a minimum/.test(EXPLANATION_SYSTEM) && /ask how much yard or land/.test(EXPLANATION_SYSTEM))

console.log(`\n RESULT: ${pass} passed, ${fail} failed${fail ? ` — ${failures.join(" | ")}` : ""}`)
if (fail === 0) console.log(" CLIENT_PORTAL_PASS")
process.exit(fail ? 1 : 0)
