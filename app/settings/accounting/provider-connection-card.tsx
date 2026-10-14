"use client"

// THE one accounting-connection card, reused at every level of the hierarchy
// (platform / brokerage / team / agent / vendor — the keep-one rule). Driven by
// the offering matrix in lib/connections/accounting-scopes.ts:
//   • "connectable"        → a real connect button that hits the REAL flow
//                            (/api/integrations/oauth/quickbooks or the Stripe
//                            Connect surface) — never a dead link.
//   • "managed-elsewhere"  → honest informational note (+ link) — e.g. Stripe at
//                            platform/brokerage level IS the billing spine.
//   • "not-offered"        → the documented verdict rendered verbatim (e.g. no
//                            team billing flow), no button at all.
// Connect is additionally gated by `canConnect`: the OAuth route derives the
// owner scope from the LOGGED-IN user's role, so a card only shows the button
// when this user's role actually maps to this card's scope (a broker on the
// team page sees the honest reason instead of silently connecting the wrong
// owner's books).

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { disconnectProvider as disconnectBrokerageAccounting } from "@/app/actions/accounting-sync"
import { disconnectProvider as disconnectOwnerScoped } from "@/app/actions/connections/connection-center"
import { CheckCircle2, XCircle, Loader2, ExternalLink, Info, MinusCircle } from "lucide-react"
import { toast } from "sonner"

// TOMBSTONE (§1.1 / §6, 2026-08-29): `AccountingCardScope` — a byte-identical
// second spelling of the scope ladder — is DELETED.
// SURVIVOR: lib/connections/accounting-scopes.ts:46 `AccountingScope`, which is
// the one the OFFERING MATRIX is keyed on (`ACCOUNTING_OFFERINGS:
// Record<AccountingScope, …>`) and which `ACCOUNTING_SCOPES` enumerates. There
// was nothing to merge onto it — the two lists carried the same five arms — but
// only one of them can be the vocabulary, and a card cannot be the authority on
// a ladder whose matrix lives elsewhere: add a sixth scope to the matrix and the
// old copy would have gone on type-checking while rendering nothing for it.
// The `status` prop's inline union was the same defect one line down; its
// doc-comment already NAMED the survivor it was refusing to import.
//
// Type-only import ON PURPOSE: accounting-scopes.ts pulls in the connector
// gateway at runtime, and this is a "use client" file. `import type` is erased,
// so the vocabulary is shared without dragging server code into the bundle.
import type { AccountingScope, AccountingOfferingStatus } from "@/lib/connections/accounting-scopes"

interface ProviderConnectionCardProps {
  provider: "quickbooks" | "xero" | "stripe" | "zoom"
  scope: AccountingScope
  /** Offering status from lib/connections/accounting-scopes.ts. */
  status: AccountingOfferingStatus
  connected: boolean
  /** Company / account label when connected (QBO account name, acct_… id, …). */
  companyName?: string | null
  lastSyncedAt?: string | null
  /** REAL connect path (OAuth route or Connect surface) for "connectable";
   *  informational link for "managed-elsewhere". */
  connectPath?: string | null
  /** Verdict / note rendered for managed-elsewhere + not-offered (and as helper
   *  text when connectable). */
  note?: string | null
  /** May the CURRENT user connect at this scope? (Their login must map to it —
   *  the OAuth route resolves scope from the user's role.) */
  canConnect?: boolean
  connectDisabledReason?: string | null
  /** Brokerage scope only: routes disconnect through the accounting-sync action. */
  brokerageId?: string | null
  /** Vendor scope: owner hint for the owner-scoped disconnect action. */
  vendorId?: string | null
  /** platform_credentials key when it differs from `provider` (platform books
   *  use the distinct 'platform_quickbooks' key). */
  storageKey?: string | null
}

const PROVIDER_LABELS: Record<string, { name: string; color: string; bg: string }> = {
  quickbooks: { name: "QuickBooks", color: "text-green-600", bg: "bg-green-50" },
  xero: { name: "Xero", color: "text-blue-600", bg: "bg-blue-50" },
  stripe: { name: "Stripe", color: "text-purple-600", bg: "bg-purple-50" },
  zoom: { name: "Zoom", color: "text-sky-600", bg: "bg-sky-50" },
}

export function ProviderConnectionCard({
  provider,
  scope,
  status,
  connected,
  companyName = null,
  lastSyncedAt = null,
  connectPath = null,
  note = null,
  canConnect = true,
  connectDisabledReason = null,
  brokerageId = null,
  vendorId = null,
  storageKey = null,
}: ProviderConnectionCardProps) {
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const meta = PROVIDER_LABELS[provider] ?? PROVIDER_LABELS.quickbooks

  const handleDisconnect = async () => {
    if (!confirm(`Are you sure you want to disconnect ${meta.name}?`)) return
    setIsDisconnecting(true)
    try {
      if (scope === "brokerage" && brokerageId && (provider === "quickbooks" || provider === "xero")) {
        await disconnectBrokerageAccounting({ provider, brokerageId })
      } else {
        const res = await disconnectOwnerScoped({
          // Zoom is the meetings domain; everything else on this card is financial.
          domain: provider === "zoom" ? "meetings" : "financial",
          provider: storageKey ?? provider,
          owner: scope === "vendor" && vendorId ? { scope: "vendor", id: vendorId } : undefined,
        })
        if (!res.ok) throw new Error(res.error)
      }
      window.location.reload()
    } catch (error) {
      console.error("Failed to disconnect:", error)
      toast.error(error instanceof Error ? error.message : "Failed to disconnect provider")
    } finally {
      setIsDisconnecting(false)
    }
  }

  // ── Not offered: the documented verdict, no button (never a dead control). ──
  if (status === "not-offered") {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg text-muted-foreground">{meta.name}</CardTitle>
            <Badge variant="outline">
              <span className="flex items-center gap-1">
                <MinusCircle className="h-3 w-3" />
                Not offered
              </span>
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{note ?? "Not offered at this level."}</p>
        </CardContent>
      </Card>
    )
  }

  // ── Managed elsewhere: honest note + link, no connect/disconnect controls. ──
  if (status === "managed-elsewhere") {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className={`text-lg ${meta.color}`}>{meta.name}</CardTitle>
            <Badge variant="secondary">
              <span className="flex items-center gap-1">
                <Info className="h-3 w-3" />
                Managed elsewhere
              </span>
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{note}</p>
          {connectPath && (
            <a href={connectPath}>
              <Button variant="outline" size="sm">
                <ExternalLink className="h-4 w-4 mr-2" />
                Open
              </Button>
            </a>
          )}
        </CardContent>
      </Card>
    )
  }

  // ── Connectable ────────────────────────────────────────────────────────────
  return (
    <Card className={connected ? meta.bg : ""}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className={`text-lg ${meta.color}`}>{meta.name}</CardTitle>
          <Badge variant={connected ? "default" : "secondary"}>
            {connected ? (
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Connected
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <XCircle className="h-3 w-3" />
                Not Connected
              </span>
            )}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {connected ? (
          <>
            {companyName && (
              <div className="text-sm">
                <span className="text-muted-foreground">Account: </span>
                <span className="font-medium">{companyName}</span>
              </div>
            )}
            {lastSyncedAt ? (
              <div className="text-sm">
                <span className="text-muted-foreground">Last synced: </span>
                <span className="font-medium">{new Date(lastSyncedAt).toLocaleString()}</span>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">Not synced yet.</div>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleDisconnect}
              disabled={isDisconnecting}
              className="w-full"
            >
              {isDisconnecting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Disconnecting...
                </>
              ) : (
                "Disconnect"
              )}
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {note ?? `Connect your ${meta.name} account to sync your books.`}
            </p>
            {canConnect && connectPath ? (
              <a href={connectPath} className="block">
                <Button className="w-full">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Connect {meta.name}
                </Button>
              </a>
            ) : (
              <p className="text-sm text-amber-700">
                {connectDisabledReason ?? "Your account can't connect at this level."}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
