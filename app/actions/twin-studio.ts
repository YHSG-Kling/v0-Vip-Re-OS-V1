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

import { resolveActingContext, resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import { isDidSentiment } from "@/lib/did/agent-presenter"
import { createServiceClient } from "@/lib/supabase/service"
import { syncAgentVoiceId } from "@/lib/voice/sync-voice-id"
import { revalidatePath } from "next/cache"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

// ─── Types ────────────────────────────────────────────────────────────────

export interface Twin {
  id: string
  agentId: string
  brokerageId: string | null
  label: string
  sourceType: "photo" | "video"
  /** What the agent uploaded — the raw photo/video that went to D-ID. */
  sourceUrl: string
  /**
   * THE FINISHED AVATAR, RE-HOSTED IN OUR OWN SUPABASE BUCKET.
   *
   * Written by lib/did/avatar-completion.ts:applyAvatarOutcome once D-ID says
   * "done": it downloads the finished asset and uploads it to `twin-avatars` at
   * `rehosted/{assetId}.{ext}`, and THIS is the url every surface should render
   * — the D-ID CDN url it came from expires. Null until the avatar finishes.
   */
  avatarUrl: string | null
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
    avatarUrl: row.avatar_url ?? null,
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
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.agentId) {
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
  const ctx = await resolveActingContext()
  if (!ctx.ok) return { twins: [], error: "Unauthorized" }
  if (!isAdminOrBroker({ user_type: ctx.userType })) {
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
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.agentId) return { ok: false, error: "Unauthorized" }
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
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.agentId) return { ok: false, error: "Unauthorized" }
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

/**
 * Update a twin's display label and personality — the "edit an existing twin"
 * path, as distinct from finalizeTwin() which is the wizard's last step.
 *
 * WIRED (w3): the "Rename / edit personality" item on TwinCard's menu
 * (app/dashboard/settings/twin-studio/components/twin-card.tsx). The card had
 * carried a `canEdit` prop that promised an edit affordance and rendered only
 * Set-default and Delete, so a twin's name and personality were fixed at
 * creation. The dialog's maxLength values mirror the ceilings below, which
 * REFUSE rather than truncate.
 */
export async function updateTwinDetails(params: {
  twinId: string
  label?: string
  personality?: string
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.agentId) return { ok: false, error: "Unauthorized" }
  const supabase = createServiceClient()

  // `error` destructured so a refused read is distinguishable from a genuine
  // miss. Both still refuse — this gate must fail closed — but a swallowed
  // read error should not be reported to the user as "your twin is gone".
  const { data: twin, error: twinError } = await supabase
    .from("agent_avatar_assets")
    .select("agent_id")
    .eq("id", params.twinId)
    .maybeSingle()

  if (twinError) return { ok: false, error: "Could not verify the twin — nothing was changed" }
  if (!twin || twin.agent_id !== ctx.agentId) {
    return { ok: false, error: "Twin not found" }
  }

  const update: Record<string, any> = { updated_at: new Date().toISOString() }

  // Bounds match the siblings that write the same columns. Without them this
  // was the unbounded back door to both: createTwinDraft caps label at 64, and
  // `personality` is a free-text SYSTEM-PROMPT ADDENDUM injected into every
  // conversation this twin fronts — an unbounded value is both a prompt-
  // injection surface and an unbounded per-turn token cost on every AI call
  // that loads it.
  if (params.label !== undefined) {
    const label = params.label.trim()
    if (!label) return { ok: false, error: "Give the twin a name" }
    update.label = label.slice(0, 64)
  }
  if (params.personality !== undefined) {
    const personality = params.personality.trim()
    if (personality.length > 2000) {
      return {
        ok: false,
        error: "Keep the personality note under 2000 characters — it is added to every conversation.",
      }
    }
    update.personality = personality || null
  }

  const { error: updateError } = await supabase
    .from("agent_avatar_assets")
    .update(update)
    .eq("id", params.twinId)
  if (updateError) return { ok: false, error: updateError.message }

  revalidatePath("/dashboard/settings/twin-studio")
  return { ok: true }
}

// ─── Broker approval gate ─────────────────────────────────────────────────

export async function approveTwin(twinId: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok) return { ok: false, error: "Unauthorized" }
  if (!isAdminOrBroker({ user_type: ctx.userType })) {
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
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok) return { ok: false, error: "Unauthorized" }
  if (!isAdminOrBroker({ user_type: ctx.userType })) {
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
//   3. POST /api/elevenlabs/voice-clone { twin_id } — once the user records or
//      uploads, creates the real ElevenLabs clone (usage-capped + metered) and
//      stores voice_id / voice_sample_url on the same row. This is the ONE
//      voice-binding path; the duplicate `attachVoiceToTwin` action that also
//      wrote those columns was removed in w2s3 (see the note below).
//   4. finalizeTwin      — sets personality + flips approval per brokerage
//      policy + optionally promotes to default
// ──────────────────────────────────────────────────────────────────────────

export async function createTwinDraft(params: {
  label: string
  sourceType: "photo" | "video"
  sourceUrl: string
}): Promise<{ ok: boolean; twinId?: string; error?: string }> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.agentId) return { ok: false, error: "Unauthorized" }

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

// attachVoiceToTwin was REMOVED here (orphan burn-down w2s3).
//
// SURVIVOR: app/api/elevenlabs/voice-clone/route.ts — the `twin_id` branch.
// It is the path the wizard actually calls, it writes the SAME three columns
// (voice_id, voice_sample_url, updated_at) on the same row, and it carries the
// ownership guard that was merged onto it FROM this function (the route's own
// comment names it as the source).
//
// Nothing was lost: the route is strictly richer — it creates the real
// ElevenLabs clone, enforces the usage cap, returns an honest 503 when the key
// is unset, and meters the spend via logMediaUsage('voice_clones_created').
//
// It was also actively harmful to keep as a second door. This function let a
// caller write an ARBITRARY voiceId string onto their twin without going
// through the clone route at all — binding a voice id nobody in this brokerage
// paid to create, with no cap check and no `voice_clones_created` meter line.
// The metering bypass is the reason this is a deletion and not a "harmless
// duplicate".

// ─── Stock voices ─────────────────────────────────────────────────────────
//
// THE SECOND WAY TO HAVE A VOICE. A clone costs money, takes a recording, and
// some agents simply do not want their own voice on an explainer video — so the
// Twin Studio voice step offers ElevenLabs' STOCK library as well as the clone.
// A stock voice creates nothing at the vendor: it is an id that already exists
// in the shared library, so there is no usage cap to check and nothing to meter.
// That is precisely why the allowlist below is load-bearing — see
// setTwinStockVoice.

export interface TwinVoiceOption {
  voiceId: string
  label: string
  /** One line of "what does it sound like", shown under the name. */
  style: string
  gender: string | null
}

/**
 * The stock voices a twin may be given.
 *
 * TWO SOURCES, ONE LIST. The curated set in lib/video/assistant-options.ts is
 * the reliable floor — it renders with no vendor key and never changes shape
 * under us. On top of it, when ELEVENLABS_API_KEY is configured, the live
 * library is merged in so the picker is not frozen to nine ids forever.
 * `listElevenLabsVoices` returns PREMADE voices only; it must, because the
 * platform ElevenLabs account also holds every agent's clone.
 *
 * The curated entry wins on an id collision — its `style` line is written for
 * this product, ElevenLabs' own description is not.
 */
export async function listTwinVoiceOptions(): Promise<{ voices: TwinVoiceOption[]; live: boolean }> {
  const { ASSISTANT_VOICE_OPTIONS } = await import("@/lib/video/assistant-options")

  const byId = new Map<string, TwinVoiceOption>()
  for (const v of ASSISTANT_VOICE_OPTIONS) {
    byId.set(v.voiceId, { voiceId: v.voiceId, label: v.label, style: v.style, gender: v.gender })
  }

  let live = false
  try {
    const { listElevenLabsVoices } = await import("./avatar-voice-catalog")
    const res = await listElevenLabsVoices()
    if (res.success) {
      live = true
      for (const v of res.voices) {
        if (byId.has(v.voice_id)) continue
        byId.set(v.voice_id, {
          voiceId: v.voice_id,
          label: v.name,
          style: v.description ?? `${v.gender ?? "Neutral"} · ${v.language}`,
          gender: v.gender,
        })
      }
    }
  } catch {
    // The stock catalogue is an enhancement, not a prerequisite — a vendor
    // outage must not empty the picker and leave the agent with no voice
    // option at all. The curated floor still stands.
    live = false
  }

  return { voices: [...byId.values()], live }
}

/**
 * Give a twin one of the STOCK voices instead of a clone.
 *
 * THE ALLOWLIST IS THE WHOLE POINT. `attachVoiceToTwin` was deleted in w2s3
 * because it let a caller write an ARBITRARY voice id onto their twin — binding
 * a voice nobody paid to create, with no cap check and no
 * `voice_clones_created` meter line. This action must NOT re-open that door, so
 * the id is checked against the stock catalogue and anything outside it is
 * refused. A CLONE still has exactly one way in:
 * POST /api/elevenlabs/voice-clone, which is where the cap and the metering
 * live.
 */
export async function setTwinStockVoice(params: {
  twinId: string
  voiceId: string
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.agentId) return { ok: false, error: "Unauthorized" }

  const voiceId = params.voiceId?.trim()
  if (!voiceId) return { ok: false, error: "Pick a voice" }

  // Allowlist FIRST — cheapest refusal, and it needs no database round trip.
  //
  // FAILS CLOSED, and says which kind of "no" it is. If the live catalogue was
  // unreachable on this call, an id the agent legitimately picked a moment ago
  // may not be in the set — that is a "try again", not "you picked a bad
  // voice". Either way the write does not happen: the whole point of the gate
  // is that an unverified id never reaches the column.
  const { voices, live } = await listTwinVoiceOptions()
  if (!voices.some((v) => v.voiceId === voiceId)) {
    return {
      ok: false,
      error: live
        ? "That isn't one of the stock voices. Pick one from the list, or record your own."
        : "We couldn't reach the voice library to confirm that one — try again in a moment.",
    }
  }

  const supabase = createServiceClient()

  // `error` destructured so a REFUSED read is not read as "no such twin".
  // This is an ownership gate, so it fails closed either way.
  const { data: twin, error: twinError } = await supabase
    .from("agent_avatar_assets")
    .select("id, agent_id")
    .eq("id", params.twinId)
    .maybeSingle()
  if (twinError) return { ok: false, error: "Could not verify the twin — nothing was changed" }
  if (!twin || twin.agent_id !== ctx.agentId) return { ok: false, error: "Twin not found" }

  const { error: updateError } = await supabase
    .from("agent_avatar_assets")
    .update({
      voice_id: voiceId,
      // A stock voice has no recording behind it. Clearing this is honest: a
      // leftover sample url from an earlier clone attempt would claim this
      // voice was built from that recording.
      voice_sample_url: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.twinId)
  if (updateError) return { ok: false, error: updateError.message }

  revalidatePath("/dashboard/settings/twin-studio")
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
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.agentId) return { ok: false, error: "Unauthorized" }
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
