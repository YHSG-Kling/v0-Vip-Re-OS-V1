#!/usr/bin/env tsx
/**
 * scripts/intent-interface-guard.ts   (npm run test:intent-interface — pure + static, no DB, no model, no network)
 * Run: NODE_OPTIONS=--max-old-space-size=6000 npx tsx --conditions=react-server scripts/intent-interface-guard.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * C17 — ONE INTENT INTERFACE ACROSS THE WHOLE OS (wave 148, lane 148D).
 *
 * Owner, verbatim (2026-11-01): "when trying to create ads, blogs, etc. the actor/user should be able to speak
 * the search and what they want to accomplish in natural language and this should be the case in the whole OS."
 *
 * WHAT IS HELD
 *   1  THE SIX UTTERANCES the spec names route to the right capability, with the right params and the right
 *      authority outcome — by RULES alone (no model), so the proof is deterministic.
 *   2  MISSING IS ASKED, NEVER GUESSED — the clarification names the field; an answer added to the same request
 *      clears it; the model's answer is re-checked (a value not in the words is dropped; dates re-derived).
 *   3  AUTHORITY — role → feature (FEATURE_FLAGS), never-spoken, the risk ceiling, fail closed on an unknown
 *      role, a buyer limited to their own portal, an ad audience by a protected characteristic dropped.
 *   4  EXECUTION RAILS — executeIntent refuses / asks / waits for a yes / hands off BEFORE it reads anything;
 *      every consequential domain executor is ledgered (domain.entity.action); the door takes the tenant from
 *      the session and refuses a bearer token; the model call is booked to the session tenant.
 *   5  ONE INTENT SYSTEM (census) — no actor-command classifier outside the C17 module; every legacy door
 *      reads its intent from interpretIntentLive; every legacy executor key is a branch its surface handles;
 *      one phrase → one route; the catalogue's managers / capabilities / features / services are real.
 *   6  ONE AFFORDANCE (census) — every mount names a real screen; every screen is mounted; one caller of the
 *      door; every other speech-recognition surface is a NAMED exemption saying where its words go; the
 *      accessibility contract (label, live region, text fallback, aria-pressed, Escape).
 *   7  C10 — a buyer's words are recorded with literal wording, interpretation, confidence and consent; a
 *      correction keeps history; a phone call states its own basis.
 *   8  THE PROMPT STANDARD — the one prompt carries every required section and every route.
 *   X  POSITIVE CONTROLS for every finder (§2: a broken finder and a clean tree both report zero).
 *
 * BLIND SPOTS (published, §2)
 *   · The six utterances are proven by RULES; a paraphrase relies on the model assist, which this proof cannot
 *     run (it proves the re-check of the model's answer instead).
 *   · The census finds a classifier by its SHAPE (a prompt listing snake_case intents beside a model call, the
 *     retired function names, the retired prompt phrases). A classifier written in a novel shape — a JSON
 *     schema enum of intents with no bulleted list — is not seen.
 *   · Executors are proven up to the gate (refuse / ask / confirm / hand off) and statically for the ledger;
 *     the DB legs (the listing ad producer, the blog writer, the open-house door, the buyer search) are their
 *     own proofs' — this one does not drive them.
 *   · The ElevenLabs Conversational AI agent (app/api/agent-assistant/tool-call/route.ts) selects tools itself
 *     from lib/voice/tool-registry.ts under that route's authority check — a provider-side tool loop, not a
 *     classifier in this tree; it is carried as Still open, not merged.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "./strip-comments"
import {
  interpretIntent, intentCatalogue, intentRoute, checkIntentAuthority, recheckModelPick, interestStem, criteriaMentions,
  intentSystemPrompt, matchRoutes, classifyClientIntent, INTENT_SCREENS,
  type IntentActor, type IntentRoute,
} from "../lib/voice-admin/intent-interface"
import { voiceCapabilities, VOICE_NEVER_SPOKEN } from "../lib/voice-admin/kernel-command-surface"
import { APP_CAPABILITY_REGISTRY } from "../lib/agentic-os/app-capability-registry"
import { MANAGERS } from "../lib/kernel/manager-registry"
import { FEATURE_FLAGS } from "../lib/security/permission-matrix"
import { COMMAND_MAP } from "../app/actions/voice-assistant/helpers/command-map"
import { applyConversationTurn, emptyCriteria, type CriteriaStatement } from "../lib/buyer-search/conversational-search"
import { defaultCriteriaConsent, CRITERIA_CONSENT_BASES } from "../lib/buyer-search/buyer-criteria"
import { extractCriteriaFromTranscript, extractLifestyleAsks } from "../lib/buyer-search/conversation-criteria"

const root = process.cwd()
const raw = (rel: string) => readFileSync(join(root, rel), "utf8")
const code = (rel: string) => stripComments(raw(rel))
let pass = 0, fail = 0
const failures: string[] = []
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const NOW = new Date("2026-11-01T12:00:00Z") // a Sunday
const agent: IntentActor = { userId: "00000000-0000-4000-8000-000000000001", userType: "agent", platformRole: null, agentId: "00000000-0000-4000-8000-0000000000a1" }
const tenant = { brokerageId: "00000000-0000-4000-8000-0000000000b1" }
const say = (utterance: string, actor: IntentActor = agent, extra: Partial<Parameters<typeof interpretIntent>[0]> = {}) =>
  interpretIntent({ utterance, modality: "voice", actor, tenant, now: NOW, ...extra })

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(relative(root, p))
  }
  return out
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" C17 — one intent interface, one affordance, the whole OS")
  console.log("══════════════════════════════════════════════════")

  // ── 1 · THE SIX UTTERANCES ────────────────────────────────────────────────
  console.log("\n── 1 · the six utterances (rules only) ──")
  const ad = say("Create an ad for my new listing")
  check("1a 'Create an ad for my new listing' → listing_ad_draft (governed by ad_campaign_launch, ads manager)",
    ad.capability === "listing_ad_draft" && ad.governedBy === "ad_campaign_launch" && ad.manager === "ads_manager", JSON.stringify({ c: ad.capability }))
  check("1a …listing = the agent's newest listing (resolved at execution, never invented), kind just_listed",
    ad.params.listing === "latest" && ad.params.kind === "just_listed" && ad.missing.length === 0)
  check("1a …allowed for an agent, waits for a yes, and its creative waits for the approver",
    ad.authority_check.outcome === "allowed" && ad.authority_check.confirmationRequired && ad.authority_check.approvalRequired && ad.plan.needsConfirmation)

  const buyers = say("Find buyers interested in acreage")
  check("1b 'Find buyers interested in acreage' → buyer_interest_search, interest 'acreage'",
    buyers.capability === "buyer_interest_search" && buyers.params.interest === "acreage")
  check("1b …a READ: allowed, no confirmation, scoped to the agent's OWN contacts (contacts, never leads)",
    buyers.authority_check.allowed && !buyers.authority_check.confirmationRequired && buyers.authority_check.dataScope === "own")

  const blog = say("Write a blog on this month's market")
  check("1c 'Write a blog on this month's market' → market_blog_draft (governed by blog_publish, campaign manager)",
    blog.capability === "market_blog_draft" && blog.governedBy === "blog_publish" && blog.manager === "campaign_orchestrator")
  check("1c …topic captured, period derived from 'this month' (November 2026), area left to the verified territory",
    blog.params.topic === "this month's market" && blog.params.period === "November 2026" && blog.params.area === null && blog.missing.length === 0)
  check("1c …confirmation + approver before publication", blog.authority_check.confirmationRequired && blog.authority_check.approvalRequired)

  const homes = say("Find homes with a private backyard and a short commute")
  check("1d 'Find homes with a private backyard and a short commute' → property_search (shopping agent)",
    homes.capability === "property_search" && homes.manager === "shopping_agent")
  check("1d …criteria from the ONE C10 parser (backyard, commute)", /backyard/.test(homes.params.criteria ?? "") && /commute/.test(homes.params.criteria ?? ""))
  check("1d …the buyer and the commute destination are ASKED, never guessed",
    homes.missing.map((m) => m.param).join(",") === "buyer,commute_destination" && homes.params.commute_destination === null && homes.clarification === homes.missing[0].ask)

  const oh = say("Schedule a virtual open house")
  check("1e 'Schedule a virtual open house' → open_house_schedule, kind virtual_open_house (listing concierge)",
    oh.capability === "open_house_schedule" && oh.params.kind === "virtual_open_house" && oh.manager === "listing_concierge")
  check("1e …listing, day, start, end and the https join link are all asked (in that order)",
    oh.missing.map((m) => m.param).join(",") === "listing,date,start_time,end_time,join_url")

  const care = say("Show me which contacts may need help")
  check("1f 'Show me which contacts may need help' → contact_care_scan (sphere manager), a READ, allowed",
    care.capability === "contact_care_scan" && care.manager === "sphere_of_influence" && care.authority_check.allowed && !care.authority_check.confirmationRequired)
  check("1 all six are understood by RULES with high confidence (no model needed for the owner's words)",
    [ad, buyers, blog, homes, oh, care].every((r) => r.via === "rules" && r.confidence === "high"))
  check("1 typed and spoken land identically (modality is recorded, not a second path)",
    interpretIntent({ utterance: "Create an ad for my new listing", modality: "text", actor: agent, tenant, now: NOW }).capability === ad.capability)

  // ── 2 · MISSING IS ASKED, NEVER GUESSED ───────────────────────────────────
  console.log("\n── 2 · clarification ──")
  const ohFull = say("Schedule a virtual open house for 12 Oak Street on Saturday from 1 to 3 pm https://zoom.us/j/123456")
  check("2a every field said → nothing missing; Saturday → 2026-11-07; 1–3 pm → 13:00–15:00; the join link kept",
    ohFull.missing.length === 0 && ohFull.params.date === "2026-11-07" && ohFull.params.start_time === "13:00" && ohFull.params.end_time === "15:00" && ohFull.params.join_url === "https://zoom.us/j/123456" && ohFull.params.listing === "address:12 Oak Street")
  const combined = say("Schedule a virtual open house. 12 Oak Street Saturday 1 to 3 pm https://zoom.us/j/9")
  check("2b the affordance's clarification loop (answer appended to the same request) clears what was missing", combined.missing.length === 0 && combined.capability === "open_house_schedule")
  const inPerson = say("Schedule an open house for 12 Oak Street tomorrow from 11am to 1pm")
  check("2c an in-person open house does not ask for a join link (conditional requirement)", inPerson.params.kind === "open_house" && inPerson.missing.length === 0 && inPerson.params.date === "2026-11-02")
  const onContact = say("Find homes with a big yard and a short commute", agent, { context: { contactId: "00000000-0000-4000-8000-0000000000c1" } })
  check("2d on a contact's page the buyer comes from the page (re-read under the tenant at execution) — not asked",
    onContact.params.buyer === "id:00000000-0000-4000-8000-0000000000c1" && !onContact.missing.some((m) => m.param === "buyer"))
  const vague = say("Schedule an open house for 12 Oak Street sometime soon")
  check("2e no day or hour is defaulted (null → asked), and the house number 12 is never read as a time",
    vague.params.date === null && vague.params.start_time === null && vague.missing.some((m) => m.param === "date") && vague.missing.some((m) => m.param === "start_time"))
  check("2e′ spoken days / times ride the voice lane's ONE resolver (lib/voice/spoken-values.ts), not a second spelling",
    /from "@\/lib\/voice\/spoken-values"/.test(code("lib/voice-admin/intent-interface.ts")) && !/export function spokenDate/.test(code("lib/voice-admin/intent-interface.ts")))
  const picked = recheckModelPick({ route: "open_house_schedule", params: [{ name: "listing", value: "45 Elm Street" }, { name: "date", value: "2026-12-25" }, { name: "kind", value: "virtual" }], confidence: "high", needs_human: false, reason: "x" }, "set up a virtual open house this weekend", NOW)
  check("2f the model's answer is re-checked: a listing the person never said is DROPPED; its date is ignored and re-derived from the words",
    picked.routeKey === "open_house_schedule" && picked.params.listing === undefined && picked.params.date === null && picked.params.kind === "virtual" && picked.notes.some((n) => /45 Elm/.test(n)))
  check("2g a route the catalogue does not have is dropped; needs_human is a refusal, never a route",
    recheckModelPick({ route: "wire_money", params: [], confidence: "high", needs_human: false, reason: "" }, "wire the funds", NOW).routeKey === null
    && recheckModelPick({ route: "listing_ad_draft", params: [], confidence: "high", needs_human: true, reason: "" }, "sign the contract", NOW).routeKey === null)
  const none = say("the weather looks lovely today")
  check("2h an unrelated sentence matches nothing and SAYS so (no fabricated action)", none.capability === null && /didn't catch/.test(none.plan.summary))

  // ── 3 · AUTHORITY ─────────────────────────────────────────────────────────
  console.log("\n── 3 · authority ──")
  const co = say("Create an ad for my new listing", { ...agent, userType: "compliance_officer" })
  check("3a a compliance officer may not draft ads (FEATURE_FLAGS.campaigns excludes the role, CLAUDE.md §4/§5)", co.authority_check.outcome === "refused_role" && co.missing.length === 0)
  const vendor = say("Show me which contacts may need help", { ...agent, userType: "vendor", agentId: null })
  check("3b a vendor seat sees no contact list", vendor.authority_check.outcome === "refused_role")
  const unknownRole = say("Show me which contacts may need help", { ...agent, userType: null })
  check("3c an unreadable role FAILS CLOSED", unknownRole.authority_check.outcome === "refused_role" && !unknownRole.authority_check.allowed)
  const staff = say("Show me which contacts may need help", { ...agent, userType: "admin", platformRole: "superadmin" })
  check("3d platform staff (platform_role, never user_type='superadmin') are admitted with an 'all' data scope", staff.authority_check.allowed && staff.authority_check.dataScope === "all")
  const broker = say("Find buyers interested in acreage", { ...agent, userType: "broker" })
  check("3e a broker searches the brokerage's buyers (data scope brokerage), an agent only their own", broker.authority_check.dataScope === "brokerage" && buyers.authority_check.dataScope === "own")
  const buyerActor: IntentActor = { userId: "00000000-0000-4000-8000-0000000000d1", userType: "contact", platformRole: null, agentId: null, contactId: "00000000-0000-4000-8000-0000000000c9", contactType: "buyer" }
  const buyerSearch = say("Find homes with a private backyard and a short commute to the Medical Center", buyerActor)
  check("3f a BUYER in their portal: the client floor routes their search to property_search, buyer = themselves",
    buyerSearch.capability === "property_search" && buyerSearch.params.buyer === "id:00000000-0000-4000-8000-0000000000c9" && buyerSearch.authority_check.dataScope === "self")
  const buyerAd = say("create an ad for my new listing", buyerActor)
  check("3g …and a buyer's other requests stay client requests (an ad is never theirs to draft)", buyerAd.family === "client_portal" && buyerAd.capability !== "listing_ad_draft")
  const sellerAct = say("please lower the price to 450", { ...buyerActor, contactType: "seller" })
  check("3h a SELLER's price change is a proposal to the agent (client floor, kept verbatim)", sellerAct.capability === "client_seller_action" && classifyClientIntent("please lower the price to 450", "seller") === "seller_action")
  const synthetic = (over: Partial<IntentRoute>): IntentRoute => ({ ...intentRoute("contact_care_scan")!, ...over })
  check("3i POSITIVE CONTROL: a route governed by a never-spoken capability is refused (money / books / legal stage)",
    checkIntentAuthority(synthetic({ governedBy: "payment_transfer" }), agent).outcome === "refused_never_spoken")
  check("3j POSITIVE CONTROL: FINANCIAL / LEGAL risk is refused from a sentence (the assistant's one ceiling rule)",
    checkIntentAuthority(synthetic({ risk: "FINANCIAL" }), agent).outcome === "refused_risk" && checkIntentAuthority(synthetic({ risk: "LEGAL" }), agent).outcome === "refused_risk")
  check("3k the catalogue speaks NO never-spoken capability", !intentCatalogue().some((r) => r.governedBy && (VOICE_NEVER_SPOKEN as readonly string[]).includes(r.governedBy)))
  check("3l an operability block is said BEFORE anything is promised",
    say("Create an ad for my new listing", agent, { operable: { ad_campaign_launch: false }, blockReason: { ad_campaign_launch: "connect Meta first" } }).authority_check.outcome === "not_operable")
  // Re-asserted wave 149Z to the owner's 2026-11-03 rule: a PERSONA audience is lawful ("seniors" passes); what is dropped
  // is the housing ad platform's refused narrowing (age / gender / ZIP / lookalike) and proxy wording. Positive control flipped.
  const narrowedAudience = say("Create an ad for my new listing targeting buyers aged 55 and over")
  check("3m PLATFORM RULE ON AD AUDIENCES: age narrowing ('aged 55 and over') is DROPPED with Meta's Special Ad Category reason; the ad still drafts on location",
    narrowedAudience.params.audience === null && narrowedAudience.notes.some((n) => /Special Ad Category/.test(n)) && narrowedAudience.capability === "listing_ad_draft", JSON.stringify(narrowedAudience.params.audience))
  const lookalike = say("Create an ad for my new listing targeting a lookalike of my past buyers")
  check("3m' …a LOOKALIKE audience is dropped too (Meta housing delivery rule)", lookalike.params.audience === null && lookalike.notes.some((n) => /lookalike/.test(n)), JSON.stringify(lookalike.params.audience))
  const personaAudience = say("Create an ad for my new listing targeting seniors")
  check("3n …a PERSONA audience ('seniors') passes untouched — every persona is allowed (owner ruling 1)", personaAudience.params.audience === "seniors" && personaAudience.notes.length === 0, JSON.stringify(personaAudience.params.audience))
  const needsAudience = say("Create an ad for my new listing targeting first-time buyers")
  check("3n' …'first-time buyers' passes untouched (control)", needsAudience.params.audience === "first-time buyers" && needsAudience.notes.length === 0)
  // Wave 149 integration (owner ruling 1 + C20): a typed audience word that IS a persona label of the OS ("empty nesters" is a
  // kernel-portal persona and a life-event situation) is an audience BASIS, not a familial-status proxy; a word that is only a
  // protected class ("women" — gender, which Meta's housing category refuses at delivery anyway) still drops the audience.
  const personaWord = say("Create an ad for my new listing targeting empty nesters")
  check("3n'' …'empty nesters' passes untouched — a persona label is never a proxy (owner ruling 1, personaAudienceLabels)", personaWord.params.audience === "empty nesters" && personaWord.notes.length === 0, JSON.stringify(personaWord.params.audience))
  const classWord = say("Create an ad for my new listing targeting women")
  check("3n''' POSITIVE CONTROL — 'women' (a protected class, not a persona) is still dropped with the proxy reason", classWord.params.audience === null && classWord.notes.some((n) => /women/.test(n)), JSON.stringify(classWord.params.audience))

  // ── 4 · EXECUTION RAILS ───────────────────────────────────────────────────
  console.log("\n── 4 · execution rails ──")
  const live = await import("../lib/voice-admin/intent-interface-live")
  const ctx = { actor: agent, tenant, confirmed: false }
  const exRefused = await live.executeIntent(co, ctx)
  check("4a refused authority → 'refused', nothing read (no client was even created)", exRefused.status === "refused")
  const exInfo = await live.executeIntent(oh, ctx)
  check("4b missing information → 'needs_info' with the question", exInfo.status === "needs_info" && exInfo.say === oh.missing[0].ask)
  const exConfirm = await live.executeIntent(ad, ctx)
  check("4c a mutating route on an UNCONFIRMED turn → 'needs_confirmation' with the plan's steps", exConfirm.status === "needs_confirmation" && exConfirm.results.length === ad.plan.steps.length)
  const exHandoff = await live.executeIntent(say("what should I do today"), ctx)
  check("4d an intent the team brain executes → 'handoff' to that door (the brain keeps its executor)", exHandoff.status === "handoff" && exHandoff.executorDoor === "team_brain")
  const liveSrc = code("lib/voice-admin/intent-interface-live.ts")
  const execBody = liveSrc.slice(liveSrc.indexOf("export async function executeIntent"))
  const iAuth = execBody.indexOf("authority_check.allowed"), iMissing = execBody.indexOf("i.missing.length > 0"), iConfirm = execBody.indexOf("!ctx.confirmed"), iSvc = execBody.indexOf("createServiceClient()")
  check("4e the gate order is the kernel lane's: authority → missing → confirmation → only then a client", iAuth > 0 && iAuth < iMissing && iMissing < iConfirm && iConfirm < iSvc)
  const actions = [...execBody.matchAll(/action:\s*"([^"]+)"/g)].map((m) => m[1])
  check(`4f every consequential domain executor is ledgered with a domain.entity.action name (${actions.join(", ")})`,
    actions.length === 3 && actions.every((a) => /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(a)) && (execBody.match(/withActionLedger</g) ?? []).length === 3)
  check("4g the model assist is the ROUTED, tenant-booked lane (generateObjectRouted, intent_classification, the session tenant)",
    /generateObjectRouted\(\{[\s\S]{0,120}feature: "intent_classification",\s*brokerageId: input\.tenant\.brokerageId/.test(liveSrc))
  check("4h the confident rules route is never swapped by the model (it may only fill details)", /rulesStand && checked\.routeKey !== result\.capability/.test(liveSrc))
  const door = code("app/api/agentic-os/voice/route.ts")
  check("4i the door refuses a bearer token and takes tenant + actor from the SESSION (requireAuth), never the body",
    /caller\.via === "token"[\s\S]{0,700}status: 403/.test(door) && /brokerageId: auth\.brokerageId/.test(door) && !/body\.brokerageId|body\.userId|body\.role/.test(door))
  check("4j every interpretation lands in voice_commands with its error READ", /from\("voice_commands"\)\.insert[\s\S]{0,1500}if \(error\) console\.error/.test(liveSrc))
  check("4k POSITIVE CONTROL: the ledger-name finder rejects a malformed name", !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test("marketing.ad"))

  // ── 5 · ONE INTENT SYSTEM (census) ────────────────────────────────────────
  console.log("\n── 5 · one intent system (census) ──")
  const C17_FILES = new Set(["lib/voice-admin/intent-interface.ts", "lib/voice-admin/intent-interface-live.ts", "lib/voice-admin/kernel-command-surface.ts"])
  /** Third-party MESSAGE classifiers — they read what a lead / contact / caller WROTE, not an actor's command to the OS. */
  // Only what the finder actually flags is listed (6 below holds "no stale exemption"); the other message
  // classifiers in the tree (lead-pipeline/ai-intent-classifier, unknown-sender-identification,
  // ai-isa/lead-call-intent, lead-intent/inbound-lead-intent) are not shaped like a command classifier.
  const MESSAGE_CLASSIFIERS: Record<string, string> = {
    "lib/intelligence/intent-classifier.ts": "inbound message intent + urgency — a lead's message, not an actor's command (AI_TASK_ROUTING.inbound_intent_classification)",
  }
  const RETIRED_SHAPES: RegExp[] = [
    /Classify the real estate assistant voice command/i,
    /Detect Intent \(one of\)/,
    /voice command parser for a real estate/i,
    /Examples of target_action values/,
    /Respond with ONLY the intent string/,
    /function\s+(parseVoiceIntent|simpleIntentParsing|parseLLMIntent|parseFallbackIntent)\b/,
  ]
  const MODEL_CALL = /\b(generateTextRouted|generateObjectRouted|gatewayChat|generateText|generateObject)\s*\(|\/api\/ai\/analyze/
  const looksLikeClassifier = (src: string): boolean => {
    if (RETIRED_SHAPES.some((r) => r.test(src))) return true
    const bullets = (src.match(/(?:^|\n|\\n)\s*-\s*[a-z]+(?:_[a-z]+)+\s*:/g) ?? []).length
    return bullets >= 5 && /\bintent/i.test(src) && MODEL_CALL.test(src)
  }
  const files = [...walk(join(root, "app")), ...walk(join(root, "lib"))]
  const hits = files.filter((f) => !C17_FILES.has(f) && looksLikeClassifier(stripComments(raw(f))))
  const actorHits = hits.filter((f) => !MESSAGE_CLASSIFIERS[f])
  check(`5a NO actor-command intent classifier outside the C17 module (scanned ${files.length} files; ${hits.length - actorHits.length} named message classifiers set aside)`,
    actorHits.length === 0, actorHits.join(", "))
  for (const [f, why] of Object.entries(MESSAGE_CLASSIFIERS)) check(`5a′ the exemption is live (the finder still flags it — no stale exemption): ${f} (${why})`, hits.includes(f))
  const fixtureCopy = 'const r = await generateTextRouted({ system: `Classify the command into one of these intents:\n- query_showings: a\n- query_tasks: b\n- create_task: c\n- draft_offer: d\n- area_query: e` })'
  check("5b POSITIVE CONTROL: the finder catches a copied classifier (bulleted intents beside a model call)", looksLikeClassifier(fixtureCopy))
  check("5c POSITIVE CONTROL: the finder catches each retired shape (the old field-mic prompt, the old command-layer function)",
    looksLikeClassifier("const prompt = `Detect Intent (one of):`") && looksLikeClassifier("function parseLLMIntent(t) {}"))
  check("5d BLINDNESS CONTROL: the census reads comment-STRIPPED source (a tombstone naming parseVoiceIntent is not a classifier)",
    !looksLikeClassifier(stripComments("// TOMBSTONE: function parseVoiceIntent(x) moved\nexport const a = 1\n")))
  const DOORS = ["app/api/agentic-os/voice/route.ts", "app/api/internal/voice-command/route.ts", "app/actions/voice-assistant.ts", "app/actions/voice-assistant/core/parse-intent.ts"]
  check("5e every actor-command door reads its intent from interpretIntentLive (agentic-os/voice · the team brain · the field mic · the command layer)",
    DOORS.every((d) => /interpretIntentLive\(/.test(code(d))), DOORS.filter((d) => !/interpretIntentLive\(/.test(code(d))).join(", "))
  check("5f each retired classifier carries a TOMBSTONE naming the survivor", DOORS.slice(1).every((d) => /TOMBSTONE[\s\S]{0,900}lib\/voice-admin\/intent-interface\.ts/.test(raw(d))))
  check("5g the client portal's floor moved INTO the one module and is re-exported (one spelling for its importers)",
    /export function classifyClientIntent/.test(code("lib/voice-admin/intent-interface.ts")) && !/export function classifyClientIntent/.test(code("lib/portal/client-action-router.ts")) && /export \{ classifyClientIntent/.test(code("lib/portal/client-action-router.ts")))
  const brain = code("app/api/internal/voice-command/route.ts")
  const brainBranches = new Set([...brain.matchAll(/intent === "([a-z_]+)"/g)].map((m) => m[1]))
  const brainExecs = intentCatalogue().map((r) => r.executors.team_brain).filter((x): x is string => !!x)
  check(`5h every team-brain executor key is a branch the brain handles, and every branch is reachable (${brainExecs.length} keys)`,
    brainExecs.every((k) => brainBranches.has(k)) && [...brainBranches].every((b) => brainExecs.includes(b)), [...brainBranches].filter((b) => !brainExecs.includes(b)).join(","))
  const field = code("app/actions/voice-assistant.ts")
  const fieldCases = new Set([...field.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]))
  const fieldExecs = intentCatalogue().map((r) => r.executors.field_assistant).filter((x): x is string => !!x)
  check(`5i every field-mic executor key is a case its switch handles (${fieldExecs.length} keys)`, fieldExecs.every((k) => fieldCases.has(k)), fieldExecs.filter((k) => !fieldCases.has(k)).join(","))
  const cmdExecs = intentCatalogue().map((r) => r.executors.command_layer).filter((x): x is string => !!x)
  const cmdKeys = Object.keys(COMMAND_MAP)
  check(`5j every command-layer executor is a COMMAND_MAP command, and every command is routed (${cmdExecs.length}/${cmdKeys.length})`,
    cmdExecs.every((k) => cmdKeys.includes(k)) && cmdKeys.every((k) => cmdExecs.includes(k)), cmdKeys.filter((k) => !cmdExecs.includes(k)).join(","))
  const owner = new Map<string, string>()
  const dupPhrases: string[] = []
  for (const r of intentCatalogue()) for (const p of r.phrases) { const k = p.toLowerCase().trim(); if (owner.has(k) && owner.get(k) !== r.key) dupPhrases.push(`${k} (${owner.get(k)} / ${r.key})`); owner.set(k, r.key) }
  check("5k ONE PHRASE → ONE ROUTE (one vocabulary of intents, §6)", dupPhrases.length === 0, dupPhrases.join("; "))
  const keys = intentCatalogue().map((r) => r.key)
  check("5l every route key is unique", new Set(keys).size === keys.length)
  check("5m the kernel lane is DERIVED: every speakable capability is a kernel route (no second list)",
    voiceCapabilities().every((vc) => intentRoute(vc.capability)?.family === "kernel_signal"))
  const badRoutes = intentCatalogue().filter((r) =>
    !(r.manager in MANAGERS) || (r.governedBy && !APP_CAPABILITY_REGISTRY[r.governedBy]) || (r.feature !== null && !(r.feature in FEATURE_FLAGS))
    || !existsSync(join(root, r.service.split(/[: ]/)[0])))
  check("5n every route names a real manager, catalogue capability, role feature and an existing service file", badRoutes.length === 0, badRoutes.map((r) => r.key).join(","))
  // The kernel table (VOICE_PHRASES) is the survivor's and its own proof holds its two specific single words
  // ("repurpose", "milestone"); every phrase THIS lane authored is multi-word.
  const kernelPhrase = (r: IntentRoute, p: string) => r.family === "kernel_signal" && voiceCapabilities().some((vc) => vc.capability === r.key && vc.phrases.includes(p))
  const singles = intentCatalogue().flatMap((r) => r.phrases.filter((p) => p.trim().split(/\s+/).length < 2 && !kernelPhrase(r, p)).map((p) => `${r.key}:${p}`))
  check("5o every phrase this lane authored is multi-word (a generic token never triggers work)", singles.length === 0, singles.join(","))
  // THE TEAM-COMMAND FLOOR IS PICKED INSIDE THE ONE MODULE (wave 148Z — lane 148D Still open 1 closed). The floor
  // (lib/voice/parse-team-command.ts) names the team dispatcher's own commands; its ONLY caller is interpretIntent
  // (teamCommandFloor → interpretation.teamCommand). The two surfaces that execute team commands (the Command Center bar,
  // the spoken admin's run_team_command) read interpretation.teamCommand and call no parser themselves. This check read
  // "only its two NAMED callers, each asking C17 first" while the merge was pending — tightened to ONE caller (the rule
  // can only shrink further, never widen).
  const FLOOR_SURFACES = ["app/actions/command-center.ts", "app/api/agent-assistant/tool-call/route.ts"]
  const floorCallers = files.filter((f) => f !== "lib/voice/parse-team-command.ts" && /parseTeamCommandText\(/.test(stripComments(raw(f))))
  check("5q the team-command floor has exactly ONE caller — interpretIntent (lib/voice-admin/intent-interface.ts) — and both surfaces read interpretation.teamCommand",
    floorCallers.length === 1 && floorCallers[0] === "lib/voice-admin/intent-interface.ts"
    && FLOOR_SURFACES.every((f) => /interpretIntent\(/.test(code(f)) && /interpretation\.teamCommand\b/.test(code(f))),
    floorCallers.join(","))
  check("5q POSITIVE CONTROL: the floor-caller finder sees a direct call, and not one only named in a tombstone",
    /parseTeamCommandText\(/.test(stripComments(`const parsed = parseTeamCommandText(text)`))
    && !/parseTeamCommandText\(/.test(stripComments(`// TOMBSTONE: this bar called parseTeamCommandText(text) itself\nconst parsed = interpretation.teamCommand`)))
  {
    const tc = (u: string) => interpretIntent({ utterance: u, modality: "text", actor: { userId: "u", userType: "broker", platformRole: null, agentId: "a" }, tenant: { brokerageId: "b" } })
    const standup = tc("what should I do today")
    const ad = tc("create an ad for my new listing at 12 Oak Street")
    const nothing = tc("what's the weather")
    check("5r C17 names the team command when no domain route owns the sentence; a domain route carries none; nonsense carries none",
      standup.teamCommand !== null && standup.family !== "domain" && ad.family === "domain" && ad.teamCommand === null && nothing.teamCommand === null,
      JSON.stringify({ standup: standup.teamCommand?.name ?? null, standupFamily: standup.family, ad: ad.teamCommand, nothing: nothing.teamCommand }))
  }
  check("5p POSITIVE CONTROL: the phrase-collision finder sees a collision", (() => { const m = new Map<string, string>(); let d = 0; for (const [k, p] of [["a", "find buyers"], ["b", "find buyers"]]) { if (m.has(p) && m.get(p) !== k) d++; m.set(p, k) } return d === 1 })())

  // ── 6 · ONE AFFORDANCE (census) ───────────────────────────────────────────
  console.log("\n── 6 · one affordance (census) ──")
  const appFiles = walk(join(root, "app"))
  const mounts: Array<{ file: string; screen: string }> = []
  for (const f of appFiles) for (const m of stripComments(raw(f)).matchAll(/<IntentAffordance[\s\S]{0,40}?screen="([a-z_]+)"/g)) mounts.push({ file: f, screen: m[1] })
  check(`6a every mount names a screen in INTENT_SCREENS (${mounts.length} mounts)`, mounts.length > 0 && mounts.every((m) => m.screen in INTENT_SCREENS), mounts.filter((m) => !(m.screen in INTENT_SCREENS)).map((m) => `${m.file}:${m.screen}`).join(","))
  const mounted = new Set(mounts.map((m) => m.screen))
  check("6b every screen in INTENT_SCREENS is mounted (no declared screen without the affordance)", Object.keys(INTENT_SCREENS).every((s) => mounted.has(s)), Object.keys(INTENT_SCREENS).filter((s) => !mounted.has(s)).join(","))
  const REQUIRED_MOUNTS: Array<[string, string]> = [
    ["app/dashboard/campaigns/ads/page.tsx", "ads"], ["app/dashboard/marketing/blog/page.tsx", "blog"], ["app/crm/page.tsx", "contacts"],
    ["app/dashboard/open-houses/page.tsx", "open_houses"], ["app/mobile/assistant/page.tsx", "mobile"],
    ["app/components/shared/internal-ai-assistant.tsx", "assistant"], ["app/components/dashboard/voice/KernelPlanCard.tsx", "voice_center"],
  ]
  check("6c mounted on the owner's screens: ads · blog · contacts · open houses · mobile · the shell assistant (every staff screen) · voice center",
    REQUIRED_MOUNTS.every(([f, s]) => mounts.some((m) => m.file === f && m.screen === s)), REQUIRED_MOUNTS.filter(([f, s]) => !mounts.some((m) => m.file === f && m.screen === s)).map(([f]) => f).join(","))
  check("6d the shell assistant is mounted app-wide by the AppShell (desktop + the mobile layout)", /<PageContextAssistant/.test(code("app/components/layout/app-shell.tsx")))
  const doorCallers = appFiles.filter((f) => /["'`]\/api\/agentic-os\/voice["'`]/.test(stripComments(raw(f))))
  check("6e ONE caller of the C17 door — the affordance itself", doorCallers.length === 1 && doorCallers[0] === "app/components/shared/intent-affordance.tsx", doorCallers.join(","))
  check("6f KernelPlanCard is a binding of the one affordance, not a second implementation", /<IntentAffordance screen="voice_center"/.test(code("app/components/dashboard/voice/KernelPlanCard.tsx")) && !/fetch\(/.test(code("app/components/dashboard/voice/KernelPlanCard.tsx")))
  /** Every OTHER browser speech-recognition surface, and where its words go. A new one fails until named. */
  const STT_EXEMPT: Record<string, string> = {
    "app/components/shared/internal-ai-assistant.tsx": "the shell assistant — its spoken commands go to the team brain, whose intent is C17's; a plan another desk owns renders <IntentAffordance screen=\"assistant\">",
    "app/components/dashboard/voice/WakeWordCard.tsx": "the command layer's wake word — handleVoiceCommand → parseIntent → C17",
    "app/mobile/voice/voice-session-button.tsx": "the field mic — processVoiceCommand → C17 (and the voice intake drafts)",
    "app/portal/[contactId]/search/PortalNlSearch.tsx": "a BUYER dictating their own criteria — the C10 criteria door (one capability, the one C10 parser), not an intent router",
    "app/components/portal/PersonaPropertiesDashboard.tsx": "a buyer dictating a property search in their portal — the C10 search, not an intent router",
    "app/crm/contacts/[contactId]/components/voice-note-card.tsx": "DICTATION of a note onto one contact — words into a note, never a command",
    "app/components/features/ai-avatar-chat/SimliFaceSession.tsx": "a live avatar CONVERSATION (the portal chat), not a command to the OS",
  }
  const sttFiles = [...appFiles, ...walk(join(root, "lib"))].filter((f) => /SpeechRecognition|webkitSpeechRecognition/.test(stripComments(raw(f))) && f !== "app/components/shared/intent-affordance.tsx")
  const unnamed = sttFiles.filter((f) => !STT_EXEMPT[f])
  check(`6g every other speech-recognition surface is a NAMED exemption saying where its words go (${sttFiles.length})`, unnamed.length === 0, unnamed.join(","))
  check("6g′ no stale exemption (each named file still uses speech recognition)", Object.keys(STT_EXEMPT).every((f) => sttFiles.includes(f)))
  const aff = code("app/components/shared/intent-affordance.tsx")
  check("6h accessibility: a <label htmlFor> on the input, an aria-live region, aria-pressed on the mic, Escape stops listening",
    /<label htmlFor=\{inputId\}/.test(aff) && /aria-live="polite"/.test(aff) && /aria-pressed=\{listening\}/.test(aff) && /e\.key === "Escape"/.test(aff))
  check("6i TEXT FALLBACK: the input always renders; only the mic waits on speech support",
    /\{voiceOk && \(/.test(aff) && !/\{voiceOk && \([\s\S]{0,80}<Input/.test(aff) && /<Input[\s\S]{0,40}id=\{inputId\}/.test(aff))
  check("6j status is said in WORDS on the badge (never colour alone)", /STATUS_WORDS\[exec\.status\]/.test(aff) && /Needs your yes/.test(aff))
  check("6k a confirmation is a SECOND request carrying confirmed:true (the plan alone never acts)", /post\(request \|\| answer\.utterance, modality, true\)/.test(aff) && /confirmed, context/.test(aff))
  check("6l POSITIVE CONTROL: the mount finder reads a fixture", /<IntentAffordance[\s\S]{0,40}?screen="([a-z_]+)"/.test('<IntentAffordance compact screen="ads" />'))

  // ── 7 · C10 — a buyer's words recorded ────────────────────────────────────
  console.log("\n── 7 · C10 statement record ──")
  const text = "We want a big yard, under 600k in Frisco"
  const parsed = { criteria: extractCriteriaFromTranscript(text).criteria, evidence: [text], lifestyle: extractLifestyleAsks(text), dealBreakers: [] as string[] }
  const statement: CriteriaStatement = {
    literal: text, interpretation: { criteria: parsed.criteria }, confidence: "high",
    consent: { basis: "call_recording_disclosure", ref: "voice_call:abc", note: "policy", sourceRef: "voice_call:abc", capturedAt: NOW.toISOString() },
  }
  const turn1 = applyConversationTurn(emptyCriteria(), parsed, { text, channel: "voice", at: NOW.toISOString(), trigger: "stated", statement })
  const ev = turn1.changes[0]?.evidence as Record<string, unknown> | undefined
  check("7a every change row carries the LITERAL words, the INTERPRETATION, the CONFIDENCE and the CONSENT",
    turn1.changes.length > 0 && turn1.changes.every((c) => (c.evidence as any).literal === text && (c.evidence as any).confidence === "high" && (c.evidence as any).consent?.basis === "call_recording_disclosure" && !!(c.evidence as any).interpretation))
  check("7b the store's provenance entry says 'said' with the quote, confidence and consent", turn1.next.provenance?.maxPrice?.source === "said" && turn1.next.provenance?.maxPrice?.consent?.sourceRef === "voice_call:abc" && turn1.next.provenance?.maxPrice?.confidence === "high")
  const correction = "actually under 550k"
  const turn2 = applyConversationTurn(turn1.next, { criteria: extractCriteriaFromTranscript(correction).criteria, evidence: [correction], lifestyle: [], dealBreakers: [] }, { text: correction, channel: "portal", at: NOW.toISOString(), trigger: "corrected", statement: { ...statement, literal: correction, consent: defaultCriteriaConsent("portal", NOW.toISOString()) } })
  const fix = turn2.changes.find((c) => c.field === "maxPrice")
  check("7c a CORRECTION keeps history: the change row holds previous 600000 → proposed 550000, trigger corrected", !!fix && fix.previous === 600000 && fix.proposed === 550000 && fix.trigger === "corrected")
  check("7d POSITIVE CONTROL: a turn with no statement carries no literal (the finder tells them apart)",
    !("literal" in ((applyConversationTurn(emptyCriteria(), parsed, { text, channel: "portal", at: NOW.toISOString(), trigger: "stated" }).changes[0]?.evidence ?? {}) as object)) && !!ev)
  check("7e the consent basis vocabulary is one list; each channel maps to a basis that states only what is known",
    CRITERIA_CONSENT_BASES.includes("call_recording_disclosure") && defaultCriteriaConsent("sms", "t")?.basis === "inbound_message" && defaultCriteriaConsent("portal", "t", null, { type: "user", userId: "u1" })?.basis === "self_service_portal" && defaultCriteriaConsent("portal", "t") === null && defaultCriteriaConsent("agent", "t", null, { userId: "a1" })?.basis === "agent_attested")
  const turnSrc = code("lib/buyer-search/criteria-turn.ts")
  check("7f the ONE ledgered writer builds the statement and passes it into the turn (every channel gets it)",
    /const statement = criteriaStatementOf\(parsed, input\.text/.test(turnSrc) && /applyConversationTurn\(current, parsed, \{[^}]*statement \}/.test(turnSrc))
  const callSrc = code("lib/voice/call-analysis.ts")
  check("7g a PHONE CALL states its own basis (call_recording_disclosure + the voice_call ref) — never a portal default", /basis: "call_recording_disclosure"/.test(callSrc) && /sourceRef: `voice_call:\$\{call\.id\}`/.test(callSrc))

  // ── 8 · THE PROMPT STANDARD ───────────────────────────────────────────────
  console.log("\n── 8 · the one prompt ──")
  const prompt = intentSystemPrompt({ brandName: "Oak & Main Realty", role: "agent", screen: "ads", modality: "voice" })
  const SECTIONS = ["ROLE AND MANDATE", "THE PERSON", "WHAT YOU MAY RELY ON", "WHAT YOU MUST NEVER INVENT", "THE DECISION YOU OWN", "CATALOGUE", "COMPLIANCE BOUNDARY", "ESCALATION", "OUTPUT CONTRACT"]
  check("8a the prompt carries every section of the owner's standard", SECTIONS.every((s) => prompt.includes(s)), SECTIONS.filter((s) => !prompt.includes(s)).join(","))
  check("8b it names the tenant's brand, the screen, the modality and lists EVERY route", prompt.includes("Oak & Main Realty") && prompt.includes("Ads") && /SPOKEN/.test(prompt) && intentCatalogue().every((r) => prompt.includes(`- ${r.key}:`)))
  check("8c fair housing is scoped to WORDING + the platform's housing rules on AD AUDIENCES (any persona) — buyer criteria are captured as said",
    /WORDING of public marketing copy/.test(prompt) && /may be any persona/.test(prompt) && /Special Ad Category/.test(prompt) && /captured as said/.test(prompt) && !/captured only as needs/.test(prompt))
  check("8d POSITIVE CONTROL: a one-line prompt fails the rubric", !SECTIONS.every((s) => "Classify the command.".includes(s)))
  check("8e the brain/field/command prompts are gone — the ONE prompt is the only intent prompt (5a holds the tree)", !/Respond with ONLY the intent string/.test(code("app/api/internal/voice-command/route.ts")))
  check("8f matchRoutes on the ads screen breaks a tie toward the ad, never inventing one", matchRoutes("ad for this listing", "ads")[0]?.route.key === "listing_ad_draft" && matchRoutes("hello there", "ads").length === 0)
  check("8g interestStem / criteriaMentions: 'acreage' matches a buyer who said '2 acres' and NOT one whose deal-breaker it is",
    interestStem("acreage") === "acre" && criteriaMentions({ features: ["2 acres"] }, "acre") === "2 acres" && criteriaMentions({ features: ["acreage"], dealBreakers: ["acreage"] }, "acre") === null)

  console.log(`\n RESULT: ${pass} passed, ${fail} failed${fail ? ` — ${failures.join(" | ")}` : ""}`)
  // Never the chain's own signal token: `GUARD_EXIT=` belongs to the chain runner (CLAUDE.md §7 — grepped from the log as the one
  // trustworthy line). A proof printing it poisoned that grep once (2026-11-01: a push went out on this line while the chain was red).
  console.log(` INTENT_INTERFACE_EXIT=${fail ? 1 : 0}`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
