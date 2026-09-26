"use server"

/**
 * app/actions/command-center.ts
 *
 * Approve / reject mutations for the Agent Command Center approval queue.
 * Approve routes through the REAL executors (executeAction /
 * executeAssetManagerAction) so the governance contract holds: a human
 * approver's id is stamped (approved_by) before the action executes — there is
 * no autonomous self-execution. Reject transitions a proposed action to
 * 'skipped' with the same approver provenance.
 */
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { executeAction } from "@/lib/agents/marketing-agent-actions"
import { executeAssetManagerAction } from "@/lib/agents/asset-manager-actions"
import { executeAdManagerAction } from "@/lib/ads/ad-manager"
import { approveContentSource, rejectContentSource, type ContentQueue } from "@/lib/kernel/approval-sources"

type Queue = "marketing" | "asset" | "ads" | "client_message" | ContentQueue
type AgentQueue = "marketing" | "asset" | "ads"
const TABLE: Record<AgentQueue, "marketing_agent_actions" | "asset_manager_actions" | "ad_manager_actions"> = {
  marketing: "marketing_agent_actions",
  asset:     "asset_manager_actions",
  ads:       "ad_manager_actions",
}

/** Resolve the acting user and confirm they may approve agent actions. */
async function requireApprover(): Promise<{ userId: string; brokerageId: string | null; isSuperadmin: boolean; role: string } | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }
  const { data: u } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  const role = u?.user_type ?? "agent"
  // SCOPE LADDER (kept inline — isSuperadmin below hands wider scope): dead
  // 'superadmin' removed from the array only — 0 live rows store that
  // users.user_type, so it admitted nobody (isSuperadmin stays dead-false,
  // unchanged behavior). broker_owner added: storable seat that owns the brokerage.
  if (!["admin", "broker", "broker_owner"].includes(role)) return { error: "Not authorized to approve agent actions" }
  return { userId: user.id, brokerageId: u?.brokerage_id ?? null, isSuperadmin: role === "superadmin", role }
}

/**
 * Record an outbound client-message decision to the Compliance Officer's audit ledger — the
 * verdict is recomputed SERVER-SIDE from the final copy + the recipient's live consent, so the
 * record is tamper-proof. Best-effort: never blocks or fails the approve/reject it documents.
 */
async function recordClientMessageDecision(
  actionId: string,
  actor: { userId: string; role: string; brokerageId: string | null },
  decision: "approved" | "rejected",
  editedBody?: string,
): Promise<void> {
  try {
    const svc = createServiceClient()
    const { data: m } = await svc.from("agent_client_messages")
      .select("brokerage_id, channel, body, recipient_contact_id")
      .eq("id", actionId).maybeSingle()
    if (!m) return
    let consent = { recipientWithdrawn: false, emailRevoked: false, smsRevoked: false }
    if ((m as any).recipient_contact_id) {
      const { data: c } = await svc.from("contacts")
        .select("nurture_status, email_opt_out, email_unsubscribed, sms_opt_out")
        .eq("id", (m as any).recipient_contact_id).maybeSingle()
      if (c) consent = {
        recipientWithdrawn: (c as any).nurture_status === "withdrawn",
        emailRevoked: !!(c as any).email_opt_out || !!(c as any).email_unsubscribed,
        smsRevoked: !!(c as any).sms_opt_out,
      }
    }
    const { recordEgressComplianceDecision } = await import("@/lib/kernel/compliance-ledger")
    await recordEgressComplianceDecision({
      brokerageId: (m as any).brokerage_id ?? actor.brokerageId ?? "",
      actorUserId: actor.userId, actorRole: actor.role,
      queue: "client_message", entityId: actionId, channel: (m as any).channel ?? "portal",
      text: editedBody ?? (m as any).body ?? "", consent, decision,
    }, svc)
  } catch { /* audit is best-effort — never breaks the decision */ }
}

/**
 * Record a BROADCAST content decision (social/newsletter/blog/…) to the compliance ledger — the
 * Fair Housing verdict recomputed server-side from the item's copy (no per-recipient consent, so
 * advisory-only). Completes the ledger: every outbound copy decision is recorded, not just 1:1
 * messages. Best-effort; only the outbound-copy queues (skips internal transaction/task queues).
 */
async function recordContentDecision(
  queue: Queue,
  actionId: string,
  actor: { userId: string; role: string; brokerageId: string | null },
  decision: "approved" | "rejected",
): Promise<void> {
  try {
    const { OUTBOUND_COPY_QUEUES, extractProposalCopy } = await import("@/lib/kernel/command-center")
    if (!OUTBOUND_COPY_QUEUES.has(queue)) return
    const svc = createServiceClient()
    const { loadOneContentAction } = await import("@/lib/kernel/approval-sources")
    const action = await loadOneContentAction(queue as ContentQueue, actionId, svc)
    if (!action) return
    const text = extractProposalCopy(action.actionInput)
    if (!text) return
    const { recordEgressComplianceDecision } = await import("@/lib/kernel/compliance-ledger")
    await recordEgressComplianceDecision({
      brokerageId: action.brokerageId ?? actor.brokerageId ?? "",
      actorUserId: actor.userId, actorRole: actor.role,
      queue, entityId: actionId, channel: "content",
      text, consent: { recipientWithdrawn: false, emailRevoked: false, smsRevoked: false }, decision,
    }, svc)
  } catch { /* audit is best-effort — never breaks the decision */ }
}

/** Confirm the action exists, is still proposed, and is in the approver's scope. */
async function loadScopedAction(queue: AgentQueue, actionId: string, brokerageId: string | null, isSuperadmin: boolean) {
  const svc = createServiceClient()
  const { data } = await svc.from(TABLE[queue])
    .select("id, brokerage_id, status")
    .eq("id", actionId)
    .maybeSingle()
  if (!data) return { error: "Action not found" as const }
  if (!isSuperadmin && brokerageId && data.brokerage_id !== brokerageId) return { error: "Action outside your brokerage" as const }
  if (data.status !== "proposed") return { error: `Action already ${data.status}` as const }
  return { ok: true as const }
}

export async function approveAgentAction(params: { queue: Queue; actionId: string; editedBody?: string }) {
  const actor = await requireApprover()
  if ("error" in actor) return { ok: false, error: actor.error }

  // Social posts approve through the existing, self-scoping social action — the
  // Command Center is just a second (unified) surface onto the SAME write.
  if (params.queue === "social") {
    await recordContentDecision(params.queue, params.actionId, actor, "approved")
    const { approveSocialPost } = await import("@/app/actions/social-media-automation")
    const res = await approveSocialPost(params.actionId)
    revalidatePath("/dashboard/admin/command-center")
    return { ok: !!res.success, status: res.success ? "approved" : "failed", error: res.error }
  }
  // Newsletter + direct-mail + ad-creative + predictive-touch + transaction-task
  // all release through the content-approval registry.
  if (params.queue === "newsletter" || params.queue === "direct_mail" || params.queue === "ad_creative" || params.queue === "predictive_listing" || params.queue === "transaction_task" || params.queue === "transaction_smart_task" || params.queue === "agent_followup" || params.queue === "blog" || params.queue === "podcast") {
    await recordContentDecision(params.queue, params.actionId, actor, "approved")
    const res = await approveContentSource(params.queue, params.actionId, { userId: actor.userId, brokerageId: actor.brokerageId, isSuperadmin: actor.isSuperadmin })
    revalidatePath("/dashboard/admin/command-center")
    return { ok: res.ok, status: res.status, error: res.error }
  }
  // Deal-critical managers' client messages: approving SENDS the seller/buyer update.
  if (params.queue === "client_message") {
    const { approveClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await approveClientMessage(params.actionId, actor.userId, params.editedBody)
    await recordClientMessageDecision(params.actionId, actor, "approved", params.editedBody)
    revalidatePath("/dashboard/admin/command-center")
    return { ok: res.status === "sent", status: res.status, result: res.result }
  }

  const scope = await loadScopedAction(params.queue, params.actionId, actor.brokerageId, actor.isSuperadmin)
  if ("error" in scope) return { ok: false, error: scope.error }

  const result = params.queue === "marketing"
    ? await executeAction(params.actionId, actor.userId)
    : params.queue === "ads"
    ? await executeAdManagerAction(params.actionId, actor.userId)
    : await executeAssetManagerAction(params.actionId, actor.userId)

  revalidatePath("/dashboard/admin/command-center")
  return { ok: result.status !== "failed", status: result.status, result: result.result }
}

export async function rejectAgentAction(params: { queue: Queue; actionId: string }) {
  const actor = await requireApprover()
  if ("error" in actor) return { ok: false, error: actor.error }

  if (params.queue === "social") {
    await recordContentDecision(params.queue, params.actionId, actor, "rejected")
    const { rejectSocialPost } = await import("@/app/actions/social-media-automation")
    const res = await rejectSocialPost(params.actionId, undefined, "Rejected in Command Center")
    revalidatePath("/dashboard/admin/command-center")
    return { ok: !!res.success, status: "rejected" as const, error: res.error }
  }
  if (params.queue === "newsletter" || params.queue === "direct_mail" || params.queue === "ad_creative" || params.queue === "predictive_listing" || params.queue === "transaction_task" || params.queue === "transaction_smart_task" || params.queue === "agent_followup" || params.queue === "blog" || params.queue === "podcast") {
    await recordContentDecision(params.queue, params.actionId, actor, "rejected")
    const res = await rejectContentSource(params.queue, params.actionId, { userId: actor.userId, brokerageId: actor.brokerageId, isSuperadmin: actor.isSuperadmin })
    revalidatePath("/dashboard/admin/command-center")
    return { ok: res.ok, status: "rejected" as const, error: res.error }
  }
  if (params.queue === "client_message") {
    await recordClientMessageDecision(params.actionId, actor, "rejected")
    const { rejectClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await rejectClientMessage(params.actionId, actor.userId)
    revalidatePath("/dashboard/admin/command-center")
    return { ok: res.ok, status: "rejected" as const }
  }

  const scope = await loadScopedAction(params.queue, params.actionId, actor.brokerageId, actor.isSuperadmin)
  if ("error" in scope) return { ok: false, error: scope.error }

  const svc = createServiceClient()
  const { error } = await svc.from(TABLE[params.queue])
    .update({ status: "skipped", approved_by: actor.userId, approved_at: new Date().toISOString() })
    .eq("id", params.actionId)
    .eq("status", "proposed")
  if (error) return { ok: false, error: error.message }

  revalidatePath("/dashboard/admin/command-center")
  return { ok: true, status: "skipped" as const }
}

/**
 * COMMAND YOUR TEAM (text) — the One Command Center capstone: the human types a plain-language
 * instruction and it routes through the SAME dispatcher the voice admin uses (no second brain).
 * The deterministic parser maps the text to a { name, params }; read-only commands return the
 * team's spoken answer, ACTING verbs delegate to backends that each enforce their own gate
 * (proposal→approval + consent re-check for follow-ups, Fair Housing pre-flight for promos, etc.)
 * — nothing sends autonomously. Ambiguous text returns a rephrase prompt rather than mis-route.
 */
export async function runTeamCommand(
  text: string,
): Promise<{ ok: boolean; spoken: string; command?: string; acting?: boolean }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, spoken: "You're not signed in." }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id, first_name")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, spoken: "I can't find your brokerage — contact your admin." }

  const { parseTeamCommandText } = await import("@/lib/voice/parse-team-command")
  const parsed = parseTeamCommandText(text)
  if (!parsed) {
    return { ok: false, spoken: "I didn't catch a team command in that. Try \"what should I do today\", \"what do you know about <name>\", \"anything near <address>\", or \"cut a reel for <listing>\"." }
  }

  const { dispatchTeamCommand } = await import("@/lib/voice/team-commands")
  const { TEAM_ACTION_COMMANDS } = await import("@/lib/voice/team-command-names")
  const r = await dispatchTeamCommand(
    parsed.name,
    parsed.params,
    { brokerageId: u.brokerage_id, agentUserId: user.id, firstName: u.first_name ?? null },
  )
  const acting = TEAM_ACTION_COMMANDS.has(parsed.name)
  if (acting && r.ok) revalidatePath("/dashboard/admin/command-center")
  return { ok: r.ok, spoken: r.spoken, command: parsed.name, acting }
}
