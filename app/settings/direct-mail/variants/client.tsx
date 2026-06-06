"use client"

import { useState, useTransition } from "react"
import {
  setVariantActive,
  addCustomVariant,
  type VariantCatalogRow,
} from "@/app/actions/direct-mail-variants-settings"

const COPY_STYLE_PRESETS = [
  "direct-fact", "question-hook", "social-proof", "photo-led",
  "intro-warm", "intro-credibility", "checkin-personal", "appointment-prep",
]
const COMPOSITION_PRESETS = ["PostcardFront4x6", "PostcardFront6x9"]
const USE_KIND_OPTIONS    = ["farm_mail", "welcome_kit", "sphere_outreach", "lifecycle", "pre_listing_kit"]
const PERSONA_OPTIONS     = [
  "first_time", "relocated", "luxury", "fsbo", "probate",
  "upsize", "downsize", "military", "divorce", "senior",
  "expired", "foreclosure", "other",
]

export function VariantCatalogClient({ initialRows }: { initialRows: VariantCatalogRow[] }) {
  const [rows, setRows]   = useState(initialRows)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Add-form state
  const [form, setForm] = useState({
    composition_id: "PostcardFront4x6",
    copy_style:     "direct-fact",
    layout_variant: "default",
    persona:        "first_time",
    use_kind:       "farm_mail",
    postcard_size:  "4x6",
  })

  function handleToggle(variantId: string, current: boolean) {
    setError(null)
    startTransition(async () => {
      const r = await setVariantActive({ variantId, isActive: !current })
      if (!r.success) {
        setError(r.error ?? "Toggle failed")
        return
      }
      setRows((prev) => prev.map((row) =>
        row.variant_id === variantId ? { ...row, is_active: !current } : row,
      ))
    })
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setWarning(null)
    startTransition(async () => {
      const r = await addCustomVariant({
        composition_id: form.composition_id,
        copy_style:     form.copy_style,
        layout_variant: form.layout_variant,
        persona:        form.persona,
        use_kind:       form.use_kind,
        postcard_size:  form.postcard_size,
      })
      if (!r.success) {
        setError(r.error ?? "Add failed")
        return
      }
      if (r.warning) setWarning(r.warning)
      // Page revalidates on save; show the new row optimistically too.
      setRows((prev) => [
        {
          variant_id:          r.variantId ?? `pending-${Date.now()}`,
          is_brokerage_scoped: true,
          composition_id:      form.composition_id,
          copy_style:          form.copy_style,
          layout_variant:      form.layout_variant,
          persona:             form.persona,
          use_kind:            form.use_kind,
          postcard_size:       form.postcard_size,
          is_active:           true,
          sends_count: 0, scans_count: 0, leads_count: 0,
          cost_spent_cents: 0, last_send_at: null,
        },
        ...prev,
      ])
    })
  }

  // Group rows by (persona × use_kind × size) for browseability.
  const grouped = new Map<string, VariantCatalogRow[]>()
  for (const r of rows) {
    const key = `${r.persona} · ${r.use_kind} · ${r.postcard_size}`
    const arr = grouped.get(key) ?? []
    arr.push(r)
    grouped.set(key, arr)
  }
  const groupKeys = [...grouped.keys()].sort()

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Bandit Catalog</h1>
        <p className="text-gray-600 mt-2">
          Every arm the Thompson sampler picks from. Platform arms (
          <span className="inline-block w-3 h-3 rounded-full bg-gray-300 align-middle mr-1" />)
          are shared across brokerages and read-only. Custom arms (
          <span className="inline-block w-3 h-3 rounded-full bg-blue-500 align-middle mr-1" />)
          are scoped to your brokerage; toggle their active state or add new ones below.
        </p>
      </header>

      {/* Add custom arm */}
      <section className="border border-gray-200 rounded-lg p-5 bg-white">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Add custom arm</h2>
        <p className="text-sm text-gray-600 mb-4">
          New arm enters the bandit pool on the next dispatch matching its
          (persona × use × size) cell. copy_style must match an entry in
          POSTCARD_COPY_STYLE_OVERLAYS in lib/direct-mail/draft-copy.ts —
          otherwise the prompt falls through to default and the arm won&apos;t
          differ from baseline (we&apos;ll warn you).
        </p>
        <form onSubmit={handleAdd} className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <label className="block">
            <span className="block text-xs text-gray-700 mb-1">Composition</span>
            <select value={form.composition_id} onChange={(e) => setForm((p) => ({ ...p, composition_id: e.target.value }))}
              className="w-full border rounded px-2 py-1">
              {COMPOSITION_PRESETS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs text-gray-700 mb-1">Copy style</span>
            <input list="copy-styles" value={form.copy_style}
              onChange={(e) => setForm((p) => ({ ...p, copy_style: e.target.value }))}
              className="w-full border rounded px-2 py-1 font-mono text-xs"
              placeholder="direct-fact" />
            <datalist id="copy-styles">
              {COPY_STYLE_PRESETS.map((s) => <option key={s} value={s} />)}
            </datalist>
          </label>
          <label className="block">
            <span className="block text-xs text-gray-700 mb-1">Layout variant</span>
            <input type="text" value={form.layout_variant}
              onChange={(e) => setForm((p) => ({ ...p, layout_variant: e.target.value }))}
              className="w-full border rounded px-2 py-1 font-mono text-xs" />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-700 mb-1">Persona</span>
            <select value={form.persona} onChange={(e) => setForm((p) => ({ ...p, persona: e.target.value }))}
              className="w-full border rounded px-2 py-1">
              {PERSONA_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs text-gray-700 mb-1">Use kind</span>
            <select value={form.use_kind} onChange={(e) => setForm((p) => ({ ...p, use_kind: e.target.value }))}
              className="w-full border rounded px-2 py-1">
              {USE_KIND_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs text-gray-700 mb-1">Postcard size</span>
            <select value={form.postcard_size} onChange={(e) => setForm((p) => ({ ...p, postcard_size: e.target.value }))}
              className="w-full border rounded px-2 py-1">
              <option value="4x6">4x6</option>
              <option value="6x9">6x9</option>
            </select>
          </label>
          <div className="md:col-span-3 flex justify-end">
            <button type="submit" disabled={pending}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 disabled:opacity-50">
              {pending ? "Adding…" : "Add custom arm"}
            </button>
          </div>
        </form>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        {warning && <p className="mt-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">⚠ {warning}</p>}
      </section>

      {/* Catalog browser */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Arm catalog (grouped by cohort)</h2>
        {groupKeys.length === 0 ? (
          <p className="text-sm text-gray-500 italic">
            No arms yet. The bandit materializes platform arms on the first dispatch for each (persona × use × size) — fire a farm-mail send to seed.
          </p>
        ) : (
          <div className="space-y-4">
            {groupKeys.map((groupKey) => {
              const groupRows = grouped.get(groupKey)!
              return (
                <details key={groupKey} className="border border-gray-200 rounded bg-white">
                  <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50">
                    {groupKey}
                    <span className="ml-2 text-xs text-gray-500">{groupRows.length} arm{groupRows.length === 1 ? "" : "s"}</span>
                  </summary>
                  <div className="overflow-x-auto px-4 pb-3">
                    <table className="min-w-full text-xs">
                      <thead>
                        <tr className="text-left text-gray-600">
                          <th className="py-1 pr-3">Scope</th>
                          <th className="py-1 pr-3">Composition</th>
                          <th className="py-1 pr-3">Copy style</th>
                          <th className="py-1 pr-3">Layout</th>
                          <th className="py-1 pr-3 text-right">Sends</th>
                          <th className="py-1 pr-3 text-right">Scans</th>
                          <th className="py-1 pr-3 text-right">Leads</th>
                          <th className="py-1 pr-3 text-right">Spend</th>
                          <th className="py-1 pr-3">Active</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groupRows.map((r) => (
                          <tr key={r.variant_id} className="border-t border-gray-100">
                            <td className="py-1.5 pr-3">
                              <span className={`inline-block w-2 h-2 rounded-full align-middle mr-1 ${
                                r.is_brokerage_scoped ? "bg-blue-500" : "bg-gray-300"
                              }`} />
                              {r.is_brokerage_scoped ? "custom" : "platform"}
                            </td>
                            <td className="py-1.5 pr-3 font-mono">{r.composition_id}</td>
                            <td className="py-1.5 pr-3">{r.copy_style}</td>
                            <td className="py-1.5 pr-3">{r.layout_variant}</td>
                            <td className="py-1.5 pr-3 text-right">{r.sends_count}</td>
                            <td className="py-1.5 pr-3 text-right">{r.scans_count}</td>
                            <td className="py-1.5 pr-3 text-right font-medium text-green-700">{r.leads_count}</td>
                            <td className="py-1.5 pr-3 text-right">${(r.cost_spent_cents / 100).toFixed(2)}</td>
                            <td className="py-1.5 pr-3">
                              {r.is_brokerage_scoped ? (
                                <button onClick={() => handleToggle(r.variant_id, r.is_active)} disabled={pending}
                                  className={`text-xs px-2 py-0.5 rounded border ${
                                    r.is_active ? "bg-green-50 text-green-800 border-green-200" : "bg-gray-50 text-gray-600 border-gray-200"
                                  } hover:opacity-80 disabled:opacity-50`}>
                                  {r.is_active ? "Active" : "Disabled"}
                                </button>
                              ) : (
                                <span className={`text-xs px-2 py-0.5 rounded ${r.is_active ? "bg-gray-100 text-gray-600" : "bg-gray-50 text-gray-400"}`}>
                                  {r.is_active ? "Active" : "Disabled"}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
