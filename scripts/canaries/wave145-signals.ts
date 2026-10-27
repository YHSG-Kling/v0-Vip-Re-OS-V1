/**
 * scripts/canaries/wave145-signals.ts — SIGNALS canary (wave 145, lane 145J; owner rulings 11, 12, 14; contract C2):
 *   RULING 11 — "need a watcher or something": a new or CHANGED enrichment fact emits a DURABLE event — SOURCE UPDATE →
 *     FIELD / PROVENANCE CHANGE → INTENT EVALUATION → CANONICAL PERSON (C2 for leads) → SIGNAL REACTIVATION → the existing
 *     manager / arbiter → next-best action — consumed ONCE (idempotency), with freshness; never an invented real-time signal.
 *   RULING 12 — "no protected fair housing attributes holding back any enrichment syncing": syncing proceeds; sensitive / protected
 *     fields are STORED under access control + provenance for authorized research, segregated from housing targeting; never exposed
 *     to ads, steering or eligibility. Do not block import; do not expose.
 *   RULING 14 — a Sphere / lifetime change JOINS the existing signal-reactivation intelligence and the in-app equity / refinance
 *     check (estimate from VERIFIED inputs through requestPropertyValuation; education; licensed-professional referral; market
 *     review; listing consultation). An estimate is never an appraisal, payoff or firm offer; rates, equity and eligibility are never
 *     fabricated.
 *
 * Through the survivors at b364eb4b, in memory: lib/enrichment/intent-signal-sources.ts newIntentFacts / publishNewIntentFacts
 * (the live column DEFAULT manager_signals.status = 'open' is applied AT INSERT, as the database does — 144Z's information_schema
 * read), lib/external/versium-client.ts appendVersiumRealEstateIndicators (an injected call — no network),
 * lib/enrichment/online-presence-store.ts persistRealEstateIndicators, lib/kernel/signal-registry.ts + manager-signals.ts, the equity
 * modules' stripped source (law 3). Lane 145F's names bind at the `WAVE145 BIND` lines.
 *
 * MEASURED AT b364eb4b: two new facts in one write collapse into ONE bus line (the open-line dedupe absorbs the second); a re-capture
 * of the SAME value with a new captured_at is read as a new fact; once a line is consumed the SAME fact re-published opens a second
 * evaluation (no idempotency key per fact); no freshness window; Versium's demographic adapter DROPS protected-class fields
 * (VERSIUM_PROTECTED_CLASS_FIELD) instead of storing them segregated; the lead-side facts are only pulled, never pushed.
 */
import { LIVE } from "./_harness"
import { findLanded, listFiles, readRepo, strippedRepo } from "./_registry"
import { memSupabase } from "../in-memory-supabase"
import { bindContract, canary145, quiet } from "./wave145-harness"

// ── WAVE145 BIND (lane 145F notes, "## Canary requirements", published 16:07Z) ──────────────────────────────────────────────────
// lib/enrichment/intent-signal-sources.ts publishNewIntentFacts(svc, target, before, after, now, { lifeEventWindowDays }) ·
// watchEnrichmentFactChanges(svc, brokerageId, { now, windowMinutes }, { lifeEventWindowDays, respond });
// lib/external/versium-client.ts appendVersiumRealEstateIndicators(id, { call }) → .protectedResearch;
// lib/enrichment/online-presence-store.ts persistRealEstateIndicators(…, { protectedResearch }) → protected_research_attributes;
// lib/ai-isa/lifetime-change-action.ts runLifetimeChangeActions(svc, brokerageId, { now }, { valuation, windows }).
// The fixtures below are lane 145F's own (scripts/lifetime-signals-guard.ts); the ASSERTIONS are the rulings.
const RESEARCH_TABLE = "protected_research_attributes"
const RESEARCH_ALLOWED = new Set(["lib/enrichment/protected-research-store.ts", "lib/enrichment/online-presence-store.ts"])

export async function run() {
  const c = canary145("Signals: every changed enrichment fact is ONE durable, provenance-carrying, fresh event consumed once → canonical person (C2) → reactivation → arbiter · protected fields never block a sync and are stored segregated, never exposed · lifetime changes join reactivations + the verified equity check")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only")
  const iss = await quiet(async () => import("../../lib/enrichment/intent-signal-sources")) as unknown as Record<string, any>
  const NOW = new Date("2026-10-27T15:00:00.000Z")
  const B = "11111111-1111-4111-8111-111111111111", B2 = "22222222-2222-4222-8222-222222222222", CT = "66666666-6666-4666-8666-666666666666"
  // The STORED block shape (lib/enrichment/online-presence-store.ts: provider + captured_at beside the facts, the field_provenance stamp).
  const ind = (on: boolean | null, at: string, extra: Record<string, unknown> = {}) => ({ enrichment_profile: { real_estate_indicators: { provider: "versium", captured_at: at, ...(on === null ? {} : { onlinePresenceRealEstate: on }), ...extra }, field_provenance: { real_estate_indicators: { source: "versium", capability: "person.enrich_online_presence", retrievedAt: at, matchConfidence: "individual", purpose: "enrichment" } } } })
  /** An in-memory bus whose manager_signals insert carries the live column DEFAULT (status 'open') AT INSERT, as Postgres does. */
  const busWith = (seed: Record<string, Array<Record<string, unknown>>> = {}) => {
    const db = memSupabase({ manager_signals: [], agent_action_ledger: [], signal_reactivations: [], ...seed }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
    const from = db.from.bind(db)
    ;(db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = from(t) as unknown as Record<string, (...a: unknown[]) => unknown>
      if (t === "manager_signals") { const ins = q.insert.bind(q); q.insert = (rows: unknown) => ins(Array.isArray(rows) ? rows.map((r) => ({ status: "open", ...(r as object) })) : { status: "open", ...(rows as object) }) }
      return q
    }
    return db
  }
  const lines = (db: ReturnType<typeof busWith>, id = CT) => (db.tables.manager_signals ?? []).filter((r) => r.signal_type === "online_intent_detected" && r.entity_id === id)
  const OPTS = { lifeEventWindowDays: 14 }

  // ── 1 · ONE durable event PER changed fact, carrying source / field / provenance / freshness / an idempotency key ──
  const bus = busWith({ contacts: [{ id: CT, brokerage_id: B, contact_type: "buyer" }] })
  const before = ind(false, "2026-04-01T00:00:00.000Z"), after = ind(true, "2026-10-27T13:00:00.000Z", { investingRealEstate: true })
  const t1 = await quiet(() => iss.publishNewIntentFacts(bus, { brokerageId: B, contactId: CT }, before, after, NOW, OPTS)) as { published: number }
  const ls = lines(bus)
  const payloads = ls.map((r) => JSON.stringify(r.payload ?? {}))
  const carries = payloads.length > 0 && payloads.every((p) => /versium/.test(p) && /Online Presence|Investing|online_real_estate|investor/i.test(p) && /2026-10-27T13:00/.test(p) && /idempot/i.test(p) && /provenance/i.test(p))
  const unchanged = iss.newIntentFacts(after, after, NOW) as unknown[]
  const age = iss.newIntentFacts({ enrichment_profile: {} }, { enrichment_profile: { birth_date: "1980-05-01", captured_at: "2026-10-20T00:00:00.000Z" } }, NOW) as unknown[]
  c.rule("145F", "EACH NEW / CHANGED ENRICHMENT FACT IS ITS OWN DURABLE EVENT WITH ITS PROVENANCE (ruling 11: 'SOURCE UPDATE → FIELD/PROVENANCE CHANGE → INTENT EVALUATION'): a write that lands TWO new behaviour facts (online real-estate activity + investor activity) publishes TWO bus lines for the canonical contact — never one absorbing the other — each naming its source, its field, its provenance stamp, its observation time (freshness) and an idempotency key; an unchanged re-capture and an age fact emit nothing (controls)", t1.published === 2 && ls.length === 2 && carries && unchanged.length === 0 && age.length === 0, `published ${t1.published}, lines ${ls.length}; payload carries source/field/provenance/time/idempotency ${carries}; unchanged → ${unchanged.length}; age → ${age.length}; sample ${payloads[0]?.slice(0, 160) ?? "—"}`)

  // ── 2 · CONSUMED ONCE: the same facts again (a re-run writer, a retried webhook, a re-poll) open nothing — also after consumption ──
  const again = await quiet(() => iss.publishNewIntentFacts(bus, { brokerageId: B, contactId: CT }, before, after, NOW, OPTS)) as { published: number }
  const whileOpen = lines(bus).length
  for (const r of lines(bus)) r.status = "consumed"
  await quiet(() => iss.publishNewIntentFacts(bus, { brokerageId: B, contactId: CT }, before, after, NOW, OPTS))
  const afterConsumed = lines(bus).length
  const recapture = iss.newIntentFacts(after, ind(true, "2026-10-27T14:30:00.000Z", { investingRealEstate: true }), NOW) as unknown[]
  // POSITIVE CONTROL: a genuinely NEW fact (home-improvement interest) after consumption IS a new event.
  const fresh = await quiet(() => iss.publishNewIntentFacts(bus, { brokerageId: B, contactId: CT }, after, ind(true, "2026-10-27T14:30:00.000Z", { investingRealEstate: true, homeImprovementInterest: true }), NOW, OPTS)) as { published: number }
  c.rule("145F", "EACH CHANGED FACT IS CONSUMED ONCE — AN IDEMPOTENCY KEY, NOT AN OPEN-LINE ACCIDENT (ruling 11: 'consumed ONCE (idempotency key)'): re-publishing the SAME facts while their lines are open adds nothing, and re-publishing them AFTER the evaluation consumed them opens NO second evaluation; a re-capture of the SAME value with a newer captured_at is not a change (re-enrichment ≠ change); a genuinely new fact still is (positive control)", whileOpen === 2 && afterConsumed === 2 && recapture.length === 0 && fresh.published === 1 && lines(bus).length === 3, `same facts again → ${again.published} published, ${whileOpen} line(s); after consumption → ${afterConsumed} line(s); same value re-captured → ${recapture.length} fact(s); a new fact → +${fresh.published} (${lines(bus).length} total)`)

  // ── 3 · FRESHNESS: a fact observed outside the tenant's life-event window is history, never routed as new ──
  const stale = busWith()
  const tStale = await quiet(() => iss.publishNewIntentFacts(stale, { brokerageId: B, contactId: CT }, ind(false, "2025-01-01T00:00:00.000Z"), ind(true, "2026-01-02T00:00:00.000Z"), NOW, OPTS)) as { published: number; stale?: number }
  c.rule("145F", "FRESHNESS DECIDES WHAT IS NEW (ruling 11: 'polling only where the provider updates periodically, with freshness + idempotency; never invent real-time signals'): a fact first observed months ago, landing now, is counted STALE and routes nothing (the fresh write above routed — positive control)", t1.published === 2 && tStale.published === 0 && lines(stale).length === 0, `stale write → published ${tStale.published}, stale ${tStale.stale ?? "∅"}, lines ${lines(stale).length}`)

  // ── 4 · C2: the WATCHER routes a converted lead's fact to its CONTACT and an open lead's as a lead; an inactive one nowhere ──
  await c.check("145F", "THE WATCHER ROUTES EVERY CHANGED FACT TO THE CANONICAL PERSON (ruling 11 + contract C2: 'routed through the signal registry to the canonical party (contract C2 for leads) → arbiter'): the enrichment sweep reads this tenant's contacts and leads stamped since its cursor — a lead WITH a contact_id is evaluated as that contact (never a second lead-side evaluation), an open lead without one reaches the ONE responder as a lead, an inactive lead without one is out of every domain; a fact carried from before the cursor is not new; another tenant's rows are never swept", async () => {
    if (typeof iss.watchEnrichmentFactChanges !== "function") return { ok: false, evidence: `lib/enrichment/intent-signal-sources.ts exports no watchEnrichmentFactChanges — awaiting lane 145F; HEAD pushes contact facts only (publishNewIntentFacts); findLanded canonicalPartyFor reader: ${findLanded(["lib/enrichment", "app/api/cron"], /\bcanonicalPartyFor\s*\(/) ?? "nothing"}` }
    const L1 = "77777777-7777-4777-8777-777777777777", L2 = "88888888-8888-4888-8888-888888888888", L3 = "99999999-9999-4999-8999-999999999999"
    const at = "2026-10-27T13:00:00.000Z"
    const calls: Array<{ subject: { type: string; id: string } }> = []
    const respond = (async (_s: unknown, inp: { subject: { type: string; id: string } }) => { calls.push(inp); return { action: "lead_signal_recorded", subjectClass: "lead", kind: "moving", reason: "ok" } }) as never
    const db = busWith({
      contacts: [
        { id: CT, brokerage_id: B, deleted_at: null, last_enriched_at: at, enriched_at: null, last_life_event_detected: null, ...ind(true, at) },
        { id: "c-carried", brokerage_id: B, deleted_at: null, last_enriched_at: at, enriched_at: null, last_life_event_detected: null, ...ind(true, "2026-10-01T00:00:00.000Z") },
        { id: "c-tenant2", brokerage_id: B2, deleted_at: null, last_enriched_at: at, enriched_at: null, last_life_event_detected: null, ...ind(true, at) },
      ],
      leads: [
        { id: L1, brokerage_id: B, contact_id: CT, is_active: false, last_enriched_at: at, life_events: null, ...ind(true, at, { homeImprovementInterest: true }) },
        { id: L2, brokerage_id: B, contact_id: null, is_active: true, last_enriched_at: at, life_events: null, ...ind(true, at) },
        { id: L3, brokerage_id: B, contact_id: null, is_active: false, last_enriched_at: at, life_events: null, ...ind(true, at) },
      ],
    })
    const w = await quiet(() => iss.watchEnrichmentFactChanges(db, B, { now: NOW, windowMinutes: 360 }, { lifeEventWindowDays: 14, respond })) as Record<string, unknown>
    const toContact = (db.tables.manager_signals ?? []).filter((r) => r.entity_id === CT)
    const leadLines = (db.tables.manager_signals ?? []).filter((r) => [L1, L2, L3].includes(String(r.entity_id)))
    const carried = (db.tables.manager_signals ?? []).some((r) => r.entity_id === "c-carried")
    const foreign = (db.tables.manager_signals ?? []).some((r) => r.entity_id === "c-tenant2")
    const leadAsLead = calls.filter((x) => x.subject.type === "lead").map((x) => x.subject.id)
    const ok = toContact.length >= 1 && leadLines.length === 0 && !carried && !foreign && leadAsLead.length === 1 && leadAsLead[0] === L2 && !calls.some((x) => x.subject.id === L1 || x.subject.id === L3)
    return { ok, evidence: `lines for the contact ${toContact.length} (incl. the converted lead's fact); lead-keyed lines ${leadLines.length}; responder subjects ${calls.map((x) => `${x.subject.type}:${x.subject.id.slice(0, 4)}`).join(",") || "none"}; carried routed ${carried}; other tenant routed ${foreign}; counts ${JSON.stringify({ c: w.contactsScanned, l: w.leadsScanned })}` }
  })

  // ── 5 · RULING 12: protected attributes never block the sync, are STORED segregated with provenance, never on the contact row ──
  const vc = await quiet(async () => import("../../lib/external/versium-client")) as unknown as Record<string, any>
  const ops = await quiet(async () => import("../../lib/enrichment/online-presence-store")) as unknown as Record<string, any>
  const row = { "Online Presence Indicator - Real Estate": "Yes", "Home Own or Rent": "Own", Ethnicity: "Ex", Religion: "Rx", "Presence of Children": "Yes", "Veteran In Household": "Yes", Language: "Lx" }
  const appended = await quiet(async () => vc.appendVersiumRealEstateIndicators({ email: "pat@example.test" }, { call: async () => ({ ok: true, status: 200, data: { versium: { match_counts: { full_demographic: 1 }, num_results: 1, results: [row] } } }) })) as Record<string, any>
  const exposed = JSON.stringify({ indicators: appended.indicators, provenance: appended.provenance })
  const research = (appended.protectedResearch ?? []) as Array<Record<string, unknown>>
  const store = memSupabase({ contacts: [{ id: CT, brokerage_id: B, enrichment_profile: {} }], [RESEARCH_TABLE]: [], manager_signals: [], agent_action_ledger: [] }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
  const wrote = await quiet(async () => ops.persistRealEstateIndicators(store, { contactId: CT, brokerageId: B }, appended.indicators, appended.provenance, { protectedResearch: research, now: NOW })) as { ok: boolean }
  const held = (store.tables[RESEARCH_TABLE] ?? []) as Array<Record<string, unknown>>
  const contactClean = !/Ethnicity|Religion|Children|Veteran|"Ex"|"Rx"|"Lx"/.test(JSON.stringify(store.tables.contacts))
  const foreignWrite = await quiet(async () => ops.persistRealEstateIndicators(store, { contactId: CT, brokerageId: B2 }, appended.indicators, appended.provenance, { protectedResearch: research, now: NOW })) as { ok: boolean }
  c.rule("145F", "PROTECTED ATTRIBUTES NEVER BLOCK ENRICHMENT SYNCING — THEY ARE STORED, SEGREGATED, FOR AUTHORIZED RESEARCH (ruling 12: 'Do not block import; do not expose'): a Versium row carrying ethnicity, religion, children, veteran and language lands its allow-listed facts unchanged (the sync proceeds), and the protected fields leave ONLY in a segregated research field, are written to the research store with provenance (purpose research, the provider, when retrieved), NOTHING protected reaches the contact row, and another tenant cannot write research onto this contact", !!appended.indicators?.onlinePresenceRealEstate && !/Ethnicity|Religion|Children|Veteran|"Ex"|"Rx"|"Lx"/.test(exposed) && research.length >= 5 && wrote.ok && held.length >= 5 && held.every((h) => h.brokerage_id === B && h.purpose === "research" && !!h.provider) && contactClean && !foreignWrite.ok, `sync proceeds ${!!appended.indicators?.onlinePresenceRealEstate}; protected in the exposed indicators ${/Ethnicity|Religion|"Ex"|"Rx"/.test(exposed)}; segregated research fields ${research.length}; store rows ${held.length} (purpose research ${held.every((h) => h.purpose === "research")}); contact row clean ${contactClean}; foreign tenant write → ${foreignWrite.ok ? "ACCEPTED" : "refused"}`)

  // …and the store is FIREWALLED: only the store and its one writer name it (stripped source; real string literals).
  const { stringLiterals, stripComments } = await import("../strip-comments")
  const namesIt = (text: string) => stringLiterals(text).some((l) => l.text === RESEARCH_TABLE || /protected-research-store$/.test(l.text))
  const leaks = [...listFiles("lib", (f) => /\.tsx?$/.test(f)), ...listFiles("app", (f) => /\.tsx?$/.test(f))].filter((f) => !RESEARCH_ALLOWED.has(f) && /protected_research_attributes|protected-research-store/.test(readRepo(f) ?? "") && namesIt(stripComments(readRepo(f) ?? "")))
  const storeLanded = !!readRepo("lib/enrichment/protected-research-store.ts")
  const fwControl = namesIt(`await svc.from("protected_research_attributes").select("*")`) && !namesIt(stripComments(`// protected_research_attributes is the research store\nconst x = 1`))
  c.rule("145F", "THE RESEARCH STORE NEVER REACHES ADS, TARGETING, DISPATCH OR ELIGIBILITY (ruling 12: 'never exposed to ads/steering/eligibility'): no lib/ or app/ module other than the store and its one writer names the research table or imports the store (stripped source, real string literals; positive control: a .from(…) of the table IS caught, a comment is not)", storeLanded && fwControl && leaks.length === 0, `${storeLanded ? "store landed" : "lib/enrichment/protected-research-store.ts not landed (lane 145F)"}; modules naming it outside the store: ${leaks.join(", ") || "none"}; control ${fwControl}`)
  c.pendingOwner("145F", "THE RESEARCH STORE'S READERS AND RETENTION ARE THE OWNER'S (ruling 12: 'under access control + provenance'): which role may READ protected research and for how long it is kept", false, "Data governance (carried from wave 144 — 144Z owner item 2; lane 145F built the segregated store): name the role(s) that may read protected_research_attributes (compliance_officer only? platform research staff?) and the retention period — the store's RLS / purge is then written to that answer", storeLanded ? "store built; readers / retention undecided" : "store not landed yet")

  // ── 6 · RULING 14: the lifetime change JOINS the signal-reactivation intelligence (green — preserve the 144Z routing) ──
  const reg = await quiet(async () => import("../../lib/kernel/signal-registry"))
  const ms = await quiet(async () => import("../../lib/kernel/manager-signals"))
  const REG = (reg as unknown as { SIGNAL_REGISTRY: Record<string, { consumers: string[]; disposition: string }> }).SIGNAL_REGISTRY
  const HANDLERS = (ms as unknown as { SIGNAL_HANDLERS: Record<string, unknown> }).SIGNAL_HANDLERS
  const life = ["equity_milestone", "refinance_opportunity"].map((k) => ({ k, s: REG[k] }))
  const joined = life.every(({ k, s }) => !!s && s.disposition === "handled" && s.consumers.includes("sphere_of_influence") && typeof HANDLERS[`sphere_of_influence:${k}`] === "function")
  const lap = await quiet(async () => import("../../lib/ai-isa/lead-action-plan"))
  const kinds = lap.EXPERIENCE_KINDS as readonly string[]
  c.rule("145F", "A LIFETIME CHANGE JOINS THE SIGNAL-REACTIVATION INTELLIGENCE, NOT AN ISOLATED FOLLOW-UP ENGINE (ruling 14: 'the signal joins signal reactivations'; green, preserve): equity_milestone and refinance_opportunity are HANDLED by the Sphere manager's registered handlers (the ones that file signal_reactivations), and the next-best menu can answer them with education, a market update, an agent intervention (listing consultation) and a referral to a licensed professional (professional_referral)", joined && ["education", "market_update", "agent_intervention", "professional_referral"].every((k) => kinds.includes(k)), `${life.map(({ k, s }) => `${k}: ${s ? `${s.disposition}/${s.consumers.join("+")}` : "absent"}, handler ${typeof HANDLERS[`sphere_of_influence:${k}`] === "function"}`).join("; ")}`)

  // ── 7 · RULING 14 + law 3: the equity estimate is requestPropertyValuation on verified inputs; never a fabricated rate ──
  const equityFiles = [...new Set(["lib/kernel/equity-trigger.ts", "lib/kernel/anniversary-equity.ts", "lib/ai-isa/lifetime-change-action.ts", ...listFiles("lib/equity", (f) => /\.ts$/.test(f)), ...listFiles("lib/sphere", (f) => /\.ts$/.test(f) && /equity|refi/i.test(strippedRepo(f) ?? ""))])].filter((f) => strippedRepo(f) !== null)
  const RATE_LITERAL = /\b(rate|apr|interest\w*|mortgageRate\w*)\s*[:=]\s*0?\.\d{2,}\b|\b(rate|apr)\s*[:=]\s*\d(\.\d+)?\s*\/\s*100\b/i
  const avmDirect = equityFiles.filter((f) => /\bgetRentcastAVM\s*\(/.test(strippedRepo(f) ?? ""))
  const chain = equityFiles.filter((f) => /\brequestPropertyValuation\s*\(/.test(strippedRepo(f) ?? ""))
  const rates = equityFiles.filter((f) => RATE_LITERAL.test(strippedRepo(f) ?? ""))
  const rateControl = RATE_LITERAL.test("const rate = 0.0675") && !RATE_LITERAL.test("const ltv = loanBalance / value")
  c.rule("145F", "THE EQUITY CHECK IS AN ESTIMATE FROM VERIFIED INPUTS — NEVER A FABRICATED RATE (ruling 14 + law 3: a home value is requestPropertyValuation, never getRentcastAVM): the equity modules ask the provider chain, none calls the AVM vendor directly, and none hard-codes an interest rate (positive control: a literal 0.0675 rate IS caught; an LTV ratio is not)", rateControl && chain.length > 0 && avmDirect.length === 0 && rates.length === 0, `equity modules ${equityFiles.join(", ")}; via requestPropertyValuation ${chain.length}; direct getRentcastAVM ${avmDirect.join(", ") || "none"}; rate literals ${rates.join(", ") || "none"}`)

  // ── 8 · RULING 14: the in-app equity / refinance playbook, driven on lane 145F's door ──
  const lca = await bindContract({ id: "145F lifetime change action", lane: "145F", file: "lib/ai-isa/lifetime-change-action.ts", exports: ["runLifetimeChangeActions"] })
  await c.check("145F", "THE LIFETIME CHANGE ACTION (ruling 14: 'refinance/in-app checking of equity (playbook like glide and realscout)'): a refinance signal on a lifetime client with a verified purchase and a recorded loan puts ONE in-app equity card in the portal labelled an ESTIMATE (not an appraisal, payoff or offer) that quotes NO rate, opens ONE governed post-close moment for the conductor (planner + arbiter — not a send, not a timetable), and CONSUMES the reactivation row (the signal joined, it was not re-asked); with no verified valuation there is NO card (nothing fabricated); a re-run adds nothing", async () => {
    if (!lca.mod) return { ok: false, evidence: lca.evidence }
    const LIFE = "33333333-3333-4333-8333-333333333333", AG = "44444444-4444-4444-8444-444444444444", TX = "55555555-5555-4555-8555-555555555555"
    const seed = () => ({
      contacts: [{ id: LIFE, brokerage_id: B, first_name: "Lee", last_name: "Past", contact_type: "lifetime_customer", lifecycle_state: "lifetime_customer", nurture_status: null, buyer_stage: null, agent_id: AG }],
      transactions: [{ id: TX, brokerage_id: B, status: "closed", deleted_at: null, close_date: "2021-06-01", buyer_contact_id: LIFE, contact_id: LIFE, deal_type: "buyer", property_address: "1 Main St, Austin, TX", purchase_price: 400000, loan_amount: null }],
      transaction_lenders: [{ id: "tl1", transaction_id: TX, loan_amount: 320000, interest_rate: 6.75, created_at: "2021-05-01T00:00:00Z" }],
      signal_reactivations: [{ id: "sig-refi", brokerage_id: B, contact_id: LIFE, lead_id: null, signal_type: "refinance_opportunity", signal_strength: null, signal_data: { source: "equity_trigger", kind: "refinance" }, triggered_at: "2026-10-27T10:00:00.000Z", isa_reactivated: false }],
      transparency_updates: [], lifetime_customer_touchpoints: [], agent_action_ledger: [],
    })
    const opts = { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } }
    const valuation = async () => ({ value: 520000, rangeLow: 495000, rangeHigh: 545000, source: "rentcast", confidence: 0.8, fetchedAt: NOW.toISOString() })
    const WINDOWS = { lifeEventWindowDays: 14, valueCheckWindowDays: 14 }
    const db = memSupabase(seed(), opts)
    await quiet(async () => lca.mod!.runLifetimeChangeActions(db, B, { now: NOW }, { valuation, windows: WINDOWS }))
    const cards = (db.tables.transparency_updates ?? []).filter((r) => r.contact_id === LIFE)
    const card = cards[0] as Record<string, any> | undefined
    const text = `${card?.title ?? ""} ${card?.message ?? card?.body ?? card?.description ?? ""}`
    const moments = (db.tables.lifetime_customer_touchpoints ?? []).filter((r) => r.contact_id === LIFE)
    const consumed = (db.tables.signal_reactivations ?? []).find((r) => r.id === "sig-refi")?.isa_reactivated === true
    await quiet(async () => lca.mod!.runLifetimeChangeActions(db, B, { now: NOW }, { valuation, windows: WINDOWS }))
    const cardsAfter = (db.tables.transparency_updates ?? []).filter((r) => r.contact_id === LIFE).length
    const dbNull = memSupabase(seed(), opts)
    await quiet(async () => lca.mod!.runLifetimeChangeActions(dbNull, B, { now: NOW }, { valuation: async () => null, windows: WINDOWS }))
    const nullCards = (dbNull.tables.transparency_updates ?? []).filter((r) => r.contact_id === LIFE).length
    const labelled = card?.metadata?.not_an_appraisal === true && card?.metadata?.rate_quoted === false
    const noRateQuoted = !/%|\bAPR\b|per month/i.test(text)
    return { ok: cards.length === 1 && labelled && noRateQuoted && card?.is_visible_to_client === true && moments.length === 1 && consumed && cardsAfter === 1 && nullCards === 0, evidence: `cards ${cards.length} (${card?.update_type ?? "—"}; estimate-labelled ${labelled}; quotes no rate ${noRateQuoted}); moments ${moments.length}; reactivation consumed ${consumed}; re-run cards ${cardsAfter}; no valuation → cards ${nullCards}` }
  })

  c.blind("The bus ran in memory with the live open-line DEFAULT applied at insert (no RLS, no trigger). The watcher and the lifetime action are driven with lane 145F's own fixture shapes and injected seams (a responder, a valuation) — no provider is called, nothing is sent. The research firewall reads stripped lib/ + app/ for real string literals naming the table or the store; a reader reaching it through an RPC or a view is out of its sight.")
  return c.report([], 0)
}
