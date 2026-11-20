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
  generateAIJSON as _generateAIJSON,
  generateAIObject as _generateAIObject,
} from "@/lib/ai/generate"
import type { z } from "zod"

// TOMBSTONE (wave 155, lane 155R29; CLAUDE.md §1 case 2 — the functionality lives elsewhere): generateAIText and generateChatResponse
// DELETED from this file (generateAIJSON / generateAIObject stay — lead-intelligence.ts imports this module). No runtime file imported
// either wrapper: every other `generateAIText` / `generateChatResponse` in the tree is the lib function itself (namesakes).
//   · generateAIText → survivor lib/ai/generate.ts:64 generateAIText, which server code imports directly per this file's own IMPORT
//     RULES (app/actions/neighborhood-reports.ts:7 import, :342 call; lib/ads/ad-creative-engine.ts:162; the narration modules).
//   · generateChatResponse (a fixed "user is viewing property …" chat template) → the product's chat responders: the staff assistant
//     app/api/internal/ai-chat/route.ts:366 POST (app/components/shared/internal-ai-assistant.tsx:596 transport) and the website
//     visitor chat app/api/widget/message/route.ts:42 POST.
// Both wrappers were public model-spending doors (gated in 155S2, which named retirement the integrator's census call). Nothing merged.

export async function generateAIJSON<T = Record<string, unknown>>(
  prompt: string,
  options?: { model?: string; maxTokens?: number; temperature?: number; feature?: string }
): Promise<{ data: T | null; error?: string }> {
  const refused = await refuseWithoutSession()
  if (refused) return { data: null, error: refused }
  return ledgered("session", { action: "ai.json.generate", subject: { type: "ai_feature", ref: options?.feature ?? "generic" }, riskClass: "LOW_RISK_WRITE" }, async () => {
  return _generateAIJSON<T>(prompt, options)
  })
}

export async function generateAIObject<T extends z.ZodType>(
  prompt: string,
  schema: T,
  options?: { model?: string; temperature?: number }
): Promise<{ success: boolean; object?: z.infer<T>; error?: string }> {
  const refused = await refuseWithoutSession()
  if (refused) return { success: false, error: refused }
  return _generateAIObject<T>(prompt, schema, options)
}

/**
 * WAVE 155 (lane 155S2): THE GATE every export here runs before the model. Each is a public endpoint ("use server") that
 * spent on a model for whoever posted to it — no session was read (lib/ai/generate.ts resolves the tenant to BOOK the
 * spend to, but never refused a caller without one). Now a caller with no session, or a session with no tenant, is
 * refused and no model is reached. No importer exists today (scripts/orphan-export-baseline.json carries the file);
 * retiring it is the integrator's census call — the gate stands either way.
 * @proofSeam scripts/wave155-ungated-deal-guard.ts
 */
async function refuseWithoutSession(): Promise<string | null> {
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  return ctx.isAuthenticated && ctx.brokerageId ? null : "Not authenticated"
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
