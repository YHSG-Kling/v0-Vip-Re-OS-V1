"use server"

import { generateTextRouted } from "@/lib/ai/models"
// THE SPEND ACTOR. Every export in this "use server" file is a public HTTP
// endpoint, so the AI cost ledger's tenant can only come from the SESSION
// (CLAUDE.md §4) — never from an id the caller supplied.
import { getAgentContext } from "@/lib/identity/get-agent-context"

export async function askRelationshipAI(params: {
  question: string
  contactName: string
  contactPersona?: string | null
  systemPrompt?: string
}): Promise<{ success: boolean; answer?: string; error?: string }> {
  const { question, contactName, contactPersona, systemPrompt } = params

  // Tenant for the AI cost ledger — SESSION (§4). Every argument here is
  // caller-supplied copy; none of it can name a payer.
  const spendActor = await getAgentContext()
  return ledgered(spendActor, { action: "crm.relationship_advice.ask", subject: { type: "user", id: spendActor.userId }, riskClass: "LOW_RISK_WRITE" }, async () => {

  if (!question?.trim()) {
    return { success: false, error: "Question is required" }
  }

  const resolvedSystemPrompt = systemPrompt ??
    `You are a real estate relationship advisor. The agent is asking about their client named ${contactName}${contactPersona ? ` (persona: ${contactPersona})` : ""}. Give concise, actionable advice in 2-3 sentences. Be specific and practical.`

  // Single egress through generateTextRouted: gateway + AI_TASK_ROUTING + automatic fallback
  // model + fair-use accounting + cost log. Previously this file had a direct-OpenAI fallback
  // that bypassed the gateway entirely (defeating cost metering, rate-limit pooling, healer).
  // The routed wrapper IS the correct fallback layer: if the primary model fails, it falls back
  // to the routing table's secondary model — all under the same single egress.
  if (!process.env.AI_GATEWAY_API_KEY) {
    return { success: false, error: "AI provider not configured. Please add AI_GATEWAY_API_KEY to environment variables." }
  }

  try {
    const { text } = await generateTextRouted({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
      feature:     "ai_isa_response",
      system:      resolvedSystemPrompt,
      prompt:      question.trim(),
      maxTokens:   600,
    })

    return { success: true, answer: text.trim() }
  } catch (err: any) {
    console.error("[v0] Relationship AI error:", err)
    return { success: false, error: "Failed to generate advice. Please try again." }
  }
  })
}

/**
 * WAVE 155 (lane 155R9, G12): ONE agent_action_ledger receipt per session write — ledgerSessionAction
 * (lib/kernel/action-ledger.ts) does the claim → run → settle. Who and which tenant come from the SESSION (CLAUDE.md §4);
 * "session" resolves them through getAgentContext. NO idempotency key: a person's second save runs again and leaves a
 * second receipt. The export's value comes back unchanged; a refused claim (only a malformed action name, caught by
 * test:action-ledger §14) throws instead of returning a value of another shape. No session tenant → the write runs exactly
 * as before, unrecorded (agent_action_ledger.brokerage_id is NOT NULL — there is no valid row to write).
 * @proofSeam scripts/ledger-receipts-transaction2-guard.ts
 */
async function ledgered<T>(
  who: { userId?: string | null; brokerageId?: string | null; agentId?: string | null } | null | undefined | "session",
  what: { action: string; subject: { type: string; id?: string | null; ref?: string | null }; riskClass: string; detail?: Record<string, unknown> },
  run: () => Promise<T>,
): Promise<T> {
  const seat = who === "session" ? await (await import("@/lib/identity/get-agent-context")).getAgentContext() : who
  if (!seat?.userId || !seat.brokerageId) return run()
  const id = what.subject.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(what.subject.id) ? what.subject.id : null
  const subject = { type: what.subject.type, id, ref: id ? what.subject.ref ?? null : what.subject.ref ?? what.subject.id ?? null }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  let ran = false
  const r = await ledgerSessionAction({ brokerageId: seat.brokerageId, action: what.action, actor: { type: "user", userId: seat.userId, agentId: seat.agentId ?? null }, subject, riskClass: what.riskClass, reasonCode: "HUMAN_REQUESTED", detail: what.detail ?? null }, async () => { ran = true; return run() })
  if (!ran) throw new Error((r as { error?: string }).error ?? "action ledger refused the claim")
  return r as T
}
