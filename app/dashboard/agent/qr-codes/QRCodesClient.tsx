'use client'

import { useState, useTransition, useEffect, useRef } from 'react'

interface QRCodeRow {
  id: string
  slug: string
  label: string
  purpose: string | null
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
  label: string
  purpose: string
}

const PURPOSES = [
  'Open House',
  'Listing Inquiry',
  'General Contact',
  'Referral',
  'Event',
  'Other',
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
  const [createForm, setCreateForm] = useState<CreateFormState>({ label: '', purpose: 'General Contact' })
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
    import('qrcode').then((QRCode) => {
      QRCode.toDataURL(getQRUrl(slug), { width: 400, margin: 2 }, (_err: Error | null | undefined, url: string) => {
        const a = document.createElement('a')
        a.href = url
        a.download = `qr-${slug}.png`
        a.click()
      })
    })
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreateError(null)
    if (!createForm.label.trim()) {
      setCreateError('Label is required.')
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
        setCreateForm({ label: '', purpose: 'General Contact' })
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
                  {code.purpose && (
                    <p className="text-xs text-muted-foreground">{code.purpose}</p>
                  )}
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    code.is_active
                      ? 'bg-green-100 text-green-700'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {code.is_active ? 'Active' : 'Inactive'}
                </span>
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
    </div>
  )
}
