"use client"

// app/dashboard/superadmin/demo-room/demo-stills-card.tsx
// ─────────────────────────────────────────────────────────────────────────────
// THE HUMAN DOOR's surface (wave 78 integration): lane 78B built the screenshot
// seam and its server action (app/actions/superadmin/screenshot-capture.ts)
// but mounted no page, so no-orphan-actions flagged the action as imported by
// nothing. The demo room is the natural home — the same platform-marketing
// staff who seed the deal-room demo ask for a demo still or a public
// property-page capture here. Autonomous refresh still rides the
// marketing-image-regen cron; this card is for the on-demand case.
import { useEffect, useState, useTransition } from "react"
import {
  captureDemoStillAction,
  capturePublicPropertyStillAction,
  listDemoStillSurfacesAction,
} from "@/app/actions/superadmin/screenshot-capture"

type Surface = { id: string; label: string; route: string }

export function DemoStillsCard() {
  const [surfaces, setSurfaces] = useState<Surface[]>([])
  const [surfaceId, setSurfaceId] = useState<string>("")
  const [query, setQuery] = useState<string>("")
  const [result, setResult] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    listDemoStillSurfacesAction().then((r) => {
      if (r.ok) { setSurfaces(r.surfaces); setSurfaceId(r.surfaces[0]?.id ?? "") }
      else setErr(r.error)
    }).catch((e) => setErr(e instanceof Error ? e.message : "Could not load the demo still surfaces"))
  }, [])

  function captureSurface() {
    if (!surfaceId) return
    setErr(null); setResult(null)
    start(async () => {
      const r = await captureDemoStillAction({ surfaceId })
      if (r.ok) setResult(`${r.cached ? "Cached" : "Captured"} — ${r.url}`)
      else setErr(r.error)
    })
  }

  function capturePublic() {
    if (!query.trim()) return
    setErr(null); setResult(null)
    start(async () => {
      const r = await capturePublicPropertyStillAction({ query: query.trim() })
      if (r.ok) setResult(`${r.cached ? "Cached" : "Captured"} — ${r.url} (pending approval; demo/training material only)`)
      else setErr(r.error)
    })
  }

  return (
    <section className="rounded-lg border p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Demo stills</h2>
        <p className="text-xs text-muted-foreground">
          Screenshots of the demo tenant&apos;s own surfaces (redacted) and public property pages, for
          product videos, the live-agent demo and training material. Public captures land pending
          approval and never reach tenant pickers.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded border bg-background px-2 py-1 text-sm"
          value={surfaceId}
          onChange={(e) => setSurfaceId(e.target.value)}
          disabled={pending || surfaces.length === 0}
        >
          {surfaces.map((s) => <option key={s.id} value={s.id}>{s.label} — {s.route}</option>)}
        </select>
        <button type="button" className="rounded border px-3 py-1 text-sm" onClick={captureSurface} disabled={pending || !surfaceId}>
          {pending ? "Working…" : "Capture OS surface"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="min-w-[18rem] rounded border bg-background px-2 py-1 text-sm"
          placeholder="Public property page to find, e.g. 123 Main St Tampa zestimate"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={pending}
        />
        <button type="button" className="rounded border px-3 py-1 text-sm" onClick={capturePublic} disabled={pending || !query.trim()}>
          {pending ? "Working…" : "Capture public page"}
        </button>
      </div>
      {result && <p className="text-xs break-all">{result}</p>}
      {err && <p className="text-xs text-destructive">{err}</p>}
    </section>
  )
}
