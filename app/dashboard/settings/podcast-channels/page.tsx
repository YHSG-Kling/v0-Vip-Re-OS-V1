import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/app/components/ui/card"
import { Mic2 } from "lucide-react"
import { PodcastChannelsClient } from "./podcast-channels-client"

export const metadata = { title: "Podcast Channels | Settings" }

export default async function PodcastChannelsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const service = createServiceClient()

  // Resolve agent / brokerage
  const { data: agent } = await service
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", user.id)
    .maybeSingle()

  const brokerageId = agent?.brokerage_id ?? null
  if (!brokerageId) redirect("/dashboard")

  // Fetch agent-level channels (personal overrides)
  const { data: agentChannels } = await service
    .from("podcast_distribution_channels")
    .select("id, channel_name, is_enabled, external_show_id, distribution_config, agent_user_id")
    .eq("brokerage_id", brokerageId)
    .eq("agent_user_id", user.id)
    .order("channel_name")

  // Fetch brokerage-level channels (inherited, agent_user_id IS NULL)
  const { data: brokerageChannels } = await service
    .from("podcast_distribution_channels")
    .select("id, channel_name, is_enabled, external_show_id, distribution_config, agent_user_id")
    .eq("brokerage_id", brokerageId)
    .is("agent_user_id", null)
    .order("channel_name")

  return (
    <div className="container max-w-3xl py-8 space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Mic2 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">Podcast Distribution Channels</h1>
        </div>
        <p className="text-muted-foreground">
          Configure which platforms your podcast episodes are distributed to. Personal settings override brokerage defaults.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Distribution Hierarchy</CardTitle>
          <CardDescription>
            When distributing, the system checks: your personal channel credentials → brokerage-level defaults.
            Configure your own show IDs below to override the brokerage defaults with your personal podcast accounts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PodcastChannelsClient
            agentChannels={agentChannels ?? []}
            brokerageChannels={brokerageChannels ?? []}
          />
        </CardContent>
      </Card>
    </div>
  )
}
