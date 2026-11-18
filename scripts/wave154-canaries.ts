#!/usr/bin/env tsx
/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fixtures and fake clients, the repo's proof idiom */
/**
 * scripts/wave154-canaries.ts — `npx tsx --conditions=react-server scripts/wave154-canaries.ts`
 *                                (wave 154, lane 154F — batch-1 INTEGRATION canaries; key: test:wave154-canaries, chained LAST in `guard`)
 * ─────────────────────────────────────────────────────────────────────────────
 * DIRECTIVE 154F (lines 460–474): seven journeys, one per distinct input type. Batch 1 was built by six lanes in isolation
 * (154A1, 154A2, 154B, 154C, 154D, 154E), each proven against its own fakes. Each canary here composes the REAL exported code of
 * TWO OR MORE of those lanes (named in `lanes`) in ONE in-memory world, and carries BOTH halves of a measurement (CLAUDE.md §2):
 * the built behavior on a well-formed input AND the ADVERSE case refused / absent / counted, a named POSITIVE CONTROL and a
 * published BLIND SPOT.
 *
 * CROSS-LANE DEFECTS ARE THE OUTPUT, NOT A FAILURE. Where two lanes disagree (a vocabulary, a field name, a missing caller), the
 * canary MEASURES the rule the journey needs and records the disagreement as a `defect` (file:line, the smallest fix, the batch-2
 * owner). A canary with an observed defect prints PARTIAL; it does not turn the guard red, and it is not papered over: the
 * assertion is the RULE, never the waypoint — once the owner fixes the link the same check observes nothing and the row reads
 * COMPLETE (SIMULATED) with no edit here. The positive / adverse halves are what gate the guard.
 *
 * SIMULATED, NEVER LIVE: no provider, model, Exa, Zyte, ZenRows, Apify, Google, social channel or database is called. Providers
 * and the model are injected seams that COUNT their calls; `@/lib/supabase/service` and `server-only` are replaced by a module
 * hook (the os-planes-canaries idiom) so a module that builds its own service client meets the canary's world; the award RPC
 * (m484 / m968) is modelled in-process on the world's own tables. memSupabase has no CHECK / FK / RLS / trigger.
 *
 * REGISTRY: `WAVE154_CANARIES` is exported so lane 154L extends THIS file (append with `canary({...})`, same shape) and later
 * runners can reuse rows by import, the way wave153-canaries reuses wave150 / wave152.
 *
 * Measurement: code-token scans read STRIPPED source (scripts/strip-comments.ts) and are supporting checks only; no count or line
 * number is pinned; every absence assertion carries a positive control.
 */
import { readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { registerHooks } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = (...a) => globalThis.__W154.svc(...a)",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})
const G = globalThis as any
G.__W154 = { svc: () => { throw new Error("wave154-canaries: no world bound for createServiceClient") } }

const ROOT = process.cwd()
const raw = (p: string): string => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "")
/** Identifiers only — comments AND string contents blanked (a word inside prose is a mention, not wiring). */
const ident = (p: string): string => blankStrings(stripComments(raw(p)))
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const w = console.warn, e = console.error, l = console.log, i = console.info
  console.warn = () => {}; console.error = () => {}; console.log = () => {}; console.info = () => {}
  try { return await fn() } finally { console.warn = w; console.error = e; console.log = l; console.info = i }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A disagreement between two lanes, measured. `observed` is the RULE failing right now; false = the link holds. */
export interface CrossLaneDefect { id: string; observed: boolean; what: string; where: string; fix: string; owner: string; evidence?: unknown }
/** `partial`: a link of the journey this canary could NOT execute (named, not a defect) — the row reads PARTIAL while it stands. */
export interface Verdict154 { positive: boolean; negative: boolean; detail?: string; note?: string; defects?: CrossLaneDefect[]; partial?: string[] }
type Journey = 1 | 2 | 3 | 4 | 5 | 6 | 7
export interface Canary154 {
  id: string; journey: Journey; title: string
  /** Directive line(s) this journey answers. */
  directive: string
  /** The lanes whose REAL exported code is composed (a single-lane canary would be a lane proof, not an integration). */
  lanes: readonly string[]
  survivors: readonly string[]
  /** The lane proofs that drive the same survivors deeper — they run in the guard chain, not here. */
  proofs: readonly string[]
  adverse: string; positiveControl: string; blindSpot: string
  run: () => Promise<Verdict154>
}
const CANARIES: Canary154[] = []
/** Register a canary (lane 154L appends here with the same shape). */
const canary = (c: Canary154) => { CANARIES.push(c) }
const halves = (pos: Array<[string, boolean]>, neg: Array<[string, boolean]>) => ({ positive: pos.every(([, b]) => b), negative: neg.every(([, b]) => b), failing: [...pos, ...neg].filter(([, b]) => !b).map(([n]) => n) })
const verdictOf = (h: ReturnType<typeof halves>, detail: unknown, note: string, defects: CrossLaneDefect[] = [], partial: string[] = []): Verdict154 =>
  ({ positive: h.positive, negative: h.negative, detail: JSON.stringify({ failing: h.failing, detail }).slice(0, 2400), note, defects, partial })

const T1 = "b1540000-0000-4000-8000-000000000001", T2 = "b1540000-0000-4000-8000-000000000002"
const NOW = new Date("2026-11-18T15:00:00.000Z")
const DAY = 86_400_000
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString()
const DB_OPTS = { uuidIds: true, stampCreatedAt: true, unique: { raw_scraped_leads: [["idempotency_key"]], agent_action_ledger: [["idempotency_key"]] } } as const
const world = (seed: Record<string, Row[]>, opts: Record<string, unknown> = {}): MemClient => {
  const w = memSupabase(seed as never, { ...DB_OPTS, ...opts } as never)
  G.__W154.svc = () => w
  return w
}
/** Any field that could carry a person into a topic (the PERSON-KEY FINDER). */
const PERSON_KEY = /"(email|phone|contact_?id|contactId|lead_?id|first_?name|last_?name|full_?name|author|handle|user_?id|profile_?url)"\s*:|[A-Za-z0-9._%+-]+@[a-z0-9-]+\.[a-z]{2,}|\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/i
const PERSON_TABLES = ["raw_scraped_leads", "leads", "contacts", "lead_enrichment_queue", "raw_recruit_prospects"]
const personWrites = (w: MemClient) => w.writes.filter((x: any) => PERSON_TABLES.includes(x.table))

// The voice world — the tenant's sender settings read by THE loader (lib/kernel/brand-voice.ts loadSenderVoiceBrief).
const AG1 = "a1540000-0000-4000-8000-0000000000a1", U1 = "a1540000-0000-4000-8000-0000000000u1".replace("u1", "11")
const voiceSeed = (): Record<string, Row[]> => ({
  brokerages: [{ id: T1, name: "Gulf Breeze Homes", city: "Pensacola", state: "FL", plan_tier: "brokerage", status: "active" }],
  users: [{ id: U1, brokerage_id: T1, first_name: "Jordan", last_name: "Reyes", email_signature: "Jordan Reyes · Gulf Breeze Homes", team_id: null }],
  agents: [{ id: AG1, brokerage_id: T1, user_id: U1, team_id: null, bio: "Helps Pensacola families buy and sell", specializations: ["first-time buyers"], languages: ["English"], license_number: null, license_state: "FL" }],
  brand_voice_profile: [], teams: [], brokerage_brand_settings: [], ai_identity_profiles: [], farm_territories: [], distribution_finals: [],
})
async function senderVoiceText(w: MemClient): Promise<{ text: string; brief: any }> {
  const { loadSenderVoiceBrief, renderSenderVoiceBrief } = await import("../lib/kernel/brand-voice")
  const brief = await loadSenderVoiceBrief(w as never, { brokerageId: T1, agentUserId: U1, agentId: AG1 }, { cache: false, now: NOW })
  return { text: renderSenderVoiceBrief(brief), brief }
}

// ═════════════════════════════════════════════════════════════════════════════
// JOURNEY 1 — an authorized public housing request → … → Contact only when qualified → assigned agent
// ═════════════════════════════════════════════════════════════════════════════
canary({
  id: "J1", journey: 1, directive: "line 465",
  title: "A first-person public housing request becomes ONE Raw Lead through the pre-pull dedup; a held Contact is answered, never re-purchased; a Contact exists only once the AI ISA qualified and an agent is assigned",
  lanes: ["154B", "153N", "kernel ingest (lib/kernel/scraping.ts)", "lead promotion gates"],
  survivors: [
    "lib/acquisition-plays/public-request.ts runPublicRequestPlay (154B statement-keyed person record)",
    "lib/lead-pipeline/pre-pull-dedup.ts loadKnownAcquisitionKeys + planPrePullDedup (the production default, not injected)",
    "lib/kernel/scraping.ts ingestRawSourceBatch (THE RawData producer, on the world client)",
    "lib/lead-pipeline/canonical-lead-eligibility.ts evaluateCanonicalLeadEligibility (the Lead gate)",
    "lib/ai-isa/qualification-core.ts deriveQualificationSignals / signalScore (the AI ISA readiness)",
    "lib/lead-assignment/rule-matcher.ts evaluateAssignmentEligibility · lib/contact-promotion/promotion-eligibility.ts validatePromotionEligibility",
  ],
  proofs: ["test:google-intelligence §B", "test:acquisition-door", "test:online-hunting", "test:conversion-finality"],
  adverse: "the same statement re-found under a mirror URL collapses to one person; a person whose published email is already a Lead is held before RawData; a published email that is already a Contact goes to the arbiter with ZERO RawData writes; a replay files nothing new; an anonymous forum question never becomes a person; an unqualified Lead is refused Contact promotion",
  positiveControl: "the fresh first-person FSBO with a published email IS written as subject 'person' with its statement key, quote and expiry",
  blindSpot: "processRawRecord / promoteRawRecordToLead / promoteLeadToContactService build their own service client and run enrichment — their pure gates are composed here, the orchestration is test:lead-door / test:conversion-finality; the arbiter door (respondToLifeChangeSignal) is a counting seam; the Exa hunt is not called (results injected)",
  run: async () => {
    const request = await import("../lib/acquisition-plays/public-request")
    const hunting = await import("../lib/providers/exa/hunting")
    const { evaluateCanonicalLeadEligibility } = await import("../lib/lead-pipeline/canonical-lead-eligibility")
    const { deriveQualificationSignals, signalScore } = await import("../lib/ai-isa/qualification-core")
    const { evaluateAssignmentEligibility } = await import("../lib/lead-assignment/rule-matcher")
    const { validatePromotionEligibility } = await import("../lib/contact-promotion/promotion-eligibility")
    const MARKET = "c1540000-0000-4000-8000-0000000000m1".replace("m1", "01")
    const market = { id: MARKET, brokerage_id: T1, name: "Pensacola", city: "Pensacola", state: "FL", zip_codes: ["32501", "32502"], counties: ["Escambia"], agent_id: AG1 }
    const marketRow = { ...market, is_active: true, enabled_sources: ["exa"], monthly_budget_usd: 100, spend_this_month: 0, max_records_per_run: 100, priority: 1, last_scraped_at: null }
    const HELD_CONTACT = "c1540000-0000-4000-8000-0000000000c1"
    const w = world({
      raw_scraped_leads: [], scraper_executions: [], lifecycle_events: [], lead_scraping_markets: [marketRow], manager_signals: [], lead_deduplication_log: [], lead_enrichment_queue: [],
      leads: [{ id: "l-held", brokerage_id: T1, email: "already.lead@example.org", phone: null, enrichment_profile: null, last_enriched_at: null }],
      contacts: [{ id: HELD_CONTACT, contact_id: "c2-secondary", brokerage_id: T1, email: "held.contact@example.org", phone: null, deleted_at: null }],
    })
    const page = (o: Record<string, unknown>) => hunting.normalizeExaHuntRow({ id: "r-" + String(o.id), url: null, title: null, text: null, author: null, publishedDate: null, highlights: null, summary: null, score: 0.8, ...o })
    const words = (email: string) => `We are selling our house by owner in East Hill this spring. Email me at ${email} if interested.`
    const fresh = page({ id: "f1", url: "https://www.reddit.com/r/Pensacola/comments/f1/fsbo/", title: "Selling our house", author: "eastHillOwner", publishedDate: daysAgo(3), text: words("owner.seller@example.com"), highlights: ["We are selling our house by owner in East Hill this spring."] })
    const mirror = { ...page({ id: "f1m", url: "https://old.reddit.com/r/Pensacola/comments/f1/fsbo/", title: "Selling our house", author: "eastHillOwner", publishedDate: daysAgo(9), text: words("owner.seller@example.com"), highlights: ["We are selling our house by owner in East Hill this spring."] }) }
    const heldLead = page({ id: "f2", url: "https://www.reddit.com/r/Pensacola/comments/f2/", title: "Selling", author: "seller2", publishedDate: daysAgo(4), text: words("already.lead@example.org"), highlights: ["We are selling our house by owner in East Hill this spring."] })
    const heldContact = page({ id: "f3", url: "https://www.reddit.com/r/Pensacola/comments/f3/", title: "Selling", author: "seller3", publishedDate: daysAgo(5), text: words("held.contact@example.org"), highlights: ["We are selling our house by owner in East Hill this spring."] })
    const anon = page({ id: "q1", url: "https://www.reddit.com/r/Pensacola/comments/q1/", title: "Question", author: "curious850", publishedDate: daysAgo(2), text: "Is it a good time to sell a house in Pensacola? What do closing costs look like?", highlights: ["Is it a good time to sell a house in Pensacola?"] })
    let responded = 0
    const respond = (async () => { responded++; return { action: "noted", reason: "counting seam" } }) as never
    const run = (results: unknown[]) => quiet(() => request.runPublicRequestPlay(w as never, { market: market as never, hunt: null, results: results as never, now: NOW }, { respond }))
    const writesBefore = w.writes.length
    const r1 = await run([fresh, mirror, heldLead, heldContact, anon])
    const persons = (w.tables.raw_scraped_leads as Row[]).filter((x) => x.subject_kind === "person")
    const anonRows = (w.tables.raw_scraped_leads as Row[]).filter((x) => x.subject_kind !== "person")
    const person = persons[0] ?? {}
    const ev = (person.evidence ?? person.normalized_preview?.rawdata?.evidence ?? {}) as Row
    const contactWrites = w.writes.slice(writesBefore).filter((x: any) => x.table === "contacts")
    const rawCountAfter1 = (w.tables.raw_scraped_leads as Row[]).length
    const r2 = await run([fresh])
    const rawCountAfter2 = (w.tables.raw_scraped_leads as Row[]).length
    // The Lead gate on the row THE ingest wrote (not on a fixture) — and on the anonymous row.
    const gateRaw = evaluateCanonicalLeadEligibility({ subject_kind: person.subject_kind, email: person.email, phone: person.phone, first_name: person.first_name ?? null, last_name: person.last_name ?? null })
    const gateEnriched = evaluateCanonicalLeadEligibility({ subject_kind: person.subject_kind, email: person.email, phone: person.phone, first_name: "Casey", last_name: "Morgan" })
    const gateAnon = evaluateCanonicalLeadEligibility({ subject_kind: anonRows[0]?.subject_kind ?? "anonymous_question", email: null, first_name: null, last_name: null })
    // The AI ISA works the Lead: readiness → qualified → assignable → convertible (to the territory's agent).
    const sig = deriveQualificationSignals({ messageText: "Yes we are ready to list soon — can we schedule a time to meet this week?", conversationCount: 2, timeline: "1-3_months", leadScore: signalScore("hot") })
    const lead = { lead_stage: sig.readinessForAgent ? "qualified" : "new", agent_id: market.agent_id, is_active: true, email: person.email, phone: person.phone, first_name: "Casey", last_name: "Morgan" }
    const assign = evaluateAssignmentEligibility(lead.lead_stage, null)
    const promote = await validatePromotionEligibility(lead)
    const coldSig = deriveQualificationSignals({ messageText: "just browsing", conversationCount: 0, leadScore: signalScore("cold") })
    const unqualified = await validatePromotionEligibility({ ...lead, lead_stage: coldSig.readinessForAgent ? "qualified" : "new" })
    const noAgent = await validatePromotionEligibility({ ...lead, agent_id: null })
    const h = halves([
      ["POSITIVE CONTROL · the fresh first-person FSBO is written ONCE as subject 'person' with the 154B statement key, quote and expiry", persons.length === 1 && String(person.source_record_id ?? "").startsWith("exa-stmt-") && /selling our house by owner/i.test(String(ev.quote ?? "")) && typeof ev.evidence_expires_at === "string"],
      ["the RawData row is the tenant's (brokerage_id from the market, never a body field)", person.brokerage_id === T1],
      ["the Lead gate holds the Raw Lead until enrichment supplies a real name (failing 'name' — an email alone is not a Lead), and admits it once named", !gateRaw.eligible && (gateRaw as any).failing === "name" && gateEnriched.eligible],
      ["the AI ISA readiness qualifies the engaged Lead; qualified → assignable → convertible to the assigned territory agent", sig.readinessForAgent && assign.ok && assign.via === "qualified" && promote.isEligible],
    ], [
      ["ADVERSE · the mirror (older indexed copy) collapses into the same person — one Raw Lead, the older URL named", persons.length === 1 && (r1.refused ?? []).some((x: any) => /older indexed copy/.test(x.why))],
      ["ADVERSE · a published email already held as a Lead is HELD by the production pre-pull dedup before RawData (no second paid pull)", !persons.some((p) => p.email === "already.lead@example.org") && (r1.refused ?? []).some((x: any) => /duplicate held before a paid pull/.test(x.why))],
      ["ADVERSE · a published email already held as a Contact goes to the arbiter (1 call), writes NO RawData for it and NO contacts row", responded === 1 && !persons.some((p) => p.email === "held.contact@example.org") && contactWrites.length === 0],
      ["ADVERSE · the anonymous forum question is never a person (no email on its row) and the gate refuses its subject", anonRows.every((x) => !x.email) && !gateAnon.eligible && (gateAnon as any).failing === "subject"],
      ["ADVERSE · a rediscovery of the same statement files nothing new — held by the production pre-pull dedup (or replayed by ingest), one row", rawCountAfter2 === rawCountAfter1 && ((r2.refused ?? []).some((x: any) => /duplicate held before a paid pull/.test(x.why)) || (r2.actions ?? []).some((a: any) => a.kind === "ingest_person" && a.detail?.replayed === 1))],
      ["ADVERSE · an unqualified Lead, or one with no assigned agent, is refused Contact promotion", !unqualified.isEligible && !noAgent.isEligible],
    ])
    return verdictOf(h, { persons: persons.length, anon: anonRows.length, responded, refused: (r1.refused ?? []).map((x: any) => x.why).slice(0, 6), gateRaw, sig, r2: { actions: r2.actions, refused: r2.refused } }, `raw rows ${rawCountAfter1} (1 person + ${anonRows.length} non-person); arbiter calls ${responded}; Contact rows written 0`)
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// JOURNEY 2 — an aggregate Google Trends result → ONE localized topic (REAL intake) → a first draft in the agent's voice
// ═════════════════════════════════════════════════════════════════════════════
canary({
  id: "J2", journey: 2, directive: "line 466",
  title: "A Trends point lands as ONE localized topic through the REAL intake with ZERO person records; the relative index never becomes a count; the topic briefs a first draft that leads with the agent's voice",
  lanes: ["154B", "154C", "154D"],
  survivors: [
    "lib/content-intel/search-demand.ts runSearchDemandScan + productionTopicIntake (the integrator's wiring to 154C, not a fake)",
    "lib/content-intel/topic-intake.ts intakeTopicIdeas (THE one producer into content_topic_bank)",
    "lib/content-intel/search-demand-volume.ts displaySearchVolume",
    "lib/content-intel/topic-bank.ts pickTopics (the pool reader every writer uses)",
    "lib/repurpose/refurbish-idea.ts refurbishTriggerVerdict('google_trend') / buildRefurbishIdeaBrief · lib/repurpose/refurbish-run.ts draftRefurbishOutput",
    "lib/kernel/brand-voice.ts loadSenderVoiceBrief + renderSenderVoiceBrief",
  ],
  proofs: ["test:google-intelligence §A", "test:public-chatter-topics", "test:refurbish-original", "test:sender-voice"],
  adverse: "a second scan of the same trend merges (one row); an unlocated trend is no topic; a relative index renders as 'interest index N/100 (relative)' and never as searches; no column holds the index as a score",
  positiveControl: "the person-key finder sees a planted email; a canonical-shape geo row IS boosted by pickTopics for the same recipient",
  blindSpot: "the model is a counting seam that returns a fixed draft; the Trends transport is a fake (Trends stays OWNER-HELD); the step from a stored topic row to a refurbish run has no production caller (see defects) — it is composed by the canary",
  run: async () => {
    const sd = await import("../lib/content-intel/search-demand")
    const vol = await import("../lib/content-intel/search-demand-volume")
    const { pickTopics } = await import("../lib/content-intel/topic-bank")
    const ri = await import("../lib/repurpose/refurbish-idea")
    const rr = await import("../lib/repurpose/refurbish-run")
    const w = world({ ...voiceSeed(), content_topic_sources: [], content_topic_bank: [], buyer_criteria_utterances: [], keyword_intelligence: [], raw_scraped_leads: [], leads: [], contacts: [] })
    let trendCalls = 0
    const trends = { provider: "fake-trends", rights: "licensed" as const, fetchRegional: async () => { trendCalls++; return { ok: true as const, points: [
      { term: "homes with acreage", geo: { city: "Pensacola", state: "FL" }, relativeIndex: 64, windowStart: daysAgo(90), windowEnd: daysAgo(1), risingPct: 140 },
      { term: "flood insurance", geo: {}, relativeIndex: 80, windowStart: daysAgo(90), windowEnd: daysAgo(1) },
    ] } } }
    if (!sd.productionTopicIntake) throw new Error("productionTopicIntake is null — the integrator wiring is gone")
    const scan = await quiet(() => sd.runSearchDemandScan(w as never, { brokerageId: T1, now: NOW, geo: { city: "Pensacola", state: "FL" } }, { intake: sd.productionTopicIntake, trends }))
    const bank = w.tables.content_topic_bank as Row[]
    const row = bank[0] ?? {}
    const trendCallsFirst = trendCalls
    const scan2 = await quiet(() => sd.runSearchDemandScan(w as never, { brokerageId: T1, now: new Date(NOW.getTime() + 3_600_000), geo: { city: "Pensacola", state: "FL" } }, { intake: sd.productionTopicIntake, trends }))
    const shown = vol.displaySearchVolume("google_trends", row.raw_data?.evidence?.value ?? null)
    // The pool reader every writer uses — for a Pensacola recipient.
    const picked = await quiet(() => pickTopics({ brokerageId: T1, limit: 5, recipientLocation: { city: "Pensacola", state: "FL" }, client: w as never }))
    const pickedTrend = picked.find((t) => t.id === row.id)
    // Positive control for the geo reader: a row in the shape every OTHER pool writer uses (local-intel.ts, brand-listening.ts).
    const ctrl = memSupabase({ content_topic_bank: [{ id: "ctrl", brokerage_id: T1, topic_title: "control", status: "fresh", expires_at: new Date(NOW.getTime() + 30 * DAY).toISOString(), engagement_score: 0, performance_score: 0, categories: [], geo_relevance: { cities: ["Pensacola"], states: ["FL"], zip_codes: [] } }] } as never)
    const ctrlPick = await quiet(() => pickTopics({ brokerageId: T1, limit: 5, recipientLocation: { city: "Pensacola", state: "FL" }, client: ctrl as never }))
    // The topic → a refurbish brief → the FIRST draft, composed with the agent's real voice brief.
    const trig = ri.refurbishTriggerVerdict({ kind: "google_trend" })
    const brief = ri.buildRefurbishIdeaBrief({ exclude: rr.refurbishExcludeDefault }, {
      source: { kind: "google_trend", url: null, platform: null, contentType: null, untrustedText: null, topics: ["homes with acreage"], hookType: "question", geoLabel: row.geo_relevance?.label ?? "Pensacola, FL" },
      evidence: { kind: "proxy", tier: "promising_frequently_surfaced", label: `relative search interest ${row.raw_data?.evidence?.value}/100 (relative, not a count)` } as never,
      rights: (trig.rights ?? "idea_only") as never, audience: { label: null }, localFacts: [], ownAssets: [], availableFormats: ["blog"],
    })
    const voice = await senderVoiceText(w)
    let generated = 0
    const draft = brief.ok ? await rr.draftRefurbishOutput({ generate: async () => { generated++; return "Thinking about a home with a little land around Pensacola? Here is what to check first: zoning, flood zone, septic and well, and what the lot costs to keep up." } }, {
      mode: "idea_only", format: "blog", voiceBriefText: voice.text, themFirstText: "", brief: brief.brief, reusableSourceText: null, sourceLabel: "Google Trends topic", untrustedSourceText: null,
    }) : null
    const prompt = draft?.prompt ?? ""
    const defects: CrossLaneDefect[] = []
    const geoMismatch = !!pickedTrend && pickedTrend.geo_match === false && ctrlPick[0]?.geo_match === true
    defects.push({
      id: "D1-geo-shape", observed: geoMismatch,
      what: "the intake writes geo_relevance in the TopicIdea shape {city, state, zip, label}; the pool reader pickTopics (and every other pool writer) uses {cities[], states[], zip_codes[]} — so a topic stored through the ONE intake is never geo-matched and loses the +20 local boost in every newsletter / social / podcast / video picker",
      where: "lib/content-intel/topic-intake.ts:415 (`geo_relevance: p.idea.geo ?? null`) vs lib/content-intel/topic-bank.ts:295-304 matchesGeo; same shape as local-intel.ts:501, brand-listening.ts:752, app/actions/content-intel/sources.ts:59",
      fix: "topic-intake.ts:415 → `geo_relevance: p.idea.geo ? { cities: p.idea.geo.city ? [p.idea.geo.city] : [], states: p.idea.geo.state ? [p.idea.geo.state] : [], zip_codes: p.idea.geo.zip ? [p.idea.geo.zip] : [], label: p.idea.geo.label ?? null } : null` (one line; label rides along, readers ignore it)",
      owner: "G1 (lib/content-intel/**)", evidence: { stored: row.geo_relevance, intakeRowGeoMatch: pickedTrend?.geo_match, controlGeoMatch: ctrlPick[0]?.geo_match },
    })
    // MEASURED on the stored row: the pool's own sourceKind, offered to refurbish's trigger (directly, or through a mapper
    // once one is exported), must start a run. Supporting only: whether any repurpose module names the pool vocabulary.
    const poolKind = String(row.raw_data?.intake?.source_kind ?? "")
    const mapper = (ri as any).refurbishTriggerKindForTopicSource as ((k: string) => string | null) | undefined
    const offered = ri.refurbishTriggerVerdict({ kind: (mapper?.(poolKind) ?? poolKind) as never })
    const namesPoolVocabulary = /search_demand_trends|SEARCH_DEMAND_SOURCE_KINDS/.test(ident("lib/repurpose/refurbish-idea.ts") + ident("lib/repurpose/actions.ts") + ident("lib/repurpose/refurbish-run.ts"))
    defects.push({
      id: "D2-topic-to-refurbish", observed: !offered.start,
      what: "a stored trend topic has no production path into the refurbish draft: refurbishTriggerVerdict knows 'google_trend' / 'public_chatter', the pool rows carry sourceKind 'search_demand_trends' / 'community_post' / 'facebook_group_question', and nothing maps one vocabulary onto the other or calls the trigger for a pool row (the only callers are the competitor-watch and pasted-transcript doors) — the first draft in the agent's voice is reachable only by a person",
      where: "lib/repurpose/refurbish-idea.ts:418 refurbishTriggerVerdict (kinds google_trend / public_chatter) vs lib/content-intel/search-demand.ts:69 SEARCH_DEMAND_SOURCE_KINDS and lib/content-intel/public-chatter-topics.ts:184/304; callers only lib/repurpose/actions.ts:161/203",
      fix: "add `refurbishTriggerKindForTopicSource(sourceKind)` beside refurbishTriggerVerdict (search_demand_* → google_trend; community_post | facebook_group_question | meta_ad_creative → public_chatter) and call it from the sessionless refurbish starter (D outside 5) for fresh pool rows",
      owner: "H (lib/repurpose/**; the sessionless starter) with G1 naming the pool's sourceKind vocabulary", evidence: { poolKind, mapperExported: !!mapper, offered, supportingScanNamesPoolVocabulary: namesPoolVocabulary },
    })
    const ideas = scan.producers.flatMap((p: any) => p.ideas)
    const h = halves([
      ["POSITIVE CONTROL · the person-key finder sees a planted email", PERSON_KEY.test("reach me at jo@example.com")],
      ["one transport call; ONE localized topic stored through the REAL intake (status stored, inserted 1), tenant-pinned", trendCallsFirst === 1 && scan.intakeStatus === "stored" && (scan.intake as any)?.inserted === 1 && bank.length === 1 && row.brokerage_id === T1 && /Pensacola/.test(String(row.topic_title))],
      ["the stored topic keeps its RELATIVE evidence (proxy, relative_index_0_100, 64) and the ONE display classifier shows it as a relative index, never a search count", row.raw_data?.evidence?.kind === "proxy" && row.raw_data?.evidence?.unit === "relative_index_0_100" && row.raw_data?.evidence?.value === 64 && shown.relativeIndex === 64 && shown.searchCount === null && shown.basis.kind === "relative_index"],
      ["the trend may start a refurbish (idea_only) and briefs a consumer question for Pensacola", trig.start && trig.rights === "idea_only" && brief.ok && /Pensacola/.test((brief as any).brief?.consumerQuestion ?? "")],
      ["the FIRST draft's prompt LEADS with the agent's voice brief (the real loader: Jordan Reyes) and the model was asked once", prompt.startsWith("SENDER VOICE BRIEF") && /Jordan Reyes/.test(prompt.slice(0, 600)) && generated === 1 && !!draft?.ok],
    ], [
      ["ADVERSE · ZERO person records: personRecords 0, no person-table write, no person key on any stored byte", scan.personRecords === 0 && personWrites(w).length === 0 && !PERSON_KEY.test(JSON.stringify(bank))],
      ["ADVERSE · the relative index never becomes a count: searchCount null, no engagement_score written from it", shown.searchCount === null && (row.engagement_score === undefined || row.engagement_score === null)],
      ["ADVERSE · the unlocated trend point is NOT a topic", !ideas.some((i: any) => /flood insurance/i.test(i.title))],
      ["ADVERSE · a second scan of the same trend MERGES into the one row (no duplicate topic)", bank.length === 1 && (scan2.intake as any)?.merged === 1],
    ])
    return verdictOf(h, { scan: scan.intakeStatus, intake: scan.intake, row: { title: row.topic_title, geo: row.geo_relevance, ev: row.raw_data?.evidence, score: row.engagement_score }, shown, scan2: scan2.intake, promptHead: prompt.slice(0, 160) }, `topics stored ${bank.length}; person writes ${personWrites(w).length}; model calls ${generated}`, defects)
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// JOURNEY 3 — competitor content → an original piece
// ═════════════════════════════════════════════════════════════════════════════
canary({
  id: "J3", journey: 3, directive: "line 467",
  title: "Refurbish asks 154C's exclusion gate FIRST: a joining announcement is refused before any model call; a consumer question is briefed; a synonym rewrite fails the originality gate; the draft carries the sender's voice; 'published' needs the channel's own id",
  lanes: ["154C", "154D", "153 publish cron"],
  survivors: [
    "lib/repurpose/refurbish-run.ts refurbishExcludeDefault (→ 154C classifyTopicExclusion, the integrator's wiring)",
    "lib/repurpose/refurbish-idea.ts refurbishTriggerVerdict / buildRefurbishIdeaBrief / assessOriginality / carriesSourceMedia / refurbishPublicationVerdict / refurbishRetestDecision",
    "lib/repurpose/refurbish-run.ts draftRefurbishOutput",
    "lib/kernel/brand-voice.ts loadSenderVoiceBrief + renderSenderVoiceBrief",
  ],
  proofs: ["test:refurbish-original", "test:public-chatter-topics §A", "test:marketing-loops", "test:sender-voice"],
  adverse: "an agent-joining announcement with 90k displayed reactions is refused (competitor_agent_joining) with ZERO model calls; a competitor not on the watchlist starts nothing; a synonym rewrite is near_copy and nothing is posted; a post marked published without the provider id is NOT published",
  positiveControl: "an independently written answer to the same consumer question passes the originality gate; a published row WITH an external id counts",
  blindSpot: "refurbishCompetitorIdea / executePipeline are session 'use server' doors (test:refurbish-original drives them); the omnipresence planner and scheduleSocialPost are not run here; engagement is not read (no platform auth — counts stay NULL)",
  run: async () => {
    const ri = await import("../lib/repurpose/refurbish-idea")
    const rr = await import("../lib/repurpose/refurbish-run")
    const { classifyTopicExclusion } = await import("../lib/content-intel/topic-intake")
    const w = world({ ...voiceSeed() })
    let excludeCalls = 0, generated = 0
    const exclude = (i: any) => { excludeCalls++; return rr.refurbishExcludeDefault(i) }
    const ev = (n: number) => ri.labelCompetitorEvidence({ evidence: { kind: "proxy", metric: "search_index_rank", value: n, unit: "rank_0_100" } } as never)
    const src = (text: string) => ({ kind: "competitor_post" as const, url: "https://www.instagram.com/p/xyz/", platform: "instagram", contentType: "social_post", untrustedText: text, topics: ["homeowners insurance", "renewal"], hookType: "question", geoLabel: "Pensacola, FL" })
    const base = { rights: "idea_only" as never, audience: { label: null }, localFacts: [], ownAssets: [], availableFormats: ["blog", "carousel"] }
    const watched = ri.refurbishTriggerVerdict({ kind: "competitor_watch", authorized: true })
    const unwatched = ri.refurbishTriggerVerdict({ kind: "competitor_watch", authorized: false })
    const joining = "Please welcome our newest agent, Alex Kim, to the Bayside Realty family! We're thrilled to have Alex join our team."
    const joinBrief = ri.buildRefurbishIdeaBrief({ exclude }, { ...base, source: src(joining), evidence: ev(95) })
    const callsAfterJoin = excludeCalls, generatedAfterJoin = generated
    const question = "Is your homeowners insurance premium about to jump at renewal? Here are the questions to ask your insurer before you sign, and why older roofs and flood zones change the price you pay."
    const qBrief = ri.buildRefurbishIdeaBrief({ exclude }, { ...base, source: src(question), evidence: ev(70) })
    const voice = await senderVoiceText(w)
    const compose = (draftText: string) => rr.draftRefurbishOutput({ generate: async () => { generated++; return draftText } }, {
      mode: "idea_only", format: "carousel", voiceBriefText: voice.text, themFirstText: "", brief: qBrief.ok ? qBrief.brief : null, reusableSourceText: null, sourceLabel: "competitor post (idea only)", untrustedSourceText: question,
    })
    const synonym = await compose("Is your home insurance premium going to jump at renewal? Here are the questions to put to your insurer before you sign, and why older roofs and flood zones change the cost you pay.")
    const original = await compose("Renewal letter arrive with a bigger number? Three things move a Pensacola premium most: the age of your roof, your flood zone, and the deductible you choose. Ask your agent which one you can change this year.")
    const sameGate = classifyTopicExclusion({ title: joining.slice(0, 200), text: joining, sourceKind: "competitor_post" }).reason
    const pubNone = ri.refurbishPublicationVerdict({ status: "published", external_post_id: null })
    const pubYes = ri.refurbishPublicationVerdict({ status: "published", external_post_id: "17890000000000001" })
    const retest = ri.refurbishRetestDecision({ publication: pubYes, measuredRate: null, baselineRate: 0.02 })
    const media = ri.carriesSourceMedia(["https://cdn.example.test/own/hero.jpg"], { url: "https://www.instagram.com/p/xyz/", mediaUrl: "https://scontent.cdninstagram.com/v/abc.jpg" })
    const mediaCopied = ri.carriesSourceMedia(["https://scontent.cdninstagram.com/v/abc.jpg"], { url: "https://www.instagram.com/p/xyz/", mediaUrl: "https://scontent.cdninstagram.com/v/abc.jpg" })
    const actions = ident("lib/repurpose/actions.ts")
    const h = halves([
      ["an authorized watchlist competitor may start an idea-only refurbish", watched.start && watched.rights === "idea_only"],
      ["a real consumer question is BRIEFED (a reworded question, not the source's words)", qBrief.ok && !String((qBrief as any).brief?.consumerQuestion ?? "").includes("about to jump")],
      ["POSITIVE CONTROL · an independently written answer passes the originality gate and is a draft", original.ok && (original as any).originality?.verdict === "original"],
      ["the draft prompt LEADS with the sender's voice (real loader) and never carries the competitor's wording (idea_only)", original.prompt.startsWith("SENDER VOICE BRIEF") && /Jordan Reyes/.test(original.prompt.slice(0, 600)) && !original.prompt.includes("about to jump at renewal")],
      ["POSITIVE CONTROL · a published row WITH the channel's id counts as published (and is not a win until measured)", pubYes.published && retest.decision === "awaiting_measurement"],
      ["the production door wires the same gate (supporting, stripped source: actions.ts passes refurbishExcludeDefault into the brief)", /exclude\s*:\s*refurbishExcludeDefault/.test(actions)],
    ], [
      ["ADVERSE · the joining announcement is refused by 154C's reason (competitor_agent_joining) despite a high proxy, asked FIRST, before any model call", !joinBrief.ok && (joinBrief as any).reason === "competitor_agent_joining" && callsAfterJoin === 1 && generatedAfterJoin === 0 && /joining/i.test((joinBrief as any).userMessage)],
      ["ADVERSE · the gate D asks is C's gate: 154C's classifier on the same text gives the reason Refurbish refused with", sameGate === "competitor_agent_joining" && sameGate === (joinBrief as any).reason],
      ["ADVERSE · a competitor NOT on the watchlist starts nothing", !unwatched.start],
      ["ADVERSE · a synonym rewrite FAILS the originality gate (near_copy) — nothing to post", !synonym.ok && (synonym as any).reason === "near_copy"],
      ["ADVERSE · 'published' with no channel id is NOT published; competitor media on the draft is detected", !pubNone.published && pubNone.state === "awaiting_provider" && !media && mediaCopied],
    ])
    return verdictOf(h, { joinBrief, synonym: (synonym as any).originality, original: (original as any).originality, pubNone, pubYes }, `exclude asked ${excludeCalls}×; model calls ${generated} (0 for the refused post)`)
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// JOURNEY 4 — public community discussion → a reworded topic, no phantom people
// ═════════════════════════════════════════════════════════════════════════════
canary({
  id: "J4", journey: 4, directive: "line 468 (owner ruling R1 / R2 / R3)",
  title: "A Nextdoor public post goes through the topic purpose and stores no wording, author or contact; the Nextdoor PERSON path makes zero transport calls; a Facebook group question and a Meta ad creative yield topics and zero RawData / Raw Lead / Contact writes",
  lanes: ["154C", "153N (checkpointed transport)", "154B (the statement classifier it needs)"],
  survivors: [
    "lib/content-intel/public-chatter-topics.ts researchCommunityPostTopics / normalizeFacebookGroupItems / normalizeMetaAdItems",
    "lib/providers/scrape-checkpoint.ts fetchCheckpointedSnapshot (COMMUNITY_TOPIC_RESEARCH_PURPOSE vs the person purposes)",
    "lib/content-intel/topic-intake.ts intakeTopicIdeas (production default — no intake injected)",
  ],
  proofs: ["test:public-chatter-topics", "test:scrapers", "test:online-hunting"],
  adverse: "the same Nextdoor URL under the person purpose (real_estate_need_chatter) with no agreement is held_terms with ZERO fetches; a brand-slogan group post and a new-hire ad are excluded; no person-table write happens on any path",
  positiveControl: "the topic purpose DID fetch once on the same counting transport (the person path's 0 is not a dead fetcher); the PII finder sees the planted email / phone in the source text",
  blindSpot: "the transport, robots and store are seams; the rewording is rule-derived (no model wired); Facebook / Ad Library sources stay inactive in production until rights + an Apify key exist (normalizers driven directly); no cron schedules Nextdoor topic research yet (154C partial a)",
  run: async () => {
    const pc = await import("../lib/content-intel/public-chatter-topics")
    const ck = await import("../lib/providers/scrape-checkpoint")
    const { intakeTopicIdeas } = await import("../lib/content-intel/topic-intake")
    const ndText = "Hi neighbors, I'm Pat Neighbor (pat.n@example.com, 954-555-0142). Our homeowners insurance premium just went up forty percent at renewal and I'm looking to buy a smaller place. How are people handling rising insurance costs around here?"
    const page = `<html><head><meta property="article:published_time" content="2026-11-10T09:00:00Z"></head><body><div class="author">Pat Neighbor</div><p>${ndText}</p></body></html>`
    const calls: Array<{ url: string; purpose?: string }> = []
    const store = new Map<string, any>()
    const snapshot = {
      fetcher: async (url: string) => { calls.push({ url }); return { ok: true, html: page, provider: "zyte" as const, cost: 0.001, costBasis: "final" as const, statusCode: 200, vendorStatus: null, headers: {}, notModified: false, error: null } },
      robots: async () => ({ status: 404, text: null }),
      store: { load: async (k: string) => (store.has(k) ? { id: k, state: store.get(k) } : false as const), save: async (_id: string | null, st: any) => { store.set(st.key, st); return { ok: true, id: st.key, error: null } } } as any,
      spendGate: () => ({ allowed: true, reason: "test budget" }), configuredProviders: ["zyte"] as const, now: () => NOW,
      ledgerClient: memSupabase({ lead_scraping_jobs: [] } as never),
    }
    const w = world({ content_topic_sources: [], content_topic_bank: [], raw_scraped_leads: [], leads: [], contacts: [], lead_scraping_jobs: [] })
    const topic = await quiet(() => pc.researchCommunityPostTopics(w as never, { brokerageId: T1, urls: ["https://nextdoor.com/p/AbC123xyz"], geo: { city: "Pensacola", state: "FL", label: "Pensacola" }, now: NOW }, { snapshot: snapshot as never }))
    const topicFetches = calls.length
    const personStore = new Map<string, any>()
    const personSnapshot = { ...snapshot, agreements: {}, store: { load: async (k: string) => (personStore.has(k) ? { id: k, state: personStore.get(k) } : false as const), save: async (_id: string | null, st: any) => { personStore.set(st.key, st); return { ok: true, id: st.key, error: null } } } }
    const personPath = await quiet(() => ck.fetchCheckpointedSnapshot({ url: "https://nextdoor.com/p/AbC123xyz", scope: { brokerageId: T1, marketId: null, purpose: "real_estate_need_chatter", lane: "nextdoor_chatter" } as never }, personSnapshot as never))
    const personFetches = calls.length - topicFetches
    const bankAfterNd = JSON.stringify(w.tables.content_topic_bank)
    const groups = await pc.normalizeFacebookGroupItems([
      { text: "Anyone know how to prepare for a rising homeowners insurance premium? Ours doubled.", url: "https://www.facebook.com/groups/pcola/posts/2", time: "2026-11-15T10:00:00Z", likesCount: 15, commentsCount: 30, user: { id: "u9", name: "A Member" }, topComments: [{ text: "call me 850-555-0199", profileName: "B Agent" }] },
      { text: "We're #1 in the county — the most trusted name in real estate!", url: "https://www.facebook.com/groups/pcola/posts/3", time: "2026-11-15T10:00:00Z", likesCount: 90000, commentsCount: 4000 },
    ], { geo: { label: "Pensacola" }, now: NOW })
    const ads = await pc.normalizeMetaAdItems([
      { adArchiveID: "111", pageID: "p1", collationId: "c1", startDateFormatted: "2026-09-01", snapshot: { title: "Is your homeowners insurance premium about to jump?", body: { text: "Learn what drives flood and wind insurance costs and the questions to ask your insurer before renewal." }, displayFormat: "VIDEO" } },
      { adArchiveID: "222", pageID: "p2", collationId: "c2", snapshot: { title: "Please welcome our newest agent!", body: { text: "We're thrilled to welcome Alex to the Bayside Realty family. Join our team!" }, displayFormat: "IMAGE" } },
    ], { geo: { label: "Pensacola" }, now: NOW })
    const fbIntake = await intakeTopicIdeas(w as never, { brokerageId: T1, ideas: [...groups.ideas, ...ads.ideas], now: NOW })
    const bank = w.tables.content_topic_bank as Row[]
    const stored = JSON.stringify(bank)
    const kinds = bank.map((r) => r.raw_data?.intake?.source_kind)
    // Positive control for D3: the router DOES name the first-person path when any classifier of the shape is present.
    const shaped = (t: string) => { const fp = /\b(I|I'm|we|our)\b/.test(t) && /looking to buy/i.test(t); return { firstPerson: fp, requestsAgentContact: false, statesHousingNeed: fp } }
    const withClassifier = pc.routeChatter(pc.visibleTextOf(page), "community_post", shaped)
    const defects: CrossLaneDefect[] = [{
      id: "D3-chatter-classifier", observed: topic.routes.unclassified_topic > 0 && topic.routes.first_person_topic_only === 0,
      what: "the production chatter path has no statement classifier: 154C's routeChatter takes it injected and 154B's readPublicStatement is module-private, so a first-person Nextdoor post (\"I'm looking to buy\") is recorded as unclassified_topic and its person path as not_evaluated — the topic is still stored safely, but the LICENSE-HELD person path the owner's one-line switch would open is never even named",
      where: "lib/content-intel/public-chatter-topics.ts:114-127 (StatementClassifier injected, default null) vs lib/acquisition-plays/public-request.ts readPublicStatement (not exported; used at :169)",
      fix: "export a PURE readPublicStatement (or move it to lib/acquisition-plays/contract.ts, which public-chatter-topics may import without reaching ingest) and make it researchCommunityPostTopics' / normalizeFacebookGroupItems' default `classify`",
      owner: "G1 (lib/content-intel/**; the export lives in 154B's module — checklist item 'C partial (c)')", evidence: topic.routes,
    }]
    const h = halves([
      ["POSITIVE CONTROL · the PII finder sees the planted email and phone in the SOURCE text", PERSON_KEY.test(ndText)],
      ["POSITIVE CONTROL · the topic purpose fetched the public post ONCE on the counting transport", topicFetches === 1 && topic.fetched === 1],
      ["the Nextdoor post became ONE reworded topic (rights public_read_reworded) through the production intake", topic.intake?.inserted === 1 && (w.tables.content_topic_bank as Row[]).some((r) => r.raw_data?.intake?.rights === "public_read_reworded")],
      ["POSITIVE CONTROL · with a classifier of the injected shape the SAME post routes first_person_topic_only (person path LICENSE-HELD, never a person) — the D3 finder can tell", withClassifier.route === "first_person_topic_only" && /license_held/.test(withClassifier.personPath)],
      ["a Facebook group question AND a Meta ad creative each landed as a topic", kinds.includes("facebook_group_question") && kinds.includes("meta_ad_creative") && fbIntake.ok],
    ], [
      ["ADVERSE · nothing stored carries the post's wording, the author, an email or a phone", !/forty percent|Pat Neighbor|pat\.n@|954-555|850-555|A Member|B Agent/.test(stored) && !PERSON_KEY.test(stored)],
      ["ADVERSE · the Nextdoor PERSON path (no agreement) is held_terms with ZERO transport calls", personPath.status === "held_terms" && personFetches === 0],
      ["ADVERSE · the brand slogan (94k reactions) and the new-hire ad are excluded before storage", groups.excluded.length >= 1 && ads.excluded.some((e: any) => e.reason === "competitor_agent_joining") && !/most trusted|Alex|Bayside/.test(stored)],
      ["ADVERSE · ZERO RawData / Raw Lead / Contact writes on every path", personWrites(w).length === 0 && !/raw_scraped_leads|"leads"|contacts/.test(JSON.stringify(w.writes.map((x: any) => x.table)))],
      ["the Nextdoor topic stored no person wording even before the Facebook items were added", !/Pat Neighbor|pat\.n@/.test(bankAfterNd)],
    ])
    return verdictOf(h, { routes: topic.routes, personPath: { status: personPath.status, reason: personPath.reason }, fetches: { topicFetches, personFetches }, kinds, excluded: [...groups.excluded, ...ads.excluded] }, `topic fetches ${topicFetches}, person-path fetches ${personFetches}; topics ${bank.length}; person writes ${personWrites(w).length}`, defects)
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// JOURNEY 5 — a verified agent milestone → points → badge → tier → leaderboard → the agent's and the team lead's readers
// ═════════════════════════════════════════════════════════════════════════════
/** The award RPCs (m484 award_agent_points, m968 award_agent_points_once) modelled IN-PROCESS on the world's own tables. */
function withAwardRpc(w: MemClient): MemClient & { rpcCalls: () => number } {
  let calls = 0
  const writer = (args: Row) => {
    calls++
    const agent = (w.tables.agents as Row[]).find((a) => a.id === args.p_agent_id)
    if (!agent) return { data: null, error: { message: "no agents row" } }
    agent.gamification_points = (agent.gamification_points ?? 0) + Number(args.p_points)
    const log = { id: `apl-${(w.tables.agent_points_log as Row[]).length + 1}`, agent_id: agent.id, brokerage_id: agent.brokerage_id, points: args.p_points, reason: args.p_reason, reference_type: args.p_reference_type ?? null, reference_id: args.p_reference_id ?? null, created_at: NOW.toISOString() }
    ;(w.tables.agent_points_log as Row[]).push(log)
    return { data: { brokerage_id: agent.brokerage_id, points_added: args.p_points, new_total: agent.gamification_points, log_id: log.id }, error: null }
  }
  ;(w as any).rpc = async (fn: string, args: Row) => {
    if (fn === "award_agent_points") return writer(args)
    if (fn === "award_agent_points_once") {
      const since = args.p_since ? String(args.p_since) : null
      const standing = (w.tables.agent_points_log as Row[]).some((r) => r.agent_id === args.p_agent_id && r.reason === args.p_reason && (args.p_reference_id == null || r.reference_id === args.p_reference_id) && (since == null || String(r.created_at) >= since))
      if (standing) return { data: { already_awarded: true, agent_id: args.p_agent_id }, error: null }
      const r = writer(args)
      return r.error ? r : { data: { ...r.data, already_awarded: false }, error: null }
    }
    return { data: null, error: { message: `unknown rpc ${fn}` } }
  }
  return Object.assign(w, { rpcCalls: () => calls })
}
canary({
  id: "J5", journey: 5, directive: "line 469 (owner ruling R6)",
  title: "A verified close pays through THE award writer once, earns its event badge and the threshold badge, moves the tier, ranks on the populated board the agent and the team lead read; a replay awards nothing; a self-typed achievement is refused",
  lanes: ["154E", "153I (badges / thresholds)", "recruiting_manager (the board populator)"],
  survivors: [
    "lib/gamification/lifecycle-awards.ts awardLifecycleMilestones → lib/gamification/award-points.ts awardAgentPointsOnce → RPC award_agent_points_once (m968 APPLIED)",
    "lib/gamification/lifecycle-awards.ts awardEventBadges / awardThresholdBadges → awardBadgeToAgent",
    "lib/gamification/tiers.ts tierForPoints / nextTierForPoints",
    "lib/recruiting/leaderboard.ts runLeaderboardSnapshot (the only leaderboard_rankings writer)",
    "lib/gamification/leaderboard-vocabulary.ts defaultPeriodLabel · lib/kernel/resolve-user-team.ts resolveLedTeamId (what getLeaderboard reads with)",
    "lib/gamification/award-points.ts POINT_EARNING_ACTIONS ⟂ lib/gamification/award-census.ts AWARD_CENSUS",
  ],
  proofs: ["test:gamification", "test:leaderboard", "test:challenges", "test:adaptive-development"],
  adverse: "the same TRANSACTION_CLOSED replayed awards 0 and writes no ledger row; a REFERRAL_CONVERTED with no closed deal behind it (a self-typed referral) is refused; nothing a seat can assert is advertised as earnable; the use-server file exports no award door",
  positiveControl: "the first close DOES pay (ledger rows written through the RPC) and the board populator DOES write rows for that period",
  blindSpot: "the RPC body is modelled in-process (the SQL lock is the live m968 function); getLeaderboard / getAgentPointsAndTier are session 'use server' readers — composed through the same vocabulary and resolver they call, not invoked; RLS that closes the browser self-award (m968) is not modelled",
  run: async () => {
    const { awardLifecycleMilestones } = await import("../lib/gamification/lifecycle-awards")
    const { KernelEvent } = await import("../lib/kernel/events")
    const { tierForPoints, nextTierForPoints } = await import("../lib/gamification/tiers")
    const { runLeaderboardSnapshot } = await import("../lib/recruiting/leaderboard")
    const { defaultPeriodLabel } = await import("../lib/gamification/leaderboard-vocabulary")
    const { resolveLedTeamId } = await import("../lib/kernel/resolve-user-team")
    const { POINT_EARNING_ACTIONS } = await import("../lib/gamification/award-points")
    const { AWARD_CENSUS } = await import("../lib/gamification/award-census")
    const TEAM = "7e540000-0000-4000-8000-000000000001", LEAD_USER = "a1540000-0000-4000-8000-0000000000l1".replace("l1", "21"), AG2 = "a1540000-0000-4000-8000-0000000000a2"
    const TX = "75400000-0000-4000-8000-000000000001", REF = "7f540000-0000-4000-8000-000000000001", BADGE_FC = "b4540000-0000-4000-8000-000000000001", BADGE_BR = "b4540000-0000-4000-8000-000000000002"
    const w = withAwardRpc(world({
      agents: [{ id: AG1, brokerage_id: T1, user_id: U1, team_id: TEAM, gamification_points: 300 }, { id: AG2, brokerage_id: T1, user_id: "u-ag2", team_id: TEAM, gamification_points: 0 }],
      teams: [{ id: TEAM, brokerage_id: T1, team_lead_id: LEAD_USER, name: "East Hill", created_at: daysAgo(400) }],
      agent_points_log: [{ id: "apl-0", agent_id: AG1, brokerage_id: T1, points: 300, reason: "SHOWING_COMPLETED", reference_type: "showing", reference_id: "5h000000-0000-4000-8000-000000000000", created_at: daysAgo(2) }],
      transactions: [{ id: TX, brokerage_id: T1, agent_id: AG1, buyer_contact_id: null, seller_contact_id: null, status: "closed", close_date: daysAgo(0) }],
      referrals: [{ id: REF, brokerage_id: T1, agent_id: AG1, referring_agent_id: AG1, status: "won", transaction_id: null, referred_contact_id: null, created_at: daysAgo(1) }],
      gamification_badges: [
        { id: BADGE_FC, brokerage_id: null, badge_name: "First Close", badge_tier: "silver", trigger_event: "FIRST_CLOSE", is_active: true, required_points: 0 },
        { id: BADGE_BR, brokerage_id: null, badge_name: "Bronze Club", badge_tier: "bronze", trigger_event: "points_threshold", is_active: true, required_points: 500 },
      ],
      agent_badges: [], lifecycle_events: [], notifications: [], leaderboard_rankings: [], brokerages: [{ id: T1 }],
    }))
    const before = Number((w.tables.agents as Row[])[0].gamification_points)
    const closeEvt = { event: KernelEvent.TRANSACTION_CLOSED, brokerageId: T1, entityType: "transaction", entityId: TX, metadata: { agent_id: AG1 } }
    const first = await quiet(() => awardLifecycleMilestones(w as never, closeEvt, NOW))
    const after = Number((w.tables.agents as Row[])[0].gamification_points)
    const logAfterFirst = (w.tables.agent_points_log as Row[]).length
    const replay = await quiet(() => awardLifecycleMilestones(w as never, closeEvt, NOW))
    const logAfterReplay = (w.tables.agent_points_log as Row[]).length
    const selfRef = await quiet(() => awardLifecycleMilestones(w as never, { event: KernelEvent.REFERRAL_CONVERTED, brokerageId: T1, entityType: "referral", entityId: REF, metadata: { agent_id: AG1 } }, NOW))
    const badges = (w.tables.agent_badges as Row[]).filter((b) => b.agent_id === AG1).map((b) => b.badge_id)
    const board = await quiet(() => runLeaderboardSnapshot(w as never, { brokerageId: T1, now: NOW }))
    const period = defaultPeriodLabel(NOW)
    const ranks = w.tables.leaderboard_rankings as Row[]
    const brokerageRow = ranks.find((r) => r.scope === "brokerage" && r.metric_type === "points" && r.period_label === period && r.agent_id === AG1)
    const led = await resolveLedTeamId(w as never, LEAD_USER)
    const teamRow = led.ok && led.teamId ? ranks.find((r) => r.scope === "team" && r.team_id === led.teamId && r.metric_type === "points" && r.period_label === period && r.agent_id === AG1) : undefined
    const advertised = POINT_EARNING_ACTIONS.map((a) => a.reason)
    const untrusted = AWARD_CENSUS.filter((c) => c.trust !== "verified_outcome").map((c) => c.reason)
    const gamActions = ident("app/actions/gamification.ts")
    const h = halves([
      ["POSITIVE CONTROL · the verified close PAYS through the RPC writer: LISTING_CLOSED + FIRST_CLOSE, total moves by exactly what was awarded", first.awarded.length === 2 && after - before === first.awarded.reduce((s, a) => s + a.points, 0) && w.rpcCalls() === 2],
      ["the FIRST_CLOSE event badge AND the Bronze threshold badge are earned on the STORED total", badges.includes(BADGE_FC) && badges.includes(BADGE_BR)],
      ["the tier moves unranked → bronze on the stored total; the next rung is named", tierForPoints(before) === "unranked" && tierForPoints(after) === "bronze" && nextTierForPoints(after)?.label != null],
      ["POSITIVE CONTROL · the board populator wrote this period's brokerage board and the agent ranks #1 with the ledger total", board.rows > 0 && !!brokerageRow && brokerageRow.rank_position === 1 && Number(brokerageRow.metric_value) === after],
      ["the team lead's reader (resolveLedTeamId on teams.team_lead_id) reaches the team board row for the same agent", led.ok && led.teamId === TEAM && !!teamRow],
    ], [
      ["ADVERSE · the replayed close awards NOTHING and writes no ledger row", replay.awarded.length === 0 && replay.alreadyAwarded === 2 && logAfterReplay === logAfterFirst],
      ["ADVERSE · a self-typed referral with no closed deal behind it is REFUSED (no points)", selfRef.awarded.length === 0 && selfRef.refused.some((r) => /no closed transaction evidences referral/.test(r))],
      ["ADVERSE · nothing a seat can assert or a booking can trigger is advertised as earnable", advertised.length > 0 && !advertised.some((r) => untrusted.includes(r as never))],
      ["ADVERSE · the 'use server' gamification file exports no award door (supporting, stripped: no exported addPoints / awardPoints)", !/export\s+(async\s+)?function\s+(addPoints|awardPoints|awardAgentPoints)\b/.test(gamActions) && /export\s+async\s+function\s+getLeaderboard\b/.test(gamActions)],
    ])
    return verdictOf(h, { first, replay: { awarded: replay.awarded.length, already: replay.alreadyAwarded }, selfRef: selfRef.refused, badges, board, brokerageRow, led, teamRow: !!teamRow }, `points ${before} → ${after} (tier ${tierForPoints(before)} → ${tierForPoints(after)}); ledger rows ${logAfterFirst}; board rows ${board.rows}`)
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// JOURNEY 6 — a campaign item and an AI ISA touch for the same person at the same time
// ═════════════════════════════════════════════════════════════════════════════
canary({
  id: "J6", journey: 6, directive: "line 470",
  title: "A queued campaign follow-on and the AI ISA's reply aimed at the same person at the same moment: the conversation owner wins, exactly ONE message goes out, the campaign piece is held (not lost) and a held inbound reaches a person",
  lanes: ["154A2 (stale-plan re-read in arbitratePlannedTouch)", "153 bundle follow-on worker", "153 inbound responder"],
  survivors: [
    "lib/direct-mail/orchestrate-bundle-send.ts orchestrateBundleSend / executeBundleFollowOnTask",
    "lib/ai-isa/followup-arbiter.ts arbitratePlannedTouch (154A2 FIXED post-decision re-read)",
    "lib/communications/inbound-responder.ts respondToInboundCommunication",
    "lib/ai-isa/followup-arbiter.ts arbitrationResponsivenessMetrics (the reader over the decision ledger)",
  ],
  proofs: ["test:os-planes-canaries (P4, P13)", "test:campaign-bundle-follow-on", "test:inbound-responder"],
  adverse: "Dana writes while her campaign piece is being planned: the plan finishing after the ISA's reply is held (stale_plan_superseded) and the bundle sends nothing; a signature / commission question is held for a person (a reply-coach draft) — never answered by the bot, never dropped",
  positiveControl: "Rowan (no conversation) gets the same slow plan and his campaign piece goes out exactly once",
  blindSpot: "the model and the composer are seams; the queue-drain cron that re-runs the held follow-on later is test:campaign-bundle-follow-on; SMS / email providers are counting fakes",
  run: async () => {
    const arb = await import("../lib/ai-isa/followup-arbiter")
    const bundle = await import("../lib/direct-mail/orchestrate-bundle-send")
    const resp = await import("../lib/communications/inbound-responder")
    const { platformFollowupPolicy } = await import("../lib/ai-isa/followup-policy")
    const C1 = "c6540000-0000-4000-8000-000000000001", C2 = "c6540000-0000-4000-8000-000000000002", BU = "c6b40000-0000-4000-8000-000000000001", CONV = "cc540000-0000-4000-8000-000000000001"
    const I1 = "c6140000-0000-4000-8000-000000000001", I2 = "c6140000-0000-4000-8000-000000000002"
    const iso = (ms = 0) => new Date(Date.now() + ms).toISOString()
    const contact = (id: string, name: string) => ({ id, brokerage_id: T1, agent_id: AG1, first_name: name, email: `${name.toLowerCase()}@example.test`, phone: null, deleted_at: null, email_verified: true, email_opt_out: false, email_unsubscribed: false, dnc_status: false, ai_outreach_paused: false, source: "website", created_at: iso(-30 * DAY) })
    const w = world({
      contacts: [contact(C1, "Dana"), contact(C2, "Rowan")], conversations: [{ id: CONV, brokerage_id: T1, agent_id: AG1 }], agents: [{ id: AG1, brokerage_id: T1, user_id: U1 }],
      campaign_bundles: [{ id: BU, brokerage_id: T1, name: "Welcome", is_active: true }],
      campaign_bundle_items: [{ id: I1, bundle_id: BU, brokerage_id: T1, channel: "email", preset_id: "p1", order_index: 0 }, { id: I2, bundle_id: BU, brokerage_id: T1, channel: "email", preset_id: "p2", order_index: 1 }],
      campaign_bundle_dispatches: [], orchestrator_tasks: [], agent_action_ledger: [], messages: [], buyer_fatigue_scores: [], managed_agents: [], feature_access_overrides: [],
    }, { unique: { agent_action_ledger: [["idempotency_key"]], orchestrator_tasks: [["payload->>idempotency_key"]] } })
    const egress: string[] = []
    const dispatchItem = async (_s: unknown, item: { channel: string; preset_id: string }, ctx?: Row) => { egress.push(`campaign:${item.preset_id}:${String(ctx?.contactId ?? "?")}`); return { channel: item.channel, success: true, messageId: `prov-${egress.length}` } as never }
    const start = (contactId: string, name: string) => bundle.orchestrateBundleSend({ brokerageId: T1, bundleId: BU, contactId, recipientName: name, mailingAddress: "", city: "", state: "", zip: "", recipientEmail: `${name.toLowerCase()}@example.test` } as never, { client: w as never, dispatchItem: dispatchItem as never } as never)
    await quiet(() => start(C1, "Dana")); await quiet(() => start(C2, "Rowan"))
    const followOn = (cid: string) => (w.tables.orchestrator_tasks as Row[]).find((t) => t.task_type === bundle.BUNDLE_FOLLOW_ON_TASK && t.payload?.bundle_item_id === I2 && t.payload?.audience?.contact_id === cid)
    const sendNow = { optionId: "send_now", channel: "email", format: null, waitHours: null, rationale: "the next piece of the welcome series", evidence: ["history"], confidence: 0.9 }
    let decides = 0
    const slowDecide = (during?: () => Promise<void>) => async (s: unknown, input: Row) => arb.arbitratePlannedTouch(s as never, input as never, { decide: (async () => { decides++; await sleep(60); if (during) await during(); await sleep(60); return sendNow }) as never }) as never
    const sms: Row[] = [], drafts: Row[] = []
    const rdeps = { policy: platformFollowupPolicy(), customer360For: async () => ({ ok: true, view: { fields: {} } }), compose: async () => ({ text: "Saturday at 10 works — I'll confirm shortly." }), safety: () => [] as string[],
      sendSms: async (p: Row) => { sms.push(p); egress.push(`isa:sms:${String(p.contactId ?? C1)}`); (w.tables.messages as Row[]).push({ id: `out-${sms.length}`, brokerage_id: T1, contact_id: C1, conversation_id: CONV, direction: "outbound", sender_type: "ai", type: "sms", created_at: iso() }); return { sent: true, providerRef: `SM${sms.length}`, messageId: `m-${sms.length}` } },
      sendEmail: async () => ({ sent: true, providerRef: "em", messageId: "me" }), postPortal: async () => ({ sent: true, providerRef: null, messageId: "mp" }),
      replyCoach: async (p: Row) => { drafts.push(p); return { success: true, draftId: `d-${drafts.length}` } }, routeToAgent: (async () => true) as never }
    let n = 0
    const inbound = (body: string, primary = "schedule_showing") => {
      const at = iso()
      ;(w.tables.messages as Row[]).push({ id: `in-${++n}`, brokerage_id: T1, contact_id: C1, conversation_id: CONV, direction: "inbound", sender_type: "contact", type: "sms", created_at: at })
      return { brokerageId: T1, contactId: C1, conversationId: CONV, recordId: `rec-j6-${n}`, channel: "sms", provider: "twilio", surface: "sms", body, isPublic: false, threadRef: null, intent: { primary, confidence: 90, urgency: "normal" }, receivedAt: at } as never
    }
    // THE SAME MOMENT: Dana's campaign piece is being planned; she writes; the AI ISA answers while the plan is in flight.
    const egressMark = egress.length
    let reply: any = null
    const t1 = followOn(C1)
    const campaign = t1 ? await quiet(() => bundle.executeBundleFollowOnTask(w as never, { id: t1.id }, { arbitrate: slowDecide(async () => { reply = await resp.respondToInboundCommunication(w as never, inbound("Can we see the house Saturday at 10?"), rdeps as never) }) as never, dispatchItem: dispatchItem as never })) : null
    const toDana = egress.slice(egressMark).filter((e) => e.endsWith(C1))
    const danaTask = followOn(C1)
    // A held inbound (signature / money) is not lost: a person gets the draft.
    const held = await quiet(() => resp.respondToInboundCommunication(w as never, inbound("Do I need to sign the counteroffer tonight, and is the commission split final?", "general_question"), rdeps as never))
    // Positive control: Rowan, nobody in conversation, the same slow plan.
    const rowanMark = egress.length
    const t2 = followOn(C2)
    const rowan = t2 ? await quiet(() => bundle.executeBundleFollowOnTask(w as never, { id: t2.id }, { arbitrate: slowDecide() as never, dispatchItem: dispatchItem as never })) : null
    const toRowan = egress.slice(rowanMark).filter((e) => e.endsWith(C2))
    const ledger = (w.tables.agent_action_ledger ?? []) as Row[]
    const superseded = ledger.some((x) => x.subject_id === C1 && JSON.stringify(x.detail ?? {}).includes("stale_plan_superseded"))
    const metrics = arb.arbitrationResponsivenessMetrics(ledger as never, new Date())
    const h = halves([
      ["the AI ISA answered Dana's inbound (reply_sent) while the campaign plan was still deciding", reply?.action === "reply_sent" && decides >= 1],
      ["exactly ONE message reached Dana in that moment (the conversation owner's), zero campaign pieces", toDana.length === 1 && toDana[0].startsWith("isa:")],
      ["POSITIVE CONTROL · Rowan, nobody in conversation, gets his campaign piece exactly once from the same slow plan", toRowan.length === 1 && toRowan[0].startsWith("campaign:p2:")],
      ["the decision ledger's reader sees the inbound decisions and misses none", metrics.inbound >= 2 && metrics.missedConversations === 0],
    ], [
      ["ADVERSE · the campaign plan that finished AFTER the reply is held as stale_plan_superseded (154A2's re-read), nothing sent over the live conversation", superseded && !egress.slice(egressMark).some((e) => e.startsWith("campaign:") && e.endsWith(C1))],
      ["ADVERSE · the held campaign piece is NOT lost: Dana's follow-on task still stands (not completed / cancelled)", !!danaTask && !["completed", "cancelled", "done"].includes(String(danaTask.status))],
      ["ADVERSE · a signature / commission question is held for a person (reply_proposed + a reply-coach draft), not sent and not dropped", held.action === "reply_proposed" && drafts.length >= 1 && sms.length === 1],
    ])
    return verdictOf(h, { campaign, reply: reply && { action: reply.action, reason: reply.reason }, toDana, toRowan, rowan, danaTask: danaTask && { status: danaTask.status, sched: danaTask.scheduled_for }, held: { action: held.action, reason: held.reason }, metrics }, `egress to Dana ${toDana.length}, to Rowan ${toRowan.length}; drafts for a person ${drafts.length}`)
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// JOURNEY 7 — a delegated request from each seat
// ═════════════════════════════════════════════════════════════════════════════
canary({
  id: "J7", journey: 7, directive: "line 471",
  title: "Each seat that exists — platform staff, tenant admin, office, agent, Contact, vendor — reaches its manager door with the right writable scope, leaves evidence a reader returns, and is refused across the isolation boundary",
  lanes: ["154A2 (delegation recovery, action-ledger outcome)", "153O / 153T (delegation subjects)", "150DAC (egress scope)", "153 inbound responder", "lender-linkage"],
  survivors: [
    "lib/kernel/tenant-scope.ts resolveTenantScope (platform staff)",
    "lib/kernel/egress-scope.ts resolveEgressScope + scopeFilter (tenant admin / office / agent writable scope)",
    "lib/kernel/manager-delegation.ts requestDelegation + pendingDelegationsFor (the manager door + its reader; withActionLedger evidence)",
    "lib/auth/lead-visibility.ts LEAD_DESK_USER_TYPES (agents see Contacts only)",
    "lib/communications/inbound-responder.ts respondToInboundCommunication (the Contact's request → ai_isa)",
    "lib/kernel/lender-linkage.ts isLenderVendorCategory / vendorSeatsForUser (a lender is a vendor category)",
  ],
  proofs: ["test:os-planes-canaries (P7, P8)", "test:manager-delegation", "test:egress-scope", "test:lead-visibility", "test:lender-linkage"],
  adverse: "no tenant and no proven platform authority throws (never 'every tenant'); B1's admin naming B2's contact is refused subject_not_found with nothing of B2 leaked; an office admin's filter is pinned to their office; an agent is not on the lead desk; a Contact of B2 writing into B1's thread is not answered; a vendor of another lender sees no seat; 'lender' is not a user type",
  positiveControl: "the same delegation with B1's own contact IS written, ledgered and returned by the subject reader; a seat with a vendor row resolves its lender seat",
  blindSpot: "there is no single seat → manager router: internal seats reach managers through manager-to-manager delegation (requestDelegation needs a requestingManager) and the v1 domain API (data_steward); the Contact's door is the inbound responder and the vendor's door is portal-auth (session-bound requireLenderVendorActor, not invoked) — see the PARTIAL note; RLS is not modelled; the vendor seat's PostgREST embed is selected whole (memSupabase cannot project an embed)",
  run: async () => {
    const ts = await import("../lib/kernel/tenant-scope")
    const es = await import("../lib/kernel/egress-scope")
    const del = await import("../lib/kernel/manager-delegation")
    const { LEAD_DESK_USER_TYPES } = await import("../lib/auth/lead-visibility")
    const { TENANT_ADMIN_USER_TYPES } = await import("../lib/auth/resolve-user-role")
    const { CAPABILITY_MANAGER } = await import("../lib/agentic-os/capability-ownership")
    const { isLenderVendorCategory, vendorSeatsForUser } = await import("../lib/kernel/lender-linkage")
    const { resolvePlatformManager } = await import("../lib/kernel/manager-registry")
    const CONV7 = "cc740000-0000-4000-8000-000000000001", CN = "c7540000-0000-4000-8000-000000000001", CF = "c7540000-0000-4000-8000-0000000000f2", LOC = "10c54000-0000-4000-8000-000000000001", VND = "e7540000-0000-4000-8000-000000000001", VU = "e7540000-0000-4000-8000-0000000000u1".replace("u1", "11")
    // platform staff
    const platform = ts.resolveTenantScope({ brokerageId: null, platformAuthorized: true, platformReason: "platform_role=staff (verified)", where: "wave154-canaries J7" })
    let orphanThrew = false
    try { ts.resolveTenantScope({ brokerageId: null, platformAuthorized: false, where: "wave154-canaries J7" }) } catch (e) { orphanThrew = ts.isTenantScopeRefusal(e) }
    const sentinel = resolvePlatformManager("platform_sentinel")
    // tenant admin / office / agent writable scope
    const admin = es.resolveEgressScope({ userId: "u-adm", brokerageId: T1, userType: "broker_admin", locationId: null, teamId: null } as never)
    const office = es.resolveEgressScope({ userId: "u-off", brokerageId: T1, userType: "admin", locationId: LOC, teamId: null } as never)
    const agent = es.resolveEgressScope({ userId: U1, brokerageId: T1, userType: "agent", locationId: null, teamId: null } as never)
    const fAdmin = es.scopeFilter(admin), fOffice = es.scopeFilter(office), fAgent = es.scopeFilter(agent)
    // the manager door + evidence + reader (a tenant admin's request rides the ai_isa → isa_qualify owner on a Contact subject)
    const w = world({ contacts: [{ id: CN, brokerage_id: T1, agent_id: AG1, first_name: "Avery", email: "avery@example.test", email_verified: true, dnc_status: false, ai_outreach_paused: false, created_at: daysAgo(30) }, { id: CF, brokerage_id: T2, first_name: "SECRET-T2-CONTACT" }],
      manager_delegations: [], manager_delegation_events: [], agent_action_ledger: [], missions: [], mission_events: [], conversations: [{ id: CONV7, brokerage_id: T1, agent_id: AG1, contact_id: CN }], agents: [{ id: AG1, brokerage_id: T1, user_id: U1 }], managed_agents: [], feature_access_overrides: [], messages: [], buyer_fatigue_scores: [],
      user_role_assignments: [{ id: "ura-1", user_id: VU, vendor_id: VND, vendors: { id: VND, name: "Coastal Lending", category: "lender", brokerage_id: T1 } }], vendors: [{ id: VND, brokerage_id: T1, category: "lender", name: "Coastal Lending" }] })
    const dd = { afford: async () => ({ allowed: true, reason: "entitled" }), authority: async () => 2 as const, emit: async () => {}, signal: async () => {}, mission: { emit: async () => {}, signal: async () => {} } } as never
    const isaOwner = CAPABILITY_MANAGER["isa_qualify" as never] as never
    const own = await quiet(() => del.requestDelegation({ brokerageId: T1, requestingManager: "listing_concierge", assignedManager: isaOwner, capability: "isa_qualify", objective: "qualify the contact before the listing appointment", authority: 2, inputEntities: { contactId: CN }, actor: { type: "user", id: "u-adm" } } as never, w as never, dd))
    const nBefore = (w.tables.manager_delegations as Row[]).length
    const foreign = await quiet(() => del.requestDelegation({ brokerageId: T1, requestingManager: "listing_concierge", assignedManager: isaOwner, capability: "isa_qualify", objective: "qualify", authority: 2, inputEntities: { contactId: CF } } as never, w as never, dd))
    const reader = await del.pendingDelegationsFor(T1, { subject: { type: "contact", id: CN } }, w as never)
    const readerForeign = await del.pendingDelegationsFor(T1, { subject: { type: "contact", id: CF } }, w as never)
    const evidence = ((w.tables.agent_action_ledger ?? []) as Row[]).filter((r) => r.action === "delegation.request.create")
    // the Contact's request → the AI ISA (ai_isa) through the inbound responder; a T2 contact writing into T1 is not answered
    const resp = await import("../lib/communications/inbound-responder")
    const { platformFollowupPolicy } = await import("../lib/ai-isa/followup-policy")
    const sent: Row[] = []
    const rdeps = { policy: platformFollowupPolicy(), customer360For: async () => ({ ok: true, view: { fields: {} } }), compose: async () => ({ text: "Happy to help — what time works?" }), safety: () => [] as string[],
      sendSms: async (p: Row) => { sent.push(p); return { sent: true, providerRef: "SM1", messageId: "m1" } }, sendEmail: async (p: Row) => { sent.push(p); return { sent: true, providerRef: "em", messageId: "me" } }, postPortal: async (p: Row) => { sent.push(p); return { sent: true, providerRef: null, messageId: "mp" } },
      replyCoach: async () => ({ success: true, draftId: "d" }), routeToAgent: (async () => true) as never }
    const req = (contactId: string, rec: string) => ({ brokerageId: T1, contactId, conversationId: CONV7, recordId: rec, channel: "portal", provider: "portal", surface: "portal", body: "Can someone walk me through the inspection report?", isPublic: false, threadRef: null, intent: { primary: "general_question", confidence: 85, urgency: "normal" }, receivedAt: new Date().toISOString() }) as never
    const contactReq = await quiet(() => resp.respondToInboundCommunication(w as never, req(CN, "rec-j7-1"), rdeps as never))
    const sentAfterOwn = sent.length
    const crossReq = await quiet(() => resp.respondToInboundCommunication(w as never, req(CF, "rec-j7-2"), rdeps as never))
    const contactEvidence = ((w.tables.agent_action_ledger ?? []) as Row[]).filter((r) => r.action === "inbound.message.respond")
    // the vendor seat
    // memSupabase splits a select on commas, so it cannot project a PostgREST embed (`vendors!inner(...)`); the seeded row
    // carries the embed's shape and this thin view selects it whole — the resolver's own filter and mapping still run.
    const embedView = { from: (t: string) => { const q = w.from(t) as any; const sel = q.select.bind(q); q.select = (c?: string) => sel(c && /!inner\(/.test(c) ? "*" : c); return q } }
    const seats = await vendorSeatsForUser(embedView, VU)
    const strangerSeats = await vendorSeatsForUser(embedView, "u-stranger")
    const defects: CrossLaneDefect[] = []
    const partial = [
      "vendor seat: only the seat resolver ran — the vendor's request door (lib/kernel/portal-auth.ts requireLenderVendorActor / requireVendorActor) is session-bound and was not executed; a vendor-originated request reaching a manager with ledger evidence is unproven here",
      "no single seat → manager router exists: internal seats reach managers through manager-to-manager delegation (requestDelegation requires a requestingManager) or the v1 domain API (data_steward); the Contact's door is the inbound responder — each composed separately (owner A3: lib/orchestrator/**, app/api/agentic-os/**)",
    ]
    const h = halves([
      ["platform staff: proven platform authority yields the PLATFORM scope and a named platform manager", platform.kind === "platform" && sentinel.key === "platform_sentinel"],
      ["tenant admin: brokerage-wide writable scope, always tenant-pinned", admin.kind === "brokerage" && fAdmin.brokerage_id === T1 && (TENANT_ADMIN_USER_TYPES as ReadonlySet<string>).has("broker_admin")],
      ["office: the office admin's writable scope is their office (location filter set)", office.kind === "location" && fOffice.location_id === LOC && fOffice.brokerage_id === T1],
      ["agent: own work only", agent.kind === "agent" && fAgent.agent_user_id === U1],
      ["POSITIVE CONTROL · the delegation on T1's own contact is written to the registry's capability owner, ledgered, and the subject reader returns it", own.ok && (own as any).delegation?.assigned_manager === isaOwner && evidence.length >= 1 && reader.pending.length === 1],
      ["Contact: the Contact's request reaches the AI ISA (answered or proposed) and leaves an inbound decision on the ledger", ["reply_sent", "reply_proposed"].includes(contactReq.action) && contactEvidence.length >= 1],
      ["POSITIVE CONTROL · vendor: a seat with a vendor row resolves its lender seat; a lender is a vendor CATEGORY", seats.length === 1 && seats[0]?.brokerageId === T1 && isLenderVendorCategory(seats[0]?.category) && isLenderVendorCategory("lender") && isLenderVendorCategory("refinance_lender")],
    ], [
      ["ADVERSE · no tenant AND no proven platform authority THROWS (never read as 'every tenant')", orphanThrew],
      ["ADVERSE · T1 naming T2's contact is refused subject_not_found:contact, nothing inserted, nothing of T2 leaked; the reader finds nothing for it", !foreign.ok && (foreign as any).reason === "subject_not_found:contact" && (w.tables.manager_delegations as Row[]).length === nBefore && !JSON.stringify(foreign).includes("SECRET") && readerForeign.pending.length === 0],
      ["ADVERSE · the office filter never widens to the brokerage; the agent is NOT on the lead desk (Contacts only)", !fOffice.location_ids && !LEAD_DESK_USER_TYPES.has("agent") && LEAD_DESK_USER_TYPES.has("isa")],
      ["ADVERSE · a T2 contact writing into T1's thread is not answered (no message sent)", crossReq.action !== "reply_sent" && sent.length === sentAfterOwn],
      ["ADVERSE · a stranger has no vendor seat; 'lender' is not a tenant-admin user type", strangerSeats.length === 0 && !(TENANT_ADMIN_USER_TYPES as ReadonlySet<string>).has("lender")],
    ])
    return verdictOf(h, { platform, admin: admin.kind, office: fOffice, agent: fAgent, own: own.ok, foreign: (foreign as any).reason, reader: reader.pending.length, contactReq: { action: contactReq.action, reason: contactReq.reason }, crossReq: { action: crossReq.action, reason: crossReq.reason }, seats }, "six seats composed; delegation ledgered + read back; isolation refused on each boundary", defects, partial)
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// THE RUN
// ═════════════════════════════════════════════════════════════════════════════
export const WAVE154_CANARIES: readonly Canary154[] = CANARIES
async function runVerdict(f: () => Promise<Verdict154>): Promise<Verdict154> {
  try { return await f() } catch (e) { return { positive: false, negative: false, detail: `THREW: ${(e as Error)?.stack ?? String(e)}` } }
}
async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" WAVE 154 canaries (in-memory, SIMULATED) — directive 154F: batch-1 lanes' REAL exports composed across lanes, seven journeys,")
  console.log(" each POSITIVE + ADVERSE + positive control + blind spot; cross-lane disagreements measured as defects (PARTIAL, not papered over)")
  console.log("══════════════════════════════════════════════════════════════")
  let passed = 0, failed = 0, partialRows = 0
  const failures: string[] = []
  const observed: Array<CrossLaneDefect & { canary: string }> = []
  for (const c of CANARIES) {
    const v = await runVerdict(c.run)
    const ok = v.positive && v.negative
    const open = (v.defects ?? []).filter((d) => d.observed)
    const unexecuted = v.partial ?? []
    if (ok) passed++; else { failed++; failures.push(`${c.id}. ${c.title}`) }
    if (ok && (open.length || unexecuted.length)) partialRows++
    for (const d of open) observed.push({ ...d, canary: c.id })
    const state = !ok ? "FAILED" : open.length || unexecuted.length ? "PARTIAL · SIMULATED" : "COMPLETE · SIMULATED"
    console.log(`\n ${ok ? (open.length || unexecuted.length ? "◐" : "✓") : "✗"} ${c.id} [journey ${c.journey}] ${c.title} — positive ${v.positive ? "✓" : "✗"} · adverse ${v.negative ? "✓" : "✗"} · ${state}`)
    console.log(`      lanes: ${c.lanes.join(" + ")}`)
    console.log(`      survivors: ${c.survivors.join(" · ")}`)
    console.log(`      lane proofs (guard chain): ${c.proofs.join(", ")}`)
    console.log(`      adverse: ${c.adverse}`)
    console.log(`      positive control: ${c.positiveControl}`)
    console.log(`      blind spot: ${c.blindSpot}`)
    if (v.note) console.log(`      measured: ${v.note}`)
    for (const u of unexecuted) console.log(`      PARTIAL (not executed): ${u}`)
    for (const d of v.defects ?? []) console.log(`      cross-lane ${d.observed ? "DEFECT OBSERVED" : "link holds"} [${d.id}] → ${d.owner}${d.observed ? `: ${d.what}\n        where: ${d.where}\n        fix: ${d.fix}` : ""}`)
    if (!ok) console.log(`      evidence: ${String(v.detail ?? "").slice(0, 2400)}`)
  }
  console.log("\n──────────────────────────────────────────────────────────────")
  console.log(` measured: ${CANARIES.length} canaries over ${new Set(CANARIES.map((c) => c.journey)).size} journeys; ${partialRows} PARTIAL (a cross-lane link observed broken, or a named link not executed), ${observed.length} cross-lane defect(s): ${observed.map((d) => `${d.canary}/${d.id}`).join(", ") || "none"}`)
  console.log(" blind spots: memSupabase has no CHECK/FK/RLS/trigger · the award RPC is modelled in-process · no provider, model, Exa, Zyte, ZenRows,")
  console.log("   Apify, Google or social channel is called (counting seams — SIMULATED) · session 'use server' readers are composed through the")
  console.log("   vocabulary / resolver they call, not invoked · owner-held grants (Trends, Search Console, Apify, social OAuth) are untouched")
  if (failures.length) for (const f of failures) console.log(`  ✗ ${f}`)
  console.log(` RESULT: canaries ${passed} passed, ${failed} failed (${partialRows} of the passing rows PARTIAL)`)
  console.log(failed === 0 ? "WAVE154_CANARIES_PASS" : "WAVE154_CANARIES_FAIL")
  process.exit(failed > 0 ? 1 : 0)
}
const isEntry = (() => { try { return pathToFileURL(resolve(process.argv[1] ?? "")).href === import.meta.url } catch { return false } })()
if (isEntry) main().catch((e) => { console.error(e); console.log("WAVE154_CANARIES_FAIL"); process.exit(1) })
