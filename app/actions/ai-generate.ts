"use server"

/**
 * app/actions/ai-generate.ts — Server Action wrappers.
 *
 * All implementation lives in lib/ai/generate.ts (canonical location).
 * Next.js requires "use server" files to export only async functions —
 * re-export syntax is not permitted, so each function is explicitly wrapped.
 *
 * IMPORT RULES (Next 16 / Turbopack):
 *   · Server-side callers (app/actions/*, other lib/* files, route handlers,
 *     RSCs): import from "@/lib/ai/generate" directly — no Server Action
 *     overhead, no per-call POST round-trip.
 *   · Client components ("use client"): import from this file. Importing
 *     "@/lib/ai/generate" directly causes Turbopack to walk the transitive
 *     graph into Node-only modules (e.g. @ai-sdk/gateway, runPipelineSimple
 *     → DB writes) and the client bundle fails.
 */

import {
  generateAIText as _generateAIText,
  generateAIJSON as _generateAIJSON,
  generateAIObject as _generateAIObject,
  generateChatResponse as _generateChatResponse,
} from "@/lib/ai/generate"
import type { z } from "zod"

export async function generateAIText(
  prompt: string,
  options?: { maxTokens?: number; temperature?: number; feature?: string }
): Promise<{ text: string; error?: string }> {
  return _generateAIText(prompt, options)
}

export async function generateAIJSON<T = Record<string, unknown>>(
  prompt: string,
  options?: { model?: string; maxTokens?: number; temperature?: number; feature?: string }
): Promise<{ data: T | null; error?: string }> {
  return ledgered("session", { action: "ai.json.generate", subject: { type: "ai_feature", ref: options?.feature ?? "generic" }, riskClass: "LOW_RISK_WRITE" }, async () => {
  return _generateAIJSON<T>(prompt, options)
  })
}

export async function generateAIObject<T extends z.ZodType>(
  prompt: string,
  schema: T,
  options?: { model?: string; temperature?: number }
): Promise<{ success: boolean; object?: z.infer<T>; error?: string }> {
  return _generateAIObject<T>(prompt, schema, options)
}

export async function generateChatResponse(
  userMessage: string,
  context: string
): Promise<{ text: string; error?: string }> {
  return _generateChatResponse(userMessage, context)
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
