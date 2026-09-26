"use client"

// app/settings/campaign-bundles/learned-visual-rules-card.tsx
// The tenant's window onto the learned body-visual rules (wave 80). The loop
// applies bounded changes on its own; a person can see each one and revert it.
import { useEffect, useState, useTransition } from "react"
import { listBodyVisualRulesAction, revertBodyVisualRuleAction } from "@/app/actions/video/body-visual-rules"

type Override = {
  id: string
  purpose: string
  change: { kind: "prefer_treatment"; segmentKind: string; treatment: string } | { kind: "prefer_background"; background: string }
  why: string
  sample: number
  source: "autonomous" | "human"
  appliedAt: string
  revertedAt?: string | null
}

export function LearnedVisualRulesCard() {
  const [rows, setRows] = useState<Override[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const load = () => listBodyVisualRulesAction().then((r) => { if (r.ok) setRows(r.overrides as Override[]); else setErr(r.error) }).catch((e) => setErr(e instanceof Error ? e.message : "Could not load learned rules"))
  useEffect(() => { void load() }, [])

  function revert(id: string) {
    setErr(null)
    start(async () => {
      const r = await revertBodyVisualRuleAction({ overrideId: id, reason: "reverted by the brokerage admin from settings" })
      if (r.ok) await load(); else setErr(r.error)
    })
  }

  const live = rows.filter((o) => !o.revertedAt)
  return (
    <section className="rounded-lg border p-4 space-y-2">
      <div>
        <h2 className="text-sm font-semibold">Learned video visual rules</h2>
        <p className="text-xs text-muted-foreground">
          The OS learns which on-screen treatment performs best for each video purpose and applies bounded changes on its own. Every change is logged and can be reverted here.
        </p>
      </div>
      {live.length === 0 && <p className="text-xs text-muted-foreground">No learned rules are live.</p>}
      {live.map((o) => (
        <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span>
            <strong>{o.purpose}</strong>: {o.change.kind === "prefer_treatment" ? `prefer ${o.change.treatment} on ${o.change.segmentKind} segments` : `prefer the ${o.change.background} background`}
            <span className="text-muted-foreground"> — {o.why} (sample {o.sample}, {o.source}, {new Date(o.appliedAt).toLocaleDateString()})</span>
          </span>
          <button type="button" className="rounded border px-2 py-0.5" disabled={pending} onClick={() => revert(o.id)}>Revert</button>
        </div>
      ))}
      {err && <p className="text-xs text-destructive">{err}</p>}
    </section>
  )
}
