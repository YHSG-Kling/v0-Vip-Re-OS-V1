"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CreditCard, CheckCircle2, Loader2 } from "lucide-react"
import { ProviderConnectionCard } from "@/app/settings/accounting/provider-connection-card"
import {
  markClientInvoiceCollected,
  syncVendorInvoiceToQuickBooksAction,
} from "@/app/actions/vendor-payments"

export interface VendorInvoiceRow {
  id: string
  invoiceNumber: string | null
  billedTo: string
  contactName: string | null
  status: string
  total: number
  dueDate: string | null
  paidAt: string | null
  paymentMethod: string | null
  createdAt: string | null
  quickbooksInvoiceId: string | null
}

const STATUS_COLOR: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  submitted: "bg-blue-100 text-blue-700",
  viewed: "bg-indigo-100 text-indigo-700",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-500",
  disputed: "bg-amber-100 text-amber-700",
}

const COLLECT_METHODS = ["check", "cash", "card", "ach", "other"]

function fmt(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount)
}

export function VendorInvoicesClient({
  vendorId,
  invoices,
  stripeReady,
  quickbooksConnected,
}: {
  vendorId: string
  invoices: VendorInvoiceRow[]
  stripeReady: boolean
  quickbooksConnected: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [actingOn, setActingOn] = useState<string | null>(null)
  const [collectMethod, setCollectMethod] = useState("check")
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const billedByMe = invoices.filter((i) => i.billedTo === "brokerage" || i.billedTo === "contact")
  const chargesToMe = invoices.filter((i) => i.billedTo === "vendor")

  function handleMarkCollected(inv: VendorInvoiceRow) {
    if (
      !confirm(
        "Confirm you collected this payment directly from the client (check, cash, card, or ACH outside the platform). This records YOUR assertion of collection."
      )
    )
      return
    setActingOn(inv.id)
    setMessage(null)
    setError(null)
    startTransition(async () => {
      const res = await markClientInvoiceCollected({
        vendorId,
        invoiceId: inv.id,
        paymentMethod: collectMethod,
      })
      if (res.success) {
        setMessage(`Invoice ${inv.invoiceNumber ?? inv.id.slice(0, 8)} marked collected.`)
        router.refresh()
      } else {
        setError(res.error ?? "Failed to mark collected")
      }
      setActingOn(null)
    })
  }

  function handleSync(inv: VendorInvoiceRow) {
    setActingOn(inv.id)
    setMessage(null)
    setError(null)
    startTransition(async () => {
      const res = await syncVendorInvoiceToQuickBooksAction({ vendorId, invoiceId: inv.id })
      if (res.success) {
        setMessage(`Synced to QuickBooks (QBO invoice ${res.externalId}).`)
        router.refresh()
      } else {
        setError(res.error ?? "QuickBooks sync failed")
      }
      setActingOn(null)
    })
  }

  return (
    <div className="space-y-6">
      {/* Accounting posture */}
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <CreditCard className="h-4 w-4" />
              Online payments (Stripe)
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            {stripeReady ? (
              <p className="text-green-700 flex items-center gap-1">
                <CheckCircle2 className="h-4 w-4" />
                Connected — clients you invoice can pay online; funds land in your Stripe account.
              </p>
            ) : (
              <>
                <p className="text-muted-foreground">
                  Not set up. Until you connect Stripe, clients see instructions to pay you
                  directly (check / card / ACH) and you mark the invoice collected here.
                </p>
                <Link href="/vendor/earnings">
                  <Button size="sm" variant="outline">Set up Stripe payouts</Button>
                </Link>
              </>
            )}
          </CardContent>
        </Card>

        {/* ONE shared accounting card (same component as brokerage/team/agent/platform).
            Connect hits the REAL OAuth route (scope resolves to vendor server-side);
            invoices show "Not synced" until a real export happens — nothing silent. */}
        <ProviderConnectionCard
          provider="quickbooks"
          scope="vendor"
          status="connectable"
          connected={quickbooksConnected}
          connectPath="/api/integrations/oauth/quickbooks"
          note="Not connected. Invoices show “Not synced” until you connect your own QuickBooks company — nothing is synced silently."
          vendorId={vendorId}
        />
      </div>

      {message && (
        <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          {message}
        </p>
      )}
      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {/* Invoices the vendor issued */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invoices you issued</CardTitle>
          <CardDescription>
            Raise new invoices from a completed job on the{" "}
            <Link href="/vendor/jobs" className="underline">Jobs</Link> page. Contact-billed
            invoices appear in the client’s portal, where they can pay online when your Stripe
            is connected.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {billedByMe.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No invoices yet — create one from a completed job.
            </p>
          ) : (
            <div className="space-y-2">
              {billedByMe.map((inv) => {
                const unpaidContact =
                  inv.billedTo === "contact" && inv.status !== "paid" && inv.status !== "cancelled"
                return (
                  <div
                    key={inv.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3 border-b last:border-0 text-sm"
                  >
                    <div className="flex flex-col min-w-0">
                      <span className="font-medium">
                        {inv.invoiceNumber ?? `INV-${inv.id.slice(0, 8).toUpperCase()}`}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Billed to: {inv.billedTo === "contact" ? (inv.contactName ?? "client") : "brokerage"}
                        {inv.dueDate && ` · Due ${new Date(inv.dueDate).toLocaleDateString()}`}
                        {inv.paidAt && ` · Paid ${new Date(inv.paidAt).toLocaleDateString()}`}
                        {inv.status === "paid" && inv.paymentMethod && ` (${inv.paymentMethod})`}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold">{fmt(inv.total)}</span>
                      <Badge className={STATUS_COLOR[inv.status] ?? "bg-gray-100 text-gray-600"}>
                        {inv.status}
                      </Badge>
                      {/* QuickBooks sync state — always honest */}
                      {inv.quickbooksInvoiceId ? (
                        <Badge variant="outline" className="text-xs gap-1 text-green-700 border-green-200">
                          <CheckCircle2 className="h-3 w-3" /> QB synced
                        </Badge>
                      ) : (
                        <>
                          <Badge variant="outline" className="text-xs text-muted-foreground">
                            Not synced
                          </Badge>
                          {quickbooksConnected && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-xs"
                              disabled={isPending && actingOn === inv.id}
                              onClick={() => handleSync(inv)}
                            >
                              {isPending && actingOn === inv.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                "Sync to QB"
                              )}
                            </Button>
                          )}
                        </>
                      )}
                      {unpaidContact && (
                        <div className="flex items-center gap-1">
                          <Select value={collectMethod} onValueChange={setCollectMethod}>
                            <SelectTrigger className="w-24 h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {COLLECT_METHODS.map((m) => (
                                <SelectItem key={m} value={m}>{m}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-xs text-emerald-700 border-emerald-200"
                            disabled={isPending && actingOn === inv.id}
                            onClick={() => handleMarkCollected(inv)}
                          >
                            {isPending && actingOn === inv.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              "Mark collected"
                            )}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Charges the brokerage issued TO the vendor */}
      {chargesToMe.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Charges from your brokerage partner</CardTitle>
            <CardDescription>
              Invoices the brokerage issued to you (e.g. featured placement, services).
              Pay the brokerage directly — they mark the invoice paid on receipt.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {chargesToMe.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between gap-3 py-3 border-b last:border-0 text-sm"
                >
                  <div className="flex flex-col">
                    <span className="font-medium">
                      {inv.invoiceNumber ?? `INV-${inv.id.slice(0, 8).toUpperCase()}`}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {inv.dueDate && `Due ${new Date(inv.dueDate).toLocaleDateString()}`}
                      {inv.paidAt && ` · Paid ${new Date(inv.paidAt).toLocaleDateString()}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{fmt(inv.total)}</span>
                    <Badge className={STATUS_COLOR[inv.status] ?? "bg-gray-100 text-gray-600"}>
                      {inv.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
