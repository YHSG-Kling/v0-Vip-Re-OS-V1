'use client'

import { useState, useTransition, useEffect, useRef } from 'react'
// WAVE 152 (lane 152C): the governed lifecycle / duplicate / activity doors (each its own session gate).
import { setQrCodeActive, retireQrCode, duplicateQrCode, loadQrCodeActivity } from '@/app/actions/qr-management'
import type {
  QrManagerCode,
  QrCampaignRollup,
  QrLinkableCampaign,
  QrScopeKind,
} from '@/app/actions/qr-management'
/** The activity shape, read off the action's own result (no type import from the server-only governance module). */
type QrActivity = Extract<Awaited<ReturnType<typeof loadQrCodeActivity>>, { ok: true }>['activity']
// ONE encoding contract (wave 141F): the on-screen preview and the downloaded PNG carry the
// same quiet zone / error correction / contrast as every printed code (lib/marketing/qr-contract.ts).
// WAVE 152: the token scopes and placement vocabulary the create form offers come from the same pure contract.
import { qrEncodeOptions, QR_TOKEN_SCOPES, QR_PLACEMENT_TYPES, type QrLifecycleState } from '@/lib/marketing/qr-contract'

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
type StateFilter = 'all' | 'active' | 'inactive' | 'expired' | 'retired'

function isExpired(code: QRCodeRow): boolean {
  return code.lifecycle_state === 'expired'
}
function isRetired(code: QRCodeRow): boolean {
  return code.lifecycle_state === 'retired' || code.lifecycle_state === 'revoked'
}

/** The badge a person reads — the ONE lifecycle classifier's answer, in words. */
const LIFECYCLE_BADGE: Record<QrLifecycleState, { label: string; tone: string }> = {
  active:  { label: 'Active',  tone: 'bg-green-100 text-green-700' },
  paused:  { label: 'Paused',  tone: 'bg-muted text-muted-foreground' },
  expired: { label: 'Expired', tone: 'bg-amber-100 text-amber-800' },
  retired: { label: 'Retired', tone: 'bg-slate-200 text-slate-700' },
  revoked: { label: 'Turned off (unsafe)', tone: 'bg-red-100 text-red-700' },
}

const TOKEN_SCOPE_LABELS: Record<(typeof QR_TOKEN_SCOPES)[number], string> = {
  per_design: 'One code for this design (every printed copy shares it)',
  per_piece:  'One code per printed piece',
}

const PLACEMENT_LABELS: Record<(typeof QR_PLACEMENT_TYPES)[number], string> = {
  flyer:           'Flyer, sign or business card',
  listing_asset:   'Listing material',
  mailer:          'Direct mail piece',
  podcast_landing: 'Podcast page',
  social_landing:  'Social post or page',
  video_endcard:   'Video end card',
}

/** A fresh idempotency key per create form — a retried click re-sends it and gets the same code back. */
function newRequestKey(): string {
  const c = globalThis.crypto as Crypto | undefined
  return c?.randomUUID ? `qr-${c.randomUUID()}` : `qr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

interface CreateFormState {
  label:           string
  purpose:         string
  destinationType: string
  targetUrl:       string
  listingId:       string
  campaignId:      string
  expiresAt:       string
  tokenScope:      string
  placement:       string
  printSizeIn:     string
  trackingEnabled: boolean
}

const EMPTY_CREATE: CreateFormState = {
  label: '', purpose: 'general', destinationType: '', targetUrl: '', listingId: '',
  campaignId: '', expiresAt: '', tokenScope: 'per_design', placement: '', printSizeIn: '1', trackingEnabled: true,
}

/** "open_house" → "Open house". The stored value is the CHECK vocabulary; this
 *  is only how it reads in a dropdown. */
function humanizePurpose(value: string): string {
  const spaced = value.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** m148 destination_type enum + human labels and per-type help text.
 *  Order matches the most-common-first UX heuristic for real estate.
 *  The app-hosted paths named here are the ones lib/marketing/qr-contract.ts
 *  qrInAppDefaultPath actually builds (wave 141F — the old text named
 *  /qr/{slug}/landing, /forms/cma and /book, none of which is a route). */
const DESTINATION_OPTIONS: Array<{
  value: string
  label: string
  help:  string
  needsExternalUrl: boolean   // if true, the user MUST supply a target URL
}> = [
  { value: '',                  label: '— Choose a destination —',           help: 'Pick how scanners land.', needsExternalUrl: false },
  { value: 'landing_page',      label: 'Branded landing page',               help: 'This code’s own branded capture page at /qr/{slug}.', needsExternalUrl: false },
  { value: 'cma_form',          label: 'CMA / home value form',              help: 'App-hosted home-value funnel at /home-value (your public profile slug when you have one).', needsExternalUrl: false },
  { value: 'book_meeting',      label: 'Book a meeting',                     help: 'The listing’s public page (showing request) when you give a listing id; otherwise your public profile at /p/{your-slug}; otherwise this code’s own capture page.', needsExternalUrl: false },
  { value: 'listing_detail',    label: 'Listing detail page',                help: 'Routes to the listing’s public page at /listings/{id} — provide the listing id below.', needsExternalUrl: false },
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
      QRCode.toCanvas(canvasRef.current, url, qrEncodeOptions(200))
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
  const [createForm, setCreateForm] = useState<CreateFormState>(EMPTY_CREATE)
  const [createError, setCreateError] = useState<string | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [activity, setActivity] = useState<{ codeId: string; data: QrActivity | null; error: string | null } | null>(null)
  const [isPending, startTransition] = useTransition()
  /** ONE idempotency key per opened create form (wave 152): a double click or a retry after a network blip re-sends it,
   *  and the governed mint returns the SAME code instead of printing two. */
  const createKey = useRef<string>(newRequestKey())

  const counts = {
    all:      codes.length,
    active:   codes.filter((c) => c.lifecycle_state === 'active').length,
    inactive: codes.filter((c) => c.lifecycle_state === 'paused').length,
    expired:  codes.filter(isExpired).length,
    retired:  codes.filter(isRetired).length,
  }

  const visibleCodes = codes.filter((c) => {
    if (stateFilter === 'active')   return c.lifecycle_state === 'active'
    if (stateFilter === 'inactive') return c.lifecycle_state === 'paused'
    if (stateFilter === 'expired')  return isExpired(c)
    if (stateFilter === 'retired')  return isRetired(c)
    return true
  })

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''

  /** The TRACKING link — what the printed symbol encodes and what a shared link should be (every open is counted). */
  function getQRUrl(slug: string) {
    return `${baseUrl}/api/qr/scan?slug=${slug}`
  }

  function getLandingUrl(slug: string) {
    return `${baseUrl}/qr/${slug}`
  }

  /** Copy the safe tracking link: the token only — no name, no Contact id, no key in it. */
  function handleCopy(slug: string) {
    navigator.clipboard.writeText(getQRUrl(slug))
    setCopied(slug)
    setTimeout(() => setCopied(null), 1800)
  }

  function handleDownload(slug: string) {
    import('qrcode').then(async (QRCode) => {
      // The downloaded PNG is a PRINT asset — the contract's print size and quiet zone.
      const url = await QRCode.toDataURL(getQRUrl(slug), qrEncodeOptions(600))
      const a = document.createElement('a')
      a.href = url
      a.download = `qr-${slug}.png`
      a.click()
    })
  }

  /** Print-ready VECTOR (wave 152): an SVG scales to any print size without blurring; same quiet zone and error correction. */
  function handleDownloadSvg(slug: string) {
    import('qrcode').then(async (QRCode) => {
      const svg = await QRCode.toString(getQRUrl(slug), { ...qrEncodeOptions(600), type: 'svg' })
      const href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
      const a = document.createElement('a')
      a.href = href
      a.download = `qr-${slug}.svg`
      a.click()
      setTimeout(() => URL.revokeObjectURL(href), 1000)
    })
  }

  function openActivity(code: QRCodeRow) {
    setSelectedCode(code)
    setActivity({ codeId: code.id, data: null, error: null })
    startTransition(async () => {
      const res = await loadQrCodeActivity(code.id)
      setActivity({ codeId: code.id, data: res.ok ? res.activity : null, error: res.ok ? null : res.error })
    })
  }

  /** Pause · resume · retire · turn off (unsafe) — the one lifecycle door. Retiring keeps the code's record. */
  function handleLifecycle(code: QRCodeRow, action: 'pause' | 'resume' | 'retire' | 'revoke_unsafe') {
    setToggleError(null)
    setNotice(null)
    let reason: string | undefined
    if (action === 'retire' && !window.confirm(`Retire "${code.display_name}"? Printed copies will show a "this code has been retired" page. This can't be undone — you can duplicate it later to print a new code.`)) return
    if (action === 'revoke_unsafe') {
      const r = window.prompt(`Turn off "${code.display_name}" because its destination is unsafe? Scanners will see a safety notice instead of the page. Say why (kept on the code's record):`)
      if (!r || !r.trim()) return
      reason = r.trim()
    }
    startTransition(async () => {
      const res = action === 'pause' || action === 'resume'
        ? await setQrCodeActive({ qrCodeId: code.id, isActive: action === 'resume' })
        : await retireQrCode({ qrCodeId: code.id, unsafe: action === 'revoke_unsafe', reason })
      if (!res.ok) { setToggleError(res.error); return }
      setCodes((prev) => prev.map((c) => c.id === code.id ? { ...c, lifecycle_state: res.state, is_active: res.state === 'active' || res.state === 'expired' } : c))
    })
  }

  /** Duplicate the design under a NEW unique token (idempotent per click). */
  function handleDuplicate(code: QRCodeRow) {
    setToggleError(null)
    setNotice(null)
    const key = newRequestKey()
    startTransition(async () => {
      const res = await duplicateQrCode({ qrCodeId: code.id, idempotencyKey: key })
      if (!res.ok) { setToggleError(res.error); return }
      setNotice(`Created "${res.code.label}" with its own new code. It has its own scans; reload to see it in the list.`)
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
            // WAVE 152 (152C): the governed mint's contract — the request key and the code's provenance.
            idempotencyKey: createKey.current,
            tokenScope: createForm.tokenScope,
            placement: createForm.placement || undefined,
            printSizeIn: Number(createForm.printSizeIn) || undefined,
            trackingEnabled: createForm.trackingEnabled,
            channel: 'qr_board',
          }),
        })
        const json = (await res.json()) as { success: boolean; qrCode?: Partial<QRCodeRow>; error?: string; replayed?: boolean }
        if (!json.success || !json.qrCode) {
          setCreateError(json.error ?? 'The QR code wasn\'t created. Nothing was saved — try again.')
          return
        }
        if (json.replayed) {
          // The same request arrived twice — the first one created it; nothing new was minted.
          setNotice('That code was already created from your earlier click — no second code was made.')
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
        setCodes((prev) => prev.some((c) => c.id === minted.id) ? prev : [{
          expires_at: null, marketing_campaign_id: null, campaign_name: null,
          mail_campaign_name: null, agent_id: agentUserId, agent_name: null,
          display_name: minted.label ?? createForm.label.trim(),
          lifecycle_state: 'active', token_scope: createForm.tokenScope, placement: createForm.placement || null,
          mail_layout: null, tracking: createForm.trackingEnabled ? 'enabled' : 'disabled',
          print_size_in: Number(createForm.printSizeIn) || null, consent_context: null, destination_versions: 1, creator_name: null,
          ...minted,
        } as QRCodeRow, ...prev])
        setShowCreate(false)
        setCreateForm(EMPTY_CREATE)
        createKey.current = newRequestKey()
      } catch {
        setCreateError('Network error. Please try again.')
      }
    })
  }

  function handleEditSave(edited: QRCodeRow, reason: string) {
    setCreateError(null)
    startTransition(async () => {
      try {
        // WAVE 152 (152C): the destination goes through the governed editor (validated, versioned,
        // ledgered); pause/resume is its own action on the card, so this save no longer sends isActive.
        const res = await fetch('/api/admin/qr-codes', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: edited.id,
            label: edited.label,
            purpose: edited.purpose,
            destinationType: edited.destination_type,
            targetUrl: edited.target_url,
            reason: reason.trim() || undefined,
          }),
        })
        const json = (await res.json()) as { success: boolean; qrCode?: Partial<QRCodeRow>; error?: string; notices?: string[] }
        if (!json.success || !json.qrCode) {
          setCreateError(json.error ?? 'The change wasn\'t saved. Nothing was changed — try again.')
          return
        }
        // MERGE, don't replace: the PATCH response carries the qr_codes row and
        // not the campaign linkages this board resolves separately.
        setCodes((prev) => prev.map((c) => c.id === edited.id ? { ...c, ...(json.qrCode as QRCodeRow), destination_versions: json.notices?.length ? Math.max(c.destination_versions, 1) + 1 : c.destination_versions } : c))
        if (json.notices?.length) setNotice(json.notices.join(' '))
        setEditingCode(null)
      } catch {
        setCreateError('We couldn\'t reach the server, so nothing was saved. Check your connection and try again.')
      }
    })
  }

  // TOMBSTONE (wave 152, 152C): handleToggleActive lived here (pause/resume only). SURVIVOR: handleLifecycle above —
  // pause / resume through setQrCodeActive, retire / turn off through retireQrCode (both the governed lifecycle door).

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
        {(['all', 'active', 'inactive', 'expired', 'retired'] as StateFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setStateFilter(f)}
            className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
              stateFilter === f
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:bg-muted'
            }`}
          >
            {f === 'all' ? 'All' : f === 'inactive' ? 'Paused' : f[0].toUpperCase() + f.slice(1)} ({counts[f]})
          </button>
        ))}
      </div>

      {toggleError && (
        <p role="alert" className="text-sm text-destructive">{toggleError}</p>
      )}
      {notice && (
        <p role="status" className="text-sm text-foreground">{notice}</p>
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

              {/* WAVE 152 (152C) — the code's provenance: token scope, where it prints, print size, tracking. */}
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">Code type</label>
                <select
                  value={createForm.tokenScope}
                  onChange={(e) => setCreateForm((p) => ({ ...p, tokenScope: e.target.value }))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {QR_TOKEN_SCOPES.map((s) => <option key={s} value={s}>{TOKEN_SCOPE_LABELS[s]}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">
                  Every code gets its own unique, hard-to-guess link. A scan tells you a code was scanned — never who scanned it.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-foreground">Printed on <span className="text-muted-foreground">(optional)</span></label>
                  <select
                    value={createForm.placement}
                    onChange={(e) => setCreateForm((p) => ({ ...p, placement: e.target.value }))}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">— Not stated —</option>
                    {QR_PLACEMENT_TYPES.map((p) => <option key={p} value={p}>{PLACEMENT_LABELS[p]}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-foreground">Print size</label>
                  <select
                    value={createForm.printSizeIn}
                    onChange={(e) => setCreateForm((p) => ({ ...p, printSizeIn: e.target.value }))}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {['0.8', '1', '1.25', '1.5', '2', '3'].map((s) => <option key={s} value={s}>{s} in{s === '0.8' ? ' (smallest)' : ''}</option>)}
                  </select>
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={createForm.trackingEnabled}
                  onChange={(e) => setCreateForm((p) => ({ ...p, trackingEnabled: e.target.checked }))}
                  className="mt-0.5 h-4 w-4"
                />
                <span className="text-foreground">
                  Track each scan <span className="text-muted-foreground">— time, device type and the referring site, never the person. Off: only the total count.</span>
                </span>
              </label>

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
                  onClick={() => { setShowCreate(false); setCreateError(null); createKey.current = newRequestKey() }}
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
          <div className="bg-background rounded-lg border border-border p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-xl space-y-4">
            <div className="flex items-start justify-between">
              <h2 className="text-lg font-semibold text-foreground">{selectedCode.display_name}</h2>
              <button
                onClick={() => { setSelectedCode(null); setActivity(null) }}
                className="text-muted-foreground hover:text-foreground text-xl leading-none"
                aria-label="Close"
              >
                &times;
              </button>
            </div>
            <div className="flex justify-center">
              <QRCanvas url={getQRUrl(selectedCode.slug)} />
            </div>
            {/* PREVIEW THE TARGET (wave 152): what the code opens, and its tracking link (the token only). */}
            <div className="space-y-1 text-xs">
              <p className="text-muted-foreground">Opens: <span className="text-foreground break-all">{selectedCode.target_url ?? getLandingUrl(selectedCode.slug)}</span></p>
              <p className="text-muted-foreground">Tracking link: <span className="font-mono text-foreground break-all">{getQRUrl(selectedCode.slug)}</span></p>
              <p className="text-muted-foreground">
                {selectedCode.token_scope ? TOKEN_SCOPE_LABELS[selectedCode.token_scope as keyof typeof TOKEN_SCOPE_LABELS] ?? selectedCode.token_scope : 'Code type not recorded (created before this was tracked)'}
                {selectedCode.print_size_in ? ` · prints at ${selectedCode.print_size_in} in` : ''}
                {selectedCode.creator_name ? ` · created by ${selectedCode.creator_name}` : ''}
                {selectedCode.tracking === 'disabled' ? ' · per-scan tracking off' : ''}
              </p>
            </div>
            {/* SCAN HISTORY + OUTCOMES — four separate counts, never a person. */}
            {activity?.codeId === selectedCode.id && activity.error && (
              <p role="alert" className="text-sm text-destructive">{activity.error}</p>
            )}
            {activity?.codeId === selectedCode.id && !activity.data && !activity.error && (
              <p className="text-sm text-muted-foreground">Loading scan history…</p>
            )}
            {activity?.codeId === selectedCode.id && activity.data && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
                  <div className="rounded-md border border-border p-3">
                    <p className="text-2xl font-bold text-foreground">{selectedCode.scan_count}</p>
                    <p className="text-[11px] text-muted-foreground">All scans</p>
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <p className="text-2xl font-bold text-foreground">{activity.data.summary.humanLikelyVisits}</p>
                    <p className="text-[11px] text-muted-foreground">Visits (bots and quick repeats removed)</p>
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <p className="text-2xl font-bold text-foreground">{activity.data.summary.uniqueVisitorDays ?? '—'}</p>
                    <p className="text-[11px] text-muted-foreground">{activity.data.summary.uniqueVisitorDays === null ? 'Unique visitors not measured' : 'Unique visitors (per day)'}</p>
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <p className="text-2xl font-bold text-foreground">{activity.data.consentedContacts}</p>
                    <p className="text-[11px] text-muted-foreground">Contacts who signed up with consent</p>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {activity.data.summary.botScans} automated {activity.data.summary.botScans === 1 ? 'scan' : 'scans'} and {activity.data.summary.repeatScans} quick {activity.data.summary.repeatScans === 1 ? 'repeat' : 'repeats'} filtered
                  {activity.data.summary.unclassified ? ` · ${activity.data.summary.unclassified} older ${activity.data.summary.unclassified === 1 ? 'scan' : 'scans'} not classified` : ''}.
                  A scan never creates a Contact; appointments and closings appear in your ROI report only when they are linked.
                </p>
                {activity.data.history.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-foreground">Destination history</p>
                    <ul className="max-h-24 overflow-y-auto space-y-0.5 text-[11px] text-muted-foreground">
                      {activity.data.history.slice().reverse().map((h) => (
                        <li key={h.version} className="break-all">
                          v{h.version} · {new Date(h.changed_at).toLocaleDateString()} · {h.target_url}{h.reason ? ` — ${h.reason}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {activity.data.recent.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-foreground">Recent scans</p>
                    <ul className="max-h-28 overflow-y-auto space-y-0.5 text-[11px] text-muted-foreground">
                      {activity.data.recent.map((r, i) => (
                        <li key={i}>
                          {r.scannedAt ? new Date(r.scannedAt).toLocaleString() : 'time not recorded'} · {r.deviceClass ?? 'device not recorded'} · {r.trafficClass === 'human_likely' ? 'visit' : r.trafficClass ?? 'not classified'}
                          {r.referrerHost ? ` · from ${r.referrerHost}` : ''}{r.linkedToContact ? ' · signed up' : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => handleCopy(selectedCode.slug)}
                className="flex-1 rounded-md border border-border px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
              >
                {copied === selectedCode.slug ? 'Copied!' : 'Copy tracking link'}
              </button>
              <button
                onClick={() => handleDownloadSvg(selectedCode.slug)}
                className="flex-1 rounded-md border border-border px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
              >
                Download SVG (print)
              </button>
              <button
                onClick={() => handleDownload(selectedCode.slug)}
                className="flex-1 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
              >
                Download PNG
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
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${LIFECYCLE_BADGE[code.lifecycle_state].tone}`}>
                    {LIFECYCLE_BADGE[code.lifecycle_state].label}
                  </span>
                  {!isRetired(code) && (
                    <button
                      onClick={() => setEditingCode(code)}
                      className="text-[11px] text-blue-600 hover:underline"
                    >
                      Edit destination
                    </button>
                  )}
                  {code.destination_versions > 1 && (
                    <span className="text-[10px] text-muted-foreground">{code.destination_versions} versions</span>
                  )}
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
                  {copied === code.slug ? 'Copied!' : 'Copy link'}
                </button>
                <button
                  onClick={() => handleDownloadSvg(code.slug)}
                  className="flex-1 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
                >
                  SVG
                </button>
                <button
                  onClick={() => handleDownload(code.slug)}
                  className="flex-1 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
                >
                  PNG
                </button>
                <button
                  onClick={() => openActivity(code)}
                  className="flex-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
                >
                  Details
                </button>
              </div>

              <div className="flex gap-2">
                {!isRetired(code) && (
                  <button
                    onClick={() => handleLifecycle(code, code.lifecycle_state === 'paused' ? 'resume' : 'pause')}
                    disabled={isPending}
                    className="flex-1 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted disabled:opacity-50 transition-colors"
                  >
                    {code.lifecycle_state === 'paused' ? 'Resume' : 'Pause'}
                  </button>
                )}
                <button
                  onClick={() => handleDuplicate(code)}
                  disabled={isPending}
                  className="flex-1 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted disabled:opacity-50 transition-colors"
                >
                  Duplicate
                </button>
                {!isRetired(code) && (
                  <button
                    onClick={() => handleLifecycle(code, 'retire')}
                    disabled={isPending}
                    className="flex-1 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted disabled:opacity-50 transition-colors"
                  >
                    Retire
                  </button>
                )}
                {code.lifecycle_state !== 'revoked' && code.lifecycle_state !== 'retired' && (
                  <button
                    onClick={() => handleLifecycle(code, 'revoke_unsafe')}
                    disabled={isPending}
                    className="flex-1 rounded-md border border-destructive/40 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50 transition-colors"
                  >
                    Turn off (unsafe)
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Wave 36 — edit modal. The agent can repoint a printed QR's URL
          without reprinting the postcard. /api/qr/scan reads target_url
          fresh on every scan (true since wave 141F — before that the route
          never read it and this sentence was a promise nothing kept), so
          updating here reroutes every printed copy in the wild on the NEXT
          scan: an in-app page directly, an outside https link as a
          tap-through on the landing page. */}
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
  onSave:   (edited: QRCodeRow, reason: string) => void
  pending:  boolean
  error:    string | null
}) {
  const [label, setLabel]         = useState(code.label)
  const [destType, setDestType]   = useState(code.destination_type ?? '')
  const [targetUrl, setTargetUrl] = useState(code.target_url ?? '')
  const [reason, setReason]       = useState('')
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
      purpose,
    }, reason)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-lg border border-border p-6 w-full max-w-md shadow-xl">
        <h2 className="text-lg font-semibold text-foreground mb-1">Edit QR code</h2>
        <p className="text-xs text-muted-foreground mb-4">
          Updating the URL or destination type reroutes every printed copy on the next scan
          — no need to reprint postcards. The previous destination is kept in the code&apos;s history.
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
          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">
              Why the change <span className="text-muted-foreground">(optional — kept with this version)</span>
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Listing sold — now points to the just-sold page"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
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
