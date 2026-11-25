"use client"

// app/components/calculators/CalculatorStudio.tsx — BUILD AND PUBLISH CALCULATOR ARTIFACTS IN THE COMMAND CENTER (wave 156,
// lane 156H). Mounted on the Command tab of the existing Marketing Studio, beside the Content and Channel Command Center.
//
// It authors through createCalculatorArtifactAction (a DRAFT lead magnet, magnet_type "calculator", settings.calculator),
// publishes through the EXISTING publish door publishLeadMagnetAction (fair-housing scan of the public copy, the C5 approver,
// the ledger) — with "qr_code" when the author asked for a QR, so the code is minted by the ONE minter
// (lib/marketing/tracked-qr.ts) — and reads the funnel (scan → open → calculation → opt-in → submission) back.

import { useCallback, useEffect, useState } from "react"
import { CALCULATOR_KINDS, CALCULATOR_SPECS, type CalculatorKind } from "@/lib/calculators/engine"
import { CALCULATOR_JURISDICTIONS } from "@/lib/calculators/rate-sources"
import { createCalculatorArtifactAction, getCalculatorFunnelAction, listCalculatorArtifactsAction } from "@/app/actions/calculator-artifacts"
import { publishLeadMagnetAction } from "@/app/actions/lead-magnets-actions"

type Listed = Awaited<ReturnType<typeof listCalculatorArtifactsAction>>["calculators"][number]

export default function CalculatorStudio() {
  const [kind, setKind] = useState<CalculatorKind>("seller_net_sheet")
  const [title, setTitle] = useState("")
  const [jurisdiction, setJurisdiction] = useState("")
  const [brand, setBrand] = useState({ displayName: "", primaryColor: "", logoUrl: "", tagline: "" })
  const [explainer, setExplainer] = useState({ videoUrl: "", guideUrl: "" })
  const [cta, setCta] = useState<{ label: string; mode: "save_results" | "talk_to_agent" }>({ label: "", mode: "save_results" })
  const [qr, setQr] = useState(false)
  const [hidden, setHidden] = useState<string[]>([])
  const [list, setList] = useState<Listed[]>([])
  const [funnel, setFunnel] = useState<Record<string, Record<string, number>>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const r = await listCalculatorArtifactsAction()
    if (r.success) setList(r.calculators)
    else setMessage(r.error ?? "Could not load your calculators")
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  async function create() {
    setBusy(true); setMessage(null)
    const blank = (s: string) => (s.trim() ? s.trim() : null)
    const r = await createCalculatorArtifactAction({
      title,
      config: {
        kind, jurisdiction: blank(jurisdiction), hiddenFields: hidden,
        brand: { displayName: blank(brand.displayName), primaryColor: blank(brand.primaryColor), logoUrl: blank(brand.logoUrl), tagline: blank(brand.tagline) },
        explainer: { videoUrl: blank(explainer.videoUrl), guideUrl: blank(explainer.guideUrl) },
        cta: { label: blank(cta.label), mode: cta.mode }, qr,
      },
    })
    setBusy(false)
    setMessage(r.success ? "Draft created — preview it, then publish." : r.error ?? "Could not create the calculator")
    if (r.success) { setTitle(""); void refresh() }
  }

  async function publish(c: Listed) {
    setBusy(true); setMessage(null)
    const channels: Array<"landing_page" | "qr_code"> = c.config?.qr ? ["landing_page", "qr_code"] : ["landing_page"]
    const r = await publishLeadMagnetAction(c.id, channels)
    setBusy(false)
    setMessage(r.success ? `Published${"urls" in r && r.urls?.qr ? " with a tracked QR code" : ""}.` : ("error" in r && r.error) || "Could not publish")
    void refresh()
  }

  async function loadFunnel(id: string) {
    const r = await getCalculatorFunnelAction(id)
    if (r.success && "funnel" in r && r.funnel) setFunnel((f) => ({ ...f, [id]: r.funnel as Record<string, number> }))
    else setMessage(("error" in r && r.error) || "Could not read the funnel")
  }

  const optional = CALCULATOR_SPECS[kind].fields.filter((f) => f.required === false)
  const input = "w-full rounded-md border bg-background px-3 py-2 text-sm"

  return (
    <section className="mt-8 space-y-4 rounded-lg border p-4" aria-label="Calculators">
      <div>
        <h2 className="text-lg font-semibold">Calculators</h2>
        <p className="text-sm text-muted-foreground">Publish a calculator on your website, a landing page or a QR code. Visitors compute without giving contact details; every rate is one they enter or a cited statute — never a guessed percentage.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm">Calculator
          <select className={input} value={kind} onChange={(e) => { setKind(e.target.value as CalculatorKind); setHidden([]) }}>
            {CALCULATOR_KINDS.map((k) => <option key={k} value={k}>{CALCULATOR_SPECS[k].title}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-sm">Title<input className={input} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="space-y-1 text-sm">Jurisdiction (cited statutes)
          <select className={input} value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)}>
            <option value="">None — visitors enter every figure</option>
            {CALCULATOR_JURISDICTIONS.map((j) => <option key={j} value={j}>{j}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-sm">Display name<input className={input} value={brand.displayName} placeholder="Defaults to your brokerage name" onChange={(e) => setBrand({ ...brand, displayName: e.target.value })} /></label>
        <label className="space-y-1 text-sm">Brand colour (#RRGGBB)<input className={input} value={brand.primaryColor} placeholder="Defaults to your website colour" onChange={(e) => setBrand({ ...brand, primaryColor: e.target.value })} /></label>
        <label className="space-y-1 text-sm">Logo URL (https)<input className={input} value={brand.logoUrl} onChange={(e) => setBrand({ ...brand, logoUrl: e.target.value })} /></label>
        <label className="space-y-1 text-sm">Tagline<input className={input} value={brand.tagline} onChange={(e) => setBrand({ ...brand, tagline: e.target.value })} /></label>
        <label className="space-y-1 text-sm">Explanatory video URL (https)<input className={input} value={explainer.videoUrl} onChange={(e) => setExplainer({ ...explainer, videoUrl: e.target.value })} /></label>
        <label className="space-y-1 text-sm">Guide URL (https)<input className={input} value={explainer.guideUrl} onChange={(e) => setExplainer({ ...explainer, guideUrl: e.target.value })} /></label>
        <label className="space-y-1 text-sm">Call to action
          <select className={input} value={cta.mode} onChange={(e) => setCta({ ...cta, mode: e.target.value as "save_results" | "talk_to_agent" })}>
            <option value="save_results">Save my results</option>
            <option value="talk_to_agent">Talk with an agent</option>
          </select>
        </label>
        <label className="space-y-1 text-sm">Button text<input className={input} value={cta.label} onChange={(e) => setCta({ ...cta, label: e.target.value })} /></label>
      </div>
      <fieldset className="space-y-1 text-sm">
        <legend className="font-medium">Publish on</legend>
        <p className="text-xs text-muted-foreground">Publishing puts the calculator on its landing page inside your website, and your website lists it with your other free resources.</p>
        <label className="inline-flex items-center gap-1"><input type="checkbox" checked={qr} onChange={(e) => setQr(e.target.checked)} />QR code</label>
      </fieldset>
      {optional.length > 0 && (
        <fieldset className="space-y-1 text-sm">
          <legend className="font-medium">Hide optional fields</legend>
          {optional.map((f) => (
            <label key={f.key} className="mr-4 inline-flex items-center gap-1"><input type="checkbox" checked={hidden.includes(f.key)} onChange={(e) => setHidden(e.target.checked ? [...hidden, f.key] : hidden.filter((h) => h !== f.key))} />{f.label}</label>
          ))}
        </fieldset>
      )}
      <button type="button" disabled={busy || !title.trim()} onClick={() => void create()} className="rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-60">Create draft</button>
      {message && <p className="text-sm" role="status">{message}</p>}
      <ul className="space-y-2">
        {list.map((c) => (
          <li key={c.id} className="rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{c.name}</span>
              <span className="text-xs text-muted-foreground">{c.config ? CALCULATOR_SPECS[c.config.kind].title : "unreadable configuration"} · {c.isActive ? "published" : "draft"}{c.hasQr ? " · QR" : ""}</span>
              <a className="text-xs underline" href={`/lm/${c.slug}${c.isActive ? "" : "?preview=1"}`} target="_blank" rel="noopener noreferrer">{c.isActive ? "Open" : "Preview"}</a>
              {!c.isActive && <button type="button" disabled={busy} onClick={() => void publish(c)} className="rounded border px-2 py-1 text-xs">Publish</button>}
              <button type="button" onClick={() => void loadFunnel(c.id)} className="rounded border px-2 py-1 text-xs">Results</button>
            </div>
            {funnel[c.id] && (
              <p className="mt-1 text-xs text-muted-foreground">
                QR scans {funnel[c.id].qr_scan} · opens {funnel[c.id].calculator_open} · calculations {funnel[c.id].calculation_completed} · opt-ins {funnel[c.id].calculator_opt_in} · submissions {funnel[c.id].submissions}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
