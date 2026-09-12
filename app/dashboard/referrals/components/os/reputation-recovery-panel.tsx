"use client"

/**
 * SERVICE RECOVERY + REVIEW MONITORING — the negative-review lane nobody could reach.
 *
 * `app/actions/ai-review-automation.ts` holds six actions. Four had surfaces.
 * These two did not, and they are the two that only matter when something has
 * gone WRONG:
 *
 *   · aiCreateRecoveryPlan — given a bad review, it reads that client's real
 *     history (transactions + logged activities, pinned to the caller's own
 *     brokerage) and returns a severity call, a root-cause analysis, dated
 *     immediate actions with scripts, an outreach plan, a public-response
 *     approach, internal process changes and an escalation path. It records the
 *     plan against the review. Until now the product's entire answer to a
 *     one-star review was `aiGenerateReviewResponse` — a PUBLIC REPLY. Drafting
 *     the reply and doing nothing for the client is reputation management with
 *     the reputation part and none of the management.
 *
 *   · aiSetupReviewMonitoring — which platforms to watch and the star rating at
 *     or below which a review is treated as a recovery case.
 *
 * HONESTY NOTES, because both are easy to over-read:
 *   1. Monitoring here RECORDS the agent's threshold. No cron polls Google or
 *     Zillow on their behalf today, so the panel says "flagged here" and never
 *     "you will be alerted", which the action's own message used to imply.
 *   2. The recovery plan is persisted by the action; `persisted` comes back from
 *     it and is shown, because a swallowed write refusal would otherwise leave
 *     the agent believing a plan is on record when nothing was stored.
 */

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { LifeBuoy, Loader2, ShieldAlert, Bell, AlertTriangle, CheckCircle2 } from "lucide-react"
import {
  aiCreateRecoveryPlan,
  aiSetupReviewMonitoring,
  getReviewMonitoringSettings,
} from "@/app/actions/ai-review-automation"
import { toast } from "sonner"

interface ExistingReview {
  id: string
  platform: string
  rating: number
  review_text: string
  contact_id?: string | null
}

interface RecoveryPlan {
  severity: "critical" | "serious" | "moderate" | "minor"
  rootCauseAnalysis: string[]
  immediateActions: Array<{ action: string; owner: string; deadline: string; script: string }>
  recoveryOutreach: {
    channel: string
    timing: string
    message: string
    offerCompensation: boolean
    compensationType?: string
  }
  publicResponseStrategy: string
  internalProcessChanges: string[]
  successMetrics: string[]
  escalationPath: string
}

/** Same vocabulary agent_reviews_platform_check admits (verified live). */
const MONITOR_PLATFORMS = [
  { value: "google", label: "Google" },
  { value: "zillow", label: "Zillow" },
  { value: "realtor_com", label: "Realtor.com" },
  { value: "facebook", label: "Facebook" },
  { value: "yelp", label: "Yelp" },
]

const SEVERITY_VARIANT: Record<string, "destructive" | "default" | "secondary"> = {
  critical: "destructive",
  serious: "destructive",
  moderate: "default",
  minor: "secondary",
}

export function ReputationRecoveryPanel({
  agentId,
  existingReviews,
}: {
  agentId: string
  existingReviews: ExistingReview[]
}) {
  const [threshold, setThreshold] = useState<number>(3)
  const [platforms, setPlatforms] = useState<string[]>(["google"])
  const [monitoringSaved, setMonitoringSaved] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)

  const [planFor, setPlanFor] = useState<string | null>(null)
  const [plan, setPlan] = useState<RecoveryPlan | null>(null)
  const [planPersisted, setPlanPersisted] = useState<boolean | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)

  const [isPending, startTransition] = useTransition()

  // Read the saved configuration back. A failed read is reported as a failed
  // read — never rendered as "not configured", which would invite the agent to
  // overwrite a threshold they cannot currently see.
  useEffect(() => {
    let cancelled = false
    getReviewMonitoringSettings().then((result) => {
      if (cancelled) return
      if (!result.success) {
        setSettingsError(result.error)
        return
      }
      if (result.configured) {
        setPlatforms(result.platforms)
        setThreshold(result.alertThreshold)
        setMonitoringSaved(result.updatedAt)
      }
    })
    return () => { cancelled = true }
  }, [])

  // The reviews that this threshold treats as recovery cases.
  const flagged = existingReviews.filter((r) => typeof r.rating === "number" && r.rating <= threshold)

  const togglePlatform = (value: string) => {
    setPlatforms((current) =>
      current.includes(value) ? current.filter((p) => p !== value) : [...current, value],
    )
  }

  const saveMonitoring = () => {
    startTransition(async () => {
      const result = await aiSetupReviewMonitoring({ agentId, platforms, alertThreshold: threshold })
      if (!result.success) {
        toast.error((result as { error?: string }).error ?? "Monitoring settings were not saved")
        return
      }
      setSettingsError(null)
      setMonitoringSaved(new Date().toISOString())
      toast.success((result as any).data?.message ?? "Monitoring settings saved")
    })
  }

  const buildPlan = (review: ExistingReview) => {
    setPlanFor(review.id)
    setPlan(null)
    setPlanError(null)
    setPlanPersisted(null)
    startTransition(async () => {
      const result = await aiCreateRecoveryPlan({
        reviewId: review.id,
        agentId,
        reviewText: review.review_text ?? "",
        rating: review.rating,
        clientId: review.contact_id ?? undefined,
      })
      if (!result.success) {
        setPlanError((result as { error?: string }).error ?? "Could not build a recovery plan.")
        return
      }
      setPlan((result as any).data as RecoveryPlan)
      setPlanPersisted(((result as any).persisted as boolean) ?? null)
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <LifeBuoy className="h-4 w-4" />
          Service recovery
        </CardTitle>
        <CardDescription>
          What to do when a review goes badly — not just what to reply.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* ── Monitoring configuration ─────────────────────────────────────── */}
        <div className="rounded-md border p-3">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Which reviews count as a recovery case</span>
          </div>

          {settingsError && (
            <p className="mt-2 text-xs text-destructive">{settingsError}</p>
          )}

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Platforms to watch</Label>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {MONITOR_PLATFORMS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => togglePlatform(p.value)}
                    className={`rounded border px-2 py-0.5 text-xs ${
                      platforms.includes(p.value)
                        ? "border-primary bg-primary/10 text-foreground"
                        : "bg-background text-muted-foreground hover:border-primary"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label className="text-xs">Flag reviews at or below</Label>
              <Select value={String(threshold)} onValueChange={(v) => setThreshold(Number(v))}>
                <SelectTrigger className="mt-1.5 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <SelectItem key={n} value={String(n)}>{n} star{n === 1 ? "" : "s"}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={saveMonitoring} disabled={isPending || platforms.length === 0}>
              {isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </Button>
            {monitoringSaved && (
              <span className="text-[11px] text-muted-foreground">
                Saved {new Date(monitoringSaved).toLocaleDateString()}
              </span>
            )}
          </div>

          <p className="mt-2 text-[11px] text-muted-foreground">
            This records your threshold and flags matching reviews on this screen. The platforms
            are not polled on your behalf — reviews appear here once they are recorded against you.
          </p>
        </div>

        {/* ── Flagged reviews ──────────────────────────────────────────────── */}
        <div>
          <p className="text-sm font-medium">
            {flagged.length === 0
              ? `No reviews at or below ${threshold} star${threshold === 1 ? "" : "s"}.`
              : `${flagged.length} review${flagged.length === 1 ? "" : "s"} at or below ${threshold} star${threshold === 1 ? "" : "s"}`}
          </p>

          <div className="mt-2 space-y-2">
            {flagged.map((review) => (
              <div key={review.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <ShieldAlert className="h-4 w-4 shrink-0 text-destructive" />
                  <Badge variant="destructive" className="text-[10px]">{review.rating}★</Badge>
                  <span className="text-xs capitalize text-muted-foreground">
                    {review.platform?.replace(/_/g, ".")}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto h-7 text-xs"
                    onClick={() => buildPlan(review)}
                    disabled={isPending}
                  >
                    {isPending && planFor === review.id ? (
                      <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    ) : null}
                    Build recovery plan
                  </Button>
                </div>
                <p className="mt-1.5 line-clamp-3 text-sm text-muted-foreground">{review.review_text}</p>

                {planFor === review.id && planError && (
                  <p className="mt-2 text-xs text-destructive">{planError}</p>
                )}

                {planFor === review.id && plan && (
                  <div className="mt-3 space-y-3 rounded-md bg-muted/40 p-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={SEVERITY_VARIANT[plan.severity] ?? "secondary"} className="text-[10px] uppercase">
                        {plan.severity}
                      </Badge>
                      {planPersisted === true && (
                        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <CheckCircle2 className="h-3 w-3" /> Recorded against this review
                        </span>
                      )}
                      {planPersisted === false && (
                        <span className="flex items-center gap-1 text-[10px] text-destructive">
                          <AlertTriangle className="h-3 w-3" /> Not recorded — copy this before you leave the page
                        </span>
                      )}
                    </div>

                    {plan.rootCauseAnalysis?.length > 0 && (
                      <div>
                        <p className="font-medium">Root causes</p>
                        <ul className="ml-4 list-disc text-muted-foreground">
                          {plan.rootCauseAnalysis.map((c, i) => <li key={i}>{c}</li>)}
                        </ul>
                      </div>
                    )}

                    {plan.immediateActions?.length > 0 && (
                      <div>
                        <p className="font-medium">Do now</p>
                        <ul className="space-y-1.5">
                          {plan.immediateActions.map((a, i) => (
                            <li key={i} className="rounded border bg-background p-2">
                              <p className="font-medium">{a.action}</p>
                              <p className="text-muted-foreground">{a.owner} · {a.deadline}</p>
                              {a.script && <p className="mt-1 italic text-muted-foreground">"{a.script}"</p>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {plan.recoveryOutreach && (
                      <div>
                        <p className="font-medium">
                          Reach out — {plan.recoveryOutreach.channel}, {plan.recoveryOutreach.timing}
                        </p>
                        <p className="text-muted-foreground">{plan.recoveryOutreach.message}</p>
                        {plan.recoveryOutreach.offerCompensation && (
                          <p className="mt-1 text-muted-foreground">
                            Suggests compensation{plan.recoveryOutreach.compensationType ? `: ${plan.recoveryOutreach.compensationType}` : ""} —
                            your call, and your brokerage's policy governs it.
                          </p>
                        )}
                      </div>
                    )}

                    {plan.publicResponseStrategy && (
                      <div>
                        <p className="font-medium">Public response approach</p>
                        <p className="text-muted-foreground">{plan.publicResponseStrategy}</p>
                      </div>
                    )}

                    {plan.escalationPath && (
                      <div>
                        <p className="font-medium">Escalate to</p>
                        <p className="text-muted-foreground">{plan.escalationPath}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
