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

  // ── WEEKLY AUTO-EPISODE RUNS — the podcast_auto_runs ledger, read back ──
  // The weekly cron writes status / error_message / the rendered episode link /
  // word count / duration / completed_at on every run ("nobody is watching
  // this run, so it is logged" — lib/podcast/auto-producer.ts). This card is
  // the watcher: the host configures the show HERE, so a skipped week
  // ("host has no elevenlabs_voice_id") or a failed render is shown where the
  // person who can fix it already is. Service read behind the brokerage
  // resolution above; rows are pinned to the caller's own brokerage.
  const { data: autoRuns, error: autoRunsError } = await service
    .from("podcast_auto_runs")
    .select("id, iso_week, agent_id, status, error_message, podcast_episode_id, script_word_count, duration_seconds, created_at, completed_at")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(12)
  if (autoRunsError) {
    // supabase-js RESOLVES a refused read — log it and render the honest error
    // state below instead of an empty "no runs yet".
    console.error("[podcast-channels] auto-run ledger read failed:", autoRunsError.message)
  }
  const runRows = (autoRuns ?? []) as Array<{
    id: string; iso_week: string; agent_id: string | null; status: string | null
    error_message: string | null; podcast_episode_id: string | null
    script_word_count: number | null; duration_seconds: number | null
    created_at: string | null; completed_at: string | null
  }>

  // Host names: podcast_auto_runs.agent_id is agents-class (m366) — resolve
  // agents.id → agents.user_id → users, never agents.id against users directly
  // (disjoint id spaces). Episode titles come from the linked episode row.
  const hostAgentIds = [...new Set(runRows.map((r) => r.agent_id).filter((a): a is string => !!a))]
  const episodeIds = [...new Set(runRows.map((r) => r.podcast_episode_id).filter((e): e is string => !!e))]
  const [agentRows, episodeRows] = await Promise.all([
    hostAgentIds.length > 0
      ? service.from("agents").select("id, user_id").in("id", hostAgentIds)
      : Promise.resolve({ data: [], error: null } as { data: any[]; error: null }),
    episodeIds.length > 0
      ? service.from("podcast_episodes").select("id, title, approval_status").in("id", episodeIds)
      : Promise.resolve({ data: [], error: null } as { data: any[]; error: null }),
  ])
  if (agentRows.error) console.error("[podcast-channels] host agent read failed:", agentRows.error.message)
  if (episodeRows.error) console.error("[podcast-channels] episode read failed:", episodeRows.error.message)
  const hostUserIds = [...new Set((agentRows.data ?? []).map((a: any) => a.user_id).filter(Boolean))]
  const userRes = hostUserIds.length > 0
    ? await service.from("users").select("id, first_name, last_name").in("id", hostUserIds)
    : { data: [] as any[], error: null }
  if (userRes.error) console.error("[podcast-channels] host user read failed:", userRes.error.message)
  const nameByUserId = new Map<string, string>(
    (userRes.data ?? []).map((u: any) => [u.id, [u.first_name, u.last_name].filter(Boolean).join(" ").trim()])
  )
  const hostNameByAgentId = new Map<string, string>()
  for (const a of agentRows.data ?? []) {
    const name = a.user_id ? nameByUserId.get(a.user_id) : undefined
    if (name) hostNameByAgentId.set(a.id, name)
  }
  const episodeById = new Map<string, { title: string | null; approval_status: string | null }>(
    (episodeRows.data ?? []).map((e: any) => [e.id, { title: e.title ?? null, approval_status: e.approval_status ?? null }])
  )
  const fmtRunDuration = (s: number | null) =>
    s == null ? null : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`

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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Weekly auto-episode runs</CardTitle>
          <CardDescription>
            One run per ISO week. A skipped or failed week names its reason here — this is the only
            place the unattended weekly producer reports to a person.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {autoRunsError ? (
            <p className="text-sm text-destructive">Run history unavailable: {autoRunsError.message}</p>
          ) : runRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No auto-episode runs yet.</p>
          ) : (
            <ul className="divide-y">
              {runRows.map((run) => {
                const episode = run.podcast_episode_id ? episodeById.get(run.podcast_episode_id) : undefined
                const host = run.agent_id ? hostAgentIdName(hostNameByAgentId, run.agent_id) : null
                const duration = fmtRunDuration(run.duration_seconds)
                return (
                  <li key={run.id} className="py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {run.iso_week}
                        <span
                          className={
                            run.status === "failed"
                              ? "ml-2 text-xs text-destructive"
                              : run.status === "skipped"
                                ? "ml-2 text-xs text-amber-600"
                                : "ml-2 text-xs text-muted-foreground"
                          }
                        >
                          {run.status ?? "unknown"}
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {run.completed_at
                          ? `finished ${new Date(run.completed_at).toLocaleString()}`
                          : run.created_at
                            ? `started ${new Date(run.created_at).toLocaleString()}`
                            : ""}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {host ? `Host ${host}` : "Host unresolved"}
                      {episode?.title ? ` · "${episode.title}"` : ""}
                      {episode?.approval_status ? ` (${episode.approval_status.replace(/_/g, " ")})` : ""}
                      {run.script_word_count != null ? ` · ${run.script_word_count.toLocaleString()} words` : ""}
                      {duration ? ` · ~${duration} min` : ""}
                    </p>
                    {(run.status === "failed" || run.status === "skipped") && run.error_message && (
                      <p className="text-xs text-destructive mt-0.5">{run.error_message}</p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/** Map lookup spelled as a function so the render stays null-honest. */
function hostAgentIdName(names: Map<string, string>, agentId: string): string | null {
  return names.get(agentId) ?? null
}
