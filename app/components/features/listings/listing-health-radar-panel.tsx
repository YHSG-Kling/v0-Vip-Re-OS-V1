"use client"

/**
 * <ListingHealthRadarPanel> — surface for the active-listing health radar.
 *
 * Mirrors the Deal Health Radar UX (commit 193895c) but for the listing
 * lifecycle stage. Reads server-pre-loaded data:
 *
 *   - healthScore         : latest row from listing_health_scores
 *   - openInterventions   : unresolved listing_health_interventions
 *   - scoreHistory        : recent 7 scores for trend context
 *   - resolvedInterventions (OPTIONAL, additive): interventions already CLEARED,
 *     with who cleared them and the note they wrote
 *
 * Provides:
 *   - Trend (delta + ▲/▼)
 *   - Refresh button (POST /api/cron/listing-health-scan via action)
 *   - Open interventions list (top 3) with severity chips + Mark resolved
 *   - Resolved history — see below
 *   - "See all → /health" link when there are more (links to a per-listing
 *     deep-dive route if/when one is added)
 *
 * RESOLVED HISTORY. `resolved`, `resolved_at`, `resolved_by` and `resolution_note`
 * are all stamped by app/actions/listing-health-actions.ts:88, and every reader in
 * the product filtered those rows OUT (`.eq("resolved", false)` — this page's
 * source, app/dashboard/listings/health/actions.ts:113, and
 * app/actions/listing-risk-agent.ts:124). A cleared `seller_impacted` flag was
 * therefore unauditable: a broker could never ask who cleared it or on what
 * grounds. `resolvedInterventions` is OPTIONAL so existing callers keep working
 * unchanged; the OPEN list stays open-only and is not touched.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  Loader2,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  History,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  rescanListingHealthAction,
  resolveListingInterventionAction,
} from "@/app/actions/listing-health-actions"

interface ListingHealthScore {
  id: string
  overall_score: number
  risk_level: string
  flags: string[] | null
  ai_narrative: string | null
  previous_score: number | null
  score_delta: number | null
  days_on_market: number | null
  scored_at: string
  recommended_actions: Array<{ action: string; reasoning: string; impactEstimate?: string }> | null
}

interface ListingHealthIntervention {
  id: string
  issue_detected: string
  severity: string
  ai_recommendation: string | null
  category: string | null
  created_at: string
}

/** A CLEARED intervention plus the accountability record attached to clearing it.
 *  `resolved_by` is a users.id (scripts/schema-fk-map.ts:458 —
 *  `listing_health_interventions.resolved_by → users`), resolved to a name by the
 *  server. `resolvedByName` null with `resolvedBy` set means the account did not
 *  resolve inside this brokerage; both null means nobody was recorded. */
interface ResolvedListingHealthIntervention extends ListingHealthIntervention {
  seller_impacted: boolean | null
  resolved_at: string | null
  resolved_by: string | null
  resolvedByName: string | null
  resolution_note: string | null
}

interface Props {
  listingId: string
  healthScore: ListingHealthScore | null
  openInterventions: ListingHealthIntervention[]
  scoreHistory: Array<{ overall_score: number; risk_level: string; scored_at: string }>
  /** Additive — omitted by callers that have not wired the history read. */
  resolvedInterventions?: ResolvedListingHealthIntervention[]
  /** What the history read covered, so the section can state its own bounds
   *  instead of implying it shows everything. */
  resolvedWindowDays?: number
  resolvedLimit?: number
}

export type { ResolvedListingHealthIntervention }

const RISK_BG: Record<string, string> = {
  healthy:  "bg-green-500",
  watch:    "bg-amber-400",
  at_risk:  "bg-amber-600",
  critical: "bg-red-600",
}
const RISK_BORDER: Record<string, string> = {
  healthy:  "border-green-200 bg-green-50",
  watch:    "border-amber-200 bg-amber-50",
  at_risk:  "border-amber-300 bg-amber-50",
  critical: "border-red-200 bg-red-50",
}

export function ListingHealthRadarPanel({
  listingId,
  healthScore,
  openInterventions,
  scoreHistory,
  resolvedInterventions,
  resolvedWindowDays,
  resolvedLimit,
}: Props) {
  const router = useRouter()
  const [historyOpen, setHistoryOpen] = useState(false)
  const resolved = resolvedInterventions ?? []
  const [rescanning, setRescanning] = useState(false)
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  async function handleRescan() {
    if (rescanning) return
    setRescanning(true)
    try {
      const r = await rescanListingHealthAction({ listingId })
      if (r.success) {
        toast.success(`Listing rescored — ${r.overallScore}/100 (${r.riskLevel})`)
        router.refresh()
      } else {
        toast.error(r.error ?? "Rescan failed")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rescan failed")
    } finally {
      setRescanning(false)
    }
  }

  async function handleResolve(id: string) {
    setResolvingId(id)
    try {
      const r = await resolveListingInterventionAction({ interventionId: id })
      if (r.success) {
        toast.success("Intervention marked resolved")
        router.refresh()
      } else {
        toast.error(r.error ?? "Could not resolve")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not resolve")
    } finally {
      setResolvingId(null)
    }
  }

  // No score yet — minimal first-run state
  if (!healthScore) {
    return (
      <div className="rounded-lg border border-input bg-card p-4 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">📡 Listing Health Radar</p>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            disabled={rescanning}
            onClick={handleRescan}
          >
            {rescanning
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <RefreshCw className="h-3 w-3" />}
            Run first scan
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          No score calculated yet. Run a scan to see DOM, showings, feedback, open-house, price-vs-comps, and activity signals.
        </p>
        {/* A listing with no CURRENT score can still have interventions someone
            cleared. Gating the audit trail on "has a score" would put the record
            back out of sight, which is the defect this section exists to close. */}
        <ResolvedHistory
          resolved={resolved}
          open={historyOpen}
          onToggle={() => setHistoryOpen((v) => !v)}
          windowDays={resolvedWindowDays}
          limit={resolvedLimit}
        />
      </div>
    )
  }

  const riskLevel = healthScore.risk_level
  return (
    <div className={cn(
      "rounded-lg border p-4 space-y-3",
      RISK_BORDER[riskLevel] ?? "border-input bg-card",
    )}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">📡 Listing Health Radar</p>
        <div className="flex items-center gap-2 text-[11px]">
          <span className={cn(
            "px-1.5 py-0.5 rounded-full text-white font-medium",
            RISK_BG[riskLevel] ?? "bg-gray-500",
          )}>
            {riskLevel.replace("_", " ")}
          </span>
          <span className="font-semibold text-sm">{healthScore.overall_score}/100</span>
        </div>
      </div>

      {/* Score bar */}
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={cn("h-full transition-all", RISK_BG[riskLevel] ?? "bg-gray-500")}
          style={{ width: `${healthScore.overall_score}%` }}
        />
      </div>

      {/* Trend + actions */}
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-2 text-muted-foreground">
          {typeof healthScore.score_delta === "number" && healthScore.score_delta !== 0 ? (
            <span className={cn(
              "inline-flex items-center gap-0.5 font-medium",
              healthScore.score_delta > 0 ? "text-emerald-600" : "text-red-600",
            )}>
              {healthScore.score_delta > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {healthScore.score_delta > 0 ? "+" : ""}{healthScore.score_delta}
            </span>
          ) : (
            <span>— flat vs last scan</span>
          )}
          {healthScore.days_on_market != null && (
            <span>· {healthScore.days_on_market}d on market</span>
          )}
          {scoreHistory.length > 1 && (
            <span className="text-[10px]">({scoreHistory.length} scores · last {new Date(healthScore.scored_at).toLocaleDateString()})</span>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px] gap-1"
          disabled={rescanning}
          onClick={handleRescan}
          title="Trigger fresh listing-health score now"
        >
          <RefreshCw className={cn("h-3 w-3", rescanning && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* AI narrative when at_risk / critical */}
      {healthScore.ai_narrative && (riskLevel === "at_risk" || riskLevel === "critical") && (
        <div className="rounded-md bg-white border border-input p-2.5 text-xs">
          <p className="text-foreground leading-snug">{healthScore.ai_narrative}</p>
        </div>
      )}

      {/* Recommended actions */}
      {Array.isArray(healthScore.recommended_actions) && healthScore.recommended_actions.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-semibold text-foreground">Recommended actions</p>
          <ul className="space-y-1">
            {healthScore.recommended_actions.slice(0, 3).map((a, i) => (
              <li key={i} className="rounded-md bg-white border border-input p-2 text-[11px]">
                <p className="font-medium leading-snug">{a.action}</p>
                {a.reasoning && (
                  <p className="text-muted-foreground leading-snug">{a.reasoning}</p>
                )}
                {a.impactEstimate && (
                  <p className="text-emerald-700 text-[10px] mt-0.5">Impact: {a.impactEstimate}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Open interventions */}
      {openInterventions.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold text-foreground">
            {openInterventions.length} open intervention{openInterventions.length === 1 ? "" : "s"}
          </p>
          <ul className="space-y-1.5">
            {openInterventions.slice(0, 3).map((iv) => (
              <li key={iv.id} className={cn(
                "rounded-md border p-2 text-[11px] space-y-0.5",
                iv.severity === "critical" ? "border-red-200 bg-red-50" :
                iv.severity === "high"     ? "border-amber-200 bg-amber-50" :
                                             "border-input bg-muted/20",
              )}>
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium leading-snug">{iv.issue_detected}</p>
                  <span className={cn(
                    "text-[9px] uppercase px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap",
                    iv.severity === "critical" ? "bg-red-200 text-red-800" :
                    iv.severity === "high"     ? "bg-amber-200 text-amber-800" :
                                                 "bg-gray-200 text-gray-700",
                  )}>
                    {iv.severity}
                  </span>
                </div>
                {iv.ai_recommendation && (
                  <p className="text-muted-foreground leading-snug">{iv.ai_recommendation}</p>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1.5 text-[10px] mt-0.5"
                  disabled={resolvingId === iv.id}
                  onClick={() => handleResolve(iv.id)}
                >
                  {resolvingId === iv.id ? <Loader2 className="h-2.5 w-2.5 animate-spin mr-1" /> : null}
                  Mark resolved
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ResolvedHistory
        resolved={resolved}
        open={historyOpen}
        onToggle={() => setHistoryOpen((v) => !v)}
        windowDays={resolvedWindowDays}
        limit={resolvedLimit}
      />

      {/* Flat health */}
      {riskLevel === "healthy" && openInterventions.length === 0 && (
        <p className="text-xs text-green-700 font-medium inline-flex items-center gap-1">
          <AlertTriangle className="h-3 w-3 rotate-180 text-green-600" />
          No risk flags detected — listing on healthy trajectory.
        </p>
      )}
    </div>
  )
}

/**
 * The cleared-flag audit trail. Rendered from BOTH panel states — a listing with
 * no score yet can still have interventions that someone cleared, and hiding the
 * trail behind "has a score" would recreate the very invisibility this closes.
 */
function ResolvedHistory({
  resolved, open, onToggle, windowDays, limit,
}: {
  resolved: ResolvedListingHealthIntervention[]
  open: boolean
  onToggle: () => void
  windowDays?: number
  limit?: number
}) {
  // The audit trail for cleared flags. Every reader in the product filters
  // resolved rows out, so "who cleared the seller_impacted flag, when, and why"
  // existed only in the database. Collapsed by default — the panel's job is still
  // the OPEN work.
  if (resolved.length === 0) return null
  return (
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => onToggle()}
            className="text-[11px] font-semibold text-foreground inline-flex items-center gap-1 hover:underline"
          >
            <History className="h-3 w-3" />
            {resolved.length} resolved intervention{resolved.length === 1 ? "" : "s"}
            <span className="text-muted-foreground font-normal">{open ? "— hide" : "— show who cleared them"}</span>
          </button>
          {open && (
            <>
              <ul className="space-y-1.5">
                {resolved.map((iv) => (
                  <li key={iv.id} className="rounded-md border border-input bg-muted/20 p-2 text-[11px] space-y-0.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium leading-snug">{iv.issue_detected}</p>
                      <span className="text-[9px] uppercase px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap bg-emerald-100 text-emerald-800">
                        cleared
                      </span>
                    </div>
                    <p className="text-muted-foreground leading-snug">
                      {iv.severity}
                      {iv.category ? ` · ${iv.category}` : ""}
                      {iv.seller_impacted ? " · seller impacted" : ""}
                      {` · raised ${new Date(iv.created_at).toLocaleDateString()}`}
                    </p>
                    <p className="leading-snug">
                      {/* WHO. Three distinct states — a missing name is not a
                          missing actor, and neither is ever "resolved by the system". */}
                      {iv.resolvedByName
                        ? <>Cleared by <span className="font-medium">{iv.resolvedByName}</span></>
                        : iv.resolved_by
                        ? <>Cleared by an account outside this brokerage</>
                        : <>Cleared — <span className="text-muted-foreground">resolver not recorded</span></>}
                      {iv.resolved_at
                        ? ` on ${new Date(iv.resolved_at).toLocaleString()}`
                        : " (time not recorded)"}
                    </p>
                    {iv.resolution_note
                      ? <p className="text-muted-foreground leading-snug italic">&ldquo;{iv.resolution_note}&rdquo;</p>
                      : <p className="text-muted-foreground leading-snug">No resolution note was written.</p>}
                  </li>
                ))}
              </ul>
              {/* Publish the bounds beside the list — a history that silently
                  truncates reads as a complete record. */}
              {(windowDays || limit) && (
                <p className="text-[10px] text-muted-foreground">
                  Showing the {limit ? `most recent ${limit}` : "most recent"} resolved
                  {windowDays ? ` in the last ${windowDays} days` : ""}
                  {resolved.length === limit ? " — older ones are not shown." : "."}
                </p>
              )}
            </>
          )}
        </div>
  )
}
