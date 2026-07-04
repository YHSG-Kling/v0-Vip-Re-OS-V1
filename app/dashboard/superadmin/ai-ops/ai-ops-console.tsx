"use client"

// AI OPERATIONS — the cross-tenant view of the autonomous layer: manager throughput, dead-letter (stuck)
// signals with replay, held + failed actions, automation errors with resolve, and failing/stale crons.
import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { replaySignalAction, resolveAutomationErrorAction } from "@/app/actions/superadmin/ai-ops"
import type { AiOps } from "@/lib/platform/ai-ops"

function Tile({ label, value, tone }: { label: string; value: number; tone?: "bad" | "warn" | "ok" }) {
  const color = tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : "text-slate-900"
  return (
    <div className="rounded-lg border p-3">
      <div className={"text-2xl font-bold tabular-nums " + color}>{value}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}

export function AiOpsConsole({ data }: { data: AiOps }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [err, setErr] = useState<string | null>(null)

  function replay(id: string) {
    setErr(null)
    start(async () => { const r = await replaySignalAction(id); if (!r.ok) setErr(r.error ?? "Failed"); router.refresh() })
  }
  function resolve(id: string) {
    setErr(null)
    start(async () => { const r = await resolveAutomationErrorAction(id); if (!r.ok) setErr(r.error ?? "Failed"); router.refresh() })
  }

  const s = data.summary
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">AI Operations — every tenant</h1>
          <p className="text-muted-foreground text-sm mt-1">The autonomous layer platform-wide, last {data.windowHours}h.</p>
        </div>
        <Link href="/dashboard/superadmin/platform" className="rounded-md border px-3 py-1 text-sm">Platform</Link>
      </div>

      <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
        <Tile label="actions consumed" value={s.consumed} tone="ok" />
        <Tile label="dead-letter (stuck)" value={s.stuck} tone={s.stuck ? "bad" : "ok"} />
        <Tile label="held at gate" value={s.held} tone={s.held ? "warn" : "ok"} />
        <Tile label="failed sends" value={s.failed} tone={s.failed ? "bad" : "ok"} />
        <Tile label="automation errors" value={s.errors} tone={s.errors ? "bad" : "ok"} />
        <Tile label="crons failing" value={s.cronsFailing} tone={s.cronsFailing ? "bad" : "ok"} />
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}

      {/* Manager throughput */}
      {data.throughput.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Manager throughput (platform-wide)</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {data.throughput.map((m) => (
              <div key={m.manager} className="rounded-lg border p-3">
                <p className="text-sm font-medium truncate">{m.manager}</p>
                <p className="text-xs text-muted-foreground">{m.consumed} acted · {m.published} sent</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Dead-letter / stuck signals — replay */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Dead-letter signals ({data.stuckSignals.length})</h2>
        {data.stuckSignals.length === 0 ? <p className="text-sm text-muted-foreground">No stuck handoffs — the bus is flowing. 🎉</p> : (
          <div className="space-y-2">
            {data.stuckSignals.map((sig) => (
              <div key={sig.id} className="flex items-center gap-3 rounded-lg border p-3">
                <span className="shrink-0 rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">{sig.ageHours}h stuck</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{sig.fromManager} → {sig.toManager}</p>
                  <p className="text-xs text-muted-foreground truncate">{sig.signalType}{sig.brokerageId ? ` · ${sig.brokerageId.slice(0, 8)}` : ""}</p>
                </div>
                <button onClick={() => replay(sig.id)} disabled={pending} className="shrink-0 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Replay</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Held actions */}
      {data.heldActions.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Held at the gate ({s.held})</h2>
          <div className="space-y-1">
            {data.heldActions.slice(0, 20).map((h, i) => (
              <div key={i} className="flex items-center gap-3 text-sm">
                <span className={"shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium " + (h.oldestHours >= 72 ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600")}>{h.oldestHours}h</span>
                <span className="flex-1 truncate">{h.managerKind}{h.brokerageId ? ` · ${h.brokerageId.slice(0, 8)}` : ""}</span>
                <span className="text-xs text-muted-foreground">{h.count} awaiting approval</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Automation errors — resolve */}
      {data.automationErrors.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Automation errors ({data.automationErrors.length})</h2>
          <div className="space-y-2">
            {data.automationErrors.slice(0, 30).map((e) => (
              <div key={e.id} className="flex items-center gap-3 rounded-lg border p-3">
                <span className={"shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium " + (e.severity === "high" || e.severity === "critical" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800")}>{e.severity}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{e.workflow}</p>
                  <p className="text-xs text-muted-foreground truncate">{e.error}</p>
                </div>
                <button onClick={() => resolve(e.id)} disabled={pending} className="shrink-0 rounded-md border px-3 py-1.5 text-xs">Resolve</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Failed sends */}
      {data.failedSends.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Failed sends ({data.failedSends.length})</h2>
          <div className="space-y-1">
            {data.failedSends.slice(0, 20).map((f) => (
              <div key={f.id} className="text-sm">
                <span className="font-medium">{f.managerKind}</span> <span className="text-xs text-red-600">{f.error}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Cron health */}
      {data.cronHealth.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Autonomous jobs needing attention ({data.cronHealth.length})</h2>
          <div className="space-y-1">
            {data.cronHealth.map((c) => (
              <div key={c.cronName} className="flex items-center gap-3 text-sm">
                <span className={"shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium " + (c.health === "failing" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800")}>{c.health}</span>
                <span className="flex-1 truncate">{c.cronName}</span>
                <span className="text-xs text-muted-foreground">{c.failure7d} fails/7d{c.lastError ? ` · ${c.lastError.slice(0, 40)}` : ""}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
