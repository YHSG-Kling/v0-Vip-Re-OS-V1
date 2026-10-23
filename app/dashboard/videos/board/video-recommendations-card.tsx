"use client"

/**
 * "What should I film next" — the door onto GET /api/ai/video-recommendations.
 *
 * BUILT 2026-08-28 under the orphan doctrine §1.2: the route had five working
 * recommendation branches and NO caller anywhere in the tree. Three separate
 * waves had repaired it — phantom column filters that made PostgREST reject the
 * whole request, a phantom embed between transactions and leads, and the m565
 * memory-video tenure gate — and every one of those fixes landed on a surface no
 * agent could reach. No duplicate recommender exists (nothing else reads
 * lib/video/memory-video-gate.ts for a feed), so the missing half is built here
 * rather than the route being retired.
 *
 * WHY IT ROUTES BY `rail` INSTEAD OF ALWAYS OPENING THE WIZARD. Two of the five
 * branches must not reach the AI wizard at all:
 *   · memory_video — the wizard exists to have a MODEL write the script, and the
 *     owner's ruling makes that the one thing a memory video may never be. The
 *     wizard's own menu carries a tombstone recording the option's removal.
 *   · home_anniversary — already commissioned and delivered by its own rail
 *     (lib/kernel/anniversary-equity.ts + the intro-video-email-backfill cron),
 *     and not a type the wizard's VIDEO_TYPES menu offers.
 * Both go to the client's record, where their real surfaces live. A control that
 * opened a wizard which cannot serve the request would be a dead door dressed as
 * a live one.
 *
 * EVERY OUTCOME IS THE SERVER'S. A refused agent-identity read, a 403, and an
 * empty feed are three different things and are said differently — an error is
 * never rendered as "nothing to film".
 */

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Lightbulb, Loader2, RefreshCw, ArrowRight, AlertCircle } from "lucide-react"
import { createClient } from "@/lib/supabase/client"

/** Mirrors what app/api/ai/video-recommendations/route.ts publishes. */
interface VideoRecommendation {
  type: "high_priority" | "listing_opportunity" | "upcoming_opportunity" | string
  /** ai_video_projects.video_type — a value from the live CHECK, never a script purpose. */
  video_type: string
  /** Where the agent acts. The route decides this; the card never guesses. */
  rail?: "video_wizard" | "contact_detail"
  target_client_id?: string | null
  target_listing_id?: string | null
  target_transaction_id?: string | null
  client_name?: string | null
  property_address?: string | null
  reason: string
  suggested_content?: string
  priority_score: number
  engagement_score?: number
  client_count?: number
}

const TYPE_TONE: Record<string, string> = {
  high_priority: "bg-red-100 text-red-800 border-red-200",
  listing_opportunity: "bg-blue-100 text-blue-800 border-blue-200",
  upcoming_opportunity: "bg-amber-100 text-amber-800 border-amber-200",
}

function humanise(token: string): string {
  return token.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

export function VideoRecommendationsCard({ userId }: { userId: string | undefined }) {
  const router = useRouter()
  const [recommendations, setRecommendations] = useState<VideoRecommendation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    if (!userId) return
    setLoading(true)
    setError(null)
    try {
      const supabase = createClient()
      // The route admits only an agent_id the caller IS (it compares against
      // agents.user_id server-side), so this resolve is for ADDRESSING, not for
      // authorisation — the server refuses regardless of what is sent.
      // agents.id and users.id are disjoint; the cross is agents.user_id.
      const { data: agentRow, error: agentError } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", userId)
        .maybeSingle()

      // A refused identity read is not "you have no agent record".
      if (agentError) {
        setError("Could not read your agent profile — recommendations are unavailable.")
        return
      }
      if (!agentRow?.id) {
        setError("No agent profile is linked to this account, so there is nothing to recommend yet.")
        return
      }

      const res = await fetch(`/api/ai/video-recommendations?agent_id=${encodeURIComponent(agentRow.id)}`)
      const payload = await res.json().catch(() => null)
      if (!res.ok) {
        setError(payload?.error ?? `Recommendations failed (${res.status}).`)
        return
      }
      setRecommendations(Array.isArray(payload?.recommendations) ? payload.recommendations : [])
      setLoaded(true)
    } catch {
      setError("Recommendations could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    void load()
  }, [load])

  function act(rec: VideoRecommendation) {
    // contact_detail is the default for anything the route did not label, so an
    // unlabelled recommendation can never be pushed into the model-writes-the-
    // script wizard by omission.
    const rail = rec.rail ?? (rec.target_client_id ? "contact_detail" : "video_wizard")
    if (rail === "contact_detail" && rec.target_client_id) {
      router.push(`/crm/contacts/${rec.target_client_id}`)
      return
    }
    router.push("/dashboard/videos/create")
  }

  if (!userId) return null

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="h-4 w-4 text-amber-500" />
          What to film next
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          <span className="sr-only">Refresh recommendations</span>
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && recommendations.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Looking at your leads, listings and clients…
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!loading && !error && loaded && recommendations.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing is waiting on a video right now — every active listing has one and no client is overdue a check-in.
          </p>
        )}

        {recommendations.map((rec, i) => (
          <div
            key={`${rec.type}-${rec.video_type}-${rec.target_client_id ?? rec.target_listing_id ?? i}`}
            className="flex items-start justify-between gap-3 rounded-lg border p-3"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={TYPE_TONE[rec.type] ?? ""}>
                  {humanise(rec.type)}
                </Badge>
                <Badge variant="secondary">{humanise(rec.video_type)}</Badge>
                {(rec.client_name || rec.property_address) && (
                  <span className="truncate text-sm font-medium">
                    {rec.client_name || rec.property_address}
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{rec.reason}</p>
              {rec.suggested_content && (
                <p className="text-xs text-muted-foreground/80">{rec.suggested_content}</p>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={() => act(rec)} className="flex-shrink-0">
              {(rec.rail ?? "video_wizard") === "contact_detail" ? "Open client" : "Start video"}
              <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
