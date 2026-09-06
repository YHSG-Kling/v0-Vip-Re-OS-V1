"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { ShieldCheck, Eye, AlertTriangle, HelpCircle, Bot, Lock, Brain, Undo2, Ban, ArrowRightLeft, CalendarClock, CheckCircle2, Scale, Trophy, Handshake, MessageSquareWarning, Gavel, Quote, Archive, RotateCcw } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import {
  setManagerAutonomy, setManagerRetired, vetoLearnedAdjustment, completeRegionalConventionReview, overrideDeliberationWinner,
  type ManagerTrustRow, type CrossManagerReferralView, type StandingReviewView,
} from "@/app/actions/admin/manager-evals"
import type { LearnedAdjustmentView } from "@/lib/managers/learning-loop"
import type { TrustTier, AutonomyPosture } from "@/lib/managers/eval-scoring"
// Type-only imports — erased at build time (the modules themselves are server-side).
import type { TeamworkMetrics } from "@/lib/managers/teamwork-metrics"
import type { DeliberationRecord } from "@/lib/managers/deliberation"
import type { AccuracyGateVerdict, AccuracyHoldRollup } from "@/lib/managers/accuracy-gate"
import type { TeamArgumentSeat } from "@/lib/managers/team-argument-map"
import type { ReaperCoverage } from "@/lib/intelligence/reaper-net"
// Pure registry data (no I/O) — the ONE source of truth for the collaboration map,
// so this surface can never drift from what the referral handler actually enforces.
import { MANAGERS, MANAGER_COLLABORATIONS, type ManagerKey } from "@/lib/kernel/manager-registry"

const FOLLOW_REC = "__recommended__"

/** One manager's OWNED PROOFS — the maintenance domains resolveMaintenanceManager holds
 *  it accountable for, and the proofs (npm scripts) that keep them green. Computed
 *  server-side in page.tsx from the registry; this surface only renders it. */
export interface OwnedProofSeat {
  key: ManagerKey
  label: string
  accent: string
  domains: Array<{ domain: string; proof: string }>
  proofs: string[]
}

const TIER_META: Record<TrustTier, { label: string; className: string; icon: typeof ShieldCheck }> = {
  trusted: { label: "Trusted", className: "bg-emerald-100 text-emerald-700 border-emerald-200", icon: ShieldCheck },
  monitored: { label: "Monitored", className: "bg-amber-100 text-amber-700 border-amber-200", icon: Eye },
  probation: { label: "Probation", className: "bg-red-100 text-red-700 border-red-200", icon: AlertTriangle },
  insufficient_data: { label: "No data yet", className: "bg-gray-100 text-gray-600 border-gray-200", icon: HelpCircle },
}

const AUTONOMY_LABEL: Record<AutonomyPosture, string> = {
  autonomous: "May act autonomously",
  review_recommended: "Review recommended",
  approval_required: "Approval required",
}

export function ManagerTrustClient({
  managers: initialManagers, team, learned: initialLearned = [], referrals = [], standingReviews: initialReviews = [], teamwork = null, accuracyGates = [], accuracyHolds = null, teamMap = [], ownedProofs = [], reaperCoverage = null,
}: {
  managers: ManagerTrustRow[]
  team: { passRate: number; total: number; trustedCount: number; managerCount: number }
  /** OWNED PROOFS per manager (maintenance ownership made visible) — see page.tsx. */
  ownedProofs?: OwnedProofSeat[]
  /** REAPER COVERAGE — which managers a "nothing falls through" reaper actually
   *  covers (dedicated / predictor-backed / none). Registry-derived in page.tsx. */
  reaperCoverage?: ReaperCoverage | null
  learned?: LearnedAdjustmentView[]
  referrals?: CrossManagerReferralView[]
  standingReviews?: StandingReviewView[]
  teamwork?: TeamworkMetrics | null
  /** THE TEAM ARGUMENT MAP (round 41) — who argues with whom, derived purely from
   *  the registry server-side (collaborations + emitters + loaders); managers that
   *  have never deliberated are shown honestly, never padded with ceremonial edges. */
  teamMap?: TeamArgumentSeat[]
  /** Per-domain accuracy-gate verdicts (round 36, accuracy-driven autonomy). */
  accuracyGates?: AccuracyGateVerdict[]
  /** Sends actually HELD by the accuracy gate (round 37 hold telemetry).
   *  null ⇒ the ledger couldn't be read — rendered as honestly unavailable. */
  accuracyHolds?: AccuracyHoldRollup | null
}) {
  const { toast } = useToast()
  const [managers, setManagers] = useState<ManagerTrustRow[]>(initialManagers)
  const [learned, setLearned] = useState<LearnedAdjustmentView[]>(initialLearned)
  const [reviews, setReviews] = useState<StandingReviewView[]>(initialReviews)
  const [referralRows, setReferralRows] = useState<CrossManagerReferralView[]>(referrals)
  const [saving, setSaving] = useState<string | null>(null)
  const [vetoing, setVetoing] = useState<string | null>(null)
  /** Which manager's RETIRE confirmation is open (retirement is never one click). */
  const [confirmRetire, setConfirmRetire] = useState<string | null>(null)
  const [retiring, setRetiring] = useState<string | null>(null)
  const [completingReview, setCompletingReview] = useState<string | null>(null)
  const hasData = team.total > 0

  async function markReviewDone(review: StandingReviewView) {
    setCompletingReview(review.key)
    const r = await completeRegionalConventionReview()
    setCompletingReview(null)
    if (!r.ok) {
      toast({ title: "Could not record the review", description: r.error, variant: "destructive" })
      return
    }
    const nowIso = new Date().toISOString()
    const dueIso = new Date(Date.now() + 365 * 86_400_000).toISOString()
    setReviews((cur) => cur.map((x) => (x.key === review.key
      ? { ...x, status: "scheduled", lastCompletedAt: nowIso, dueAt: dueIso, summary: `Verified today; next review due ${dueIso.slice(0, 10)}.` }
      : x)))
    toast({ title: "Yearly review recorded", description: "The attestation is on the audit ledger; the next verification is due in a year." })
  }

  async function toggleVeto(key: string, vetoed: boolean) {
    setVetoing(key)
    const prev = learned
    setLearned((cur) => cur.map((a) => (a.key === key ? { ...a, vetoed } : a)))
    const r = await vetoLearnedAdjustment(key, vetoed)
    setVetoing(null)
    if (!r.ok) { setLearned(prev); toast({ title: "Could not update", description: r.error, variant: "destructive" }) }
    else { toast({ title: vetoed ? "Learned behavior vetoed" : "Veto cleared", description: vetoed ? "This adjustment no longer affects any manager." : "This adjustment is active again." }) }
  }

  /**
   * RETIRE / RESTORE a manager (lane W3). The action writes managed_agents.archived_at,
   * counted and audited; this only mirrors the result onto the board. On success the row
   * stays visible and is LABELLED retired — a governance surface that silently drops a
   * manager is how a retirement goes unnoticed — and its policy control goes dead,
   * because an archived row is invisible to every `.is("archived_at", null)` reader,
   * including the one setManagerAutonomy writes through.
   */
  async function changeRetired(m: ManagerTrustRow, retired: boolean) {
    setRetiring(m.agentKind)
    const r = await setManagerRetired(m.agentKind, retired)
    setRetiring(null)
    setConfirmRetire(null)
    if (!r.ok) {
      toast({ title: retired ? "Could not retire this manager" : "Could not restore this manager", description: r.error, variant: "destructive" })
      return
    }
    const nowIso = new Date().toISOString()
    setManagers((cur) => cur.map((x) => (x.agentKind === m.agentKind
      ? {
          ...x,
          isActive: !retired,
          isRetired: retired,
          retiredAt: retired ? nowIso : null,
          // The broker override lived on the row that has just been archived; it is no
          // longer the policy of record, so the board must stop showing one.
          overrideAutonomy: retired ? null : x.overrideAutonomy,
          effectiveAutonomy: retired ? x.score.autonomy : x.effectiveAutonomy,
        }
      : x)))
    toast({
      title: retired ? `${m.label} retired` : `${m.label} restored`,
      description: retired
        ? "Its identity row is archived and its stored policy is no longer in force. This is not a stop switch — use the tenant autonomy halt if sends must stop."
        : "Its archived row is live again, with the policy it carried.",
    })
  }

  async function changeAutonomy(m: ManagerTrustRow, value: string) {
    const posture = value === FOLLOW_REC ? null : (value as AutonomyPosture)
    setSaving(m.agentKind)
    const prev = managers
    setManagers((cur) => cur.map((x) => (x.agentKind === m.agentKind
      ? { ...x, overrideAutonomy: posture, effectiveAutonomy: posture ?? x.score.autonomy }
      : x)))
    const r = await setManagerAutonomy(m.agentKind, posture)
    setSaving(null)
    if (!r.ok) {
      setManagers(prev)
      toast({ title: "Could not update policy", description: r.error, variant: "destructive" })
    } else {
      toast({ title: `${m.label} policy updated`, description: posture ? `Now: ${AUTONOMY_LABEL[posture]}` : "Reverted to the eval recommendation." })
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Manager Trust & Evaluation</h1>
          <p className="text-sm text-muted-foreground">
            Every AI manager is graded on each outcome-graded session. Trust tier drives the autonomy
            posture, which is <strong>enforced at the egress</strong> — a manager set to (or recommended)
            <em> approval required</em> can&apos;t send unattended; its outreach routes to the approval
            queue. The certifiable governance no other platform can show.
          </p>
        </div>
      </div>

      {/* Team summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard label="Team pass rate" value={hasData ? `${team.passRate}%` : "—"} icon={ShieldCheck} />
        <SummaryCard label="Graded outcomes" value={team.total} icon={Bot} />
        <SummaryCard label="Trusted managers" value={`${team.trustedCount}/${team.managerCount}`} icon={ShieldCheck} />
        <SummaryCard label="Managers" value={team.managerCount} icon={Bot} />
      </div>

      {!hasData && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            No graded sessions yet. As your managers run outcome-graded work (Anthropic Managed Agents'
            rubric grader), their results appear here and each manager earns a trust tier — until then,
            all managers default to <strong>Approval required</strong> for safety.
          </CardContent>
        </Card>
      )}

      {/* Accuracy gate — accuracy-driven autonomy (round 36): an EXPLICIT 'autonomous'
          posture must also be backed by the domain's measured prediction-accuracy rail.
          The verdicts below are the exact ones dispatch enforces at the egress. */}
      {accuracyGates.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Scale className="h-4 w-4" />Accuracy gate — autonomy must be earned by prediction accuracy</CardTitle>
            <CardDescription>
              A manager granted <em>autonomous</em> may still be held to the approval queue when its
              domain&apos;s prediction-accuracy rail hasn&apos;t earned the bar — measured from the same honest
              outcome ledgers as the accuracy panel. Halts always win; this gate never overrides them
              and never grants autonomy on its own.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {accuracyGates.map((g) => {
              const badge =
                g.state === "earned" ? { label: "Earned", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" } :
                g.state === "supervised" ? { label: "Stays supervised", cls: "bg-amber-100 text-amber-800 border-amber-200" } :
                { label: "No signal", cls: "bg-gray-100 text-gray-600 border-gray-200" }
              return (
                <div key={g.domain ?? g.railId ?? g.reason} className="flex items-start justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium capitalize">{(g.domain ?? "domain").replace(/_/g, " ")}</span>
                      <Badge variant="outline" className={`text-[11px] ${badge.cls}`}>{badge.label}</Badge>
                      {g.railId && <Badge variant="outline" className="text-[11px]">{g.railId.replace(/_/g, " ")} rail</Badge>}
                      <span className="text-[11px] text-muted-foreground">{g.observations} graded outcome{g.observations === 1 ? "" : "s"}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{g.reason}</p>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      {/* Manager Learning — what the managers learned from outcomes, with a human off-switch */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><Brain className="h-4 w-4" />What your managers learned</CardTitle>
          <CardDescription>
            The learning loop turns recent outcomes into adjustments that change behavior (e.g. a brokerage
            losing deals on financing makes the Deal-Save Huddle intervene earlier). You can <strong>veto</strong>
            {" "}any learned behavior — the off-switch is enforced everywhere instantly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {learned.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              Nothing learned yet — adjustments appear here once there's enough outcome history (the loop stays silent on a small sample, by design).
            </p>
          ) : (
            <div className="space-y-2">
              {learned.map((a) => (
                <div key={a.key} className={`flex items-start justify-between gap-3 rounded-lg border p-3 ${a.vetoed ? "opacity-60 bg-muted/40" : ""}`}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-[11px]">{a.manager.replace(/_/g, " ")}</Badge>
                      <span className="text-sm font-medium">{a.key.replace(/_/g, " ")}: <span className="text-primary">{a.value}</span></span>
                      {a.vetoed && <Badge className="bg-gray-200 text-gray-700 border-gray-300 text-[11px]">vetoed</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{a.rationale}</p>
                    {a.computed_at && <p className="text-[11px] text-muted-foreground mt-0.5">learned {new Date(a.computed_at).toLocaleDateString()} · sample {a.sample}</p>}
                  </div>
                  <Button size="sm" variant={a.vetoed ? "outline" : "ghost"} className={a.vetoed ? "" : "text-destructive"}
                    onClick={() => toggleVeto(a.key, !a.vetoed)} disabled={vetoing === a.key}>
                    {a.vetoed ? <><Undo2 className="h-3.5 w-3.5 mr-1" />Restore</> : <><Ban className="h-3.5 w-3.5 mr-1" />Veto</>}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* OWNED PROOFS — maintenance ownership, per manager. Every burn/maintenance domain
          in the registry is held by exactly one accountable manager (resolveMaintenanceManager),
          and each domain names the proof that keeps it green. Rendered from registry data
          handed down by the server page; nothing here can drift from the law. */}
      {ownedProofs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><CheckCircle2 className="h-4 w-4" />Owned proofs — what each manager keeps green</CardTitle>
            <CardDescription>
              {ownedProofs.reduce((n, s) => n + s.domains.length, 0)} maintenance domains across {ownedProofs.filter((s) => s.domains.length > 0).length} managers, each backed by a named proof.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {ownedProofs.map((seat) => (
              <details key={seat.key} className="rounded-lg border p-3">
                <summary className="cursor-pointer flex items-center gap-2 flex-wrap">
                  <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs ${seat.accent}`}>{seat.label}</span>
                  <span className="text-sm font-medium">{seat.domains.length} domain{seat.domains.length === 1 ? "" : "s"}</span>
                  <span className="text-xs text-muted-foreground">{seat.proofs.length} proof{seat.proofs.length === 1 ? "" : "s"}</span>
                </summary>
                {seat.domains.length === 0 ? (
                  <p className="text-xs text-muted-foreground mt-2">No maintenance domain is held by this seat yet.</p>
                ) : (
                  <ul className="mt-2 space-y-1 max-h-64 overflow-y-auto">
                    {seat.domains.map((d) => (
                      <li key={d.domain} className="text-xs flex items-center justify-between gap-3">
                        <span className="font-mono truncate" title={d.domain}>{d.domain}</span>
                        <Badge variant="outline" className="text-[10px] shrink-0">{d.proof}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            ))}
          </CardContent>
        </Card>
      )}

      {/* REAPER COVERAGE — the honest map of which managers a "nothing falls through"
          reaper stands behind. Dedicated reapers (REAPER_NET), predictor-backed coverage
          (a stall predictor → gated handler chain with the handoff reaper as the safety
          net), and — named, never padded — the managers NO reaper covers yet. */}
      {reaperCoverage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><Archive className="h-4 w-4" />Nothing falls through — reaper coverage</CardTitle>
            <CardDescription>
              {reaperCoverage.effectiveCoveredManagers.length} of {reaperCoverage.totalManagers} managers have a reaper behind them
              ({reaperCoverage.coveredManagers.length} dedicated, {reaperCoverage.predictorBackedManagers.length} predictor-backed).
              {reaperCoverage.uncoveredManagers.length > 0
                ? ` ${reaperCoverage.uncoveredManagers.length} covered by nothing yet.`
                : " Every manager is covered."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {reaperCoverage.coveredManagers.map((m) => (
                <span key={m} className={`inline-flex items-center rounded px-2 py-0.5 text-xs ${MANAGERS[m]?.accent ?? "bg-slate-100 text-slate-700"}`} title="dedicated reaper">
                  {MANAGERS[m]?.label ?? m}
                </span>
              ))}
              {reaperCoverage.predictorBackedManagers.map((m) => (
                <span key={m} className="inline-flex items-center rounded border px-2 py-0.5 text-xs text-muted-foreground" title="predictor → handler chain (safety net: handoff reaper)">
                  {MANAGERS[m]?.label ?? m} · predictor-backed
                </span>
              ))}
            </div>
            {reaperCoverage.uncoveredManagers.length > 0 && (
              <p className="text-xs text-amber-900 flex items-start gap-1">
                <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                <span>
                  No reaper covers: {reaperCoverage.uncoveredManagers.map((m) => MANAGERS[m]?.label ?? m).join(", ")} — stuck work in
                  those domains is caught by nothing automatic today.
                </span>
              </p>
            )}
            <ul className="space-y-1">
              {reaperCoverage.domains.map((d) => (
                <li key={d.domain} className="text-xs flex items-center justify-between gap-3">
                  <span className="font-mono truncate" title={d.protects}>{d.domain}</span>
                  <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] shrink-0 ${MANAGERS[d.manager]?.accent ?? "bg-slate-100 text-slate-700"}`}>
                    {MANAGERS[d.manager]?.label ?? d.manager}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">The Management Team</CardTitle>
          <CardDescription>Pass rate = % of graded outcomes the rubric marked “satisfied”.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {managers.map((m) => {
            const meta = TIER_META[m.score.tier]
            const TierIcon = meta.icon
            return (
              <div key={m.agentKind} className={`p-3 rounded-lg border space-y-2 ${m.isRetired ? "opacity-60 bg-muted/40" : ""}`}>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <p className="font-medium flex items-center gap-2">
                      <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs ${m.accent}`}>{m.label}</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">{m.domain}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    {m.isRetired && (
                      <Badge className="bg-gray-200 text-gray-700 border-gray-300 text-[11px] gap-1">
                        <Archive className="h-3 w-3" />
                        retired{m.retiredAt ? ` ${new Date(m.retiredAt).toLocaleDateString()}` : ""}
                      </Badge>
                    )}
                    <Badge className={`${meta.className} gap-1`}><TierIcon className="h-3 w-3" />{meta.label}</Badge>
                    <Badge variant={m.overrideAutonomy ? "default" : "outline"} className="text-xs gap-1">
                      {m.overrideAutonomy && <Lock className="h-3 w-3" />}
                      {AUTONOMY_LABEL[m.effectiveAutonomy]}
                    </Badge>
                  </div>
                </div>

                {/* RETIRE / RESTORE (lane W3) — the writer managed_agents.archived_at never had.
                    Retirement is never one click: the confirm below states what it does AND
                    what it does not do, because an archived manager's autonomy posture reads
                    as absent, and absent fails OPEN at the dispatch gate. */}
                {(m.isActive || m.isRetired) && (
                  <div className="pt-1">
                    {m.isRetired ? (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-muted-foreground">
                          Retired — its stored policy is out of force, and a dispatch of this kind would spawn a fresh manager.
                        </span>
                        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={retiring === m.agentKind}
                          onClick={() => changeRetired(m, false)}>
                          <RotateCcw className="h-3.5 w-3.5 mr-1" />Restore
                        </Button>
                      </div>
                    ) : confirmRetire === m.agentKind ? (
                      <div className="rounded-md border border-amber-200 bg-amber-50/50 p-2 space-y-2">
                        <p className="text-xs text-amber-900">
                          <strong>Retire {m.label}?</strong> Its identity row is archived, it leaves this board&apos;s
                          active roster, and the broker policy stored on it stops being the policy of record.
                        </p>
                        <p className="text-[11px] text-amber-900">
                          <strong>This is not a stop switch.</strong> A retired manager has no stored posture, and the
                          dispatch gate reads an absent posture as <em>allowed</em> — and the next dispatch of this kind
                          would spawn a brand-new manager with no policy at all. If sends must STOP, use the tenant
                          autonomy halt instead. Work already running is protected: retirement is refused while any
                          session of this manager is running or idle.
                        </p>
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setConfirmRetire(null)} disabled={retiring === m.agentKind}>Cancel</Button>
                          <Button size="sm" variant="destructive" disabled={retiring === m.agentKind}
                            onClick={() => changeRetired(m, true)}>
                            <Archive className="h-3.5 w-3.5 mr-1" />Yes, retire this manager
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-end">
                        <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive"
                          onClick={() => setConfirmRetire(m.agentKind)}>
                          <Archive className="h-3.5 w-3.5 mr-1" />Retire this manager
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {/* Broker governance: override the autonomy posture (policy of record) */}
                <div className="flex items-center justify-between gap-3 pt-1">
                  <span className="text-xs text-muted-foreground">
                    {m.overrideAutonomy
                      ? <>Broker override active · eval recommends <em>{AUTONOMY_LABEL[m.score.autonomy]}</em></>
                      : <>Following eval recommendation</>}
                  </span>
                  <Select
                    value={m.overrideAutonomy ?? FOLLOW_REC}
                    onValueChange={(v) => changeAutonomy(m, v)}
                    disabled={!m.isActive || saving === m.agentKind}
                  >
                    <SelectTrigger className="w-56 h-8 text-xs">
                      <SelectValue placeholder={m.isActive ? "Set policy" : "Not active yet"} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={FOLLOW_REC}>Follow eval recommendation</SelectItem>
                      <SelectItem value="autonomous">Override: may act autonomously</SelectItem>
                      <SelectItem value="review_recommended">Override: review recommended</SelectItem>
                      <SelectItem value="approval_required">Override: approval required</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground w-20">Rubric</span>
                  <Progress value={m.score.passRate} className="flex-1" />
                  <span className="text-sm tabular-nums w-12 text-right">{m.score.total > 0 ? `${m.score.passRate}%` : "—"}</span>
                </div>
                {/* CLOSED LEARNING LOOP — real-world outcome effectiveness alongside the rubric */}
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground w-20">Outcomes</span>
                  <Progress value={m.outcomeEffectiveness} className="flex-1" />
                  <span className="text-sm tabular-nums w-12 text-right">
                    {m.outcomeBand === "no_data" ? "—" : `${m.outcomeEffectiveness}%`}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                  <span>{m.score.satisfied}/{m.score.total} satisfied</span>
                  <span>{m.sessionCount} session{m.sessionCount === 1 ? "" : "s"}</span>
                  {m.lastEvaluatedAt && <span>last graded {new Date(m.lastEvaluatedAt).toLocaleDateString()}</span>}
                  {/* The PROVIDER's reference for that last grade — what a broker quotes when
                      disputing it. Truncated for the line; the full id is on the title. */}
                  {m.lastOutcomeRef && (
                    <span className="font-mono" title={`Anthropic outcome id ${m.lastOutcomeRef}`}>
                      outcome {m.lastOutcomeRef.length > 14 ? `${m.lastOutcomeRef.slice(0, 14)}…` : m.lastOutcomeRef}
                    </span>
                  )}
                  {/* VERSION AXIS — a pass-rate is only comparable within one agent version. */}
                  {m.anthropicVersions.length === 1 && <span>agent v{m.anthropicVersions[0]}</span>}
                  {m.anthropicVersions.length > 1 && (
                    <span className="text-amber-700" title={m.anthropicVersions.map((v) => `v${v}`).join(", ")}>
                      mixed agent versions ({m.anthropicVersions.length}) — scores span more than one
                    </span>
                  )}
                  {m.tokensIn + m.tokensOut > 0 && <span>{(m.tokensIn + m.tokensOut).toLocaleString()} tokens</span>}
                  {m.score.byResult.needs_revision ? <span>{m.score.byResult.needs_revision} needed revision</span> : null}
                  {m.score.byResult.failed ? <span className="text-red-600">{m.score.byResult.failed} failed</span> : null}
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      {/* CROSS-MANAGEMENT — the declared collaboration map (round 34). Pure registry data:
          exactly the edges the cross_manager_referral handler enforces on the bus. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><ArrowRightLeft className="h-4 w-4" />Cross-management — who co-manages what</CardTitle>
          <CardDescription>
            Single ownership stays the law (one steward per table, one owner per queue), but these are the
            <strong> declared</strong> domains where managers already work together — derived from the real
            signal traffic and stewardship overlaps. A cross-manager referral may <strong>only</strong> travel
            these edges; anything else is refused on the bus.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {Object.values(MANAGER_COLLABORATIONS).map((d) => (
            <div key={d.key} className="rounded-lg border p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium">{d.label}</span>
                {d.managers.map((mk: ManagerKey) => (
                  <span key={mk} className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] ${MANAGERS[mk].accent}`}>
                    {MANAGERS[mk].label}
                  </span>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-1">{d.evidence}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* THE TEAM ARGUMENT MAP (round 41) — who argues with whom, derived purely from
          the registry (deliberative edges + live emitters + grounded loaders). Managers
          with no deliberative seat are shown HONESTLY — their no-edge verdicts are
          documented in the registry beside the collaboration map (simulator-locked),
          never papered over with a ceremonial edge. */}
      {teamMap.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Scale className="h-4 w-4" />Team argument map</CardTitle>
            <CardDescription>
              Which managers <strong>argue</strong> with which — every edge below escalates a referral to a full
              deliberation (grounded positions, one rebuttal round, a resolved winner with the stated why). A manager
              listed as never deliberating is an honest fact, not a gap: no genuine dispute exists between its
              stewarded evidence and a peer&apos;s, and a manufactured edge would be noise.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {teamMap.map((seat) => (
              <div key={seat.manager} className="rounded-lg border p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] ${seat.accent}`}>{seat.label}</span>
                  {seat.deliberates ? (
                    <>
                      <span className="text-xs text-muted-foreground">argues with</span>
                      {seat.arguesWith.map((mk) => (
                        <span key={mk} className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] ${MANAGERS[mk].accent}`}>
                          {MANAGERS[mk].label}
                        </span>
                      ))}
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      has never deliberated — no genuine dispute with a peer&apos;s evidence (verdict documented in the registry)
                    </span>
                  )}
                </div>
                {seat.deliberates && (
                  <div className="mt-1 space-y-0.5">
                    {seat.domains.filter((d) => d.deliberative).map((d) => (
                      <p key={d.key} className="text-xs text-muted-foreground">
                        <span className="font-medium">{d.label}</span>
                        {" — raised live by "}
                        {d.emitters.length > 0
                          ? d.emitters.map((e) => `${e.kind === "sweep" ? "sweep" : "hook"}: ${e.key}`).join(", ")
                          : "no emitter registered"}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* AUTONOMY THROTTLED (round 37, hold telemetry) — sends the accuracy gate
          actually HELD at the egress, rolled up per manager/domain from the
          self-heal ledger (the same rows the Exception Center folds). Sits beside
          the deliberation/teamwork view so the broker sees enforcement, not just
          policy. Always rendered — honest empty and honest unavailable states. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Ban className="h-4 w-4" />
            Autonomy throttled — sends held by the accuracy gate
          </CardTitle>
          <CardDescription>
            Counted from the hold ledger, not modeled: each row is an autonomous send dispatch actually
            held to the approval queue because the domain&apos;s prediction-accuracy rail was below the bar.
            Last {accuracyHolds?.windowDays ?? 30} days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {accuracyHolds === null ? (
            <p className="text-sm text-muted-foreground py-2">
              Hold telemetry could not be read right now — counts are unavailable. The gate itself still
              enforces at the egress; only this view is degraded.
            </p>
          ) : accuracyHolds.totalHolds === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No autonomous sends were held by the accuracy gate in the last {accuracyHolds.windowDays} days —
              either the granted domains have earned their accuracy bar, or no gated manager attempted an
              unattended send.
            </p>
          ) : (
            <div className="space-y-2">
              {accuracyHolds.rows.map((h) => (
                <div key={`${h.managerKey}-${h.domain}`} className="flex items-start justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] ${MANAGERS[h.managerKey as ManagerKey]?.accent ?? "bg-slate-100 text-slate-700"}`}>
                        {MANAGERS[h.managerKey as ManagerKey]?.label ?? h.managerKey.replace(/_/g, " ")}
                      </span>
                      <Badge variant="outline" className="text-[11px] capitalize">{h.domain.replace(/_/g, " ")}</Badge>
                      <span className="text-sm font-medium">{h.holds} send{h.holds === 1 ? "" : "s"} held</span>
                      <span className="text-[11px] text-muted-foreground ml-auto">last {new Date(h.lastAt).toLocaleDateString()}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{h.lastReason}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* TEAMWORK METRICS (round 35) — the referral + deliberation ledgers rolled up:
          how well the managers actually work TOGETHER, per period. */}
      {teamwork && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Handshake className="h-4 w-4" />Teamwork — last {teamwork.periodDays} days</CardTitle>
            <CardDescription>
              Rolled up from the referral and deliberation ledgers — nothing modeled, every count a real row.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
              <TeamworkStat label="Handed off" value={teamwork.handedOff} />
              <TeamworkStat label="Picked up & acted" value={teamwork.resolved} />
              <TeamworkStat label="Median pickup" value={teamwork.medianPickupHours !== null ? `${teamwork.medianPickupHours}h` : "—"} />
              <TeamworkStat label="Deliberations held" value={teamwork.deliberationsHeld} />
              <TeamworkStat label="Rebuttals argued" value={teamwork.rebuttalsArgued} />
              <TeamworkStat label="Dissents recorded" value={teamwork.dissentsRecorded} />
              <TeamworkStat label="Principal's calls" value={teamwork.principalOverrides} />
            </div>
            {teamwork.deliberationsUnavailable > 0 && (
              <p className="text-[11px] text-muted-foreground mt-2">
                {teamwork.deliberationsUnavailable} deliberation{teamwork.deliberationsUnavailable === 1 ? " was" : "s were"} recorded honestly
                unavailable (model unreachable) — no canned arguments were substituted.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* CROSS-MANAGER REFERRALS — who asked whom for what, with state + what the receiver did. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><ArrowRightLeft className="h-4 w-4" />Cross-manager referrals</CardTitle>
          <CardDescription>
            A manager&apos;s sweep found something in a peer&apos;s domain and raised it through the governed bus.
            Every referral shows who asked whom, for what, and what the receiving manager did — including
            governed refusals of undeclared edges. Last 90 days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {referralRows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No referrals yet — they appear when a manager&apos;s sweep raises work into a co-managed domain
              (first live emitter: the Cron Manager referring approval kinds aging past the 48h SLA to their owners).
            </p>
          ) : (
            <div className="space-y-2">
              {referralRows.map((r) => (
                <div key={r.id} className="rounded-lg border p-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] ${MANAGERS[r.from as ManagerKey]?.accent ?? "bg-slate-100 text-slate-700"}`}>{r.fromLabel}</span>
                    <ArrowRightLeft className="h-3 w-3 text-muted-foreground" />
                    <span className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] ${MANAGERS[r.to as ManagerKey]?.accent ?? "bg-slate-100 text-slate-700"}`}>{r.toLabel}</span>
                    {r.domainLabel && <Badge variant="outline" className="text-[11px]">{r.domainLabel}</Badge>}
                    <Badge className={`text-[11px] ${r.status === "open" ? "bg-amber-100 text-amber-800 border-amber-200" : r.status === "consumed" ? "bg-emerald-100 text-emerald-700 border-emerald-200" : "bg-gray-100 text-gray-600 border-gray-200"}`}>
                      {r.status}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground ml-auto">{new Date(r.createdAt).toLocaleDateString()}</span>
                  </div>
                  <p className="text-sm mt-1.5">{r.ask}</p>
                  {r.action && (
                    <p className="text-xs text-muted-foreground mt-1">
                      <CheckCircle2 className="h-3 w-3 inline mr-1" />
                      {r.toLabel}: {r.action}
                    </p>
                  )}
                  {r.deliberation && (
                    <DeliberationBlock
                      record={r.deliberation}
                      referralId={r.id}
                      onOverridden={(updated) =>
                        setReferralRows((cur) => cur.map((x) => (x.id === r.id ? { ...x, deliberation: updated } : x)))}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* STANDING REVIEWS — recurring manager review tasks with audit-ledger-derived due state. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><CalendarClock className="h-4 w-4" />Standing reviews</CardTitle>
          <CardDescription>
            Recurring verification tasks a manager owns on a fixed cadence. Completion is recorded on the
            audit ledger — the due state derives from the latest completion, no parallel state.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {reviews.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">No standing reviews configured.</p>
          ) : reviews.map((rv) => (
            <div key={rv.key} className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] ${rv.ownerAccent}`}>{rv.ownerLabel}</span>
                <span className="text-sm font-medium">{rv.label}</span>
                <Badge className={`text-[11px] ${rv.status === "overdue" ? "bg-red-100 text-red-700 border-red-200" : rv.status === "due" ? "bg-amber-100 text-amber-800 border-amber-200" : "bg-emerald-100 text-emerald-700 border-emerald-200"}`}>
                  {rv.status}
                </Badge>
                <span className="text-[11px] text-muted-foreground ml-auto">yearly · {rv.target}</span>
              </div>
              <p className="text-xs text-muted-foreground">{rv.what}</p>
              <p className="text-xs">{rv.summary}</p>
              <div className="text-[11px] text-muted-foreground">
                <p className="font-medium">Published sources to check:</p>
                <ul className="list-disc pl-4 mt-0.5 space-y-0.5">
                  {rv.sources.map((s) => <li key={s}>{s}</li>)}
                </ul>
              </div>
              <div className="flex justify-end">
                <Button size="sm" variant="outline" disabled={completingReview === rv.key}
                  onClick={() => markReviewDone(rv)}>
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                  Mark verified against the published sources
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function TeamworkStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border p-3 text-center">
      <p className="text-xl font-bold tabular-nums">{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  )
}

/** THE ARGUMENT, rendered (round 35; rebuttals + the principal's call round 36):
 *  every manager's grounded position, the ONE bounded rebuttal round's cited
 *  pushbacks, the winner with the stated why-this-beats-the-others, honest dissent,
 *  and the human's recorded override — or the honest 'deliberation unavailable' when
 *  the model couldn't be reached. */
function DeliberationBlock({
  record, referralId, onOverridden,
}: {
  record: DeliberationRecord
  referralId: string
  onOverridden: (updated: DeliberationRecord) => void
}) {
  const { toast } = useToast()
  const [callOpen, setCallOpen] = useState(false)
  const [callWinner, setCallWinner] = useState<string>("")
  const [callReason, setCallReason] = useState("")
  const [savingCall, setSavingCall] = useState(false)
  const accent = (key: string) => (MANAGERS as Record<string, { accent: string; label: string }>)[key]?.accent ?? "bg-slate-100 text-slate-700"
  const label = (key: string) => (MANAGERS as Record<string, { accent: string; label: string }>)[key]?.label ?? key

  if (record.status !== "resolved" || !record.winner) {
    return (
      <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/50 p-2">
        <p className="text-xs text-amber-900 flex items-center gap-1">
          <Scale className="h-3 w-3" /> Deliberation unavailable — {record.unavailableReason ?? "the model could not be reached"}.
          No canned arguments were substituted; the referral still reached you.
        </p>
      </div>
    )
  }

  async function recordCall() {
    if (!callWinner || !callReason.trim()) {
      toast({ title: "The principal's call needs a pick and a reason", variant: "destructive" })
      return
    }
    setSavingCall(true)
    const r = await overrideDeliberationWinner(referralId, callWinner, callReason.trim())
    setSavingCall(false)
    if (!r.ok) {
      toast({ title: "Could not record the call", description: r.error, variant: "destructive" })
      return
    }
    onOverridden(r.record)
    setCallOpen(false)
    setCallWinner("")
    setCallReason("")
    toast({ title: "Principal's call recorded", description: "Your override is on the deliberation ledger with the stated reason." })
  }

  return (
    <div className="mt-2 rounded-md border bg-muted/30 p-2 space-y-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        <Scale className="h-3 w-3" /> The argument — {record.positions.length} positions
        {record.rebuttalHeld ? <span className="normal-case tracking-normal">· one rebuttal round held</span> : null}
      </p>
      {record.positions.map((p) => (
        <div key={p.manager} className={`rounded border p-2 ${p.manager === record.winner ? "border-emerald-300 bg-emerald-50/40" : "bg-background"}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] ${accent(p.manager)}`}>{label(p.manager)}</span>
            {p.manager === record.winner && (
              <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-[10px] gap-1"><Trophy className="h-3 w-3" />winning position</Badge>
            )}
            {record.override?.winner === p.manager && (
              <Badge className="bg-indigo-100 text-indigo-800 border-indigo-200 text-[10px] gap-1"><Gavel className="h-3 w-3" />principal&apos;s pick</Badge>
            )}
            {record.dissent?.manager === p.manager && (
              <Badge className="bg-orange-100 text-orange-800 border-orange-200 text-[10px] gap-1"><MessageSquareWarning className="h-3 w-3" />dissent on the record</Badge>
            )}
          </div>
          <p className="text-xs mt-1"><span className="font-medium">Proposal:</span> {p.proposal}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{p.reasoning}</p>
          {p.risks.length > 0 && (
            <p className="text-[11px] text-muted-foreground mt-0.5"><span className="font-medium">Risks:</span> {p.risks.join(" · ")}</p>
          )}
          {p.evidence.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {p.evidence.map((e, i) => (
                <li key={i} className="text-[11px] font-mono text-muted-foreground truncate">📎 {e}</li>
              ))}
            </ul>
          )}
          {p.rebuttal?.note && (
            <div className="mt-1.5 rounded border border-slate-200 bg-slate-50/60 p-1.5">
              <p className="text-[11px] text-slate-700 flex items-start gap-1">
                <Quote className="h-3 w-3 mt-0.5 shrink-0" />
                <span><span className="font-medium">Rebuts the others:</span> {p.rebuttal.note}</span>
              </p>
              {p.rebuttal.evidence.length > 0 && (
                <ul className="mt-0.5 space-y-0.5 pl-4">
                  {p.rebuttal.evidence.map((e, i) => (
                    <li key={i} className="text-[11px] font-mono text-muted-foreground truncate">📎 {e}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      ))}
      <div className="rounded border border-emerald-200 bg-emerald-50/50 p-2">
        <p className="text-xs text-emerald-900">
          <span className="font-medium">Why {label(record.winner)}&apos;s solution won:</span> {record.resolution}
        </p>
      </div>
      {record.dissent && (
        <div className="rounded border border-orange-200 bg-orange-50/50 p-2">
          <p className="text-xs text-orange-900">
            <span className="font-medium">{label(record.dissent.manager)} dissents:</span> {record.dissent.note}
          </p>
        </div>
      )}
      {/* THE PRINCIPAL'S CALL (round 36) — the human weighs in: override the argued
          winner with a stated reason, recorded on the same deliberation ledger. */}
      {record.override ? (
        <div className="rounded border border-indigo-200 bg-indigo-50/50 p-2">
          <p className="text-xs text-indigo-900 flex items-start gap-1">
            <Gavel className="h-3 w-3 mt-0.5 shrink-0" />
            <span>
              <span className="font-medium">Principal&apos;s call — {label(record.override.winner)} governs</span>
              {record.override.winner !== record.winner ? <> (overriding {label(record.winner)}&apos;s argued win)</> : <> (confirming the argued win)</>}:
              {" "}{record.override.reason}
              <span className="text-indigo-700/70"> · {new Date(record.override.at).toLocaleDateString()}</span>
            </span>
          </p>
        </div>
      ) : callOpen ? (
        <div className="rounded border border-indigo-200 bg-indigo-50/30 p-2 space-y-2">
          <p className="text-[11px] font-medium text-indigo-900 flex items-center gap-1">
            <Gavel className="h-3 w-3" /> The principal&apos;s call — pick the position that governs, and say why
          </p>
          <Select value={callWinner || undefined} onValueChange={setCallWinner}>
            <SelectTrigger className="h-8 text-xs bg-background">
              <SelectValue placeholder="Pick the winning position" />
            </SelectTrigger>
            <SelectContent>
              {record.positions.map((p) => (
                <SelectItem key={p.manager} value={p.manager}>
                  {label(p.manager)}{p.manager === record.winner ? " (argued winner)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <textarea
            value={callReason}
            onChange={(e) => setCallReason(e.target.value)}
            placeholder="Your stated reason — required; an unexplained override is refused"
            className="w-full rounded-md border bg-background p-2 text-xs min-h-[52px]"
            maxLength={500}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setCallOpen(false)} disabled={savingCall}>Cancel</Button>
            <Button size="sm" onClick={recordCall} disabled={savingCall || !callWinner || !callReason.trim()}>
              <Gavel className="h-3.5 w-3.5 mr-1" />Record the call
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setCallOpen(true)}>
            <Gavel className="h-3.5 w-3.5 mr-1" />Principal&apos;s call — override the winner
          </Button>
        </div>
      )}
    </div>
  )
}

function SummaryCard({ label, value, icon: Icon }: { label: string; value: string | number; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <Icon className="h-7 w-7 text-muted-foreground" />
        <div><p className="text-2xl font-bold">{value}</p><p className="text-xs text-muted-foreground">{label}</p></div>
      </CardContent>
    </Card>
  )
}
