/**
 * POST /api/elevenlabs/voice-clone
 * Clones an agent's voice via ElevenLabs Instant Voice Clone API.
 * Much cheaper than HeyGen voice cloning for high-volume TTS.
 *
 * Body: { name: string, sample_audio_urls: string[], profile_id: string }
 * Returns: { elevenlabs_voice_id: string }
 */

import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { checkUsageCap } from "@/lib/usage/check-cap"
import { logMediaUsage } from "@/lib/usage/log-media-usage"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

const EL_API_BASE = "https://api.elevenlabs.io/v1"

export async function POST(request: NextRequest) {
  // Hoisted so the outer catch can still fail the training job — an unexpected
  // throw is exactly the case where a 'queued' row would otherwise be stranded.
  let trainingIdForCleanup: string | undefined
  try {
    const supabase = await createClient()
    const auth = await requireAuth(supabase)
    if (!auth.ok) return auth.response

    const apiKey = process.env.ELEVENLABS_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: "ElevenLabs API key not configured" }, { status: 503 })
    }

    const body = await request.json()
    const { name, sample_audio_urls, profile_id, training_id, twin_id, isa_default } = body as {
      name: string
      sample_audio_urls: string[]
      /** Legacy: writes the clone to agent_voice_profiles (per-agent default). */
      profile_id?: string
      /** Guided capture: the voice_clone_training row this render belongs to.
       *  When present the outcome is RECONCILED onto that job (which is what
       *  promotes the profile + fires the kernel's VOICE_CLONE_READY), instead
       *  of the profile being flipped behind the job's back. */
      training_id?: string
      /** Twin Studio: writes the clone to a specific agent_avatar_assets row. */
      twin_id?: string
      /** ISA voice settings: saves the clone as the brokerage's default ISA voice
       *  (brokerages.default_isa_voice_id). Broker/admin only. */
      isa_default?: boolean
    }

    if (!name || !Array.isArray(sample_audio_urls) || sample_audio_urls.length < 1) {
      return NextResponse.json(
        { error: "Missing required fields: name, sample_audio_urls (min 1)" },
        { status: 400 }
      )
    }
    if (!profile_id && !twin_id && !isa_default) {
      return NextResponse.json(
        { error: "One of profile_id (legacy), twin_id (Twin Studio), or isa_default is required" },
        { status: 400 }
      )
    }
    if (training_id && !profile_id) {
      return NextResponse.json(
        { error: "training_id must be sent with the profile_id the job belongs to" },
        { status: 400 }
      )
    }

    // A guided-capture job is already sitting at 'queued' when this route is
    // called. Every failure path below has to move it to 'failed', or the
    // profile is stranded at 'training' forever and the agent is told to wait
    // for a job that will never finish.
    trainingIdForCleanup = training_id

    const failJob = async (message: string) => {
      if (!training_id) return
      try {
        const { updateTrainingJobStatus } = await import("@/app/actions/video-voice")
        await updateTrainingJobStatus(training_id, "failed", undefined, message)
      } catch (err) {
        console.error("[voice-clone] could not mark training job failed:", err)
      }
    }
    // Setting the brokerage-wide default ISA voice is a broker/admin action.
    if (isa_default && !isAdminOrBroker({ user_type: auth.userType })) {
      return NextResponse.json({ error: "Only broker / admin can set the default ISA voice" }, { status: 403 })
    }

    // ─── Usage cap on voice clone creation ──────────────────────────────────
    const cap = await checkUsageCap({
      brokerageId: auth.brokerageId,
      metric: "voice_clones_created",
      addQuantity: 1,
    })
    if (!cap.allowed) {
      await failJob(cap.message ?? "Voice clone usage cap reached")
      return NextResponse.json({ error: cap.message, capExceeded: true }, { status: 429 })
    }

    // Download and attach audio samples as multipart/form-data
    const formData = new FormData()
    formData.append("name", name)
    formData.append("description", `Agent voice clone for ${auth.user.email}`)

    for (const url of sample_audio_urls) {
      const audioRes = await fetch(url)
      if (!audioRes.ok) {
        await failJob(`Failed to fetch audio sample: ${url}`)
        return NextResponse.json({ error: `Failed to fetch audio sample: ${url}` }, { status: 400 })
      }
      const blob = await audioRes.blob()
      formData.append("files", blob, "sample.mp3")
    }

    // Through Connection OS. Multipart is a first-class bodyType on the gateway
    // (m333) rather than a raw fetch: this is a real egress that spends money
    // and creates a durable asset, so it belongs in the same place as every
    // other one — self-healing on a field rename, credential resolution, and
    // connector-health attribution.
    const elRes = await callConnector<{ voice_id?: string; detail?: { message?: string } }>({
      connector: "elevenlabs",
      baseUrl: EL_API_BASE,
      path: "/voices/add",
      method: "POST",
      auth: { style: "header", name: "xi-api-key", value: apiKey },
      bodyType: "multipart",
      body: formData,
    })

    const elData = elRes.data ?? {}

    if (!elRes.ok || !elData.voice_id) {
      console.error("[ElevenLabs] voice clone error:", elRes.error ?? elData)
      const message = elData.detail?.message ?? elRes.error ?? "ElevenLabs voice clone failed"
      await failJob(message)
      return NextResponse.json({ error: message }, { status: 500 })
    }

    const elevenlabs_voice_id: string = elData.voice_id
    const sample_url = sample_audio_urls[0] ?? null

    // ISA voice path: save the clone as the brokerage's default ISA voice, so the
    // AI ISA speaks in this custom voice when no per-agent clone applies.
    if (isa_default) {
      await supabase
        .from("brokerages")
        .update({ default_isa_voice_id: elevenlabs_voice_id })
        .eq("id", auth.brokerageId)

      logMediaUsage({
        brokerageId: auth.brokerageId,
        metric: "voice_clones_created",
        quantity: 1,
        agentId: auth.agentId,
        userId: auth.userId,
        sessionRef: elevenlabs_voice_id,
        feature: "isa_default_voice",
        metadata: { isa_default: true },
      }).catch(() => {})

      return NextResponse.json({ success: true, elevenlabs_voice_id })
    }

    // Twin Studio path: bind the clone to a specific twin row.
    // The twin's voice is promoted to agents.voice_id only when the user
    // sets the twin as default (handled in app/actions/twin-studio.ts).
    if (twin_id) {
      const { data: twin } = await supabase
        .from("agent_avatar_assets")
        .select("id, agent_id")
        .eq("id", twin_id)
        .maybeSingle()
      // OWNERSHIP CHECK. requireAuth establishes WHO is calling but says nothing
      // about whether this twin is theirs, and `agent_id` was selected above and
      // then never compared — so any authenticated agent could bind a voice
      // clone onto another agent's twin (an IDOR on a voice identity, and it
      // spends the victim's ElevenLabs quota to do it).
      //
      // app/actions/twin-studio.ts::attachVoiceToTwin — the server action that
      // does the same job — has always had this guard
      // (`twin.agent_id !== ctx.agentId`). This route is the survivor the UI
      // actually calls, and it was the one missing it.
      //
      // 404 rather than 403, deliberately: a distinct "forbidden" would confirm
      // that a twin id exists, which is itself the enumeration this closes.
      if (!twin || twin.agent_id !== auth.agentId) {
        return NextResponse.json({ error: "Twin not found" }, { status: 404 })
      }
      await supabase
        .from("agent_avatar_assets")
        .update({
          voice_id: elevenlabs_voice_id,
          voice_sample_url: sample_url,
          updated_at: new Date().toISOString(),
        })
        .eq("id", twin_id)

      logMediaUsage({
        brokerageId: auth.brokerageId,
        metric: "voice_clones_created",
        quantity: 1,
        agentId: auth.agentId,
        userId: auth.userId,
        sessionRef: elevenlabs_voice_id,
        feature: "twin_studio",
        metadata: { twin_id },
      }).catch(() => {})

      return NextResponse.json({ success: true, elevenlabs_voice_id })
    }

    // Per-agent profile path.
    //
    // training_status MUST reach 'ready' as part of recording the voice id.
    // ElevenLabs Instant Voice Clone is SYNCHRONOUS — /voices/add returned the
    // voice_id above — so the moment the id is saved the clone IS usable, and
    // there is no later provider callback to promote it. The row is created
    // 'not_started' and every reader gates on training_status = 'ready', so
    // writing the id alone leaves a working clone permanently invisible.
    //
    // TWO WAYS IN, ONE OUTCOME:
    //   · guided capture sends training_id → the outcome is reconciled onto the
    //     voice_clone_training row, which promotes the profile, writes the
    //     lifecycle events and fires VOICE_CLONE_READY through the kernel.
    //   · quick upload sends profile_id alone → the profile is promoted here.
    if (training_id) {
      try {
        const { updateTrainingJobStatus } = await import("@/app/actions/video-voice")
        await updateTrainingJobStatus(training_id, "completed", {
          voice_id: elevenlabs_voice_id,
          sample_count: sample_audio_urls.length,
        })
      } catch (err: any) {
        console.error("[voice-clone] training reconciliation failed:", err)
        return NextResponse.json(
          { error: `Voice was cloned but could not be saved: ${err?.message ?? "reconciliation failed"}` },
          { status: 500 },
        )
      }
    } else {
      const { error: profileError } = await supabase
        .from("agent_voice_profiles")
        .update({ elevenlabs_voice_id, training_status: "ready" })
        .eq("id", profile_id!)
      if (profileError) {
        // The clone exists at ElevenLabs but we could not record it. Say so —
        // reporting success here would strand a voice nothing can find.
        console.error("[voice-clone] profile update failed:", profileError.message)
        return NextResponse.json(
          { error: `Voice was cloned but could not be saved: ${profileError.message}` },
          { status: 500 },
        )
      }
    }

    try {
      const { data: profile } = await supabase
        .from("agent_voice_profiles")
        .select("agent_id")
        .eq("id", profile_id!)
        .maybeSingle()
      if (profile?.agent_id) {
        const { syncAgentVoiceId } = await import("@/lib/voice/sync-voice-id")
        await syncAgentVoiceId({ agentId: profile.agent_id, elevenlabsVoiceId: elevenlabs_voice_id })
      }
    } catch (err) {
      console.warn("[elevenlabs/voice-clone] sync to agents.voice_id failed:", err)
    }

    logMediaUsage({
      brokerageId: auth.brokerageId,
      metric: "voice_clones_created",
      quantity: 1,
      agentId: auth.agentId,
      userId: auth.userId,
      sessionRef: elevenlabs_voice_id,
      feature: training_id ? "voice_guided_capture" : "voice_quick_upload",
      metadata: { profile_id, training_id: training_id ?? null, sample_count: sample_audio_urls.length },
    }).catch(() => {})

    return NextResponse.json({ success: true, elevenlabs_voice_id })
  } catch (error: any) {
    console.error("[ElevenLabs] voice-clone error:", error)
    if (trainingIdForCleanup) {
      try {
        const { updateTrainingJobStatus } = await import("@/app/actions/video-voice")
        await updateTrainingJobStatus(
          trainingIdForCleanup,
          "failed",
          undefined,
          error?.message ?? "Internal server error",
        )
      } catch (cleanupErr) {
        console.error("[voice-clone] could not mark training job failed:", cleanupErr)
      }
    }
    return NextResponse.json({ error: error.message ?? "Internal server error" }, { status: 500 })
  }
}
