"use client"

// Premium Placement panel — the monetization surface on the Preferred tab.
// Brokerage leadership charges vendors for featured placement in the curated
// directory (vendor_directory): offer → placement invoice (awaiting payment)
// → "Mark paid & feature" once funds are collected (check / ACH / external
// Stripe invoice — collection is manual in v1; see lib/vendors/premium-placement).

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Megaphone, Star } from "lucide-react"
import {
  offerPremiumPlacementAction,
  markPlacementPaidAction,
} from "@/app/actions/vendor-premium-placement"

export interface DirectoryEntry {
  id: string
  name: string | null
  category: string | null
  preferred: boolean | null
  display_priority: number | null
}

export interface PlacementInvoice {
  id: string
  invoice_number: string | null
  status: string
  total_amount: number | null
  due_date: string | null
  paid_at: string | null
  line_items: Array<{
    type?: string
    months?: number
    price_cents?: number
    directory_id?: string
    placement_until?: string
  }> | null
}

const MANAGER_ROLES = ["admin", "broker", "broker_admin", "superadmin", "team_lead"]
const PAYMENT_METHODS = ["check", "ach", "stripe", "cash_app", "manual"]

function placementItem(inv: PlacementInvoice) {
  return inv.line_items?.find((li) => li?.type === "premium_placement") ?? null
}

export function PremiumPlacementPanel({
  directoryEntries,
  placementInvoices,
  userRole,
}: {
  directoryEntries: DirectoryEntry[]
  placementInvoices: PlacementInvoice[]
  userRole: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [offerFor, setOfferFor] = useState<string | null>(null)
  const [months, setMonths] = useState("3")
  const [price, setPrice] = useState("150")
  const [payMethod, setPayMethod] = useState("check")
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const canManage = MANAGER_ROLES.includes(userRole)

  // Latest paid placement term per directory row → "active until" line.
  const activeUntil = new Map<string, string>()
  for (const inv of placementInvoices) {
    if (inv.status !== "paid") continue
    const item = placementItem(inv)
    if (!item?.directory_id || !item.placement_until) continue
    const existing = activeUntil.get(item.directory_id)
    if (!existing || item.placement_until > existing) {
      activeUntil.set(item.directory_id, item.placement_until)
    }
  }

  const openInvoices = placementInvoices.filter(
    (inv) => inv.status !== "paid" && inv.status !== "cancelled"
  )

  const handleOffer = (directoryId: string) => {
    setMessage(null)
    setError(null)
    const monthsNum = parseInt(months, 10)
    const priceCents = Math.round(parseFloat(price) * 100)
    startTransition(async () => {
      const result = await offerPremiumPlacementAction({
        vendorDirectoryId: directoryId,
        months: monthsNum,
        priceCents,
      })
      if (!result.success) {
        setError(result.error ?? "Failed to create placement offer.")
        return
      }
      setMessage(`Placement invoice ${result.invoiceNumber} created — mark it paid once the vendor pays.`)
      setOfferFor(null)
      router.refresh()
    })
  }

  const handleMarkPaid = (invoiceId: string) => {
    setMessage(null)
    setError(null)
    startTransition(async () => {
      const result = await markPlacementPaidAction({ invoiceId, paymentMethod: payMethod })
      if (!result.success) {
        setError(result.error ?? "Failed to mark placement paid.")
        return
      }
      const until = result.placementUntil
        ? new Date(result.placementUntil).toLocaleDateString()
        : null
      setMessage(until ? `Vendor featured — placement active until ${until}.` : "Vendor featured.")
      router.refresh()
    })
  }

  if (directoryEntries.length === 0 && placementInvoices.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Megaphone className="h-5 w-5" />
          Premium Placement
        </CardTitle>
        <CardDescription>
          Charge vendors for featured placement in your curated directory. Payment is
          collected off-platform (check, ACH, or a Stripe invoice you send) — mark the
          invoice paid once funds arrive to feature the vendor.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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

        {/* Directory entries — offer placement per row */}
        <div className="space-y-3">
          {directoryEntries.map((entry) => {
            const until = activeUntil.get(entry.id)
            return (
              <div key={entry.id} className="p-4 border rounded-lg hover:bg-muted/50 transition-colors">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{entry.name || "Vendor"}</p>
                      {entry.preferred && (
                        <Badge variant="secondary" className="gap-1">
                          <Star className="h-3 w-3 text-yellow-500 fill-yellow-500" />
                          Featured
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">{entry.category}</p>
                    {until && (
                      <p className="text-xs text-muted-foreground">
                        Placement active until {new Date(until).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                  {canManage && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOfferFor(offerFor === entry.id ? null : entry.id)}
                      disabled={isPending}
                    >
                      Offer premium placement
                    </Button>
                  )}
                </div>

                {canManage && offerFor === entry.id && (
                  <div className="mt-3 flex flex-wrap items-end gap-3 border-t pt-3">
                    <div className="space-y-1">
                      <Label htmlFor={`pp-months-${entry.id}`} className="text-xs">Months</Label>
                      <Input
                        id={`pp-months-${entry.id}`}
                        type="number"
                        min={1}
                        max={60}
                        value={months}
                        onChange={(e) => setMonths(e.target.value)}
                        className="w-24 h-9"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`pp-price-${entry.id}`} className="text-xs">Price ($)</Label>
                      <Input
                        id={`pp-price-${entry.id}`}
                        type="number"
                        min={1}
                        step="0.01"
                        value={price}
                        onChange={(e) => setPrice(e.target.value)}
                        className="w-28 h-9"
                      />
                    </div>
                    <Button size="sm" onClick={() => handleOffer(entry.id)} disabled={isPending}>
                      {isPending ? "Creating..." : "Create placement invoice"}
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Pending placement invoices — mark paid & feature */}
        {openInvoices.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm font-medium">Placement invoices awaiting payment</p>
            {openInvoices.map((inv) => {
              const item = placementItem(inv)
              const entry = directoryEntries.find((d) => d.id === item?.directory_id)
              return (
                <div
                  key={inv.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-4 border rounded-lg"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{inv.invoice_number ?? inv.id.slice(0, 8)}</p>
                      <Badge variant="outline">{inv.status}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {entry?.name ?? "Directory entry"} — {item?.months ?? "?"} mo — $
                      {Number(inv.total_amount ?? 0).toFixed(2)}
                      {inv.due_date ? ` — due ${new Date(inv.due_date).toLocaleDateString()}` : ""}
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-2">
                      <Select value={payMethod} onValueChange={setPayMethod}>
                        <SelectTrigger className="w-28 h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PAYMENT_METHODS.map((m) => (
                            <SelectItem key={m} value={m}>
                              {m}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button size="sm" onClick={() => handleMarkPaid(inv.id)} disabled={isPending}>
                        {isPending ? "Saving..." : "Mark paid & feature"}
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
