"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import type {
  PlatformCredential,
  ProviderOverride,
} from "@/app/actions/settings/integrations"
import {
  upsertPlatformCredential,
  upsertProviderOverride,
  togglePlatformCredential,
} from "@/app/actions/settings/integrations"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { getSelectableEsignProviders, getTransactionFormProviders, DEFAULT_ESIGN_PROVIDER, PROVIDER_CATALOG } from "@/lib/integrations/providers/catalog"
import { providerSelectionVerdict } from "@/lib/connections/scope"

// ── Provider catalogue ─────────────────────────────────────────────────────
// ONE SETTING PER CAPABILITY (wave 141, lane 141C; owner: "TRANSACTION/FORMS provider · E-SIGN
// provider · ACCOUNTING provider · PAYMENTS provider"). `payment` is the kernel's provider_type for
// the PAYMENTS capability (lib/kernel/providers.ts SYSTEM_DEFAULTS — Stripe by default).
const PROVIDER_TYPES = ["esign", "transaction", "accounting", "payment", "sms", "email", "voice", "calendar", "mls", "crm"] as const
const TYPE_LABELS: Record<string, string> = {
  esign: "E-SIGN", transaction: "LEGAL-FORMS PROVIDER", accounting: "ACCOUNTING", payment: "PAYMENTS",
}

// eSign + transaction options are derived from the unified provider catalog
// (single source of truth) so the UI offers exactly the IMPLEMENTED providers
// and never the unimplemented ones (which crash the factory). Adding a provider
// class + flipping catalog.implemented makes it appear here automatically.
const PROVIDER_KEYS_BY_TYPE: Record<string, string[]> = {
  // The catalog DEFAULT (lane 89A: DocuSign — embedded in the platform window) is offered FIRST;
  // Google eSignature (portal-send, no credential), Dotloop and every connectable API provider
  // remain selectable after it. A selection here always wins over the default.
  esign:       [...getSelectableEsignProviders(), "none"],
  transaction: [...getTransactionFormProviders(), "none"],
  sms:         ["twilio", "bandwidth", "vonage"],
  email:       ["sendgrid", "mailgun", "resend"],
  voice:       ["twilio", "bandwidth"],
  calendar:    ["google", "outlook"],
  // TOMBSTONE (lane 71C, carried from wave 69): "rentcast" removed from the
  // tenant-selectable MLS provider list. Wave 69 owner ruling (verbatim):
  // "rentcast is platform provided but idx is for tenant connected... the
  // setting page should only allow them to setup their idx connection." The
  // active-listing source order is DERIVED platform logic, never a tenant
  // choice — survivor: lib/buyer-search/listing-source-order.ts::resolveActiveListingSources
  // (IDX when the brokerage's own IDX credential is connected, else RentCast,
  // never a tenant-picked override). This provider_overrides row was never
  // consulted by that resolver anyway (readerless write of the "rentcast"
  // value specifically) — removed at the source rather than left offering a
  // choice with no effect.
  mls:         ["idx_broker", "spark", "rets", "bridge"],
  // Xero stays LISTED so a broker can see it is built-but-parked (lib/connections/scope.ts
  // CANDIDATE_PROVIDERS) — the verdict renders it unavailable with the reason, never selectable.
  accounting:  ["quickbooks", "xero", "none"],
  payment:     ["stripe", "none"],
  crm:         ["gohighlevel", "none"],
}

/** The honest menu entry: the ONE verdict every write door reads (unavailable WITH its reason). */
function selectionVerdict(type: string, key: string): { ok: boolean; reason?: string } {
  const v = providerSelectionVerdict(type, key)
  return v.ok ? { ok: true } : { ok: false, reason: v.reason }
}

const PLATFORM_LABELS: Record<string, string> = {
  google_esign: PROVIDER_CATALOG.google_esign.label,
  dotloop:      "Dotloop",
  docusign:     "DocuSign",
  skyslope:     "SkySlope",
  authentisign: "Authentisign",
  brokermint:   "Brokermint",
  formsimplicity: PROVIDER_CATALOG.formsimplicity.label,
  stripe:       "Stripe",
  twilio:       "Twilio",
  bandwidth:    "Bandwidth",
  vonage:       "Vonage",
  sendgrid:     "SendGrid",
  mailgun:      "Mailgun",
  resend:       "Resend",
  google:       "Google",
  outlook:      "Outlook / Microsoft",
  rets:         "RETS",
  spark:        "Spark API",
  bridge:       "Bridge Interactive",
  idx_broker:   "IDX Broker",
  quickbooks:   "QuickBooks",
  xero:         "Xero",
  wordpress:    "WordPress",
  idxbroker:    "IDX Broker",   // the CREDENTIAL key; idx_broker above is the provider-override key
  gohighlevel:  "GoHighLevel",
  none:         "None (Disabled)",
}

const PLATFORM_ICONS: Record<string, string> = {
  google_esign: "G",
  dotloop:    "D",
  docusign:   "DS",
  skyslope:   "SS",
  authentisign: "AS",
  brokermint: "BM",
  twilio:     "TW",
  sendgrid:   "SG",
  google:     "G",
  outlook:    "OL",
  resend:     "RE",
  mailgun:    "MG",
  bandwidth:  "BW",
  vonage:     "VG",
}

// ── Types ──────────────────────────────────────────────────────────────────
type CredForm = {
  platform: string
  api_key: string
  api_url: string
  account_id: string
  account_name: string
}

type OverrideForm = {
  provider_type: string
  provider_key: string
}

const EMPTY_CRED: CredForm = { platform: "", api_key: "", api_url: "", account_id: "", account_name: "" }
// The override form opens on the e-sign DEFAULT (the catalog's ONE constant), never a hard-coded vendor.
const EMPTY_OVERRIDE: OverrideForm = { provider_type: "esign", provider_key: DEFAULT_ESIGN_PROVIDER }

// ── Component ──────────────────────────────────────────────────────────────
export function IntegrationsClient({
  credentials: initialCreds,
  overrides,
  defaults,
}: {
  credentials: PlatformCredential[]
  overrides: ProviderOverride[]
  /** The kernel's platform defaults per provider_type (lib/kernel/providers.ts SYSTEM_DEFAULTS),
   *  passed by the server page — a client component cannot import the kernel. */
  defaults?: Record<string, string>
}) {
  // `credentials` keeps local state on purpose: handleToggle flips is_active in
  // place without a reload. TOMBSTONE — `const [overrides, setOverrides] =
  // useState(initialOverrides)`: setOverrides was never called, so that copy had
  // no writer; the prop is rendered directly. (handleSaveOverride ends in
  // window.location.reload(), a full remount, so the list was not frozen in
  // practice — it would have been the moment that became a router.refresh().)
  const [credentials, setCredentials] = useState(initialCreds)
  const [showCredDialog, setShowCredDialog] = useState(false)
  const [showOverrideDialog, setShowOverrideDialog] = useState(false)
  const [credForm, setCredForm] = useState<CredForm>(EMPTY_CRED)
  const [overrideForm, setOverrideForm] = useState<OverrideForm>(EMPTY_OVERRIDE)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  // ── Credentials ──────────────────────────────────────────────────────────
  function handleAddCred() {
    if (!credForm.platform) { setError("Platform is required"); return }
    setError(null)
    startTransition(async () => {
      const res = await upsertPlatformCredential({
        platform:     credForm.platform,
        api_key:      credForm.api_key || undefined,
        api_url:      credForm.api_url || undefined,
        account_id:   credForm.account_id || undefined,
        account_name: credForm.account_name || undefined,
      })
      if (!res.success) { setError(res.error ?? "Failed"); return }
      setShowCredDialog(false)
      window.location.reload()
    })
  }

  function handleToggle(cred: PlatformCredential) {
    startTransition(async () => {
      await togglePlatformCredential(cred.id, !cred.is_active)
      setCredentials(prev =>
        prev.map(c => c.id === cred.id ? { ...c, is_active: !c.is_active } : c)
      )
    })
  }

  // ── Provider overrides ───────────────────────────────────────────────────
  function handleSaveOverride() {
    setError(null)
    startTransition(async () => {
      const res = await upsertProviderOverride({
        provider_type: overrideForm.provider_type,
        provider_key:  overrideForm.provider_key,
        enabled:       overrideForm.provider_key !== "none",
      })
      if (!res.success) { setError(res.error ?? "Failed"); return }
      setShowOverrideDialog(false)
      window.location.reload()
    })
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function getOverrideForType(type: string) {
    return overrides.find(o => o.provider_type === type)
  }

  function statusBadge(active: boolean) {
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
        active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
      }`}>
        <span className={`w-1.5 h-1.5 rounded-full ${active ? "bg-green-500" : "bg-gray-400"}`} />
        {active ? "Active" : "Inactive"}
      </span>
    )
  }

  return (
    <div className="p-6 space-y-8 max-w-4xl">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Integrations</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage platform credentials and provider routing overrides for your brokerage.
          </p>
        </div>
        {/* Orphan-route sweep: the tenant lead-source / listing-feed setup page
            was unreachable from any nav — this hub is its home. */}
        <Button variant="outline" size="sm" asChild>
          <Link href="/dashboard/settings/integrations/lead-sources">
            Lead Sources &amp; Listing Feeds
          </Link>
        </Button>
      </div>

      {/* ── Provider Routing ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Provider Routing</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Set which provider to use per channel. Overrides the global kernel default.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => {
            setOverrideForm(EMPTY_OVERRIDE)
            setError(null)
            setShowOverrideDialog(true)
          }}>
            Configure Override
          </Button>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-2.5 font-medium text-gray-600">Provider Type</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-600">Active Provider</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-600">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {PROVIDER_TYPES.map(type => {
                const override = getOverrideForType(type)
                // A stored selection the matrix no longer certifies is shown as UNAVAILABLE with its
                // reason (tenant-facing honesty) — never as a working provider.
                const stored = override && override.provider_key !== "none" ? selectionVerdict(type, override.provider_key) : null
                const platformDefault = defaults?.[type]
                return (
                  <tr key={type} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-800 uppercase text-xs tracking-wide">
                      {TYPE_LABELS[type] ?? type}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {override
                        ? <>
                            {PLATFORM_LABELS[override.provider_key] ?? override.provider_key}
                            {stored && !stored.ok && <p className="text-[11px] text-amber-700 mt-0.5">Unavailable — {stored.reason}</p>}
                          </>
                        : <span className="text-gray-400 italic">{type === "esign" ? `Default — ${PROVIDER_CATALOG[DEFAULT_ESIGN_PROVIDER].label}` : platformDefault ? `Default — ${PLATFORM_LABELS[platformDefault] ?? platformDefault}` : "No platform default — your selection decides"}</span>}
                    </td>
                    <td className="px-4 py-3">
                      {override ? (stored && !stored.ok ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                          Unavailable
                        </span>
                      ) : statusBadge(override.enabled)) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                        onClick={() => {
                          setOverrideForm({
                            provider_type: type,
                            provider_key:  override?.provider_key ?? (PROVIDER_KEYS_BY_TYPE[type]?.[0] ?? ""),
                          })
                          setError(null)
                          setShowOverrideDialog(true)
                        }}
                      >
                        {override ? "Edit" : "Set"}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Platform Credentials ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Platform Credentials</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              API keys and tokens for connected platforms. Stored securely at the brokerage scope.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => {
            setCredForm(EMPTY_CRED)
            setError(null)
            setShowCredDialog(true)
          }}>
            Add Credential
          </Button>
        </div>

        {credentials.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
            <p className="text-sm text-gray-500">No platform credentials configured yet.</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Platform</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Account</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Scope</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Last Synced</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Status</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {credentials.map(cred => (
                  <tr key={cred.id} className={`border-b border-gray-50 hover:bg-gray-50 ${!cred.is_active ? "opacity-50" : ""}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-gray-900 text-white text-xs font-bold shrink-0">
                          {PLATFORM_ICONS[cred.platform] ?? cred.platform.slice(0, 2).toUpperCase()}
                        </span>
                        <span className="font-medium text-gray-900">
                          {PLATFORM_LABELS[cred.platform] ?? cred.platform}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {cred.account_name ?? cred.account_id ?? (
                        <span className="text-gray-400 italic">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600 capitalize">{cred.scope}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {cred.last_synced_at
                        ? new Date(cred.last_synced_at).toLocaleString()
                        : <span className="text-gray-400">Never</span>}
                    </td>
                    <td className="px-4 py-3">
                      {cred.sync_error ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                          Error
                        </span>
                      ) : statusBadge(cred.is_active)}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleToggle(cred)}
                        disabled={isPending}
                        className={`relative inline-flex h-5 w-9 rounded-full transition-colors focus:outline-none ${
                          cred.is_active ? "bg-gray-900" : "bg-gray-200"
                        }`}
                      >
                        <span className={`inline-block h-4 w-4 mt-0.5 rounded-full bg-white shadow transform transition-transform ${
                          cred.is_active ? "translate-x-4" : "translate-x-0.5"
                        }`} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Add Credential Dialog ─────────────────────────────────────────── */}
      <Dialog open={showCredDialog} onOpenChange={open => { if (!open) setShowCredDialog(false) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Platform Credential</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1.5">Platform *</label>
              <Input
                value={credForm.platform}
                onChange={e => setCredForm(f => ({ ...f, platform: e.target.value }))}
                placeholder="e.g. dotloop, twilio, sendgrid"
                className="h-9"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1.5">API Key</label>
              <Input
                type="password"
                value={credForm.api_key}
                onChange={e => setCredForm(f => ({ ...f, api_key: e.target.value }))}
                placeholder="••••••••••••••••"
                className="h-9"
                autoComplete="off"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1.5">API URL</label>
              <Input
                value={credForm.api_url}
                onChange={e => setCredForm(f => ({ ...f, api_url: e.target.value }))}
                placeholder="https://api.example.com"
                className="h-9"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1.5">Account ID</label>
                <Input
                  value={credForm.account_id}
                  onChange={e => setCredForm(f => ({ ...f, account_id: e.target.value }))}
                  className="h-9"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1.5">Account Name</label>
                <Input
                  value={credForm.account_name}
                  onChange={e => setCredForm(f => ({ ...f, account_name: e.target.value }))}
                  className="h-9"
                />
              </div>
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowCredDialog(false)}>Cancel</Button>
            <Button onClick={handleAddCred} disabled={isPending}>
              {isPending ? "Saving..." : "Save Credential"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Provider Override Dialog ──────────────────────────────────────── */}
      <Dialog open={showOverrideDialog} onOpenChange={open => { if (!open) setShowOverrideDialog(false) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Configure Provider Override</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1.5">Provider Type</label>
              <Select
                value={overrideForm.provider_type}
                onValueChange={v => setOverrideForm(f => ({
                  provider_type: v,
                  provider_key:  PROVIDER_KEYS_BY_TYPE[v]?.[0] ?? "",
                }))}
              >
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDER_TYPES.map(t => (
                    <SelectItem key={t} value={t}>{TYPE_LABELS[t] ?? t.toUpperCase()}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1.5">Provider</label>
              <Select
                value={overrideForm.provider_key}
                onValueChange={v => setOverrideForm(f => ({ ...f, provider_key: v }))}
              >
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(PROVIDER_KEYS_BY_TYPE[overrideForm.provider_type] ?? []).map(k => {
                    // Unavailable providers stay LISTED (never advertised as working, never hidden):
                    // disabled, with the honest reason shown below the menu when picked.
                    const v = selectionVerdict(overrideForm.provider_type, k)
                    return (
                      <SelectItem key={k} value={k} disabled={!v.ok}>
                        {PLATFORM_LABELS[k] ?? k}{v.ok ? "" : " — unavailable"}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
              {(() => {
                const v = overrideForm.provider_key ? selectionVerdict(overrideForm.provider_type, overrideForm.provider_key) : { ok: true }
                return v.ok ? null : <p className="text-[11px] text-amber-700 mt-1.5">Unavailable — {v.reason}</p>
              })()}
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowOverrideDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveOverride} disabled={isPending || !selectionVerdict(overrideForm.provider_type, overrideForm.provider_key).ok}>
              {isPending ? "Saving..." : "Save Override"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
