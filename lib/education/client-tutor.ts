// lib/education/client-tutor.ts
//
// CLIENT EDUCATION TUTOR (shopping_agent / listing_concierge) — the on-demand, context-aware education
// tutor for the CLIENT portals (buyer / seller / homeowner). Unlike the staff copilot, this is client-safe:
// it knows the client's role + transaction stage + agent, answers plain-language "what does this mean / what
// should I do" questions, points to the right learning_modules, and ALWAYS defers specifics to the client's
// agent / attorney / lender. It never gives legal or financial advice and never steers (Fair Housing).
//
// Every question is logged to chat_messages (session_type 'portal_widget') — which the question→curriculum
// loop then mines, so recurring client questions become new client lessons. A closed education loop.
//
// Pure prompt/guard is testable; answerTutorQuestion takes an injectable generator so tests spend no tokens.

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import type { createServiceClient } from "@/lib/supabase/service"
import { isLifetimeCustomerType } from "@/lib/contact-types"
type Svc = ReturnType<typeof createServiceClient>

export interface TutorContext {
  firstName: string | null
  role: "buyer" | "seller" | "homeowner" | "client"
  /** The contact's PERSONA (first_time_buyer, investor, senior_downsizing, past_client, …) — customer-facing
   *  coaching/education speaks FROM the persona, not the role. */
  persona: string | null
  stageLabel: string | null
  agentName: string | null
}

/** A persona → how to speak to them. Customer-facing education is persona-first, not role-first. */
const PERSONA_VOICE: Record<string, string> = {
  first_time_buyer: "a first-time buyer — they're new to all of this, so define every term, reassure often, and never assume prior knowledge",
  investor: "a real-estate investor — they think in numbers, ROI, cap rate, and timelines; be efficient and data-forward, skip the hand-holding",
  senior_downsizing: "a senior who is downsizing — be patient, respectful, unrushed, and sensitive to the emotional weight of leaving a long-time home",
  luxury_buyer: "a luxury buyer — be polished, discreet, and concierge-level; assume sophistication",
  relocation: "a relocating buyer — they're often remote and time-pressured; be logistics-forward and proactive about the out-of-area unknowns",
  move_up_seller: "a move-up seller juggling a sale and a purchase — focus on timing, contingencies, and coordinating both sides",
  past_client: "a past client and homeowner — warm, low-pressure, long-term relationship tone; think equity, maintenance, and 'when the time is right'",
}

/** PURE: the client-safe education tutor system prompt — PERSONA-first (then role/stage), Fair Housing, no advice-giving. */
export function buildTutorSystemPrompt(ctx: TutorContext): string {
  const who = ctx.firstName ? `The client's first name is ${ctx.firstName}.` : ""
  const stage = ctx.stageLabel ? `They are currently at this point in their journey: ${ctx.stageLabel}.` : ""
  const agent = ctx.agentName ? `Their agent is ${ctx.agentName} — encourage them to reach out to ${ctx.agentName} for anything specific to their deal.` : "Encourage them to reach out to their agent for anything specific to their deal."
  // Persona-first framing (falls back to the role only when no persona is known).
  const personaVoice = (ctx.persona && PERSONA_VOICE[ctx.persona]) || `a ${ctx.role}`
  return [
    `You are a warm, plain-spoken real-estate education tutor. You are speaking to ${personaVoice}. ${who} ${stage}`,
    `Tailor your tone and depth to THIS persona — the way you'd coach a first-time buyer is different from how you'd talk to a seasoned investor. Speak from who they are, not just their transaction role.`,
    `Your job is to explain what things mean and what generally happens next — clearly, calmly, at a 10th-grade reading level. ${agent}`,
    `HARD RULES:`,
    `- You are NOT a lawyer, lender, or the client's agent. Never give legal, tax, or specific financial advice — explain generally and defer specifics to the appropriate professional.`,
    `- Never invent details about THIS client's specific transaction, numbers, property, or timeline. Speak in general terms and tell them to confirm specifics with their agent.`,
    `- FAIR HOUSING: never reference or imply anything about protected classes, neighborhood demographics, "good/bad areas", schools-as-proxy, or who "fits" a neighborhood. Never steer.`,
    `- Be concise (a few short paragraphs), reassuring, and end by inviting them to ask their agent or ask you a follow-up.`,
  ].join("\n")
}

/** PURE: a coarse Fair-Housing / advice-risk guard on the generated answer. Returns true if it should be held. */
export function tutorAnswerRisky(answer: string): boolean {
  const t = (answer ?? "").toLowerCase()
  const risky = [
    /\b(protected class|race|religion|national origin|familial status|disabilit)/,
    /\bgood (school|neighborhood|area)s?\b/,
    /\bbad (school|neighborhood|area)s?\b/,
    /\bpeople like you\b/,
    /\bthis (neighborhood|area) is (mostly|predominantly)\b/,
  ]
  return risky.some((re) => re.test(t))
}

export const TUTOR_SAFE_FALLBACK =
  "That's a great question — it's best answered by your agent, who knows the specifics of your situation. " +
  "I can explain how the process works in general, though — want me to walk you through the steps?"

export type TutorGenerator = (args: { system: string; prompt: string }) => Promise<string>

export interface TutorAnswer {
  answer: string
  relatedModules: Array<{ id: string; title: string | null }>
  held: boolean
  /** Wave 155 (155F): how the answer was reached — sourced from the record / knowledge, unresolved, uncertain, deferred … */
  answered?: import("@/lib/portal/question-answer-decision").AnswerState
  /** Wave 155 (155F): where each stated fact came from (table:row.column) and its version. */
  sources?: Array<{ source: string; version: string | null }>
  /** Wave 155 (155F): whether the agent was told / a task opened (one per unresolved question). */
  ding?: { filed: boolean; deduped: boolean; notified: number }
}

/** Resolve the client's tutor context (role, stage, agent) — best-effort, ALWAYS inside the session's tenant (wave 155: a missing
 *  tenant reads nothing — it never decays into "any tenant"). */
async function resolveTutorContext(svc: Svc, contactId: string, brokerageId: string): Promise<{ ctx: TutorContext; brokerageId: string | null; agentId: string | null }> {
  const { data: c } = await svc.from("contacts").select("first_name, contact_type, contact_persona, buyer_stage, brokerage_id, agent_id").eq("id", contactId).eq("brokerage_id", brokerageId).maybeSingle()
  const cc = c as any
  const role: TutorContext["role"] = cc?.contact_type === "seller" ? "seller" : isLifetimeCustomerType(cc?.contact_type) ? "homeowner" : cc?.contact_type === "buyer" ? "buyer" : "client"
  let agentName: string | null = null
  if (cc?.agent_id) {
    const { data: a } = await svc.from("agents").select("user_id").eq("id", cc.agent_id).maybeSingle()
    const uid = (a as any)?.user_id
    if (uid) {
      const { data: u } = await svc.from("users").select("first_name, last_name").eq("id", uid).maybeSingle()
      const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
      if (full) agentName = full
    }
  }
  return {
    ctx: { firstName: cc?.first_name ?? null, role, persona: cc?.contact_persona ?? null, stageLabel: cc?.buyer_stage ? String(cc.buyer_stage).replace(/_/g, " ") : null, agentName },
    brokerageId: cc?.brokerage_id ?? null,
    agentId: cc?.agent_id ?? null,
  }
}

/**
 * Answer a client's education question: build the client-safe context, generate a plain-language answer
 * (Fair-Housing-guarded), surface the most relevant learning_modules, and LOG the turn to chat_messages so
 * the question→curriculum loop can learn from it. Injectable generator so tests spend no tokens.
 */
export async function answerTutorQuestion(
  svc: Svc,
  input: {
    contactId: string; question: string; generate?: TutorGenerator
    /** Wave 155 (155F): the SESSION's tenant (requireContactAccess) — REQUIRED; the contact is read inside it, never outside. */
    brokerageId: string
    now?: Date
  },
): Promise<TutorAnswer> {
  const question = (input.question ?? "").trim()
  if (!question) return { answer: TUTOR_SAFE_FALLBACK, relatedModules: [], held: false }
  if (!input.brokerageId) return { answer: TUTOR_SAFE_FALLBACK, relatedModules: [], held: false, answered: "refused", sources: [] }

  const { ctx, brokerageId, agentId } = await resolveTutorContext(svc, input.contactId, input.brokerageId)
  // A contact the session's tenant does not hold is indistinguishable from no contact (PRIV-001): nothing is read or said.
  if (!brokerageId) return { answer: TUTOR_SAFE_FALLBACK, relatedModules: [], held: false, answered: "refused", sources: [] }

  // Related published lessons for this client (reuses the canonical matcher).
  let relatedModules: Array<{ id: string; title: string | null }> = []
  try {
    const { pickLearningModulesForActor } = await import("@/lib/learning-router/composer")
    const picks = await pickLearningModulesForActor({ supabase: svc, actorKind: "customer", actorId: input.contactId, limit: 3 })
    relatedModules = picks.map((p) => ({ id: p.id, title: p.title }))
  } catch { /* best-effort */ }

  const system = buildTutorSystemPrompt(ctx)
  const generate: TutorGenerator = input.generate ?? (async ({ system, prompt }) => {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const { text } = await generateTextRouted({ feature: "client_education_tutor", system, prompt, temperature: 0.4, maxTokens: 500 })
    return text
  })

  // WAVE 155 (lane 155F, directive F1 / owner R10): THE ANSWER DECISION. A deal / lender / title / vendor fact is answered from
  // the RECORD (deterministic, sourced — the model is never asked for a closing date or a loan decision); a guard question
  // (injection, steering, forecast) gets its fixed answer; a general question is answered at once from the tenant's verified
  // help base, phrased by this tutor's own model and screened so it cannot add a figure the sources do not carry.
  const qad = await import("@/lib/portal/question-answer-decision")
  const decision = brokerageId
    ? await qad.decidePortalAnswer(svc, {
        brokerageId, contactId: input.contactId, question, agentName: ctx.agentName,
        generalAnswer: async ({ sources }) => (await generate({
          system: sources.length > 0 ? `${system}\nVERIFIED SOURCES — answer ONLY from these; never add a figure, date or deadline they do not contain:\n${sources.map((s) => `- ${s.title}: ${s.excerpt}`).join("\n")}` : system,
          prompt: question,
        })).trim(),
      })
    : null
  let answer = decision?.text ?? TUTOR_SAFE_FALLBACK
  let held = false
  if (tutorAnswerRisky(answer)) { answer = TUTOR_SAFE_FALLBACK; held = true }

  // Log the turn (feeds the question→curriculum loop and the repeated-question topic). Best-effort; never blocks the answer.
  let sid: string | null = null
  try {
    const { data: session, error: tutorSessionErr } = await svc.from("chat_sessions").insert({
      brokerage_id: brokerageId, contact_id: input.contactId, session_type: "portal_widget", source: "education_tutor", status: "active",
    }).select("id").single()
    if (tutorSessionErr) console.error(`[client-tutor] tutor session NOT created (the turn will not be logged): ${tutorSessionErr.message}`)
    sid = (session as any)?.id ?? null
    if (sid) {
      await sentinelWrite(svc, svc.from("chat_messages").insert([
        { session_id: sid, role: "user", content: question },
        { session_id: sid, role: "assistant", content: answer, metadata: decision ? { portal_answer: { kind: decision.cls.kind, fact: decision.cls.fact, guard: decision.cls.guard, answered: held ? "held" : decision.answered, sources: decision.sources.slice(0, 6), stripped_sentences: decision.stripped.length } } : {} },
      ]), { table: "chat_messages", flow: "chat_messages_write", reason: "turn log for the curriculum loop; the answer is returned regardless" })
    }
  } catch { /* logging best-effort */ }

  if (!decision || !brokerageId) return { answer, relatedModules, held }
  // The follow-through, AFTER the answer is composed: the ding (one per unresolved question), knowledge repair (F3), the topic (F2).
  const ding = await qad.fileQuestionDing(svc, { brokerageId, contactId: input.contactId, sessionId: sid, agentId, question, decision, surface: "portal_tutor", now: input.now })
  if (!ding.filed && !ding.deduped && ding.notified === 0 && decision.plan.notify) console.error(`[client-tutor] question ding not filed: ${ding.reason}`)
  await followThroughKnowledge(svc, { brokerageId, contactId: input.contactId, agentId, question, decision: { ...decision, answered: held ? "held" : decision.answered }, sessionId: sid, now: input.now })
  return { answer, relatedModules, held, answered: held ? "held" : decision.answered, sources: decision.sources.map((s) => ({ source: s.source, version: s.version })), ding: { filed: ding.filed, deduped: ding.deduped, notified: ding.notified } }
}

/**
 * F3 + F2 for a portal question: a shaky answer (uncertain, held, or the same person asking the same theme again within the
 * re-ask window) opens ONE knowledge-verification task first; an eligible general question is offered to the ONE repeated-
 * question feeder (lib/customer-intelligence/website-question-topics.ts — distinct askers, first-party floor, held while a
 * repair is open). Never throws; nothing here blocks the answer.
 */
async function followThroughKnowledge(svc: Svc, a: { brokerageId: string; contactId: string; agentId: string | null; question: string; decision: import("@/lib/portal/question-answer-decision").PortalAnswerDecision; sessionId: string | null; now?: Date }): Promise<void> {
  try {
    const { classifyQuestion } = await import("@/lib/education/question-gap")
    const theme = classifyQuestion(a.question)?.topic ?? null
    const qad = await import("@/lib/portal/question-answer-decision")
    if (!(a.decision.cls.kind === "general_education" || a.decision.cls.kind === "tenant_procedure") || a.decision.cls.guard) return
    let reasked = false
    if (theme) {
      const now = a.now ?? new Date()
      const since = new Date(now.getTime() - qad.REASK_WINDOW_MINUTES * 60_000).toISOString()
      const { data: sess, error: sErr } = await svc.from("chat_sessions").select("id").eq("brokerage_id", a.brokerageId).eq("contact_id", a.contactId).eq("session_type", "portal_widget").gte("created_at", since).limit(20)
      const prior = ((sess ?? []) as Array<{ id: string }>).map((s) => s.id).filter((id) => id !== a.sessionId)
      if (!sErr && prior.length > 0) {
        const { data: msgs } = await svc.from("chat_messages").select("content").in("session_id", prior).eq("role", "user").limit(50)
        reasked = ((msgs ?? []) as Array<{ content: string | null }>).some((m) => classifyQuestion(m.content)?.topic === theme)
      }
    }
    const why = qad.needsKnowledgeRepair({ answered: a.decision.answered, reaskedAfterAnswer: reasked })
    if (why && theme) {
      const r = await qad.markKnowledgeForRepair(svc, { brokerageId: a.brokerageId, agentId: a.agentId, theme, reason: why, sources: a.decision.sources.map((s) => s.source), now: a.now })
      if (r.error) console.error(`[client-tutor] knowledge repair not filed: ${r.error}`)
    }
    if (a.decision.cls.topicEligible) {
      const { considerCustomerQuestion } = await import("@/lib/customer-intelligence/website-question-topics")
      const t = await considerCustomerQuestion(svc, { brokerageId: a.brokerageId, text: a.question, now: a.now })
      if (t.status === "refused") console.error(`[client-tutor] question topic not recorded: ${t.reason}`)
    }
  } catch (e) {
    console.error("[client-tutor] knowledge follow-through failed (non-blocking):", e instanceof Error ? e.message : e)
  }
}
