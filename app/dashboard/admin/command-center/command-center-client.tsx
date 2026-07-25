"use client"

import { useState, useTransition } from "react"
import { ScopeSwitcher } from "./scope-switcher"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { approveAgentAction, rejectAgentAction } from "@/app/actions/command-center"
import { generateStandupAudio } from "@/app/actions/standup-audio"
import type { CommandCenterData, CommandCenterAction, CommandCenterSession } from "@/lib/kernel/command-center"
import { MANAGERS } from "@/lib/kernel/manager-registry"
import { ManagerTalkFeed } from "./manager-talk-feed"
import { ManagerActivityFeed } from "./manager-activity-feed"
import { CommandBar } from "./command-bar"

const SESSION_BADGE: Record<string, string> = {
  running:    "bg-green-100 text-green-800",
  idle:       "bg-amber-100 text-amber-800",
  terminated: "bg-slate-100 text-slate-700",
  error:      "bg-red-100 text-red-800",
}
const QUEUE_BADGE: Record<string, string> = {
  marketing:   "bg-purple-100 text-purple-800",
  asset:       "bg-orange-100 text-orange-800",
  social:      "bg-sky-100 text-sky-800",
  newsletter:  "bg-emerald-100 text-emerald-800",
  direct_mail: "bg-amber-100 text-amber-900",
  ads:           "bg-rose-100 text-rose-800",
  ad_creative:   "bg-pink-100 text-pink-800",
  client_message:"bg-indigo-100 text-indigo-800",
  predictive_listing:"bg-teal-100 text-teal-800",
  transaction_task:  "bg-red-100 text-red-800",
  transaction_smart_task: "bg-red-50 text-red-700",
  agent_followup:    "bg-cyan-100 text-cyan-800",
  blog:              "bg-lime-100 text-lime-800",
  podcast:           "bg-fuchsia-100 text-fuchsia-800",
}
const QUEUE_LABEL: Record<string, string> = {
  marketing:     "Marketing Agent",
  asset:         "Asset Manager",
  social:        "Social Post",
  newsletter:    "Newsletter",
  direct_mail:   "Direct Mail",
  ads:           "Ads Manager",
  ad_creative:   "Ad Creative",
  client_message:"Client Update",
  predictive_listing:"Predicted Seller",
  transaction_task:  "At-Risk Deal",
  transaction_smart_task: "Deal Task",
  agent_followup:    "Follow-up",
  blog:              "Blog Post",
  podcast:           "Podcast",
}
// Manager display labels come from the canonical registry (single source of truth) —
// no hand-kept map to drift from MANAGERS.
function managerLabelForKind(kind: string | null): string {
  if (kind && kind in MANAGERS) return MANAGERS[kind as keyof typeof MANAGERS].label
  return kind ?? "Unknown agent"
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—"
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function CommandCenterClient({
  data, scope, scopeLabel, canSwitch = false, scopeOptions = [], currentView = "all",
}: {
  data: CommandCenterData
  scope: "platform" | "brokerage"
  scopeLabel?: string
  canSwitch?: boolean
  scopeOptions?: import("./scope-switcher").ScopeOption[]
  currentView?: string
}) {
  const [actions, setActions] = useState<CommandCenterAction[]>(data.pendingActions)
  const [summary, setSummary] = useState(data.summary)

  // Standup card → jump to that manager's first item in the approval queue below.
  function scrollToManagerQueue(managerKey: string) {
    const el = document.querySelector(`[data-manager="${managerKey}"]`)
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" })
      el.classList.add("ring-2", "ring-blue-400", "rounded-lg")
      setTimeout(() => el.classList.remove("ring-2", "ring-blue-400", "rounded-lg"), 1800)
    }
  }

  function onResolved(actionId: string) {
    setActions((prev) => {
      const next = prev.filter((a) => a.id !== actionId)
      setSummary((s) => ({ ...s, pendingApprovals: next.length }))
      return next
    })
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Agent Command Center</h1>
          <p className="text-sm text-muted-foreground">
            {scopeLabel ?? (scope === "platform" ? "Platform-wide" : "Your brokerage")} — live manager sessions + action approvals
          </p>
          <a href="/dashboard/admin/compliance-ledger" className="mt-1 inline-block text-xs text-cyan-700 underline hover:text-cyan-900">
            ⚖️ Compliance Ledger — every outbound disposition →
          </a>
        </div>
        {scopeLabel && (
          <ScopeSwitcher label={scopeLabel} canSwitch={canSwitch} options={scopeOptions} current={currentView} />
        )}
      </header>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Stat label="Running" value={summary.activeSessions} accent="text-green-700" />
        <Stat label="Idle" value={summary.idleSessions} accent="text-amber-700" />
        <Stat label="Errored" value={summary.erroredSessions} accent="text-red-700" />
        <Stat label="Pending approvals" value={summary.pendingApprovals} accent="text-blue-700" />
        <Stat label="SLA breached" value={summary.breachedApprovals} accent={summary.breachedApprovals > 0 ? "text-red-700" : "text-slate-500"} />
      </div>

      {/* CLIENT & DEAL-PARTY DECISIONS — top of fold BY DESIGN: a seller hit Accept,
          a lender posted conditions, a vendor filed a request. Response speed to a
          client's decision is the most trust-critical latency in the product. */}
      {(data.clientDecisions ?? []).length > 0 && (
        <section className="rounded-lg border-2 border-emerald-300 bg-emerald-50/60 dark:bg-emerald-950/20 p-4 space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold">🤝 Client decisions awaiting you</h2>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {data.decisionVelocity?.medianHours != null && (
                <span className="rounded-full border border-emerald-300 bg-emerald-100/60 dark:bg-emerald-900/30 px-2 py-0.5 font-medium text-emerald-800 dark:text-emerald-200">
                  30-day execute speed: median {data.decisionVelocity.medianHours < 24
                    ? `${data.decisionVelocity.medianHours}h`
                    : `${Math.round((data.decisionVelocity.medianHours / 24) * 10) / 10}d`}
                </span>
              )}
              <span>{data.clientDecisions.length} waiting — oldest first</span>
            </div>
          </div>
          <ul className="space-y-2">
            {data.clientDecisions.slice(0, 8).map((d) => (
              <li key={d.id} className="rounded-md border bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{d.title}</p>
                  <span className="text-xs rounded-full border px-2 py-0.5 text-muted-foreground">
                    {d.source === "client_offer_decision" ? "Offer decision"
                      : d.source === "lender_condition" ? "Lender needs docs"
                      : "Vendor request"}
                  </span>
                </div>
                {d.description && <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{d.description}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                  {d.dueDate && <span className="text-amber-700">Due {new Date(d.dueDate).toLocaleDateString()}</span>}
                  {d.transactionId && (
                    <a className="text-primary underline" href={`/dashboard/transactions/${d.transactionId}`}>Open deal →</a>
                  )}
                  {d.contactId && (
                    <a className="text-primary underline" href={`/crm/contacts/${d.contactId}`}>Open contact →</a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Manager Daily Standup — the morning roll-call: what each Claude manager did in
          the last 24h and what is waiting on a human. The governed-autonomy report. */}
      {data.standup.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold">Manager standup — last 24 hours</h2>
            <div className="flex items-center gap-3">
              <StandupAudioButton />
              <span className="text-xs text-muted-foreground">
                {data.standup.reduce((s, l) => s + l.needs_human, 0)} item{data.standup.reduce((s, l) => s + l.needs_human, 0) === 1 ? "" : "s"} need you
              </span>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {data.standup.map((line) => (
              <Card
                key={line.manager}
                className={"p-4 " + (line.needs_human > 0 ? "border-blue-300 bg-blue-50/40" : "")}
                title={MANAGERS[line.manager]?.domain ?? ""}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <Badge className="bg-slate-900 text-white">{line.label}</Badge>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{line.activity_24h} action{line.activity_24h === 1 ? "" : "s"}/24h</span>
                    {line.reaped_24h > 0 && (
                      <Badge className="bg-amber-600 text-white" title="Stuck items the manager's reaper caught & escalated">
                        🪤 {line.reaped_24h} caught
                      </Badge>
                    )}
                    {line.needs_human > 0 && (
                      <Badge className="bg-blue-600 text-white">{line.needs_human} need you</Badge>
                    )}
                  </div>
                </div>
                <p className="text-sm text-foreground">{line.headline}</p>
                {line.needs_human > 0 && (
                  <button
                    type="button"
                    onClick={() => scrollToManagerQueue(line.manager)}
                    className="mt-2 text-xs font-medium text-blue-700 hover:underline"
                  >
                    Review {line.label}&apos;s {line.needs_human} item{line.needs_human === 1 ? "" : "s"} ↓
                  </button>
                )}
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* AI ISA dial batches awaiting approval — "call my hottest N consented contacts". */}
      {data.dialBatches && data.dialBatches.length > 0 && (
        <section className="space-y-2">
          <a href="/dashboard/admin/voice-dial-batches" className="block">
            <Card className="p-4 border-indigo-300 bg-indigo-50/40 hover:bg-indigo-50 transition-colors">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-indigo-900">
                    AI ISA wants to call {data.dialBatches.reduce((s, b) => s + b.proposedCount, 0)} consented contact{data.dialBatches.reduce((s, b) => s + b.proposedCount, 0) === 1 ? "" : "s"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {data.dialBatches.length} dial batch{data.dialBatches.length === 1 ? "" : "es"} awaiting approval — consent re-checked the moment you approve.
                  </div>
                </div>
                <Badge className="bg-indigo-600 text-white">Review &amp; approve →</Badge>
              </div>
            </Card>
          </a>
        </section>
      )}

      {/* Command your team (text) — routes through the SAME dispatcher the voice admin uses. */}
      <CommandBar />

      {/* Managers talking — the inter-manager bus made visible: who told whom what,
          and what the addressed manager did about it. Registry-driven identity +
          coordination-kind vocabulary (see manager-talk-feed.tsx). */}
      <ManagerTalkFeed talk={data.managerTalk ?? []} />

      {/* What the managers did — the completed-work ledger: the third manager story
          (alongside the pending queue + the talking feed). One chronological,
          manager-attributed timeline composed from the per-manager stores. */}
      <ManagerActivityFeed activity={data.managerActivity ?? []} />

      {/* Unified governed-deliverables rail — every loop's gate proposals in one glance.
          The proof-of-system view: N AI deliverables this week, every one human-approved
          before it shipped. */}
      {data.deliverables && data.deliverables.totals.total > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">Governed deliverables — last 7 days</h2>
            <span className="text-xs text-muted-foreground">across all manager loops</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Card className="p-4"><div className="text-xs text-muted-foreground">AI deliverables</div><div className="text-2xl font-semibold">{data.deliverables.totals.total}</div></Card>
            <Card className="p-4"><div className="text-xs text-muted-foreground">Awaiting you</div><div className="text-2xl font-semibold text-blue-700">{data.deliverables.totals.proposed + data.deliverables.totals.approved}</div></Card>
            <Card className="p-4"><div className="text-xs text-muted-foreground">Sent to clients</div><div className="text-2xl font-semibold text-green-700">{data.deliverables.totals.sent}</div></Card>
            <Card className="p-4"><div className="text-xs text-muted-foreground">Rejected</div><div className="text-2xl font-semibold">{data.deliverables.totals.rejected}</div></Card>
            <Card className={"p-4 " + (data.deliverables.totals.sent === data.deliverables.totals.sentWithApprover ? "border-green-300 bg-green-50/40" : "border-red-300 bg-red-50/40")}>
              <div className="text-xs text-muted-foreground">Sent w/ human approval</div>
              <div className="text-2xl font-semibold">{data.deliverables.totals.sentWithApprover}/{data.deliverables.totals.sent}</div>
            </Card>
          </div>
          {data.deliverables.byLoop.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {data.deliverables.byLoop.map((l) => (
                <Card key={l.loop} className="px-3 py-1.5 flex items-center gap-2">
                  <span className="text-sm">{l.loop}</span>
                  <Badge className="bg-slate-900 text-white">{l.count}</Badge>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}

      {/* THE ROI LEDGER — what the AI team EARNED, live. Every number traces to a
          ledger row (attribution credits, calls, live bookings, sent drafts) — the
          software's numbers, measured, not claimed. Silent when nothing earned. */}
      {data.roiLedger && data.roiLedger.headline && (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">What your AI team earned</h2>
            <span className="text-xs text-muted-foreground">last {data.roiLedger.periodDays} days · from the ledgers</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card className="p-4 border-emerald-300 bg-emerald-50/40">
              <div className="text-xs text-muted-foreground">Attributed closed volume</div>
              <div className="text-2xl font-semibold text-emerald-700">
                ${Math.round(data.roiLedger.attributedGciCents / 100).toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground">{data.roiLedger.attributedDeals} deal{data.roiLedger.attributedDeals === 1 ? "" : "s"} · attribution-weighted</div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-muted-foreground">Calls answered</div>
              <div className="text-2xl font-semibold">{data.roiLedger.callsAnswered}</div>
              <div className="text-xs text-muted-foreground">{data.roiLedger.appointmentsBooked} booked live</div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-muted-foreground">AI drafts sent</div>
              <div className="text-2xl font-semibold">{data.roiLedger.draftsSent}</div>
              <div className="text-xs text-muted-foreground">written by the team, approved by agents</div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-muted-foreground">Opt-outs honored</div>
              <div className="text-2xl font-semibold">{data.roiLedger.optOutsHonored}</div>
              <div className="text-xs text-muted-foreground">compliance is a feature</div>
            </Card>
          </div>
          <p className="text-xs text-muted-foreground">{data.roiLedger.headline}</p>
        </section>
      )}

      {/* Retention board — the Recruiting Manager's daily flight-risk scores made visible.
          People health beside production: who's trending down and why, before they leave. */}
      {data.retentionBoard && data.retentionBoard.scored > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">Agent retention board — flight risk</h2>
            <span className="text-xs text-muted-foreground">
              {data.retentionBoard.scored} scored{data.retentionBoard.asOf ? ` · as of ${data.retentionBoard.asOf}` : ""}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Card className={"p-4 " + (data.retentionBoard.atRisk > 0 ? "border-red-300 bg-red-50/40" : "")}>
              <div className="text-xs text-muted-foreground">At risk</div>
              <div className="text-2xl font-semibold text-red-700">{data.retentionBoard.atRisk}</div>
            </Card>
            <Card className="p-4"><div className="text-xs text-muted-foreground">Watch</div><div className="text-2xl font-semibold text-amber-700">{data.retentionBoard.watch}</div></Card>
            <Card className="p-4"><div className="text-xs text-muted-foreground">Healthy</div><div className="text-2xl font-semibold text-green-700">{data.retentionBoard.healthy}</div></Card>
          </div>
          {/* Save-play effectiveness — did the AI team's retention interventions actually work? */}
          {data.retentionOutcomes && data.retentionOutcomes.total > 0 && (
            <Card className="p-3 flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">Save-play effectiveness ({data.retentionOutcomes.total} intervention{data.retentionOutcomes.total === 1 ? "" : "s"})</span>
              <div className="flex items-center gap-3 text-sm">
                <span className="text-green-700 font-medium">{data.retentionOutcomes.retained} retained</span>
                <span className="text-red-700 font-medium">{data.retentionOutcomes.lost} lost</span>
                <span className="text-muted-foreground">{data.retentionOutcomes.pending} pending</span>
                {data.retentionOutcomes.winRate !== null && (
                  <Badge className="bg-green-700 text-white">{Math.round(data.retentionOutcomes.winRate * 100)}% win rate</Badge>
                )}
              </div>
            </Card>
          )}
          {data.retentionBoard.agents.length > 0 && (
            <div className="space-y-1.5">
              {data.retentionBoard.agents.map((a) => {
                const risky = a.tier === "at_risk" || a.tier === "critical"
                return (
                  <Card key={a.agentId} className={"p-3 flex items-start justify-between gap-3 " + (risky ? "border-red-200" : "")}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{a.name}</span>
                        <Badge className={risky ? "bg-red-600 text-white" : a.tier === "watch" ? "bg-amber-500 text-white" : "bg-slate-900 text-white"}>{a.tier.replace(/_/g, " ")}</Badge>
                        {a.trend && a.trend !== "stable" && (
                          <span className={"text-[11px] font-medium " + (a.trend === "declining" ? "text-red-700" : "text-green-700")}>
                            {a.trend === "declining" ? "▼ declining" : "▲ improving"}
                          </span>
                        )}
                      </div>
                      {a.drivers.length > 0 && <p className="text-xs text-muted-foreground truncate">{a.drivers.join(" · ")}</p>}
                    </div>
                    <span className="text-lg font-semibold shrink-0">{a.score}<span className="text-xs text-muted-foreground">/100</span></span>
                  </Card>
                )
              })}
            </div>
          )}
        </section>
      )}

      {/* Skill-freshness board — the education loop made visible. Team competency at a glance:
          who has a stale skill and in what, so the manager keeps everyone sharp (not just onboarded once). */}
      {data.skillBoard && data.skillBoard.scored > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">Skill freshness — keep the team sharp</h2>
            <span className="text-xs text-muted-foreground">{data.skillBoard.scored} agents</span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Card className={"p-4 " + (data.skillBoard.needRefresh > 0 ? "border-amber-300 bg-amber-50/40" : "")}>
              <div className="text-xs text-muted-foreground">Need a refresher</div>
              <div className="text-2xl font-semibold text-amber-700">{data.skillBoard.needRefresh}</div>
            </Card>
            <Card className="p-4"><div className="text-xs text-muted-foreground">Unproven</div><div className="text-2xl font-semibold text-slate-700">{data.skillBoard.unproven}</div></Card>
            <Card className="p-4"><div className="text-xs text-muted-foreground">Sharp</div><div className="text-2xl font-semibold text-green-700">{data.skillBoard.sharp}</div></Card>
          </div>
          {data.skillBoard.agents.length > 0 && (
            <div className="space-y-1.5">
              {data.skillBoard.agents.map((a) => (
                <Card key={a.agentId} className={"p-3 flex items-center justify-between gap-3 " + (a.worst === "stale" ? "border-amber-200" : "")}>
                  <span className="text-sm font-medium truncate">{a.name}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-muted-foreground truncate max-w-[16rem]">{a.areas.join(" · ")}</span>
                    <Badge className={a.worst === "stale" ? "bg-amber-600 text-white" : a.worst === "untested" ? "bg-slate-500 text-white" : "bg-slate-900 text-white"}>{a.worst === "untested" ? "unproven" : a.worst}</Badge>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Revenue-share board — the agent-to-agent recruiting growth engine. The passive income the
          network pays out + who earns it + how deep their downline runs (the eXp/REAL flywheel). */}
      {data.revenueShareBoard && (data.revenueShareBoard.totalShared > 0 || data.revenueShareBoard.activeRelationships > 0) && (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">Revenue share — the recruiting growth engine</h2>
            <span className="text-xs text-muted-foreground">trailing 12 months</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card className="p-4"><div className="text-xs text-muted-foreground">Shared to sponsors</div><div className="text-2xl font-semibold text-green-700">${Math.round(data.revenueShareBoard.totalShared).toLocaleString()}</div></Card>
            <Card className="p-4"><div className="text-xs text-muted-foreground">Paid</div><div className="text-2xl font-semibold">${Math.round(data.revenueShareBoard.paidShared).toLocaleString()}</div></Card>
            <Card className="p-4"><div className="text-xs text-muted-foreground">Pending</div><div className="text-2xl font-semibold text-amber-700">${Math.round(data.revenueShareBoard.pendingShared).toLocaleString()}</div></Card>
            <Card className="p-4"><div className="text-xs text-muted-foreground">Active sponsorships</div><div className="text-2xl font-semibold">{data.revenueShareBoard.activeRelationships}</div></Card>
          </div>
          {data.revenueShareBoard.earners.length > 0 && (
            <div className="space-y-1.5">
              {data.revenueShareBoard.earners.map((e) => (
                <Card key={e.agentId} className="p-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium truncate">{e.name}</span>
                    {e.downlineSize > 0 && <Badge className="bg-slate-900 text-white">{e.downlineSize} in downline</Badge>}
                  </div>
                  <span className="text-lg font-semibold shrink-0 text-green-700">${Math.round(e.earned).toLocaleString()}</span>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Curriculum board — the OS teaching itself to teach. Courses the AI authored from real,
          recurring knowledge gaps, awaiting a human publish (grounded in evidence, not generic material). */}
      {data.curriculumBoard && data.curriculumBoard.pending > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">AI-authored curriculum — pending review</h2>
            <span className="text-xs text-muted-foreground">{data.curriculumBoard.pending} draft{data.curriculumBoard.pending === 1 ? "" : "s"} from real knowledge gaps</span>
          </div>
          <div className="space-y-1.5">
            {data.curriculumBoard.drafts.map((d) => (
              <Card key={d.id} className="p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium truncate">{d.title}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    {d.category && <Badge className="bg-slate-900 text-white">{d.category.replace(/_/g, " ")}</Badge>}
                    <span className="text-xs text-muted-foreground">{d.lessonCount} lesson{d.lessonCount === 1 ? "" : "s"} · {d.quizCount} quiz</span>
                  </div>
                </div>
                {d.rationale && <p className="text-xs text-muted-foreground mt-1 truncate">{d.rationale}</p>}
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* THE AI EXECUTIVE STANDUP — the weekly ROI-ranked org plan synthesized across every manager,
          with the single human ask up top. The executive layer above the per-manager P&L. */}
      {data.weeklyExecPlan && data.weeklyExecPlan.moves.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h2 className="text-lg font-semibold">🎯 AI Executive Standup — your week, ranked by impact</h2>
            {data.weeklyExecPlan.totalKnownImpactCents > 0 && (
              <span className="text-sm font-semibold text-green-700">
                ~${Math.round(data.weeklyExecPlan.totalKnownImpactCents / 100).toLocaleString()} in play
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{data.weeklyExecPlan.headline}</p>

          {data.weeklyExecPlan.oneAsk && (
            <Card className="p-4 border-l-4 border-l-indigo-500 bg-indigo-50/50">
              <div className="flex items-center gap-2 mb-1">
                <Badge className="bg-indigo-600 text-white">The one ask</Badge>
                <Badge className="bg-slate-900 text-white">{data.weeklyExecPlan.oneAsk.managerLabel}</Badge>
              </div>
              <p className="text-sm font-semibold text-foreground">{data.weeklyExecPlan.oneAsk.title}</p>
              <p className="text-xs text-muted-foreground mt-1">{data.weeklyExecPlan.oneAsk.why}</p>
            </Card>
          )}

          <div className="space-y-2">
            {data.weeklyExecPlan.moves.map((mv) => {
              const band = mv.impactBand === "high" ? "text-red-700 bg-red-50" : mv.impactBand === "medium" ? "text-amber-700 bg-amber-50" : "text-slate-600 bg-slate-50"
              const dollars = mv.estimatedImpactCents ? `$${Math.round(mv.estimatedImpactCents / 100).toLocaleString()}` : mv.impactBand
              return (
                <Card key={`${mv.kind}-${mv.rank}-${mv.entityId ?? mv.manager}`} className="p-3">
                  <div className="flex items-start gap-3">
                    <span className="w-7 h-7 shrink-0 rounded-full bg-slate-900 text-white text-sm font-bold flex items-center justify-center">{mv.rank}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold">{mv.title}</span>
                        <Badge className="bg-slate-100 text-slate-700">{mv.managerLabel}</Badge>
                        {mv.needsHuman && <Badge className="bg-indigo-100 text-indigo-800">needs you</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">{mv.why}</p>
                    </div>
                    <span className={"shrink-0 text-xs font-semibold px-2 py-1 rounded " + band} title={`Impact band: ${mv.impactBand}`}>{dollars}</span>
                  </div>
                </Card>
              )
            })}
          </div>
        </section>
      )}

      {/* Manager Weekly P&L — the outcome layer: what each manager PRODUCED this week
          vs the prior week. Proves the AI workforce moves the business, not just acts. */}
      {data.weeklyPnl.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Manager weekly P&amp;L — production vs last week</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.weeklyPnl.map((card) => (
              <Card key={card.manager} className="p-4" title={MANAGERS[card.manager]?.domain ?? ""}>
                <div className="mb-2">
                  <Badge className="bg-slate-900 text-white">{card.label}</Badge>
                </div>
                <p className="text-sm text-foreground mb-3">{card.headline}</p>
                <div className="space-y-1.5">
                  {card.metrics.map((m) => {
                    const display = m.unit === "currency" ? `$${Math.round(m.value).toLocaleString()}` : String(m.value)
                    const up = m.deltaPct !== null && m.deltaPct > 0
                    const down = m.deltaPct !== null && m.deltaPct < 0
                    return (
                      <div key={m.label} className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">{m.label}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold">{display}</span>
                          {m.deltaPct === null ? (
                            <span className="text-[11px] text-muted-foreground" title="No prior-week baseline">new</span>
                          ) : (
                            <span
                              className={
                                "text-[11px] font-medium " +
                                (up ? "text-green-700" : down ? "text-red-700" : "text-muted-foreground")
                              }
                              title={`Prior week: ${m.unit === "currency" ? "$" + Math.round(m.prior).toLocaleString() : m.prior}`}
                            >
                              {up ? "▲" : down ? "▼" : "—"} {Math.abs(m.deltaPct)}%
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Managers on duty — every pending activity is owned by an accountable manager */}
      {data.managerBreakdown.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Managers on duty</h2>
          <div className="flex flex-wrap gap-2">
            {data.managerBreakdown.map((m) => (
              <Card key={m.key} className="px-3 py-2 flex items-center gap-2" title={MANAGERS[m.key]?.domain ?? ""}>
                <Badge className="bg-slate-900 text-white">{m.label}</Badge>
                <span className="text-sm font-semibold">{m.count}</span>
                <span className="text-xs text-muted-foreground">pending</span>
                {m.breached > 0 && <Badge className="bg-red-100 text-red-800">{m.breached} breached</Badge>}
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Approval queue */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Approval queue</h2>
        {actions.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">No actions awaiting approval.</Card>
        ) : (
          actions.map((a) => (
            <div key={a.id} data-manager={a.managerKey}>
              <ActionRow action={a} onResolved={onResolved} />
            </div>
          ))
        )}
      </section>

      {/* Sessions */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Manager sessions</h2>
        {data.sessions.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">No managed-agent sessions yet.</Card>
        ) : (
          <div className="space-y-2">{data.sessions.map((s) => <SessionRow key={s.id} session={s} />)}</div>
        )}
      </section>
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <Card className="p-4">
      <div className={`text-3xl font-bold ${accent}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground mt-1">{label}</div>
    </Card>
  )
}

function SessionRow({ session }: { session: CommandCenterSession }) {
  return (
    <Card className="p-4 flex items-center justify-between">
      <div>
        <div className="font-medium">{managerLabelForKind(session.agentKind)}</div>
        <div className="text-xs text-muted-foreground">
          {session.entityType} · {session.entityId.slice(0, 8)}… · last event {timeAgo(session.lastEventAt)}
        </div>
      </div>
      <Badge className={SESSION_BADGE[session.status] ?? "bg-slate-100 text-slate-700"}>{session.status}</Badge>
    </Card>
  )
}

/**
 * Gate-2 preview: the ACTUAL finished product the human is releasing — the
 * rendered section videos + the announcement email — so "Approve" means
 * "release this real thing", not "approve an intent".
 */
function DeliveryPreview({ input }: { input: Record<string, unknown> }) {
  const [showEmail, setShowEmail] = useState(false)
  const videos = Array.isArray(input.video_renders) ? (input.video_renders as Array<{ section_key: string; title: string; output_url: string; thumbnail_url: string | null }>) : []
  const email = (input.email ?? {}) as { subject?: string; preview_text?: string; preview_html?: string }
  const appt = input.appointment_at as string | null

  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Review before releasing to the seller</div>

      {videos.length > 0 && (
        <div>
          <div className="text-xs font-medium mb-1">{videos.length} finished video{videos.length === 1 ? "" : "s"}</div>
          <div className="flex flex-wrap gap-2">
            {videos.map((v) => (
              <a key={v.section_key} href={v.output_url} target="_blank" rel="noreferrer"
                 className="block w-32 rounded border overflow-hidden hover:ring-2 hover:ring-amber-400">
                {v.thumbnail_url
                  ? <img src={v.thumbnail_url} alt={v.title} className="w-full h-20 object-cover" />
                  : <div className="w-full h-20 bg-slate-200 flex items-center justify-center text-xs text-slate-500">▶ video</div>}
                <div className="px-1.5 py-1 text-[11px] truncate">{v.title}</div>
              </a>
            ))}
          </div>
        </div>
      )}

      {email.subject && (
        <div>
          <div className="text-xs font-medium">Announcement email</div>
          <div className="text-sm">{email.subject}</div>
          {email.preview_text && <div className="text-xs text-muted-foreground">{email.preview_text}</div>}
          {email.preview_html && (
            <>
              <button type="button" onClick={() => setShowEmail((s) => !s)}
                      className="text-xs text-blue-600 hover:underline mt-1">
                {showEmail ? "Hide email preview" : "Preview email"}
              </button>
              {showEmail && (
                <iframe title="email preview" sandbox="" srcDoc={email.preview_html}
                        className="mt-2 w-full h-56 rounded border bg-white" />
              )}
            </>
          )}
        </div>
      )}

      {appt && <div className="text-[11px] text-muted-foreground">Seller appointment: {new Date(appt).toLocaleString()}</div>}
    </div>
  )
}

/**
 * Social preview: the ACTUAL creative + caption that will post to a public feed.
 * Approving here is "publish this to the public", so the operator sees the media
 * and copy, not just an action name.
 */
function SocialPreview({ input }: { input: Record<string, unknown> }) {
  const content = (input.content as string | null) ?? ""
  const media = Array.isArray(input.media_urls) ? (input.media_urls as string[]) : []
  const hashtags = Array.isArray(input.hashtags) ? (input.hashtags as string[]) : []
  const platform = String(input.platform ?? "social")
  const scheduledFor = input.scheduled_for as string | null
  const isVideo = (u: string) => /\.(mp4|mov|webm)(\?|$)/i.test(u)

  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>Review before posting publicly</span>
        <Badge className="bg-sky-100 text-sky-800">{platform === "all" ? "every connected platform" : platform}</Badge>
      </div>
      {media.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {media.map((u, i) => (
            isVideo(u)
              ? <video key={i} src={u} controls className="w-40 h-24 rounded border object-cover bg-black" />
              : <a key={i} href={u} target="_blank" rel="noreferrer"><img src={u} alt="" className="w-40 h-24 rounded border object-cover" /></a>
          ))}
        </div>
      )}
      {content && <p className="text-sm whitespace-pre-wrap">{content}</p>}
      {hashtags.length > 0 && <p className="text-xs text-sky-700">{hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}</p>}
      {scheduledFor && <div className="text-[11px] text-muted-foreground">Scheduled to post: {new Date(scheduledFor).toLocaleString()}</div>}
    </div>
  )
}

/** Newsletter preview: the subject + body the operator is releasing to subscribers. */
function NewsletterPreview({ input }: { input: Record<string, unknown> }) {
  const subject = (input.subject_line as string | null) ?? ""
  const body = (input.content_preview as string | null) ?? ""
  const sendDate = input.send_date as string | null
  const ai = !!input.is_ai_generated
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-1">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>Review before emailing subscribers</span>
        {ai && <Badge className="bg-emerald-100 text-emerald-800">AI-drafted</Badge>}
      </div>
      {subject && <div className="text-sm font-medium">Subject: {subject}</div>}
      {body && <p className="text-sm whitespace-pre-wrap max-h-48 overflow-auto">{body}</p>}
      {sendDate && <div className="text-[11px] text-muted-foreground">Scheduled to send: {new Date(sendDate).toLocaleString()}</div>}
    </div>
  )
}

/** Direct-mail preview: the rendered design + copy for the whole campaign (one approval per campaign). */
function DirectMailPreview({ input }: { input: Record<string, unknown> }) {
  const design = (input.design_url as string | null) ?? null
  const copy = (input.copy_text as string | null) ?? ""
  const pieceType = (input.piece_type as string | null) ?? "mail"
  const quantity = input.quantity as number | null
  const audience = (input.target_audience as string | null) ?? null
  const mailingDate = input.mailing_date as string | null
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>Review before it prints + mails</span>
        <Badge className="bg-amber-100 text-amber-900">{pieceType}{quantity ? ` · ${quantity} pieces` : ""}</Badge>
      </div>
      {design && <a href={design} target="_blank" rel="noreferrer"><img src={design} alt="mail design" className="w-56 rounded border" /></a>}
      {copy && <p className="text-sm whitespace-pre-wrap">{copy}</p>}
      {audience && <div className="text-[11px] text-muted-foreground">Audience: {audience}</div>}
      {mailingDate && <div className="text-[11px] text-muted-foreground">Mailing date: {new Date(mailingDate).toLocaleString()}</div>}
    </div>
  )
}

/** Ads Manager action: the spend move the operator is authorizing (launch/pause/budget). */
function AdActionPreview({ input, actionType }: { input: Record<string, unknown>; actionType: string }) {
  const newBudget = input.new_daily_budget as number | null
  const label: Record<string, string> = {
    launch_ad_campaign: "Launch campaign", pause_ad_campaign: "Pause campaign",
    shift_ad_budget: "Shift daily budget", scale_ad_creative: "Scale winning campaign",
  }
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-1">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>Authorize this ad-spend action</span>
        <Badge className="bg-rose-100 text-rose-800">{label[actionType] ?? actionType}</Badge>
      </div>
      {newBudget != null && <div className="text-sm font-medium">New daily budget: ${newBudget}/day</div>}
      <div className="text-[11px] text-muted-foreground">Spend moves only on your approval, and the server caps it.</div>
    </div>
  )
}

/** Ad creative: the headline/copy/CTA that will run as a paid ad. */
function AdCreativePreview({ input }: { input: Record<string, unknown> }) {
  const headline = (input.headline as string | null) ?? ""
  const primary = (input.primary_text as string | null) ?? ""
  const cta = (input.call_to_action as string | null) ?? ""
  const media = (input.media_asset_url as string | null) ?? null
  const dest = (input.destination_url as string | null) ?? null
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Review before it runs as a paid ad</div>
      {media && <a href={media} target="_blank" rel="noreferrer"><img src={media} alt="ad creative" className="w-56 rounded border" /></a>}
      {headline && <div className="text-sm font-semibold">{headline}</div>}
      {primary && <p className="text-sm whitespace-pre-wrap">{primary}</p>}
      <div className="flex items-center gap-2 text-xs">
        {cta && <Badge className="bg-pink-100 text-pink-800">{cta}</Badge>}
        {dest && <a href={dest} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline truncate max-w-xs">{dest}</a>}
      </div>
    </div>
  )
}

/** Predicted-seller auto-touch: the outreach to a likely-to-list homeowner. */
function PredictiveTouchPreview({ input }: { input: Record<string, unknown> }) {
  const subject = input.subject as string | null, body = input.body as string | null
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-1">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>Review before it reaches the homeowner</span>
        <Badge className="bg-teal-100 text-teal-800">{String(input.channel ?? "outreach")} · PLS {String(input.pls_score ?? "?")}</Badge>
      </div>
      {!!subject && <div className="text-sm font-medium">{subject}</div>}
      {!!body ? <p className="text-sm whitespace-pre-wrap">{body}</p> : <p className="text-xs text-muted-foreground italic">Message is AI-drafted at send time; approving queues it (compliance-checked before it goes out).</p>}
    </div>
  )
}
/** Deal at-risk task: an item the agent must resolve to keep the transaction on track. */
function TransactionTaskPreview({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-1">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>At-risk on a transaction</span>
        {!!input.severity && <Badge className="bg-red-100 text-red-800">{String(input.severity)}</Badge>}
      </div>
      {!!input.headline && <div className="text-sm font-medium">{String(input.headline)}</div>}
      {!!input.detail && <p className="text-sm whitespace-pre-wrap">{String(input.detail)}</p>}
      <div className="text-[11px] text-muted-foreground">
        {!!input.suggested_recipient && <>Recipient: {String(input.suggested_recipient)} · </>}
        {!!input.due_date && <>Due {new Date(String(input.due_date)).toLocaleDateString()}</>}
      </div>
    </div>
  )
}

/** Autopilot follow-up: a scheduled reminder (e.g. open-house check-in) the agent does or skips. */
function FollowupPreview({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-1">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>Scheduled follow-up</span>
        {!!input.priority && <Badge className="bg-cyan-100 text-cyan-800">{String(input.priority)}</Badge>}
      </div>
      {!!input.title && <div className="text-sm font-medium">{String(input.title)}</div>}
      {!!input.description && <p className="text-sm whitespace-pre-wrap">{String(input.description)}</p>}
      {!!input.scheduled_for && <div className="text-[11px] text-muted-foreground">Due {new Date(String(input.scheduled_for)).toLocaleString()}</div>}
    </div>
  )
}

function SmartTaskPreview({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-1">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>Open deal to-do</span>
        {!!input.priority && <Badge className="bg-red-50 text-red-700">{String(input.priority)}</Badge>}
        {!!input.ai_generated && <Badge className="bg-purple-100 text-purple-800">AI-suggested</Badge>}
      </div>
      {!!input.title && <div className="text-sm font-medium">{String(input.title)}</div>}
      {!!input.description && <p className="text-sm whitespace-pre-wrap">{String(input.description)}</p>}
      <div className="text-[11px] text-muted-foreground">
        {!!input.category && <>{String(input.category)} · </>}
        {!!input.assigned_to && <>Assigned: {String(input.assigned_to)} · </>}
        {!!input.due_date && <>Due {new Date(String(input.due_date)).toLocaleDateString()}</>}
      </div>
    </div>
  )
}

/** Blog post: the SEO article copy reviewed before it publishes to the site. */
function BlogPreview({ input }: { input: Record<string, unknown> }) {
  const img = (input.featured_image_url as string | null) ?? null
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Review before it publishes to your site</div>
      {img && <a href={img} target="_blank" rel="noreferrer"><img src={img} alt="" className="w-56 rounded border" /></a>}
      {!!input.title && <div className="text-sm font-semibold">{String(input.title)}</div>}
      {!!input.excerpt && <p className="text-sm italic text-muted-foreground">{String(input.excerpt)}</p>}
      {!!input.content_preview && <p className="text-sm whitespace-pre-wrap max-h-48 overflow-auto">{String(input.content_preview)}</p>}
    </div>
  )
}
/** Podcast episode: generated audio reviewed before it distributes to Spotify/Apple/etc. */
function PodcastPreview({ input }: { input: Record<string, unknown> }) {
  const audio = (input.audio_url as string | null) ?? null
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Review before it distributes to Spotify / Apple / etc.</div>
      {!!input.title && <div className="text-sm font-semibold">{String(input.title)}</div>}
      {!!input.description && <p className="text-sm whitespace-pre-wrap">{String(input.description)}</p>}
      {audio && <audio src={audio} controls className="w-full" />}
    </div>
  )
}

function ActionRow({ action, onResolved }: { action: CommandCenterAction; onResolved: (id: string) => void }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const isClientMsg = action.queue === "client_message"
  const [editedBody, setEditedBody] = useState<string>(isClientMsg ? String(action.actionInput.body ?? "") : "")

  function run(kind: "approve" | "reject") {
    setError(null)
    startTransition(async () => {
      const res = kind === "approve"
        ? await approveAgentAction({ queue: action.queue, actionId: action.id, ...(isClientMsg ? { editedBody } : {}) })
        : await rejectAgentAction({ queue: action.queue, actionId: action.id })
      if (res.ok) onResolved(action.id)
      else setError(res.error ?? "Action failed")
    })
  }

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className="bg-slate-900 text-white" title="The Claude manager accountable for this activity">
              {action.managerLabel}
            </Badge>
            <Badge className={QUEUE_BADGE[action.queue] ?? "bg-slate-100 text-slate-700"}>
              {QUEUE_LABEL[action.queue] ?? action.queue}
            </Badge>
            <span className="font-medium">{action.actionType.replace(/_/g, " ")}</span>
            {action.slaLevel === "breached" && (
              <Badge className="bg-red-100 text-red-800">SLA breached · {Math.round(action.ageHours)}h</Badge>
            )}
            {action.slaLevel === "due" && (
              <Badge className="bg-amber-100 text-amber-800">SLA due · {Math.round(action.ageHours)}h</Badge>
            )}
            {action.compliance && (
              <Badge
                className={
                  action.compliance.status === "blocked" ? "bg-red-100 text-red-800"
                  : action.compliance.status === "advisory" ? "bg-amber-100 text-amber-800"
                  : "bg-green-100 text-green-800"
                }
                title={action.compliance.findings.join(" • ") || "Consent verified, no Fair Housing language"}
              >
                ⚖️ Compliance Officer: {action.compliance.status === "blocked" ? "Blocked" : action.compliance.status === "advisory" ? "Advisory" : "Cleared"}
              </Badge>
            )}
          </div>
          {action.rationale && <p className="text-sm text-muted-foreground mt-1">{action.rationale}</p>}
          {action.compliance && action.compliance.findings.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {action.compliance.findings.map((f, i) => (
                <li key={i} className={`text-xs ${action.compliance!.status === "blocked" ? "text-red-700" : "text-amber-700"}`}>⚖️ {f}</li>
              ))}
            </ul>
          )}
          {action.actionType === "approve_prelisting_delivery" && <DeliveryPreview input={action.actionInput} />}
          {action.queue === "social" && <SocialPreview input={action.actionInput} />}
          {action.queue === "newsletter" && <NewsletterPreview input={action.actionInput} />}
          {action.queue === "direct_mail" && <DirectMailPreview input={action.actionInput} />}
          {action.queue === "ads" && <AdActionPreview input={action.actionInput} actionType={action.actionType} />}
          {action.queue === "ad_creative" && <AdCreativePreview input={action.actionInput} />}
          {action.queue === "predictive_listing" && <PredictiveTouchPreview input={action.actionInput} />}
          {action.queue === "transaction_task" && <TransactionTaskPreview input={action.actionInput} />}
          {action.queue === "transaction_smart_task" && <SmartTaskPreview input={action.actionInput} />}
          {action.queue === "agent_followup" && <FollowupPreview input={action.actionInput} />}
          {action.queue === "blog" && <BlogPreview input={action.actionInput} />}
          {action.queue === "podcast" && <PodcastPreview input={action.actionInput} />}
          {isClientMsg && (
            <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <span>Review/edit before it reaches the {String(action.actionInput.audience ?? "client")}</span>
                <Badge className="bg-indigo-100 text-indigo-800">{String(action.actionInput.audience ?? "client")}</Badge>
                <Badge className="bg-slate-100 text-slate-700">via {String(action.actionInput.channel ?? "portal").replace("_", " ")}</Badge>
              </div>
              {!!action.actionInput.subject && <div className="text-sm font-medium">{String(action.actionInput.subject)}</div>}
              <textarea className="w-full text-sm rounded border p-2 min-h-[120px] bg-white" value={editedBody} onChange={(e) => setEditedBody(e.target.value)} />
              {!!action.actionInput.briefing && <div className="text-[11px] text-muted-foreground">Agent note: {String(action.actionInput.briefing)}</div>}
            </div>
          )}
          <div className="text-xs text-muted-foreground mt-1">proposed {timeAgo(action.proposedAt)}</div>
          {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
        </div>
        <div className="flex gap-2 shrink-0">
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run("reject")}>{action.queue === "transaction_task" ? "Dismiss" : action.queue === "transaction_smart_task" ? "Cancel" : action.queue === "agent_followup" ? "Skip" : "Reject"}</Button>
          <Button size="sm" disabled={pending || action.compliance?.status === "blocked"} title={action.compliance?.status === "blocked" ? "Compliance Officer blocked this — the recipient withdrew or revoked this channel" : undefined} onClick={() => run("approve")}>{pending ? "…" : action.compliance?.status === "blocked" ? "Blocked" : action.actionType === "approve_prelisting_delivery" ? "Release" : isClientMsg ? "Approve & Send" : action.queue === "transaction_task" ? "Resolve" : action.queue === "transaction_smart_task" ? "Done" : action.queue === "agent_followup" ? "Done" : action.queue === "predictive_listing" ? "Approve & Queue" : action.queue === "blog" ? "Approve & Publish" : action.queue === "podcast" ? "Approve & Distribute" : "Approve"}</Button>
        </div>
      </div>
    </Card>
  )
}

// "Hear the standup" — the broker plays their AI team's daily standup, read aloud in
// their cloned/chosen voice (ElevenLabs). Falls back to showing the text brief when
// TTS is unavailable. The "talk to your brokerage" differentiator, audio half.
function StandupAudioButton() {
  const [loading, setLoading] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function play() {
    setErr(null)
    setLoading(true)
    try {
      const res = await generateStandupAudio()
      if (!res.success) { setErr(res.error ?? "Could not generate the standup."); return }
      setText(res.text ?? null)
      if (res.audioDataUrl) setAudioUrl(res.audioDataUrl)
      else setErr(res.error ?? "Audio unavailable — showing the brief.")
    } catch {
      setErr("Could not generate the standup.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" disabled={loading} onClick={play} title="Hear your AI team's standup read aloud">
        {loading ? "…" : "▶ Hear the standup"}
      </Button>
      {audioUrl && <audio src={audioUrl} controls autoPlay className="h-8" />}
      {text && <p className="max-w-md text-right text-[11px] text-muted-foreground">{text}</p>}
      {err && <p className="text-[11px] text-destructive">{err}</p>}
    </div>
  )
}
