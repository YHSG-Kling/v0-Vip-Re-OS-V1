import { listChannelPresets, type PresetChannel } from "@/app/actions/channel-presets"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"
import { createServiceClient } from "@/lib/supabase/service"
import { ChannelPresetsClient } from "./client"

export const dynamic = "force-dynamic"

/** Does the caller's agents row have an ElevenLabs voice clone ready?
 *  Used by the voicedrop tab to show a "voice not set up" warning
 *  with a deep link to the existing /dashboard/videos/voice wizard. */
async function hasAgentVoiceClone(agentScopeId: string | null): Promise<boolean> {
  if (!agentScopeId) return false
  const svc = createServiceClient()
  // agent_voice_profiles.agent_id FKs to agents(id) — agentScopeId IS
  // agents.id (resolvePolicyScopeAccess returns it that way).
  const { data } = await svc
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id")
    .eq("agent_id", agentScopeId)
    .maybeSingle()
  return !!(data?.elevenlabs_voice_id as string | null)
}

const CHANNELS: PresetChannel[] = [
  "email", "sms", "social_post", "voicedrop",
  "podcast_episode", "ad_retarget", "portal_push",
]

export default async function ChannelPresetsPage() {
  const access = await resolvePolicyScopeAccess()
  const [results, voiceCloneReady] = await Promise.all([
    Promise.all(CHANNELS.map((c) => listChannelPresets(c))),
    hasAgentVoiceClone(access.agentScopeId),
  ])

  const initialPresets: Record<PresetChannel, Array<{
    id: string; name: string;
    scope_type: "agent" | "team" | "brokerage";
    scope_id: string; is_active: boolean;
    compliance_event_id: string | null;
    created_at: string;
    payload: Record<string, unknown>;
  }>> = {
    email:           [],
    sms:             [],
    social_post:     [],
    voicedrop:       [],
    podcast_episode: [],
    ad_retarget:     [],
    portal_push:     [],
  }
  const errors: string[] = []
  for (let i = 0; i < CHANNELS.length; i++) {
    const r = results[i]
    if (r.success) initialPresets[CHANNELS[i]] = r.presets
    else errors.push(`${CHANNELS[i]}: ${r.error}`)
  }

  return (
    <ChannelPresetsClient
      initialPresets={initialPresets}
      loadErrors={errors}
      voiceCloneReady={voiceCloneReady}
      access={{
        canEditAgent:     access.canEditAgent,
        canEditTeam:      access.canEditTeam,
        canEditBrokerage: access.canEditBrokerage,
        agentScopeId:     access.agentScopeId,
        teamScopeIds:     access.teamScopeIds,
        brokerageScopeId: access.brokerageScopeId,
      }}
    />
  )
}
