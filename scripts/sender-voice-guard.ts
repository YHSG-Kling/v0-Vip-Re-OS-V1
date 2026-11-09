// scripts/sender-voice-guard.ts — `test:sender-voice` (wave 151, lane 151I — AI copy that sounds like the ACTUAL user from the first draft)
// ─────────────────────────────────────────────────────────────────────────────
// Owner (verbatim): "when I meant that the copy is in the user's words, I didn't mean that after copy is created, let the
// human put in their words. I meant that AI takes the user's added words, tagline, from their settings, and creates the copy
// from the user's tone and word choices so it helps to have the copy sound like the user and humanized — but gear it to
// them (contact or geared audience persona) first methodology."
//
//   §A THE SENDER-VOICE BRIEF — compiled from the sender's APPROVED settings and AUTHORIZED examples through THE ONE
//      brand-voice reader (lib/kernel/brand-voice.ts loadSenderVoiceBrief); VERSIONED (`v1:<sha12>`, a changed setting is a
//      new version); a sender with NO writing sample gets settings only and the explicit line (no invented vocabulary — another
//      agent's words never leak); a refused read is NAMED, never guessed; an AI-authored final is NOT a writing sample.
//   §B THE AUDIENCE BRIEF — separate, from appropriately sourced expressed interests (the person's own words on the ONE
//      memory ledger + stated criteria + their preference columns) and persona context; THEM FIRST (a homeowner who said
//      "less maintenance" is written to about that, never a seller solicitation); every persona label welcome; protected-class
//      attributes never copy facts (positive control: the row carries them); tenant-pinned.
//   §C THE GENERATOR CONDITIONS ON BOTH BRIEFS BEFORE THE FIRST DRAFT — the real composition on an injected deterministic
//      model: sender brief first, audience second, rules after; two agents, one subject → distinct drafts with the SAME facts
//      and the SAME brand boundary; no briefs → the rules alone. Static: every channel generator puts the voice in the prompt
//      before its model call (direct) or hands the copy engine the sender (engine); a generator that drafts first and voices
//      later is CAUGHT (positive control).
//   §D THE FINAL GUARD — a required disclosure is appended word for word or the publication is REFUSED (a paraphrase is not the
//      disclosure); the sender's own formality setting, a drafted signature / opt-out the ONE assembler adds, accessibility
//      (all-caps, bare link text, run-ons) are NAMED; a seller solicitation opener is caught by the ONE tell list; human
//      approval stays the gate.
//   §E PROVENANCE — the staged final records created_by, brokerage_id, status and findings.voice_source (version, sources).
//   §F ONE COMPILER — exactly one loadSenderVoiceBrief in lib/; the pipeline and the social writer no longer read
//      brand_voice_profile privately (stripped source; a tombstone is not a read).
// The summary line is `RESULT: N passed, M failed`.

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { loadSenderVoiceBrief, renderSenderVoiceBrief, type SenderVoiceBrief } from "../lib/kernel/brand-voice"
import { generatePersonaCopy, type AudienceBrief } from "../lib/kernel/ai-copy"
import { loadAudienceBrief } from "../lib/campaign-sequences/persona-render"
import { finalizeForDistribution, stageDistributionFinal, checkDistributionPublication } from "../lib/marketing/humanize-final"

let pass = 0, fail = 0
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const ROOT = process.cwd()
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
const code = (p: string) => stripComments(raw(p))
const tokens = (p: string) => blankStrings(stripComments(raw(p)))
function walk(dir: string, out: string[] = []): string[] {
  let names: string[] = []
  try { names = readdirSync(join(ROOT, dir)) } catch { return out }
  for (const n of names) {
    if (n === "node_modules" || n === "__tests__" || n.startsWith(".")) continue
    const p = join(dir, n)
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p)
  }
  return out
}

// ── fixtures: ONE brokerage, TWO agents with different settings, ONE contact with their own words ─────────
const B1 = "11111111-1111-4111-8111-111111111111"
const B2 = "22222222-2222-4222-8222-222222222222"
const U1 = "aaaaaaaa-0000-4000-8000-000000000001", A1 = "aaaaaaaa-0000-4000-8000-00000000a001", T1 = "tttttttt-0000-4000-8000-000000000001"
const U2 = "bbbbbbbb-0000-4000-8000-000000000002", A2 = "bbbbbbbb-0000-4000-8000-00000000a002"
const U3 = "cccccccc-0000-4000-8000-000000000003", A3 = "cccccccc-0000-4000-8000-00000000a003"
const C1 = "dddddddd-0000-4000-8000-000000000001", C3 = "dddddddd-0000-4000-8000-000000000003"
const NOW = new Date("2026-11-09T12:00:00Z")
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const daysAhead = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString()

function seed() {
  return memSupabase({
    brokerages: [{ id: B1, name: "Harbor & Pine Homes", city: "Pace", state: "FL" }],
    brand_voice_profile: [
      { id: "bv-base", brokerage_id: B1, agent_id: null, team_id: null, tone: "warm", formality_level: "conversational", preferred_words: ["neighbors", "the long game"], prohibited_words: ["guaranteed"], key_brand_messages: ["every move is a long-term relationship"], tagline: "Neighbors first, numbers always", mission_statement: null, tone_examples: [], writing_style_notes: null },
      { id: "bv-a1", brokerage_id: B1, agent_id: A1, team_id: null, tone: "direct", formality_level: null, preferred_words: ["straight talk", "your block"], prohibited_words: [], key_brand_messages: [], tagline: "Straight talk about your block", mission_statement: null, tone_examples: ["Three homes on Alder sold last month; two went over asking.", "If you are weighing a move before school starts, here is how long it usually takes."], writing_style_notes: "short sentences, one number per paragraph" },
    ],
    users: [
      { id: U1, first_name: "Jane", last_name: "Rivera", email_signature: "<p>Jane Rivera<br>Harbor &amp; Pine Homes · 555-0100</p>", team_id: T1 },
      { id: U2, first_name: "Marcus", last_name: "Lee", email_signature: null, team_id: null },
      { id: U3, first_name: "Priya", last_name: "Nair", email_signature: null, team_id: null },
    ],
    agents: [
      { id: A1, user_id: U1, brokerage_id: B1, team_id: T1, bio: "Fifteen years on the west side of Pace.", specializations: ["waterfront"], languages: ["English", "Spanish"], license_number: "SL123", license_state: "fl" },
      { id: A2, user_id: U2, brokerage_id: B1, team_id: null, bio: null, specializations: [], languages: [], license_number: "SL456", license_state: "FL" },
      { id: A3, user_id: U3, brokerage_id: B1, team_id: null, bio: null, specializations: [], languages: [], license_number: null, license_state: null },
    ],
    teams: [{ id: T1, brokerage_id: B1, name: "The West Side Team", tagline: "West side, done right", branding_override: null, member_overrides_json: null }],
    brokerage_brand_settings: [{ brokerage_id: B1, tagline: "Calm advice, local roots", email_signature_html: "<p>Harbor &amp; Pine Homes · Pace, FL</p>" }],
    ai_identity_profiles: [],
    farm_territories: [{ brokerage_id: B1, agent_id: A1, name: "Alder Creek", city: "Pace", state: "FL", zip_codes: ["32571"], is_active: true }],
    distribution_finals: [
      // An AI-written final a person approved is the AI's voice, not the sender's — never a writing sample (U3).
      { id: "df-ai", brokerage_id: B1, created_by: U3, authored_by: "ai", status: "approved", final_text: "A fresh take on the west side market.", created_at: daysAgo(3) },
    ],
    notifications: [],
    contacts: [
      {
        id: C1, brokerage_id: B1, first_name: "Pat", last_name: "Ortiz", contact_type: "seller", contact_persona: "downsizer", buyer_stage: null, home_owner_status: "owner",
        enrichment_profile: null, last_contacted_at: daysAgo(92), preferred_channel: "email", preferred_contact_time: "evenings", preferred_language: null,
        accessibility_preferences: ["large_text"], age_range: "65+", gender: "F", household_income: "150k+",
        metadata: { context_spine: { summary: "Pat owns on Alder and is tired of the yard.", lastTouch: daysAgo(5), preferences: ["wants less yard maintenance"], openNextStep: null, sentiment: "neutral", keyFacts: [], interactionCount: 3, updatedAt: daysAgo(5), facts: [
          { key: "motivation", value: "less maintenance", observedAt: daysAgo(5), confidence: 0.9, reviewBy: daysAhead(100), source: "person_words:sms:m1" },
          { key: "explanation_style", value: "plain_language", observedAt: daysAgo(5), confidence: 0.9, reviewBy: daysAhead(100), source: "person_words:sms:m1" },
          { key: "motivation", value: "an enrichment model's guess", observedAt: daysAgo(40), confidence: 0.4, reviewBy: daysAhead(60), source: "enrichment:model", supersededAt: daysAgo(5), supersededBy: "less maintenance" },
          { key: "timeline", value: "stale", observedAt: daysAgo(300), confidence: 0.9, reviewBy: daysAgo(200), source: "person_words:email:m0" },
        ] } },
      },
      { id: C3, brokerage_id: B1, first_name: "Sam", last_name: "Quinn", contact_type: "both", contact_persona: "probate", buyer_stage: null, home_owner_status: "owner", enrichment_profile: null, last_contacted_at: null, metadata: null },
    ],
  }, { uuidIds: true })
}

async function main() {
  const db = seed()
  const fresh = { cache: false as const, now: NOW }

  // ══ §A ══════════════════════════════════════════════════════════════════════════════════════
  section("A · the sender-voice brief — compiled from the sender's settings and authorized examples, versioned, never invented")
  const b1 = await loadSenderVoiceBrief(db as never, { brokerageId: B1, agentUserId: U1 }, fresh)
  const b2 = await loadSenderVoiceBrief(db as never, { brokerageId: B1, agentUserId: U2 }, fresh)
  check("agent 1: the agent overlay wins the tone and the tagline; the brokerage base's words accumulate beside the agent's own",
    b1.tone === "direct" && b1.tagline === "Straight talk about your block" && b1.taglineSource === "agent" && b1.preferredWords.includes("straight talk") && b1.preferredWords.includes("neighbors"), JSON.stringify({ tone: b1.tone, tagline: b1.tagline, words: b1.preferredWords }))
  check("agent 1: the brand boundary is carried (the brokerage's prohibited word) and the signature the ONE assembler appends is known (users.email_signature, plain text)",
    b1.prohibitedWords.includes("guaranteed") && b1.signature.source === "user" && /Jane Rivera/.test(b1.signature.text ?? "") && !/<p>/.test(b1.signature.text ?? ""), JSON.stringify(b1.signature))
  check("agent 1: the authorized writing sample is the distilled examples from the sender's own published pieces (tone_examples) — hasWritingSample",
    b1.hasWritingSample && b1.writingSamples.length === 2 && b1.writingSamples.every((s) => /tone_examples/.test(s.source)))
  check("agent 1: professional positioning and local expertise come from the agents row and the active farm territory, named as sources",
    b1.positioning.licenseLine === "FL License # SL123" && b1.positioning.languages.includes("Spanish") && b1.localExpertise.areas.some((a) => /Alder Creek/.test(a)) && b1.sources.includes("farm_territories@agent") && b1.sources.includes("users.email_signature"), JSON.stringify({ pos: b1.positioning, local: b1.localExpertise, sources: b1.sources }))
  check("VERSIONED: `v1:<sha12>`, deterministic for the same settings, different for a different sender",
    /^v1:[0-9a-f]{12}$/.test(b1.version) && b1.version === (await loadSenderVoiceBrief(db as never, { brokerageId: B1, agentUserId: U1 }, fresh)).version && b1.version !== b2.version, `${b1.version} vs ${b2.version}`)
  check("the same scope named by the agents.id (not the users.id) compiles the SAME version (either id names the agent; disjoint id spaces crossed inside the tenant)",
    (await loadSenderVoiceBrief(db as never, { brokerageId: B1, agentId: A1 }, fresh)).version === b1.version)
  check("agent 2 (no agent row, no sample): the brokerage BASE voice applies — tone warm, the base tagline, the brand's prohibited word — and NO writing sample",
    b2.tone === "warm" && b2.tagline === "Neighbors first, numbers always" && b2.taglineSource === "brokerage" && b2.prohibitedWords.includes("guaranteed") && b2.hasWritingSample === false && b2.signature.source === "brokerage", JSON.stringify({ tone: b2.tone, tagline: b2.tagline, sig: b2.signature.source }))
  const r1 = renderSenderVoiceBrief(b1), r2 = renderSenderVoiceBrief(b2)
  check("the rendered brief for a sender WITHOUT a sample says so in so many words and uses ONLY the stated settings (no invented vocabulary — the other agent's words never leak)",
    /No writing sample is on file for this sender/.test(r2) && !/straight talk/.test(r2) && !/How they write/.test(r2) && /neighbors, the long game/.test(r2))
  check("the rendered brief for a sender WITH a sample carries their own sentences and the instruction to match rhythm, not copy",
    /How they write — their own sentences/.test(r1) && /Three homes on Alder sold last month/.test(r1) && /never copy a sentence/.test(r1))
  check("both briefs begin with the versioned header, name the tagline exactly, tell the writer the signature is appended (never drafted) and that legal text is not theirs to write",
    [r1, r2].every((r) => /^SENDER VOICE BRIEF v1:[0-9a-f]{12}/.test(r) && /Tagline \(exact wording or not at all/.test(r) && /do NOT write one|do NOT draft one/.test(r) && /Legal and required disclosure text is not yours to write/.test(r)))
  // A CHANGED SETTING IS A NEW VERSION.
  db.tables.brand_voice_profile.push({ id: "bv-a2", brokerage_id: B1, agent_id: A2, team_id: null, tone: "playful", formality_level: "casual", preferred_words: ["let's keep it simple"], prohibited_words: [], key_brand_messages: [], tagline: null, mission_statement: null, tone_examples: [], writing_style_notes: null })
  const b2b = await loadSenderVoiceBrief(db as never, { brokerageId: B1, agentUserId: U2 }, fresh)
  check("a saved setting (agent 2 adds their own words) is a NEW version — the old one is never silently reused", b2b.version !== b2.version && b2b.tone === "playful" && b2b.preferredWords.includes("let's keep it simple"))
  // AUTHORIZED EXAMPLES: the sender's OWN approved edit counts; an AI-authored approved final does not.
  db.tables.distribution_finals.push({ id: "df-h", brokerage_id: B1, created_by: U2, authored_by: "human", status: "published", final_text: "<p>Pat, the two homes on Alder closed in nine days. Here is what that means for your timing.</p>", created_at: daysAgo(2) })
  const b2c = await loadSenderVoiceBrief(db as never, { brokerageId: B1, agentUserId: U2 }, fresh)
  const b3 = await loadSenderVoiceBrief(db as never, { brokerageId: B1, agentUserId: U3 }, fresh)
  check("the sender's OWN approved edit (distribution_finals authored_by human, approved/published) is a writing sample; an AI-authored approved final is NOT (agent 3 stays settings-only)",
    b2c.hasWritingSample && b2c.writingSamples.some((s) => /own approved edit/.test(s.source) && /two homes on Alder closed/.test(s.text)) && b3.hasWritingSample === false, JSON.stringify({ b2c: b2c.writingSamples, b3: b3.hasWritingSample }))
  // A REFUSED READ IS NAMED, NEVER GUESSED.
  const refusedDb = seed()
  const brRefused = await loadSenderVoiceBrief(memSupabase({ ...refusedDb.tables }, { uuidIds: true, refuse: { users: "permission denied for table users" } }) as never, { brokerageId: B1, agentUserId: U1 }, fresh)
  check("FAIL HONEST: a refused users read is NAMED in readErrors and the rendered brief says what could not be read — the voice is compiled from what WAS readable (the agent overlay still applies)",
    brRefused.readErrors.some((e) => /users read refused/.test(e)) && /could NOT be read/.test(renderSenderVoiceBrief(brRefused)) && brRefused.tone === "direct" && brRefused.signature.source !== "user", JSON.stringify(brRefused.readErrors))
  check("NEGATIVE CONTROL: no refusal → readErrors empty", b1.readErrors.length === 0 && b2.readErrors.length === 0)

  // ══ §B ══════════════════════════════════════════════════════════════════════════════════════
  section("B · the audience brief — separate, from the person's own words; them first; every persona welcome; protected attributes never copy facts")
  const a1 = await loadAudienceBrief(db as never, { brokerageId: B1, contactId: C1, now: NOW })
  check("the brief names the person, keeps the persona LABEL (downsizer — not refused) and the contact_type as a label only",
    a1.name === "Pat Ortiz" && a1.personaLabel === "downsizer" && a1.audience === "seller")
  check("THEM FIRST: what they SAID leads — the own-words motivation and the stated criterion; the superseded enrichment guess and the expired fact are NOT there",
    a1.leadWith.some((l) => /less maintenance/.test(l)) && a1.leadWith.some((l) => /less yard maintenance/.test(l)) && !JSON.stringify(a1).includes("enrichment model") && !a1.stated.some((s) => s.value === "stale"), JSON.stringify(a1.leadWith))
  check("how they want to hear from us: the own-words explanation style, the preference columns, the accessibility preference",
    a1.preferences.explanationStyle === "plain_language" && a1.preferences.channel === "email" && a1.preferences.time === "evenings" && a1.preferences.accessibility.includes("large_text"))
  check("POSITIVE CONTROL: the row carries protected-class attributes (age_range 65+, gender) — none reaches the brief's facts, leadWith or stated (the FH rule lives at the copy fact, not as a deleted attribute)",
    !JSON.stringify({ f: a1.facts, l: a1.leadWith, s: a1.stated }).match(/65\+|gender|household/i) && a1.facts.includes("currently owns their home") && a1.evidenceClass === "expressed_interest")
  const rendered = (() => { let seen = ""; return { seen, get: async () => { const d = await generatePersonaCopy({ goal: "g", facts: ["f"], channel: "email", persona: {}, audience: a1 }, { body: "FB" }, { chat: async ({ messages }) => { seen = messages[0].content; return { ok: true, content: JSON.stringify({ body: "x" }) } } }); return { d, seen } } } })()
  const ab = await rendered.get()
  check("the rendered audience brief opens on the stated need and forbids a seller solicitation opener (a homeowner asking about less maintenance gets genuinely useful alternatives, not a listing pitch)",
    /AUDIENCE BRIEF v1/.test(ab.seen) && /THEM FIRST — they told us what matters to them: .*less maintenance/.test(ab.seen) && /Do NOT open with an offer to sell, list or value their home/.test(ab.seen) && /Every persona is welcome/.test(ab.seen))
  const a3 = await loadAudienceBrief(db as never, { brokerageId: B1, contactId: C3, now: NOW })
  check("a sensitive persona label (probate) is carried, not refused; with nothing stated the brief says so (persona_only) and the them-first line asks, never pitches",
    a3.personaLabel === "probate" && a3.evidenceClass === "persona_only" && a3.leadWith.length === 0)
  const aForeign = await loadAudienceBrief(db as never, { brokerageId: B2, contactId: C1, now: NOW })
  check("TENANT-PINNED: another brokerage reads NOTHING about this contact (no name, no words, the miss is named)", aForeign.name === null && aForeign.leadWith.length === 0 && aForeign.readErrors.some((e) => /no such contact/.test(e)))
  const aNone = await loadAudienceBrief(db as never, { brokerageId: B1, contactId: null, now: NOW })
  check("no contact (a broadcast) → an honest empty brief, no guess", aNone.evidenceClass === "none" && aNone.facts.length === 0 && aNone.readErrors.length === 0)
  const aRefused = await loadAudienceBrief(memSupabase({}, { refuse: { contacts: "permission denied for table contacts" } }) as never, { brokerageId: B1, contactId: C1, now: NOW })
  check("FAIL HONEST: a refused contacts read is NAMED and injects nothing", aRefused.readErrors.some((e) => /refused/.test(e)) && aRefused.facts.length === 0)

  // ══ §C ══════════════════════════════════════════════════════════════════════════════════════
  section("C · the generator is conditioned on BOTH briefs BEFORE the first draft (real composition, deterministic model)")
  const FACT = "the two homes on Alder closed in nine days"
  type Call = { system: string; user: string }
  const calls: Call[] = []
  // A deterministic "model": writes from what the system prompt TELLS it — the sender's first stated word, their exact tagline,
  // and the one fact it was given. Different briefs → different drafts; the fact is always kept.
  const fakeModel = async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
    const system = messages[0].content, user = messages[1].content
    calls.push({ system, user })
    const words = /Their words and phrases \(use them where they fit naturally; never force or pile them up\): ([^\n]+)/.exec(system)?.[1]?.split(", ")[0] ?? "plain language"
    const tagline = /Tagline \(exact wording or not at all; the final phase places it\): "([^"]+)"/.exec(system)?.[1] ?? ""
    const fact = /Facts you may use:\n- ([^\n]+)/.exec(user)?.[1] ?? ""
    const lead = /THEM FIRST — they told us what matters to them: ([^.;]+)/.exec(system)?.[1] ?? ""
    return { ok: true, content: JSON.stringify({ subject: `${words}`, body: `${lead ? `About ${lead.replace(/^motivation: /, "")}: ` : ""}${words} — ${fact}.${tagline ? ` — ${tagline}` : ""}` }) }
  }
  const req = (brief: SenderVoiceBrief | null, audience: AudienceBrief | null) => ({ goal: "a short check-in email", facts: [FACT], channel: "email", persona: { name: "Pat", audience: "seller" }, words: 60, senderVoice: brief, audience })
  const d1 = await generatePersonaCopy(req(b1, a1), { body: "FALLBACK" }, { chat: fakeModel })
  const d2 = await generatePersonaCopy(req(b2, a1), { body: "FALLBACK" }, { chat: fakeModel })
  const s1 = calls[0].system, s2 = calls[1].system
  check("the sender's brief is the FIRST block of the system prompt, the audience brief second, the rules after — before any draft exists",
    s1.indexOf("SENDER VOICE BRIEF") === 0 && s1.indexOf("AUDIENCE BRIEF") > 0 && s1.indexOf("AUDIENCE BRIEF") < s1.indexOf("Rules you must NEVER break") && s2.indexOf("SENDER VOICE BRIEF") === 0)
  check("TWO AGENTS, ONE SUBJECT: distinct, naturally different drafts (agent 1's words + tagline vs agent 2's) that preserve the SAME fact",
    d1.body !== d2.body && d1.body.includes(FACT) && d2.body.includes(FACT) && /straight talk/.test(d1.body) && /Straight talk about your block/.test(d1.body) && /neighbors/.test(d2.body) && /Neighbors first, numbers always/.test(d2.body), JSON.stringify({ d1: d1.body, d2: d2.body }))
  check("…and both open on what THE PERSON said (them first), with the same brand boundary in both prompts (the brokerage's prohibited word)",
    /^About less maintenance/.test(d1.body) && /^About less maintenance/.test(d2.body) && /Never use \(their own list\): guaranteed/.test(s1) && /Never use \(their own list\): guaranteed/.test(s2))
  check("the sender without a sample is told so in the prompt and the other agent's vocabulary never reaches them", /No writing sample is on file/.test(s2) && !/straight talk/.test(s2))
  check("PROVENANCE rides the draft: each draft carries the voice version it was written in", d1.voiceSource?.version === b1.version && d2.voiceSource?.version === b2.version)
  const d0 = await generatePersonaCopy({ goal: "g", facts: [FACT], channel: "email", persona: { name: "Pat" } }, { body: "FALLBACK" }, { chat: fakeModel })
  check("NO BRIEFS → the rules alone (the prior prompt, byte for byte: it begins with the first rule line) and no voice stamp", calls[2].system.startsWith("You write real-estate marketing copy for a specific person.") && !/SENDER VOICE BRIEF|AUDIENCE BRIEF/.test(calls[2].system) && d0.voiceSource == null)
  const dFb = await generatePersonaCopy(req(b1, a1), { body: "DETERMINISTIC FALLBACK" }, { chat: async () => ({ ok: false }) })
  check("the model unavailable → the deterministic fallback (a play never breaks); a fallback is nobody's modelled voice (no stamp)", dFb.body === "DETERMINISTIC FALLBACK" && dFb.voiceSource == null)

  // STATIC: every channel generator voices BEFORE it drafts.
  type Direct = { kind: "direct"; channel: string; file: string; voice: RegExp; model: RegExp }
  type Engine = { kind: "engine"; channel: string; file: string; calls: number }
  type Shape = { kind: "shape"; channel: string; file: string; shape: RegExp; useRaw?: boolean }
  const ROSTER: Array<Direct | Engine | Shape> = [
    { kind: "direct", channel: "emails / SMS / plays (the copy engine)", file: "lib/kernel/ai-copy.ts", voice: /\bsenderVoiceFor\(/, model: /\bawait send\(/ },
    { kind: "direct", channel: "the AI pipeline", file: "lib/ai/pipeline.ts", voice: /\bloadSenderVoiceBrief\(/, model: /\bgenerateAIResponse\(/ },
    { kind: "direct", channel: "the ISA / assistant cascade (inbound email, engagement, portal, widget, avatar)", file: "lib/ai-isa/brand-voice-prompt.ts", voice: /\bloadSenderVoiceBrief\(/, model: /\bparts\.join\(/ },
    { kind: "direct", channel: "ads", file: "lib/ads/ad-creator.ts", voice: /\bloadSenderVoiceBrief\(/, model: /\bgenerateTextRouted\(/ },
    { kind: "direct", channel: "social posts", file: "app/actions/social/generate-social-post.ts", voice: /\brenderSenderVoiceBrief\(/, model: /\bgenerateObject\(/ },
    { kind: "direct", channel: "the weekly podcast", file: "lib/podcast/auto-producer.ts", voice: /args\.voiceBrief/, model: /\bgenerateTextRouted\(/ },
    { kind: "direct", channel: "Managed-Agent kickoff (buyer / listing concierge, deal coordinator)", file: "lib/agents/brokerage-context.ts", voice: /\bloadSenderVoiceBrief\(/, model: /function renderBrokerageContextForKickoff\(/ },
    { kind: "engine", channel: "sequences (email / SMS steps)", file: "lib/campaign-sequences/render-step.ts", calls: 1 },
    { kind: "engine", channel: "lead-magnet landing + deliverable copy", file: "lib/marketing/lead-magnet-copy.ts", calls: 2 },
    { kind: "engine", channel: "avatar video hooks (director + A/B variants)", file: "lib/video/video-director.ts", calls: 2 },
    { kind: "shape", channel: "video scripts (every generator through the ONE gate)", file: "lib/video/script-compliance.ts", shape: /briefBlock,\s*\]/ },
    { kind: "shape", channel: "newsletters / blogs / podcast scripts (content creators ask the gate for the SENDER)", file: "lib/kernel/content-creators.ts", shape: /buildComplianceSystemBlocks\([^)]*\{\s*agentId:[^}]*agentUserId:/ },
    { kind: "shape", channel: "lead-magnet funnel (planner, checklist, video script)", file: "lib/lead-magnets/magnet-funnel.ts", shape: /\.\.\.\(ctx\.voiceBrief \? \[ctx\.voiceBrief, ""\] : \[\]\)/, useRaw: true },
    { kind: "shape", channel: "books (every manuscript prompt)", file: "lib/lead-magnets/book-creator.ts", shape: /p\.voice_brief \? `\$\{p\.voice_brief\}/, useRaw: true },
    { kind: "shape", channel: "client education lessons", file: "lib/education/client-education-authoring.ts", shape: /generateObjectRouted\(\s*\{[\s\S]{0,700}?opts\.voiceBrief/ },
  ]
  const ENGINE_CARRIES = /generatePersonaCopy\(\s*\{[\s\S]{0,2500}?\b(?:sender|senderVoice):/g
  const draftsFirst = (src: string, voice: RegExp, model: RegExp) => { const v = src.search(voice), m = src.search(model); return v < 0 || m < 0 || v > m }
  for (const r of ROSTER) {
    if (r.kind === "direct") {
      const src = tokens(r.file)
      check(`${r.channel}: ${r.file} puts the sender's voice in the prompt BEFORE its model call`, !draftsFirst(src, r.voice, r.model), `voice@${src.search(r.voice)} model@${src.search(r.model)}`)
    } else if (r.kind === "engine") {
      const n = (tokens(r.file).match(ENGINE_CARRIES) ?? []).length
      check(`${r.channel}: ${r.file} hands the copy engine the sender (${r.calls} call${r.calls === 1 ? "" : "s"}) — the engine composes the voice first`, n >= r.calls, `${n} of ${r.calls} calls carry sender/senderVoice`)
    } else {
      check(`${r.channel}: ${r.file} carries the brief into the writer's prompt`, r.shape.test(r.useRaw ? code(r.file) : tokens(r.file)))
    }
  }
  const FIXTURE_LATE = blankStrings("const { text } = await generateTextRouted({ prompt })\nconst brief = renderSenderVoiceBrief(await loadSenderVoiceBrief(db, scope))\nreturn `${brief}\\n${text}`\n")
  check("POSITIVE CONTROL: a generator that DRAFTS FIRST and voices later is caught by the direct finder", draftsFirst(FIXTURE_LATE, /\bloadSenderVoiceBrief\(/, /\bgenerateTextRouted\(/))
  check("POSITIVE CONTROL: a copy-engine call that carries no sender is caught by the engine finder (and one that does is counted)",
    (blankStrings("await generatePersonaCopy({ goal, facts, channel, persona }, fb)").match(ENGINE_CARRIES) ?? []).length === 0 && (blankStrings("await generatePersonaCopy({ goal, facts, channel, persona, sender: ref }, fb)").match(ENGINE_CARRIES) ?? []).length === 1)
  console.log("    report-only (not this lane's files — Outside-lane requests in the notes): lib/direct-mail/draft-copy.ts (151H) still reads brand_voice_profile.tone_examples privately — " + (/\.from\(\s*["']brand_voice_profile["']\s*\)/.test(tokens("lib/direct-mail/draft-copy.ts")) ? "PRIVATE READ PRESENT" : "no private read") + "; lib/market-reports/producer.ts (151G) — sender brief " + (/loadSenderVoiceBrief|renderSenderVoiceBrief/.test(tokens("lib/market-reports/producer.ts")) ? "wired" : "NOT wired"))

  // ══ §D ══════════════════════════════════════════════════════════════════════════════════════
  section("D · the final guard — disclosures verbatim or refused; the sender's own rules; accessibility; the approval gate")
  const EHO = "Equal Housing Opportunity. All information is deemed reliable but not guaranteed."
  const brand = { brandName: "Harbor & Pine Homes", tagline: "Neighbors first, numbers always", prohibitedWords: [], preferredWords: [] }
  const f1 = await finalizeForDistribution({ assetKind: "email_campaign", text: "Two homes on Alder sold this month; both closed in nine days.", tenantBrand: brand, disclosures: [EHO], voiceBrief: b1, audienceBrief: a1 })
  check("a required disclosure the draft lacked is appended EXACTLY as given (never paraphrased)", f1.disclosures.appended.length === 1 && f1.text.includes(EHO) && f1.disclosures.missing.length === 0)
  const ddb = memSupabase({ distribution_finals: [], notifications: [] }, { uuidIds: true })
  const staged = await stageDistributionFinal(ddb as never, { brokerageId: B1, assetTable: "email_campaigns", assetId: "55555555-5555-4555-8555-555555555555", final: f1, createdBy: U1, notifyUserId: U1, now: NOW })
  const paraphrased = await checkDistributionPublication(ddb as never, { brokerageId: B1, assetKind: "email_campaign", assetTable: "email_campaigns", assetId: "55555555-5555-4555-8555-555555555555", content: "Two homes on Alder sold this month; both closed in nine days. We follow fair housing law and believe our information is accurate.", approval: { approved: true, by: U1, at: NOW.toISOString() } })
  const kept = await checkDistributionPublication(ddb as never, { brokerageId: B1, assetKind: "email_campaign", assetTable: "email_campaigns", assetId: "55555555-5555-4555-8555-555555555555", content: `Two homes on Alder sold this month; both closed in nine days, reworded. ${EHO}`, approval: { approved: true, by: U1, at: NOW.toISOString() } })
  check("a PARAPHRASED disclosure is a MISSING disclosure — the publication is REFUSED, not accepted as 'close enough'; the exact text passes (control)",
    staged.ok && !paraphrased.ok && /required disclosure is missing/.test(paraphrased.reason) && kept.ok, JSON.stringify({ paraphrased, kept }))
  const unapproved = await checkDistributionPublication(ddb as never, { brokerageId: B1, assetKind: "email_campaign", assetTable: "email_campaigns", assetId: "55555555-5555-4555-8555-555555555555", content: f1.text, approval: { approved: false, by: null, at: null } })
  check("HUMAN APPROVAL REMAINS THE GATE: every final requires it and an unapproved piece is refused at the door", f1.requiresHumanApproval === true && !unapproved.ok && /not approved by a person/.test(unapproved.reason))
  const STOP = "Reply STOP to opt out; msg & data rates may apply."
  const f2 = await finalizeForDistribution({ assetKind: "email_campaign", text: "The open house runs noon to two.", tenantBrand: brand, verbatim: [STOP], voiceBrief: b1 })
  check("a required scripted opt-out rides `verbatim`: appended once, byte for byte, never scanned", f2.verbatim.appended.length === 1 && f2.text.includes(STOP) && f2.verbatim.missing.length === 0)
  const bFormal: SenderVoiceBrief = { ...b1, formality: "professional" }
  const f3 = await finalizeForDistribution({ assetKind: "email_campaign", text: "Hey! You're gonna love what the two homes on Alder did this month. Jane Rivera\nHarbor & Pine Homes · 555-0100", tenantBrand: brand, voiceBrief: bFormal })
  check("the sender's OWN formality setting is the rule the final is read against — a drift is NAMED (review note, not a hold)",
    f3.toneNotes.some((n) => /gonna/.test(n) && /sender's own formality/.test(n)) && f3.reviewNotes.some((n) => /gonna/.test(n)), JSON.stringify(f3.toneNotes))
  check("a DRAFTED signature is named: the ONE email assembler appends it (a duplicate, not a disclosure)", f3.toneNotes.some((n) => /assembler appends the sender's signature/.test(n)))
  const f4 = await finalizeForDistribution({ assetKind: "newsletter", html: "<p>THIS IS THE BIGGEST MONTH WE HAVE SEEN on Alder.</p><p><a href=\"https://x.test\">click here</a> to unsubscribe from these.</p>", tenantBrand: brand })
  check("ACCESSIBILITY is named: an all-caps run and bare link text; the drafted opt-out line is named too (the ONE assembler adds it)",
    f4.accessibility.some((n) => /all-caps/.test(n)) && f4.accessibility.some((n) => /link text "click here"/.test(n)) && f4.toneNotes.some((n) => /opt-out wording belongs to the ONE assembler/.test(n)), JSON.stringify({ a: f4.accessibility, t: f4.toneNotes }))
  const f5 = await finalizeForDistribution({ assetKind: "email_campaign", text: "Thinking of selling? Let's talk about options with less maintenance.", tenantBrand: brand, voiceBrief: b1, audienceBrief: a1 })
  check("a draft that answers 'less maintenance' with a SELLER SOLICITATION opener is caught by the ONE tell list (them-first enforced at the final too)", f5.readyForApproval === false && f5.campaignPhrases.some((p) => /Thinking of selling/i.test(p)))
  check("NEGATIVE CONTROL: a plain, specific, sentence-case draft in the sender's formality carries no tone or accessibility note", f1.toneNotes.length === 0 && f1.accessibility.length === 0 && f1.readyForApproval === true, JSON.stringify({ t: f1.toneNotes, a: f1.accessibility, b: f1.blockers }))

  // ══ §E ══════════════════════════════════════════════════════════════════════════════════════
  section("E · provenance — who asked, which tenant, which voice version, which sources, what approval status")
  const row = ddb.tables.distribution_finals[0]
  check("the staged final records created_by (users.id), brokerage_id (the tenant) and status (awaiting approval)", row?.created_by === U1 && row?.brokerage_id === B1 && row?.status === "awaiting_approval")
  check("…and findings.voice_source: the brief's version, its sources (evidence) and whether a writing sample existed",
    row?.findings?.voice_source?.version === b1.version && Array.isArray(row?.findings?.voice_source?.sources) && row.findings.voice_source.sources.includes("users.email_signature") && row.findings.voice_source.hasWritingSample === true, JSON.stringify(row?.findings?.voice_source))
  check("the same final's hash is what the door proves it sent (unchanged contract)", row?.content_sha256 === f1.sha256 && f1.voiceSource?.version === b1.version)
  const fNoBrief = await finalizeForDistribution({ assetKind: "blog_post", text: "Spring checklist for sellers in Riverbend.", tenantBrand: null })
  check("NEGATIVE CONTROL: a final produced without a brief records voice_source null (never a fabricated version)", fNoBrief.voiceSource === null)

  // ══ §F ══════════════════════════════════════════════════════════════════════════════════════
  section("F · ONE compiler, ONE reader (comment-stripped source)")
  const libFiles = walk("lib")
  const DEF = /export\s+async\s+function\s+loadSenderVoiceBrief\b/
  check("POSITIVE CONTROL: a planted twin definer is seen; the same text in a comment is not", DEF.test(stripComments("export async function loadSenderVoiceBrief(c) {}\n")) && !DEF.test(stripComments("// export async function loadSenderVoiceBrief(c) {}\n")))
  const definers = libFiles.filter((f) => DEF.test(code(f)))
  check("exactly ONE sender-voice brief compiler in lib/ — lib/kernel/brand-voice.ts (THE brand-voice reader, extended)", definers.length === 1 && definers[0] === "lib/kernel/brand-voice.ts", definers.join(", "))
  // The table-name finder reads COMMENT-STRIPPED source — never string-BLANKED source, where every literal is already
  // empty and the finder would pass on everything (the vacuous-pass shape CLAUDE.md §2 names).
  const BVP_READ = /\.from\(\s*["']brand_voice_profile["']\s*\)/
  check("POSITIVE CONTROL: the private-read finder sees a live read, ignores a tombstone, and is NOT run on string-blanked source (where it would see nothing)",
    BVP_READ.test(stripComments('await db.from("brand_voice_profile").select("tone")')) && !BVP_READ.test(stripComments('// .from("brand_voice_profile") — TOMBSTONE\n')) && !BVP_READ.test(blankStrings('await db.from("brand_voice_profile").select("tone")')))
  check("lib/ai/pipeline.ts no longer reads brand_voice_profile itself and its tombstone names the survivor", !BVP_READ.test(code("lib/ai/pipeline.ts")) && /SURVIVOR:\s*\n?\s*\*?\s*lib\/kernel\/brand-voice\.ts loadSenderVoiceBrief/.test(raw("lib/ai/pipeline.ts")))
  check("app/actions/social/generate-social-post.ts no longer reads brand_voice_profile itself and its tombstone names the survivor", !BVP_READ.test(code("app/actions/social/generate-social-post.ts")) && /SURVIVOR: lib\/kernel\/brand-voice\.ts loadSenderVoiceBrief/.test(raw("app/actions/social/generate-social-post.ts")))
  // THE RATCHET: every lib/ reader of brand_voice_profile as of 2026-11-09 (stripped source), with its reason. A NEW reader
  // is a fourth spelling of the one cascade and fails; a baseline reader that stops reading is reported as retired.
  const READER_BASELINE: Record<string, string> = {
    "lib/kernel/brand-voice.ts": "THE cascade reader (resolveBrandVoiceCore) + the sender-voice brief",
    "lib/ai-isa/brand-voice-prompt.ts": "the AI-agent cascade's own brokerage/agent rows (pre-existing; merges with ai_identity_profiles)",
    "lib/voice-distiller/per-agent-voice.ts": "the WRITER (distills tone_examples from the agent's published pieces)",
    "lib/branding/resolve-brand-context.ts": "the agent motto for the brand cascade (tagline only)",
    "lib/kernel/content-creators.ts": "the video project's reviewer context (brand_voice_context.tone beside the script — not a writer's voice read; the newsletter writer's private read was FOLDED onto loadSenderVoiceBrief by the integrator, wave 151)",
    "lib/services/content-generation.service.ts": "pre-existing (carried)",
    "lib/listings/listing-description-core.ts": "pre-existing (carried)",
    "lib/sphere-resonance/touchpoint-draft.ts": "pre-existing (carried)",
    "lib/platform/config-snapshots.ts": "settings snapshot / restore (not a writer's voice read)",
    "lib/onboarding/setup-readiness.ts": "readiness check (exists?), not a voice read",
    "lib/onboarding/critical-setup.ts": "readiness check (exists?), not a voice read",
    "lib/kernel/self-healing.ts": "self-healing probe, not a voice read",
    "lib/kernel/tenant-readiness.ts": "readiness check, not a voice read",
  }
  const readers = libFiles.filter((f) => BVP_READ.test(code(f)))
  const newReaders = readers.filter((f) => !(f in READER_BASELINE))
  const retired = Object.keys(READER_BASELINE).filter((f) => !readers.includes(f))
  console.log(`    brand_voice_profile readers in lib/ (stripped; denominator ${libFiles.length} files): ${readers.length} — ${readers.join(", ")}${retired.length ? `\n    retired since the baseline: ${retired.join(", ")}` : ""}`)
  check(`RATCHET: no NEW lib/ reader of brand_voice_profile beyond the ${Object.keys(READER_BASELINE).length} frozen on 2026-11-09 (a new one is a fourth spelling of the one cascade)`, newReaders.length === 0, newReaders.join(", "))
  check("the ONE cascade (resolveBrandVoiceCore) now reads the sender's examples and notes (tone_examples, writing_style_notes, custom_instructions, content_guidelines, brand_personality, style, target_audience)", /tone_examples, writing_style_notes, custom_instructions, content_guidelines, brand_personality, style, target_audience/.test(raw("lib/kernel/brand-voice.ts")))

  console.log("\n BLIND SPOTS: §A/§B run on the in-memory client (no RLS, no CHECK, no live rows) — the live tenant pins are asserted by test:tenant-config-reads and test:cross-office-rls; the writing-sample rule reads distribution_finals authored_by='human' — a human edit of a non-copy asset would count; §B's 'their words' filter is lexical on the fact's `source` (enrich/infer/model/predict/score) — a fact written from an unlabelled source reads as stated; §C's static roster is a census of NAMED generators (a new writer that calls the model with no voice token is caught only if it is added to the roster) and 'before' is source order, a proxy for runtime order; the direct-mail writer (lib/direct-mail/draft-copy.ts, lane 151H) and the market-report producer (lib/market-reports/producer.ts, lane 151G) are REPORTED, not asserted — Outside-lane requests carry the exact change; §D's accessibility notes are lexical (no reading-grade model); no live model, no live send, no reach measurement here (measured by hand: app/crm/page.tsx stays at 1300).")
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail === 0) console.log("✅ SENDER_VOICE_PASS — the sender's versioned voice brief and the person's own-words brief condition the first draft across every channel; disclosures verbatim or refused; human approval the gate; provenance recorded")
  else { console.log("❌ SENDER_VOICE_FAIL"); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
