"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { ShieldCheck, Eye, AlertTriangle, HelpCircle, Bot, Lock, Brain, Undo2, Ban } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { setManagerAutonomy, vetoLearnedAdjustment, type ManagerTrustRow } from "@/app/actions/admin/manager-evals"
import type { LearnedAdjustmentView } from "@/lib/managers/learning-loop"
import type { TrustTier, AutonomyPosture } from "@/lib/managers/eval-scoring"

const FOLLOW_REC = "__recommended__"

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
  managers: initialManagers, team, learned: initialLearned = [],
}: {
  managers: ManagerTrustRow[]
  team: { passRate: number; total: number; trustedCount: number; managerCount: number }
  learned?: LearnedAdjustmentView[]
}) {
  const { toast } = useToast()
  const [managers, setManagers] = useState<ManagerTrustRow[]>(initialManagers)
  const [learned, setLearned] = useState<LearnedAdjustmentView[]>(initialLearned)
  const [saving, setSaving] = useState<string | null>(null)
  const [vetoing, setVetoing] = useState<string | null>(null)
  const hasData = team.total > 0

  async function toggleVeto(key: string, vetoed: boolean) {
    setVetoing(key)
    const prev = learned
    setLearned((cur) => cur.map((a) => (a.key === key ? { ...a, vetoed } : a)))
    const r = await vetoLearnedAdjustment(key, vetoed)
    setVetoing(null)
    if (!r.ok) { setLearned(prev); toast({ title: "Could not update", description: r.error, variant: "destructive" }) }
    else { toast({ title: vetoed ? "Learned behavior vetoed" : "Veto cleared", description: vetoed ? "This adjustment no longer affects any manager." : "This adjustment is active again." }) }
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
              <div key={m.agentKind} className="p-3 rounded-lg border space-y-2">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <p className="font-medium flex items-center gap-2">
                      <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs ${m.accent}`}>{m.label}</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">{m.domain}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    <Badge className={`${meta.className} gap-1`}><TierIcon className="h-3 w-3" />{meta.label}</Badge>
                    <Badge variant={m.overrideAutonomy ? "default" : "outline"} className="text-xs gap-1">
                      {m.overrideAutonomy && <Lock className="h-3 w-3" />}
                      {AUTONOMY_LABEL[m.effectiveAutonomy]}
                    </Badge>
                  </div>
                </div>

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
                  {m.tokensIn + m.tokensOut > 0 && <span>{(m.tokensIn + m.tokensOut).toLocaleString()} tokens</span>}
                  {m.score.byResult.needs_revision ? <span>{m.score.byResult.needs_revision} needed revision</span> : null}
                  {m.score.byResult.failed ? <span className="text-red-600">{m.score.byResult.failed} failed</span> : null}
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>
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
