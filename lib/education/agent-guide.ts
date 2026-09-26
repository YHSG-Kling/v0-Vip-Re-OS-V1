/**
 * lib/education/agent-guide.ts
 *
 * ON-DEMAND GUIDANCE — "someone is always there helping" (owner rule).
 * An agent asks the team HOW anything works ("how do I set up my voice
 * twin?", "what happens when a contract is uploaded?") and gets an
 * immediate answer GROUNDED in the tenant's own published curriculum —
 * with the module link for the deep dive. The loop closes itself: every
 * question is logged to the SAME chat ledger the question-gap miner
 * reads (chat_messages user turns), so a topic the library can't answer
 * yet becomes a proven gap the curriculum author writes a lesson for —
 * the library grows from real questions, not guesses.
 *
 * CONSOLIDATION: the client-facing tutor (client-tutor.ts) answers
 * CLIENTS inside the portal; THIS is the AGENT-facing twin on the team
 * bus, reusing the published learning_modules as its only knowledge
 * grounding (never free-wheeling advice) + the persona-copy gateway with
 * a deterministic fallback. NOT server-only (simulator-driven).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = SupabaseClient<any, any, any>

export interface GuideMatch {
  moduleId: string
  title: string
  summary: string | null
  estimatedMinutes: number | null
}

export interface GuideAnswer {
  spoken: string
  matches: GuideMatch[]
  /** true when nothing in the library answered — the question was logged
   *  as a gap signal for the curriculum author. */
  gapLogged: boolean
}

/** PURE: pick the question's meaningful terms (the match keys). */
export function guideSearchTerms(question: string): string[] {
  const STOP = new Set(["how", "do", "i", "the", "a", "an", "what", "is", "are", "my", "to", "of", "in", "for", "on", "does", "can", "we", "with", "set", "up", "me", "it", "and", "or", "when", "where", "why", "work", "works"])
  return Array.from(new Set(
    question.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  )).slice(0, 6)
}

/** PURE: the deterministic answer when the gateway is down — honest,
 *  module-pointing, never invented instruction. */
export function composeGuideFallback(question: string, matches: GuideMatch[]): string {
  // `question` WAS ACCEPTED HERE AND READ BY NOTHING until 2026-08-24, and this is
  // the one branch where the agent most needs it: a bare "I don't have a guide on
  // that yet" gives them no way to tell whether the library is missing the topic or
  // the search simply misread them. It now says WHAT it looked for — the same terms
  // `guideSearchTerms` hands the query, which is also what the gap miner logs — so a
  // misread question is visibly a misread question and can be rephrased.
  const asked = question.trim()
  if (matches.length === 0) {
    const terms = guideSearchTerms(asked)
    const looked = terms.length > 0 ? ` I searched the academy for ${terms.map((t) => `"${t}"`).join(", ")}.` : ""
    return `I don't have a published guide on that yet — I've flagged it, and when it keeps coming up the team authors a lesson for it.${looked} Meanwhile, ask me about anything on your setup card or the academy, or just tell me what you're trying to do and I'll route you.`
  }
  const top = matches[0]
  const more = matches.length > 1 ? ` There ${matches.length - 1 === 1 ? "is 1 more guide" : `are ${matches.length - 1} more guides`} on this in the academy.` : ""
  const forWhat = asked ? ` for "${asked}"` : ""
  return `Yes — "${top.title}"${top.estimatedMinutes ? ` (${top.estimatedMinutes} min)` : ""} covers exactly that${top.summary ? `: ${top.summary}` : "."} It's in your academy${forWhat}.${more}`
}

/**
 * Answer an agent's how-do-I question from the published library, log the
 * question for the gap miner, and return the spoken line + module links.
 */
export async function answerAgentQuestion(
  svc: Svc,
  input: { brokerageId: string; userId: string; question: string; copyGenerator?: CopyGenerator },
): Promise<GuideAnswer> {
  const question = input.question.trim()
  const terms = guideSearchTerms(question)

  // Grounding: PUBLISHED modules only (tenant's own + any it can see).
  let matches: GuideMatch[] = []
  if (terms.length > 0) {
    const ors = terms.map((t) => `title.ilike.%${t}%,summary.ilike.%${t}%`).join(",")
    const { data } = await svc.from("learning_modules")
      .select("id, title, summary, estimated_minutes")
      .eq("brokerage_id", input.brokerageId)
      .eq("status", "published")
      .or(ors)
      .limit(3)
    matches = ((data ?? []) as any[]).map((m) => ({
      moduleId: m.id, title: m.title, summary: m.summary ?? null, estimatedMinutes: m.estimated_minutes ?? null,
    }))
  }

  // Log the question to the SAME ledger the question-gap miner reads
  // (chat_messages user turns via chat_sessions) — the library grows from
  // what people actually ask. One internal_assistant session per user.
  let gapLogged = false
  try {
    // chat_sessions.agent_id FKs agents.id (live contract) — resolve the
    // caller's agents row; a broker/admin without one logs agent-less.
    const { data: agentRow } = await svc.from("agents")
      .select("id").eq("user_id", input.userId).eq("brokerage_id", input.brokerageId).maybeSingle()
    const agentId = ((agentRow as any)?.id as string | null) ?? null

    let sessionQ = svc.from("chat_sessions")
      .select("id")
      .eq("brokerage_id", input.brokerageId)
      .eq("session_type", "internal_assistant")
    sessionQ = agentId ? sessionQ.eq("agent_id", agentId) : sessionQ.is("agent_id", null)
    const { data: session } = await sessionQ.limit(1).maybeSingle()
    let sessionId = (session as any)?.id as string | undefined
    if (!sessionId) {
      const { data: created } = await svc.from("chat_sessions").insert({
        brokerage_id: input.brokerageId,
        agent_id: agentId,
        session_type: "internal_assistant",
        source: "agent_guide",
        status: "active",
      }).select("id").single()
      sessionId = (created as any)?.id
    }
    if (sessionId) {
      await svc.from("chat_messages").insert({
        session_id: sessionId, role: "user", content: question,
        metadata: { surface: "agent_guide", asked_by_user_id: input.userId, matched_modules: matches.length },
      })
      gapLogged = matches.length === 0
    }
  } catch { /* logging is best-effort — the answer still flows */ }

  // The spoken answer — gateway-composed, grounded ONLY in the matched
  // module facts; deterministic fallback keeps it honest when the gateway
  // is down or nothing matched.
  const fallback = composeGuideFallback(question, matches)
  let spoken = fallback
  if (matches.length > 0) {
    try {
      const { generatePersonaCopy } = await import("@/lib/kernel/ai-copy")
      spoken = (await generatePersonaCopy(
        {
          goal: "answer an agent's how-do-I question in 2-3 spoken sentences, grounded ONLY in the provided guide titles/summaries (never invent steps), ending by pointing them to the guide",
          facts: [
            `Question: ${question}`,
            ...matches.map((m) => `Guide: "${m.title}"${m.summary ? ` — ${m.summary}` : ""}${m.estimatedMinutes ? ` (${m.estimatedMinutes} min)` : ""}`),
          ],
          channel: "portal",
          persona: { audience: "agent", situation: "asking the AI team how a feature works" },
          words: 70,
        },
        { body: fallback },
        { generator: input.copyGenerator },
      )).body
    } catch { /* fallback stands */ }
  }

  return { spoken, matches, gapLogged }
}
