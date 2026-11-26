"use server"

/**
 * app/actions/avatar-video.ts
 *
 * TEAMMATE VIDEO lane — server actions for the video studio create surface.
 * Thin auth shell over lib/video/avatar-explainer: the caller is always
 * resolved from the session (never trusted from params), then the lane
 * module commissions onto the EXISTING Director rail (ai_video_projects →
 * director-reel-render → poll-did-videos → composition render → unified
 * approval queue at approval_status='pending_review').
 *
 * D-ID + ElevenLabs ONLY (no HeyGen). Provider gating is honest: no D-ID key
 * → the commission parks at status='awaiting_provider' and the readiness
 * action auto-resumes parked jobs once the key exists.
 */

import { createClient } from "@/lib/supabase/server"
import { resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"
import { isValidUUID } from "@/lib/validations"
import {
  AVATAR_EXPLAINER_PRESETS,
  commissionAvatarExplainer,
  getAvatarExplainerReadiness,
  resumeAwaitingProviderExplainers,
  type AvatarExplainerPreset,
  type AvatarExplainerReadiness,
  type CommissionAvatarExplainerResult,
} from "@/lib/video/avatar-explainer"

interface Caller {
  userId: string
  brokerageId: string
}

async function resolveCaller(): Promise<{ ok: true; caller: Caller } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: row } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  const brokerageId = (row as { brokerage_id: string | null } | null)?.brokerage_id ?? null
  if (!brokerageId) return { ok: false, error: "No brokerage on your account" }
  return { ok: true, caller: { userId: user.id, brokerageId } }
}

export interface TeammateExplainerReadinessResult {
  success: boolean
  error?: string
  readiness?: AvatarExplainerReadiness
  /** Parked awaiting-provider jobs resumed on this load (D-ID key now present). */
  resumedAwaiting?: number
  recent?: Array<{
    id: string
    title: string | null
    status: string | null
    approval_status: string | null
    created_at: string | null
  }>
}

/** Provider/voice readiness for the create surface + best-effort resume of
 *  parked jobs + the agent's recent teammate-explainer projects. */
export async function getTeammateExplainerReadiness(): Promise<TeammateExplainerReadinessResult> {
  const auth = await resolveCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  return ledgered(auth.caller, { action: "marketing.avatar_explainer.resume_parked", subject: { type: "brokerage", id: auth.caller.brokerageId }, riskClass: "LOW_RISK_WRITE" }, async () => {
  const { userId, brokerageId } = auth.caller

  try {
    const readiness = await getAvatarExplainerReadiness({ brokerageId, agentUserId: userId })

    // Un-park any awaiting-provider jobs now that (or if) the key exists.
    const { resumed } = await resumeAwaitingProviderExplainers(brokerageId)

    // Recent lane projects — session client, so RLS scopes visibility.
    const supabase = await createClient()
    // Scoped: resolveCaller already fixed the brokerage this surface acts in.
    // No agents row ⇒ no projects of your own, which is an empty list; the
    // readiness itself is still worth returning.
    const agentId = await resolveAgentIdInBrokerage(supabase, userId, brokerageId)
    const { data: recentRows, error: recentError } = agentId
      ? await supabase
          .from("ai_video_projects")
          .select("id, title, status, approval_status, created_at")
          .eq("brokerage_id", brokerageId)
          .eq("agent_id", agentId)
          .contains("video_metadata", { lane: "avatar_explainer" })
          .order("created_at", { ascending: false })
          .limit(5)
      : { data: [], error: null }
    if (recentError) {
      return { success: false, error: recentError.message }
    }

    return {
      success: true,
      readiness,
      resumedAwaiting: resumed,
      recent: (recentRows ?? []) as TeammateExplainerReadinessResult["recent"],
    }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
  })
}

export interface CreateTeammateExplainerInput {
  presetId?: AvatarExplainerPreset["id"] | null
  topic: string
  audience: string
  listingId?: string | null
}

export interface CreateTeammateExplainerResult {
  success: boolean
  error?: string
  violations?: string[]
  videoProjectId?: string
  /** 'staged' → rendering starts on the next cron tick;
   *  'awaiting_provider' → honest park until D-ID is configured. */
  status?: "staged" | "awaiting_provider"
  compositionId?: string
  voiceSource?: AvatarExplainerReadiness["voiceSource"]
  warnings?: string[]
}

/** Commission a teammate explainer video (AI-authored script in the brand
 *  voice → ElevenLabs voice → D-ID avatar → Remotion brand frames → the
 *  unified pending_review approval queue). */
export async function createTeammateExplainerVideo(
  input: CreateTeammateExplainerInput,
): Promise<CreateTeammateExplainerResult> {
  const auth = await resolveCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  return ledgered(auth.caller, { action: "marketing.avatar_explainer.commission", subject: { type: "listing", id: input.listingId ?? null, ref: input.listingId ? null : "avatar_explainer:new" }, riskClass: "FINANCIAL", detail: { preset_id: input.presetId ?? null } }, async () => {
  const { userId, brokerageId } = auth.caller

  const topic = (input.topic ?? "").trim()
  const audience = (input.audience ?? "").trim()
  if (topic.length < 3 || topic.length > 300) {
    return { success: false, error: "Topic must be between 3 and 300 characters" }
  }
  if (audience.length > 120) {
    return { success: false, error: "Audience must be 120 characters or fewer" }
  }
  const presetId = AVATAR_EXPLAINER_PRESETS.some((p) => p.id === input.presetId)
    ? (input.presetId as AvatarExplainerPreset["id"])
    : null
  const listingId = input.listingId && isValidUUID(input.listingId) ? input.listingId : null

  const result: CommissionAvatarExplainerResult = await commissionAvatarExplainer({
    brokerageId,
    agentUserId: userId,
    topic,
    audience,
    presetId,
    listingId,
  })

  if (!result.ok) {
    return { success: false, error: result.reason, violations: result.violations }
  }
  return {
    success: true,
    videoProjectId: result.videoProjectId,
    status: result.status,
    compositionId: result.compositionId,
    voiceSource: result.voiceSource,
    warnings: result.warnings,
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
