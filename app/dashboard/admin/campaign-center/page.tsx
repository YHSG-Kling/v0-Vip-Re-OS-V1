import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { loadCampaignCenter } from "@/lib/kernel/campaign-center"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ApproveItemButton, ApprovePlayButton } from "./approve-buttons"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const metadata = {
  title: "Campaign Command Center | Kernel OS",
  description: "Every marketing draft the AI bench staged across all channels, grouped by play — approve the whole campaign in one place.",
}

const CHANNEL_LABEL: Record<string, string> = {
  social: "Social", email: "Email", newsletter: "Newsletter", blog: "Blog",
  direct_mail: "Direct Mail", ad: "Ads", neighbor_farm: "Neighbor Farm", open_house: "Open House",
}

/**
 * Campaign Command Center — the marketing counterpart to the agent Command Center.
 * Shows the bench's staged drafts (social/email/newsletter/blog/direct-mail/ads/neighbor
 * farms/open houses) in one feed, grouped by play. All data via loadCampaignCenter().
 */
export default async function CampaignCenterPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { data: u } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  const userType = u?.user_type ?? "agent"
  const brokerageId = u?.brokerage_id ?? undefined
  if (!isAdminOrBroker({ user_type: userType }) || !brokerageId) redirect("/dashboard")

  const data = await loadCampaignCenter(brokerageId)

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Campaign Command Center</h1>
        <span className="text-sm text-muted-foreground">{data.total} draft{data.total === 1 ? "" : "s"} awaiting approval</span>
      </div>

      {data.total === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">Nothing staged right now — the bench fills this as plays run (Farm, Launch, Intent, Lookalike, Idle Hands).</Card>
      ) : (
        <>
          <Card className="p-4">
            <div className="text-xs font-medium mb-2">By play</div>
            <div className="flex flex-wrap items-center gap-2">
              {Object.entries(data.byPlay).sort((a, b) => b[1] - a[1]).map(([play, n]) => (
                <div key={play} className="flex items-center gap-1">
                  <Badge variant="secondary">{play} · {n}</Badge>
                  {play !== "Other" && <ApprovePlayButton play={play} />}
                </div>
              ))}
            </div>
            <div className="text-xs font-medium mt-3 mb-2">By channel</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(data.byChannel).sort((a, b) => b[1] - a[1]).map(([ch, n]) => (
                <Badge key={ch}>{CHANNEL_LABEL[ch] ?? ch} · {n}</Badge>
              ))}
            </div>
          </Card>

          <div className="grid gap-2">
            {data.items.map((it) => (
              <Card key={`${it.channel}:${it.id}`} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{it.title}</div>
                  <div className="text-xs text-muted-foreground">{CHANNEL_LABEL[it.channel] ?? it.channel}{it.play ? ` · ${it.play}` : ""}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="outline">{it.status.replace(/_/g, " ")}</Badge>
                  <ApproveItemButton channel={it.channel} id={it.id} />
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
