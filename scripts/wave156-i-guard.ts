#!/usr/bin/env tsx
/**
 * scripts/wave156-i-guard.ts — wave 156, lane 156I: GROUNDED MARKET INTELLIGENCE THAT CLOSES BUSINESS LOOPS.
 *
 * Every existing signal carries field-level evidence and reaches a consumed action; no signal turns an anonymous observation
 * into a named person. The guard DRIVES the real exported doors (scripts/in-memory-supabase.ts, counted provider stubs — no
 * portal, search provider or model is ever reached) and asserts the RULE each directive proof names:
 *
 * §A  PERMITS (directive row 1) — lib/external/permit-signals.ts ingestPermitSignals, end to end:
 *     A1 a fresh, source-dated permit at a contact's address lands as ONE signal whose signal_details.evidence carries the
 *        source (dataset + record id), the source's own event date, confidence, usage rights, the dedup key, its consumers and
 *        the sentence that a permit never means the owner is moving;
 *     A2 a WITHDRAWN permit (a superseded / contradicted record) at another contact's address is NOT filed and is counted;
 *        an "Active" one is (positive control); every status column the matcher reads is DERIVED from comment-stripped source;
 *     A3 NO DOWNLOAD WITHOUT RECORDED RIGHTS — a queryable dataset with no license read is never fetched (0 provider calls);
 *        the same dataset with its license is fetched once (positive control);
 *     A4 a second run of the same permits files nothing new (no duplicate signal).
 * §B  THE PERSON PATH (directive row 5, canary C18) — lib/acquisition-plays/public-request.ts runPublicRequestPlay with counted
 *     ingest / dedup / arbiter seams: an adult's first-person need with a contact point they published on a permitted page
 *     becomes ONE Raw Lead (positive control); the same statement from an author who says they are 16 does not; an anonymous
 *     forum post and an anonymous search-trend page never yield a person; authorStatesMinor on a derived phrase table.
 * §C  TOPICS (rows 6–7, canary C19) — lib/content-intel/topic-intake.ts intakeTopicIdeas: a competitor's "welcome our newest
 *     agent" post never reaches the topic bank; an unmeasured "everyone is asking" claim is refused; a topic carrying a phone
 *     number is refused; the same consumer question observed twice is ONE topic (no duplicate campaign seed).
 * §D  TWO TENANTS, ONE SIGNAL, DIFFERENT LOCAL COPY — lib/repurpose/refurbish-idea.ts buildRefurbishIdeaBrief +
 *     composeRefurbishPrompt with each sender's renderSenderVoiceBrief (lib/kernel/brand-voice.ts): each first-generation
 *     prompt carries its own brand, place and sourced local fact and none of the other tenant's.
 * §E  ONLY GENUINE OUTCOMES ARE ATTRIBUTED (row 8) — refurbishRetestDecision / refurbishTriggerVerdict never call an
 *     unmeasured piece a win or an unmeasured baseline an under-performer.
 * §F  THE AGENT'S OPPORTUNITY (rows 4 / 9) — lib/kernel/listing-propensity.ts runListingPropensity: one gated brief per agent
 *     per week naming the homeowner, the observed evidence and the next step; a second run proposes nothing; a REFUSED dedup
 *     read proposes nothing (it used to file a duplicate). lib/ai-isa/transaction-propensity.ts rankContactsByPropensity:
 *     a contact whose only "signal" is a system write (updated_at) scores 0 — the dialer ranks on observed facts only.
 *
 * RED AT BASE: WAVE156_I_ROOT=<the starting tree> npx tsx scripts/wave156-i-guard.ts — modules load from that tree.
 *
 * BLIND SPOTS (published). The in-memory client has no row security, CHECKs or unique indexes (m490's index is not modelled;
 * the read-back dedup is what A4 drives). The permit status column names are the portals' published schemas, not a live
 * re-read. §B's minor screen reads only what an author SAYS about their age — an author who states nothing is neither adult
 * nor minor to this rule. §D shows the PROMPT the first draft is generated from, not a model's output (no model is called).
 * §F's proposal door (lib/agents/agent-client-messages.ts) is a counted stub that files the row; its own gates are its proof.
 * The local-event cancellation path (lib/newsletter/local-events.ts) and the PCS planner are covered by their own guards and
 * are named, not re-driven, here.
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync, statSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { memSupabase, type MemClient } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

const WT = process.cwd()
const ROOT = process.env.WAVE156_I_ROOT || WT
let passed = 0, failed = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 400)}`}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (f: string): string => { const p = join(ROOT, f); return existsSync(p) ? readFileSync(p, "utf8") : "" }

// ── module hooks: "@/x" resolves under ROOT; provider / session seams are counted stubs ─────────────────────────────────────
const G = globalThis as any
G.__I = { socrata: [] as string[], arcgis: [] as string[], permitRows: [] as any[], proposals: [] as any[] }
const realUrl = (p: string) => pathToFileURL(join(ROOT, p)).href
const OVERRIDE: Record<string, string> = {
  // The two permit portals — COUNTED; no portal is ever reached.
  "lib/external/socrata-client.ts": "export async function recentPermits(a){ globalThis.__I.socrata.push(a.datasetId); return { ok: true, status: 200, data: globalThis.__I.permitRows.map((r) => ({ ...r })), error: null } }",
  "lib/external/arcgis-permits.ts": "export async function recentArcgisPermits(a){ globalThis.__I.arcgis.push(a.serviceUrl); return { ok: true, status: 200, data: [], error: null } }",
  "lib/supabase/service.ts": "export function createServiceClient(){ throw new Error('fixture: the guard hands every door its client') }",
  "lib/supabase/server.ts": "export async function createClient(){ throw new Error('fixture: no session client') }",
}
const REPLACE: Record<string, string> = {
  // The proposal rail — counted; it files the row on the client it is handed so the next run's dedup read can see it.
  "lib/agents/agent-client-messages.ts": "export async function proposeClientMessage(input, client){ globalThis.__I.proposals.push(input); const { data, error } = await client.from('agent_client_messages').insert({ brokerage_id: input.brokerageId, agent_kind: input.agentKind, entity_type: input.entityType, entity_id: input.entityId, audience: input.audience, subject: input.subject, body: input.body, rationale: input.rationale, status: 'proposed' }).select('id'); return error ? { ok: false, error: error.message } : { ok: true, id: (data ?? [])[0]?.id } }",
}
const BY_SPEC: Record<string, string> = {
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
  "next/headers": "export async function headers(){ return new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] }, set(){}, delete(){} } }",
}
const dataUrl = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`
function aliasPath(rel: string): string | null {
  for (const c of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`, `${rel}/index.tsx`]) {
    const p = join(ROOT, c)
    if (existsSync(p) && !statSync(p).isDirectory()) return p
  }
  return null
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (BY_SPEC[spec] !== undefined) return { url: dataUrl(BY_SPEC[spec]), shortCircuit: true }
    const aliased = spec.startsWith("@/") ? aliasPath(spec.slice(2)) : null
    const r = aliased ? { url: pathToFileURL(aliased).href, shortCircuit: true } : next(spec, ctx)
    if (String(ctx?.parentURL ?? "").startsWith("data:")) return r
    const path = String(r.url ?? "").split("?")[0]
    const rep = Object.keys(REPLACE).find((k) => path === realUrl(k))
    if (rep) return { url: dataUrl(REPLACE[rep]), shortCircuit: true }
    const ov = Object.keys(OVERRIDE).find((k) => path === realUrl(k))
    if (ov) return { url: dataUrl(`export * from ${JSON.stringify(realUrl(ov))}; ${OVERRIDE[ov]}`), shortCircuit: true }
    return r
  },
})
const load = (p: string) => import(pathToFileURL(join(ROOT, p)).href)

const NOW = new Date()
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000)
const B1 = "00000000-0000-4000-8000-0000000000b1"

// ══ §A PERMITS ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionA() {
  section("§A permits: rights before download, superseded permits suppressed, field-level evidence")
  const ps = await load("lib/external/permit-signals.ts")
  const reg = await load("lib/external/socrata-market-registry.ts")
  const austin = (reg.getMarketDatasets({ state: "TX", city: "Austin" }) as any[]).find((d) => d.kind === "permits" && !d.unavailable && d.licence)
  check("fixture: the registry's Austin permit dataset is licensed and queryable (positive control for the fixture itself)", !!austin && !!austin.dateColumn, austin?.datasetId)
  if (!austin) return
  const covered = (spec: any) => () => ({ state: "TX", city: "Austin", market: "TX:Austin", status: "covered", ingestible: [spec], queryable: [spec], reasons: [] })
  const territories = [{ state: "TX", city: "Austin" }]
  const sinceIso = daysAgo(14).toISOString().slice(0, 10)
  const issued = (d: number) => `${daysAgo(d).toISOString().slice(0, 10)}T00:00:00.000`
  G.__I.permitRows = [
    { permit_number: "2026-000111 BP", issue_date: issued(3), original_address1: "100 MAIN ST", description: "Kitchen remodel and interior paint", status_current: "Active" },
    { permit_number: "2026-000222 BP", issue_date: issued(4), original_address1: "200 OAK AVE", description: "Roof replacement", status_current: "Withdrawn" },
  ]
  const db: MemClient = memSupabase({
    leads: [],
    contacts: [
      { id: "c-100", brokerage_id: B1, address: "100 Main St", deleted_at: null },
      { id: "c-200", brokerage_id: B1, address: "200 Oak Ave", deleted_at: null },
      { id: "c-other", brokerage_id: "other-tenant", address: "100 Main St", deleted_at: null },
    ],
    motivated_seller_signals: [],
  })

  // A1 + A2 — one run.
  G.__I.socrata.length = 0
  const r1 = await ps.ingestPermitSignals({ supabase: db, brokerageId: B1, territories, sinceIso, coverage: covered(austin) })
  const rows = db.tables.motivated_seller_signals ?? []
  const ev = rows[0]?.signal_details?.evidence
  check("A1 the licensed dataset is fetched exactly once (counted stub — no portal reached)", G.__I.socrata.length === 1, G.__I.socrata)
  check("A1 the fresh permit at the contact's address lands as ONE signal on that contact, in this tenant", rows.length === 1 && rows[0].contact_id === "c-100" && rows[0].brokerage_id === B1, rows.map((r: any) => [r.contact_id, r.brokerage_id]))
  check("A1 another tenant's contact at the same address is never matched", !rows.some((r: any) => r.contact_id === "c-other"))
  check("A1 evidence: the source dataset and record id", ev?.source?.dataset === `${austin.host}/${austin.datasetId}` && ev?.source?.record_id === "2026-000111 BP", ev?.source)
  check("A1 evidence: the source's own event date (not the run date)", ev?.source_event_date === issued(3).slice(0, 10), ev?.source_event_date)
  check("A1 evidence: usage rights = the registry licence as read", ev?.usage_rights?.class === austin.licence.class && ev?.usage_rights?.read_on === austin.licence.readOn, ev?.usage_rights)
  check("A1 evidence: confidence separates the verified record from the circumstantial seller reading", ev?.confidence?.record === "verified_issuer_record" && ev?.confidence?.seller_reading === "circumstantial", ev?.confidence)
  check("A1 evidence: the dedup key equals the row's dedupe_key", typeof ev?.dedup_key === "string" && ev.dedup_key === rows[0]?.signal_details?.dedupe_key)
  check("A1 evidence: the consumed action is named (the readers of motivated_seller_signals)", Array.isArray(ev?.consumed_by) && ev.consumed_by.length >= 1, ev?.consumed_by)
  check("A1 evidence: a permit never claims the owner is moving", /never says the owner is moving/.test(String(ev?.person_inference ?? "")))
  check("A2 the WITHDRAWN permit is not filed (a superseded record never drives a seller signal)", !rows.some((r: any) => r.contact_id === "c-200"), rows.map((r: any) => r.contact_id))
  check("A2 …and it is counted, not silently dropped", r1.skippedSuperseded === 1, { skippedSuperseded: r1.skippedSuperseded })

  // A2 — the vocabulary, over every status column the matcher reads (DERIVED from comment-stripped source).
  const src = stripComments(raw("lib/external/permit-signals.ts"))
  const keysBlock = /const PERMIT_STATUS_KEYS = \[([\s\S]*?)\]/.exec(src)?.[1] ?? ""
  const keys = [...keysBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  check("A2 derived: the matcher's permit-status columns are read from source (non-empty)", keys.length >= 3, keys)
  for (const k of keys) {
    const withdrawn = ps.matchPermitsToLeads?.([{ permit_number: "X1", original_address1: "100 MAIN ST", [k]: "Permit Withdrawn" }], [{ id: "c-100", address: "100 Main St", entity: "contact" }])
    const active = ps.matchPermitsToLeads?.([{ permit_number: "X1", original_address1: "100 MAIN ST", [k]: "Issued" }], [{ id: "c-100", address: "100 Main St", entity: "contact" }])
    check(`A2 column "${k}": "Permit Withdrawn" is superseded, "Issued" still matches (positive control)`, withdrawn?.matches.length === 0 && withdrawn?.skippedSuperseded === 1 && active?.matches.length === 1, { w: withdrawn?.matches.length, a: active?.matches.length })
  }
  const reason = ps.permitSupersededReason
  check("A2 vocabulary: void / cancelled / revoked / expired / denied supersede; finaled / active / blank do not",
    typeof reason === "function" && ["VOID", "Cancelled", "Revoked", "Permit Expired", "Denied"].every((s) => !!reason(s)) && ["Finaled", "Active", "Permit Issued", "", null].every((s) => reason(s) === null))

  // A3 — rights unknown → zero provider calls; positive control: the same spec with its licence is fetched.
  const unlicensed = { ...austin, licence: undefined }
  G.__I.socrata.length = 0
  const db3 = memSupabase({ leads: [], contacts: [{ id: "c-100", brokerage_id: B1, address: "100 Main St", deleted_at: null }], motivated_seller_signals: [] })
  const r3 = await ps.ingestPermitSignals({ supabase: db3, brokerageId: B1, territories, sinceIso, coverage: covered(unlicensed) })
  check("A3 a dataset with no license read is NEVER downloaded (0 provider calls)", G.__I.socrata.length === 0, G.__I.socrata)
  check("A3 …it is refused by name, and nothing is written", r3.datasetsSkippedRightsUnknown === 1 && (r3.rightsUnknownReasons ?? []).length === 1 && (db3.tables.motivated_seller_signals ?? []).length === 0, { n: r3.datasetsSkippedRightsUnknown, why: r3.rightsUnknownReasons })
  const unknownClass = { ...austin, licence: { class: "unknown", text: "not read", readOn: "2026-11-25" } }
  G.__I.socrata.length = 0
  await ps.ingestPermitSignals({ supabase: memSupabase({ leads: [], contacts: [], motivated_seller_signals: [] }), brokerageId: B1, territories, sinceIso, coverage: covered(unknownClass) })
  check("A3 a licence recorded as \"unknown\" is refused the same way", G.__I.socrata.length === 0, G.__I.socrata)
  G.__I.socrata.length = 0
  await ps.ingestPermitSignals({ supabase: memSupabase({ leads: [], contacts: [{ id: "c-100", brokerage_id: B1, address: "100 Main St", deleted_at: null }], motivated_seller_signals: [] }), brokerageId: B1, territories, sinceIso, coverage: covered(austin) })
  check("A3 POSITIVE CONTROL: the same dataset WITH its licence is fetched", G.__I.socrata.length === 1, G.__I.socrata)

  // A4 — a repeated signal files nothing new.
  const before = (db.tables.motivated_seller_signals ?? []).length
  const r4 = await ps.ingestPermitSignals({ supabase: db, brokerageId: B1, territories, sinceIso, coverage: covered(austin) })
  check("A4 the same permits on the next run file nothing new (no duplicate signal)", (db.tables.motivated_seller_signals ?? []).length === before && r4.alreadyRecorded === 1 && r4.signalsWritten === 0, { before, after: (db.tables.motivated_seller_signals ?? []).length, r4: r4.alreadyRecorded })
}

// ══ §B THE PERSON PATH ═════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionB() {
  section("§B the person path: first-person + published contact + rights + age; anonymous never becomes a person (C18)")
  const pr = await load("lib/acquisition-plays/public-request.ts")
  const stmt = await load("lib/acquisition-plays/public-statement.ts")
  const ingested: any[] = []
  const deps = {
    ingest: async (p: any) => { ingested.push(...p.records.map((r: any) => ({ ...r, __subject: r.envelope?.subjectKind }))); return { inserted: p.records.length, replayed: 0, skipped_territory: 0, skipped_stale: 0, skipped_refused: 0 } },
    findContact: async () => ({ contactId: null, error: null }),
    respond: async () => { throw new Error("fixture: no existing contact in this scenario") },
    loadKnown: async () => ({ sourceRecordIds: new Set<string>(), personKeys: new Set<string>(), propertyKeys: new Set<string>(), priorProviderResults: new Map(), scope: { brokerageId: B1, includesPlatformPool: false } }),
  }
  const market = { id: "m-austin", brokerage_id: B1, name: "Austin", city: "Austin", state: "TX", zip_codes: [] }
  const res = (id: string, url: string, text: string, author: string | null = null) => ({ id, url, title: null, text, author, publishedDate: daysAgo(2).toISOString(), highlights: null, extracted: null, publisher: null })
  const results = [
    res("r-adult", "https://austin.craigslist.org/hsw/d/austin-wanted-home/7000000001.html", "We are looking to buy a house in Austin this year. Please email me at jane.buyer@example.com with any homes."),
    res("r-minor", "https://austin.craigslist.org/hsw/d/austin-first-home/7000000002.html", "I'm 16 and looking to buy a house in Austin this year. Email me at teen.buyer@example.com please."),
    res("r-forum", "https://www.reddit.com/r/Austin/comments/abc123/buying_advice/", "We are looking to buy a house in Austin this year, any advice on neighborhoods?", "u_quiet_handle"),
    res("r-trend", "https://trends.google.com/trends/explore?geo=US-TX&q=homes%20for%20sale%20austin", "Interest over time for homes for sale austin, Texas."),
  ]
  const out = await pr.runPublicRequestPlay({ from: () => { throw new Error("fixture: no direct reads") } }, { market, hunt: null, results, now: NOW }, deps)
  const persons = ingested.filter((r) => r.__subject === "person")
  check("B POSITIVE CONTROL: the adult's own need + the contact point they published becomes ONE Raw Lead", persons.length === 1 && persons[0].email === "jane.buyer@example.com", persons.map((p) => p.email))
  check("B the author who says they are 16 is NOT filed as a person (age check)", !ingested.some((r) => r.email === "teen.buyer@example.com"), ingested.map((r) => [r.__subject, r.email]))
  check("B …and the refusal names the rule", (out.refused ?? []).some((x: any) => /under 18/.test(String(x.why))), (out.refused ?? []).map((x: any) => x.why))
  check("B C18: the anonymous forum post never yields a named person (no person row, no handle carried as identity)", !persons.some((p) => /reddit\.com/.test(String(p.sourceUrl))) && !ingested.some((r) => r.__subject === "person" && JSON.stringify(r).includes("u_quiet_handle")))
  check("B C18: an anonymous search-trend page never yields a person", !persons.some((p) => /trends\.google/.test(String(p.sourceUrl))))
  check("B no record outside the person path carries an email or phone", ingested.filter((r) => r.__subject !== "person").every((r) => !r.email && !r.phone))
  const minor = stmt.authorStatesMinor
  const yes = ["I'm 16 and want to buy my first house", "I am 17 years old and saving for a condo", "im 15 y/o", "I'm a minor but my parents want to sell", "I'm in high school and curious about buying"]
  const no = ["I'm 34 and relocating for work", "I'm 5 minutes from downtown", "I'm 9 years into my career", "My son is 16 and we are moving", "I'm 8 months pregnant and we need a bigger home", "I'm 150k pre-approved"]
  check("B authorStatesMinor: the author's own statements of being under 18 are read", typeof minor === "function" && yes.every((t) => minor(t) === true), yes.filter((t) => !(typeof minor === "function" && minor(t))))
  check("B authorStatesMinor POSITIVE CONTROL: an adult age, a distance, a career length, a third party's age and an amount are not", typeof minor === "function" && no.every((t) => minor(t) === false), no.filter((t) => typeof minor === "function" && minor(t)))
}

// ══ §C TOPICS ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionC() {
  section("§C topics: competitor identity announcements excluded; no unmeasured popularity; no personal data; one idea, one topic (C19)")
  const ti = await load("lib/content-intel/topic-intake.ts")
  const db = memSupabase({ content_topic_bank: [], content_topic_sources: [{ id: "src-1", brokerage_id: B1, is_active: true }] })
  const base = { observedAt: NOW.toISOString(), publishedAt: daysAgo(5).toISOString(), rights: "public_read_reworded", sourceId: "src-1" }
  const joining = { ...base, sourceKind: "competitor_ad", title: "Please welcome our newest agent Sam Rivera to the team!", evidence: { kind: "proxy", metric: "search_relevance_recency", value: 95, unit: "search_relevance_0_100" } }
  const question = { ...base, sourceKind: "community_post", title: "How do property taxes change after you buy a home in Austin?", geo: { city: "Austin", state: "TX" }, evidence: { kind: "proxy", metric: "x", value: 40, unit: "score_0_100" }, dedupKey: "guard156i:property-taxes-austin" }
  const trend = { ...base, sourceKind: "community_post", title: "Everyone is asking about flood insurance in Austin", evidence: { kind: "unknown" } }
  const personal = { ...base, sourceKind: "community_post", title: "Call Jane at 512-555-0101 about selling her Austin house", evidence: { kind: "unknown" } }
  const g = ti.classifyTopicExclusion({ title: joining.title, sourceKind: "competitor_ad" })
  check("C the exclusion gate names a competitor's agent-joining post — even at a 95 search rank", g.excluded && g.reason === "competitor_agent_joining", g)
  check("C POSITIVE CONTROL: a consumer question passes the gate", ti.classifyTopicExclusion({ title: question.title }).excluded === false)
  const r1 = await ti.intakeTopicIdeas(db, { brokerageId: B1, ideas: [joining, question, trend, personal], now: NOW })
  const reasons = Object.fromEntries((r1.excluded ?? []).map((e: any) => [e.title.slice(0, 20), e.reason]))
  check("C the joining announcement never reaches content_topic_bank", !(db.tables.content_topic_bank ?? []).some((r: any) => /welcome|newest agent/i.test(String(r.topic_title))), reasons)
  check("C an unmeasured popularity claim is refused (no invented 'viral')", (r1.excluded ?? []).some((e: any) => e.reason === "unmeasured_trend_claim"), reasons)
  check("C a topic carrying a phone number is refused (no person in the pool)", (r1.excluded ?? []).some((e: any) => e.reason === "personal_data_in_topic"), reasons)
  check("C POSITIVE CONTROL: the consumer question is stored once", r1.inserted === 1 && (db.tables.content_topic_bank ?? []).length === 1, { inserted: r1.inserted, errors: r1.errors })
  const r2 = await ti.intakeTopicIdeas(db, { brokerageId: B1, ideas: [{ ...question, observedAt: new Date(NOW.getTime() + 60_000).toISOString() }], now: NOW })
  check("C the same idea observed again is MERGED into the one topic — no second campaign seed", r2.inserted === 0 && r2.merged === 1 && (db.tables.content_topic_bank ?? []).length === 1, { inserted: r2.inserted, merged: r2.merged, n: (db.tables.content_topic_bank ?? []).length })
}

// ══ §D TWO TENANTS ═════════════════════════════════════════════════════════════════════════════════════════════════════════
function voiceBrief(o: { brokerageId: string; name: string; brand: string; tone: string; city: string; word: string }) {
  return {
    schema: "sender_voice_brief.v1", version: `v1:${o.brokerageId.slice(-6)}`, compiledAt: NOW.toISOString(),
    scope: { brokerageId: o.brokerageId, teamId: null, agentUserId: null, agentId: null },
    sender: { name: o.name, brandName: o.brand, teamName: null, level: "agent" },
    tone: o.tone, formality: null, personality: null, style: null, tagline: null, taglineSource: null, missionStatement: null, keyMessages: [],
    preferredWords: [o.word], prohibitedWords: [], signature: { text: null, source: null }, writingSamples: [], hasWritingSample: false,
    styleNotes: null, customInstructions: null, contentGuidelines: null, targetAudience: null,
    positioning: { bio: null, specializations: [], languages: [], licenseLine: null }, localExpertise: { areas: [], cityState: o.city },
    identity: { personaLabel: null, followupStyle: null }, sources: ["brand_voice_profile.tone@agent"], readErrors: [],
  }
}
async function sectionD() {
  section("§D two tenants, one signal: each first draft is written in its own brand and place")
  const ri = await load("lib/repurpose/refurbish-idea.ts")
  const bv = await load("lib/kernel/brand-voice.ts")
  const ti = await load("lib/content-intel/topic-intake.ts")
  const signal = { kind: "google_trend", url: null, platform: null, contentType: null, untrustedText: null, topics: ["flood insurance"], hookType: "question" }
  const evidence = ri.labelCompetitorEvidence({ likesCount: null, commentsCount: null, sharesCount: null, viewsCount: null, engagementRate: null, engagementSource: null })
  const tenants = [
    { id: "00000000-0000-4000-8000-0000000000a1", name: "Dana Cole", brand: "Gulf Coast Homes", tone: "warm", city: "Pensacola, FL", word: "neighbor", fact: { fact: "Escambia County's flood-zone map update took effect this year", source: "escambia county planning (fixture)", asOf: "2026-10-01" } },
    { id: "00000000-0000-4000-8000-0000000000a2", name: "Riley Shaw", brand: "Summit Realty", tone: "direct", city: "Denver, CO", word: "mountain", fact: { fact: "Denver's floodplain permit fee schedule changed this year", source: "denver community planning (fixture)", asOf: "2026-09-15" } },
  ]
  const prompts: string[] = []
  for (const t of tenants) {
    const b = ri.buildRefurbishIdeaBrief({ exclude: (i: any) => ti.classifyTopicExclusion(i) }, { source: { ...signal, geoLabel: t.city }, evidence, rights: "idea_only", audience: { label: null }, localFacts: [t.fact], ownAssets: [], availableFormats: [] })
    const p = b.ok ? ri.composeRefurbishPrompt({ mode: "idea_only", format: "facebook_post", voiceBriefText: bv.renderSenderVoiceBrief(voiceBrief({ brokerageId: t.id, ...t })), themFirstText: "", brief: b.brief, reusableSourceText: null, sourceLabel: "search topic" }) : ""
    prompts.push(p)
  }
  const [a, b] = prompts
  check("D tenant A's prompt carries A's brand, place and sourced local fact", a.includes("Gulf Coast Homes") && a.includes("Pensacola") && a.includes("Escambia County"))
  check("D tenant B's prompt carries B's brand, place and sourced local fact", b.includes("Summit Realty") && b.includes("Denver") && b.includes("floodplain permit fee"))
  check("D neither prompt carries the other tenant's brand, place or fact", !a.includes("Summit Realty") && !a.includes("Denver") && !b.includes("Gulf Coast Homes") && !b.includes("Pensacola"))
  check("D the voice leads the first draft (the sender brief is the prompt's opening)", a.startsWith("SENDER VOICE BRIEF") && b.startsWith("SENDER VOICE BRIEF"))
  check("D the same signal produced different copy instructions (not one generic draft)", a !== b && a.length > 0)
}

// ══ §E ATTRIBUTION ═════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionE() {
  section("§E only genuine outcomes are attributed")
  const ri = await load("lib/repurpose/refurbish-idea.ts")
  const published = { published: true, state: "published", why: "provider acknowledged (fixture)" }
  check("E a published piece with no measured outcome is not a win", ri.refurbishRetestDecision({ publication: published, measuredRate: null, baselineRate: 0.02 }).decision === "awaiting_measurement")
  check("E a measured piece with no tenant baseline is not a win either", ri.refurbishRetestDecision({ publication: published, measuredRate: 0.05, baselineRate: null }).decision === "awaiting_measurement")
  check("E POSITIVE CONTROL: measured at or above the tenant's own baseline is kept", ri.refurbishRetestDecision({ publication: published, measuredRate: 0.05, baselineRate: 0.02 }).decision === "keep")
  check("E an unmeasured own piece is never assumed to under-perform", ri.refurbishTriggerVerdict({ kind: "own_underperformer", own: { measuredRate: null, baselineRate: 0.02 } }).start === false)
  check("E an unpublished piece is never counted", ri.refurbishRetestDecision({ publication: { published: false, state: "awaiting_provider", why: "no ack" }, measuredRate: 0.9, baselineRate: 0.01 }).decision === "not_published")
}

// ══ §F THE AGENT'S OPPORTUNITY ═════════════════════════════════════════════════════════════════════════════════════════════
async function sectionF() {
  section("§F the agent receives a real opportunity with evidence and the next step — once; the dialer ranks on observed facts")
  const lp = await load("lib/kernel/listing-propensity.ts")
  const seed = () => ({
    brokerages: [{ id: B1 }],
    home_value_estimates: [1, 2, 3].map((i) => ({ contact_id: "c-1", brokerage_id: B1, estimated_equity: 250_000, generated_at: daysAgo(i * 5).toISOString() })),
    contacts: [{ id: "c-1", brokerage_id: B1, first_name: "Pat", last_name: "Owner", contact_type: "past_client", agent_id: "agent-1" }],
    call_analyses: [{ contact_id: "c-1", brokerage_id: B1, intent_primary: "sell_home", created_at: daysAgo(10).toISOString() }],
    agent_client_messages: [] as any[],
  })
  G.__I.proposals.length = 0
  const db = memSupabase(seed())
  await lp.runListingPropensity(db, NOW)
  const p = G.__I.proposals[0]
  check("F one gated brief is proposed to the owning agent", G.__I.proposals.length === 1 && p?.entityType === "agent" && p?.entityId === "agent-1" && p?.audience === "agent", G.__I.proposals.map((x: any) => [x.entityType, x.entityId]))
  // The brief line names each homeowner's TOP TWO reasons (composePropensityBrief slices two); the full reason list rides the score.
  check("F the brief carries the record-backed evidence (the home-value checks on file, the equity on that check)", /checked their home's value 3/.test(String(p?.body)) && /estimated equity/.test(String(p?.body)), p?.body)
  check("F the brief names the next step (approve → the Listing Concierge's pre-list play)", /approve and the Listing Concierge starts the pre-list play/.test(String(p?.body)))
  await lp.runListingPropensity(db, NOW)
  check("F a second run in the same week proposes nothing (no duplicate campaign)", G.__I.proposals.length === 1, G.__I.proposals.length)
  G.__I.proposals.length = 0
  const refused = memSupabase(seed(), { refuse: { agent_client_messages: "permission denied (fixture)" } })
  const rr = await lp.runListingPropensity(refused, NOW)
  check("F a REFUSED dedup read proposes nothing and is counted as an error (fail closed — it used to file a duplicate)", G.__I.proposals.length === 0 && rr.errors >= 1, { proposals: G.__I.proposals.length, errors: rr.errors })
  G.__I.proposals.length = 0
  const other = memSupabase({ ...seed(), agent_client_messages: [{ id: "x", brokerage_id: "other-tenant", rationale: `[PROPENSITY] [agent-1] [zzz]` }] })
  await lp.runListingPropensity(other, NOW)
  check("F POSITIVE CONTROL: the dedup read still proposes when nothing is on file for this tenant", G.__I.proposals.length === 1, G.__I.proposals.length)

  const tp = await load("lib/ai-isa/transaction-propensity.ts")
  const cdb = memSupabase({ contacts: [
    { id: "c-quiet", brokerage_id: B1, first_name: "Quiet", last_name: "Contact", intent_score: null, engagement_score: null, equity_estimate: null, referral_score: null, last_life_event_detected: null, updated_at: NOW.toISOString() },
    { id: "c-engaged", brokerage_id: B1, first_name: "Engaged", last_name: "Contact", intent_score: 40, engagement_score: 80, equity_estimate: null, referral_score: null, last_life_event_detected: null, updated_at: daysAgo(200).toISOString() },
  ] })
  const ranked = await tp.rankContactsByPropensity({ brokerageId: B1, limit: 10 }, cdb)
  const quiet = ranked.find((r: any) => r.contactId === "c-quiet")
  check("F a contact whose only 'signal' is a system write (updated_at = now) scores 0 — not 'recent activity'", quiet?.result.score === 0 && !quiet?.result.topReasons.includes("recent activity"), quiet?.result)
  check("F POSITIVE CONTROL: observed intent + engagement still rank first", ranked[0]?.contactId === "c-engaged" && ranked[0]?.result.score > 0, ranked.map((r: any) => [r.contactId, r.result.score]))
}

async function main() {
  console.log(`wave156-i-guard — grounded market intelligence (modules from ${ROOT === WT ? "this tree" : ROOT})`)
  for (const s of [sectionA, sectionB, sectionC, sectionD, sectionE, sectionF]) {
    try { await s() } catch (e) { check(`${s.name} ran without throwing`, false, e instanceof Error ? `${e.message}\n${e.stack?.split("\n").slice(1, 4).join(" | ")}` : String(e)) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) { console.log(`FAILED:\n  - ${fails.join("\n  - ")}`); process.exit(1) }
}
main()
