import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { loadContentStudio } from "@/lib/kernel/content-studio"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ApproveReelButton } from "./approve-button"

export const metadata = {
  title: "Content Studio | Kernel OS",
  description: "Every reel the AI Video Director staged — its format, music mood, hook A/B, caption state, QR/B-roll, and the learned WHY — approve it in one place.",
}

const CAPTION_LABEL: Record<string, string> = {
  captioned: "Captioned ✓",
  script_only: "Script (pending gate)",
  none: "No script yet",
}

const ASPECT_LABEL: Record<string, string> = {
  square: "1:1", vertical: "9:16", horizontal: "16:9",
}

/**
 * Content Studio — the Asset Manager's command surface over the AI creative team.
 * Shows the Video Director's staged reels (pending review + recently approved),
 * each card carrying the WHOLE creative decision: composition, channels/aspect,
 * music mood, the hook A/B + which opener is winning, caption state, QR/B-roll
 * flags, and the learned WHY behind the format. All data via loadContentStudio();
 * approval flips through the real existing ai_video_projects gate.
 */
export default async function ContentStudioPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { data: u } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  const userType = u?.user_type ?? "agent"
  const brokerageId = u?.brokerage_id ?? undefined
  if (!["admin", "broker", "broker_admin", "superadmin", "team_lead"].includes(userType) || !brokerageId) redirect("/dashboard")

  const data = await loadContentStudio(brokerageId)
  const winnerByExperiment = new Map(data.experiments.map((e) => [e.experimentId, e]))

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Content Studio</h1>
        <span className="text-sm text-muted-foreground">
          {data.pendingCount} reel{data.pendingCount === 1 ? "" : "s"} awaiting approval
        </span>
      </div>

      {data.total === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">
          Nothing staged right now — the AI Video Director fills this as situations run (a new listing, a price drop, an anniversary, an agent request).
        </Card>
      ) : (
        <>
          {Object.keys(data.byComposition).length > 0 && (
            <Card className="p-4">
              <div className="text-xs font-medium mb-2">Pending by composition</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.byComposition).sort((a, b) => b[1] - a[1]).map(([comp, n]) => (
                  <Badge key={comp} variant="secondary">{comp} · {n}</Badge>
                ))}
              </div>
            </Card>
          )}

          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              Awaiting approval · {data.pendingCount}
            </div>
            {data.groups.pending_review.length === 0 ? (
              <Card className="p-4 text-sm text-muted-foreground">Nothing pending — the team is caught up.</Card>
            ) : (
              <div className="grid gap-2">
                {data.groups.pending_review.map((it) => {
                  const exp = it.experimentId ? winnerByExperiment.get(it.experimentId) : undefined
                  const isWinner = !!exp && exp.winnerVariantIndex !== null && it.variantIndex === exp.winnerVariantIndex
                  return (
                    <Card key={it.id} className="p-3 space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{it.title}</div>
                          <div className="text-xs text-muted-foreground">
                            {it.composition ?? it.videoType ?? "reel"}
                            {it.aspect ? ` · ${ASPECT_LABEL[it.aspect] ?? it.aspect}` : ""}
                            {it.targetChannels.length ? ` · ${it.targetChannels.join(", ")}` : ""}
                          </div>
                        </div>
                        <div className="shrink-0">
                          <ApproveReelButton id={it.id} />
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {it.musicMood && it.musicMood !== "none" && <Badge variant="outline">♪ {it.musicMood}</Badge>}
                        {it.formatSource && (
                          <Badge variant={it.formatSource === "learned" ? "default" : "secondary"}>
                            format: {it.formatSource}
                          </Badge>
                        )}
                        {it.hookAngle && (
                          <Badge variant={isWinner ? "default" : "outline"}>
                            hook: {it.hookAngle.replace(/_/g, " ")}{typeof it.variantIndex === "number" ? ` (v${it.variantIndex})` : ""}{isWinner ? " · winning" : ""}
                          </Badge>
                        )}
                        <Badge variant="outline">{CAPTION_LABEL[it.captionState] ?? it.captionState}</Badge>
                        {it.hasQr && <Badge variant="secondary">QR ✓</Badge>}
                        {it.hasBroll && <Badge variant="secondary">B-roll ✓ · {it.brollCount}</Badge>}
                      </div>

                      {(it.formatWhy || it.hookWhy || (exp && it.experimentId)) && (
                        <div className="text-xs text-muted-foreground space-y-0.5">
                          {it.formatWhy && <div><span className="font-medium">Why this format:</span> {it.formatWhy}</div>}
                          {it.hookWhy && <div><span className="font-medium">Why this hook:</span> {it.hookWhy}</div>}
                          {exp && <div><span className="font-medium">A/B:</span> {exp.why}</div>}
                        </div>
                      )}
                    </Card>
                  )
                })}
              </div>
            )}
          </div>

          {data.groups.approved.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                Recently approved · {data.approvedCount}
              </div>
              <div className="grid gap-2">
                {data.groups.approved.map((it) => (
                  <Card key={it.id} className="p-3 flex items-center justify-between gap-3 opacity-80">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{it.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {it.composition ?? it.videoType ?? "reel"}
                        {it.targetChannels.length ? ` · ${it.targetChannels.join(", ")}` : ""}
                      </div>
                    </div>
                    <Badge variant="outline">approved</Badge>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
