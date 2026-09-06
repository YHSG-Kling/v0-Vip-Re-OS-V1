"use client"

/**
 * The "What the managers did" ledger — the completed-work counterpart to the
 * "Managers talking" feed. Where that feed shows the negotiation (who told whom
 * what) and the queue shows what's WAITING on a human, this shows what each AI
 * manager actually DID: executed campaign actions, released client messages,
 * swept-up stuck work, signals acted on — one chronological, manager-attributed
 * timeline. Every row is a real record composed by loadManagerActivity; nothing
 * here is decorative.
 *
 * Manager identity colors come from the canonical MANAGERS registry so the visual
 * vocabulary can't drift from the governed roster.
 */

import { useMemo, useState } from "react"
import { Card } from "@/components/ui/card"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import type { ManagerActivityEntry } from "@/lib/kernel/manager-activity"

const STATUS_STYLE: Record<ManagerActivityEntry["status"], { chip: string; label: string }> = {
  executed:  { chip: "bg-emerald-100 text-emerald-800", label: "executed" },
  sent:      { chip: "bg-sky-100 text-sky-800",         label: "sent" },
  done:      { chip: "bg-slate-100 text-slate-700",     label: "done" },
  skipped:   { chip: "bg-zinc-100 text-zinc-600",       label: "skipped" },
  escalated: { chip: "bg-amber-100 text-amber-900",     label: "escalated" },
  failed:    { chip: "bg-red-100 text-red-800",         label: "failed" },
}

const SOURCE_LABEL: Record<ManagerActivityEntry["source"], string> = {
  signal: "Coordination",
  marketing: "Campaign",
  asset: "Media",
  ads: "Paid ads",
  client_message: "Client message",
  reaper: "Self-heal",
}

function accentFor(key: string): string {
  return key in MANAGERS ? MANAGERS[key as ManagerKey].accent : "bg-slate-100 text-slate-700"
}
function domainFor(key: string): string {
  return key in MANAGERS ? MANAGERS[key as ManagerKey].domain : ""
}
function initials(label: string): string {
  return label.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()
}
function relTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ""
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function ManagerChip({ mkey, label }: { mkey: string; label: string }) {
  return (
    <span
      title={domainFor(mkey)}
      className={`inline-flex items-center gap-1 rounded-full py-0.5 pl-0.5 pr-2 text-[11px] font-medium ${accentFor(mkey)}`}
    >
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-white/70 text-[9px] font-bold">
        {initials(label)}
      </span>
      {label}
    </span>
  )
}

export function ManagerActivityFeed({ activity }: { activity: ManagerActivityEntry[] }) {
  const [showAll, setShowAll] = useState(false)
  const managerCount = useMemo(
    () => new Set(activity.map((a) => a.managerKey)).size,
    [activity],
  )
  if (!activity || activity.length === 0) return null
  const rows = showAll ? activity : activity.slice(0, 12)

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">What the managers did</h2>
        <span className="text-xs text-muted-foreground">
          {activity.length} recent action{activity.length === 1 ? "" : "s"}
          {managerCount > 1 ? ` · ${managerCount} managers` : ""}
        </span>
      </div>

      <ol className="space-y-2">
        {rows.map((a) => {
          const s = STATUS_STYLE[a.status] ?? STATUS_STYLE.done
          return (
            <li key={a.id}>
              <Card className="px-4 py-2.5">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ManagerChip mkey={a.managerKey} label={a.managerLabel} />
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {SOURCE_LABEL[a.source]}
                    </span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${s.chip}`}>{s.label}</span>
                    <span className="ml-auto text-[11px] text-muted-foreground">{relTime(a.whenISO)}</span>
                  </div>
                  <p className="text-sm text-foreground">{a.action}</p>
                  {a.detail && <p className="text-xs text-muted-foreground">{a.detail}</p>}
                </div>
              </Card>
            </li>
          )
        })}
      </ol>

      {activity.length > 12 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-xs font-medium text-primary hover:underline"
        >
          {showAll ? "Show less" : `Show all ${activity.length}`}
        </button>
      )}
    </section>
  )
}
