/**
 * scripts/canaries/wave147-movement-signals.ts — LIFE & MOVEMENT SIGNALS canary (wave 147, lane 147J; owner rulings 3 + 4,
 * contract C9 — lane 147B):
 *   "Life changes include divorce, probate, relocation, posts about looking for an agent — it is also a real estate event. There
 *    has to be a way to gain this info accurately." · signalled to the manager/arbiter when an outside provider or scrape CHANGES,
 *    including providers with no push (poll-and-diff, freshness published).
 *   → a STORED seller signal (the permit sweep's motivated_seller_signals row — a source with no push) is polled → the first poll
 *     raises ONE C9 record → the same data again raises nothing → the stored signal CHANGES (a new permit on the owner's address)
 *     → exactly ONE more C9 record → and only once; freshness is published → the person's own act corroborates it → the
 *     combination score explains itself line by line → the manager chooses inside a CLOSED menu (the source never chooses);
 *   → a DIVORCE relevance is a person's conversation: never an automated offer — a model reaching for one is refused, the
 *     manager's 'human' routes to the agent with the intimate event redacted;
 *   → inferred never reads as verified: refused by the builder (a cast cannot smuggle a reference), capped by the source ceiling,
 *     labelled "an inference, not a fact", and refused by m892's CHECK for every writer.
 *
 * Driven through the REAL modules: lib/intent/movement-source-watcher.ts runMovementTick (STORED_SELLER_SIGNALS_SOURCE),
 * lib/intent/movement-signals.ts recordMovementSignal / movementSignalFromLifeEvent / movementSignalsForArbiter. The manager's
 * model and the outbound doors (bus publish, responder, agent task, admin bell) are injected seams — lane 147B's proof seams
 * the same ones; the policy, the scorer, the menu and the validators run for real.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, strippedRepo } from "./_registry"
import { stripComments } from "../strip-comments"
import { memSupabase } from "../in-memory-supabase"
import { quiet, sqlCode } from "./wave145-harness"
import { canary147, jsonOf, tbl } from "./wave147-harness"

const B = "b1470000-0000-4000-8000-00000000b0b1"
const AG = "b1470000-0000-4000-8000-00000000b0a1"
const NOW = new Date("2026-10-30T15:00:00.000Z")
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const UNIQUE = { agent_action_ledger: [["idempotency_key"]], movement_signals: [["brokerage_id", "idempotency_key"]], movement_source_polls: [["brokerage_id", "source_key"]], movement_source_items: [["brokerage_id", "source_key", "item_key"]] }

function world() {
  return memSupabase({
    contacts: [
      { id: "b147-owner", brokerage_id: B, contact_type: "seller", agent_id: AG, zip_code: "78702", deleted_at: null, opted_out_at: null, life_events: [], last_life_event_detected: null },
      { id: "b147-divorce", brokerage_id: B, contact_type: "lifetime_customer", agent_id: AG, zip_code: "78704", deleted_at: null, opted_out_at: null, life_events: [], last_life_event_detected: null },
    ],
    leads: [], raw_scraped_leads: [], agent_action_ledger: [], movement_signals: [], movement_source_polls: [], movement_source_items: [], calculator_history: [], listings: [], transactions: [],
    motivated_seller_signals: [
      { id: "b147-mss-1", brokerage_id: B, contact_id: "b147-owner", lead_id: null, signal_type: "permit_activity", signal_strength: "moderate", detected_via: "socrata", detected_at: daysAgo(2), signal_details: { permit_id: "BP-2026-0147", address: "14 Juniper St" } },
    ],
  }, { uuidIds: true, stampCreatedAt: true, unique: UNIQUE })
}

/** The manager's model + the outbound doors, recorded (lane 147B's proof seams). */
function manager(choose: (prompt: Record<string, any>) => Record<string, unknown> | null) {
  const cap = { publishes: [] as any[], responds: [] as any[], agentTasks: [] as any[], admins: [] as any[], prompts: [] as Record<string, any>[] }
  const deps = {
    now: NOW, windowDays: 180,
    publish: async (s: any) => { cap.publishes.push(s); return { ok: true, signalId: "sig" } },
    respond: async (_svc: unknown, i: any) => { cap.responds.push(i); return { action: "lead_signal_recorded", subjectClass: "lead", kind: "moving", reason: "recorded" } },
    routeToAgent: async (_svc: unknown, a: any) => { cap.agentTasks.push(a); return true },
    notifyAdmins: async (p: any) => { cap.admins.push(p); return 1 },
    decide: async (a: { prompt: string }) => { const p = JSON.parse(a.prompt); cap.prompts.push(p); const r = choose(p); if (!r) throw new Error("no model"); return r },
  }
  return { cap, deps }
}

export async function run() {
  const c = canary147("Movement signals (C9): a no-push source is polled and diffed → exactly one C9 record per change → the combination explains itself → the manager picks from a closed menu; divorce is a person's conversation; inferred never reads as verified")
  const mv = await quiet(async () => import("../../lib/intent/movement-signals")) as unknown as Record<string, any>
  const watcher = await quiet(async () => import("../../lib/intent/movement-source-watcher")) as unknown as Record<string, any>
  const d = c.track(world(), B)
  const offer = manager((p) => ({ action: (p.allowed as Array<{ action: string }>).some((x) => x.action === "offer_help") ? "offer_help" : "research", rationale: "Two independent signs, one the person's own action — offer something useful, gently.", helper_keys: [], research_keys: [], evidence: (p.contributions as Array<{ id: string }>).map((x) => x.id), confidence: 0.8 }))
  const tick = async (now = NOW) => ((await quiet(async () => watcher.runMovementTick(d, B, { now, force: true, reconcile: false, sources: [watcher.STORED_SELLER_SIGNALS_SOURCE] }, { movement: offer.deps }))) as { watch: { sources: Array<Record<string, any>> } }).watch.sources[0] ?? {}

  // ── 1 · poll-and-diff: one raise per change, never twice ──
  const r1 = await tick()
  const after1 = tbl(d, "movement_signals").length
  const r2 = await tick()
  const after2 = tbl(d, "movement_signals").length
  c.rule("147B", "A SOURCE WITH NO PUSH IS POLLED AND DIFFED (ruling 3: 'including providers that have no push signal (poll-and-diff is the fallback)'): the first poll of the stored permit sweep raises ONE C9 record; the same data polled again raises NOTHING (POSITIVE CONTROL for the second poll's zero: the first poll's one)",
    r1.status === "polled" && r1.raised === 1 && after1 === 1 && r2.raised === 0 && after2 === 1, `poll 1 → ${r1.status}, raised ${r1.raised}; poll 2 → raised ${r2.raised}; C9 rows ${after1} → ${after2}`)
  const permit = tbl(d, "movement_signals")[0] ?? {}
  c.rule("147B", "THE RAISED RECORD IS A C9 RECORD (person → source → evidence → observed_at → confidence → event_relevance; next action and outcome NOT the source's): the permit sweep's stored row (issuer open data) is VERIFIED with its permit reference, a property_event, outreach consent-gated, next_action and outcome empty",
    permit.contact_id === "b147-owner" && permit.source_key === "pr_permit_activity" && permit.confidence === "verified" && permit.event_relevance === "property_event" && /BP-2026-0147/.test(jsonOf(permit.evidence)) && permit.outcome == null
      && (permit.next_action == null || ["ai_isa", "sphere_of_influence", "data_steward"].includes(String(permit.decided_by))),
    `${permit.source_key} · ${permit.confidence} · ${permit.event_relevance} · evidence ${jsonOf(permit.evidence).slice(0, 80)} · next_action ${permit.next_action ?? "∅"} decided_by ${permit.decided_by ?? "∅"} (the manager's stamp after its decision — never the source's)`)
  // the stored signal CHANGES: the sweep re-detects the owner's address with a NEW permit (the item key is the person + signal
  // type; the record id and strength are material) — an hour after the first polls, as a real re-sweep stamps detected_at
  const row = tbl(d, "motivated_seller_signals")[0]
  const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000)
  row.signal_details = { permit_id: "BP-2026-0201", address: "14 Juniper St" }; row.signal_strength = "strong"; row.detected_at = at(1).toISOString()
  const r3 = await tick(at(2))
  const after3 = tbl(d, "movement_signals").length
  const r4 = await tick(at(3))
  const after4 = tbl(d, "movement_signals").length
  c.rule("147B", "WHEN THE STORED SIGNAL CHANGES, EXACTLY ONE C9 SIGNAL IS RAISED — AND ONLY ONCE (C9 'Published through publishSignal'; lane 147B item 3 'raises on a material change'): the changed permit raises ONE new record; polling the changed data again raises none",
    r3.raised === 1 && after3 === after2 + 1 && r4.raised === 0 && after4 === after3, `after the change → raised ${r3.raised} (rows ${after2} → ${after3}); again → raised ${r4.raised} (rows ${after4})`)
  const poll = tbl(d, "movement_source_polls").find((p) => p.source_key === r1.key) ?? tbl(d, "movement_source_polls")[0] ?? {}
  c.rule("147B", "THE FRESHNESS IT CAN PROMISE IS PUBLISHED (ruling 3: 'with its freshness published'): the poll state records the last success and the cadence; a source whose upstream lag is unpublished promises NO freshness number it cannot keep",
    !!poll.last_success_at && Number(poll.cadence_minutes) > 0 && (r1.freshness?.promisedFreshnessMinutes === null ? /no freshness is promised/.test(String(r1.freshness?.note ?? "")) : Number(r1.freshness?.promisedFreshnessMinutes) > 0),
    `last success ${poll.last_success_at ?? "∅"}, cadence ${poll.cadence_minutes ?? "∅"} min, promised ${r1.freshness?.promisedFreshnessMinutes ?? "none"} — ${String(r1.freshness?.note ?? "").slice(0, 80)}`)

  // ── 2 · the person's own act corroborates → the combination explains itself → the manager's closed menu ──
  const own = await quiet(async () => mv.recordMovementSignal(d, { brokerageId: B, subject: { type: "contact", id: "b147-owner" }, sourceKey: "fp_calc_seller_net", eventRelevance: "property_event", intents: ["home_sale"], identity: "record_key", capturedBy: "automation", observedAt: daysAgo(1), evidence: { confidence: "verified", reference: { kind: "first_party_row", id: "calculator_history:b147", retrievedAt: daysAgo(1) }, summary: "ran the seller net calculator" } }, offer.deps)) as Record<string, any>
  const combo = own.evaluation?.combination ?? {}
  const decision = own.evaluation?.decision ?? {}
  c.rule("147B", "THE COMBINATION SCORE EXPLAINS ITSELF (lane 147B item 4: 'scored combinations, never a single keyword; the score explains itself'): the permit and the person's own calculator are INDEPENDENT kinds — corroborated; every contribution carries its arithmetic (points × class × identity × recency = value)",
    own.status === "recorded" && combo.corroborated === true && (combo.independentKinds ?? []).length === 2 && /prior pts × verified 1 × identity/.test(String(combo.explanation ?? "")) && /= \d/.test(String(combo.explanation ?? "")),
    `score ${combo.score} (${combo.band}); kinds ${jsonOf(combo.independentKinds)}; explanation: ${String(combo.explanation ?? "").slice(0, 160)}`)
  const menu = (decision.allowed ?? []) as string[]
  c.rule("147B", "THE MANAGER CHOOSES FROM A CLOSED MENU, NOT THE SOURCE (lane 147B item 6: next action ∈ { research, offer_help, wait, human }, chosen by the manager/arbiter): the model was handed the menu, what is NOT allowed and why, and the evidence — and its choice is inside the menu, stamped on the rows by the manager (decided_by), ledgered intent.movement_signal.decide",
    menu.length > 0 && menu.every((a) => ["research", "offer_help", "wait", "human"].includes(a)) && menu.includes(decision.action) && decision.source === "ai" && Array.isArray(offer.cap.prompts[0]?.not_allowed)
      && tbl(d, "movement_signals").some((r) => r.next_action === decision.action && !!r.decided_by) && tbl(d, "agent_action_ledger").some((l) => l.action === "intent.movement_signal.decide" && l.status === "executed"),
    `menu ${jsonOf(menu)} → ${decision.action} (${decision.source}); not_allowed handed ${jsonOf((offer.cap.prompts[0]?.not_allowed ?? []).map((x: { action: string }) => x.action))}; decided_by ${tbl(d, "movement_signals").find((r) => r.next_action)?.decided_by ?? "∅"}`)
  // the arbiter's read of the same evidence (the consumer hook lane 147B built), in the arbiter's own spelling
  const hook = await quiet(async () => mv.movementSignalsForArbiter(d, { brokerageId: B, contactId: "b147-owner", now: NOW, windowDays: 180 })) as Record<string, any>
  const arb = await quiet(async () => import("../../lib/ai-isa/followup-arbiter")) as unknown as Record<string, any>
  c.rule("147B", "THE ARBITER CAN READ IT (C9 'consumed by the arbiter'): movementSignalsForArbiter returns the person's movement as a life-change signal in the arbiter's OWN spelling, scored by the combination, with the explanation",
    (hook.signals ?? []).length >= 1 && (hook.signals as Array<{ type: string }>).every((s) => s.type in (arb.LIFE_CHANGE_SIGNAL_KINDS ?? {})) && !!hook.explanation,
    `signals ${jsonOf((hook.signals ?? []).map((s: { type: string; strength: number }) => [s.type, s.strength]))}; explanation ${hook.explanation ? "present" : "∅"}`)
  const arbSrc = strippedRepo("lib/ai-isa/followup-arbiter.ts") ?? ""
  const UNWIRED = /\bMOVEMENT_SIGNAL_CONSUMER\s*:\s*MovementSignalConsumer\s*\|\s*null\s*=\s*null\b/
  const wiredControl = UNWIRED.test(stripComments("const MOVEMENT_SIGNAL_CONSUMER: MovementSignalConsumer | null = null")) && !UNWIRED.test(stripComments("const MOVEMENT_SIGNAL_CONSUMER: MovementSignalConsumer | null = async (svc, a) => (await import(\"@/lib/intent/movement-signals\")).arbiterMovementSignals(svc, a)"))
  const wired = /\bMOVEMENT_SIGNAL_CONSUMER\b/.test(arbSrc) && !UNWIRED.test(arbSrc)
  c.convergence("147B", "THE ARBITER'S SEAM IS WIRED TO THE MOVEMENT HOOK (lane 147G's MOVEMENT_SIGNAL_CONSUMER, filled per lane 147B/147G Outside-lane 1 → 147Z): loadLifeChangeSignals reads the C9 combination instead of publishing 'movement signals … not wired'",
    wired && wiredControl, wired && wiredControl, `stripped lib/ai-isa/followup-arbiter.ts: consumer ${wired ? "wired" : "still null"}; finder control ${wiredControl}`)

  // ── 3 · a divorce relevance → a person only ──
  const greedy = manager((p) => ({ action: "offer_help", rationale: "Reach out now with a moving offer — they will need to sell.", helper_keys: [], research_keys: [], evidence: (p.contributions as Array<{ id: string }>).map((x) => x.id), confidence: 0.9 }))
  const built = mv.movementSignalFromLifeEvent({ brokerageId: B, contactId: "b147-divorce", event: { event: "divorce", url: "https://example.org/court-notices/147", publishedDate: daysAgo(6) }, detectedAt: daysAgo(5) })
  const dv = built.ok ? await quiet(async () => mv.recordMovementSignal(d, built.record, greedy.deps)) as Record<string, any> : { status: "refused", code: built.code }
  const dd = dv.evaluation?.decision ?? {}
  const dvMenu = (dd.allowed ?? []) as string[]
  c.rule("147B", "A DIVORCE IS NEVER AN AUTOMATED OFFER (ruling 3 + the C9 privacy rule: 'never intimate inference'; next action 'human' for an intimate event): the published divorce notice is recorded, but offer_help is NOT on the menu — a model that reaches for it is REFUSED (the policy's step instead) and nothing is published or sent",
    dv.status === "recorded" && dvMenu.length > 0 && !dvMenu.includes("offer_help") && dvMenu.includes("human") && dd.source === "deterministic" && /not permitted/.test(String(dd.fallbackReason ?? "")) && greedy.cap.publishes.length === 0 && greedy.cap.responds.length === 0,
    `recorded ${dv.status}; menu ${jsonOf(dvMenu)}; the model's offer_help → ${dd.source === "deterministic" ? `refused (${String(dd.fallbackReason ?? "").slice(0, 70)}) → ${dd.action}` : dd.action}; publishes ${greedy.cap.publishes.length}`)
  const human = manager((p) => ({ action: "human", rationale: "A sensitive public record — a person should decide whether and when to reach out.", helper_keys: [], research_keys: [], evidence: (p.contributions as Array<{ id: string }>).map((x) => x.id), confidence: 0.9 }))
  const d2 = c.track(world(), B)
  const built2 = mv.movementSignalFromLifeEvent({ brokerageId: B, contactId: "b147-divorce", event: { event: "divorce", url: "https://example.org/court-notices/147b", publishedDate: daysAgo(6) }, detectedAt: daysAgo(5) })
  const hv = built2.ok ? await quiet(async () => mv.recordMovementSignal(d2, built2.record, human.deps)) as Record<string, any> : {}
  const task = human.cap.agentTasks[0]
  c.rule("147B", "…THE ONLY ANSWER IS A PERSON: the manager's 'human' routes to the contact's agent, the task NEVER names the intimate event (redacted), and nothing is sent automatically (POSITIVE CONTROL: the redaction finder catches 'divorce' in a specimen)",
    hv.evaluation?.decision?.action === "human" && !!task && !/divorc/i.test(String(task.description ?? "")) && /divorc/i.test("Client may be going through a divorce") && human.cap.publishes.length === 0 && human.cap.responds.length === 0,
    `decision ${hv.evaluation?.decision?.action}; agent task: "${String(task?.description ?? "").slice(0, 120)}"; publishes ${human.cap.publishes.length}`)

  // ── 4 · inferred never reads as verified — the builder, the ceiling, the label and m892's CHECK ──
  const rec = (evidence: Record<string, unknown>, route = false) => quiet(async () => mv.recordMovementSignal(c.track(world(), B), { brokerageId: B, subject: { type: "contact", id: "b147-owner" }, sourceKey: "po_online_real_estate_activity", eventRelevance: "property_event", identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(3), evidence }, route ? offer.deps : { ...offer.deps, route: false })) as Promise<Record<string, any>>
  const smuggled = await rec({ confidence: "inferred", basis: ["versium:x"], method: "vendor model", summary: "modeled indicator", reference: { kind: "first_party_row", id: "x", retrievedAt: daysAgo(3) } })
  const promoted = await rec({ confidence: "verified", reference: { kind: "first_party_row", id: "x", retrievedAt: daysAgo(3) }, summary: "modeled indicator presented as verified" })
  const honest = await rec({ confidence: "inferred", basis: ["versium:online_real_estate_activity"], method: "vendor model", summary: "modeled indicator" }, true)
  c.rule("147B", "INFERRED NEVER READS AS VERIFIED — THE BUILDER (lane 147B item 5): an inference carrying a verification reference is refused (bad_evidence — a cast cannot smuggle it past the type); a modeled vendor indicator presented as verified is refused (above_source_ceiling); POSITIVE CONTROL — the same indicator honestly recorded as inferred is accepted",
    smuggled.status === "refused" && smuggled.code === "bad_evidence" && promoted.status === "refused" && promoted.code === "above_source_ceiling" && honest.status === "recorded",
    `inferred+reference → ${smuggled.status}/${smuggled.code}; modeled-as-verified → ${promoted.status}/${promoted.code}; honest inferred → ${honest.status}`)
  const m892File = "supabase/migrations/m892-movement-signals-c9-record.sql"
  const m892 = sqlCode(readFileSync(join(ROOT, m892File), "utf8"))
  const INFERRED_CHECK = /CONSTRAINT\s+movement_signals_inferred_shape\s+CHECK\s*\(\s*confidence\s*<>\s*'inferred'\s+OR\s*\(\s*evidence\s*\?\s*'basis'\s+AND\s+NOT\s*\(\s*evidence\s*\?\s*'reference'\s*\)\s*\)\s*\)/
  const checkControl = INFERRED_CHECK.test("CONSTRAINT movement_signals_inferred_shape CHECK (confidence <> 'inferred' OR (evidence ? 'basis' AND NOT (evidence ? 'reference')))") && !INFERRED_CHECK.test(sqlCode("-- CONSTRAINT movement_signals_inferred_shape CHECK (confidence <> 'inferred' OR (evidence ? 'basis' AND NOT (evidence ? 'reference')))"))
  c.rule("147B", "…AND THE DATABASE (C9 'enforced at the record, not the reader'): m892's movement_signals_inferred_shape CHECK refuses an inferred row carrying a reference for EVERY writer (read from the migration's SQL with comment lines dropped; POSITIVE CONTROL: a commented-out CHECK is not a CHECK)",
    INFERRED_CHECK.test(m892) && checkControl, `m892 CHECK present in code ${INFERRED_CHECK.test(m892)}; finder control ${checkControl}`)
  const label = (honest.evaluation?.combination?.contributions ?? []).find((x: { confidence: string }) => x.confidence === "inferred")?.reason ?? ""
  c.rule("147B", "…AND THE WORDS: every inferred contribution reads 'an inference, not a fact' and never 'verified' / 'confirmed'",
    /an inference, not a fact/.test(label) && !/^(Verified|confirmed)/i.test(label), `"${String(label).slice(0, 120)}"`)

  c.blind("The manager's model, the bus publish, the ONE responder, the agent task and the admin bell are injected seams (lane 147B's proof seams the same ones); the prompts are checked structurally by test:movement-signals, the live model's behaviour is not measured. The tick is driven with the stored-seller-signals source only; its production wiring (the enrichment-processor cron, integrator commit 0c32830e) is not executed here. memSupabase runs no CHECK — m892's inferred-shape CHECK is read from the migration text. The cron's paid / external sources (Socrata, BatchData) are never called: the source reads what their sweeps STORED.")
  return c.report()
}
