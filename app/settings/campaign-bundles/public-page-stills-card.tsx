"use client"

// app/settings/campaign-bundles/public-page-stills-card.tsx
// ─────────────────────────────────────────────────────────────────────────────
// GENERAL PUBLIC-PAGE STILLS — the tenant's capture card (wave 85, lane 85A,
// owner verbatim: "a public page screenshhot can be more than just zillow
// zestimate page."). Sits beside the Zestimate card. The tenant pastes the
// address of a public page — a listing page, its own site or landing page, a
// market / community / news / HOA / school / city / review page — and the OS
// captures it through the ONE seam (robots.txt honoured, rate-limited, public
// internet only, source and capture date recorded) into this brokerage's
// marketing assets, PENDING. A human approves or rejects it through the
// EXISTING marketing_assets rail (app/actions/marketing-studio.ts approveAsset
// / rejectAsset); an approved still is general material and serves every use
// — marketing campaigns and their videos, product videos, demos, training /
// guides, the image library — until a person narrows it (the toggles below go
// through the existing setTenantScreenshotUsesAction door, which asks THE ONE
// RULE). A Zillow page belongs to the Zestimate card; another portal's
// estimate page is refused by the classifier (its figure stays web-searched
// text on the comparison card).
import { useEffect, useState, useTransition } from "react"
import { approveAsset, rejectAsset } from "@/app/actions/marketing-studio"
import {
  captureTenantPublicPageStillAction, listTenantPublicPageStillsAction, setTenantScreenshotUsesAction,
} from "@/app/actions/marketing/tenant-screenshots"
import { SCREENSHOT_USES, type ScreenshotUse } from "@/lib/assets/screenshot-uses"

type Still = { id: string; url: string; label: string; uses: string[]; approvalStatus: string | null; sourceUrl: string | null; capturedAt: string | null }

export function PublicPageStillsCard() {
  const [pageUrl, setPageUrl] = useState("")
  const [label, setLabel] = useState("")
  const [stills, setStills] = useState<Still[]>([])
  const [result, setResult] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function load() {
    listTenantPublicPageStillsAction()
      .then((r) => { if (r.ok) setStills(r.stills as Still[]); else setErr(r.error) })
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not list your public-page stills"))
  }
  useEffect(() => { load() }, [])

  function capture() {
    if (!/^https?:\/\//i.test(pageUrl.trim())) return
    setErr(null); setResult(null)
    start(async () => {
      const r = await captureTenantPublicPageStillAction({ url: pageUrl.trim(), label: label.trim() || null })
      if (r.ok) { setResult(`${r.cached ? "Already captured today" : "Captured"} — pending your approval below.`); setPageUrl(""); setLabel(""); load() }
      else setErr(r.error)
    })
  }
  function decide(still: Still, approve: boolean) {
    setErr(null)
    start(async () => {
      const r = approve ? await approveAsset(still.id) : await rejectAsset(still.id, "Not suitable as marketing material")
      if (r.success) load(); else setErr(r.error ?? "Decision failed")
    })
  }
  function toggleUse(still: Still, u: ScreenshotUse) {
    const next = (still.uses.includes(u) ? still.uses.filter((x) => x !== u) : [...still.uses, u]) as ScreenshotUse[]
    setErr(null)
    start(async () => {
      const r = await setTenantScreenshotUsesAction({ assetId: still.id, uses: next })
      if (r.ok) load(); else setErr(r.error)
    })
  }

  return (
    <section className="border border-sky-200 bg-white rounded-lg p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">Public page stills — listings, your site, market &amp; community pages</h3>
        <p className="text-xs text-gray-600 mt-1">
          Paste the address of a public page — a listing page, your own site or landing page, a market report, a community, news, HOA, school or city page, a review page. The OS captures it (robots.txt honoured, rate-limited, public internet only, source and capture date recorded) into your marketing assets, pending your approval. Once approved it is general material: campaigns and their videos, product videos, demos, training and guides, and your image library. Online home-value estimate pages are not captured here — the Zestimate has its own card, and other sites&apos; estimates stay text on the comparison card.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input className="min-w-[20rem] rounded border bg-background px-2 py-1 text-sm" placeholder="https://…" value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} disabled={pending} />
        <input className="min-w-[12rem] rounded border bg-background px-2 py-1 text-sm" placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} disabled={pending} />
        <button type="button" className="px-3 py-1.5 bg-sky-600 text-white text-xs font-medium rounded hover:bg-sky-700 disabled:opacity-50" onClick={capture} disabled={pending || !/^https?:\/\//i.test(pageUrl.trim())}>
          {pending ? "Working…" : "Capture page"}
        </button>
      </div>
      <div className="space-y-2">
        {stills.length === 0 && <p className="text-xs text-gray-500">No public-page stills yet.</p>}
        {stills.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-2 text-xs">
            <a className="underline break-all" href={s.url} target="_blank" rel="noreferrer">{s.label}</a>
            {s.sourceUrl && <span className="text-gray-500 break-all">({s.sourceUrl}{s.capturedAt ? `, ${s.capturedAt.slice(0, 10)}` : ""})</span>}
            <span className={s.approvalStatus === "approved" ? "text-emerald-700" : s.approvalStatus === "rejected" ? "text-red-700" : "text-amber-700"}>({s.approvalStatus ?? "pending"})</span>
            {s.approvalStatus !== "approved" && <button type="button" className="rounded border px-2 py-0.5" onClick={() => decide(s, true)} disabled={pending}>Approve</button>}
            {s.approvalStatus !== "rejected" && <button type="button" className="rounded border px-2 py-0.5" onClick={() => decide(s, false)} disabled={pending}>Reject</button>}
            {SCREENSHOT_USES.map((u) => (
              <label key={u} className="flex items-center gap-1">
                <input type="checkbox" checked={s.uses.includes(u)} disabled={pending} onChange={() => toggleUse(s, u)} />
                {u.replace(/_/g, " ")}
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
