"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { requireContactAccess } from "@/lib/portal/require-contact-access"
import { answerTutorQuestion, type TutorAnswer } from "@/lib/education/client-tutor"

/**
 * Client portal education tutor — answer a client's plain-language education question. Contact-scoped AND
 * session-gated (requireContactAccess — the same gate the /portal/[contactId] surface passes). Client-safe,
 * Fair-Housing-guarded, logs the turn for the question→curriculum loop.
 */
export async function askEducationTutor(contactId: string, question: string): Promise<TutorAnswer> {
  if (!contactId || !question?.trim()) return { answer: "Ask me anything about your journey and I'll explain it.", relatedModules: [], held: false }
  // Wave 139 (139G, P1): "the portal link is the credential" was not true of THIS door — a "use server"
  // export is callable with no session at all, so any contact id bought a model answer (platform-paid AI)
  // grounded in that contact's journey. /portal is session-gated by the proxy, so the gate the portal
  // already passes is the one the action now requires (self, accepted invitee, or the brokerage's staff).
  const access = await requireContactAccess(contactId)
  if (!access.ok) return { answer: "I couldn't find your portal — please use the link your agent sent you.", relatedModules: [], held: false }
  const svc = createServiceClient()
  // Guard: the contact must exist IN THE SESSION'S TENANT (a bad/expired portal link resolves to nothing).
  const { data: contact } = await svc.from("contacts").select("id").eq("id", contactId).eq("brokerage_id", access.brokerageId).maybeSingle()
  if (!contact) return { answer: "I couldn't find your portal — please use the link your agent sent you.", relatedModules: [], held: false }
  // Wave 155 (155F, INJECT-001): the tenant is the SESSION's (access.brokerageId) — nothing in the question or the request
  // body can name another one; the tutor reads the contact, the deal and the knowledge inside it only.
  return answerTutorQuestion(svc, { contactId, question: question.slice(0, 1000), brokerageId: access.brokerageId })
}

/**
 * WAVE 155 (lane 155F, directive F1.6 / F1.7) — THE ASSIGNED HUMAN RECORDS THE OUTSIDE PARTY'S REPLY to a client's portal
 * question (the task the assistant opened: "Ask <lender / title> (not on the platform) and record the reply"). Staff only:
 * the session's tenant, and the caller is the task's assigned agent, the deal's TC or a tenant admin. The reply becomes a
 * sourced memory row, the question is re-evaluated from the record, the client gets the answer on the portal at most once,
 * and the task closes with that evidence (lib/portal/question-answer-decision.ts recordQuestionReply). A vendor with a seat
 * answers through its own portal writers instead; a chat message claiming to be the vendor is never accepted here.
 */
export async function recordPortalQuestionReplyAction(input: { taskId: string; status: "confirmed" | "not_yet" | "date"; date?: string | null; note?: string | null }): Promise<{ ok: boolean; status?: string; error?: string }> {
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) return { ok: false, error: "Not signed in" }
  if (!input?.taskId || !["confirmed", "not_yet", "date"].includes(input.status)) return { ok: false, error: "Missing reply" }
  const svc = createServiceClient()
  const { data: task, error } = await svc.from("tasks").select("id, assigned_to_agent_id, transaction_id").eq("id", input.taskId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
  if (error) return { ok: false, error: "Could not read the task" }
  if (!task) return { ok: false, error: "Task not found" }
  const { TENANT_ADMIN_USER_TYPES } = await import("@/lib/auth/resolve-user-role")
  let allowed = (!!ctx.agentId && task.assigned_to_agent_id === ctx.agentId) || TENANT_ADMIN_USER_TYPES.has(ctx.userType)
  if (!allowed && ctx.userType === "tc" && task.transaction_id) {
    const { data: tx } = await svc.from("transactions").select("coordinator_id").eq("id", task.transaction_id).eq("brokerage_id", ctx.brokerageId).maybeSingle()
    const { data: tc } = tx?.coordinator_id ? await svc.from("transaction_coordinators").select("user_id").eq("id", tx.coordinator_id).eq("brokerage_id", ctx.brokerageId).maybeSingle() : { data: null }
    allowed = tc?.user_id === ctx.userId
  }
  if (!allowed) return { ok: false, error: "Only the assigned agent, the deal's TC or an admin can record this reply" }
  const { recordQuestionReply } = await import("@/lib/portal/question-answer-decision")
  const r = await recordQuestionReply(svc, { brokerageId: ctx.brokerageId, taskId: input.taskId, provenance: { kind: "staff", userId: ctx.userId }, reply: { status: input.status, date: input.date ?? null, note: input.note ?? null } })
  return r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, error: r.reason }
}
