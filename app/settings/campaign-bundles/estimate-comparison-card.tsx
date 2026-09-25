"use client"

// app/settings/campaign-bundles/estimate-comparison-card.tsx
// ─────────────────────────────────────────────────────────────────────────────
// THE ESTIMATE COMPARISON — the tenant's card (wave 82D, owner: "finding out
// what your home is worth in todays market can make you feel overwhelmed when
// comparing all of these sites...we can help"). Sits beside the Zestimate
// stills card and the Strategy Playbooks (the `estimate_comparison` play).
//
// Four steps, all on existing rails: (1) capture every website for an address
// (lib/marketing/estimate-comparison.ts → the ONE screenshot seam, pending);
// (2) approve / reject each capture on the EXISTING marketing_assets rail
// (approveAsset / rejectAsset); (3) type the figure each APPROVED capture
// shows (the OS never reads a value off a page); (4) compose the piece —
// postcard, square, story — which lands pending for a final approval.
import { useState, useTransition } from "react"
import { approveAsset, rejectAsset } from "@/app/actions/marketing-studio"
import {
  captureEstimateComparisonAction, listEstimateComparisonAction, confirmComparisonFigureAction, composeEstimateComparisonAction,
} from "@/app/actions/marketing/tenant-screenshots"
import { COMPARISON_ESTIMATE_SOURCES, ESTIMATE_STILL_DISCLAIMER } from "@/lib/marketing/estimate-sources"

type Evidence = { assetId: string; source: string; label: string; url: string | null; approvalStatus: string | null; capturedAt: string | null; confirmedFigureUsd: number | null; posture: string; tosNote: string }
// Mirrors COMPARISON_HOOKS keys in lib/marketing/estimate-comparison.ts (the
// action refuses any other key by falling back to the default hook).
const HOOKS = [
  { key: "four_sites", label: "N websites. N different prices." },
  { key: "overwhelmed", label: "Felt more confused? You're not alone." },
  { key: "sells_for_one", label: "N online prices. It only sells for one." },
  { key: "spread", label: "$X apart. Same house." },
  { key: "cant_agree", label: "The internet can't agree." },
] as const

export function EstimateComparisonCard() {
  const [address, setAddress] = useState("")
  const [evidence, setEvidence] = useState<Evidence[]>([])
  const [figures, setFigures] = useState<Record<string, string>>({})
  const [hookKey, setHookKey] = useState<string>("four_sites")
  const [result, setResult] = useState<string | null>(null)
  const [composed, setComposed] = useState<{ urls: Record<string, string>; socialCaption: string; emailSubject: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const ready = address.trim().length >= 6

  function load() {
    if (!ready) return
    listEstimateComparisonAction({ address: address.trim() })
      .then((r) => { if (r.ok) setEvidence(r.evidence); else setErr(r.error) })
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not list the captures"))
  }
  function capture() {
    setErr(null); setResult(null); setComposed(null)
    start(async () => {
      const r = await captureEstimateComparisonAction({ address: address.trim() })
      if (!r.ok) { setErr(r.error); return }
      setResult(r.outcomes.map((o) => `${o.source.replace(/_/g, " ")}: ${o.ok ? "captured (pending your approval)" : o.reason}`).join(" · "))
      load()
    })
  }
  function decide(e: Evidence, approve: boolean) {
    setErr(null)
    start(async () => {
      const r = approve ? await approveAsset(e.assetId) : await rejectAsset(e.assetId, "Not suitable for the comparison")
      if (r.success) load(); else setErr(r.error ?? "Decision failed")
    })
  }
  function confirm(e: Evidence) {
    setErr(null)
    start(async () => {
      const r = await confirmComparisonFigureAction({ assetId: e.assetId, figure: figures[e.assetId] ?? "" })
      if (r.ok) load(); else setErr(r.error)
    })
  }
  function compose() {
    setErr(null); setResult(null)
    start(async () => {
      const r = await composeEstimateComparisonAction({ address: address.trim(), hookKey })
      if (r.ok) { setComposed({ urls: r.urls, socialCaption: r.socialCaption, emailSubject: r.emailSubject }); setResult(`Composed: "${r.headline}" — pending your approval in Marketing Studio.`) }
      else setErr(`${r.error}${r.omitted?.length ? ` (${r.omitted.map((o) => `${o.source.replace(/_/g, " ")}: ${o.reason}`).join("; ")})` : ""}`)
    })
  }

  return (
    <section className="border border-purple-200 bg-white rounded-lg p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">Estimate Comparison — &quot;every website gives a different price&quot;</h3>
        <p className="text-xs text-gray-600 mt-1">
          Capture each home-value website for one address ({COMPARISON_ESTIMATE_SOURCES.map((s) => s.cardLabel).join(", ")}), approve each capture, type the figure it shows, then compose the piece: every site&apos;s figure on its own card, the spread, and an invitation to a no-obligation home-value review. Only the Zillow still may appear as a picture; the others print as text under a plain label (their terms bar reproducing their pages). {ESTIMATE_STILL_DISCLAIMER}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input className="min-w-[18rem] rounded border bg-background px-2 py-1 text-sm" placeholder="Street address, city, state" value={address} onChange={(e) => setAddress(e.target.value)} disabled={pending} />
        <button type="button" className="px-3 py-1.5 bg-purple-600 text-white text-xs font-medium rounded hover:bg-purple-700 disabled:opacity-50" onClick={capture} disabled={pending || !ready}>{pending ? "Working…" : "Capture all sites"}</button>
        <button type="button" className="px-3 py-1.5 border text-xs rounded disabled:opacity-50" onClick={load} disabled={pending || !ready}>Refresh</button>
      </div>
      <div className="space-y-2">
        {evidence.length === 0 && <p className="text-xs text-gray-500">No captures for this address yet.</p>}
        {evidence.map((e) => (
          <div key={e.assetId} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">{e.label}</span>
            {e.url && <a className="underline" href={e.url} target="_blank" rel="noreferrer">capture</a>}
            <span className={e.approvalStatus === "approved" ? "text-emerald-700" : e.approvalStatus === "rejected" ? "text-red-700" : "text-amber-700"}>({e.approvalStatus ?? "pending"})</span>
            {e.approvalStatus !== "approved" && <button type="button" className="rounded border px-2 py-0.5" onClick={() => decide(e, true)} disabled={pending}>Approve</button>}
            {e.approvalStatus !== "rejected" && <button type="button" className="rounded border px-2 py-0.5" onClick={() => decide(e, false)} disabled={pending}>Reject</button>}
            {e.approvalStatus === "approved" && (
              <>
                <input className="w-28 rounded border px-1 py-0.5" placeholder="figure shown" value={figures[e.assetId] ?? (e.confirmedFigureUsd != null ? String(e.confirmedFigureUsd) : "")} onChange={(ev) => setFigures((f) => ({ ...f, [e.assetId]: ev.target.value }))} disabled={pending} />
                <button type="button" className="rounded border px-2 py-0.5" onClick={() => confirm(e)} disabled={pending}>{e.confirmedFigureUsd != null ? "Update figure" : "Confirm figure"}</button>
              </>
            )}
            <span className="text-[11px] text-gray-500">{e.posture === "figure_only" ? "text only on the piece" : "still may appear"}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className="rounded border bg-background px-2 py-1 text-xs" value={hookKey} onChange={(e) => setHookKey(e.target.value)} disabled={pending}>
          {HOOKS.map((h) => <option key={h.key} value={h.key}>{h.label}</option>)}
        </select>
        <button type="button" className="px-3 py-1.5 bg-purple-600 text-white text-xs font-medium rounded hover:bg-purple-700 disabled:opacity-50" onClick={compose} disabled={pending || !ready}>Compose the piece</button>
      </div>
      {composed && (
        <div className="space-y-1 text-xs">
          {Object.entries(composed.urls).map(([fmt, url]) => <a key={fmt} className="underline mr-3" href={url} target="_blank" rel="noreferrer">{fmt.replace(/_/g, " ")}</a>)}
          <p className="text-gray-700"><span className="font-medium">Email subject:</span> {composed.emailSubject}</p>
          <pre className="whitespace-pre-wrap text-gray-700 bg-gray-50 rounded p-2">{composed.socialCaption}</pre>
        </div>
      )}
      {result && <p className="text-xs break-all text-emerald-800">{result}</p>}
      {err && <p className="text-xs text-red-700">{err}</p>}
    </section>
  )
}
