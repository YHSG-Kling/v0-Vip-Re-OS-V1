import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { syncDIDAgent } from "@/lib/did/agents"

/**
 * DID AGENT SYNC — the AUTONOMOUS "updated" half of the owner's ruling (wave
 * 58, item 2): "the D-ID agent record is created/updated autonomously when
 * the agent's twin/voice changes (cron or signal reader … never a
 * button-only path)."
 *
 * lib/did/agents.ts::ensureDIDAgent CREATES a D-ID Agent once and caches its
 * id forever (agent_avatar_assets.did_agent_id / agent_voice_profiles.
 * did_agent_id) — nothing ever called PATCH /agents/{id} again, so an agent
 * who re-trained their presenter, cloned a new voice, or edited their
 * personality kept talking through the STALE D-ID Agent record until someone
 * noticed. A single call site inside Twin Studio's update action would only
 * catch changes made through that one button; this is a SWEEP instead,
 * because it must also catch a migration backfill, an admin SQL fix, or any
 * future writer this repo has not been told about yet (CLAUDE.md §3's own
 * warning about "writer-only-through-a-button" assumptions). PATCH is a full
 * replace of the SAME body POST sends (lib/did/agents.ts::buildAgentBody —
 * one builder, §6), so re-sending it unconditionally for every twin/profile
 * that already has a cached did_agent_id is safe and idempotent — no diff
 * needed before deciding whether to call it.
 *
 * TENANCY: a platform cron reading across tenants ON PURPOSE (CLAUDE.md §4),
 * gated by the cron secret; every row acted on stays scoped to its own
 * agent/twin, and D-ID's OWN account scoping (one API key, one account) is
 * unaffected by tenant — this never crosses a D-ID account boundary.
 *
 * A 404 from D-ID (the cached id was deleted out of band) self-heals: the
 * cache column is cleared so the next ensureDIDAgent call re-creates rather
 * than PATCHing a ghost forever.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 120

const BATCH = 100

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "did-agent-sync",
    cron_path: "/app/api/cron/did-agent-sync/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const svc = createServiceClient()
    let synced = 0, failed = 0, notFoundCleared = 0, skipped = 0
    const refusals: Array<{ id: string; error: string }> = []

    // ── Twin Studio twins — the current model ───────────────────────────────
    const { data: twins, error: twinsErr } = await svc
      .from("agent_avatar_assets")
      .select("id, did_agent_id, did_avatar_id, voice_id, personality, label")
      .not("did_agent_id", "is", null)
      .not("did_avatar_id", "is", null)
      .limit(BATCH)
    if (twinsErr) throw new Error(`agent_avatar_assets read refused: ${twinsErr.message}`)

    for (const t of twins ?? []) {
      const row = t as any
      const result = await syncDIDAgent({
        didAgentId: row.did_agent_id,
        presenterId: row.did_avatar_id,
        elevenLabsVoiceId: row.voice_id,
        personality: row.personality,
        agentName: row.label ?? "Agent",
      })
      if (result.ok) { synced++; continue }
      if (result.error === "NOT_FOUND") {
        notFoundCleared++
        await svc.from("agent_avatar_assets")
          .update({ did_agent_id: null, updated_at: new Date().toISOString() })
          .eq("id", row.id).then(undefined, () => {})
        continue
      }
      failed++
      refusals.push({ id: row.id, error: result.error ?? "unknown" })
    }

    // ── Legacy per-agent profiles (agents not yet on Twin Studio) ───────────
    const { data: profiles, error: profilesErr } = await svc
      .from("agent_voice_profiles")
      .select("agent_id, did_agent_id, did_avatar_id, elevenlabs_voice_id, profile_name")
      .not("did_agent_id", "is", null)
      .not("did_avatar_id", "is", null)
      .limit(BATCH)
    if (profilesErr) throw new Error(`agent_voice_profiles read refused: ${profilesErr.message}`)

    for (const p of profiles ?? []) {
      const row = p as any
      const result = await syncDIDAgent({
        didAgentId: row.did_agent_id,
        presenterId: row.did_avatar_id,
        elevenLabsVoiceId: row.elevenlabs_voice_id,
        personality: null,
        agentName: row.profile_name ?? "Agent",
      })
      if (result.ok) { synced++; continue }
      if (result.error === "NOT_FOUND") {
        notFoundCleared++
        await svc.from("agent_voice_profiles")
          .update({ did_agent_id: null, updated_at: new Date().toISOString() })
          .eq("agent_id", row.agent_id).then(undefined, () => {})
        continue
      }
      failed++
      refusals.push({ id: row.agent_id, error: result.error ?? "unknown" })
    }

    const payload = {
      scanned: (twins?.length ?? 0) + (profiles?.length ?? 0),
      batch_cap: BATCH,
      synced, failed, notFoundCleared, skipped,
      refusals: refusals.slice(0, 20),
    }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: payload.scanned,
      output_count: synced,
      metadata: payload,
    })
    return NextResponse.json({ success: true, ...payload })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[DidAgentSync] failed:", message)
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
