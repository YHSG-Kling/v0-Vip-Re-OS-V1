"use server"

/**
 * app/actions/twin-studio.ts
 *
 * Twin Studio — server actions for the agent's AI digital-twin library.
 *
 * A "twin" = one row in agent_avatar_assets carrying everything needed to
 * make the agent appear as themselves in conversational AI surfaces:
 *   - look:       did_avatar_id (presenter)
 *   - voice:      voice_id (ElevenLabs clone)
 *   - personality: free-text system-prompt addendum
 *   - status:     pending → ready (D-ID async processing) + approval gate
 *
 * One twin is the agent's default — its voice gets synced to agents.voice_id
 * (ISA / video gen / portal widget read from there), and its presenter is
 * what the AgentsWidget renders.
 *
 * No vendor names ever surface to the user — they only see "Twin".
 */

import { resolveWriteContext } from "@/lib/kernel/identity"
import { isDidSentiment } from "@/lib/did/agent-presenter"
import { createServiceClient } from "@/lib/supabase/service"
import { syncAgentVoiceId } from "@/lib/voice/sync-voice-id"
import { revalidatePath } from "next/cache"

// ─── Types ────────────────────────────────────────────────────────────────

export interface Twin {
  id: string
  agentId: string
  brokerageId: string | null
  label: string
  sourceType: "photo" | "video"
  sourceUrl: string
  thumbnailUrl: string | null
  didAvatarId: string | null
  voiceId: string | null
  voiceSampleUrl: string | null
  personality: string | null
  /** The agent's OWN opening line — the only sentence the avatar may speak
   *  that did not come from the brain. Null means it says nothing. */
  greeting: string | null
  greetingSentiment: string | null
  status: "pending" | "processing" | "ready" | "failed"
  approvalStatus: "pending" | "approved" | "rejected"
  rejectionReason: string | null
  isDefault: boolean
  createdAt: string
  errorMessage: string | null
}

function rowToTwin(row: any): Twin {
  return {
    id: row.id,
    agentId: row.agent_id,
    brokerageId: row.brokerage_id,
    label: row.label ?? "My Twin",
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    thumbnailUrl: row.thumbnail_url,
    didAvatarId: row.did_avatar_id,
    voiceId: row.voice_id,
    voiceSampleUrl: row.voice_sample_url,
    personality: row.personality,
    greeting: row.greeting ?? null,
    greetingSentiment: row.greeting_sentiment ?? null,
    status: row.status,
    approvalStatus: row.approval_status,
    rejectionReason: row.rejection_reason,
    isDefault: !!row.is_default,
    createdAt: row.created_at,
    errorMessage: row.error_message,
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────

/** Twins owned by the current agent. */
export async function listMyTwins(): Promise<{ twins: Twin[]; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.agentId) {
    return { twins: [], error: "Unauthorized" }
  }
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("agent_avatar_assets")
    .select("*")
    .eq("agent_id", ctx.agentId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false })

  if (error) return { twins: [], error: error.message }
  return { twins: (data ?? []).map(rowToTwin) }
}

/** Pending-approval twins for the brokerage (broker / superadmin only). */
export async function listPendingApprovals(): Promise<{ twins: Twin[]; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { twins: [], error: "Unauthorized" }
  if (!["broker", "admin", "superadmin"].includes(ctx.userType)) {
    return { twins: [], error: "Forbidden" }
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("agent_avatar_assets")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("approval_status", "pending")
    .order("created_at", { ascending: false })

  if (error) return { twins: [], error: error.message }
  return { twins: (data ?? []).map(rowToTwin) }
}

// ─── Write ────────────────────────────────────────────────────────────────

/** Set this twin as the agent's default (used by portal widget, ISA, video gen). */
export async function setDefaultTwin(twinId: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.agentId) return { ok: false, error: "Unauthorized" }
  const supabase = createServiceClient()

  // Verify ownership
  const { data: twin } = await supabase
    .from("agent_avatar_assets")
    .select("id, agent_id, voice_id, status, approval_status")
    .eq("id", twinId)
    .maybeSingle()

  if (!twin || twin.agent_id !== ctx.agentId) {
    return { ok: false, error: "Twin not found" }
  }
  if (twin.status !== "ready") {
    return { ok: false, error: "Twin is still processing" }
  }
  if (twin.approval_status !== "approved") {
    return { ok: false, error: "Twin is not yet approved" }
  }

  // Clear other defaults, set this one
  await supabase
    .from("agent_avatar_assets")
    .update({ is_default: false })
    .eq("agent_id", ctx.agentId)
    .neq("id", twinId)

  await supabase
    .from("agent_avatar_assets")
    .update({ is_default: true })
    .eq("id", twinId)

  // Sync voice_id to agents.voice_id (canonical for ISA + video gen).
  // Without this, the rest of the platform keeps using the previous default.
  if (twin.voice_id) {
    await syncAgentVoiceId({ agentId: ctx.agentId, elevenlabsVoiceId: twin.voice_id })
  }

  revalidatePath("/dashboard/settings/twin-studio")
  return { ok: true }
}

/** Delete a twin. The default cannot be deleted unless another exists. */
export async function deleteTwin(twinId: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.agentId) return { ok: false, error: "Unauthorized" }
  const supabase = createServiceClient()

  const { data: twin } = await supabase
    .from("agent_avatar_assets")
    .select("id, agent_id, is_default")
    .eq("id", twinId)
    .maybeSingle()

  if (!twin || twin.agent_id !== ctx.agentId) {
    return { ok: false, error: "Twin not found" }
  }

  if (twin.is_default) {
    const { count } = await supabase
      .from("agent_avatar_assets")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", ctx.agentId)
    if ((count ?? 0) <= 1) {
      return { ok: false, error: "Cannot delete your only twin" }
    }
  }

  await supabase.from("agent_avatar_assets").delete().eq("id", twinId)
  revalidatePath("/dashboard/settings/twin-studio")
  return { ok: true }
}

/** Update a twin's display label and personality. */
export async function updateTwinDetails(params: {
  twinId: string
  label?: string
  personality?: string
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.agentId) return { ok: false, error: "Unauthorized" }
  const supabase = createServiceClient()

  const { data: twin } = await supabase
    .from("agent_avatar_assets")
    .select("agent_id")
    .eq("id", params.twinId)
    .maybeSingle()

  if (!twin || twin.agent_id !== ctx.agentId) {
    return { ok: false, error: "Twin not found" }
  }

  const update: Record<string, any> = { updated_at: new Date().toISOString() }
  if (params.label !== undefined) update.label = params.label
  if (params.personality !== undefined) update.personality = params.personality

  await supabase.from("agent_avatar_assets").update(update).eq("id", params.twinId)
  revalidatePath("/dashboard/settings/twin-studio")
  return { ok: true }
}

// ─── Broker approval gate ─────────────────────────────────────────────────

export async function approveTwin(twinId: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!["broker", "admin", "superadmin"].includes(ctx.userType)) {
    return { ok: false, error: "Forbidden" }
  }
  const supabase = createServiceClient()

  // Brokerage scope check — broker can only approve twins in their brokerage.
  const { data: twin } = await supabase
    .from("agent_avatar_assets")
    .select("id, brokerage_id, approval_status")
    .eq("id", twinId)
    .maybeSingle()
  if (!twin) return { ok: false, error: "Twin not found" }
  if (twin.brokerage_id !== ctx.brokerageId) return { ok: false, error: "Forbidden" }

  await supabase
    .from("agent_avatar_assets")
    .update({
      approval_status: "approved",
      approved_by: ctx.userId,
      approved_at: new Date().toISOString(),
      rejection_reason: null,
    })
    .eq("id", twinId)

  revalidatePath("/dashboard/settings/twin-studio")
  return { ok: true }
}

export async function rejectTwin(params: {
  twinId: string
  reason: string
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!["broker", "admin", "superadmin"].includes(ctx.userType)) {
    return { ok: false, error: "Forbidden" }
  }
  if (!params.reason?.trim()) return { ok: false, error: "Reason required" }
  const supabase = createServiceClient()

  const { data: twin } = await supabase
    .from("agent_avatar_assets")
    .select("brokerage_id, is_default")
    .eq("id", params.twinId)
    .maybeSingle()
  if (!twin) return { ok: false, error: "Twin not found" }
  if (twin.brokerage_id !== ctx.brokerageId) return { ok: false, error: "Forbidden" }

  await supabase
    .from("agent_avatar_assets")
    .update({
      approval_status: "rejected",
      rejection_reason: params.reason.trim(),
      // If the rejected twin was the default, clear that flag — public surfaces
      // shouldn't render an unapproved twin.
      is_default: twin.is_default ? false : undefined,
    })
    .eq("id", params.twinId)

  revalidatePath("/dashboard/settings/twin-studio")
  return { ok: true }
}

// ─── Twin creation orchestration ──────────────────────────────────────────
//
// Twin creation is multi-step (look → voice → personality) but we can't make
// the wizard dependent on three sequential server hops. The flow:
//   1. createTwinDraft   — inserts a 'pending' row with the look only
//   2. /api/did/create-avatar (extended in this commit) — kicks off D-ID
//      processing for the look on that twin row
//   3. attachVoiceToTwin — once the user records/uploads, kicks off ElevenLabs
//      voice clone and stores voice_id on the same row
//   4. finalizeTwin      — sets personality + flips approval per brokerage
//      policy + optionally promotes to default
// ──────────────────────────────────────────────────────────────────────────

export async function createTwinDraft(params: {
  label: string
  sourceType: "photo" | "video"
  sourceUrl: string
}): Promise<{ ok: boolean; twinId?: string; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.agentId) return { ok: false, error: "Unauthorized" }

  const supabase = createServiceClient()

  // Brokerage approval policy: if twins_require_approval, new twins land in
  // 'pending' for broker review before they can go live.
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("twins_require_approval")
    .eq("id", ctx.brokerageId)
    .maybeSingle()
  const initialApproval = brokerage?.twins_require_approval ? "pending" : "approved"

  const { data, error } = await supabase
    .from("agent_avatar_assets")
    .insert({
      agent_id: ctx.agentId,
      brokerage_id: ctx.brokerageId,
      label: params.label.slice(0, 64),
      source_type: params.sourceType,
      source_url: params.sourceUrl,
      status: "pending",
      approval_status: initialApproval,
      is_default: false,
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !data) return { ok: false, error: error?.message ?? "Insert failed" }
  return { ok: true, twinId: data.id }
}

export async function attachVoiceToTwin(params: {
  twinId: string
  voiceId: string
  voiceSampleUrl: string
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.agentId) return { ok: false, error: "Unauthorized" }
  const supabase = createServiceClient()

  const { data: twin } = await supabase
    .from("agent_avatar_assets")
    .select("agent_id")
    .eq("id", params.twinId)
    .maybeSingle()
  if (!twin || twin.agent_id !== ctx.agentId) return { ok: false, error: "Twin not found" }

  await supabase
    .from("agent_avatar_assets")
    .update({
      voice_id: params.voiceId,
      voice_sample_url: params.voiceSampleUrl,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.twinId)

  return { ok: true }
}

export async function finalizeTwin(params: {
  twinId: string
  personality?: string
  /** Authored opening line. Empty string clears it — that is a real choice. */
  greeting?: string
  greetingSentiment?: string
  setAsDefault?: boolean
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.agentId) return { ok: false, error: "Unauthorized" }
  const supabase = createServiceClient()

  const { data: twin } = await supabase
    .from("agent_avatar_assets")
    .select("agent_id, status, approval_status, voice_id")
    .eq("id", params.twinId)
    .maybeSingle()
  if (!twin || twin.agent_id !== ctx.agentId) return { ok: false, error: "Twin not found" }

  const details: Record<string, unknown> = {}
  if (params.personality !== undefined) details.personality = params.personality
  // The greeting is REFUSED rather than truncated when it is too long, and the
  // sentiment is refused rather than defaulted when it is not in the vocabulary
  // — D-ID silently falls back on an unknown sentiment, so accepting one here
  // would store a preference that never reaches the avatar.
  if (params.greeting !== undefined) {
    const g = params.greeting.trim()
    if (g.length > 300) return { ok: false, error: "Keep the greeting under 300 characters — it is spoken aloud." }
    details.greeting = g || null
  }
  if (params.greetingSentiment !== undefined) {
    const v = params.greetingSentiment.trim()
    if (v && !isDidSentiment(v)) return { ok: false, error: "That tone isn't one D-ID supports." }
    details.greeting_sentiment = v || null
  }
  if (Object.keys(details).length > 0) {
    details.updated_at = new Date().toISOString()
    await supabase.from("agent_avatar_assets").update(details).eq("id", params.twinId)
  }

  // setDefault is only honored when the twin is ready + approved — same gate
  // as setDefaultTwin().
  if (params.setAsDefault && twin.status === "ready" && twin.approval_status === "approved") {
    await supabase
      .from("agent_avatar_assets")
      .update({ is_default: false })
      .eq("agent_id", ctx.agentId)
      .neq("id", params.twinId)

    await supabase
      .from("agent_avatar_assets")
      .update({ is_default: true })
      .eq("id", params.twinId)

    if (twin.voice_id) {
      await syncAgentVoiceId({ agentId: ctx.agentId, elevenlabsVoiceId: twin.voice_id })
    }
  }

  revalidatePath("/dashboard/settings/twin-studio")
  return { ok: true }
}
