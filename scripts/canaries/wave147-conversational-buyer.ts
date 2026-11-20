/**
 * scripts/canaries/wave147-conversational-buyer.ts — CONVERSATIONAL BUYER canary (wave 147, lane 147J; owner ruling 16, contract
 * C10 — lane 147C):
 *   "Buyers find properties the way Deli does — natural language and voice, explainable matching to the buyer's criteria —
 *    delivered INSIDE the existing Shopping Agent / buyer search and portal; no second search system."
 *   → a spoken request → structured criteria in THE ONE store (property_preferences) with provenance per field (said | inferred |
 *     default), each said field quoting the buyer, through the ONE ledgered writer → the search reads the store (what the query
 *     left unsaid is filled from it, the query's own words win) over the shoppable, publicly visible listings → every home
 *     explained as { matches, misses, unknowns } from listing data only — an unknown is never rendered as a fact → behaviour
 *     (saves above the stated budget) PROPOSES a change with a reason → the buyer REJECTS it → it is never offered again →
 *     a showing request: the saved_properties 'tour_requested' row, the agent told (a tour ask notifies; keystrokes do not).
 *
 * Driven through the REAL modules: lib/buyer-search/criteria-turn.ts recordStatedCriteriaTurn / persistCriteriaChanges,
 * buyer-criteria.ts loadBuyerCriteria / loadCriteriaChanges / settleCriteriaChange, conversational-search.ts
 * intentWithStoredCriteria / learnFromBehaviour / shouldNotifyAgent / nextBestExperiences, explanation-generator.ts
 * explainCriteriaFit / composeNeighbourlyExplanation / restatesUnknown, intent-parser.ts, lib/kernel/forms.ts
 * recordBuyerPropertyAction, lib/listings/listing-status-sync.ts publiclyVisibleListingStatuses. No model call (rules only).
 */
import { setSvc } from "./_harness"
import { strippedRepo } from "./_registry"
import { stripComments } from "../strip-comments"
import { memSupabase } from "../in-memory-supabase"
import { quiet } from "./wave145-harness"
import { canary147, jsonOf, seams, tbl } from "./wave147-harness"

const B = "c1470000-0000-4000-8000-00000000c0b1"
const OTHER = "c1470000-0000-4000-8000-00000000c0b2"
const K = "c1470000-0000-4000-8000-00000000c0c1"
const AG = "c1470000-0000-4000-8000-00000000c0a1"
const U = "c1470000-0000-4000-8000-00000000c0e1"
const L_ELM = "c1470000-0000-4000-8000-00000000c101", L_OAK = "c1470000-0000-4000-8000-00000000c102", L_PINE = "c1470000-0000-4000-8000-00000000c103", L_GONE = "c1470000-0000-4000-8000-00000000c104"
const SAID = "3 bed under 600k in Frisco TX with lots of natural light, an open floor plan, less yard, and an easy commute to Plano Medical Center under 30 minutes. No HOA please."
const listing = (id: string, over: Record<string, unknown>) => ({ id, brokerage_id: B, agent_id: AG, status: "active", deleted_at: null, bedrooms: 3, bathrooms: 2, property_type: "single_family", state: "TX", ...over })

export async function run() {
  const c = canary147("Conversational buyer (C10): spoken criteria with provenance in ONE store → search over shoppable public listings → matches / misses / unknowns with no invented fact → a learned proposal the buyer rejects is never offered again → a showing request reaches the agent")
  const svc = c.track(memSupabase({
    brokerages: [{ id: B, name: "Prairie Realty 147J", state: "TX" }],
    agents: [{ id: AG, brokerage_id: B, user_id: U, is_active: true }],
    contacts: [{ id: K, brokerage_id: B, contact_type: "buyer", agent_id: AG, first_name: "Robin" }],
    property_preferences: [], buyer_criteria_changes: [], agent_action_ledger: [], saved_properties: [], manager_signals: [], lifecycle_events: [],
    listings: [
      listing(L_ELM, { address: "12 Elm St", city: "Frisco", price: 575000, hoa_dues: 0, public_remarks: "Sun-filled rooms and an open floor plan on a quiet cul-de-sac.", lot_size: 0.18 }),
      listing(L_OAK, { address: "9 Oak Ct", city: "Frisco", price: 640000, bedrooms: 2, hoa_dues: null, public_remarks: null }),
      listing(L_PINE, { address: "4 Pine Rd", city: "Plano", price: 520000, bedrooms: 4, bathrooms: 3, property_type: "condo", hoa_dues: 250, public_remarks: "Updated kitchen." }),
      listing(L_GONE, { address: "1 Archived Ln", city: "Frisco", price: 550000, deleted_at: "2026-10-01T00:00:00Z", public_remarks: "Bright and open." }),
    ],
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } }), B)
  setSvc(svc)
  seams().recordEmit = true
  const turn = await quiet(async () => import("../../lib/buyer-search/criteria-turn")) as unknown as Record<string, any>
  const bc = await quiet(async () => import("../../lib/buyer-search/buyer-criteria")) as unknown as Record<string, any>
  const cs = await quiet(async () => import("../../lib/buyer-search/conversational-search")) as unknown as Record<string, any>
  const eg = await quiet(async () => import("../../lib/buyer-search/explanation-generator")) as unknown as Record<string, any>
  const ip = await quiet(async () => import("../../lib/buyer-search/intent-parser")) as unknown as Record<string, any>
  const se = await quiet(async () => import("../../lib/buyer-search/search-engine")) as unknown as Record<string, any>
  const lss = await quiet(async () => import("../../lib/listings/listing-status-sync")) as unknown as Record<string, any>

  // ── 1 · natural language → criteria with provenance, in the ONE store, through the ONE ledgered writer ──
  const t1 = await quiet(async () => turn.recordStatedCriteriaTurn(svc, { brokerageId: B, contactId: K, text: SAID, channel: "voice", actor: { type: "user", userId: null }, idempotencyKey: "buyer_search.criteria.update:147j:voice-1", allowModelAssist: false, ledgerClient: svc })) as Record<string, any>
  const crit = await quiet(async () => bc.loadBuyerCriteria(svc, K, { brokerageId: B })) as Record<string, any>
  const prov = (f: string) => crit?.provenance?.[f]
  c.rule("147C", "SPOKEN WORDS BECOME STRUCTURED, EDITABLE CRITERIA WITH PROVENANCE PER FIELD (C10 'provenance per field (said | inferred | default)'): price, beds and city from the buyer's words are 'said' and quote them; the listing type nobody mentioned reads 'default', never 'said'; the lifestyle asks (light, open plan, less yard, commute) and the HOA deal-breaker are captured",
    crit?.maxPrice === 600000 && crit?.minBeds === 3 && (crit?.cities ?? []).includes("Frisco") && ["maxPrice", "minBeds", "cities"].every((f) => prov(f)?.source === "said" && !!prov(f)?.evidence)
      && bc.provenanceOf(crit, "listingType") === "default" && (crit?.dealBreakers ?? []).includes("hoa") && (crit?.lifestyle ?? []).some((l: { kind: string }) => l.kind === "natural_light") && (crit?.lifestyle ?? []).some((l: { kind: string }) => l.kind === "commute"),
    `max ${crit?.maxPrice} (${prov("maxPrice")?.source}, "${String(prov("maxPrice")?.evidence ?? "").slice(0, 40)}"), beds ${crit?.minBeds}, cities ${jsonOf(crit?.cities)}, listingType ${bc.provenanceOf(crit, "listingType")}, deal-breakers ${jsonOf(crit?.dealBreakers)}, lifestyle ${jsonOf((crit?.lifestyle ?? []).map((l: { kind: string }) => l.kind))}`)
  const led = tbl(svc, "agent_action_ledger").filter((l) => l.action === "buyer_search.criteria.update")
  c.rule("147C", "ONE STORE, ONE LEDGERED WRITER (C10 'preferences persist across portal, mobile, email and AI conversation'): the turn landed in property_preferences (the survivor store) and left ONE buyer_search.criteria.update ledger row; a replay of the same turn writes nothing again",
    tbl(svc, "property_preferences").length === 1 && led.length === 1 && led[0].status === "executed" && (t1.changes ?? []).length >= 3,
    `store rows ${tbl(svc, "property_preferences").length}; ledger ${led.length} (${led[0]?.status}); changes ${(t1.changes ?? []).length}`)

  // ── 2 · search reads the store over the shoppable, publicly visible listings ──
  const intent = cs.intentWithStoredCriteria(ip.parseNaturalLanguageQuery("anything with a pool"), crit)
  const own = cs.intentWithStoredCriteria(ip.parseNaturalLanguageQuery("4 bed under 700k in Austin"), crit)
  c.rule("147C", "THE SEARCH READS THE ONE STORE (C10 '→ search'): what a later query leaves unsaid (price, beds, city) is filled from the stored criteria, and the query's own words win over the store",
    intent.maxPrice === 600000 && intent.minBeds === 3 && (intent.cities ?? []).includes("Frisco") && own.maxPrice === 700000 && (own.cities ?? []).includes("Austin") && !(own.cities ?? []).includes("Frisco"),
    `"anything with a pool" → max ${intent.maxPrice}, beds ${intent.minBeds}, cities ${jsonOf(intent.cities)}; "4 bed under 700k in Austin" → max ${own.maxPrice}, cities ${jsonOf(own.cities)}`)
  const shoppable = (se.BUYER_SHOPPABLE_LISTING_STATUSES as string[]).filter((s) => (lss.publiclyVisibleListingStatuses() as string[]).includes(s))
  const { data: pool } = await (svc as any).from("listings").select("*").eq("brokerage_id", B).in("status", shoppable).is("deleted_at", null)
  const homes = (pool ?? []) as Array<Record<string, any>>
  c.rule("147C", "…OVER AUTHORIZED SOURCES ONLY (C10 'search over authorized sources'; C12's ONE public predicate): the buyer shops statuses that are both shoppable and publicly visible, archived rows excluded — POSITIVE CONTROL: the archived Frisco listing exists in the table and is the one left out",
    homes.length === 3 && !homes.some((h) => h.id === L_GONE) && tbl(svc, "listings").some((h) => h.id === L_GONE && !!h.deleted_at) && jsonOf(shoppable) === jsonOf(["active"]),
    `shoppable ∩ public = ${jsonOf(shoppable)}; pool ${homes.map((h) => h.address).join(", ")}; archived seeded ${tbl(svc, "listings").some((h) => h.id === L_GONE)}`)

  // ── 3 · explainable match, no invented fact ──
  const fits = homes.map((h) => ({ h, fit: eg.explainCriteriaFit(h, crit) as { matches: Array<Record<string, any>>; misses: Array<Record<string, any>>; unknowns: Array<Record<string, any>> } }))
  const decided = fits.flatMap((f) => [...f.fit.matches, ...f.fit.misses])
  const unknowns = fits.flatMap((f) => f.fit.unknowns)
  const oak = fits.find((f) => f.h.id === L_OAK)!.fit
  const elm = fits.find((f) => f.h.id === L_ELM)!.fit
  c.rule("147C", "EVERY HOME IS EXPLAINED AS { matches, misses, unknowns } (C10): every match / miss cites a data source, every unknown cites none; 12 Elm's light and open plan match ONLY as the listing agent's words; 9 Oak is over budget and short a bedroom; its light and HOA are UNKNOWN (absence of data is not a 'no'); commute is unknown everywhere (no source measures it)",
    decided.every((i) => i.source !== "none") && unknowns.every((i) => i.source === "none") && elm.matches.filter((m) => m.source === "listing_remarks").length >= 2
      && oak.misses.some((m) => m.field === "maxPrice") && oak.misses.some((m) => m.field === "minBeds") && oak.unknowns.some((u) => u.field === "lifestyle:natural_light") && oak.unknowns.some((u) => u.field === "dealBreakers")
      && fits.every((f) => f.fit.unknowns.some((u) => u.field === "lifestyle:commute")),
    fits.map((f) => `${f.h.address}: ✓${f.fit.matches.length} ✗${f.fit.misses.length} ?${f.fit.unknowns.length}`).join(" · "))
  const voice = eg.composeNeighbourlyExplanation(oak, "9 Oak Ct") as { narrative: string; unknownsSentence: string | null }
  const planted = eg.restatesUnknown("A bright home with lovely natural light", oak)
  c.rule("147C", "NO INVENTED LISTING FACT (C10 item 7 'No invented listing facts'; 'unknowns never rendered as facts'): the neighbourly explanation of 9 Oak says nothing about its unknown light and names it as unknown — POSITIVE CONTROL: a draft claiming 'lovely natural light' for 9 Oak IS caught",
    !eg.restatesUnknown(voice.narrative, oak) && /natural light/i.test(voice.unknownsSentence ?? "") && !!planted,
    `narrative restates an unknown: ${eg.restatesUnknown(voice.narrative, oak) || "no"}; unknowns sentence "${String(voice.unknownsSentence ?? "").slice(0, 90)}"; planted claim caught as ${planted || "NOT CAUGHT"}`)

  // ── 4 · feedback proposes → the buyer rejects → never offered again ──
  const hist = [
    { kind: "saved", price: 640000, city: "Frisco", propertyType: "single_family", listingRef: L_OAK },
    { kind: "toured", price: 655000, city: "Frisco", propertyType: "single_family", listingRef: "c147-ext-1" },
  ]
  const drafts = cs.learnFromBehaviour(crit, hist, { channel: "portal" }) as Array<Record<string, any>>
  const priceDraft = drafts.find((x) => x.field === "maxPrice")
  const persisted = await quiet(async () => turn.persistCriteriaChanges(svc, { brokerageId: B, contactId: K, next: crit, drafts, actor: { type: "system" }, idempotencyKey: "buyer_search.criteria.update:147j:learn-1", trigger: "saved", channel: "portal", reasonDetail: "saved homes above the stated budget", ledgerClient: svc })) as Record<string, any>
  const proposed = (await bc.loadCriteriaChanges(svc, { brokerageId: B, contactId: K, statuses: ["proposed"] })).rows as Array<Record<string, any>>
  const priceRow = proposed.find((r) => r.field === "maxPrice")
  const storeAfterLearn = await quiet(async () => bc.loadBuyerCriteria(svc, K, { brokerageId: B })) as Record<string, any>
  c.rule("147C", "BEHAVIOUR PROPOSES A CHANGE WITH A STATED REASON — NEVER OVER A SAID VALUE (C10 'feedback … updates the criteria with a reason'; lane 147C item 3): saving homes above the buyer's SAID $600k becomes a PROPOSAL (a buyer_criteria_changes row, status proposed, the reason naming the count and the amounts) and the said budget is untouched",
    priceDraft?.status === "proposed" && /above your \$600k/.test(String(priceDraft?.reason ?? "")) && !!priceRow && storeAfterLearn?.maxPrice === 600000 && persisted.error === null,
    `draft ${priceDraft?.status} — "${String(priceDraft?.reason ?? "").slice(0, 90)}"; change row ${priceRow ? priceRow.status : "none"}; stored max ${storeAfterLearn?.maxPrice}`)
  const rejected = await bc.settleCriteriaChange(svc, { brokerageId: B, contactId: K, changeId: priceRow?.id, status: "rejected", decidedByUserId: null })
  const foreign = await bc.settleCriteriaChange(svc, { brokerageId: OTHER, contactId: K, changeId: priceRow?.id, status: "accepted", decidedByUserId: null })
  // the prior decisions exactly as the portal feedback door reads them (statuses proposed + rejected → { field, proposed, status })
  const history = (await bc.loadCriteriaChanges(svc, { brokerageId: B, contactId: K, statuses: ["proposed", "rejected"], limit: 50 })).rows as Array<Record<string, any>>
  const prior = history.map((r) => ({ field: r.field, proposed: r.proposed, status: r.status }))
  const again = cs.learnFromBehaviour(crit, hist, { channel: "portal", prior }) as Array<Record<string, any>>
  const control = cs.learnFromBehaviour(crit, hist, { channel: "portal" }) as Array<Record<string, any>>
  c.rule("147C", "THE BUYER REJECTS IT AND IT IS NEVER OFFERED AGAIN (C10: changes 'the buyer can edit or reject'): the rejection settles the change row (a decision under another tenant matches nothing and FAILS); the same behaviour later proposes no maxPrice change — POSITIVE CONTROL: without the rejection on record, the same behaviour DOES propose it",
    rejected.ok === true && foreign.ok === false && history.some((r) => r.id === priceRow?.id && r.status === "rejected") && !again.some((x) => x.field === "maxPrice") && control.some((x) => x.field === "maxPrice"),
    `reject → ${rejected.ok ? "settled" : rejected.error}; foreign decision → ${foreign.ok ? "SETTLED" : "refused"}; offered again ${again.some((x) => x.field === "maxPrice") ? "YES" : "no"}; control offers ${control.some((x) => x.field === "maxPrice") ? "yes" : "NO"}`)

  // ── 5 · a showing request reaches the agent ──
  const forms = await quiet(async () => import("../../lib/kernel/forms")) as unknown as Record<string, any>
  const tour = await quiet(async () => forms.recordBuyerPropertyAction({ contact_id: K, listing_id: L_ELM, interest_level: "tour_requested", brokerage_id: B, agent_id: AG })) as Record<string, any>
  const saved = tbl(svc, "saved_properties").find((s) => s.contact_id === K && s.listing_id === L_ELM)
  const notifyTour = cs.shouldNotifyAgent({ changes: [], requested: "showing" })
  const notifyLifestyle = cs.shouldNotifyAgent({ changes: [{ field: "lifestyle", status: "applied", provenance: "said" }] })
  const nbe = (cs.nextBestExperiences({ resultsCount: 3, clarifications: [], criteria: crit, savedCount: 1 }) as Array<{ key: string }>).map((x) => x.key)
  c.rule("147C", "A SHOWING REQUEST IS RECORDED AND REACHES THE AGENT, WHO IS INFORMED — NOT FLOODED (C10 item 4 'showing requests'; item 6 'the human agent is informed … without being flooded'): the tour ask lands as the buyer's saved_properties row (tour_requested, owned by the agent's user); a tour ask notifies the agent, a lifestyle-only tweak does not; 'request a showing' is a next-best experience",
    tour.success === true && saved?.interest_level === "tour_requested" && saved?.user_id === U && notifyTour.notify === true && notifyLifestyle.notify === false && nbe.includes("request_showing"),
    `record → ${tour.success ? "ok" : tour.error}; row ${saved ? `${saved.interest_level} (owner ${saved.user_id === U ? "the agent's user" : saved.user_id})` : "none"}; notify tour ${notifyTour.notify} / lifestyle ${notifyLifestyle.notify}; next-best ${jsonOf(nbe)}`)
  const door = strippedRepo("app/actions/buyer-search/conversational-search.ts") ?? ""
  const reactBody = door.slice(door.indexOf("tour_requested"), door.length)
  const wired = /recordBuyerPropertyAction\s*\(/.test(door) && /shouldNotifyAgent\s*\(\s*\{[^}]*requested:\s*input\.kind\s*===\s*"tour_requested"\s*\?\s*"showing"/.test(door) && /tellShoppingAgent\s*\(/.test(door) && /\/portal\/\$\{input\.contactId\}\/showings/.test(reactBody)
  const wiredControl = /recordBuyerPropertyAction\s*\(/.test(stripComments("await recordBuyerPropertyAction({ contact_id })")) && !/recordBuyerPropertyAction\s*\(/.test(stripComments("// recordBuyerPropertyAction( — tombstone"))
  c.rule("147C", "THE PORTAL DOOR WIRES IT (stripped source, app/actions/buyer-search/conversational-search.ts): a tour reaction calls recordBuyerPropertyAction, asks shouldNotifyAgent with requested 'showing', tells the Shopping Agent on the bus and hands the buyer the BBA-gated /portal/<id>/showings request (POSITIVE CONTROL: a call is caught, a tombstone is not)",
    wired && wiredControl, `wired ${wired}; finder control ${wiredControl}`)

  c.blind("searchPropertiesCore is NOT run: it builds its own service client, may call the model gap-fill and the paid external feeds (lane 147C's proof makes the same exclusion; buyer-nl-search Layer 2 covers the live path). The canary composes the search from the module's own pieces — the store read (intentWithStoredCriteria), the shared status predicates (BUYER_SHOPPABLE_LISTING_STATUSES ∩ publiclyVisibleListingStatuses, deleted_at IS NULL) as one in-memory query, and explainCriteriaFit per home. No model call runs (allowModelAssist false); the portal doors are session-gated and judged on stripped source; the kernel event of the tour ask is a recorded edge.")
  return c.report()
}
