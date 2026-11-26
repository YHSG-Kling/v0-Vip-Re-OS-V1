#!/usr/bin/env tsx
/**
 * scripts/contact-persona-service-guard.ts   (npm run test:contact-persona-service)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 154, LANE 154I — CUSTOMER / PERSONA INTELLIGENCE AND PROACTIVE "THEM-FIRST" SERVICE (directive I1–I5).
 * EVERY PROOF HERE IS SIMULATED: scripts/in-memory-supabase.ts stands in for the database, every model / provider / bus is an
 * injected seam that COUNTS its calls, and no network is touched.
 *
 *   §1 I1  THE STAGES ARE NOT INTERCHANGEABLE — no topic / trend / permit / chatter producer writes a person-stage table or a
 *          persona field (stripped source, positive control), and a run of the website-question feeder writes only the pool.
 *   §2 I2  A CURRENT CONTACT'S STATED CHANGE REACHES A DECISION — the one criteria writer tells the buyer's agent for a call /
 *          message turn (NEWLY WIRED), once, in the right tenant; the other first-party writers' decision doors are present.
 *   §3 I3  VOICE BEFORE GENERATION; WHAT THEY SAID ≠ WHAT THE MODEL SUSPECTS — two tenant voice profiles on one topic, and no
 *          model-guessed calendar date is stored on a Contact (FIXED).
 *   §4 I4  THE FIVE SERVICE EXAMPLES, executed on the existing functions.
 *   §5 I5  CANARIES — scoped task, portal / widget change, anonymous topic ≠ persona, two-tenant boundary, independent timing.
 *   §6     THE CARRIED FIX — property_search_log carries the session tenant; the first-party search reader is tenant-bound.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments, blankStrings } from "./strip-comments"

const ROOT = process.cwd()
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
const code = (p: string) => stripComments(raw(p))
let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
function walk(dir: string, out: string[] = []): string[] {
  let names: string[] = []
  try { names = readdirSync(join(ROOT, dir)) } catch { return out }
  for (const n of names) {
    if (n === "node_modules" || n.startsWith(".")) continue
    const p = join(dir, n)
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p)
  }
  return out
}

const B1 = "11111111-1111-4111-8111-111111111111"
const B2 = "22222222-2222-4222-8222-222222222222"
const C1 = "33333333-3333-4333-8333-333333333333"   // the buyer in tenant B1
const C1B = "33333333-3333-4333-8333-3333333333bb"  // the SAME person (same email) as a contact of tenant B2
const AGENT = "66666666-6666-4666-8666-666666666666"
const AGENT_USER = "55555555-5555-4555-8555-555555555555"
const U2 = "77777777-7777-4777-8777-777777777777", A2 = "88888888-8888-4888-8888-888888888888"
const NOW = new Date("2026-11-18T15:00:00Z")
const DAY = (n: number) => new Date(NOW.getTime() + n * 86_400_000)
type Row = Record<string, any>

const PERSON_TABLES = ["contacts", "leads", "raw_scraped_leads", "client_detailed_personas", "contact_lead_history"]
const PERSON_WRITE = new RegExp(`\\.from\\(\\s*["'\`](${PERSON_TABLES.join("|")})["'\`]\\s*\\)\\s*\\.\\s*(insert|update|upsert)\\s*\\(`)
const PERSONA_KEY = /\b(contact_persona|persona_journey|detailed_persona)\s*:/

async function main() {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§1 I1 — a topic, trend, permit or chatter never becomes a Contact or a persona field (stripped source)")
  const topicOnly = [...walk("lib/content-intel"), ...walk("lib/competitive-intel"), ...walk("lib/customer-intelligence")]
  const attachOnly = ["lib/lead-pipeline/permit-sourcer.ts", "lib/external/permit-signals.ts"]
  const topicHits = topicOnly.filter((f) => PERSON_WRITE.test(code(f)) || PERSONA_KEY.test(blankStrings(code(f))))
  check(`no topic / trend / chatter producer writes a person-stage table or a persona key (denominator ${topicOnly.length} files: content-intel, competitive-intel, customer-intelligence)`, topicOnly.length > 20 && topicHits.length === 0, topicHits.join(", "))
  const permitHits = attachOnly.filter((f) => /\.from\(\s*["'`](contacts|client_detailed_personas)["'`]\s*\)\s*\.\s*(insert|update|upsert)\s*\(/.test(code(f)) || PERSONA_KEY.test(blankStrings(code(f))))
  check("the permit paths ATTACH evidence to people the tenant already holds — they never write a contact or a persona field", attachOnly.every((f) => raw(f).length > 0) && permitHits.length === 0, permitHits.join(", "))
  check("POSITIVE CONTROL: a planted contact / persona writer is seen; the same text in a comment (a tombstone) is not",
    PERSON_WRITE.test(stripComments(`await db.from("contacts").update({ x: 1 })`)) && PERSON_WRITE.test(stripComments(`svc.from('leads').insert(row)`)) &&
    PERSONA_KEY.test(blankStrings(stripComments(`const patch = { contact_persona: "military" }`))) &&
    !PERSON_WRITE.test(stripComments(`// await db.from("contacts").update({ contact_persona: "x" })`)) && !PERSONA_KEY.test(blankStrings(stripComments(`/* contact_persona: x */`))))
  const chatter = code("lib/content-intel/public-chatter-topics.ts")
  check("public chatter is stored as a REWORDED topic through the one intake (never a person row)", /intakeTopicIdeas/.test(chatter) && !PERSON_WRITE.test(chatter))

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§2 I2 — an existing Contact's stated change reaches a decision (NEWLY WIRED for call / message turns)")
  const { recordStatedCriteriaTurn } = await import("../lib/buyer-search/criteria-turn")
  const { criteriaChips, loadBuyerCriteria } = await (async () => ({ ...(await import("../lib/buyer-search/conversational-search")), ...(await import("../lib/buyer-search/buyer-criteria")) }))()
  const mkCriteriaDb = () => memSupabase({
    contacts: [{ id: C1, brokerage_id: B1, contact_type: "buyer", email: "pat@example.com" }, { id: C1B, brokerage_id: B2, contact_type: "buyer", email: "pat@example.com" }],
    property_preferences: [{ id: "pp-b2", contact_id: C1B, brokerage_id: B2, inferred_cities: ["Boise"], preferred_price_max: 350000, inferred_max_price: 350000, criteria_provenance: { maxPrice: { source: "said", value: 350000 } }, lifestyle_preferences: [], listing_type: "sale" }],
    buyer_criteria_changes: [], buyer_criteria_utterances: [], agent_action_ledger: [], property_alerts: [],
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
  const published: Array<{ a: Row; client: unknown }> = []
  const publish = async (a: Row, client: unknown) => { published.push({ a, client }); return { ok: true } }
  const cdb = mkCriteriaDb()
  const said = "Actually we want 3 bedrooms under 550k in Pace now"
  const t1 = await recordStatedCriteriaTurn(cdb as never, { brokerageId: B1, contactId: C1, text: said, channel: "sms", actor: { type: "system" }, idempotencyKey: "msg:sms-1", allowModelAssist: false, ledgerClient: cdb, notifyAgent: { source: "buyer_written_message" } }, { publish: publish as never })
  check("SIMULATED: a buyer's TEXTED change is saved through the one writer and the buyer's agent is told (one bus call)", !t1.error && t1.changes.length > 0 && t1.agentNotified === true && published.length === 1, JSON.stringify({ err: t1.error, changes: t1.changes.map((c) => c.field), n: t1.agentNotified, published: published.length }))
  const sig = published[0]?.a ?? {}
  check("the notice is SCOPED: the session-verified tenant, this contact, ai_isa → shopping_agent, the fields that moved, the words' record", sig.brokerageId === B1 && sig.contactId === C1 && sig.entityId === C1 && sig.toManager === "shopping_agent" && sig.signalType === "qualification_criteria_captured" && Array.isArray(sig.payload?.fields) && sig.payload.fields.includes("maxPrice") && sig.payload?.source === "buyer_written_message", JSON.stringify(sig))
  const t1r = await recordStatedCriteriaTurn(cdb as never, { brokerageId: B1, contactId: C1, text: said, channel: "sms", actor: { type: "system" }, idempotencyKey: "msg:sms-1", allowModelAssist: false, ledgerClient: cdb, notifyAgent: { source: "buyer_written_message" } }, { publish: publish as never })
  check("a RE-DELIVERED message replays: nothing is applied twice and the agent is NOT told twice", published.length === 1 && t1r.agentNotified !== true, JSON.stringify({ n: t1r.agentNotified, published: published.length }))
  const t2 = await recordStatedCriteriaTurn(cdb as never, { brokerageId: B1, contactId: C1, text: "we would love a quiet street with a big backyard", channel: "voice", actor: { type: "system" }, idempotencyKey: "call:c2", allowModelAssist: false, ledgerClient: cdb, notifyAgent: { source: "buyer_voice_call" } }, { publish: publish as never })
  check("a non-material statement (lifestyle only) is remembered but does not ping the agent (no flood) — the deliberate wait", published.length === 1 && t2.agentNotified !== true, JSON.stringify({ n: t2.agentNotified, fields: t2.changes.map((c) => c.field) }))
  const portalDb = mkCriteriaDb()
  const before = published.length
  const tp = await recordStatedCriteriaTurn(portalDb as never, { brokerageId: B1, contactId: C1, text: said, channel: "portal", actor: { type: "user", userId: null }, idempotencyKey: "portal-1", allowModelAssist: false, ledgerClient: portalDb }, { publish: publish as never })
  check("the PORTAL door keeps its own notice (tellShoppingAgent) — the writer adds none when not asked, so no double ping", !tp.error && published.length === before && tp.agentNotified == null)
  const rdb = mkCriteriaDb()
  const refusedPub = await recordStatedCriteriaTurn(rdb as never, { brokerageId: B1, contactId: C1, text: said, channel: "email", actor: { type: "system" }, idempotencyKey: "msg:e-9", allowModelAssist: false, ledgerClient: rdb, notifyAgent: { source: "buyer_written_message" } }, { publish: (async () => ({ ok: false, reason: "bus unreachable" })) as never })
  check("a refused bus is SAID (agentNotified false + a note), never reported as told", refusedPub.agentNotified === false && refusedPub.notes.some((n) => /could not be told/.test(n)), JSON.stringify({ n: refusedPub.agentNotified, notes: refusedPub.notes }))
  const callSrc = code("lib/voice/call-analysis.ts"), mailSrc = code("lib/buyer-search/written-criteria-alert.ts")
  const NOTIFY = /recordStatedCriteriaTurn\([\s\S]{0,900}?notifyAgent:\s*\{\s*source:\s*["']buyer_(voice_call|written_message)["']/
  check("the call door and the email / SMS door pass notifyAgent to the one writer (stripped source)", NOTIFY.test(callSrc) && NOTIFY.test(mailSrc))
  check("POSITIVE CONTROL: the base call door (no notifyAgent) is NOT recognised as wired", !NOTIFY.test(stripComments(`const turn = await recordStatedCriteriaTurn(svc, { brokerageId, contactId, text, channel: "voice", sourceRef: "x" })`)))
  // The other first-party writers → their decision doors (EXISTING VERIFIED, stripped source).
  const doors: Array<[string, string, RegExp]> = [
    ["portal criteria turn → shouldNotifyAgent → the shopping agent", "app/actions/buyer-search/conversational-search.ts", /shouldNotifyAgent\([\s\S]{0,400}tellShoppingAgent\(/],
    ["valuation request by a known contact → the movement door", "lib/kernel/lead-magnets.ts", /reassessExistingContact\(/],
    ["home-value request → the movement door", "app/actions/home-value.ts", /reassessExistingContact\(/],
    ["stated report date (PCS planner) → the movement door", "lib/relocation/pcs-portal-door.ts", /kind:\s*["']stated_date["']/],
    ["saved-home change → the arbiter door (decideSavedHomeNudge)", "lib/property-alerts/saved-home-watch.ts", /decideSavedHomeNudge\(/],
    ["repeated saves / criteria changes → second-window radar", "lib/acquisition-plays/contact-second-window.ts", /["']criteria_change["']/],
    ["portal home question → value / refinance / vendor follow-up", "app/actions/portal-lifetime.ts", /requestVendorIntro\([\s\S]{0,200}\)[\s\S]*submitNextMoveIntent\(|submitNextMoveIntent\([\s\S]*requestVendorIntro\(/],
  ]
  for (const [label, file, re] of doors) check(`EXISTING VERIFIED: ${label} (${file})`, re.test(code(file)))

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§3 I3 — voice before generation; what the customer SAID vs what the model suspects")
  const { loadSenderVoiceBrief, renderSenderVoiceBrief } = await import("../lib/kernel/brand-voice")
  const { themFirstDraftBrief, renderThemFirstDraftBrief } = await import("../lib/marketing/them-first-draft-brief")
  const voiceDb = memSupabase({
    brokerages: [{ id: B1, name: "Harbor & Pine Homes", city: "Pace", state: "FL" }, { id: B2, name: "Summit Ridge Realty", city: "Boise", state: "ID" }],
    brand_voice_profile: [
      { id: "bv1", brokerage_id: B1, agent_id: null, team_id: null, tone: "warm", formality_level: "conversational", preferred_words: ["neighbors", "the long game"], prohibited_words: ["guaranteed"], key_brand_messages: ["every move is a long-term relationship"], tagline: "Neighbors first, numbers always", mission_statement: null, tone_examples: ["If you are weighing a move before school starts, here is how long it usually takes."], writing_style_notes: "short sentences" },
      { id: "bv2", brokerage_id: B2, agent_id: null, team_id: null, tone: "precise", formality_level: "formal", preferred_words: ["due diligence", "mountain-west"], prohibited_words: ["dream home"], key_brand_messages: ["data before drama"], tagline: "Clear numbers. Calm closings.", mission_statement: null, tone_examples: ["Here are the three items to verify before the option period ends."], writing_style_notes: "numbered steps" },
    ],
    users: [{ id: AGENT_USER, first_name: "Jane", last_name: "Rivera", email_signature: "Jane Rivera · Harbor & Pine Homes", team_id: null }, { id: U2, first_name: "Omar", last_name: "Hale", email_signature: "Omar Hale · Summit Ridge Realty", team_id: null }],
    agents: [{ id: AGENT, user_id: AGENT_USER, brokerage_id: B1, team_id: null, bio: "Fifteen years in Pace.", specializations: ["new construction"], languages: ["English"], license_number: "SL1", license_state: "FL" }, { id: A2, user_id: U2, brokerage_id: B2, team_id: null, bio: "Boise relocation specialist.", specializations: ["relocation"], languages: ["English"], license_number: "ID2", license_state: "ID" }],
    teams: [], brokerage_brand_settings: [], ai_identity_profiles: [], distribution_finals: [], notifications: [],
    farm_territories: [{ brokerage_id: B1, agent_id: AGENT, name: "Alder Creek", city: "Pace", state: "FL", zip_codes: ["32571"], is_active: true }, { brokerage_id: B2, agent_id: A2, name: "North End", city: "Boise", state: "ID", zip_codes: ["83702"], is_active: true }],
  }, { uuidIds: true })
  const fresh = { cache: false, now: NOW }
  const vA = await loadSenderVoiceBrief(voiceDb as never, { brokerageId: B1, agentUserId: AGENT_USER }, fresh)
  const vB = await loadSenderVoiceBrief(voiceDb as never, { brokerageId: B2, agentUserId: U2 }, fresh)
  const topic = "What does a new-construction builder warranty cover, for how long, and what should I check before closing?"
  const reader = themFirstDraftBrief({ personas: "military", side: "buyer", source: "contacts.contact_persona" })
  // The FIRST-DRAFT instruction each tenant's writer receives: sender voice FIRST, then the reader's them-first brief, then the
  // same grounded topic. (The model is a seam: the plan / first draft is conditioned by THIS text — no model is called here.)
  const planA = `${renderSenderVoiceBrief(vA)}\n\n${renderThemFirstDraftBrief(reader)}\n\nTOPIC: ${topic}`
  const planB = `${renderSenderVoiceBrief(vB)}\n\n${renderThemFirstDraftBrief(reader)}\n\nTOPIC: ${topic}`
  check("SIMULATED: two tenant voice profiles on the SAME grounded topic produce different first-draft plans, each in its own tone, words and tagline",
    planA !== planB && /Tone: warm/.test(planA) && /neighbors/.test(planA) && /Neighbors first, numbers always/.test(planA) && /Tone: precise/.test(planB) && /due diligence/.test(planB) && /Clear numbers\. Calm closings\./.test(planB))
  check("each plan carries ONLY its own brand — never the other tenant's name, tagline, words or local area",
    !/Summit Ridge|Clear numbers|due diligence|Boise/.test(planA) && !/Harbor & Pine|Neighbors first|neighbors|Pace/.test(planB), `${/Boise/.test(planA)} ${/Pace/.test(planB)}`)
  check("local expertise and writing examples come from each tenant's OWN settings (their farm areas, their sentences)", /Alder Creek|Pace/.test(planA) && /North End|Boise/.test(planB) && /weighing a move before school/.test(planA) && /option period/.test(planB))
  check("no local PROPERTY FACT is invented in either plan (no dollar figure, no price, no street address beyond the stated settings)", !/\$\s?\d|\b\d{3},\d{3}\b|\d+\s+\w+\s+(St|Ave|Rd|Dr)\b/.test(planA + planB))
  check("the reader's concern comes first in the arc (them-first), and persona concerns are exemplars, never claims about this reader",
    reader.basis === "persona" && /THEM FIRST: open on the reader's situation/.test(planA) && /never claims about this reader/.test(planA))
  check("an unknown / mixed persona is GENERIC-SAFE — never a guessed situation", themFirstDraftBrief({ personas: ["military", "luxury"] }).basis === "generic_safe" && themFirstDraftBrief({ personas: null }).basis === "generic_safe")
  const vCross = await loadSenderVoiceBrief(voiceDb as never, { brokerageId: B2, agentUserId: AGENT_USER }, fresh)
  check("the voice read is TENANT-PINNED: tenant B2 asking for B1's agent gets none of B1's agent settings (bio, specialties, farm area, voice)", !/Fifteen years in Pace|new construction|Alder Creek|Neighbors first|neighbors/.test(renderSenderVoiceBrief(vCross)))
  // FIXED — a model-guessed calendar date no longer lands on the Contact.
  const nurture = blankStrings(code("app/actions/ai-lead-nurturing.ts"))
  const DATE_WRITE = /ai_predicted_close_date\s*:/
  check("FIXED: aiPredictConversion writes no model-guessed close DATE onto the Contact (stripped + strings blanked)", !DATE_WRITE.test(nurture) && /projectedTimeline/.test(nurture))
  check("POSITIVE CONTROL: the base write `...(predictedCloseDate ? { ai_predicted_close_date: predictedCloseDate } : {})` IS caught", DATE_WRITE.test(blankStrings(stripComments(`.update({ ai_conversion_probability: p, ...(predictedCloseDate ? { ai_predicted_close_date: predictedCloseDate } : {}) })`))))
  const nurtureRaw = code("app/actions/ai-lead-nurturing.ts")
  check("the model answers in the ONE timeline vocabulary (STANDARD_TIMELINES buckets) or 'unknown' — never a free-text date", /projectedTimeline:\s*z\.enum\(PROJECTED_TIMELINES\)/.test(nurtureRaw) && /\[\.\.\.STANDARD_TIMELINES,\s*"unknown"\]/.test(nurtureRaw) && !/predictedCloseDate:\s*z\./.test(nurtureRaw))
  const panel = code("app/crm/components/os/conversion-forecast-panel.tsx")
  check("the Customer 360 panel labels it a MODEL ESTIMATE, not stated by the client — the old 'Projected close <date>' is gone", /Model estimate:/.test(panel) && /not stated by the client/.test(panel) && !/Projected close/.test(panel))
  const anyDateWriter = [...walk("app"), ...walk("lib")].filter((f) => DATE_WRITE.test(blankStrings(code(f))))
  check("no writer of ai_predicted_close_date remains anywhere in app/ or lib/ (stripped)", anyDateWriter.length === 0, anyDateWriter.join(", "))

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§4 I4 — the five service examples on existing functions (SIMULATED)")
  // (1) Three large-lot saved homes, one verified price change → authorized saved-home alert + agent task; no phantom seller lead.
  const watch = await import("../lib/property-alerts/saved-home-watch")
  const { tenantScope } = await import("../lib/kernel/tenant-scope")
  const says = (optionId: string) => async () => ({ optionId, channel: null, format: null, waitHours: null, rationale: `The evidence supports ${optionId} for this buyer right now.`, evidence: ["moment"], confidence: 0.9 })
  const homesDb = () => {
    const sp = (id: string, l: string, addr: string, price: number) => ({ id, brokerage_id: B1, contact_id: C1, listing_id: l, source: "brokerage_listing", property_address: addr, city: "Pace", list_price: price, dismissed: false, last_verified_at: DAY(-1).toISOString(), last_verified_status: "active", last_verified_price: price, last_verified_mls_number: `M-${l}`, last_verified_source: "tenant_listing", verification_hold: null })
    return memSupabase({
      brokerages: [{ id: B1, name: "Harbor & Pine Homes", state: "FL" }], brokerage_settings: [],
      contacts: [{ id: C1, brokerage_id: B1, first_name: "Pat", email: "pat@example.com", agent_id: AGENT, last_contacted_at: DAY(-6).toISOString() }],
      agents: [{ id: AGENT, brokerage_id: B1, user_id: AGENT_USER }],
      listings: [
        { id: "L1", brokerage_id: B1, status: "active", lifecycle_stage: null, list_price: 610000, mls_number: "M-L1", deleted_at: null },
        { id: "L2", brokerage_id: B1, status: "active", lifecycle_stage: null, list_price: 560000, mls_number: "M-L2", deleted_at: null },
        { id: "L3", brokerage_id: B1, status: "active", lifecycle_stage: null, list_price: 700000, mls_number: "M-L3", deleted_at: null },
      ],
      saved_properties: [sp("sp1", "L1", "100 Acre Ln (1.4 ac)", 610000), sp("sp2", "L2", "22 Meadow Rd (2.1 ac)", 600000), sp("sp3", "L3", "9 Ridge Way (1.1 ac)", 700000)],
      acquisition_plans: [], vendor_usage_tracking: [], agent_action_ledger: [], lifecycle_events: [], manager_signals: [], notifications: [], activities: [], tasks: [],
      leads: [], raw_scraped_leads: [],
    }, { stampCreatedAt: true, uuidIds: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
  }
  const hAgent = homesDb()
  const sAgent = await watch.watchSavedHomes(hAgent, tenantScope(B1, "proof"), { now: NOW, unitUsd: 0.074, decide: says("agent") as never })
  check("SIMULATED (1): of three saved homes ONE verified price drop is the only change, and the arbiter's AGENT route opens the agent's task", sAgent.changesTotal === 1 && sAgent.delivered === 1 && (hAgent.tables.activities ?? []).some((a) => a.agent_id === AGENT && a.contact_id === C1), JSON.stringify(sAgent))
  const hNote = homesDb()
  await watch.watchSavedHomes(hNote, tenantScope(B1, "proof"), { now: NOW, unitUsd: 0.074, decide: says("written_note") as never })
  const note = (hNote.tables.notifications ?? []).find((n) => n.type === watch.SAVED_HOME_ALERT_NOTIFICATION_TYPE)
  check("SIMULATED (1): the NOTE route is an authorized saved-home alert to the buyer's own portal (contact-scoped, this tenant)", !!note && note.contact_id === C1 && note.brokerage_id === B1 && note.entity_type === "saved_property")
  check("(1) never a phantom seller lead: no lead, raw lead or contact row is written by the sweep", [hAgent, hNote].every((d) => d.writes.every((w) => !["leads", "raw_scraped_leads", "contacts"].includes(w.table) || w.op !== "insert")) && (hNote.tables.leads ?? []).length === 0)

  // (2) Three consented website questions on builder warranties → ONE anonymized local FAQ topic, never three identities.
  // Wave 155 (lane 155F, F2): the feeder is considerCustomerQuestion (website chat + portal assistant askers, one count); a row
  // carries its ASKER key (`s:` session for an anonymous visitor, `c:` contact for a signed-in portal asker).
  const { considerCustomerQuestion: considerWebsiteQuestion } = await import("../lib/customer-intelligence/website-question-topics")
  const qRows = (b: string): Array<{ sessionId: string; content: string; createdAt: string; brokerageId: string }> => [
    { brokerageId: b, sessionId: "s-1", content: "Does the builder warranty cover the roof on a new build in Pace? my email is pat@example.com", createdAt: DAY(-3).toISOString() },
    { brokerageId: b, sessionId: "s-2", content: "how long is a typical new construction warranty?", createdAt: DAY(-2).toISOString() },
    { brokerageId: b, sessionId: "s-3", content: "What does the builder's warranty not cover?", createdAt: DAY(-1).toISOString() },
  ]
  const allQs = [...qRows(B1), { brokerageId: B2, sessionId: "x-9", content: "is there a builder warranty on new homes in Boise?", createdAt: DAY(-1).toISOString() }]
  const reader2 = (rows: typeof allQs) => async (_db: unknown, a: { brokerageId: string }) => ({ rows: rows.filter((r) => r.brokerageId === a.brokerageId).map(({ sessionId, content, createdAt }) => ({ askerKey: `s:${sessionId}`, content, createdAt })) })
  const intakeCalls: Array<Row> = []
  const intake = async (_db: unknown, a: Row) => { intakeCalls.push(a); return { ok: true, inserted: 1, merged: 0, excluded: [] } }
  const w3 = await considerWebsiteQuestion({ from: () => { throw new Error("no direct read expected") } }, { brokerageId: B1, text: "What does the builder's warranty not cover?", now: NOW }, { readQuestions: reader2(allQs) as never, intake: intake as never, openRepair: async () => null })
  const idea =(intakeCalls[0]?.ideas ?? [])[0] as Row | undefined
  check("SIMULATED (2): three DISTINCT website askers → ONE topic submitted to the canonical intake (one call, one idea)", w3.status === "submitted" && intakeCalls.length === 1 && intakeCalls[0].ideas.length === 1 && intakeCalls[0].brokerageId === B1, JSON.stringify(w3))
  check("(2) the idea is a REWORDED local FAQ + education brief — first_party rights, measured distinct-asker count, no visitor words, no email, no session id",
    !!idea && idea.rights === "first_party" && idea.evidence?.kind === "measured" && idea.evidence?.value === 3 && /builder warranty cover/i.test(idea.title) && !/pat@example\.com|s-1|s-2|s-3|roof on a new build/i.test(JSON.stringify(idea)) && (idea.brief?.suggested_original_formats ?? []).includes("education_magnet"), JSON.stringify(idea))
  const oneAsker = await considerWebsiteQuestion({ from: () => ({}) }, { brokerageId: B1, text: "builder warranty?? builder warranty length", now: NOW }, { readQuestions: reader2([0, 1, 2].map((i) => ({ brokerageId: B1, sessionId: "same", content: "how long is the builder warranty on a new home", createdAt: DAY(-i).toISOString() }))) as never, intake: intake as never })
  check("(2) ONE visitor asking three times is ONE asker — below the floor, nothing stored (no invented marketing identities)", oneAsker.status === "below_floor" && oneAsker.askers === 1 && intakeCalls.length === 1, JSON.stringify(oneAsker))
  const b2q = await considerWebsiteQuestion({ from: () => ({}) }, { brokerageId: B2, text: "is there a builder warranty on new homes?", now: NOW }, { readQuestions: reader2(allQs) as never, intake: intake as never })
  check("(2) tenant B2's question is counted only in B2 (one asker there) — B1's visitors never lift another tenant's topic", b2q.status === "below_floor" && b2q.askers === 1 && intakeCalls.length === 1)
  const off = await considerWebsiteQuestion({ from: () => { throw new Error("read on an unclassifiable question") } }, { brokerageId: B1, text: "hi there!", now: NOW })
  check("(2) an unclassifiable message costs nothing (no read, no write)", off.status === "not_a_topic")
  const realDb = memSupabase({ content_topic_bank: [], content_topic_sources: [], content_topic_uses: [], contacts: [{ id: C1, brokerage_id: B1 }], leads: [] }, { uuidIds: true, stampCreatedAt: true })
  const real = await considerWebsiteQuestion(realDb, { brokerageId: B1, text: "What does the builder's warranty not cover?", now: NOW }, { readQuestions: reader2(allQs) as never })
  const realTables = [...new Set(realDb.writes.map((w) => w.table))]
  check("SIMULATED (2, real intake): the only tables written are the topic pool's — no contact, lead or persona write", real.status === "submitted" && realTables.length > 0 && realTables.every((t) => t.startsWith("content_topic_")) && (realDb.tables.content_topic_bank ?? []).length === 1, JSON.stringify({ real, realTables }))
  const bankRow = (realDb.tables.content_topic_bank ?? [])[0] ?? {}
  check("(2) the stored topic row carries no visitor wording or contact point", !/pat@example\.com|roof on a new build|s-1\b/.test(JSON.stringify(bankRow)))
  const widget = code("app/api/widget/message/route.ts")
  check("(2) the website widget calls the feeder after it stores the visitor's question (dynamic import, non-blocking, refusal said)", /chat_messages['"]\)\.insert\([\s\S]{0,1200}considerCustomerQuestion\(/.test(widget) && /await import\(['"]@\/lib\/customer-intelligence\/website-question-topics['"]\)/.test(widget))
  const feeder = code("lib/customer-intelligence/website-question-topics.ts")
  check("(2) the feeder's own read is tenant-bound and customer-question sessions only — website widget + portal assistant (unconditional predicates)", /\.eq\(\s*["']chat_sessions\.brokerage_id["'],\s*a\.brokerageId\s*\)/.test(feeder) && /\.in\(\s*["']chat_sessions\.session_type["'],\s*\[\.\.\.CUSTOMER_QUESTION_SESSION_TYPES\]\s*\)/.test(feeder) && /CUSTOMER_QUESTION_SESSION_TYPES\s*=\s*\[\s*["']website_widget["'],\s*["']portal_widget["']\s*\]\s*as const/.test(feeder))

  // (3) A current seller asks about closing costs and insurance → a comparison from SUPPLIED facts; title / lender → those vendors.
  const { sellerNetScenario } = await import("../lib/calculators/engine") // 156H r4: lib/cma/net-sheet-math.ts retired onto the engine
  const supplied = { salePrice: 400000, closingCosts: 8000, mortgagePayoffAmount: 200000 }
  const sA = sellerNetScenario("As listed", { salePrice: supplied.salePrice, listingCommissionPct: 2.5, buyerBrokerCompPct: 2.5, closingCosts: supplied.closingCosts, mortgagePayoff: supplied.mortgagePayoffAmount }, { audience: "internal" })
  const sB = sellerNetScenario("With a 1% concession", { salePrice: supplied.salePrice, listingCommissionPct: 2.5, buyerBrokerCompPct: 2.5, closingCosts: supplied.closingCosts, mortgagePayoff: supplied.mortgagePayoffAmount, sellerConcessions: 4000 }, { audience: "internal" })
  check("SIMULATED (3): the comparison is arithmetic on the facts SUPPLIED (price, payoff, closing costs) — 172,000 vs 168,000, nothing invented", sA.netProceeds === 172000 && sB.netProceeds === 168000 && sA.breakdown.propertyTaxes === 0 && sA.breakdown.hoaFees === 0, JSON.stringify([sA.netProceeds, sB.netProceeds]))
  const { classifyHomeFollowUp, vendorCategoryFor } = await import("../lib/portal/home-assistant")
  const { isVendorCategory } = await import("../lib/kernel/vendor-categories")
  const titleQ = "What will my closing costs be, and who handles the title insurance on my sale?"
  const insQ = "Do I need a homeowners insurance quote before closing?"
  const lenderQ = "Can you recommend a lender for my buyer's mortgage questions?"
  check("FIXED (3): a TITLE question earns a vendor intro under the canonical 'title' category (was: no follow-up at all)", classifyHomeFollowUp(titleQ) === "vendor" && vendorCategoryFor(titleQ, []) === "title" && isVendorCategory("title"))
  check("(3) an insurance question → canonical 'insurance'; a lender question → canonical 'lender' (a VENDOR category, never a user type)", classifyHomeFollowUp(insQ) === "vendor" && vendorCategoryFor(insQ, []) === "insurance" && classifyHomeFollowUp(lenderQ) === "vendor" && vendorCategoryFor(lenderQ, []) === "lender" && isVendorCategory("insurance"))
  const BASE_VENDOR_RE = /\b(plumber|plumbing|electrician|electrical|roofer|roofing|hvac|furnace|a\/?c|air condition\w*|contractor|handyman|landscap\w*|painter|painting|mover|moving company|cleaner|cleaning|pest|inspector|gutter\w*|window\w*|flooring|remodel\w*|renovat\w*|repair\w*|fix (my|the|our)|recommend(ation)? (for )?a|know (a|any|someone)|who (do|would) you (use|recommend)|referral for a|good (\w+ )?(guy|company|service|pro|vendor)|lender|mortgage broker)\b/i
  check("NEGATIVE CONTROL (base): the base vendor pattern does not recognise the title question — the follow-up was lost", !BASE_VENDOR_RE.test(titleQ))
  const { interactiveTurnVerdict, lateResultDisposition } = await import("../lib/ai-isa/followup-arbiter")
  const own0 = { humanOwnedUntil: null, ownedReason: null, humanEngagedAt: null, lastOutboundAt: null, lastInboundAt: null }
  const fin = interactiveTurnVerdict({ body: "what will lender fees and title cost me?", intent: { primary: "financing_question", confidence: 85 }, knownContact: true, isPublic: false, ownership: own0, now: NOW })
  check("(3) a money / lender question from a known seller goes to a PERSON now (fast path, no planning call)", fin.path === "fast" && fin.optionId === "notify_human")

  // (4) An explicitly shared military report date → kept in the persona's PCS plan; relocation help offered; no orders claim.
  const { planPcsMoveForPortalContact } = await import("../lib/relocation/pcs-portal-door")
  const { personaJourneyTools } = await import("../lib/kernel/types")
  const pcsDb = memSupabase({ contacts: [{ id: C1, brokerage_id: B1, agent_id: AGENT, contact_persona: "military" }, { id: C1B, brokerage_id: B2, agent_id: null, contact_persona: "first_time" }], agent_licenses: [{ agent_id: AGENT, brokerage_id: B1, license_state: "FL", license_status: "active" }] }, { uuidIds: true })
  const recorded: Row[] = []
  const recordStatedDate = async (_s: unknown, a: Row) => { recorded.push(a); return { status: "reassessed" as const, reason: "window placed on the stated date" } }
  const reportDate = DAY(75).toISOString().slice(0, 10)
  const pcs = await planPcsMoveForPortalContact(pcsDb as never, { brokerageId: B1, contactId: C1, userId: "portal-user", isContactSelf: true }, { consentGiven: true, destinationLabel: "Fort Liberty, NC", destinationState: "NC", reportDate }, { now: NOW, recordStatedDate: recordStatedDate as never })
  check("SIMULATED (4): the person's OWN report date is kept through the canonical movement writer (stated_date / relocation_start, captured by the person)",
    pcs.ok && pcs.statedDate.status === "recorded" && recorded.length === 1 && recorded[0].capturedBy === "person" && recorded[0].change?.kind === "stated_date" && recorded[0].change?.deadline?.kind === "relocation_start" && String(recorded[0].change?.deadline?.at).startsWith(reportDate), JSON.stringify(pcs.ok ? pcs.statedDate : pcs))
  check("(4) the PCS planner is a journey tool of the MILITARY persona in the kernel persona types (the portal widget reads it)", personaJourneyTools("military").includes("pcs_move_plan") && personaJourneyTools("first_time").length === 0)
  const planText = pcs.ok ? JSON.stringify(pcs.plan) : ""
  check("(4) the plan claims NO access to orders (no 'your orders show/say', no 'we reviewed your orders')", pcs.ok && !/your orders (show|say|state|indicate)|we (have|accessed|reviewed|checked) your orders|according to your orders/i.test(planText))
  const staff = await planPcsMoveForPortalContact(pcsDb as never, { brokerageId: B1, contactId: C1, userId: "staff", isContactSelf: false }, { consentGiven: true, destinationLabel: "Fort Liberty, NC", reportDate }, { now: NOW, recordStatedDate: recordStatedDate as never })
  const noConsent = await planPcsMoveForPortalContact(pcsDb as never, { brokerageId: B1, contactId: C1, userId: "portal-user", isContactSelf: true }, { consentGiven: false, destinationLabel: "Fort Liberty, NC", reportDate }, { now: NOW, recordStatedDate: recordStatedDate as never })
  check("(4) only the PERSON shares it, consent first: staff and an unticked consent are refused and nothing is recorded", !staff.ok && staff.code === "not_the_person" && !noConsent.ok && noConsent.code === "no_consent" && recorded.length === 1)

  // (5) An agent negotiating an addendum → the communication manager respects the agent's conversation ownership.
  const agentWrote = { ...own0, humanEngagedAt: new Date(NOW.getTime() - 6 * 60_000).toISOString(), lastOutboundAt: new Date(NOW.getTime() - 6 * 60_000).toISOString() }
  const routineWhileAgentNegotiates = interactiveTurnVerdict({ body: "ok sounds good, when can we see it?", intent: { primary: "schedule_showing", confidence: 90 }, knownContact: true, isPublic: false, ownership: agentWrote, now: NOW })
  check("SIMULATED (5): while the agent is writing in the thread, even a ROUTINE turn is the agent's — the AI does not land on top", routineWhileAgentNegotiates.path === "human_owns")
  const late = lateResultDisposition({ decidedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(), fallbackAnswered: false, fallbackOptionId: "notify_human", lateOptionId: "reply", ownership: agentWrote, now: NOW })
  check("(5) a late automated answer after the agent stepped in is STALE (stale_human_owns) — no stale automated content is sent", late.disposition === "stale_human_owns")
  check("(5) ownership unreadable → a person answers (fail closed)", interactiveTurnVerdict({ body: "hi", intent: { primary: "general_question", confidence: 90 }, knownContact: true, isPublic: false, ownership: null, now: NOW }).path === "human_owns")
  const reg = raw("lib/kernel/manager-registry.ts")
  check("(5) EXISTING VERIFIED: approved addendum terms are reconciled by finance with compliance and the deal coordinator (registry row), and an addendum is approved before signature", /executed_contract_change_consequences:\s*\{\s*manager:\s*"finance_manager"[^\n]*coOwners:\s*\["compliance_officer",\s*"deal_coordinator"\]/.test(reg) && /export async function approveAddendumForSignature\(/.test(code("lib/esign/addendum-signature-request.ts")))

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§5 I5 — canaries (SIMULATED)")
  check("CANARY: an existing Contact's newly stated need → a correctly scoped shopping-agent signal (tenant + contact + fields)", sig.brokerageId === B1 && sig.contactId === C1 && published.length === 1)
  const stored = await loadBuyerCriteria(cdb as never, C1, { brokerageId: B1 })
  const chips = stored ? criteriaChips(stored) : []
  check("CANARY: the buyer portal's criteria view shows the change as SAID (provenance chip), read from the one store", chips.some((c) => c.field === "maxPrice" && c.provenance === "said" && /550/.test(c.label)), JSON.stringify(chips))
  check("CANARY: the Contact persona widget's journey tool follows the STORED persona only (military → PCS plan; none for an unknown)", personaJourneyTools("military").length === 1 && personaJourneyTools(null).length === 0 && personaJourneyTools("website_question").length === 0)
  check("CANARY: a third-party anonymous topic never becomes a persona field (feeder writes only content_topic_*; §1 scan clean)", realTables.every((t) => t.startsWith("content_topic_")) && topicHits.length === 0)
  const b2Prefs = (cdb.tables.property_preferences ?? []).find((r) => r.contact_id === C1B)
  const crossRead = await loadBuyerCriteria(cdb as never, C1B, { brokerageId: B1 })
  check("CANARY: the same person in two tenants keeps a boundary — B1's turn never touched B2's store, and B1 cannot read B2's", b2Prefs?.preferred_price_max === 350000 && JSON.stringify(b2Prefs?.inferred_cities) === JSON.stringify(["Boise"]) && crossRead === null)
  check("CANARY: each tenant keeps its own brand and service context for that person (voice briefs differ; neither carries the other)", vA.version !== vB.version && !/Summit Ridge/.test(renderSenderVoiceBrief(vA)) && !/Harbor & Pine/.test(renderSenderVoiceBrief(vB)))
  const fast = interactiveTurnVerdict({ body: "can we tour it saturday?", intent: { primary: "schedule_showing", confidence: 90 }, knownContact: true, isPublic: false, ownership: own0, now: NOW })
  check("CANARY: a routine turn is answered NOW with no broker click (fast path), and consent / quiet hours still gate the send", fast.path === "fast" && fast.optionId === "reply" && /consent, quiet hours/.test(fast.reason))
  check("CANARY: the long-term follow-up is timed independently on the person's stated date (a deadline 75 days out), not on the fast reply", recorded.length === 1 && Date.parse(recorded[0].change.deadline.at) - NOW.getTime() > 60 * 86_400_000)
  const { firstLookConsentBlock } = await import("../lib/property-alerts/first-look-consent")
  check("CANARY: no channel without consent — no phone → no text; opted out / DNC → blocked", firstLookConsentBlock({ phone: null }) === "no_phone_on_file" && firstLookConsentBlock({ phone: "555", sms_opt_out: true }) === "consent_blocked" && firstLookConsentBlock({ phone: "555", dnc_status: true }) === "consent_blocked" && firstLookConsentBlock({ phone: "555" }) === null)

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§6 the carried fix — property_search_log carries the SESSION tenant; the first-party reader is tenant-bound")
  const idx = blankStrings(code("app/actions/idx-search.ts"))
  const idxRaw = code("app/actions/idx-search.ts")
  const LOG_INSERT = /\.from\(\s*["']property_search_log["']\s*\)\.insert\(\{([\s\S]{0,400}?)\}\)/
  const m = idxRaw.match(LOG_INSERT)
  check("FIXED: the property_search_log insert names brokerage_id from the resolved actor (logTenant ← getAgentContext), never the request", !!m && /brokerage_id:\s*logTenant\.brokerageId/.test(m[1]) && /logTenantForSearch\(\s*spendActor\.brokerageId/.test(idxRaw))
  check("POSITIVE CONTROL: the base insert (no brokerage_id) is caught by the same reading", (() => { const b = `await supabase.from("property_search_log").insert({ contact_id: data.contactId, query_text: q })`.match(LOG_INSERT); return !!b && !/brokerage_id/.test(b[1]) })())
  check("the tenant helper refuses a tenantless actor and a contact outside the actor's tenant (nothing logged, said)", /if \(!actorBrokerageId\) return \{ ok: false/.test(idxRaw) && /contactBrokerageId !== actorBrokerageId/.test(idxRaw) && !/export function logTenantForSearch/.test(idx))
  const behavioral = code("lib/lead-intelligence/behavioral-summary.ts")
  check("EXISTING VERIFIED: the first-party search statements are read only for the tenant's own rows (contact AND brokerage predicates; no tenant → not read)", /buyer_criteria_utterances[\s\S]{0,400}\.eq\(\s*["']contact_id["'][\s\S]{0,80}\.eq\(\s*["']brokerage_id["'],\s*brokerageId\s*\)/.test(behavioral) && /no tenant — the statements are not read/.test(behavioral))
  check("EXISTING VERIFIED: the stated-criteria reader (loadBuyerCriteria) binds the tenant unconditionally", /\.eq\(\s*["']contact_id["'],\s*contactId\s*\)\.eq\(\s*["']brokerage_id["'],\s*brokerageId\s*\)/.test(code("lib/buyer-search/buyer-criteria.ts")) && crossRead === null)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) { console.log(`FAILED:\n - ${failures.join("\n - ")}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
