"use client"

/**
 * The "managers talking" hero feed — the inter-manager bus made visible.
 *
 * This is the product's signature differentiator: a real-estate team of AI managers
 * coordinating out loud (who told whom what, and what the addressed manager DID about
 * it), rendered as a live negotiation rather than a flat log. Every line is a real
 * row on manager_signals (publishManagerSignal → loadRecentManagerTalk); nothing here
 * is decorative mock data.
 *
 * Manager identity colors come from the canonical MANAGERS registry (single source of
 * truth) and the coordination KIND is computed by classifyCoordination — so the visual
 * vocabulary can't drift from the governed bus.
 */

import { Card } from "@/components/ui/card"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import type { ManagerTalkLine } from "@/lib/kernel/manager-signals"

// Coordination-kind visual vocabulary so the feed reads as a negotiation, not a log.
const KIND_STYLE: Record<
  string,
  { border: string; chip: string; icon: string; label: string }
> = {
  escalation: { border: "border-l-red-500",    chip: "bg-red-100 text-red-800",      icon: "🚨", label: "Escalation" },
  alert:      { border: "border-l-amber-500",  chip: "bg-amber-100 text-amber-900",  icon: "⚠️", label: "Alert" },
  handoff:    { border: "border-l-sky-500",    chip: "bg-sky-100 text-sky-800",      icon: "🤝", label: "Hand-off" },
  deferral:   { border: "border-l-slate-400",  chip: "bg-slate-100 text-slate-700",  icon: "↩︎", label: "Deferral" },
  update:     { border: "border-l-indigo-400", chip: "bg-indigo-50 text-indigo-700", icon: "•",  label: "Update" },
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

export function ManagerTalkFeed({ talk }: { talk: ManagerTalkLine[] }) {
  if (!talk || talk.length === 0) return null
  const open = talk.filter((t) => t.status === "open").length

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="relative flex h-2.5 w-2.5" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-500" />
        </span>
        <h2 className="text-lg font-semibold">Managers talking</h2>
        <span className="text-xs text-muted-foreground">
          {talk.length} recent{open > 0 ? ` · ${open} awaiting` : ""}
        </span>
      </div>

      <ol className="space-y-2">
        {talk.map((t) => {
          const k = KIND_STYLE[t.kind] ?? KIND_STYLE.update
          return (
            <li key={t.id}>
              <Card className={`border-l-4 ${k.border} px-4 py-2.5`}>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ManagerChip mkey={t.fromKey} label={t.fromLabel} />
                    <span className="text-xs text-muted-foreground">→</span>
                    <ManagerChip mkey={t.toKey} label={t.toLabel} />
                    <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${k.chip}`}>
                      {k.icon} {k.label}
                    </span>
                    <span className="ml-auto text-[11px] text-muted-foreground">{relTime(t.createdAt)}</span>
                  </div>
                  <p className="text-sm text-foreground">{t.message}</p>
                  {t.status === "consumed" && t.consumedAction ? (
                    <div className="flex items-start gap-1.5 rounded-md bg-green-50 px-2 py-1">
                      <span className="shrink-0 text-xs font-medium text-green-700">{t.toLabel} acted</span>
                      <span className="text-xs text-green-800">— {t.consumedAction}</span>
                    </div>
                  ) : t.status === "open" ? (
                    <p className="text-xs text-amber-700">⏳ awaiting {t.toLabel}</p>
                  ) : null}
                </div>
              </Card>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
