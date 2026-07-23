"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  connectApiKeyProvider,
  disconnectProvider,
  startStripeConnect,
  type ConnectionCenter,
  type OwnerHint,
} from "@/app/actions/connections/connection-center"
import { syncContactNowAction } from "@/app/actions/crm-connect"
import { getByoCarrierPolicy, setByoCarrierPolicy } from "@/app/actions/settings/global-settings-actions"
import { MANAGERS } from "@/lib/kernel/manager-registry"
import Link from "next/link"

const DOMAIN_LABELS: Record<string, string> = {
  email: "Email", phone: "Phone / SMS", calendar: "Calendar", social: "Social",
  crm: "CRM (sync-out)", financial: "Financial", listing: "IDX / Listings",
  transaction: "Transaction Management", esign: "E-Signature", showing: "Showings",
  podcast: "Podcast Syndication",
  meetings: "Video Meetings",
}

// Short clarifying notes under a domain title. Email is the important one: what
// you connect here is your PERSONAL relationship inbox (Gmail/Outlook). The
// brokerage's transactional + offers email is platform-managed (SendGrid) and is
// NOT a tenant setting — so nobody routes offers mail through a personal box.
const DOMAIN_NOTES: Record<string, string> = {
  email:
    "Connect your personal relationship inbox (Gmail or Outlook) for 1:1 email. Transactional and offer emails are sent by the platform (SendGrid) and captured for the offers system automatically — nothing to set up here.",
  phone:
    "Your calling/SMS number is provided and billed by the platform — you don't enter a carrier API key.",
  crm: "One-way: contact updates are pushed OUT to your CRM. Nothing syncs back in.",
}

const PROVIDER_LABELS: Record<string, string> = {
  gmail: "Google", outlook: "Microsoft", twilio: "Twilio", telnyx: "Telnyx", bandwidth: "Bandwidth",
  meta: "Meta (Facebook & Instagram)", linkedin: "LinkedIn", twitter: "X / Twitter",
  tiktok: "TikTok", youtube: "YouTube", pinterest: "Pinterest", google_business: "Google Business",
  gohighlevel: "GoHighLevel", followupboss: "Follow Up Boss", lofty: "Lofty", hubspot: "HubSpot",
  quickbooks: "QuickBooks", stripe: "Stripe", idxbroker: "IDX Broker",
  dotloop: "Dotloop", formsimplicity: "Form Simplicity", docusign: "DocuSign",
  skyslope: "SkySlope", brokermint: "Brokermint", authentisign: "Authentisign", showingtime: "ShowingTime",
  transistor: "Transistor",
  zoom: "Zoom",
}

type Domain = ConnectionCenter["domains"][number]
type Provider = Domain["providers"][number]

function label(map: Record<string, string>, key: string) {
  return map[key] ?? key
}

function ApiKeyForm({
  domain, provider, fields, owner, onDone,
}: {
  domain: Domain["domain"]
  provider: string
  fields: Domain["fields"]
  owner?: OwnerHint
  onDone: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  return (
    <form
      className="mt-2 space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        startTransition(async () => {
          const res = await connectApiKeyProvider({ domain, provider, fields: values, owner })
          if (res.ok) onDone()
          else setError(res.error)
        })
      }}
    >
      {fields.map((f) => (
        <div key={f.key} className="space-y-1">
          <Label htmlFor={`${provider}-${f.key}`} className="text-xs">{f.label}</Label>
          <Input
            id={`${provider}-${f.key}`}
            type={f.secret ? "password" : "text"}
            placeholder={f.placeholder}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            required={f.required}
            autoComplete="off"
          />
        </div>
      ))}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Connecting…" : "Connect"}</Button>
    </form>
  )
}

function ProviderRow({ domain, provider, fields, owner }: { domain: Domain["domain"]; provider: Provider; fields: Domain["fields"]; owner?: OwnerHint }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const name = label(PROVIDER_LABELS, provider.provider)

  const isStripeConnect = domain === "financial" && provider.provider === "stripe"
  const refresh = () => { setOpen(false); router.refresh() }
  const onDisconnect = () =>
    startTransition(async () => { await disconnectProvider({ domain, provider: provider.provider, owner }); router.refresh() })
  const onStripeConnect = () =>
    startTransition(async () => {
      const res = await startStripeConnect(owner)
      if (res.ok) window.location.href = res.url
    })

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          {provider.connected && (
            <Badge variant="default">connected{provider.detail ? ` · ${provider.detail}` : ""}</Badge>
          )}
          {!provider.available && !provider.connected && (
            <span className="text-xs text-muted-foreground">{provider.unavailableReason}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!provider.available ? (
            <Button size="sm" variant="outline" disabled>Unavailable</Button>
          ) : isStripeConnect ? (
            <Button size="sm" variant={provider.connected ? "outline" : "default"} disabled={pending} onClick={onStripeConnect}>
              {provider.connected ? "Reconnect" : "Connect"}
            </Button>
          ) : provider.auth === "oauth" && provider.oauthStartPath ? (
            <Button asChild size="sm" variant={provider.connected ? "outline" : "default"}>
              <a href={provider.oauthStartPath}>{provider.connected ? "Reconnect" : "Connect"}</a>
            </Button>
          ) : (
            <Button size="sm" variant={open ? "secondary" : provider.connected ? "outline" : "default"} onClick={() => setOpen((o) => !o)}>
              {provider.connected ? "Update" : "Connect"}
            </Button>
          )}
          {provider.connected && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={onDisconnect}>Disconnect</Button>
          )}
        </div>
      </div>
      {open && provider.available && provider.auth === "api_key" && (
        <ApiKeyForm domain={domain} provider={provider.provider} fields={fields} owner={owner} onDone={refresh} />
      )}
    </div>
  )
}

// "Sync a contact now" — the manual sync-out tool, BUILT INTO the Connection Center
// (rather than stranded on the legacy /settings/crm page). It is a DATA STEWARD
// operation (CRM/identity stewardship) and is labeled with that manager's identity;
// on success the action announces contact_crm_synced on the manager bus to the
// Sphere Manager, so the push is governed + visible in the Command Center feed.
function CrmSyncNowCard() {
  const steward = MANAGERS.data_steward
  const [contactId, setContactId] = useState("")
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  function syncNow() {
    const id = contactId.trim()
    if (!id) return
    setMsg(null)
    startTransition(async () => {
      const res = await syncContactNowAction(id)
      setMsg(res.ok
        ? { ok: true, text: `Synced to ${res.providerKey}${res.action ? ` (${res.action})` : ""}` }
        : { ok: false, text: res.error })
    })
  }

  return (
    <div className="mt-3 rounded-md border border-dashed p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Sync a contact now</span>
        <Badge variant="outline" className={`text-[10px] ${steward.accent}`}>{steward.label}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        Push one contact OUT to your active CRM immediately. Sync-out only — nothing syncs back in.
      </p>
      <div className="flex items-center gap-2">
        <Input
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
          placeholder="Contact ID"
          className="h-8 text-xs"
        />
        <Button size="sm" className="h-8 text-xs" disabled={pending || !contactId.trim()} onClick={syncNow}>
          {pending ? "Syncing…" : "Sync now"}
        </Button>
      </div>
      {msg && (
        <p className={`text-xs ${msg.ok ? "text-green-600" : "text-red-600"}`}>{msg.text}</p>
      )}
    </div>
  )
}

// Phone/SMS is PLATFORM-PROVIDED for every tier except the multi-location top tier:
// the platform owns Twilio, provisions the number, and bills it separately — the
// tenant never enters a carrier API key (see docs/PHONE-SYSTEM-SETUP.md). This panel
// makes that the primary path and bridges to the number/forwarding surface; the
// carrier API-key rows below are reframed as the ADVANCED "bring your own carrier"
// option (only the top tier assumes its own carrier registration).
function PlatformProvidedPhonePanel({ scope }: { scope: string }) {
  // The subscriber (broker/admin — "brokerage" scope) may let their MANAGED agents
  // bring their own carrier; otherwise the platform provisions + bills the number.
  const isSubscriber = scope === "brokerage"
  const [allowByo, setAllowByo] = useState<boolean | null>(null)
  const [saving, startSaving] = useTransition()

  useEffect(() => {
    if (!isSubscriber) return
    getByoCarrierPolicy().then((r) => setAllowByo(r.allowUserByo)).catch(() => setAllowByo(false))
  }, [isSubscriber])

  function toggleByo() {
    if (allowByo === null) return
    const next = !allowByo
    startSaving(async () => {
      const res = await setByoCarrierPolicy(next)
      if (res.ok) setAllowByo(next)
    })
  }

  return (
    <div className="rounded-md border bg-muted/40 p-3 space-y-2">
      <p className="text-sm font-medium">Your number is provided by the platform</p>
      <p className="text-xs text-muted-foreground">
        We provision and bill your calling/SMS number (Twilio, platform-owned) — there's no
        carrier API key to enter. Provision a number and set call forwarding in Phone setup.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline" className="h-8 text-xs">
          <Link href="/dashboard/admin/phone-settings">Provision number &amp; forwarding</Link>
        </Button>
        <Button asChild size="sm" variant="ghost" className="h-8 text-xs">
          <Link href="/dashboard/onboarding/ai-call-setup">AI call handling</Link>
        </Button>
      </div>
      {isSubscriber && (
        <div className="flex items-center justify-between border-t pt-2 mt-1">
          <div>
            <p className="text-xs font-medium">Let your agents bring their own carrier</p>
            <p className="text-[11px] text-muted-foreground">
              {allowByo
                ? "Agents may connect their own Twilio (they bill their own usage)."
                : "Agents use the platform-provided number (billed to you). You can always BYO for the brokerage."}
            </p>
          </div>
          <Button
            size="sm"
            variant={allowByo ? "default" : "outline"}
            className="h-7 text-xs"
            disabled={saving || allowByo === null}
            onClick={toggleByo}
          >
            {allowByo === null ? "…" : allowByo ? "On" : "Off"}
          </Button>
        </div>
      )}
    </div>
  )
}

export function ConnectionCenterClient({ data, owner }: { data: ConnectionCenter; owner?: OwnerHint }) {
  if (!data.ok) {
    return <p className="text-sm text-muted-foreground">{data.error ?? "Unable to load connections."}</p>
  }
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Connections available to your account ({data.scope}). Each is owned at your tier and used by
        the platform on your behalf.
      </p>
      {data.domains.map((d) => (
        <Card key={d.domain}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{label(DOMAIN_LABELS, d.domain)}</CardTitle>
            {DOMAIN_NOTES[d.domain] && (
              <p className="text-xs text-muted-foreground mt-1">{DOMAIN_NOTES[d.domain]}</p>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            {/* Phone/SMS: platform-provided is the primary path; the carrier
                API-key rows below are the advanced bring-your-own-carrier option. */}
            {d.domain === "phone" && <PlatformProvidedPhonePanel scope={data.scope} />}
            {d.domain === "phone" && d.providers.length > 0 && (
              <p className="text-[11px] font-medium text-muted-foreground pt-1">
                Advanced — bring your own carrier (top tier)
              </p>
            )}
            {d.providers.map((p) => (
              <ProviderRow key={p.provider} domain={d.domain} provider={p} fields={d.fields} owner={owner} />
            ))}
            {/* Feature parity with the legacy /settings/crm page — the manual
                sync-out tool now lives in the one Connection Center hub. */}
            {d.domain === "crm" && <CrmSyncNowCard />}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
