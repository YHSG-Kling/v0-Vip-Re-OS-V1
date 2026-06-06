'use client'

import { useState, useTransition, useEffect, useRef } from 'react'

interface QRCodeRow {
  id: string
  slug: string
  label: string
  purpose: string | null
  target_url?: string | null
  destination_type?: string | null
  listing_id?: string | null
  scan_count: number
  lead_count: number
  is_active: boolean
  created_at: string
}

interface Props {
  qrCodes: QRCodeRow[]
  agentUserId: string
  brokerageId: string
}

interface CreateFormState {
  label:           string
  purpose:         string
  destinationType: string
  targetUrl:       string
  listingId:       string
}

const PURPOSES = [
  'Open House',
  'Listing Inquiry',
  'General Contact',
  'Referral',
  'Event',
  'Other',
]

/** m148 destination_type enum + human labels and per-type help text.
 *  Order matches the most-common-first UX heuristic for real estate. */
const DESTINATION_OPTIONS: Array<{
  value: string
  label: string
  help:  string
  needsExternalUrl: boolean   // if true, the user MUST supply a target URL
}> = [
  { value: '',                  label: '— Choose a destination —',           help: 'Pick how scanners land.', needsExternalUrl: false },
  { value: 'landing_page',      label: 'Branded landing page',               help: 'App-hosted lead capture page at /qr/{slug}/landing.', needsExternalUrl: false },
  { value: 'cma_form',          label: 'CMA / home value form',              help: 'App-hosted seller form at /forms/cma.', needsExternalUrl: false },
  { value: 'book_meeting',      label: 'Book a meeting (calendar)',          help: 'App-hosted calendar at /book.', needsExternalUrl: false },
  { value: 'listing_detail',    label: 'Listing detail page',                help: 'Routes to the specific listing — provide listing id below.', needsExternalUrl: false },
  { value: 'video_avatar_tour', label: 'Avatar video tour',                  help: 'Routes to a hosted video URL (paste the URL).', needsExternalUrl: true },
  { value: 'podcast_episode',   label: 'Podcast episode',                    help: 'Routes to a hosted podcast page (paste the URL).', needsExternalUrl: true },
  { value: 'anniversary_video', label: 'Anniversary / milestone video',      help: 'Custom celebration video URL.', needsExternalUrl: true },
  { value: 'other',             label: 'Other (custom URL)',                 help: 'Free-form external URL.', needsExternalUrl: true },
]

// ── Tiny inline QR renderer using qrcode library ────────────────────────────
function QRCanvas({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    import('qrcode').then((QRCode) => {
      if (cancelled || !canvasRef.current) return
      QRCode.toCanvas(canvasRef.current, url, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      })
    })
    return () => { cancelled = true }
  }, [url])

  return <canvas ref={canvasRef} aria-label={`QR code for ${url}`} />
}

export default function QRCodesClient({ qrCodes: initialCodes, agentUserId, brokerageId }: Props) {
  const [codes, setCodes] = useState<QRCodeRow[]>(initialCodes)
  const [showCreate, setShowCreate] = useState(false)
  const [selectedCode, setSelectedCode] = useState<QRCodeRow | null>(null)
  const [editingCode, setEditingCode] = useState<QRCodeRow | null>(null)
  const [createForm, setCreateForm] = useState<CreateFormState>({
    label: '', purpose: 'General Contact', destinationType: '', targetUrl: '', listingId: '',
  })
  const [createError, setCreateError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''

  function getQRUrl(slug: string) {
    return `${baseUrl}/api/qr/scan?slug=${slug}`
  }

  function getLandingUrl(slug: string) {
    return `${baseUrl}/qr/${slug}`
  }

  function handleCopy(slug: string) {
    navigator.clipboard.writeText(getLandingUrl(slug))
    setCopied(slug)
    setTimeout(() => setCopied(null), 1800)
  }

  function handleDownload(slug: string) {
    import('qrcode').then(async (QRCode) => {
      const url = await QRCode.toDataURL(getQRUrl(slug), { width: 400, margin: 2 })
      const a = document.createElement('a')
      a.href = url
      a.download = `qr-${slug}.png`
      a.click()
    })
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreateError(null)
    if (!createForm.label.trim()) {
      setCreateError('Label is required.')
      return
    }
    if (!createForm.destinationType) {
      setCreateError('Pick a destination type so the platform knows where scanners land.')
      return
    }
    const opt = DESTINATION_OPTIONS.find((o) => o.value === createForm.destinationType)
    if (opt?.needsExternalUrl && !createForm.targetUrl.trim()) {
      setCreateError(`The "${opt.label}" destination needs a target URL — paste the link scanners should land on.`)
      return
    }
    if (createForm.destinationType === 'listing_detail' && !createForm.listingId.trim() && !createForm.targetUrl.trim()) {
      setCreateError('Listing detail destination needs either a listing id or an explicit target URL.')
      return
    }

    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/qr-codes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: createForm.label.trim(),
            purpose: createForm.purpose,
            destinationType: createForm.destinationType,
            targetUrl: createForm.targetUrl.trim() || undefined,
            listingId: createForm.listingId.trim() || undefined,
            agentUserId,
            brokerageId,
          }),
        })
        const json = (await res.json()) as { success: boolean; qrCode?: QRCodeRow; error?: string }
        if (!json.success || !json.qrCode) {
          setCreateError(json.error ?? 'Failed to create QR code.')
          return
        }
        setCodes((prev) => [json.qrCode!, ...prev])
        setShowCreate(false)
        setCreateForm({ label: '', purpose: 'General Contact', destinationType: '', targetUrl: '', listingId: '' })
      } catch {
        setCreateError('Network error. Please try again.')
      }
    })
  }

  function handleEditSave(edited: QRCodeRow) {
    setCreateError(null)
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/qr-codes', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: edited.id,
            brokerageId,
            label: edited.label,
            purpose: edited.purpose,
            destinationType: edited.destination_type,
            targetUrl: edited.target_url,
            isActive: edited.is_active,
          }),
        })
        const json = (await res.json()) as { success: boolean; qrCode?: QRCodeRow; error?: string }
        if (!json.success || !json.qrCode) {
          setCreateError(json.error ?? 'Update failed')
          return
        }
        setCodes((prev) => prev.map((c) => c.id === edited.id ? json.qrCode! : c))
        setEditingCode(null)
      } catch {
        setCreateError('Network error. Please try again.')
      }
    })
  }

  return (
    <div className="p-6 space-y-6 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">QR Codes</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Generate QR codes to capture leads at open houses, listings, and events.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
        >
          + Create QR Code
        </button>
      </div>

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background rounded-lg border border-border p-6 w-full max-w-md shadow-xl">
            <h2 className="text-lg font-semibold text-foreground mb-4">Create QR Code</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">
                  Label <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  value={createForm.label}
                  onChange={(e) => setCreateForm((p) => ({ ...p, label: e.target.value }))}
                  placeholder="e.g. 123 Main St Open House"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">Purpose</label>
                <select
                  value={createForm.purpose}
                  onChange={(e) => setCreateForm((p) => ({ ...p, purpose: e.target.value }))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {PURPOSES.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>

              {/* Wave 36 — destination_type + target_url. Without these the
                  printed QR can't actually route anywhere (qr_codes.target_url
                  is NOT NULL). */}
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">
                  Destination <span className="text-destructive">*</span>
                </label>
                <select
                  value={createForm.destinationType}
                  onChange={(e) => setCreateForm((p) => ({ ...p, destinationType: e.target.value }))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {DESTINATION_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                {createForm.destinationType && (
                  <p className="text-xs text-muted-foreground">
                    {DESTINATION_OPTIONS.find((o) => o.value === createForm.destinationType)?.help}
                  </p>
                )}
              </div>

              {/* Target URL field — required for external destination types,
                  optional override for app-hosted ones. */}
              {(() => {
                const opt = DESTINATION_OPTIONS.find((o) => o.value === createForm.destinationType)
                if (!createForm.destinationType) return null
                const labelText = opt?.needsExternalUrl
                  ? <>Target URL <span className="text-destructive">*</span></>
                  : <>Target URL <span className="text-muted-foreground">(optional — overrides the app-hosted default)</span></>
                return (
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-foreground">{labelText}</label>
                    <input
                      type="url"
                      value={createForm.targetUrl}
                      onChange={(e) => setCreateForm((p) => ({ ...p, targetUrl: e.target.value }))}
                      placeholder="https://..."
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                )
              })()}

              {/* Listing id — only for listing_detail destination. */}
              {createForm.destinationType === 'listing_detail' && (
                <div className="space-y-1">
                  <label className="text-sm font-medium text-foreground">Listing ID</label>
                  <input
                    type="text"
                    value={createForm.listingId}
                    onChange={(e) => setCreateForm((p) => ({ ...p, listingId: e.target.value }))}
                    placeholder="UUID of the listing"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              )}

              {createError && (
                <p role="alert" className="text-sm text-destructive">{createError}</p>
              )}
              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={() => { setShowCreate(false); setCreateError(null) }}
                  className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-muted transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  {isPending ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Analytics / detail drawer */}
      {selectedCode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background rounded-lg border border-border p-6 w-full max-w-lg shadow-xl space-y-4">
            <div className="flex items-start justify-between">
              <h2 className="text-lg font-semibold text-foreground">{selectedCode.label}</h2>
              <button
                onClick={() => setSelectedCode(null)}
                className="text-muted-foreground hover:text-foreground text-xl leading-none"
                aria-label="Close"
              >
                &times;
              </button>
            </div>
            <div className="flex justify-center">
              <QRCanvas url={getQRUrl(selectedCode.slug)} />
            </div>
            <div className="grid grid-cols-2 gap-4 text-center">
              <div className="rounded-md border border-border p-4">
                <p className="text-3xl font-bold text-foreground">{selectedCode.scan_count}</p>
                <p className="text-xs text-muted-foreground mt-1">Total Scans</p>
              </div>
              <div className="rounded-md border border-border p-4">
                <p className="text-3xl font-bold text-foreground">{selectedCode.lead_count}</p>
                <p className="text-xs text-muted-foreground mt-1">Contacts Created</p>
              </div>
            </div>
            <div className="text-sm text-muted-foreground break-all">
              {getLandingUrl(selectedCode.slug)}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => handleCopy(selectedCode.slug)}
                className="flex-1 rounded-md border border-border px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
              >
                {copied === selectedCode.slug ? 'Copied!' : 'Copy Link'}
              </button>
              <button
                onClick={() => handleDownload(selectedCode.slug)}
                className="flex-1 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
              >
                Download QR
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Grid of cards */}
      {codes.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          No QR codes yet. Create one to get started.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {codes.map((code) => (
            <div
              key={code.id}
              className="rounded-lg border border-border bg-card p-4 space-y-3"
            >
              <div className="flex items-start justify-between">
                <div className="space-y-0.5">
                  <p className="font-semibold text-foreground text-sm leading-tight text-pretty">
                    {code.label}
                  </p>
                  {code.destination_type && (
                    <p className="text-xs text-muted-foreground">
                      {DESTINATION_OPTIONS.find((o) => o.value === code.destination_type)?.label ?? code.destination_type}
                    </p>
                  )}
                  {code.target_url && (
                    <p className="text-[10px] text-muted-foreground truncate" title={code.target_url}>
                      → {code.target_url}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      code.is_active
                        ? 'bg-green-100 text-green-700'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {code.is_active ? 'Active' : 'Inactive'}
                  </span>
                  <button
                    onClick={() => setEditingCode(code)}
                    className="text-[11px] text-blue-600 hover:underline"
                  >
                    Edit URL
                  </button>
                </div>
              </div>

              <div className="flex gap-4 text-center">
                <div className="flex-1">
                  <p className="text-xl font-bold text-foreground">{code.scan_count}</p>
                  <p className="text-xs text-muted-foreground">Scans</p>
                </div>
                <div className="flex-1">
                  <p className="text-xl font-bold text-foreground">{code.lead_count}</p>
                  <p className="text-xs text-muted-foreground">Contacts</p>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => handleCopy(code.slug)}
                  className="flex-1 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
                >
                  {copied === code.slug ? 'Copied!' : 'Copy URL'}
                </button>
                <button
                  onClick={() => handleDownload(code.slug)}
                  className="flex-1 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
                >
                  Download
                </button>
                <button
                  onClick={() => setSelectedCode(code)}
                  className="flex-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
                >
                  Analytics
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Wave 36 — edit modal. The agent can repoint a printed QR's URL
          without reprinting the postcard. /api/qr/scan reads target_url
          fresh on every scan, so updating here reroutes every printed
          copy in the wild on the NEXT scan. */}
      {editingCode && (
        <EditQRModal
          code={editingCode}
          onClose={() => setEditingCode(null)}
          onSave={handleEditSave}
          pending={isPending}
          error={createError}
        />
      )}
    </div>
  )
}

function EditQRModal({
  code,
  onClose,
  onSave,
  pending,
  error,
}: {
  code:    QRCodeRow
  onClose: () => void
  onSave:  (edited: QRCodeRow) => void
  pending: boolean
  error:   string | null
}) {
  const [label, setLabel]         = useState(code.label)
  const [destType, setDestType]   = useState(code.destination_type ?? '')
  const [targetUrl, setTargetUrl] = useState(code.target_url ?? '')
  const [isActive, setIsActive]   = useState(code.is_active)
  const [purpose, setPurpose]     = useState(code.purpose ?? 'General Contact')

  const opt = DESTINATION_OPTIONS.find((o) => o.value === destType)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    onSave({
      ...code,
      label,
      destination_type: destType || null,
      target_url:       targetUrl.trim(),
      is_active:        isActive,
      purpose,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-lg border border-border p-6 w-full max-w-md shadow-xl">
        <h2 className="text-lg font-semibold text-foreground mb-1">Edit QR code</h2>
        <p className="text-xs text-muted-foreground mb-4">
          Updating the URL or destination type reroutes every printed copy on the next scan
          — no need to reprint postcards.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Label</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Purpose</label>
            <select
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Destination type</label>
            <select
              value={destType}
              onChange={(e) => setDestType(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {DESTINATION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {opt && <p className="text-xs text-muted-foreground">{opt.help}</p>}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Target URL</label>
            <input
              type="url"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://..."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4"
            />
            <span className="text-foreground">Active (scans redirect; uncheck to pause)</span>
          </label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-muted transition-colors"
            >Cancel</button>
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
            >{pending ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
