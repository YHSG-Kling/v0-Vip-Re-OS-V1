#!/usr/bin/env tsx
/**
 * scripts/memory-video-simulator.ts   (npm run test:memory-video)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MEMORY VIDEO IS A PRODUCT, NOT A LABEL — AND THE SELLER WRITES IT.
 *
 * OWNER RULING, verbatim: "memory video is for sellers that have been in their
 * home more than 20 years which is a seller dictated video going over the history
 * of the house so the family has it (this is a special service that can be
 * offered)."
 *
 * Before m565 that product existed as ONE WORD on a CHECK constraint. The only
 * code that ever wrote `memory_video` was (a) lib/video/intro-video-reactor.ts,
 * which was borrowing the name for the yearly anniversary/equity clip, and (b) the
 * manual video wizard, whose whole job is to have a MODEL write the script — the
 * one thing this product may never be. No eligibility rule, no offer, no capture,
 * no consumer.
 *
 * WHAT THIS HARNESS PROVES. Every absence assertion carries a POSITIVE CONTROL
 * that makes the finder demonstrate it can still see the defect it was written
 * for (CLAUDE.md §2), and every source scan reads STRIPPED source, because a
 * tombstone is not a call site.
 *
 *   Layer 1  THE WORD. Two products, two live CHECK values, read off the
 *            GENERATED vocabulary cache — never a list retyped here.
 *   Layer 2  ELIGIBILITY. More than 20 years, derived from the threshold constant
 *            rather than pinned to the number 20, and FAILING CLOSED on unknown
 *            tenure. 19 refuses, 21 admits, and the boundary is exercised.
 *   Layer 3  THE SELLER-DICTATED BOUNDARY, as behaviour: the assembler can only
 *            return characters that arrived in a `sellerWords` field.
 *   Layer 4  NO MODEL ON THE PATH — asserted against the real files, with the
 *            control that the finder still sees a model call when one is put in.
 *   Layer 5  OFFERED, NEVER SENT — the gated proposal rail, idempotency, and the
 *            gate re-checked at capture.
 *   Layer 6  NOT A NEW ORPHAN — every half built here has the other half.
 *   Layer 7  TENANCY — the session decides the tenant, never an argument.
 *
 * PURE — no database and no provider. The gate module is imported and executed;
 * lib/video/memory-video.ts and the server action are `server-only` modules, so
 * they are read as STRIPPED SOURCE rather than imported (importing them under tsx
 * throws by design). That is this harness's declared blind spot: it proves what
 * those two files SAY, plus everything the pure core DOES.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  MEMORY_VIDEO_MIN_TENURE_YEARS,
  MEMORY_VIDEO_PROMPTS,
  MODEL_MAY,
  MODEL_MAY_NOT,
  assembleSellerDictatedScript,
  assessMemoryVideoTenure,
  isSellerAuthored,
  qualifiesForMemoryVideo,
  type SellerDictatedSegment,
} from "../lib/video/memory-video-gate"
import { isPromotableVideoKind } from "../lib/kernel/video-coordination"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
/** Every source scan reads STRIPPED source. A tombstone is not a call site. */
const src = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))
const raw = (rel: string) => readFileSync(join(root, rel), "utf8")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const GATE    = "lib/video/memory-video-gate.ts"
const RAIL    = "lib/video/memory-video.ts"
const ACTION  = "app/actions/video/memory-video.ts"
const CARD    = "app/crm/contacts/[contactId]/components/memory-video-card.tsx"
const OVERVIEW= "app/crm/contacts/[contactId]/seller-lifetime-overview.tsx"
const VREC    = "app/api/ai/video-recommendations/route.ts"
const WIZARD  = "app/dashboard/videos/create/video-create-client.tsx"
const REACTOR = "lib/video/intro-video-reactor.ts"

const seg = (promptId: string, sellerWords: string): SellerDictatedSegment => ({
  promptId, sellerWords, capturedVia: "agent_transcription", capturedAt: "2026-08-26T12:00:00Z",
})

// ── Layer 1 · the word ───────────────────────────────────────────────────────
function layer1_theWord() {
  console.log("\n[1 · TWO PRODUCTS, TWO WORDS — read off the GENERATED live-CHECK cache]")

  const live = CHECK_VOCABULARIES.ai_video_projects?.video_type ?? []
  check(`the live video_type vocabulary was readable (${live.length} values)`, live.length > 0)
  check("'memory_video' is admitted — the seller-dictated keepsake has a word",
    live.includes("memory_video"))
  check("'home_anniversary' is admitted — m565 gave the anniversary/equity clip its own",
    live.includes("home_anniversary"))
  check("...and they are TWO DISTINCT members of the one vocabulary, which is the whole\n    point of the migration — one word cannot name two products (§6)",
    new Set(live.filter((v) => v === "memory_video" || v === "home_anniversary")).size === 2)
  check("CONTROL: the cache still refuses a value nobody minted, so 'admitted' means\n    something — 'family_history_video' is NOT in it",
    !live.includes("family_history_video"))

  // §6 — the anniversary spelling is the one the LEDGER already used.
  const triggers = CHECK_VOCABULARIES.agent_intro_videos?.trigger ?? []
  check("'home_anniversary' is the spelling agent_intro_videos.trigger already used —\n    one vocabulary for one moment, not a third coinage",
    triggers.includes("home_anniversary"), triggers.join("/"))

  // The reactor's stamp, read off the ternary rather than assumed.
  const stampM = /const\s+videoType\s*=\s*input\.trigger\s*===\s*"contact_agent_assigned"\s*\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)"/
    .exec(src(REACTOR))
  const anniversaryStamp = stampM?.[2] ?? ""
  check("the reactor's anniversary stamp is readable", !!stampM, anniversaryStamp || "ternary not found")
  check("...and it is no longer 'memory_video' — the anniversary stopped wearing this\n    product's name",
    anniversaryStamp !== "memory_video", anniversaryStamp)

  // THE MONEY, RE-PROVED FROM THIS SIDE. The rename must not hand the ad-spend
  // defect back, and the control is the mutation the task asks for: put a
  // promotable value back on the reactor and watch the assertion fail.
  check("the anniversary stamp is NOT promotable — no ads_manager signal can propose\n    paid spend on a 1:1 clip",
    !isPromotableVideoKind(anniversaryStamp))
  const mutated = /const\s+videoType\s*=\s*input\.trigger\s*===\s*"contact_agent_assigned"\s*\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)"/
    .exec(src(REACTOR).replace(`: "${anniversaryStamp}"`, ': "just_sold"'))
  check("CONTROL (mutation): re-introducing a promotable value on that ternary makes the\n    assertion above FAIL — the finder still recognises the defect it was written for",
    !!mutated && isPromotableVideoKind(mutated[2]), mutated?.[2] ?? "mutation did not apply")
  check("'memory_video' is not promotable either — a family keepsake is not an ad",
    !isPromotableVideoKind("memory_video"))
}

// ── Layer 2 · eligibility ────────────────────────────────────────────────────
function layer2_eligibility() {
  console.log("\n[2 · ELIGIBILITY — more than 20 years, and UNKNOWN REFUSES]")

  const MIN = MEMORY_VIDEO_MIN_TENURE_YEARS
  check("the threshold is the owner's 20 years", MIN === 20, String(MIN))

  // ASSERT THE RULE, DERIVE THE NUMBER (§2). Nothing below types 19, 20 or 21.
  check(`a seller ONE year short refuses (${MIN - 1} years)`,
    assessMemoryVideoTenure(MIN - 1).eligible === false)
  check(`a seller AT the threshold is admitted (${MIN} years) — the enrichment band is\n    literally "${MIN}+ years", so a strict > would refuse the population the ruling names`,
    assessMemoryVideoTenure(MIN).eligible === true)
  check(`a seller ONE year past it is admitted (${MIN + 1} years)`,
    assessMemoryVideoTenure(MIN + 1).eligible === true)
  check("a brand-new owner refuses (1 year)", assessMemoryVideoTenure(1).eligible === false)

  // FAIL CLOSED — the direction that matters. CLAUDE.md §4: "nobody checked" must
  // never render as "checked and fine".
  const unknowns: Array<number | null | undefined> = [null, undefined, 0, -5, NaN, Infinity]
  const admitted = unknowns.filter((u) => assessMemoryVideoTenure(u as number).eligible)
  check("UNKNOWN or nonsensical tenure REFUSES — null, undefined, 0, negative, NaN and\n    Infinity all fail closed rather than being read as 'probably long enough'",
    admitted.length === 0, admitted.map(String).join(","))
  check("...and the refusal SAYS the tenure was unknown, so an agent can act on it",
    /tenure unknown/.test(assessMemoryVideoTenure(null).reason))
  check("an eligible verdict carries the years it decided on, never a bare true",
    assessMemoryVideoTenure(MIN + 4).tenureYears === MIN + 4)
  check("...and a refusal for unknown tenure reports null years rather than 0",
    assessMemoryVideoTenure(null).tenureYears === null)
  check("CONTROL: the verdict really does vary — the gate is not a constant",
    assessMemoryVideoTenure(MIN).eligible !== assessMemoryVideoTenure(MIN - 1).eligible)

  // TWO QUESTIONS, TWO PREDICATES (§6). The persona says the SITUATION and can
  // never substitute for the tenure RULE — the defect would be a service offered
  // to a two-year owner because they ticked "downsizing".
  check("the persona predicate still answers its own question (downsize/senior)",
    qualifiesForMemoryVideo("downsizer") && qualifiesForMemoryVideo("senior"))
  check("...and it CANNOT stand in for eligibility: a downsizing owner of 2 years is\n    still refused by the tenure gate",
    qualifiesForMemoryVideo("downsize") && !assessMemoryVideoTenure(2).eligible)
  check("...nor the reverse: tenure alone qualifies without any persona on file",
    !qualifiesForMemoryVideo(null) && assessMemoryVideoTenure(MIN + 10).eligible)

  // THE ONE TENURE PARSER (§6) — no second one was written for this product.
  const parsers = [GATE, RAIL, VREC, OVERVIEW].filter((f) =>
    /function\s+parse\w*Residence|length_of_residence\s*\.\s*match|\.match\(\s*\/\(\\d/.test(src(f)))
  check("no second length_of_residence parser was written anywhere on this rail —\n    parseLengthOfResidence is the survivor and every caller imports it",
    parsers.length === 0, parsers.join(","))
  check("...and the callers really do import it, so the rule above is not vacuous",
    /parseLengthOfResidence/.test(src(RAIL)) && /parseLengthOfResidence/.test(src(VREC))
    && /parseLengthOfResidence/.test(src(OVERVIEW)))
  check("CONTROL: that hand-rolled-parser finder still fires on a hand-rolled parser",
    /function\s+parse\w*Residence/.test("function parseResidenceYears(t: string) { return 1 }"))
}

// ── Layer 3 · the seller-dictated boundary, as behaviour ─────────────────────
function layer3_sellerWrites() {
  console.log("\n[3 · THE SELLER WRITES IT — the assembler cannot produce a sentence]")

  const words = {
    arrival:    "We bought it in 1979 because my wife liked the porch.",
    the_people: "Three kids grew up here and the youngest was born upstairs.",
  }
  const out = assembleSellerDictatedScript([seg("the_people", words.the_people), seg("arrival", words.arrival)])
  check("a partial capture is ACCEPTED — four chapters unrecorded is a real state",
    out.ok === true, out.reason)
  check("...and the chapters come back in the canonical order the seller was asked,\n    not in the order they happened to be typed",
    out.chapters.join(",") === "arrival,the_people", out.chapters.join(","))
  check("...and the outstanding chapters are NAMED, so the agent knows what is left",
    out.missing.length === MEMORY_VIDEO_PROMPTS.length - 2 && out.missing.includes("farewell"))

  // THE LOAD-BEARING ASSERTION: every character of the script came out of a
  // sellerWords field. Not "we asked the model nicely" — arithmetic.
  const allSellerText = Object.values(words).join("")
  const scriptChars = out.script.replace(/\s/g, "")
  const sellerChars = allSellerText.replace(/\s/g, "")
  check("EVERY non-whitespace character of the script came from the seller's own words —\n    the assembler joins, it never composes",
    scriptChars.split("").every((c) => sellerChars.includes(c))
    && out.script.includes(words.arrival) && out.script.includes(words.the_people))
  check("...and it adds NO narration of its own: nothing but the seller's sentences\n    and the separators between them",
    out.script.replace(words.arrival, "").replace(words.the_people, "").trim() === "")
  check("CONTROL: a sentence the seller never said is detectably absent — this is the\n    exact defect (a model 'improving' the history) the assertion above forbids",
    !out.script.includes("The kitchen was where everyone gathered at Christmas"))

  // THE REFUSALS.
  const unknownChapter = assembleSellerDictatedScript([seg("what_the_agent_thinks", "A lovely family home.")])
  check("a chapter nobody asked the seller REFUSES the whole assembly — text that\n    cannot be attributed to a question the seller answered is not their words",
    unknownChapter.ok === false && /not a memory-video chapter/.test(unknownChapter.reason))
  const empty = assembleSellerDictatedScript([seg("arrival", "   ")])
  check("a capture with nothing in it REFUSES rather than returning an empty script\n    for somebody else to fill",
    empty.ok === false && empty.script === "")
  check("CONTROL: the refusal finder is not simply refusing everything — a real capture\n    still passes",
    assembleSellerDictatedScript([seg("arrival", words.arrival)]).ok === true)

  // A RE-RECORD IS A CORRECTION, AND IT IS STILL THE SELLER'S.
  const corrected = assembleSellerDictatedScript([seg("arrival", "1979."), seg("arrival", "1978, actually.")])
  check("re-recording a chapter replaces it — a seller correcting themselves is still\n    the seller",
    corrected.script === "1978, actually.")

  // THE STAMP A LATER CONSUMER CAN VERIFY.
  check("isSellerAuthored accepts a row stamped by the capture rail",
    isSellerAuthored({ authored_by: "seller", dictation: [seg("arrival", "x")] }))
  check("...and REFUSES a row that merely claims it, with no captured segments",
    !isSellerAuthored({ authored_by: "seller", dictation: [] }))
  check("...and refuses anything model-authored, empty or malformed — fail closed,\n    the same direction as the tenure gate",
    !isSellerAuthored({ authored_by: "ai", dictation: [seg("arrival", "x")] })
    && !isSellerAuthored(null) && !isSellerAuthored({}) && !isSellerAuthored("seller"))

  // THE BOUNDARY IS WRITTEN DOWN WHERE A HUMAN READS IT.
  check("the code STATES what a model may do with this product, and what it may not",
    MODEL_MAY.length > 0 && MODEL_MAY_NOT.length > 0)
  check("...and 'invent' is on the forbidden side, not the permitted one",
    MODEL_MAY_NOT.some((r) => /invent/i.test(r)) && !MODEL_MAY.some((r) => /invent/i.test(r)))
  check("...while VERBATIM captioning is permitted — the defensible half is named too,\n    so the rule reads as a boundary rather than a ban",
    MODEL_MAY.some((r) => /verbatim/i.test(r)))
}

// ── Layer 4 · no model on the path ───────────────────────────────────────────
function layer4_noModel() {
  console.log("\n[4 · NO MODEL IS CALLED ON THIS PATH (CLAUDE.md §5, the appraiser rule)]")

  const MODEL_CALL = /generateTextRouted|generateText\(|generateObject|@\/lib\/ai\/models|openai|anthropic/i
  for (const f of [GATE, RAIL, ACTION, CARD]) {
    check(`${f} calls no model`, !MODEL_CALL.test(src(f)))
  }
  check("CONTROL: the model-call finder still fires on a file that DOES call one —\n    the intro/anniversary reactor drafts its script through the AI gateway",
    MODEL_CALL.test(src(REACTOR)))

  // THE WIZARD NO LONGER OFFERS IT. Its whole job is to have a model write the
  // script — it hands the chosen video type straight to generateVideoScript — so
  // offering memory_video there is how a generated family history would happen by
  // accident.
  check("the wizard really is the model-authored path: the chosen video type is handed\n    to a script GENERATOR, which is why this product may not be one of its options",
    /generateVideoScript/.test(src(WIZARD)) && /videoType:\s*aiScriptVideoType/.test(src(WIZARD)))
  const wizardTypes = /const\s+VIDEO_TYPES\s*=\s*\[([\s\S]*?)\n\]/.exec(src(WIZARD))?.[1] ?? ""
  const offered = Array.from(wizardTypes.matchAll(/value:\s*"([a-z_]+)"/g)).map((m) => m[1])
  check("the AI-script wizard was readable and still offers other types",
    offered.length > 0, `${offered.length} options`)
  check("...and 'memory_video' is NOT one of them any more",
    !offered.includes("memory_video"))
  check("...nor is 'home_anniversary' — that value is stamped by the reactor and the\n    Director, never chosen by hand",
    !offered.includes("home_anniversary"))
  check("CONTROL: that option finder works — 'just_listed' IS still offered",
    offered.includes("just_listed"))
  check("the removal left a TOMBSTONE naming where the capability went (§1)",
    raw(WIZARD).includes("TOMBSTONE") && raw(WIZARD).includes("lib/video/memory-video-gate.ts"))
  check("CONTROL: reading RAW source would have counted that tombstone as a live option —\n    which is why every scan here reads STRIPPED source",
    raw(WIZARD).includes("memory_video") && !offered.includes("memory_video"))

  // THE ROW SAYS SO TOO, so a consumer never has to trust a comment.
  const rail = src(RAIL)
  check("the capture stamps is_ai_generated: false — the column defaults to TRUE, so\n    saying nothing would have claimed the opposite",
    /is_ai_generated:\s*false/.test(rail))
  check("...and stamps authored_by 'seller' with the captured segments beside it",
    /authored_by:\s*"seller"/.test(rail) && /dictation:\s*input\.segments/.test(rail))
  check("...and the script it stores is the PURE assembler's output, not a string it\n    built itself",
    /assembleSellerDictatedScript\(input\.segments\)/.test(rail)
    && /script_content:\s*assembled\.script/.test(rail))
  check("CONTROL: the is_ai_generated finder would miss a row that omitted the column",
    !/is_ai_generated:\s*false/.test('await svc.from("ai_video_projects").insert({ video_type: "memory_video" })'))
}

// ── Layer 5 · offered, never sent ────────────────────────────────────────────
function layer5_offeredNotSent() {
  console.log("\n[5 · A SPECIAL SERVICE THAT CAN BE OFFERED — gated, idempotent, never auto-sent]")

  const rail = src(RAIL)
  check("the offer files a GATED PROPOSAL on the existing rail, which is what gives it\n    a human approver and a real reader",
    /proposeClientMessage\(/.test(rail))
  check("...as an agent-audience proposal against the recipient contact, the same shape\n    lib/kernel/anniversary-equity.ts files",
    /audience:\s*"agent"/.test(rail) && /recipientContactId:\s*input\.contactId/.test(rail))
  check("nothing on this rail SENDS: no mailer, no SMS, no video dispatch",
    !/dispatchEmail|dispatchSms|sendEmail\(|dispatchVideo|approveClientMessage/.test(rail))
  check("CONTROL: that send-finder still fires on a line that would send",
    /dispatchEmail/.test('await dispatchEmail({ to: contact.email })'))
  check("no cron route drives this — the ruling says OFFERED, and a sweep that proposed\n    to every 20-year contact would not be an offer",
    !/cron/i.test(rail))

  check("the offer is IDEMPOTENT per contact on a rationale tag, so a second visit does\n    not pile a second offer onto the same family",
    /MEMORY_VIDEO_OFFER_TAG/.test(rail) && /already_offered/.test(rail))
  check("a contact with video_opt_out is SUPPRESSED before any eligibility talk",
    /video_opt_out/.test(rail) && /"suppressed"/.test(rail))

  // THE GATE RUNS AGAIN AT CAPTURE. An approval queue is not an eligibility test.
  const captureBody = /export async function recordMemoryVideoDictation[\s\S]*$/.exec(rail)?.[0] ?? ""
  check("the capture path re-runs the tenure gate — an offer can sit in a queue for\n    weeks, and time in a queue does not establish eligibility",
    /assessMemoryVideoTenure\(/.test(captureBody))
  check("CONTROL: the capture body was actually isolated (the finder is not reading the\n    offer function's own call)",
    captureBody.length > 0 && !captureBody.includes("proposeClientMessage"))

  // AN UPDATE THAT MATCHES NOTHING RESOLVES (CLAUDE.md §3).
  check("the capture UPDATE .select()s and COUNTS the rows it matched — an update that\n    matched nothing resolves identically to one that worked",
    /\.update\(shared\)[\s\S]{0,200}\.select\("id"\)/.test(rail)
    && /updated\.length === 0/.test(rail))
  check("...and every read destructures the error rather than swallowing a refusal",
    (rail.match(/error:\s*\w+Err/g) ?? []).length >= 4)
}

// ── Layer 6 · not a new orphan ───────────────────────────────────────────────
function layer6_noOrphan() {
  console.log("\n[6 · EVERY HALF BUILT HERE HAS ITS OTHER HALF (§1)]")

  const overview = src(OVERVIEW)
  const card     = src(CARD)
  const action   = src(ACTION)

  check("the server action has a CALLER — the offer card imports both of its exports",
    /offerMemoryVideoAction/.test(card) && /saveMemoryVideoDictationAction/.test(card))
  check("...and both are declared in the action file",
    /export async function offerMemoryVideoAction/.test(action)
    && /export async function saveMemoryVideoDictationAction/.test(action))
  check("every export of the action file is async — in a \"use server\" file every export\n    is a public HTTP endpoint (§4)",
    (action.match(/^export\s+(?!async\s)/gm) ?? []).length === 0)

  check("the card has an IMPORTER — the seller-side contact detail view renders it",
    /MemoryVideoCard/.test(overview) && /<MemoryVideoCard/.test(overview))
  check("the eligibility gate has CONSUMERS on both surfaces",
    /assessMemoryVideoTenure/.test(overview) && /assessMemoryVideoTenure/.test(src(VREC)))
  check("the offer rail has a caller — the action forwards to it",
    /offerMemoryVideo\(/.test(action) && /recordMemoryVideoDictation\(/.test(action))

  check("the card is rendered ONLY on an eligible verdict — no disabled teaser for a\n    service this family cannot be offered",
    /memoryVideoVerdict\.eligible[\s\S]{0,200}<MemoryVideoCard/.test(overview))
  check("CONTROL: that conditional finder would not pass on an unconditional render",
    !/memoryVideoVerdict\.eligible[\s\S]{0,200}<MemoryVideoCard/.test("<MemoryVideoCard contactId={contactId} />"))

  check("the recommendation feed no longer offers on a persona alone — the tenure\n    verdict gates the push",
    /assessMemoryVideoTenure\([\s\S]{0,120}\)\s*\n\s*if \(!tenure\.eligible\) continue/.test(src(VREC)))
  check("...and it still runs the persona predicate, which another lane's proof\n    mutation-tests at that exact call site",
    /qualifiesForMemoryVideo\(seller\.contact_persona\)/.test(src(VREC)))

  check("the finished keepsake has a delivery: 'memory_video' is a per-contact draft\n    type in the orchestrator, which is how it reaches the family",
    /personalVideoTypes\s*=\s*\[[^\]]*"memory_video"/.test(src("lib/orchestrator/internal.ts")))
  check("the capture sheet has no 'write this for me' control anywhere on it",
    !/generate|write it for me|suggest/i.test(card.replace(/MEMORY_VIDEO_PROMPTS/g, "")))
}

// ── Layer 7 · tenancy ────────────────────────────────────────────────────────
function layer7_tenancy() {
  console.log("\n[7 · THE TENANT COMES FROM THE SESSION (§4)]")

  const action = src(ACTION)
  const rail   = src(RAIL)
  const card   = src(CARD)

  check("no exported action takes a brokerageId argument — a body-supplied tenant on a\n    service client is the IDOR shape this repo keeps finding",
    !/export async function \w+\([^)]*brokerageId/.test(action))
  check("the tenant is resolved from the authenticated session instead",
    /auth\.getUser\(\)/.test(action) && /\.from\("users"\)[\s\S]{0,120}brokerage_id/.test(action))
  check("a session that cannot be read, or a user with no brokerage, REFUSES",
    /return \{ ok: false, error: "Unauthorized" \}/.test(action)
    && /No brokerage on this account/.test(action))
  check("...and every action returns that refusal rather than proceeding",
    (action.match(/if \(!caller\.ok\) return/g) ?? []).length === 2)
  check("the browser never sends a brokerage id — the card calls the actions with the\n    contact id alone",
    !/brokerageId/.test(card))

  check("every contact read on the rail is filtered on the gated brokerage, so another\n    tenant's contact id matches nothing rather than leaking a row",
    (rail.match(/\.eq\("brokerage_id", input\.brokerageId\)/g) ?? []).length >= 3)
  check("agents.id is resolved through the agents table, never assumed to be users.id\n    (the two id spaces are DISJOINT — 23503)",
    /resolveAgentIdInBrokerage\(/.test(action) && /agentRecordId/.test(action))
  check("CONTROL: the brokerage-filter finder would not pass on an unfiltered read",
    !/\.eq\("brokerage_id", input\.brokerageId\)/.test('svc.from("contacts").select("*").eq("id", contactId)'))
}

function main() {
  console.log("══════════════════════════════════════════════════════════")
  console.log(" Memory video — a seller-dictated product, offered not sent")
  console.log("══════════════════════════════════════════════════════════")
  layer1_theWord()
  layer2_eligibility()
  layer3_sellerWrites()
  layer4_noModel()
  layer5_offeredNotSent()
  layer6_noOrphan()
  layer7_tenancy()
  console.log("\n──────────────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    console.log(" ❌ MEMORY_VIDEO_FAIL")
    process.exit(1)
  }
  console.log(" ✅ The memory video is its own product with its own word, it is offered")
  console.log("    to sellers of 20+ years and refused when tenure is unknown, and every")
  console.log("    sentence in it is one the seller said.")
}
main()
