"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Package, CheckCircle2, Loader2, AlertCircle, Sparkles } from "lucide-react"
import { activateMarketingPackage } from "@/app/actions/marketing-package-automation"
import {
  MARKETING_PACKAGE_TYPES,
  buildPackagePreview,
  type MarketingPackageType,
} from "@/lib/marketing/package-catalog"

interface ActivePackage {
  id: string
  package_name: string | null
  package_type: string | null
  status: string | null
  total_estimated_cost: number | null
  included_services: string[] | null
  activated_at: string | null
}

interface MarketingPackagePanelProps {
  transactionId: string | null
  activePackage: ActivePackage | null
}

const formatCurrency = (amount: number | null) => {
  if (amount === null || amount === undefined) return "$0"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount)
}

const prettyService = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())

export function MarketingPackagePanel({ transactionId, activePackage }: MarketingPackagePanelProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [selected, setSelected] = useState<MarketingPackageType | null>(null)
  const [error, setError] = useState<string | null>(null)

  const preview = selected ? buildPackagePreview(selected) : null

  const handleActivate = () => {
    if (!transactionId || !selected) return
    setError(null)
    startTransition(async () => {
      const result = await activateMarketingPackage({
        transactionId,
        packageType: selected,
        // Display-and-confirm only: we activate the package state + syndication
        // tracking. We never auto-book vendor services from this surface.
        autoBookServices: false,
      })
      if (result.success) {
        setSelected(null)
        router.refresh()
      } else {
        setError(result.error ?? "Failed to activate package")
      }
    })
  }

  if (!transactionId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            Marketing Package
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-amber-600">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <p className="text-sm">
              No transaction exists for this listing yet. A marketing package activates against the
              listing&apos;s transaction — create the transaction first, then return here to activate
              a package.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Active package status */}
      {activePackage && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              Active Package
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xl font-bold">{activePackage.package_name}</span>
              <Badge variant={activePackage.status === "active" ? "default" : "secondary"}>
                {activePackage.status}
              </Badge>
              <Badge variant="outline">{formatCurrency(activePackage.total_estimated_cost)}</Badge>
            </div>
            {Array.isArray(activePackage.included_services) &&
              activePackage.included_services.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {activePackage.included_services.map((s) => (
                    <Badge key={s} variant="secondary" className="font-normal">
                      {prettyService(s)}
                    </Badge>
                  ))}
                </div>
              )}
            {activePackage.activated_at && (
              <p className="text-xs text-muted-foreground">
                Activated {new Date(activePackage.activated_at).toLocaleDateString()}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Activate / change package */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            {activePackage ? "Activate a Different Package" : "Activate a Marketing Package"}
          </CardTitle>
          <CardDescription>
            Choose a package to provision its marketing services and initialize portal syndication
            tracking for this listing&apos;s transaction. You confirm before anything is activated.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {MARKETING_PACKAGE_TYPES.map((type) => {
              const p = buildPackagePreview(type)
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    setError(null)
                    setSelected(type)
                  }}
                  className="rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <p className="text-base font-semibold capitalize">{type}</p>
                  <p className="mt-1 text-2xl font-bold">{formatCurrency(p.estimatedCost)}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {p.services.length} services included
                  </p>
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Confirm dialog — shows package contents before activating */}
      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{preview ? `Activate ${preview.packageName}` : "Activate Package"}</DialogTitle>
            <DialogDescription>
              {preview
                ? `Estimated cost ${formatCurrency(preview.estimatedCost)}. Review the included services below, then confirm.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="space-y-3 py-2">
              <p className="text-sm font-medium">Included services</p>
              <div className="flex flex-wrap gap-1.5">
                {preview.services.map((s) => (
                  <Badge key={s} variant="secondary" className="font-normal">
                    {prettyService(s)}
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Activation provisions the package and starts portal syndication tracking. Vendor
                services are not auto-booked — book them individually afterward.
              </p>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelected(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={handleActivate} disabled={isPending || !preview}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Activate Package
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
