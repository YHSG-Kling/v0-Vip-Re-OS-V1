"use client"

import { useState, useTransition } from "react"
import Link                         from "next/link"
import { dismissFatigueAlert }      from "@/app/actions/buyer-fatigue"

type RiskLevel = "fresh" | "watch" | "warning" | "critical"

interface BuyerRow {
  contact_id:           string
  fatigue_score:        number
  risk_level:           string
  total_showings:       number
  total_tour_days:      number
  days_searching:       number
  offers_rejected:      number
  engagement_trend:     string | null
  last_calculated_at:   string | null
  contacts: {
    id:          string
    first_name:  string
    last_name:   string
    email:       string | null
    buyer_stage: string | null
    agent_id:    string | null
  } | null
}

interface AlertRow {
  id:                       string
  contact_id:               string
  alert_type:               string | null
  fatigue_score_at_trigger: number | null
  risk_level:               string | null
  message:                  string | null
  created_at:               string | null
  contacts: {
    id:          string
    first_name:  string
    last_name:   string
    buyer_stage: string | null
  } | null
}

interface Props {
  buyers:      BuyerRow[]
  alerts:      AlertRow[]
  brokerageId: string
}

const RISK_META: Record<string, { label: string; bar: string; badge: string }> = {
  watch:    { label: "Watch",    bar: "bg-amber-400",  badge: "bg-amber-100 text-amber-800" },
  warning:  { label: "Warning",  bar: "bg-orange-500", badge: "bg-orange-100 text-orange-800" },
  critical: { label: "Critical", bar: "bg-red-600",    badge: "bg-red-100 text-red-800" },
  fresh:    { label: "Fresh",    bar: "bg-emerald-500",badge: "bg-emerald-100 text-emerald-800" },
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—"
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3600_000)
  if (h < 1)  return "just now"
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function RecoveryPlan({ message }: { message: string | null }) {
  if (!message) return null
  try {
    const parsed = JSON.parse(message)
    const r = parsed?.recovery
    if (!r) return null
    return (
      <div className="mt-2 pl-3 border-l-2 border-orange-300 space-y-1">
        {r.pause_days > 0 && (
          <p className="text-xs text-orange-900">
            Suggest <strong>{r.pause_days}-day</strong> search pause.
          </p>
        )}
        {r.re_engagement_message && (
          <p className="text-xs text-orange-800 italic">"{r.re_engagement_message}"</p>
        )}
        {r.search_reset_suggestion && (
          <p className="text-xs text-orange-900">Reset: {r.search_reset_suggestion}</p>
        )}
      </div>
    )
  } catch {
    return <p className="text-xs text-muted-foreground mt-1">{message}</p>
  }
}

export function BrokerageFatigueDashboard({ buyers, alerts, brokerageId }: Props) {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())
  const [isPending, startTransition]    = useTransition()
  const [filter, setFilter]             = useState<string>("all")

  const activeAlerts  = alerts.filter(a => !dismissedIds.has(a.id))
  const filteredBuyers = filter === "all"
    ? buyers
    : buyers.filter(b => b.risk_level === filter)

  function handleDismiss(alertId: string) {
    startTransition(async () => {
      await dismissFatigueAlert(alertId)
      setDismissedIds(prev => new Set([...prev, alertId]))
    })
  }

  return (
    <div className="space-y-8">

      {/* Summary strip */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Total Monitored", value: buyers.length, color: "text-foreground" },
          { label: "Watch",    value: buyers.filter(b => b.risk_level === "watch").length,    color: "text-amber-700" },
          { label: "Warning",  value: buyers.filter(b => b.risk_level === "warning").length,  color: "text-orange-700" },
          { label: "Critical", value: buyers.filter(b => b.risk_level === "critical").length, color: "text-red-700" },
        ].map(stat => (
          <div key={stat.label} className="rounded-lg border border-border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">{stat.label}</p>
            <p className={`text-2xl font-bold tabular-nums mt-0.5 ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Active alerts */}
      {activeAlerts.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-foreground mb-3">
            Active Alerts ({activeAlerts.length})
          </h2>
          <div className="space-y-3">
            {activeAlerts.map(alert => {
              const name = alert.contacts
                ? `${alert.contacts.first_name} ${alert.contacts.last_name}`
                : "Unknown buyer"
              const contactId = alert.contacts?.id ?? alert.contact_id
              const meta = RISK_META[alert.risk_level ?? "watch"] ?? RISK_META.watch
              return (
                <div
                  key={alert.id}
                  className="rounded-lg border border-orange-200 bg-orange-50 p-4 flex gap-4"
                >
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        href={`/contacts/${contactId}`}
                        className="text-sm font-semibold text-foreground hover:underline"
                      >
                        {name}
                      </Link>
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${meta.badge}`}>
                        {meta.label}
                      </span>
                      {alert.fatigue_score_at_trigger != null && (
                        <span className="text-xs text-muted-foreground">
                          Score: {alert.fatigue_score_at_trigger}/100
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {timeAgo(alert.created_at)}
                      </span>
                    </div>
                    <RecoveryPlan message={alert.message} />
                  </div>
                  <button
                    onClick={() => handleDismiss(alert.id)}
                    disabled={isPending}
                    className="shrink-0 self-start text-xs text-orange-600 hover:text-orange-900 font-medium"
                  >
                    Dismiss
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Buyer fatigue table */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground">All At-Risk Buyers</h2>
          <div className="flex items-center gap-2">
            {["all", "watch", "warning", "critical"].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 rounded-md text-xs font-medium capitalize transition-colors ${
                  filter === f
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {filteredBuyers.length === 0 ? (
          <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">No buyers in this risk category.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40">
                <tr>
                  {["Buyer", "Score", "Risk", "Showings", "Tour Days", "Rejected", "Engagement", "Updated"].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredBuyers.map(buyer => {
                  const c    = buyer.contacts
                  const name = c ? `${c.first_name} ${c.last_name}` : "—"
                  const id   = c?.id ?? buyer.contact_id
                  const meta = RISK_META[buyer.risk_level] ?? RISK_META.watch
                  return (
                    <tr key={buyer.contact_id} className="hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-3">
                        <Link
                          href={`/contacts/${id}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {name}
                        </Link>
                        {c?.buyer_stage && (
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {c.buyer_stage.replace(/_/g, " ").toLowerCase()}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${meta.bar}`}
                              style={{ width: `${buyer.fatigue_score}%` }}
                            />
                          </div>
                          <span className="tabular-nums font-semibold">{buyer.fatigue_score}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${meta.badge}`}>
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 tabular-nums">{buyer.total_showings}</td>
                      <td className="px-4 py-3 tabular-nums">{buyer.total_tour_days}</td>
                      <td className="px-4 py-3 tabular-nums">{buyer.offers_rejected}</td>
                      <td className="px-4 py-3 capitalize text-muted-foreground text-xs">
                        {buyer.engagement_trend ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {timeAgo(buyer.last_calculated_at)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
