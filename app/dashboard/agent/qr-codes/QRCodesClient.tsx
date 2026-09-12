'use client'

import { useState, useTransition, useEffect, useRef } from 'react'
import { setQrCodeActive } from '@/app/actions/qr-management'
import type {
  QrManagerCode,
  QrCampaignRollup,
  QrLinkableCampaign,
  QrScopeKind,
} from '@/app/actions/qr-management'

type QRCodeRow = QrManagerCode

interface Props {
  qrCodes: QRCodeRow[]
  /** Scans/leads rolled up by the FORWARD campaign link (qr_codes.marketing_campaign_id). */
  campaigns: QrCampaignRollup[]
  /** Campaigns a new code may be linked to (this brokerage's). */
  linkableCampaigns: QrLinkableCampaign[]
  /** qr_codes.purpose CHECK vocabulary, handed down by the page. */
  purposes: string[]
  scope: QrScopeKind
  scopeLabel: string
  /** agents.id — null for a broker/admin with no agent record; creation needs one. */
  agentUserId: string | null
  brokerageId: string
}

/** "Keep an eye on all active, inactive codes" — the board's state filter. */
type StateFilter = 'all' | 'active' | 'inactive' | 'expired'

function isExpired(code: QRCodeRow): boolean {
  return !!code.expires_at && new Date(code.expires_at).getTime() <= Date.now()
}

interface CreateFormState {
  label:           string
  purpose:         string
  destinationType: string
  targetUrl:       string
  listingId:       string
  campaignId:      string
  expiresAt:       string
}

/** "open_house" → "Open house". The stored value is the CHECK vocabulary; this
 *  is only how it reads in a dropdown. */
function humanizePurpose(value: string): string {
  const spaced = value.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

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

export default function QRCodesClient({
  qrCodes: initialCodes,
  campaigns,
  linkableCampaigns,
  purposes,
  scope,
  scopeLabel,
  agentUserId,
  brokerageId,
}: Props) {
  const [codes, setCodes] = useState<QRCodeRow[]>(initialCodes)
  const [showCreate, setShowCreate] = useState(false)
  const [selectedCode, setSelectedCode] = useState<QRCodeRow | null>(null)
  const [editingCode, setEditingCode] = useState<QRCodeRow | null>(null)
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [createForm, setCreateForm] = useState<CreateFormState>({
    label: '', purpose: 'general', destinationType: '', targetUrl: '', listingId: '',
    campaignId: '', expiresAt: '',
  })
  const [createError, setCreateError] = useState<string | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const counts = {
    all:      codes.length,
    active:   codes.filter((c) => c.is_active).length,
    inactive: codes.filter((c) => !c.is_active).length,
    expired:  codes.filter(isExpired).length,
  }

  const visibleCodes = codes.filter((c) => {
    if (stateFilter === 'active')   return c.is_active
    if (stateFilter === 'inactive') return !c.is_active
    if (stateFilter === 'expired')  return isExpired(c)
    return true
  })

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
            // The campaign link is written HERE, at mint time — it is the fact
            // the campaign rollup above measures against.
            marketingCampaignId: createForm.campaignId || undefined,
            // Sent as an instant so /api/qr/scan's expiry comparison is
            // unambiguous; the input only collects a date.
            expiresAt: createForm.expiresAt
              ? new Date(`${createForm.expiresAt}T23:59:59`).toISOString()
              : undefined,
            agentUserId,
            brokerageId,
          }),
        })
        const json = (await res.json()) as { success: boolean; qrCode?: Partial<QRCodeRow>; error?: string }
        if (!json.success || !json.qrCode) {
          setCreateError(json.error ?? 'Failed to create QR code.')
          return
        }
        // The mint endpoint returns the qr_codes row only — the campaign
        // linkages and the owner name are resolved server-side by
        // loadQrCodesForCaller, so a freshly minted card shows them as absent
        // (which is the truth) until the next load.
        // The endpoint returns a PARTIAL row, so the defaults must fill the gaps
        // rather than be overwritten by keys the response does not carry. A
        // manually created code is named by the label the person just typed, so
        // display_name is that label until the next load resolves it properly.
        const minted = json.qrCode
        setCodes((prev) => [{
          expires_at: null, marketing_campaign_id: null, campaign_name: null,
          mail_campaign_name: null, agent_id: agentUserId, agent_name: null,
          display_name: minted.label ?? createForm.label.trim(),
          ...minted,
        } as QRCodeRow, ...prev])
        setShowCreate(false)
        setCreateForm({
          label: '', purpose: 'general', destinationType: '', targetUrl: '', listingId: '',
          campaignId: '', expiresAt: '',
        })
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
        const json = (await res.json()) as { success: boolean; qrCode?: Partial<QRCodeRow>; error?: string }
        if (!json.success || !json.qrCode) {
          setCreateError(json.error ?? 'Update failed')
          return
        }
        // MERGE, don't replace: the PATCH response carries the qr_codes row and
        // not the campaign linkages this board resolves separately.
        setCodes((prev) => prev.map((c) => c.id === edited.id ? { ...c, ...(json.qrCode as QRCodeRow) } : c))
        setEditingCode(null)
      } catch {
        setCreateError('Network error. Please try again.')
      }
    })
  }

  /** Pause / resume — the reversible half of "keep an eye on active AND inactive". */
  function handleToggleActive(code: QRCodeRow) {
    setToggleError(null)
    startTransition(async () => {
      const res = await setQrCodeActive({ qrCodeId: code.id, isActive: !code.is_active })
      if (!res.ok) {
        setToggleError(res.error)
        return
      }
      setCodes((prev) => prev.map((c) => c.id === code.id ? { ...c, is_active: res.isActive } : c))
    })
  }

  return (
    <div className="p-6 space-y-6 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">QR Codes</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {scopeLabel} — active and paused. Generate codes to capture leads at open
            houses, listings, and events.
          </p>
        </div>
        <div className="text-right">
          <button
            onClick={() => setShowCreate(true)}
            disabled={!agentUserId}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            + Create QR Code
          </button>
          {!agentUserId && (
            <p className="text-xs text-muted-foreground mt-1 max-w-[16rem]">
              A new code is filed against an agent record; your account has none in
              this brokerage, so you can manage codes here but not mint one.
            </p>
          )}
        </div>
      </div>

      {/* State filter — inactive codes are VISIBLE, not hidden. */}
      <div className="flex flex-wrap gap-2">
        {(['all', 'active', 'inactive', 'expired'] as StateFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setStateFilter(f)}
            className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
              stateFilter === f
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:bg-muted'
            }`}
          >
            {f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)} ({counts[f]})
          </button>
        ))}
      </div>

      {toggleError && (
        <p role="alert" className="text-sm text-destructive">{toggleError}</p>
      )}

      {/* Scans per campaign — the FORWARD link only (qr_codes.marketing_campaign_id).
          A code carried by a mailer is linked the other way round
          (direct_mail_campaigns.qr_code_id) and is named on its own card; the two
          are different facts and are deliberately not summed together. */}
      {campaigns.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Scans by marketing campaign</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground text-left">
                  <th className="py-1 pr-4 font-medium">Campaign</th>
                  <th className="py-1 pr-4 font-medium">Codes</th>
                  <th className="py-1 pr-4 font-medium">Scans</th>
                  <th className="py-1 font-medium">Contacts</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.campaignId} className="border-t border-border">
                    <td className="py-1.5 pr-4 text-foreground">{c.campaignName}</td>
                    <td className="py-1.5 pr-4 text-muted-foreground">{c.codeCount}</td>
                    <td className="py-1.5 pr-4 font-semibold text-foreground">{c.scans}</td>
                    <td className="py-1.5 font-semibold text-foreground">{c.leads}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
                  {purposes.map((p) => (
                    <option key={p} value={p}>{humanizePurpose(p)}</option>
                  ))}
                </select>
              </div>

              {/* Campaign link — the FORWARD link (qr_codes.marketing_campaign_id),
                  written at mint time. Without it the campaign's scan rollup can
                  only ever count codes that reached it through a mail piece. */}
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">Marketing campaign</label>
                <select
                  value={createForm.campaignId}
                  onChange={(e) => setCreateForm((p) => ({ ...p, campaignId: e.target.value }))}
                  disabled={linkableCampaigns.length === 0}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                >
                  <option value="">— Not linked to a campaign —</option>
                  {linkableCampaigns.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {linkableCampaigns.length === 0
                    ? 'No marketing campaigns in this brokerage yet.'
                    : 'Scans on this code roll up to the campaign you pick.'}
                </p>
              </div>

              {/* Expiry — enforced at scan time by /api/qr/scan. */}
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">
                  Expires <span className="text-muted-foreground">(optional)</span>
                </label>
                <input
                  type="date"
                  value={createForm.expiresAt}
                  onChange={(e) => setCreateForm((p) => ({ ...p, expiresAt: e.target.value }))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">
                  After this date a scan gets a plain "this code has expired" page instead of the destination.
                </p>
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
              <h2 className="text-lg font-semibold text-foreground">{selectedCode.display_name}</h2>
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
      {visibleCodes.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          {codes.length === 0
            ? 'No QR codes yet. Create one to get started.'
            : `No ${stateFilter} QR codes.`}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {visibleCodes.map((code) => (
            <div
              key={code.id}
              className="rounded-lg border border-border bg-card p-4 space-y-3"
            >
              <div className="flex items-start justify-between">
                <div className="space-y-0.5">
                  <p className="font-semibold text-foreground text-sm leading-tight text-pretty">
                    {code.display_name}
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
                  {scope !== 'agent' && (
                    <p className="text-[10px] text-muted-foreground">
                      {code.agent_name ?? 'Unassigned'}
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
                  {isExpired(code) && (
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-800">
                      Expired
                    </span>
                  )}
                  <button
                    onClick={() => setEditingCode(code)}
                    className="text-[11px] text-blue-600 hover:underline"
                  >
                    Edit URL
                  </button>
                </div>
              </div>

              {/* Campaign linkage, both directions, named for what each one is. */}
              <div className="space-y-0.5 text-[11px]">
                {code.campaign_name ? (
                  <p className="text-foreground">
                    Campaign: <span className="font-medium">{code.campaign_name}</span>
                  </p>
                ) : (
                  <p className="text-muted-foreground">Not linked to a marketing campaign</p>
                )}
                {code.mail_campaign_name && (
                  <p className="text-foreground">
                    On mailer: <span className="font-medium">{code.mail_campaign_name}</span>
                  </p>
                )}
                {code.expires_at && (
                  <p className={isExpired(code) ? 'text-amber-700' : 'text-muted-foreground'}>
                    {isExpired(code) ? 'Expired ' : 'Expires '}
                    {new Date(code.expires_at).toLocaleDateString()}
                  </p>
                )}
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

              <button
                onClick={() => handleToggleActive(code)}
                disabled={isPending}
                className="w-full rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted disabled:opacity-50 transition-colors"
              >
                {code.is_active ? 'Pause (stop redirecting scans)' : 'Resume (redirect scans again)'}
              </button>
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
          purposes={purposes}
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
  purposes,
  onClose,
  onSave,
  pending,
  error,
}: {
  code:     QRCodeRow
  purposes: string[]
  onClose:  () => void
  onSave:   (edited: QRCodeRow) => void
  pending:  boolean
  error:    string | null
}) {
  const [label, setLabel]         = useState(code.label)
  const [destType, setDestType]   = useState(code.destination_type ?? '')
  const [targetUrl, setTargetUrl] = useState(code.target_url ?? '')
  const [isActive, setIsActive]   = useState(code.is_active)
  const [purpose, setPurpose]     = useState(code.purpose ?? 'general')

  const opt = DESTINATION_OPTIONS.find((o) => o.value === destType)
  /** `<kind>:<uuid>` is a minter's lookup key, not a name a person chose. */
  const isGeneratedKey = /^[a-z_]+:[0-9a-f-]{8,}$/i.test(code.label)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    onSave({
      ...code,
      label: isGeneratedKey ? code.label : label,
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
            {isGeneratedKey ? (
              /* An auto-minted code's label is the IDEMPOTENCY KEY its minter
                 looks itself up by (`listing:<id>`, `open_house:<id>`,
                 `lead_magnet:<id>`). Renaming it would not rename anything a
                 person sees — the board reads display_name — it would only make
                 the next mint miss this row and print a SECOND code for the same
                 listing. So it is shown, not edited. Everything below it is still
                 editable, including where the code points. */
              <>
                <p className="w-full rounded-md border border-input bg-muted px-3 py-2 text-sm text-muted-foreground font-mono">
                  {code.label}
                </p>
                <p className="text-xs text-muted-foreground">
                  This code was created automatically for {code.display_name}. Its label is the key
                  that stops a duplicate code being minted for the same thing, so it cannot be
                  renamed — the destination below can.
                </p>
              </>
            ) : (
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            )}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Purpose</label>
            <select
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {purposes.map((p) => <option key={p} value={p}>{humanizePurpose(p)}</option>)}
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
