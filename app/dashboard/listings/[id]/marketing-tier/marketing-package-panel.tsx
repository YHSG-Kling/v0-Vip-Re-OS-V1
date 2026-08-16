"use client"

import { useCallback, useEffect, useState, useTransition } from "react"
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
import { Package, CheckCircle2, Loader2, AlertCircle, Sparkles, Globe, RefreshCw } from "lucide-react"
import {
  activateMarketingPackage,
  bookMarketingService,
  getMarketingPackageServices,
  getSyndicationStatus,
  getVendorRecommendations,
  syncListingToPlatforms,
} from "@/app/actions/marketing-package-automation"
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

interface BookedService {
  id: string
  service_type: string | null
  status: string | null
  scheduled_date: string | null
  estimated_cost: number | null
  vendor: { company_name: string | null } | null
}

/**
 * One row of the ranked bench behind a Book button. Every field comes from
 * getVendorRecommendations, which ranks on the SAME published rules the
 * automation books with — so this list is the order it would actually pick in,
 * not a second opinion.
 */
interface VendorCandidate {
  id: string
  name: string | null
  rating: number | null
  preferred: boolean | null
  estimated_turnaround_days: number | null
  score: number
  measured: string[]
  unmeasured: string[]
  autoBookable: boolean
  autoBookBlockedReason: string | null
}

interface SyndicationRow {
  id: string
  platform_name: string | null
  platform_category: string | null
  syndication_status: string | null
  listing_url: string | null
  last_synced_at: string | null
}

export function MarketingPackagePanel({ transactionId, activePackage }: MarketingPackagePanelProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [selected, setSelected] = useState<MarketingPackageType | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Booked vendor services for the active package. The activation copy promises
  // "book them individually afterward" — this is the surface that lets you.
  const [services, setServices] = useState<BookedService[]>([])
  const [servicesLoading, setServicesLoading] = useState(false)
  const [bookingService, setBookingService] = useState<string | null>(null)
  const [bookError, setBookError] = useState<string | null>(null)

  // The ranked bench behind a Book button, per service type. An agent used to
  // click Book and receive whoever the automation chose, with no sight of who
  // else was considered or why. Keyed by service type so opening one does not
  // discard another.
  const [candidates, setCandidates] = useState<Record<string, VendorCandidate[]>>({})
  const [candidatesLoading, setCandidatesLoading] = useState<string | null>(null)
  const [openCandidates, setOpenCandidates] = useState<string | null>(null)

  // Portal syndication tracking, initialised by activation. Nothing showed it.
  const [syndication, setSyndication] = useState<SyndicationRow[]>([])
  const [syndicationLoading, setSyndicationLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)

  const packageId = activePackage?.id ?? null

  const loadServices = useCallback(async () => {
    if (!packageId) { setServices([]); return }
    setServicesLoading(true)
    try {
      const rows = await getMarketingPackageServices(packageId)
      setServices((rows ?? []) as unknown as BookedService[])
    } finally {
      setServicesLoading(false)
    }
  }, [packageId])

  const loadSyndication = useCallback(async () => {
    if (!transactionId) { setSyndication([]); return }
    setSyndicationLoading(true)
    try {
      const rows = await getSyndicationStatus(transactionId)
      setSyndication((rows ?? []) as unknown as SyndicationRow[])
    } finally {
      setSyndicationLoading(false)
    }
  }, [transactionId])

  useEffect(() => { void loadServices() }, [loadServices])
  useEffect(() => { void loadSyndication() }, [loadSyndication])

  const bookedTypes = new Set(services.map((s) => s.service_type).filter(Boolean) as string[])
  const unbookedServices = (activePackage?.included_services ?? []).filter((s) => !bookedTypes.has(s))

  /**
   * Load (or collapse) the bench for one service. The result is cached per
   * service type: the ranking is deterministic and the bench does not change
   * between two clicks, so re-fetching would only add latency.
   */
  const toggleCandidates = (serviceType: string) => {
    if (openCandidates === serviceType) { setOpenCandidates(null); return }
    setOpenCandidates(serviceType)
    if (candidates[serviceType] || !transactionId) return
    setCandidatesLoading(serviceType)
    void (async () => {
      try {
        const rows = await getVendorRecommendations(serviceType, transactionId)
        setCandidates((prev) => ({ ...prev, [serviceType]: (rows ?? []) as unknown as VendorCandidate[] }))
      } finally {
        setCandidatesLoading(null)
      }
    })()
  }

  const handleBook = (serviceType: string) => {
    if (!packageId || !transactionId) return
    setBookError(null)
    setBookingService(serviceType)
    startTransition(async () => {
      const result = await bookMarketingService({
        packageId,
        serviceType,
        transactionId,
      })
      setBookingService(null)
      if (!result.success) {
        // Surface the refusal — "No available vendors for this service" is the
        // answer an agent needs, not a silently unchanged list.
        setBookError(result.error ?? `Could not book ${serviceType}`)
        return
      }
      await loadServices()
    })
  }

  const handleSync = () => {
    if (!transactionId) return
    setSyncMessage(null)
    setSyncing(true)
    startTransition(async () => {
      const result = await syncListingToPlatforms(transactionId)
      setSyncing(false)
      if (!result.success) {
        setSyncMessage(result.error ?? "Syndication sync failed")
        return
      }
      setSyncMessage(
        typeof result.synced === "number"
          ? `Synced ${result.synced} platform${result.synced === 1 ? "" : "s"}`
          : (result.message ?? "No pending syndications")
      )
      await loadSyndication()
    })
  }

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
        // Activation seeds syndication tracking rows — pull them straight away
        // instead of leaving the section empty until the next navigation.
        await loadSyndication()
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

      {/* Vendor services for the active package */}
      {activePackage && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Vendor Services</CardTitle>
            <CardDescription>
              Book each included service to the best-matching approved vendor in your brokerage.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {servicesLoading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading services…
              </p>
            ) : (
              <>
                {services.length > 0 && (
                  <div className="space-y-2">
                    {services.map((s) => (
                      <div
                        key={s.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{prettyService(s.service_type ?? "Service")}</p>
                          <p className="text-xs text-muted-foreground">
                            {s.vendor?.company_name ?? "Vendor pending"}
                            {s.scheduled_date
                              ? ` · ${new Date(s.scheduled_date).toLocaleDateString()}`
                              : " · unscheduled"}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {s.estimated_cost !== null && (
                            <Badge variant="outline">{formatCurrency(s.estimated_cost)}</Badge>
                          )}
                          <Badge variant="secondary">{s.status ?? "scheduled"}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {unbookedServices.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Not booked yet</p>
                    <div className="space-y-2">
                      {unbookedServices.map((s) => (
                        <div key={s} className="rounded-lg border p-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={isPending && bookingService === s}
                              onClick={() => handleBook(s)}
                            >
                              {isPending && bookingService === s && (
                                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                              )}
                              Book {prettyService(s)}
                            </Button>
                            {/* Booking used to be the only affordance here, so the
                                choice of vendor was invisible until after it was
                                made. This shows the same ranking the automation
                                books with, BEFORE the click. */}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => toggleCandidates(s)}
                            >
                              {openCandidates === s ? "Hide" : "Who would be booked?"}
                            </Button>
                          </div>

                          {openCandidates === s && (
                            <div className="mt-2 space-y-1.5 border-t pt-2">
                              {candidatesLoading === s ? (
                                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the bench…
                                </p>
                              ) : (candidates[s] ?? []).length === 0 ? (
                                <p className="text-xs text-muted-foreground">
                                  No approved vendor on this brokerage&apos;s bench handles{" "}
                                  {prettyService(s).toLowerCase()}. Booking it will say the same.
                                </p>
                              ) : (
                                <>
                                  {(candidates[s] ?? []).map((v, i) => (
                                    <div key={v.id} className="flex flex-wrap items-baseline justify-between gap-2">
                                      <div className="min-w-0">
                                        <p className="text-xs font-medium">
                                          {i + 1}. {v.name ?? "Unnamed vendor"}
                                          {v.preferred === true && (
                                            <Badge variant="secondary" className="ml-2">Preferred</Badge>
                                          )}
                                          {i === 0 && v.autoBookable && (
                                            <Badge variant="outline" className="ml-2">Would be booked</Badge>
                                          )}
                                        </p>
                                        <p className="text-[11px] text-muted-foreground">
                                          {v.rating !== null ? `Rated ${v.rating.toFixed(1)}` : "Unrated"}
                                          {v.estimated_turnaround_days !== null
                                            ? ` · ~${v.estimated_turnaround_days}d turnaround`
                                            : " · turnaround unknown"}
                                        </p>
                                        {/* The honest half: what the ranking could
                                            NOT weigh on this row. A blank column
                                            scores nothing and says so, rather than
                                            defaulting to a flattering number. */}
                                        {v.unmeasured.length > 0 && (
                                          <p className="text-[11px] text-muted-foreground">
                                            Not counted (no value on record):{" "}
                                            {v.unmeasured.map((u) => u.replace(/_/g, " ")).join(", ")}
                                          </p>
                                        )}
                                        {v.autoBookBlockedReason && (
                                          <p className="text-[11px] text-muted-foreground">
                                            {v.autoBookBlockedReason}
                                          </p>
                                        )}
                                      </div>
                                    </div>
                                  ))}
                                  <p className="text-[11px] text-muted-foreground">
                                    Ranked on rating, your preferred flag, your display order and
                                    turnaround — the same rules the automation books with.
                                  </p>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : services.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Every service in this package is booked.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No services booked yet.
                  </p>
                )}

                {bookError && <p className="text-sm text-destructive">{bookError}</p>}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Portal syndication tracking */}
      {transactionId && (syndication.length > 0 || syndicationLoading) && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4 pb-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Globe className="h-5 w-5" />
                Portal Syndication
              </CardTitle>
              <CardDescription>Where this listing is published, and what is still pending.</CardDescription>
            </div>
            <Button size="sm" variant="outline" className="shrink-0" disabled={syncing} onClick={handleSync}>
              <RefreshCw className={`mr-2 h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
              Sync Pending
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {syndicationLoading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading syndication status…
              </p>
            ) : (
              syndication.map((row) => (
                <div
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{row.platform_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.platform_category?.replace(/_/g, " ") ?? "portal"}
                      {row.last_synced_at
                        ? ` · last synced ${new Date(row.last_synced_at).toLocaleDateString()}`
                        : ""}
                    </p>
                  </div>
                  <Badge variant={row.syndication_status === "active" ? "default" : "secondary"}>
                    {row.syndication_status ?? "pending"}
                  </Badge>
                </div>
              ))
            )}
            {syncMessage && <p className="text-sm text-muted-foreground">{syncMessage}</p>}
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
