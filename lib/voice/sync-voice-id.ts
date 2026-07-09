/**
 * lib/voice/sync-voice-id.ts
 *
 * Promotes a completed voice clone (elevenlabs_voice_id captured on
 * agent_voice_profiles after ElevenLabs voice-clone training finishes) to the
 * canonical agents.voice_id slot so the AI ISA call-context resolver
 * (lib/ai-isa/build-call-context.ts) actually finds and uses it.
 *
 * Design intent of the two storage locations:
 *   - agent_voice_profiles.elevenlabs_voice_id — training output (rich
 *     profile with sample_count, quality_score, training_status, etc.)
 *   - agents.voice_id — the canonical "use this voice for ISA calls"
 *     pointer that the resolver chain reads.
 *
 * Without this sync the agent could complete a voice clone in their
 * Voice & Avatar Setup and ISA calls would still fall back to the
 * brokerage default — silently broken.
 *
 * Call this from any path that learns a new elevenlabs_voice_id has
 * been issued for an agent's profile (training-complete webhook,
 * manual finalize action, etc).
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface SyncVoiceIdInput {
  agentId:           string  // agents.id
  elevenlabsVoiceId: string  // the freshly issued voice id from ElevenLabs
}

export async function syncAgentVoiceId(
  input: SyncVoiceIdInput,
): Promise<{ success: boolean; updated: boolean; error?: string }> {
  const supabase = createServiceClient()

  // Read current agents.voice_id — only update when it differs to avoid
  // bumping updated_at on every webhook redelivery.
  const { data: agent } = await supabase
    .from("agents")
    .select("voice_id")
    .eq("id", input.agentId)
    .maybeSingle()

  if (agent?.voice_id === input.elevenlabsVoiceId) {
    return { success: true, updated: false }
  }

  const { error } = await supabase
    .from("agents")
    .update({ voice_id: input.elevenlabsVoiceId })
    .eq("id", input.agentId)

  if (error) return { success: false, updated: false, error: error.message }
  return { success: true, updated: true }
}
