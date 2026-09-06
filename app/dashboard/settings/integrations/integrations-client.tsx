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
import { getEsignProviders, getTransactionFormProviders } from "@/lib/integrations/providers/catalog"

// ── Provider catalogue ─────────────────────────────────────────────────────
const PROVIDER_TYPES = ["esign", "transaction", "sms", "email", "voice", "calendar", "mls", "accounting", "crm"] as const

// eSign + transaction options are derived from the unified provider catalog
// (single source of truth) so the UI offers exactly the IMPLEMENTED providers
// and never the unimplemented ones (which crash the factory). Adding a provider
// class + flipping catalog.implemented makes it appear here automatically.
const PROVIDER_KEYS_BY_TYPE: Record<string, string[]> = {
  esign:       [...getEsignProviders(), "none"],
  transaction: [...getTransactionFormProviders(), "none"],
  sms:         ["twilio", "bandwidth", "vonage"],
  email:       ["sendgrid", "mailgun", "resend"],
  voice:       ["twilio", "bandwidth"],
  calendar:    ["google", "outlook"],
  mls:         ["idx_broker", "spark", "rets", "bridge", "rentcast"],
  accounting:  ["quickbooks", "xero"],
  crm:         ["gohighlevel", "none"],
}

const PLATFORM_LABELS: Record<string, string> = {
  dotloop:      "Dotloop",
  docusign:     "DocuSign",
  skyslope:     "SkySlope",
  authentisign: "Authentisign",
  brokermint:   "Brokermint",
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
  rentcast:     "Rentcast (no IDX needed)",
  quickbooks:   "QuickBooks",
  xero:         "Xero",
  wordpress:    "WordPress",
  idxbroker:    "IDX Broker",   // the CREDENTIAL key; idx_broker above is the provider-override key
  gohighlevel:  "GoHighLevel",
  none:         "None (Disabled)",
}

const PLATFORM_ICONS: Record<string, string> = {
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
const EMPTY_OVERRIDE: OverrideForm = { provider_type: "esign", provider_key: "dotloop" }

// ── Component ──────────────────────────────────────────────────────────────
export function IntegrationsClient({
  credentials: initialCreds,
  overrides,
}: {
  credentials: PlatformCredential[]
  overrides: ProviderOverride[]
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

        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
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
                return (
                  <tr key={type} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-800 uppercase text-xs tracking-wide">
                      {type}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {override
                        ? PLATFORM_LABELS[override.provider_key] ?? override.provider_key
                        : <span className="text-gray-400 italic">Kernel default</span>}
                    </td>
                    <td className="px-4 py-3">
                      {override ? statusBadge(override.enabled) : (
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
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
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
                    <SelectItem key={t} value={t}>{t.toUpperCase()}</SelectItem>
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
                  {(PROVIDER_KEYS_BY_TYPE[overrideForm.provider_type] ?? []).map(k => (
                    <SelectItem key={k} value={k}>
                      {PLATFORM_LABELS[k] ?? k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowOverrideDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveOverride} disabled={isPending}>
              {isPending ? "Saving..." : "Save Override"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
