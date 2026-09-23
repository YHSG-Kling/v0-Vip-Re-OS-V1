"use client"

// app/settings/campaign-bundles/estimate-stills-card.tsx
// ─────────────────────────────────────────────────────────────────────────────
// "ZESTIMATE & CO." — the tenant's still picker (wave 80, lane 80D). Sits
// beside the Strategy Playbooks because the still is the Zestimate
// Challenge's own material (lib/marketing/creative-playbooks.ts). The tenant
// picks a source + address; the OS captures the public estimate page through
// the ONE seam (ToS-aware) into this brokerage's marketing assets, PENDING;
// a human approves or rejects here through the EXISTING marketing_assets rail
// (app/actions/marketing-studio.ts approveAsset / rejectAsset). An approved
// still is what the next playbook install consumes, and it is already in the
// image-library picker every creative surface reads.
import { useEffect, useState, useTransition } from "react"
import { approveAsset, rejectAsset } from "@/app/actions/marketing-studio"
import {
  captureEstimateStillAction, listEstimateSourcesAction, listTenantScreenshotStillsAction, setTenantScreenshotUsesAction,
} from "@/app/actions/marketing/tenant-screenshots"
import { ESTIMATE_SOURCES, ESTIMATE_STILL_DISCLAIMER, type EstimateSourceKey } from "@/lib/marketing/estimate-sources"

// Mirrors SCREENSHOT_USES in lib/assets/screenshot-capture.ts (a server-only
// module a client component cannot import); the action refuses any other value.
const USES = ["marketing_campaign", "product_video"] as const
type Use = (typeof USES)[number]
type Still = { id: string; url: string; label: string; uses: string[]; approvalStatus: string | null; estimateSource?: string | null; address?: string | null; capturedAt: string | null }

export function EstimateStillsCard() {
  const [source, setSource] = useState<EstimateSourceKey>(ESTIMATE_SOURCES[0].key)
  const [tosNotes, setTosNotes] = useState<Record<string, string>>(Object.fromEntries(ESTIMATE_SOURCES.map((s) => [s.key, s.tosNote])))
  const [address, setAddress] = useState("")
  const [alsoForVideo, setAlsoForVideo] = useState(true)
  const [stills, setStills] = useState<Still[]>([])
  const [result, setResult] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function load() {
    listTenantScreenshotStillsAction({ use: "marketing_campaign" })
      .then((r) => { if (r.ok) setStills(r.stills as Still[]); else setErr(r.error) })
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not list your stills"))
  }
  useEffect(() => {
    load()
    listEstimateSourcesAction().then((r) => { if (r.ok) setTosNotes(Object.fromEntries(r.sources.map((s) => [s.key, s.tosNote]))) }).catch(() => {})
  }, [])

  function capture() {
    if (address.trim().length < 6) return
    setErr(null); setResult(null)
    start(async () => {
      const r = await captureEstimateStillAction({ source, address: address.trim(), alsoForVideo })
      if (r.ok) { setResult(`${r.cached ? "Already captured today" : "Captured"} — pending your approval below. ${r.disclaimer}`); load() }
      else setErr(r.error)
    })
  }
  function decide(still: Still, approve: boolean) {
    setErr(null)
    start(async () => {
      const r = approve ? await approveAsset(still.id) : await rejectAsset(still.id, "Not suitable for the campaign")
      if (r.success) load(); else setErr(r.error ?? "Decision failed")
    })
  }
  function toggleUse(still: Still, u: Use) {
    const next = (still.uses.includes(u) ? still.uses.filter((x) => x !== u) : [...still.uses, u]) as Use[]
    setErr(null)
    start(async () => {
      const r = await setTenantScreenshotUsesAction({ assetId: still.id, uses: next })
      if (r.ok) load(); else setErr(r.error)
    })
  }

  return (
    <section className="border border-purple-200 bg-white rounded-lg p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">Zestimate &amp; co. stills — the Zestimate Challenge&apos;s own material</h3>
        <p className="text-xs text-gray-600 mt-1">
          Pick the estimate source and an address. The OS captures the public estimate page (robots.txt honoured, rate-limited, source and capture date recorded) into your marketing assets, pending your approval. An approved still is used by the next Zestimate Challenge install and appears in your image picker. {ESTIMATE_STILL_DISCLAIMER}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className="rounded border bg-background px-2 py-1 text-sm" value={source} onChange={(e) => setSource(e.target.value as EstimateSourceKey)} disabled={pending}>
          {ESTIMATE_SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <input className="min-w-[18rem] rounded border bg-background px-2 py-1 text-sm" placeholder="Street address, city, state" value={address} onChange={(e) => setAddress(e.target.value)} disabled={pending} />
        <label className="flex items-center gap-1 text-xs text-gray-700">
          <input type="checkbox" checked={alsoForVideo} onChange={(e) => setAlsoForVideo(e.target.checked)} disabled={pending} />
          also usable in videos
        </label>
        <button type="button" className="px-3 py-1.5 bg-purple-600 text-white text-xs font-medium rounded hover:bg-purple-700 disabled:opacity-50" onClick={capture} disabled={pending || address.trim().length < 6}>
          {pending ? "Working…" : "Capture still"}
        </button>
      </div>
      <p className="text-[11px] text-gray-500">{tosNotes[source]}</p>
      <div className="space-y-2">
        {stills.length === 0 && <p className="text-xs text-gray-500">No estimate stills yet.</p>}
        {stills.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-2 text-xs">
            <a className="underline break-all" href={s.url} target="_blank" rel="noreferrer">{s.label}</a>
            <span className={s.approvalStatus === "approved" ? "text-emerald-700" : s.approvalStatus === "rejected" ? "text-red-700" : "text-amber-700"}>({s.approvalStatus ?? "pending"})</span>
            {s.approvalStatus !== "approved" && <button type="button" className="rounded border px-2 py-0.5" onClick={() => decide(s, true)} disabled={pending}>Approve</button>}
            {s.approvalStatus !== "rejected" && <button type="button" className="rounded border px-2 py-0.5" onClick={() => decide(s, false)} disabled={pending}>Reject</button>}
            {USES.map((u) => (
              <label key={u} className="flex items-center gap-1">
                <input type="checkbox" checked={s.uses.includes(u)} disabled={pending} onChange={() => toggleUse(s, u)} />
                {u.replace("_", " ")}
              </label>
            ))}
          </div>
        ))}
      </div>
      {result && <p className="text-xs break-all text-emerald-800">{result}</p>}
      {err && <p className="text-xs text-red-700">{err}</p>}
    </section>
  )
}
