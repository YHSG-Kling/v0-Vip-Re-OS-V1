/**
 * POST /api/agent/update-video-profile
 * Saves D-ID avatar source URLs (photo or video) and ElevenLabs voice ID
 * to agent_voice_profiles for the authenticated agent.
 *
 * Body (all optional, at least one required):
 *   did_photo_url?: string       — public URL of agent headshot for D-ID /talks
 *   did_video_url?: string       — public URL of short agent video for D-ID /clips
 *   elevenlabs_voice_id?: string — ElevenLabs cloned voice ID
 *   preferred_avatar_provider?: "did" | "heygen"
 */

import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const auth = await requireAuth(supabase)
    if (!auth.ok) return auth.response

    const body = await request.json()
    const {
      did_photo_url,
      did_video_url,
      elevenlabs_voice_id,
      preferred_avatar_provider,
    } = body

    const hasUpdate =
      did_photo_url !== undefined ||
      did_video_url !== undefined ||
      elevenlabs_voice_id !== undefined ||
      preferred_avatar_provider !== undefined

    if (!hasUpdate) {
      return NextResponse.json(
        { error: "At least one field (did_photo_url, did_video_url, elevenlabs_voice_id, preferred_avatar_provider) is required" },
        { status: 400 }
      )
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (did_photo_url !== undefined) updates.did_photo_url = did_photo_url
    if (did_video_url !== undefined) updates.did_video_url = did_video_url
    if (elevenlabs_voice_id !== undefined) updates.elevenlabs_voice_id = elevenlabs_voice_id
    if (preferred_avatar_provider !== undefined) updates.preferred_avatar_provider = preferred_avatar_provider

    // Upsert: create profile row if it doesn't exist yet
    const { error } = await supabase
      .from("agent_voice_profiles")
      .upsert(
        {
          agent_id: auth.agentId,
          brokerage_id: auth.brokerageId,
          ...updates,
        },
        { onConflict: "agent_id" }
      )

    if (error) {
      console.error("[update-video-profile] DB error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Mirror elevenlabs_voice_id to users table — podcast-generation.ts reads it from there.
    if (elevenlabs_voice_id !== undefined && auth.userId) {
      await supabase
        .from("users")
        .update({ elevenlabs_voice_id })
        .eq("id", auth.userId)
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error("[update-video-profile] Error:", error)
    return NextResponse.json({ error: error.message ?? "Internal server error" }, { status: 500 })
  }
}
