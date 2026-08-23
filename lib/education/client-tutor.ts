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
}

/** Resolve the client's tutor context (role, stage, agent) — best-effort. */
export async function resolveTutorContext(svc: Svc, contactId: string): Promise<{ ctx: TutorContext; brokerageId: string | null }> {
  const { data: c } = await svc.from("contacts").select("first_name, contact_type, contact_persona, buyer_stage, brokerage_id, agent_id").eq("id", contactId).maybeSingle()
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
  }
}

/**
 * Answer a client's education question: build the client-safe context, generate a plain-language answer
 * (Fair-Housing-guarded), surface the most relevant learning_modules, and LOG the turn to chat_messages so
 * the question→curriculum loop can learn from it. Injectable generator so tests spend no tokens.
 */
export async function answerTutorQuestion(
  svc: Svc,
  input: { contactId: string; question: string; generate?: TutorGenerator },
): Promise<TutorAnswer> {
  const question = (input.question ?? "").trim()
  if (!question) return { answer: TUTOR_SAFE_FALLBACK, relatedModules: [], held: false }

  const { ctx, brokerageId } = await resolveTutorContext(svc, input.contactId)

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

  let answer = ""
  try { answer = (await generate({ system, prompt: question })).trim() } catch { answer = TUTOR_SAFE_FALLBACK }
  let held = false
  if (tutorAnswerRisky(answer)) { answer = TUTOR_SAFE_FALLBACK; held = true }

  // Log the turn (feeds the question→curriculum loop). Best-effort; never blocks the answer.
  try {
    const { data: session } = await svc.from("chat_sessions").insert({
      brokerage_id: brokerageId, contact_id: input.contactId, session_type: "portal_widget", source: "education_tutor", status: "active",
    }).select("id").single()
    const sid = (session as any)?.id
    if (sid) {
      await svc.from("chat_messages").insert([
        { session_id: sid, role: "user", content: question },
        { session_id: sid, role: "assistant", content: answer },
      ])
    }
  } catch { /* logging best-effort */ }

  return { answer, relatedModules, held }
}
