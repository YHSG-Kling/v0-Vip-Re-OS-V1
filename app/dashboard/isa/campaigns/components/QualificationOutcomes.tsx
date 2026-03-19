"use client"

import { useState } from "react"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"
import type { QualificationOutcome, QualificationStats } from "@/app/actions/ai-isa"

const RESULT_BADGE: Record<string, string> = {
  qualified:       "bg-green-100 text-green-800",
  not_qualified:   "bg-red-100 text-red-800",
  appointment_set: "bg-blue-100 text-blue-800",
  no_response:     "bg-gray-100 text-gray-700",
  needs_follow_up: "bg-yellow-100 text-yellow-800",
}

interface Props {
  outcomes:  QualificationOutcome[]
  stats:     QualificationStats
  chartData: { result: string; count: number }[]
}

export function QualificationOutcomes({ outcomes, stats, chartData }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const statCards = [
    { label: "Qualified",        value: stats.qualified,        color: "text-green-600" },
    { label: "Not Qualified",    value: stats.not_qualified,    color: "text-red-600"   },
    { label: "Appointment Set",  value: stats.appointment_set,  color: "text-blue-600"  },
    { label: "No Response",      value: stats.no_response,      color: "text-gray-600"  },
    { label: "Needs Follow-Up",  value: stats.needs_follow_up,  color: "text-yellow-600"},
  ]

  return (
    <div className="flex flex-col gap-6">
      {/* Stats row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {statCards.map(s => (
          <div key={s.label} className="rounded-lg border border-border bg-card p-3 text-center">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Bar chart */}
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="mb-3 text-sm font-medium text-foreground">Results (last 30 days)</p>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} margin={{ top: 0, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="result"
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              tickFormatter={v => v.replace(/_/g," ")}
            />
            <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
            <Tooltip
              contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12 }}
              formatter={(v) => [v, "Count"]}
              labelFormatter={l => String(l).replace(/_/g," ")}
            />
            <Bar dataKey="count" fill="hsl(var(--primary))" radius={[3,3,0,0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">Contact</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">Score</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">Result</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">Signals</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">Agent</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">Assigned</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {outcomes.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  No qualification outcomes in the last 30 days.
                </td>
              </tr>
            ) : outcomes.map(row => {
              const name = [row.contact_first_name, row.contact_last_name].filter(Boolean).join(" ") || "Unknown"
              const isExpanded = expanded.has(row.id)
              const signals = Array.isArray(row.qualification_signals) ? row.qualification_signals : []
              return (
                <>
                  <tr key={row.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 font-medium text-foreground">
                      <a href={`/contacts/${row.contact_id}`} className="hover:underline">
                        {name}
                      </a>
                    </td>
                    <td className="px-4 py-3">
                      {row.score != null ? (
                        <div className="flex items-center gap-2 min-w-[80px]">
                          <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-primary"
                              style={{ width: `${row.score}%` }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground w-8 text-right">{row.score}</span>
                        </div>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RESULT_BADGE[row.qualification_result] ?? "bg-gray-100 text-gray-700"}`}>
                        {row.qualification_result.replace(/_/g," ")}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {signals.length > 0 ? (
                        <button
                          onClick={() => toggleExpand(row.id)}
                          className="text-xs text-primary hover:underline"
                        >
                          {isExpanded ? "Hide" : `${signals.length} signal${signals.length !== 1 ? "s" : ""}`}
                        </button>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{row.assigned_agent_name ?? "—"}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {row.assigned_at ? new Date(row.assigned_at).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                  {isExpanded && signals.length > 0 && (
                    <tr key={`${row.id}-signals`} className="bg-muted/20">
                      <td colSpan={6} className="px-4 py-2">
                        <div className="flex flex-wrap gap-1.5">
                          {signals.map((s, i) => (
                            <span key={i} className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                              {typeof s === "string" ? s : JSON.stringify(s)}
                            </span>
                          ))}
                        </div>
                        {row.notes && (
                          <p className="mt-1.5 text-xs text-muted-foreground italic">{row.notes}</p>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
