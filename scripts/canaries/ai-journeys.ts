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
import { LIVE, canary } from "./_harness"
import { findLanded } from "./_registry"
import { memSupabase } from "../in-memory-supabase"

export async function run() {
  const c = canary("AI journeys: life-change / intent signal → governed interpretation → next-best action (incl. a qualified professional) → evidence")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only")
  const UNWIRED = false as boolean
  const { SIGNAL_REGISTRY } = await import("../../lib/kernel/signal-registry")
  const spec = (k: string) => (SIGNAL_REGISTRY as Record<string, { consumers: string[]; disposition: string }>)[k]

  // ── 1 · client-initiated intent is handled (green — preserve) ──
  const nm = spec("next_move_intent"), hot = spec("seller_intent_hot")
  c.rule("144F", "CLIENT-INITIATED INTENT IS EVALUATED (green — preserve): a lifetime customer's 'Your Next Move' tap (next_move_intent) and a hot seller-intent read (seller_intent_hot) are HANDLED by registered managers (sphere_of_influence / ai_isa + listing_concierge) — never a feed line nobody acts on", !!nm && nm.disposition === "handled" && nm.consumers.length > 0 && !!hot && hot.disposition === "handled" && hot.consumers.length > 0, `next_move_intent ${nm?.disposition} [${nm?.consumers}] · seller_intent_hot ${hot?.disposition} [${hot?.consumers}]`)

  // ── 2 · system-detected life-change signals TRIGGER an evaluation ──
  const lifeChange = ["refinance_opportunity", "equity_milestone"].map((k) => ({ k, s: spec(k) }))
  c.rule("144F", "A DETECTED LIFE CHANGE TRIGGERS A GOVERNED EVALUATION (ruling 11: 'possibly refinancing etc. … TRIGGERS an action inside the platform … through a governed evaluation and next-best action'): the equity-trigger's refinance_opportunity and equity_milestone signals are HANDLED by a registered consumer manager that evaluates them (next-best action under authority) — not feed-only", lifeChange.every(({ s }) => !!s && s.disposition === "handled" && s.consumers.length > 0), `HEAD: ${lifeChange.map(({ k, s }) => `${k} ${s?.disposition ?? "absent"} [${s?.consumers?.join(",") ?? ""}]`).join(" · ")}`)
  // WAVE144 WIRE (integrator): 144E/144F — online moving / home-sale / buying-intent signal sources routed to leads + contacts.
  const onlineIntent = Object.keys(SIGNAL_REGISTRY).filter((k) => /moving_intent|move_intent_online|life_change|life_event|online_intent|relocation_intent|home_sale_intent|buying_intent|refinance_intent/.test(k))
  const handler = findLanded(["lib/kernel/event-reactor.ts", "lib/kernel/manager-signals.ts", "lib/ai-isa", "lib/kernel/lifetime-conversion.ts"], /\b(life_change|life_event|moving_intent|online_intent|home_sale_intent|buying_intent|refinance_intent)\b/)
  c.rule("144F", "ONLINE INTENT / LIFE EVENTS FROM PROVIDERS WE ALREADY USE ARE ROUTED (rulings 10–11: moving, home-sale interest, buying intent, refinance, lawful public life events): each source lane 144E registers becomes a signal with a consumer manager that evaluates it for the lead / contact / lifetime person it matches — respecting source terms, consent and communication rules", onlineIntent.length > 0 && handler !== null && UNWIRED, `HEAD: registered online-intent / life-change signals: ${onlineIntent.join(", ") || "none"}; handler ${handler ?? "none"} — wire the 'signal → evaluated → next best' assertion here once 144E's '## Signals available' land`)

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
  const kinds = [...(lap as unknown as { EXPERIENCE_KINDS: readonly string[] }).EXPERIENCE_KINDS]
  c.rule("144F", "THE NEXT-BEST MENU INCLUDES A QUALIFIED PROFESSIONAL (ruling 11: 'message, education, human task, property review, referral to a qualified professional'): for a refinance / life-change moment the planner can rank a referral to a qualified professional (a lender, a vendor on the Deal Team / vendor bench) as its own experience kind, executed by its registered manager — never a message that pretends to be advice", kinds.some((k) => /referr|professional|vendor|lender|specialist/.test(k)), `HEAD EXPERIENCE_KINDS: ${kinds.join(", ")}`)

  c.blind("The manager-signal HANDLERS are not driven here (the registry is the contract each handler is held to by test:signal-integrity); the arbiter ran with an injected model and recorder seams. Raw leads have consented to nothing (CLAUDE.md §5) — for them the governed evaluation is the identity / dedup / territory gate (the seller-journey canary), never outreach.")
  return c.report([], 0)
}
