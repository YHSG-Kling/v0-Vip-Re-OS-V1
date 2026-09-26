"use client"

// app/settings/campaign-bundles/estimate-stills-card.tsx
// ─────────────────────────────────────────────────────────────────────────────
// THE ZESTIMATE STILL — the tenant's capture card (wave 80D; narrowed to ONE
// source at wave 81D, owner: "the zestimate screenshot is the only property
// page screenshot … the picture of the property on zillow with the zestimate
// showing"). Sits beside the Strategy Playbooks because the still is the
// Zestimate Challenge's own material (lib/marketing/creative-playbooks.ts).
// The tenant enters an address; the OS captures the Zillow property page
// (photo + Zestimate confirmed on screen, else refused) through the ONE seam
// (ToS-aware) into this brokerage's marketing assets, PENDING;
// a human approves or rejects here through the EXISTING marketing_assets rail
// (app/actions/marketing-studio.ts approveAsset / rejectAsset). An approved
// still is what the next Zestimate Challenge install consumes — for that
// campaign's postcard and that campaign's own video. WAVE 84B (owner verbatim:
// "only the zillow zestimate screenshot can be used for marketing campaigns
// including video"): a still's uses are ZESTIMATE_SCREENSHOT_USES —
// marketing_campaign + campaign_video — read from THE ONE RULE
// (lib/assets/screenshot-uses.ts), never restated; product_video / demo /
// training / the image library are never offered. And ("for the zestimate
// challenge it is oky to have a real number"): on an APPROVED still a person
// confirms the Zestimate it shows (the existing confirmComparisonFigureAction
// door), so the Zestimate Challenge's copy may quote Zillow's figure.
import { useEffect, useState, useTransition } from "react"
import { approveAsset, rejectAsset } from "@/app/actions/marketing-studio"
import {
  captureEstimateStillAction, confirmComparisonFigureAction, listEstimateSourcesAction, listTenantScreenshotStillsAction, setTenantScreenshotUsesAction,
} from "@/app/actions/marketing/tenant-screenshots"
import { ESTIMATE_SOURCES, ESTIMATE_STILL_DISCLAIMER, DEFAULT_ESTIMATE_SOURCE } from "@/lib/marketing/estimate-sources"
import { ZESTIMATE_SCREENSHOT_USES, type ScreenshotUse } from "@/lib/assets/screenshot-uses"

// THE ONE RULE's Zestimate list (lib/assets/screenshot-uses.ts) — a pure module
// a client component may import; the action refuses any other value.
const USES = ZESTIMATE_SCREENSHOT_USES
type Use = ScreenshotUse
type Still = { id: string; url: string; label: string; uses: string[]; approvalStatus: string | null; estimateSource?: string | null; address?: string | null; capturedAt: string | null; confirmedFigureUsd?: number | null }

export function EstimateStillsCard() {
  // ONE source — the Zillow property page (wave 81D). No picker: the vocabulary
  // holds exactly one key and the card shows it as a fixed line.
  const source = DEFAULT_ESTIMATE_SOURCE
  const sourceDef = ESTIMATE_SOURCES.find((s) => s.key === source) ?? ESTIMATE_SOURCES[0]
  const [tosNotes, setTosNotes] = useState<Record<string, string>>(Object.fromEntries(ESTIMATE_SOURCES.map((s) => [s.key, s.tosNote])))
  const [address, setAddress] = useState("")
  const [figures, setFigures] = useState<Record<string, string>>({})
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
      const r = await captureEstimateStillAction({ source, address: address.trim() })
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

  function confirmFigure(still: Still) {
    const typed = (figures[still.id] ?? "").trim()
    if (!typed) return
    setErr(null)
    start(async () => {
      const r = await confirmComparisonFigureAction({ assetId: still.id, figure: typed })
      if (r.ok) { setResult(`Zestimate confirmed: $${r.figureUsd.toLocaleString("en-US")} — the next Zestimate Challenge install may quote it as Zillow's figure.`); load() }
      else setErr(r.error)
    })
  }

  return (
    <section className="border border-purple-200 bg-white rounded-lg p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">Zestimate stills — the Zestimate Challenge&apos;s own material</h3>
        <p className="text-xs text-gray-600 mt-1">
          Enter an address. The OS captures the Zillow property page — the property photo and the Zestimate together, refused if either is not on screen — (robots.txt honoured, rate-limited, source and capture date recorded) into your marketing assets, pending your approval. An approved still is used by the next Zestimate Challenge install — its postcard and its own video — and nowhere else: a Zestimate still is marketing-campaign material (the campaign&apos;s video included) only. Confirm the Zestimate an approved still shows and the campaign copy may quote it — always as Zillow&apos;s estimate, never as your value. {ESTIMATE_STILL_DISCLAIMER}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border bg-muted px-2 py-1 text-sm" title={`Source: ${sourceDef.host} — must show ${sourceDef.mustShow.join(" + ")}`}>{sourceDef.label}</span>
        <input className="min-w-[18rem] rounded border bg-background px-2 py-1 text-sm" placeholder="Street address, city, state" value={address} onChange={(e) => setAddress(e.target.value)} disabled={pending} />
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
            {s.approvalStatus === "approved" && (
              <span className="flex items-center gap-1">
                <input className="w-28 rounded border bg-background px-1 py-0.5" placeholder={s.confirmedFigureUsd != null ? `$${s.confirmedFigureUsd.toLocaleString("en-US")}` : "Zestimate shown"} value={figures[s.id] ?? ""} onChange={(e) => setFigures({ ...figures, [s.id]: e.target.value })} disabled={pending} />
                <button type="button" className="rounded border px-2 py-0.5" onClick={() => confirmFigure(s)} disabled={pending || !(figures[s.id] ?? "").trim()}>{s.confirmedFigureUsd != null ? "Correct figure" : "Confirm figure"}</button>
              </span>
            )}
          </div>
        ))}
      </div>
      {result && <p className="text-xs break-all text-emerald-800">{result}</p>}
      {err && <p className="text-xs text-red-700">{err}</p>}
    </section>
  )
}
