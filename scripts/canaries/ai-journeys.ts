/**
 * scripts/canaries/ai-journeys.ts — AI JOURNEYS canary (wave 144, lane 144J; owner rulings 11 + 12 + 18):
 *   a life change / online intent (thinking of moving, possibly refinancing …) TRIGGERS a governed evaluation and a
 *   next-best action in the existing manager fabric — message, education, human task, property review, referral to a
 *   qualified professional — for leads, contacts and the lifetime type, with evidence (who / why / which facts / which policy);
 *   source terms, privacy, consent and communication rules respected; no invented behaviour.
 * Through the survivors at 967a4866: lib/kernel/signal-registry.ts (SIGNAL_REGISTRY — every signal names its consumers and
 * disposition), lib/ai-isa/lead-action-plan.ts (planNextBestExperience, EXPERIENCE_KINDS / EXPERIENCE_EXECUTORS),
 * lib/ai-isa/followup-arbiter.ts arbitrateAndRecordExperience (injected model + recorder seams — the evidence the ledger
 * receives). In memory; nothing is sent.
 *
 * MEASURED AT 967a4866: the client-initiated next_move_intent is handled (sphere_of_influence), but the system-detected
 * refinance_opportunity and equity_milestone signals are FEED-ONLY (no consumer evaluates them) and the next-best menu has
 * no "refer to a qualified professional" kind — 144F (signal sources: 144E).
 */
import { LIVE, canary, canaryClient, setSvc } from "./_harness"
import { findLanded, strippedRepo } from "./_registry"
import { memSupabase } from "../in-memory-supabase"

export async function run() {
  const c = canary("AI journeys: life-change / intent signal → governed interpretation → next-best action (incl. a qualified professional) → evidence")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only")
  const { SIGNAL_REGISTRY } = await import("../../lib/kernel/signal-registry")
  const spec = (k: string) => (SIGNAL_REGISTRY as Record<string, { consumers: string[]; disposition: string }>)[k]

  // ── 1 · client-initiated intent is handled (green — preserve) ──
  const nm = spec("next_move_intent"), hot = spec("seller_intent_hot")
  c.rule("144F", "CLIENT-INITIATED INTENT IS EVALUATED (green — preserve): a lifetime customer's 'Your Next Move' tap (next_move_intent) and a hot seller-intent read (seller_intent_hot) are HANDLED by registered managers (sphere_of_influence / ai_isa + listing_concierge) — never a feed line nobody acts on", !!nm && nm.disposition === "handled" && nm.consumers.length > 0 && !!hot && hot.disposition === "handled" && hot.consumers.length > 0, `next_move_intent ${nm?.disposition} [${nm?.consumers}] · seller_intent_hot ${hot?.disposition} [${hot?.consumers}]`)

  // ── 2 · system-detected life-change signals TRIGGER an evaluation ──
  // Lane 144Z: the two equity-trigger lines are HANDLED by the Sphere Manager (lib/kernel/manager-signals.ts) through the ONE
  // life-change responder. Beyond the registry contract, the chain is DRIVEN: a bus row exactly as the reactor publishes it → the
  // Sphere's inbox (consumeManagerSignals) → the registered handler → the responder → a signal_reactivations row for the lifetime
  // client (the Sphere's gated loop; a lifetime client is never engaged directly) — on the harness's in-memory service client.
  const { SIGNAL_HANDLERS, consumeManagerSignals, MANAGERS_FOR_PROOF } = await (async () => {
    const ms = await import("../../lib/kernel/manager-signals")
    const reg = await import("../../lib/kernel/manager-registry")
    return { SIGNAL_HANDLERS: ms.SIGNAL_HANDLERS as Record<string, unknown>, consumeManagerSignals: ms.consumeManagerSignals, MANAGERS_FOR_PROOF: reg.MANAGERS as Record<string, unknown> }
  })()
  const B = "33333333-3333-4333-8333-333333333333", LIFE = "44444444-4444-4444-8444-444444444444", LIFE2 = "55555555-5555-4555-8555-555555555555"
  const bus = canaryClient({
    contacts: [{ id: LIFE, brokerage_id: B, contact_type: "lifetime_customer", first_name: "Lee", last_name: "Past" }, { id: LIFE2, brokerage_id: B, contact_type: "lifetime_customer", first_name: "Max", last_name: "Past" }],
    manager_signals: [
      { id: "ms-eq", brokerage_id: B, from_manager: "data_steward", to_manager: "sphere_of_influence", signal_type: "refinance_opportunity", message: "A lifetime contact has a rate-improvement refinance opportunity.", entity_type: "contact", entity_id: LIFE, contact_id: LIFE, payload: { transaction_id: null, quarter: "2026Q4" }, status: "open", created_at: new Date().toISOString() },
    ],
    signal_reactivations: [], agent_action_ledger: [],
  })
  setSvc(bus)
  const quiet = <T,>(f: () => Promise<T>) => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; return f().finally(() => { console.warn = w; console.error = e }) }
  const eqRun = await quiet(() => consumeManagerSignals({ brokerageId: B, toManager: "sphere_of_influence" as never }, bus as never))
  const eqRows = (bus.tables.signal_reactivations ?? []).filter((r) => r.contact_id === LIFE && r.signal_type === "refinance_opportunity")
  const eqConsumed = (bus.tables.manager_signals ?? []).find((r) => r.id === "ms-eq")?.status === "consumed"
  const lifeChange = ["refinance_opportunity", "equity_milestone"].map((k) => ({ k, s: spec(k) }))
  const handlersOk = lifeChange.every(({ k, s }) => !!s && s.disposition === "handled" && s.consumers.length > 0 && s.consumers.every((m) => m in MANAGERS_FOR_PROOF && typeof SIGNAL_HANDLERS[`${m}:${k}`] === "function"))
  c.rule("144F", "A DETECTED LIFE CHANGE TRIGGERS A GOVERNED EVALUATION (ruling 11: 'possibly refinancing etc. … TRIGGERS an action inside the platform … through a governed evaluation and next-best action'): the equity-trigger's refinance_opportunity and equity_milestone signals are HANDLED by a registered consumer manager that evaluates them (next-best action under authority) — not feed-only — and the bus row DRIVES it: the Sphere's inbox consumes the refinance line and the ONE responder files it for the lifetime client's gated loop", handlersOk && eqRun.consumed === 1 && eqConsumed && eqRows.length === 1, `${lifeChange.map(({ k, s }) => `${k} ${s?.disposition ?? "absent"} [${s?.consumers?.join(",") ?? ""}]`).join(" · ")}; inbox consumed ${eqRun.consumed}; signal rows ${eqRows.length}`)

  // ── 2b · ONLINE INTENT / LIFE EVENTS from providers we already use are PUSHED and answered (lane 144Z) ──
  // A write lands a NEW Versium online real-estate indicator on a lifetime contact → publishNewIntentFacts (the writer's hand-off) →
  // ONE `online_intent_detected` bus row → the AI ISA's registered handler → the responder (kind 'moving' from the source's own
  // intents) → the Sphere's signal row. Controls: an age fact (a birth date) publishes NOTHING; an unchanged re-capture publishes
  // NOTHING; a stored property fact (a refinance date) is not a change. Respecting source terms / consent: nothing is sent here —
  // a lifetime client reaches the Sphere's gated loop, a contact the consent-gated engagement (its own proof, test:intent-driven-followup).
  const iss = await import("../../lib/enrichment/intent-signal-sources")
  const NOWI = new Date()
  const ind = (on: boolean, refi: string | null = null) => ({ enrichment_profile: { real_estate_indicators: { onlinePresenceRealEstate: on, refinanceDate: refi, capturedAt: "2026-10-20T00:00:00.000Z" } } })
  const newBehaviour = iss.newIntentFacts(ind(false), ind(true), NOWI)
  const unchanged = iss.newIntentFacts(ind(true), ind(true), NOWI)
  const ageOnly = iss.newIntentFacts({ enrichment_profile: {} }, { enrichment_profile: { birth_date: "1980-05-01", captured_at: "2026-10-20T00:00:00.000Z" } }, NOWI)
  const propertyOnly = iss.newIntentFacts(ind(false), ind(false, "2026-09-01"), NOWI)
  const pushed = await quiet(() => iss.publishNewIntentFacts(bus, { brokerageId: B, contactId: LIFE2 }, ind(false), ind(true), NOWI))
  const intentRow = (bus.tables.manager_signals ?? []).find((r) => r.signal_type === "online_intent_detected" && r.entity_id === LIFE2)
  // The in-memory client has no column DEFAULTs: apply the live one (manager_signals.status DEFAULT 'open', information_schema read
  // 2026-10-26) to the row the publisher wrote, exactly as the database would — the publisher never names the column.
  if (intentRow && intentRow.status === undefined) intentRow.status = "open"
  const isaRun = await quiet(() => consumeManagerSignals({ brokerageId: B, toManager: "ai_isa" as never }, bus as never))
  const intentRows = (bus.tables.signal_reactivations ?? []).filter((r) => r.contact_id === LIFE2)
  const onlineSpec = spec("online_intent_detected")
  const onlineIntent = Object.keys(SIGNAL_REGISTRY).filter((k) => /moving_intent|move_intent_online|life_change|life_event|online_intent|relocation_intent|home_sale_intent|buying_intent|refinance_intent/.test(k))
  const handler = findLanded(["lib/kernel/event-reactor.ts", "lib/kernel/manager-signals.ts", "lib/ai-isa", "lib/kernel/lifetime-conversion.ts"], /\b(life_change|life_event|moving_intent|online_intent|home_sale_intent|buying_intent|refinance_intent)\b/)
  // The writers hand their BEFORE / AFTER rows to the push (stripped source: a tombstone or a comment is not a call site).
  const writersPush = ["lib/enrichment/online-presence-store.ts", "lib/enrichment/contact-enrichment-core.ts"].every((f) => /publishNewIntentFacts\s*\(/.test(strippedRepo(f) ?? ""))
  const wired = !!onlineSpec && onlineSpec.disposition === "handled" && onlineSpec.consumers.includes("ai_isa") && typeof SIGNAL_HANDLERS["ai_isa:online_intent_detected"] === "function"
  const behaviourKind = newBehaviour.length === 1 ? (await import("../../lib/ai-isa/followup-arbiter")).intentFactSignalType(newBehaviour[0]) : null
  c.rule("144F", "ONLINE INTENT / LIFE EVENTS FROM PROVIDERS WE ALREADY USE ARE ROUTED (rulings 10–11: moving, home-sale interest, buying intent, refinance, lawful public life events): each source lane 144E registers becomes a signal with a consumer manager that evaluates it for the lead / contact / lifetime person it matches — respecting source terms, consent and communication rules: a NEW online real-estate indicator is pushed ONCE onto the bus (online_intent_detected → the AI ISA's registered handler → the ONE responder), filed under the source's own intent (moving); an age fact, an unchanged re-capture and a stored property fact publish nothing", wired && onlineIntent.length > 0 && handler !== null && writersPush && newBehaviour.length === 1 && behaviourKind === "moving_intent" && unchanged.length === 0 && ageOnly.length === 0 && propertyOnly.length === 0 && pushed.published === 1 && !!intentRow && isaRun.consumed >= 1 && intentRows.length === 1 && intentRows[0].signal_type === "moving_intent", `registered ${onlineIntent.join(", ") || "none"} (${onlineSpec?.disposition ?? "absent"} [${onlineSpec?.consumers?.join(",") ?? ""}]); writers push ${writersPush}; new ${newBehaviour.map((f) => f.key).join(",")} → ${behaviourKind}; unchanged ${unchanged.length}, age ${ageOnly.length}, property ${propertyOnly.length}; published ${pushed.published}; ISA inbox consumed ${isaRun.consumed}; signal row ${intentRows.map((r) => r.signal_type).join(",") || "none"}`)

  // ── 3 · interpretation → next-best → EVIDENCE (green — preserve) ──
  const lap = await import("../../lib/ai-isa/lead-action-plan")
  const arb = await import("../../lib/ai-isa/followup-arbiter")
  const policy = (await import("../../lib/ai-isa/followup-policy")).platformFollowupPolicy()
  const NOW = new Date("2026-10-25T15:00:00.000Z")
  const input = {
    now: NOW, subject: "contact" as const, nba: { intent: { score: 70, trend: "rising", velocityPerDay: 1, accelerationPerDay2: 0, confidence: "medium", independentSources: 2, momentumRank: 70, evidence: [] }, memoryFacts: [{ key: "timeline", value: "3-6" }] },
    person: { contactType: "lifetime_customer", persona: "past_client", hasAssignedAgent: true },
    behavior: { touchpoints7d: 0, lastTouchpointChannel: null, portalEducationViews: 2 },
    transaction: null, education: null, fatigue: { riskLevel: null },
    policy: { complianceHardFlag: false, allowedChannels: ["email", "portal"], autoSendAllowed: true, videoAllowed: false },
  } as unknown as import("../../lib/ai-isa/lead-action-plan").NextBestExperienceInput
  const plan = lap.planNextBestExperience(input)
  const recorded: Array<Record<string, unknown>> = []
  const sink = { ledger: async (ctx: Record<string, unknown>, run: () => Promise<unknown>) => { recorded.push(ctx); return run() }, emit: async () => ({ inserted: true }), delegate: async () => ({ ok: true, delegation: { id: "d1" } }) }
  const r = await arb.arbitrateAndRecordExperience(memSupabase({}, { uuidIds: true, stampCreatedAt: true }), { brokerageId: "B", contactId: "C", input, plan, now: NOW, policy, systemSource: "canary", moment: { key: "refinance_opportunity", intent: "Rates fell below the client's loan rate; they may want a refinance review.", daysSinceOpen: 0 } }, { decide: async () => ({ optionId: "communication", channel: "email", waitHours: null, rationale: "A rate drop matters to them; a short note from their agent explains the options without pressure.", evidence: ["moment", "intent"], confidence: 0.8 }), record: sink as never })
  const d = r.decision
  c.rule("144F", "INTERPRETATION → NEXT-BEST → EVIDENCE (green — preserve; Constitution law 5): a life-change MOMENT on a lifetime contact is decided from a closed, permitted menu and the decision carries its rationale, the fact keys it rests on, its confidence and its source — and that detail is what the ledger receives", !!d && typeof d.rationale === "string" && d.rationale.length > 10 && d.source === "ai" && d.evidence.includes("moment") && d.menu.length > 0 && recorded.length + (r.recorded ? 1 : 0) > 0, d ? `${d.source} ${d.kind}/${d.channel ?? "-"} evidence [${d.evidence.join(",")}] menu [${d.menu.join(",")}]` : "no decision")
  // Lane 144Z: professional_referral is its own experience kind. DRIVEN: a refinance signal on a lifetime contact → the planner's
  // SIGNAL slice ranks it → the model picks it from the permitted menu (a person's task, never a message) → recordAndExecuteExperience
  // runs the ISA's introduction rail, which writes ONE agent task naming the brokerage's lender bench. Control: with no agent of
  // record nothing is pretended — the rail reports unexecuted with the reason.
  const kinds = [...(lap as unknown as { EXPERIENCE_KINDS: readonly string[] }).EXPERIENCE_KINDS]
  const exec = (lap.EXPERIENCE_EXECUTORS as Record<string, { manager: string }>).professional_referral
  const AG = "66666666-6666-4666-8666-666666666666", RC = "77777777-7777-4777-8777-777777777777", RC2 = "88888888-8888-4888-8888-888888888888"
  const refiSvc = canaryClient({
    contacts: [{ id: RC, brokerage_id: B, contact_type: "lifetime_customer", first_name: "Ria", last_name: "Refi", agent_id: AG }, { id: RC2, brokerage_id: B, contact_type: "lifetime_customer", first_name: "No", last_name: "Agent", agent_id: null }],
    vendors: [{ id: "v-lender", brokerage_id: B, name: "Canary Home Loans", category: "lender" }, { id: "v-title", brokerage_id: B, name: "Canary Title", category: "title" }],
    signal_reactivations: [{ id: "sr1", brokerage_id: B, contact_id: RC, signal_type: "refinance_opportunity", signal_strength: 70, triggered_at: new Date(NOW.getTime() - 86_400_000).toISOString(), signal_data: {} }],
    activities: [], agent_action_ledger: [],
  })
  setSvc(refiSvc)
  const refiInput = { ...input, policy: { ...input.policy, allowedChannels: ["email"] } } as typeof input
  const pick = async () => ({ optionId: "professional_referral", channel: "human_task", waitHours: null, rationale: "A refinance question is best answered by a lender the client chooses; their agent offers the introduction.", evidence: ["signals", "moment"], confidence: 0.8 })
  const ledgerSink = { ledger: async (_c: Record<string, unknown>, run: () => Promise<unknown>) => run(), emit: async () => ({ inserted: true }), delegate: async () => ({ ok: true, delegation: { id: "d1" } }) }
  const refi = await quiet(() => arb.arbitrateAndRecordExperience(refiSvc, { brokerageId: B, contactId: RC, input: refiInput, plan: lap.planNextBestExperience(refiInput), now: NOW, policy, systemSource: "canary" }, { decide: pick as never, record: ledgerSink as never }))
  const task = (refiSvc.tables.activities ?? []).find((t) => t.contact_id === RC && t.agent_id === AG)
  const ranked = refi.plan.ranked.some((r) => r.kind === "professional_referral")
  const noAgent = await quiet(() => lap.prepareProfessionalIntroduction(refiSvc, { brokerageId: B, contactId: RC2, reasons: ["refinance"], now: NOW }))
  c.rule("144F", "THE NEXT-BEST MENU INCLUDES A QUALIFIED PROFESSIONAL (ruling 11: 'message, education, human task, property review, referral to a qualified professional'): for a refinance / life-change moment the planner can rank a referral to a qualified professional (a lender, a vendor on the Deal Team / vendor bench) as its own experience kind, executed by its registered manager — never a message that pretends to be advice: the arbiter may choose it (a person's task, stance notify_human), the ISA's rail writes ONE agent task naming the brokerage's lender bench (not the title vendor) and stating the client chooses (RESPA §8); with no agent of record nothing is pretended", kinds.includes("professional_referral") && !!exec && exec.manager in MANAGERS_FOR_PROOF && ranked && refi.decision?.source === "ai" && refi.decision.kind === "professional_referral" && refi.decision.stance === "notify_human" && refi.recorded.execution.mode === "caller" && !!task && /Canary Home Loans/.test(String(task.description)) && !/Canary Title/.test(String(task.description)) && /client chooses/i.test(String(task.description)) && !noAgent.ok, `decision ${refi.decision?.source}/${refi.decision?.kind}/${refi.decision?.stance}${refi.decision?.fallbackReason ? ` (${refi.decision.fallbackReason.slice(0, 80)})` : ""}; execution ${refi.recorded.execution.mode}${refi.recorded.execution.mode === "unexecuted" ? ` (${(refi.recorded.execution as { reason: string }).reason.slice(0, 80)})` : ""}; task ${task ? "written" : "absent"}; ranked ${ranked}; executor ${exec?.manager ?? "none"}; no-agent ${noAgent.ok ? "ok?!" : (noAgent as { reason: string }).reason.slice(0, 60)}; kinds ${kinds.join(", ")}`)

  c.blind("The equity / online-intent HANDLERS are driven through the Sphere's and the ISA's inbox on the harness's in-memory service client (no RLS, no trigger), with LIFETIME subjects only — a contact's governed engagement (engageContact → the arbiter → the consent-gated dispatch) is test:intent-driven-followup's, never driven here (no send). The equity-trigger scan and the event reactor's publish are not run: the bus row is seeded as the reactor writes it. The other manager-signal HANDLERS are not driven here (the registry is the contract each handler is held to by test:signal-integrity); the arbiter ran with an injected model and recorder seams. Raw leads have consented to nothing (CLAUDE.md §5) — for them the governed evaluation is the identity / dedup / territory gate (the seller-journey canary), never outreach.")
  return c.report([], 0)
}
