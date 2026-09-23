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
  listScreenshotStillsForUseAction,
  setScreenshotUsesAction,
} from "@/app/actions/superadmin/screenshot-capture"

type Surface = { id: string; label: string; route: string }
// Mirrors SCREENSHOT_USES in lib/assets/screenshot-capture.ts (a server-only
// module a client component cannot import); the action refuses any other value.
const USES = ["marketing_campaign", "product_video", "demo", "training"] as const
type Use = (typeof USES)[number]
type Still = { id: string; url: string; label: string; uses: Use[]; approvalStatus: string | null }

export function DemoStillsCard() {
  const [surfaces, setSurfaces] = useState<Surface[]>([])
  const [surfaceId, setSurfaceId] = useState<string>("")
  const [query, setQuery] = useState<string>("")
  const [result, setResult] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pending, start] = useTransition()
  // OWNER (2026-09-23): "the zestimate screenshot will be used in some marketing
  // campaigns so there can be many uses for the screenshots" — every still
  // carries its uses; a person widens or narrows them here (lane 79C).
  const [use, setUse] = useState<Use>("marketing_campaign")
  const [stills, setStills] = useState<Still[]>([])

  function loadStills(u: Use) {
    listScreenshotStillsForUseAction({ use: u, includePublicPage: true })
      .then((r) => { if (r.ok) setStills(r.stills as Still[]); else setErr(r.error) })
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not list the stills"))
  }
  useEffect(() => { loadStills(use) }, [use])

  function toggleUse(still: Still, u: Use) {
    const next = still.uses.includes(u) ? still.uses.filter((x) => x !== u) : [...still.uses, u]
    setErr(null)
    start(async () => {
      const r = await setScreenshotUsesAction({ assetId: still.id, uses: next })
      if (r.ok) loadStills(use); else setErr(r.error)
    })
  }

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
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Stills usable for</span>
          <select className="rounded border bg-background px-2 py-1 text-sm" value={use} onChange={(e) => setUse(e.target.value as Use)} disabled={pending}>
            {USES.map((u) => <option key={u} value={u}>{u.replace("_", " ")}</option>)}
          </select>
        </div>
        {stills.length === 0 && <p className="text-xs text-muted-foreground">No stills carry this use yet.</p>}
        {stills.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-2 text-xs">
            <a className="underline break-all" href={s.url} target="_blank" rel="noreferrer">{s.label}</a>
            {s.approvalStatus && s.approvalStatus !== "approved" && <span className="text-muted-foreground">({s.approvalStatus})</span>}
            {USES.map((u) => (
              <label key={u} className="flex items-center gap-1">
                <input type="checkbox" checked={s.uses.includes(u)} disabled={pending} onChange={() => toggleUse(s, u)} />
                {u.replace("_", " ")}
              </label>
            ))}
          </div>
        ))}
      </div>
      {result && <p className="text-xs break-all">{result}</p>}
      {err && <p className="text-xs text-destructive">{err}</p>}
    </section>
  )
}
