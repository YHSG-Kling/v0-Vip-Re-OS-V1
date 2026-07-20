"use client"

import { useState, useTransition } from "react"
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

const DOMAIN_LABELS: Record<string, string> = {
  email: "Email", phone: "Phone / SMS", calendar: "Calendar", social: "Social",
  crm: "CRM (sync-out)", financial: "Financial", listing: "IDX / Listings",
  transaction: "Transaction Management", esign: "E-Signature", showing: "Showings",
  podcast: "Podcast Syndication",
  meetings: "Video Meetings",
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
          </CardHeader>
          <CardContent className="space-y-2">
            {d.providers.map((p) => (
              <ProviderRow key={p.provider} domain={d.domain} provider={p} fields={d.fields} owner={owner} />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
