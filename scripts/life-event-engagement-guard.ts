#!/usr/bin/env tsx
/**
 * scripts/life-event-engagement-guard.ts  (npm run test:life-event-engagement)
 * ────────────────────────────────────────────────────────────────────────
 * WAVE 148, LANE 148F — owner rulings 5 + 17, contract C20 (and C19's surfaces). DRIVEN through the real modules on an in-memory
 * database (no network, no model, no vendor — the model, the authority grant and the gateway are injected), each refusal beside its
 * positive control:
 *
 *   A. THE CHRONOLOGICAL MAP (C20) — one entry per canonical event (aliases · category · chain + stage · supersedes · sensitivity ·
 *      relevance · follow-up kind · allowed outreach); no alias means two events; every spelling the tree ever wrote resolves; the
 *      C9 relevance table and the arbiter's signal vocabulary are DERIVED from it; prohibited (health / pregnancy) tokens never map.
 *   B. THE ONE WRITE RULE — mergeLifeEvents canonicalises, dedups the same event, sequences, links supersedes, drops prohibited
 *      tokens, leaves unknown elements untouched; the chronology and the "current" view read back right.
 *   C. EVERY WRITER MAPPED + THE BACKFILL — a census over STRIPPED source of every `life_events:` write, each classified
 *      (vocabulary / carry / not a database write) with a positive control; m920's spelling pairs EQUAL the map's alias index;
 *      m919's CHECK list EQUALS the canonical events; the migrations carry the lane stamp or the APPLIED stamp (the rule, not the waypoint).
 *   D. RULING 17 — THE ARBITER'S LIFE-EVENT BRANCH (arbitrateAndRecordExperience, end to end): quiet monitoring is the fallback (never a
 *      person by reflex); automated, event-agnostic help appears only on grounded evidence with a confirmed identity AND the tenant's
 *      explicit autonomy; the map's allowed experiences bound it; a person is always a CHOICE; the expert empathetic prompt decides it.
 *   E. THE OUTREACH SCREEN (positive control): a draft naming or alluding to the event is REFUSED — screenLifeEventOutreach and
 *      personalizeOutreach (a model draft naming the divorce is replaced by the deterministic copy); no copy fact ever names an event.
 *   F. THE C19 SURFACES — the lead desk's door reads the dataset verifications after its seat gate; the permit sweep records its feed
 *      observations; the movement chokepoint asks the dataset ceiling.
 *
 * Scans read STRIPPED source (scripts/strip-comments.ts) and blank strings where a specimen could match. BLIND SPOTS are printed at
 * the end.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments, blankStrings } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function ok(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await f() } finally { console.warn = w; console.error = e } }
const raw = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")
const src = (p: string) => stripComments(raw(p))
const NOW = new Date("2026-10-30T15:00:00.000Z")
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()

function walk(dir: string, out: string[] = []): string[] {
  const abs = join(process.cwd(), dir)
  if (!existsSync(abs)) return out
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const rel = `${dir}/${name}`
    const st = statSync(join(process.cwd(), rel))
    if (st.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(rel)
  }
  return out
}

async function main() {
  const voc = await import("../lib/enrichment/life-event-vocabulary")
  const mv = await import("../lib/intent/movement-signals")
  const arb = await import("../lib/ai-isa/followup-arbiter")
  const lap = await import("../lib/ai-isa/lead-action-plan")
  const policyMod = await import("../lib/ai-isa/followup-policy")
  const po = await import("../lib/ai-isa/personalize-outreach")

  // ── A. THE CHRONOLOGICAL MAP ──────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nA. the chronological vocabulary map (C20) — one entry per event, every spelling resolved")
  {
    const types = voc.LIFE_EVENT_TYPES as readonly string[]
    ok(types.every((t) => (voc.LIFE_EVENT_VOCAB as Record<string, { canonical: string }>)[t]?.canonical === t) && Object.keys(voc.LIFE_EVENT_VOCAB).length === types.length, `every canonical event (${types.length}) has exactly one map entry keyed by itself`)
    const entries = Object.values(voc.LIFE_EVENT_VOCAB)
    const complete = entries.filter((e) => e.category && e.chain && e.stage >= 1 && e.sensitivity && e.followupKind && e.allowedOutreach.tone.length > 20 && e.allowedOutreach.neverMention.length > 0 && voc.LIFE_EVENT_ENGAGEMENT_MODES.every((m) => e.allowedOutreach.modes.includes(m)))
    ok(complete.length === entries.length, "every entry carries category · chain + stage · sensitivity · follow-up kind · all FIVE engagement modes · never-mention terms · a tone brief", entries.filter((e) => !complete.includes(e)).map((e) => e.canonical).join(", "))
    const sameChainBackward = entries.flatMap((e) => e.supersedes.filter((s) => voc.LIFE_EVENT_VOCAB[s].chain === e.chain && voc.LIFE_EVENT_VOCAB[s].stage >= e.stage).map((s) => `${e.canonical}→${s}`))
    ok(entries.every((e) => e.supersedes.every((s) => types.includes(s) && s !== e.canonical)) && sameChainBackward.length === 0, "CHRONOLOGY: an event supersedes only OTHER events, and within its own chain only an EARLIER stage (relocation 3 → job change 1; inheritance 2 → death 1)", sameChainBackward.join(", "))
    const stagesUnique = [...new Set(entries.map((e) => e.chain))].every((c) => { const st = entries.filter((e) => e.chain === c).map((e) => e.stage); return new Set(st).size === st.length })
    ok(stagesUnique, "each chain orders its events by distinct stages (the map knows what comes before what)")
    // aliases: one spelling, one meaning — the module throws at load on a duplicate; prove the detector on a specimen
    const dupOf = (map: Record<string, readonly string[]>) => { const seen = new Map<string, string>(); const dups: string[] = []; for (const [t, as] of Object.entries(map)) for (const a of [t, ...as]) { if (seen.has(a) && seen.get(a) !== t) dups.push(a); seen.set(a, t) } return dups }
    ok(dupOf(Object.fromEntries(entries.map((e) => [e.canonical, e.aliases]))).length === 0 && dupOf({ a: ["x"], b: ["x"] }).join() === "x", "no alias maps two events (positive control: a specimen map with one shared alias is caught)")
    const written = ["divorce", "death_in_family", "probate", "probate_filing", "wedding", "baby", "newborn", "retired", "new_job", "promotion", "foreclosure", "pre_foreclosure", "empty_nest", "graduation", "obituary", "estate_of", "chapter_7", "relocating", "job_transfer", "Divorce-Filing", "  Death In Family "]
    const unresolved = written.filter((w) => !voc.canonicalLifeEventType(w))
    ok(unresolved.length === 0, `every spelling the tree ever wrote or read resolves to its canonical event (${written.length} checked)`, unresolved.join(", "))
    ok(voc.canonicalLifeEventType("divorce") === "divorce_filing" && voc.canonicalLifeEventType("probate_filing") === "inheritance" && voc.canonicalLifeEventType("wedding") === "marriage" && voc.canonicalLifeEventType("made_up_event") === null, "…each to the RIGHT event, and an unknown token is null (never guessed onto a nearby event)")
    ok(["pregnancy", "pregnant", "expecting", "diagnosis", "hospice"].every((t) => voc.canonicalLifeEventType(t) === null) && voc.normalizeLifeEvent({ type: "pregnancy" }, { observedAt: NOW.toISOString() }).ok === false, "PRIVACY: health / pregnancy tokens are NEVER a life event (no mapping, the normaliser drops them with the reason)")
    ok(types.every((t) => { const e = voc.LIFE_EVENT_VOCAB[t as never] as { movementRelevance: string | null; protectedProxy: boolean }; const r = (mv.LIFE_EVENT_RELEVANCE as Record<string, { relevance: string; protectedProxy: boolean } | null>)[t]; return e.movementRelevance === null ? r === null : r?.relevance === e.movementRelevance && r.protectedProxy === e.protectedProxy }),
      "C9's LIFE_EVENT_RELEVANCE is DERIVED from the map (relevance + protected proxy) — one vocabulary, no restated table")
    ok(/LIFE_EVENT_VOCAB\[t\]\.movementRelevance/.test(src("lib/intent/movement-signals.ts")) && !/divorce_filing:\s*\{\s*relevance:\s*"divorce"/.test(src("lib/intent/movement-signals.ts")), "…and the restated literal table is gone from movement-signals (stripped source)")
    const kinds = arb.LIFE_CHANGE_SIGNAL_KINDS as Record<string, string>
    ok(types.every((t) => kinds[t] === (voc.LIFE_EVENT_VOCAB as Record<string, { followupKind: string }>)[t].followupKind) && kinds.probate_filing === "life_event" && kinds.death_in_family === "life_event" && kinds.relocating === "moving" && kinds.refinance_opportunity === "refinance",
      "the arbiter's signal vocabulary reads every map spelling as its follow-up kind (probate_filing / death_in_family → life_event, relocating → moving) — explicit intent rows untouched")
  }

  // ── B. THE ONE WRITE RULE ─────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nB. the one write rule — canonical, deduped, sequenced, superseding, privacy-safe")
  {
    const stored = [{ event: "divorce", source: "public_records" }, { type: "new_job", detected_at: daysAgo(90), source_date: daysAgo(95) }, { type: "something_else_entirely", note: "kept" }, { type: "pregnancy" }]
    const m = voc.mergeLifeEvents(stored, [
      { type: "relocation", source_url: "https://example.org/r", source_date: daysAgo(10) },
      { event: "Divorce", source_url: "https://example.org/d" },
      { type: "job_change", source_date: daysAgo(95) },
      { type: "hospice" },
    ], { now: NOW })
    const byType = (t: string) => m.events.filter((e) => e.type === t)
    ok(m.events.every((e) => !("event" in e) || e.type === "something_else_entirely") && byType("divorce_filing").length === 1 && byType("job_change").length === 1, "stored history is CANONICALISED (`{ event: divorce }` → `{ type: divorce_filing }`, `new_job` → job_change) and the same event is never appended twice", JSON.stringify(m.events.map((e) => e.type)))
    ok(m.duplicates === 2 && m.added.length === 1 && m.added[0].type === "relocation", `DEDUP: a re-detected divorce (undated) and the same job change (same day) are duplicates (${m.duplicates}); only the relocation is new`)
    const job = byType("job_change")[0] as { sequence: number }, rel = byType("relocation")[0] as { sequence: number; supersedes: number | null; event_at: string | null; observed_at: string }
    const storedMax = Math.max(...m.events.filter((e) => e !== rel && typeof e.sequence === "number").map((e) => e.sequence as number))
    ok(rel.sequence === storedMax + 1 && rel.supersedes === job.sequence && !!rel.event_at && rel.observed_at === NOW.toISOString(),`CHRONOLOGY: the relocation continues the sequence (#${rel.sequence}), SUPERSEDES the job change (#${job.sequence}) and carries event_at (the evidence date) apart from observed_at (when we saw it)`, JSON.stringify(rel))
    ok(m.dropped.length === 2 && m.dropped.every((d) => /never/.test(d.reason)) && !m.events.some((e) => /pregnan|hospice/.test(String(e.type))), "PRIVACY: a stored pregnancy and an incoming hospice token are DROPPED (never re-written, never mapped), with the reason", JSON.stringify(m.dropped))
    ok(m.untouched === 1 && m.events.some((e) => e.type === "something_else_entirely" && e.note === "kept"), "an element the map does not know is kept exactly as it was (not ours to drop) and counted")
    const again = voc.mergeLifeEvents(m.events, [{ type: "relocation", source_date: daysAgo(10) }], { now: NOW })
    ok(again.added.length === 0 && JSON.stringify(again.events) === JSON.stringify(m.events), "IDEMPOTENT: merging the merged history with an event it already holds changes nothing")
    const second = voc.mergeLifeEvents(m.events, [{ type: "relocation", source_date: daysAgo(1) }], { now: NOW })
    ok(second.added.length === 1 && second.added[0].supersedes === rel.sequence, "(positive control) a GENUINELY new relocation (another day) is a new record that supersedes the first one")
    const cur = voc.currentLifeEvents(second.events).map((e) => e.type)
    const chron = voc.lifeEventChronology(second.events).map((e) => e.type)
    ok(!cur.includes("job_change") && cur.filter((t) => t === "relocation").length === 1 && chron.indexOf("job_change") < chron.indexOf("relocation"), `CURRENT view: superseded records drop out (current: ${cur.join(", ")}); the chronology orders by event time (${chron.join(" → ")})`)
    ok(voc.lifeEventTypeOf({ event: "death_in_family" }) === "death_in_household" && voc.lifeEventTypeOf("wedding") === "marriage" && voc.lifeEventTypeOf(null) === null, "one reader rule for every stored shape ({ type }, { event }, a bare string)")
  }

  // ── C. EVERY WRITER MAPPED + THE BACKFILL ────────────────────────────────────────────────────────────────────────────────
  console.log("\nC. every life_events writer is mapped onto the vocabulary; m919 / m920 agree with the map")
  {
    // A `life_events:` object key in live code (strings blanked — a select list naming the column is not a write).
    const KEY = /\blife_events\s*:/
    const VOCAB_CALL = /\b(?:mergeLifeEvents|normalizeLifeEvent|canonicalLifeEventType|lifeEventTypeOf)\(/
    const files = [...walk("lib"), ...walk("app")]
    const census = files.filter((f) => KEY.test(blankStrings(src(f))))
    // Every file that writes the key, classified — the vocabulary rides the write, or it is a carry of an already-mapped column, or
    // it is not a database write at all (a type, a prompt input, an investigation payload).
    const CLASSIFIED: Record<string, string> = {
      "lib/enrichment/contact-enrichment-core.ts": "vocabulary — mergeLifeEvents (the OSINT pass, the provider profile and the life-change check)",
      "lib/lead-pipeline/enrichment-column-map.ts": "vocabulary — mergeLifeEvents at both column promotions (the profile builder keeps the provider's raw record in enrichment_profile, never the column)",
      "app/actions/lead-intelligence.ts": "vocabulary — mergeLifeEvents at the lead_people_data write; canonicalLifeEventType at the motivating-event read",
      "app/actions/contact-enrichment.ts": "carry — markLifeChangeNotified rewrites the stored elements in place (matched through lifeEventTypeOf)",
      "lib/contact-promotion/contact-creator.ts": "carry — promotion copies the lead's already-mapped column onto the new contact (m920 canonicalises any history)",
      "lib/osint-client.ts": "producer type + canonical tokens (test:movement-signals §J asserts every written token is a LifeEventType)",
      "lib/predictive-listing/signal-generators.ts": "type only — the reader reads through lifeEventTypeOf",
      "lib/sphere-resonance/run-resonance-scan.ts": "type only — the reader reads through lifeEventTypeOf",
      "lib/agentic-os/deal-investigator.ts": "not a database write — the investigation payload it hands the model",
      "lib/contacts/persona-builder.ts": "not a database write — a persona prompt input (Outside-lane: lane C — pass the tone, never the events)",
      "lib/ai-isa/ghost-reengagement.ts": "not a database write — personalization input (personalize-outreach turns events into TONE only)",
      "app/actions/ai-isa/engage-contact.ts": "not a database write — personalization input (tone only, every model draft screened)",
      "app/actions/ai-isa/initiate-engagement.ts": "not a database write — personalization input (tone only)",
      "lib/ai-isa/personalize-outreach.ts": "type only — PersonalizationInput.life_events (converted to tone + the internal screen fact)",
      "lib/lead-pipeline/material-enrichment-change.ts": "type only — reads through lifeEventTypeOf",
      "lib/external/peopledata-client.ts": "type only — the provider response shape",
      "lib/kernel/referral-radar.ts": "in-memory only — the radar's scraper merge never persists (reads through lifeEventTypeOf)",
      "lib/enrichment/intent-signal-sources.ts": "type only — reads through lifeEventTypeOf",
      "lib/intent/movement-source-watcher.ts": "reader — `c.life_events : []` is a ternary over the stored column; each element is read through canonicalLifeEventType / normalizeLifeEvent",
    }
    const unclassified = census.filter((f) => !CLASSIFIED[f])
    ok(unclassified.length === 0, `every file with a live \`life_events:\` key is classified (${census.length} found)`, unclassified.join(", "))
    const vocabWriters = Object.entries(CLASSIFIED).filter(([, why]) => /^vocabulary/.test(why)).map(([f]) => f)
    const unmapped = vocabWriters.filter((f) => !VOCAB_CALL.test(src(f)))
    ok(unmapped.length === 0 && vocabWriters.length >= 3, `every database WRITER calls the vocabulary at the write (${vocabWriters.length} writers)`, unmapped.join(", "))
    const specimen = blankStrings(stripComments("// life_events: legacy\nconst row = { life_events: provider.events }\nconst q = \"life_events: nope\""))
    ok(KEY.test(specimen) && !VOCAB_CALL.test(specimen) && !KEY.test(blankStrings(stripComments("// life_events: x\nconst q = \"life_events: y\""))), "(positive control) the census sees a live key with no vocabulary call, and ignores the same key in a comment or a string")
    ok(!/\blife_events:\s*osintData\.life_events\b/.test(src("lib/enrichment/contact-enrichment-core.ts")) && !/life_events:\s*enrichmentData\.life_events\s*\|\|\s*\[\]/.test(src("lib/enrichment/contact-enrichment-core.ts")), "the OSINT pass no longer REPLACES the stored history (`life_events: osintData.life_events` / `|| []` are gone)")
    // m920: the spelling pairs EQUAL the map's alias index
    const m920 = raw("supabase/migrations/m920-life-event-spellings-onto-chronological-vocabulary-backfill.sql")
    const pairs = new Map([...m920.matchAll(/\('([a-z0-9_]+)',\s*'([a-z0-9_]+)'\)/g)].map((x) => [x[1], x[2]]))
    const index = new Map<string, string>()
    for (const t of voc.LIFE_EVENT_TYPES) { index.set(t, t); for (const a of voc.LIFE_EVENT_VOCAB[t].aliases) index.set(a, t) }
    const diff = [...index].filter(([a, t]) => pairs.get(a) !== t).map(([a]) => a).concat([...pairs.keys()].filter((a) => !index.has(a)))
    ok(pairs.size === index.size && diff.length === 0, `m920's backfill spellings EQUAL the map's alias index (${pairs.size} pairs) — a spelling added on one side only is caught`, diff.join(", "))
    ok(/UPDATE public\.contacts c SET life_events/.test(m920) && /UPDATE public\.leads l SET life_events/.test(m920) && /'observed_at'/.test(m920) && /'event_at'/.test(m920) && /'sequence'/.test(m920) && !/DELETE FROM/i.test(m920), "m920 rewrites contacts + leads onto the map with the chronology stamps — and deletes NOTHING (prohibited tokens are listed for the owner)")
    const m919 = raw("supabase/migrations/m919-movement-signals-life-event-chronology-c20.sql")
    const checkList = (m919.match(/movement_signals_life_event_check[\s\S]*?IN \(([\s\S]*?)\)\)/)?.[1] ?? "").match(/'([a-z_]+)'/g)?.map((s) => s.slice(1, -1)) ?? []
    ok(checkList.length === voc.LIFE_EVENT_TYPES.length && voc.LIFE_EVENT_TYPES.every((t) => checkList.includes(t)), `m919's CHECK list EQUALS the canonical events (${checkList.length}) — the database spelling is generated from the map, no parallel table`)
    ok(/ADD COLUMN IF NOT EXISTS life_event/.test(m919) && /ADD COLUMN IF NOT EXISTS event_at/.test(m919) && /ADD COLUMN IF NOT EXISTS sequence/.test(m919) && /ADD COLUMN IF NOT EXISTS supersedes/.test(m919) && /REFERENCES public\.movement_signals \(id\) ON DELETE SET NULL/.test(m919) && !/CREATE TABLE/i.test(m919),
      "m919 adds life_event / event_at / sequence / supersedes (self-FK) to the C9 store — and creates no vocabulary table")
    const stamp = (p: string) => { const l1 = raw(p).split("\n")[0] ?? ""; return l1 === "-- WRITTEN, NOT APPLIED (wave 148, lane 148F) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor" || l1.startsWith("-- ── APPLIED LIVE ") }
    const migs = ["supabase/migrations/m918-market-dataset-verifications-c19.sql", "supabase/migrations/m919-movement-signals-life-event-chronology-c20.sql", "supabase/migrations/m920-life-event-spellings-onto-chronological-vocabulary-backfill.sql"]
    ok(migs.every(stamp) && !stamp("supabase/migrations/does-not-exist.sql"), "m918–m920 carry the lane stamp OR the APPLIED stamp on line 1 (the rule, not the waypoint; a missing file is caught)")
    // the life-event C9 row names only m892 ∪ m919 columns
    const cols = new Set([...raw("supabase/migrations/m892-movement-signals-c9-record.sql").matchAll(/^\s{2}([a-z_]+)\s+(?:uuid|text|timestamptz|jsonb|boolean|text\[\])/gm)].map((x) => x[1]).concat(["life_event", "event_at", "sequence", "supersedes"]))
    const d = memSupabase({ contacts: [{ id: "c1", brokerage_id: "b1", contact_type: "buyer", agent_id: null, zip_code: null, deleted_at: null }], movement_signals: [], agent_action_ledger: [] }, { uuidIds: true, stampCreatedAt: true })
    const built = mv.movementSignalFromLifeEvent({ brokerageId: "b1", contactId: "c1", event: { type: "relocation", url: "https://example.org/x", publishedDate: daysAgo(3) }, detectedAt: daysAgo(1) })
    if (built.ok) await quiet(() => mv.recordMovementSignal(d as never, built.record, { route: false, now: NOW, windowDays: 180 }))
    const row = (d.tables.movement_signals ?? [])[0] ?? {}
    const strays = Object.keys(row).filter((k) => !cols.has(k) && k !== "id" && k !== "created_at")
    ok(!!row.life_event && row.life_event === "relocation" && row.sequence === 1 && strays.length === 0, "a life-event C9 row carries life_event / event_at / sequence and names ONLY m892 ∪ m919 columns (a PGRST204 cannot hide here)", strays.join(", "))
    const desk = await mv.listMovementRecordsForLeadDesk(d as never, { brokerageId: "b1" })
    ok(desk.records[0]?.lifeEvent === "relocation" && desk.records[0]?.sequence === 1 && desk.records[0]?.supersedes === null && !!desk.records[0]?.eventAt, "the lead desk READS the chronology (life event, event time, sequence, supersedes) — the m919 columns have a product reader, not only a writer")
  }

  // ── D. RULING 17 — THE ARBITER'S LIFE-EVENT BRANCH ───────────────────────────────────────────────────────────────────────
  console.log("\nD. ruling 17 — the arbiter warms engagement without naming the event; a person is a choice, never the reflex")
  {
    const policy = policyMod.platformFollowupPolicy()
    const B = "B", C = "c-1"
    const contact = { id: C, brokerage_id: B, email: "pat@example.test", email_opt_out: false, email_unsubscribed: false, phone: "+15555550100", tcpa_consent: true, sms_opt_out: false, phone_opt_out: false, call_stop_flag: false, dnc_status: false, direct_mail_opt_out: false, mailing_address: "1 Main St", mailing_address_verified: true, opt_out_channels: [], has_login: true }
    const input = { now: NOW, subject: "contact" as const, nba: { memoryFacts: [] }, person: { contactType: "seller", persona: null, hasAssignedAgent: true }, behavior: { touchpoints7d: 0, lastTouchpointChannel: null, portalEducationViews: 0 }, transaction: null, education: null, fatigue: { riskLevel: null }, policy: { complianceHardFlag: false, allowedChannels: ["email", "sms", "phone", "direct_mail"], autoSendAllowed: true, videoAllowed: true } } as never
    const readiness = { providers: async () => ({ rows: [{ provider: "sendgrid", category: "email", ready: true }, { provider: "twilio", category: "voice_sms", ready: true }, { provider: "lob", category: "mail", ready: true }] }), budget: async () => ({ allowed: true, remainingBudget: 100 }), prices: async () => ({ email: 0.001, sms: 0.0128, phone: 0.014, voice_drop: null, direct_mail: 0.78 }) }
    const sig = (type: string, source: string | null, days = 1) => ({ id: `s-${type}-${days}`, brokerage_id: B, contact_id: C, signal_type: type, signal_strength: 70, triggered_at: daysAgo(days), isa_reactivated: false, signal_data: source ? { source } : {} })
    const run = async (o: { signals: Array<Record<string, unknown>>; contactOver?: Record<string, unknown>; authority?: { allowed: boolean; reason: string | null } | "default"; decide?: (a: { system: string; prompt: string }) => Promise<Record<string, unknown>> }) => {
      const db = memSupabase({ contacts: [{ ...contact, ...(o.contactOver ?? {}) }], signal_reactivations: o.signals, buyer_fatigue_scores: [] }, { uuidIds: true, stampCreatedAt: true })
      const recorded: Array<Record<string, any>> = []
      let system = "", prompt = "", calls = 0
      const plan = lap.planNextBestExperience(input)
      const r = await quiet(() => arb.arbitrateAndRecordExperience(db, { brokerageId: B, contactId: C, input, plan, now: NOW, policy, systemSource: "t", deliverable: arb.CONTACT_ENGAGEMENT_DELIVERABLE }, {
        decide: async (a) => { calls++; system = a.system; prompt = a.prompt; if (!o.decide) throw new Error("no model in the proof"); return (await o.decide(a)) as never },
        record: { ledger: async (ctx: Record<string, any>, f: () => Promise<unknown>) => { recorded.push(ctx); return f() }, emit: async () => ({ inserted: true }), delegate: async () => ({ ok: true, delegation: { id: "d1" } }) } as never,
        readiness: readiness as never,
        ...(o.authority === "default" ? {} : { lifeEventAuthority: async () => (o.authority as { allowed: boolean; reason: string | null }) ?? { allowed: false, reason: "not granted in the proof" } }),
      }))
      return { r, arbitration: recorded[0]?.detail?.arbitration ?? {}, system, prompt, calls }
    }
    const GROUNDED = "enrichment:movement_signals"
    const reply = (over: Record<string, unknown>) => async () => ({ optionId: "wait", channel: null, format: null, waitHours: 72, rationale: "A hard season — give them space and keep listening, with the door open.", evidence: ["lifeEvent", "signals"], confidence: 0.8, ...over })

    // 1. nothing granted, nothing confirmed → quiet monitoring or a person; the fallback is quiet monitoring
    const bare = await run({ signals: [sig("divorce_filing", null)] })
    const bm = bare.r.decision?.menu ?? []
    ok(bm.includes("wait") && bm.includes("agent_intervention") && bm.every((k) => k === "wait" || k === "agent_intervention") && bare.r.plan.chosen.kind === "wait" && bare.r.decision?.lifeEvent?.mode === "quiet_monitoring",
      "unconfirmed evidence, no autonomy grant: the menu is QUIET MONITORING or A PERSON, and with the model down quiet monitoring stands — never a person by reflex", `${JSON.stringify(bm)} · ${bare.r.plan.chosen.kind}`)
    // 2. grounded + confirmed + granted → helpful education / appropriate outreach join the menu; the model's education is honoured
    const granted = { allowed: true, reason: null }
    const full = await run({ signals: [sig("divorce_filing", GROUNDED)], authority: granted, decide: reply({ optionId: "education", channel: "email", waitHours: null, rationale: "Something useful to any homeowner, chosen for where they are — nothing about the moment itself." }) })
    const fm = full.r.decision?.menu ?? []
    ok(fm.includes("education") && fm.includes("wait") && fm.includes("agent_intervention") && full.r.decision?.source === "ai" && full.r.decision?.kind === "education" && full.r.decision?.lifeEvent?.mode === "helpful_education" && full.arbitration.life_event?.automated_help_offered === true,
      "grounded evidence with a CONFIRMED identity AND the tenant's explicit autonomy: helpful education joins the menu and the model's choice is honoured (mode helpful_education, on the ledger)", `${JSON.stringify(fm)} · ${full.r.decision?.kind} · ${full.r.decision?.fallbackReason}`)
    ok(!fm.includes("market_update") && !fm.includes("properties") && !fm.includes("video") && !fm.includes("portal_task"), "the MAP bounds it: for a divorce only education / a warm communication may be automated — no valuation nudge, no homes, no video")
    ok(full.system === arb.ARBITER_LIFE_EVENT_SYSTEM && /"lifeEvent"/.test(full.prompt) && /"automatedHelpOffered":true/.test(full.prompt) && !/divorce/i.test(JSON.stringify(full.r.decision?.lifeEvent?.tone ?? "")), "the branch decides under the expert EMPATHETIC prompt, with the life-event brief in the facts (the tone names no event)")
    // 3. confirmed evidence but NO grant → no automated help, the reason said
    const noGrant = await run({ signals: [sig("divorce_filing", GROUNDED)], authority: { allowed: false, reason: "the tenant has not explicitly granted the AI ISA autonomy" } })
    ok(!(noGrant.r.decision?.menu ?? []).includes("education") && /explicitly granted/.test(JSON.stringify(noGrant.prompt)), "confirmed evidence WITHOUT the explicit autonomy grant: no automated help — and the brief tells the model why (escalation is a choice, not a reflex)")
    // 4. granted but name-only (a public web mention) → no automated help (it may be someone else)
    const nameOnly = await run({ signals: [], contactOver: { life_events: [{ type: "divorce_filing" }], last_life_event_detected: daysAgo(2), enrichment_profile: {} }, authority: granted })
    ok((nameOnly.r.decision?.menu ?? []).every((k) => k === "wait" || k === "agent_intervention") && /identity is not confirmed/.test(nameOnly.prompt), "a NAME-ONLY public mention never earns automated help even with the grant (it may be someone else) — said in the brief", JSON.stringify(nameOnly.r.decision?.menu))
    // 5. a person is a CHOICE: the model may hand it to the agent
    const person = await run({ signals: [sig("death_in_household", GROUNDED)], authority: granted, decide: reply({ optionId: "agent_intervention", channel: "human_task", waitHours: null, rationale: "The agent knows this family personally — a short human note is what a friend would send." }) })
    ok(person.r.decision?.source === "ai" && person.r.decision?.kind === "agent_intervention" && person.r.decision?.lifeEvent?.mode === "human", "the model may CHOOSE a person (mode human) — a judgment it states, never the reflex")
    // 6. the default authority reader fails closed (no explicit managed_agents grant in this database)
    const dflt = await run({ signals: [sig("divorce_filing", GROUNDED)], authority: "default" })
    ok(!(dflt.r.decision?.menu ?? []).includes("education") && /explicitly granted|autonomy could not be read|holds the AI ISA/.test(dflt.prompt), "the DEFAULT grant reader (lib/managers/autonomy-gate.ts posture) fails closed: no explicit `autonomous` posture → no automated help", (dflt.prompt.match(/whyNotAutomated[^\]]*\]/) ?? [""])[0])
    // 7. a non-life signal is untouched (control)
    const sale = await run({ signals: [sig("home_sale_interest", null)] })
    ok((sale.r.decision?.menu ?? []).includes("market_update") && !sale.r.decision?.lifeEvent, "(control) a home-sale signal is not reshaped — no life-event guard, a market update stays on the menu")
    // 8. the prompt — the standard for every prompt (role · context · facts · decision · creative brief · escalation · compliance · contract)
    const P = arb.ARBITER_LIFE_EVENT_SYSTEM
    ok(["ROLE.", "BUSINESS CONTEXT.", "FACTS YOU MAY RELY ON", "THE DECISION YOU OWN", "WHAT 'WARM' MEANS HERE", "AUTONOMY AND EVIDENCE", "ESCALATION RULE", "COMPLIANCE BOUNDARY", "OUTPUT CONTRACT"].every((s) => P.includes(s)) && /QUIET MONITORING/.test(P) && /never be able to infer that we know/.test(P) && /about them and their emotions/.test(P),
      "ARBITER_LIFE_EVENT_SYSTEM is an expert, structured, empathetic brief (role, context, facts, decision, what warm means, autonomy + evidence, escalation, compliance, typed contract)")
    ok(/never simply handed to a person either/.test(arb.ARBITER_SYSTEM) && !/A life event \(divorce, probate, a disclosed life change\) is a person's conversation: never an automated message about it/.test(arb.ARBITER_SYSTEM), "the general arbiter prompt carries ruling 17 (the wave-147 'a person's conversation: never an automated message' sentence is gone)")
    ok(!/function narrowMenuForLifeEvent\(/.test(src("lib/ai-isa/followup-arbiter.ts")) && /function lifeEventMenu\(/.test(src("lib/ai-isa/followup-arbiter.ts")), "the wave-147 narrowing (person-or-wait) is replaced by the empathetic branch (stripped source)")
  }

  // ── E. THE OUTREACH SCREEN ───────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nE. the outreach screen — a draft naming or alluding to the event is refused (positive control)")
  {
    const named = voc.screenLifeEventOutreach("Hi Pat — so sorry to hear about the divorce. If you're thinking of selling, I can help.", { events: [{ type: "divorce_filing" }] })
    ok(!named.ok && named.hits.some((h) => h.event === "divorce_filing"), "POSITIVE CONTROL: an outreach draft containing the event word ('divorce') is REFUSED", JSON.stringify(named.hits))
    const loss = voc.screenLifeEventOutreach("Our condolences on your loss. When the estate is ready, we can list quickly.")
    ok(!loss.ok && loss.hits.length >= 2, "condolences used as an opener and an allusion to the estate are refused EVEN WHEN no event is on file (intimate words are never automated)", JSON.stringify(loss.hits))
    const tell = voc.screenLifeEventOutreach("We noticed in the public records that you recently filed for something — let's talk.")
    ok(!tell.ok && tell.hits.some((h) => h.event === "surveillance"), "a SURVEILLANCE tell ('we noticed', 'public records', 'filed for') is refused — they must never feel watched")
    const baby = voc.screenLifeEventOutreach("Congratulations on the new baby! A bigger home with a nursery?", { events: [{ type: "new_baby" }] })
    const listing = voc.screenLifeEventOutreach("3 bed, 2 bath with a sunny nursery off the primary suite.")
    ok(!baby.ok && listing.ok, "a protected-proxy event is screened when the person carries it ('baby', 'nursery'); the same word in a listing for someone who does not is a room, not an allusion (control)")
    const job = voc.screenLifeEventOutreach("Congrats on the new job! Happy to send some homes near the office.", { events: [{ type: "job_change" }] })
    const jobDisclosed = voc.screenLifeEventOutreach("Congrats on the new job! Happy to send some homes near the office.", { events: [{ type: "job_change" }], selfDisclosed: ["job_change"] })
    ok(!job.ok && jobDisclosed.ok, "a career event the person did NOT tell us is never mentioned; one they told us themselves may be acknowledged (control)")
    const clean = voc.screenLifeEventOutreach("Hi Pat — I put together a short seasonal home-care checklist and a few trusted local services. No rush at all; reply anytime.", { events: [{ type: "divorce_filing" }, { type: "death_in_household" }] })
    ok(clean.ok, "(control) warm, event-agnostic help passes the screen", JSON.stringify(clean.hits))
    // personalize-outreach: life events are TONE only; a model draft naming the event is replaced
    const facts = po.buildPersonalizationFacts({ first_name: "Pat", city: "Austin", life_events: [{ type: "divorce" }, { type: "new_baby" }] })
    const [sysMsg, userMsg] = po.buildOutreachPrompt(facts, { channel: "sms" }).map((m) => m.content)
    ok(facts.some((f) => f.key === "tone") && !facts.some((f) => f.key === "life_event") && !/divorc|baby|life transition|growing family/i.test(userMsg) && !/_life_events|internal/.test(userMsg) && /Never mention, allude to/.test(sysMsg),
      "no copy FACT names a life event any more (was 'Recent life event'); the event shapes only the TONE and an internal screen fact the prompt never shows; the system prompt carries the universal rule", userMsg.slice(0, 400))
    const det = po.buildDeterministicCopy(facts, "sms", "Pat")
    ok(!voc.screenLifeEventOutreach(det.body, { events: [{ type: "divorce_filing" }, { type: "new_baby" }] }).hits.length && !/recent/i.test(det.body), "the deterministic copy carries no life-event hook ('with your recent …' is gone) and passes the screen", det.body)
    const bad = await po.personalizeOutreach({ facts, channel: "sms", firstName: "Pat" }, { gatewayFn: (async () => ({ ok: true, content: "Hi Pat! Sorry to hear about the divorce — want to talk about selling?" })) as never, model: "test" })
    ok(bad.source === "deterministic_fallback" && bad.lifeEventScreen?.refused === true && !/divorc/i.test(bad.body), "POSITIVE CONTROL (end to end): a MODEL draft naming the divorce is REFUSED and the deterministic copy goes instead, the refusal said", JSON.stringify(bad))
    const good = await po.personalizeOutreach({ facts, channel: "sms", firstName: "Pat" }, { gatewayFn: (async () => ({ ok: true, content: "Hi Pat — a short checklist of trusted local services, in case it's useful. No rush." })) as never, model: "test" })
    ok(good.source === "gateway" && !good.lifeEventScreen, "(control) a warm, event-agnostic model draft passes and is sent as written")
  }

  // ── F. THE C19 SURFACES ──────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nF. the C19 surfaces — the door, the feed observation, the chokepoint")
  {
    const act = src("app/actions/movement-signals.ts")
    const body = act.slice(act.indexOf("function listMovementSignalsAction("), act.indexOf("function markMovementSignalOutcomeAction("))
    const gate = body.search(/await leadDeskSeat\(\)/), dvi = body.search(/import\("@\/lib\/intent\/dataset-verification"\)/)
    ok(gate >= 0 && dvi > gate && /listMarketDatasetVerifications\(/.test(body) && /verifications=\{result\.verifications\}/.test(src("app/dashboard/intelligence/movement-signals/page.tsx")), "the lead desk's door reads the dataset verifications AFTER its seat gate, and the screen renders them (the m918 table's user door)")
    ok(/ttlDays:\s*VERIFICATION_TTL_DAYS/.test(body) && /defaultMaxLagDays:\s*DEFAULT_MAX_LAG_DAYS/.test(body) && /verificationPolicy\.ttlDays/.test(src("app/dashboard/intelligence/movement-signals/movement-signals-client.tsx")), "the rule the statuses are judged by (TTL, default freshness window) reaches the screen FROM the module — the page restates no number")
    const cron = src("app/api/cron/permit-signal-scan/route.ts")
    ok(/recordDatasetObservations\(supabase,\s*\{\s*probes:\s*\[\.\.\.datasetHealth\.values\(\)\]/.test(cron) && !/recordDatasetObservations\(/.test(stripComments("// recordDatasetObservations(supabase, { probes: [] })")), "the daily permit sweep records ONE feed observation per dataset (positive control: a commented call is not a call)")
    const sig = src("lib/intent/movement-signals.ts")
    ok(/datasetCeilingWithObservations\(svc,\s*built\.record\.datasetKey/.test(sig) && /code:\s*"dataset_unverified"/.test(sig), "the ONE persistence chokepoint (recordMovementSignal) asks the dataset ceiling and refuses an intimate topic on an unverified dataset")
  }

  console.log("\n  BLIND SPOTS (published):")
  console.log("   · memSupabase has no RLS / CHECK / FK / trigger — m918–m920's refusals are each migration's VERIFY block, for the integrator.")
  console.log("   · The model, the autonomy grant and the gateway are INJECTED; the prompts are checked structurally, the live model's empathy is not measured.")
  console.log("   · The screen is lexical: a paraphrase that alludes to an event without any listed word (\"I know things have been hard\") passes it; the prompts carry the rule first.")
  console.log("   · The writer census finds `life_events:` object keys; a write through a computed key or a raw SQL string is not seen.")
  console.log("   · Dataset verifications are dated reads (2026-11-01); a feed that changes shape between sweeps is seen at the next sweep, not before.")

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ❌ LIFE_EVENT_ENGAGEMENT_FAIL"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ LIFE_EVENT_ENGAGEMENT_PASS — one chronological vocabulary; every writer on it; the arbiter warms engagement without naming the event; a draft that names it is refused")
}

main().catch((e) => { console.error(e); process.exit(1) })
