"use client"

import { useState, useTransition } from "react"
import {
  upsertDirectMailPreset,
  deactivatePreset,
  type PresetRow,
  type UpsertPresetInput,
} from "@/app/actions/direct-mail-presets"

export function PresetsClient({ initialPresets }: { initialPresets: PresetRow[] }) {
  const [presets, setPresets] = useState(initialPresets)
  const [editing, setEditing] = useState<PresetRow | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [violations, setViolations] = useState<string[] | null>(null)
  const [pending, startTransition] = useTransition()

  function handleSave(input: UpsertPresetInput, presetId?: string) {
    setError(null); setViolations(null)
    startTransition(async () => {
      const r = await upsertDirectMailPreset({ ...input, id: presetId })
      if (!r.success) {
        if (r.violations) setViolations(r.violations)
        setError(r.error ?? "Save failed")
        return
      }
      // Optimistic refresh by leaving the modal open with success
      setEditing(null)
      setShowCreate(false)
      // The page revalidates; force a synthetic update in-place too.
      if (presetId) {
        setPresets((prev) => prev.map((p) => p.id === presetId ? { ...p, ...input } as PresetRow : p))
      }
    })
  }

  function handleDeactivate(id: string) {
    setError(null)
    startTransition(async () => {
      const r = await deactivatePreset(id)
      if (!r.success) { setError(r.error ?? "Deactivate failed"); return }
      setPresets((prev) => prev.map((p) => p.id === id ? { ...p, is_active: false } : p))
    })
  }

  const active = presets.filter((p) => p.is_active)
  const inactive = presets.filter((p) => !p.is_active)

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Saved Campaign Presets</h1>
          <p className="text-gray-600 mt-2">
            Hand-tuned mailers that bypass the bandit. Use for high-stakes one-offs —
            anniversary blasts, listing-launch flagship pieces, agent-relocation
            announcements. The Fair Housing gate runs once at save time; future
            dispatches inherit the audit without re-running the AI gate.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700"
        >+ New preset</button>
      </header>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm">{error}</div>}
      {violations && violations.length > 0 && (
        <div className="p-3 bg-amber-50 border border-amber-200 text-amber-900 rounded text-sm">
          <div className="font-medium mb-1">Compliance gate blocked the copy:</div>
          <ul className="list-disc list-inside text-xs">
            {violations.map((v, i) => <li key={i}>{v}</li>)}
          </ul>
        </div>
      )}

      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Active presets ({active.length})</h2>
        {active.length === 0 ? (
          <p className="text-sm text-gray-500 italic">No active presets yet. Click &ldquo;New preset&rdquo; to build one.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {active.map((p) => (
              <PresetCard
                key={p.id} preset={p}
                onEdit={() => setEditing(p)}
                onDeactivate={() => handleDeactivate(p.id)}
                pending={pending}
              />
            ))}
          </div>
        )}
      </section>

      {inactive.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-700 mb-3">Inactive ({inactive.length})</h2>
          <ul className="text-sm text-gray-500 space-y-1">
            {inactive.map((p) => (
              <li key={p.id}>{p.name} · {p.piece_type} {p.postcard_size ? `· ${p.postcard_size}` : ""}</li>
            ))}
          </ul>
        </section>
      )}

      {(showCreate || editing) && (
        <PresetEditor
          initial={editing}
          onClose={() => { setEditing(null); setShowCreate(false); setError(null); setViolations(null) }}
          onSave={handleSave}
          pending={pending}
        />
      )}
    </div>
  )
}

function PresetCard({ preset, onEdit, onDeactivate, pending }: {
  preset: PresetRow; onEdit: () => void; onDeactivate: () => void; pending: boolean
}) {
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-900">{preset.name}</h3>
          <div className="flex flex-wrap gap-1 mt-1">
            <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700">{preset.piece_type}</span>
            {preset.postcard_size && <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700">{preset.postcard_size}</span>}
            {preset.composition_id && <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700 font-mono">{preset.composition_id}</span>}
            {preset.compliance_event_id && <span className="text-xs px-2 py-0.5 rounded bg-green-50 text-green-700">Compliance: passed</span>}
          </div>
          {preset.piece_type === "postcard" ? (
            <p className="mt-2 text-sm text-gray-700 line-clamp-2">{preset.locked_headline} — {preset.locked_body}</p>
          ) : (
            <p className="mt-2 text-sm text-gray-700 line-clamp-2">{preset.locked_letter_body?.slice(0, 160)}…</p>
          )}
        </div>
      </div>
      <div className="flex gap-2 mt-3 justify-end">
        <button onClick={onEdit} disabled={pending}
          className="text-xs px-3 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50">Edit</button>
        <button onClick={onDeactivate} disabled={pending}
          className="text-xs px-3 py-1 border border-gray-200 rounded text-red-600 hover:bg-red-50 disabled:opacity-50">Deactivate</button>
      </div>
    </div>
  )
}

function PresetEditor({ initial, onClose, onSave, pending }: {
  initial: PresetRow | null
  onClose: () => void
  onSave: (input: UpsertPresetInput, presetId?: string) => void
  pending: boolean
}) {
  const [pieceType, setPieceType]       = useState<"postcard" | "letter">(initial?.piece_type ?? "postcard")
  const [name, setName]                 = useState(initial?.name ?? "")
  const [size, setSize]                 = useState<"4x6" | "6x9">(initial?.postcard_size ?? "4x6")
  const [composition, setComposition]   = useState(initial?.composition_id ?? "PostcardFront4x6")
  const [headline, setHeadline]         = useState(initial?.locked_headline ?? "")
  const [body, setBody]                 = useState(initial?.locked_body ?? "")
  const [cta, setCta]                   = useState(initial?.locked_cta ?? "")
  const [statusBadge, setStatusBadge]   = useState(initial?.status_badge ?? "")
  const [photoUrl, setPhotoUrl]         = useState(initial?.property_photo_url ?? "")
  const [pullQuote, setPullQuote]       = useState(initial?.pull_quote ?? "")
  const [greeting, setGreeting]         = useState(initial?.locked_letter_greeting ?? "Hi {{first_name}},")
  const [letterBody, setLetterBody]     = useState(initial?.locked_letter_body ?? "")
  const [signoff, setSignoff]           = useState(initial?.locked_letter_signoff ?? "")
  const [fallbackTpl, setFallbackTpl]   = useState(initial?.fallback_template_id ?? "")

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const input: UpsertPresetInput = {
      name,
      piece_type:           pieceType,
      postcard_size:        pieceType === "postcard" ? size : null,
      composition_id:       pieceType === "postcard" ? composition : null,
      locked_headline:      pieceType === "postcard" ? headline : null,
      locked_body:          pieceType === "postcard" ? body : null,
      locked_cta:           pieceType === "postcard" ? cta : null,
      status_badge:         pieceType === "postcard" ? statusBadge || null : null,
      property_photo_url:   pieceType === "postcard" ? photoUrl  || null : null,
      pull_quote:           pieceType === "postcard" ? pullQuote || null : null,
      locked_letter_greeting: pieceType === "letter" ? greeting : null,
      locked_letter_body:     pieceType === "letter" ? letterBody : null,
      locked_letter_signoff:  pieceType === "letter" ? signoff : null,
      fallback_template_id:   fallbackTpl || null,
    }
    onSave(input, initial?.id)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 overflow-y-auto">
      <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-xl max-w-3xl w-full p-6 my-6 space-y-4">
        <header className="flex justify-between items-center">
          <h2 className="text-lg font-semibold text-gray-900">{initial ? "Edit preset" : "New preset"}</h2>
          <button type="button" onClick={onClose} className="text-2xl text-gray-400 hover:text-gray-700">×</button>
        </header>

        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="block text-xs text-gray-700 mb-1">Name</span>
            <input required value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Anniversary Blast" className="w-full border rounded px-3 py-1.5" />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-700 mb-1">Piece type</span>
            <select value={pieceType} onChange={(e) => setPieceType(e.target.value as "postcard" | "letter")}
              className="w-full border rounded px-3 py-1.5">
              <option value="postcard">Postcard</option>
              <option value="letter">Letter</option>
            </select>
          </label>
        </div>

        {pieceType === "postcard" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">
                <span className="block text-xs text-gray-700 mb-1">Size</span>
                <select value={size} onChange={(e) => {
                    const newSize = e.target.value as "4x6" | "6x9"
                    setSize(newSize)
                    setComposition(newSize === "6x9" ? "PostcardFront6x9" : "PostcardFront4x6")
                  }}
                  className="w-full border rounded px-3 py-1.5">
                  <option value="4x6">4×6</option>
                  <option value="6x9">6×9</option>
                </select>
              </label>
              <label className="text-sm">
                <span className="block text-xs text-gray-700 mb-1">Composition</span>
                <select value={composition} onChange={(e) => setComposition(e.target.value)}
                  className="w-full border rounded px-3 py-1.5 font-mono text-xs">
                  <option value="PostcardFront4x6">PostcardFront4x6</option>
                  <option value="PostcardFront6x9">PostcardFront6x9</option>
                </select>
              </label>
            </div>
            <label className="text-sm block">
              <span className="block text-xs text-gray-700 mb-1">Headline</span>
              <input required value={headline} onChange={(e) => setHeadline(e.target.value)}
                className="w-full border rounded px-3 py-1.5" />
            </label>
            <label className="text-sm block">
              <span className="block text-xs text-gray-700 mb-1">Body</span>
              <textarea required rows={3} value={body} onChange={(e) => setBody(e.target.value)}
                className="w-full border rounded px-3 py-1.5" />
            </label>
            <label className="text-sm block">
              <span className="block text-xs text-gray-700 mb-1">CTA</span>
              <input required value={cta} onChange={(e) => setCta(e.target.value)}
                className="w-full border rounded px-3 py-1.5" />
            </label>
            {size === "6x9" && (
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm">
                  <span className="block text-xs text-gray-700 mb-1">Status badge (e.g. JUST SOLD)</span>
                  <input value={statusBadge} onChange={(e) => setStatusBadge(e.target.value)}
                    className="w-full border rounded px-3 py-1.5" />
                </label>
                <label className="text-sm">
                  <span className="block text-xs text-gray-700 mb-1">Property photo URL</span>
                  <input type="url" value={photoUrl} onChange={(e) => setPhotoUrl(e.target.value)}
                    placeholder="https://..." className="w-full border rounded px-3 py-1.5" />
                </label>
                <label className="text-sm col-span-2">
                  <span className="block text-xs text-gray-700 mb-1">Pull quote (back side)</span>
                  <input value={pullQuote} onChange={(e) => setPullQuote(e.target.value)}
                    className="w-full border rounded px-3 py-1.5" />
                </label>
              </div>
            )}
          </>
        )}

        {pieceType === "letter" && (
          <>
            <label className="text-sm block">
              <span className="block text-xs text-gray-700 mb-1">Greeting (supports {"{{first_name}}"})</span>
              <input value={greeting} onChange={(e) => setGreeting(e.target.value)}
                className="w-full border rounded px-3 py-1.5" />
            </label>
            <label className="text-sm block">
              <span className="block text-xs text-gray-700 mb-1">Letter body (paragraphs separated by blank lines)</span>
              <textarea required rows={8} value={letterBody} onChange={(e) => setLetterBody(e.target.value)}
                className="w-full border rounded px-3 py-1.5" />
            </label>
            <label className="text-sm block">
              <span className="block text-xs text-gray-700 mb-1">Signoff</span>
              <input value={signoff} onChange={(e) => setSignoff(e.target.value)}
                className="w-full border rounded px-3 py-1.5" />
            </label>
          </>
        )}

        <label className="text-sm block">
          <span className="block text-xs text-gray-700 mb-1">Lob fallback template id (used when Remotion render fails)</span>
          <input value={fallbackTpl} onChange={(e) => setFallbackTpl(e.target.value)}
            placeholder="tmpl_..." className="w-full border rounded px-3 py-1.5 font-mono text-xs" />
        </label>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 border rounded text-sm hover:bg-gray-50">Cancel</button>
          <button type="submit" disabled={pending}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
            {pending ? "Running compliance gate…" : (initial ? "Save changes" : "Run gate + save")}
          </button>
        </div>
      </form>
    </div>
  )
}
