import { listChannelPresets, type PresetChannel } from "@/app/actions/channel-presets"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"
import { ChannelPresetsClient } from "./client"

export const dynamic = "force-dynamic"

const CHANNELS: PresetChannel[] = [
  "email", "sms", "social_post", "voicedrop",
  "podcast_episode", "ad_retarget", "portal_push",
]

export default async function ChannelPresetsPage() {
  const access = await resolvePolicyScopeAccess()
  const results = await Promise.all(CHANNELS.map((c) => listChannelPresets(c)))

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
