"use client"

import { useEffect, useState, useCallback } from "react"
import { useParams } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription
} from "@/components/ui/sheet"
import {
  createPropertyAlert, updatePropertyAlert, pausePropertyAlert,
  resumePropertyAlert, deletePropertyAlert, getAlertResults,
  getBuyerAlertSummary, runAlertNow, previewAlertCriteria, prefillFromProfile
} from "@/app/actions/property-alerts/alert-actions"

type Filter = "all" | "new_listings" | "price_reductions" | "not_viewed"

interface AlertRecord {
  id: string
  alert_name: string
  frequency: string
  is_active: boolean
  paused_by: string | null
  last_run_at: string | null
  last_match_count: number
  total_alerts_sent: number
  unviewed_count: number
  min_price?: number
  max_price?: number
  bedrooms_min?: number
  bathrooms_min?: number
  cities?: string[]
  zip_codes?: string[]
  property_types?: string[]
  delivery_channels?: string[]
}

interface ResultRecord {
  id: string
  property_address: string
  city?: string
  list_price?: number
  bedrooms?: number
  bathrooms?: number
  sqft?: number
  match_score: number
  match_reasons?: string[]
  is_price_reduction: boolean
  is_new_listing: boolean
  buyer_viewed: boolean
  buyer_reaction?: string
  listing_url?: string
  primary_photo_url?: string
}

const FREQUENCY_LABELS: Record<string, string> = {
  instant: "Every 15 min", twice_daily: "Twice Daily", daily: "Daily", weekly: "Weekly"
}
const PROPERTY_TYPE_OPTIONS = ["Single Family", "Condo", "Townhouse", "Multi-Family", "Land", "Commercial"]

export default function BuyerAlertsPage() {
  const params  = useParams()
  const buyerId = params.id as string

  // Derived from URL — brokerage_id pulled from first alert or contact
  const [brokerageId, setBrokerageId] = useState<string>("")
  const [alerts, setAlerts]           = useState<AlertRecord[]>([])
  const [idxStatus, setIdxStatus]     = useState<"checking" | "configured" | "not_configured">("checking")
  const [isAdmin, setIsAdmin]         = useState(false)
  const [loading, setLoading]         = useState(true)

  // Results panel state
  const [expandedAlertId, setExpandedAlertId] = useState<string | null>(null)
  const [results, setResults]                 = useState<ResultRecord[]>([])
  const [unviewedCount, setUnviewedCount]     = useState(0)
  const [resultFilter, setResultFilter]       = useState<Filter>("all")
  const [resultsLoading, setResultsLoading]   = useState(false)

  // Create/Edit slide-over
  const [sheetOpen, setSheetOpen]   = useState(false)
  const [editAlert, setEditAlert]   = useState<AlertRecord | null>(null)
  const [saving, setSaving]         = useState(false)
  const [previewCount, setPreviewCount]   = useState<number | null>(null)
  const [previewing, setPreviewing]       = useState(false)
  const [runningNow, setRunningNow]       = useState<string | null>(null)

  // Form state
  const emptyForm = {
    alertName: "", minPrice: "", maxPrice: "", bedroomsMin: "", bathroomsMin: "",
    propertyTypes: [] as string[], cities: "", zipCodes: "", minSqft: "", maxSqft: "",
    yearBuiltMin: "", mustHaveFeatures: [] as string[], keywords: "",
    maxDaysOnMarket: "", newListingsOnly: true, includeComingSoon: true,
    includePriceReductions: true, priceReductionMinPercent: "2",
    frequency: "daily", deliveryChannels: ["email", "in_app"] as string[],
    maxResultsPerAlert: "10",
  }
  const [form, setForm] = useState(emptyForm)

  const loadAlerts = useCallback(async () => {
    setLoading(true)
    const res = await getBuyerAlertSummary(buyerId)
    if (res.success) {
      setAlerts(res.alerts as AlertRecord[])
      if (res.alerts.length > 0) {
        const bid = (res.alerts[0] as any).brokerage_id
        setBrokerageId(bid ?? "")
      }
    }
    setLoading(false)
  }, [buyerId])

  useEffect(() => { loadAlerts() }, [loadAlerts])

  // IDX status check
  useEffect(() => {
    if (!brokerageId) return
    import("@/app/actions/property-alerts/alert-actions").then(({ testIdxConnection }) => {
      testIdxConnection(brokerageId).then(r => {
        setIdxStatus(r.success && r.configured ? "configured" : "not_configured")
      })
    })
  }, [brokerageId])

  const loadResults = async (alertId: string, filter: Filter = "all") => {
    setResultsLoading(true)
    const res = await getAlertResults(alertId, { filter })
    if (res.success) {
      setResults(res.results as ResultRecord[])
      setUnviewedCount(res.unviewedCount ?? 0)
    }
    setResultsLoading(false)
  }

  const toggleExpand = async (alertId: string) => {
    if (expandedAlertId === alertId) { setExpandedAlertId(null); return }
    setExpandedAlertId(alertId)
    setResultFilter("all")
    await loadResults(alertId, "all")
  }

  const openCreate = () => {
    setEditAlert(null)
    setForm(emptyForm)
    setPreviewCount(null)
    setSheetOpen(true)
  }

  const openEdit = (alert: AlertRecord) => {
    setEditAlert(alert)
    setForm({
      alertName: alert.alert_name,
      minPrice: alert.min_price?.toString() ?? "",
      maxPrice: alert.max_price?.toString() ?? "",
      bedroomsMin: alert.bedrooms_min?.toString() ?? "",
      bathroomsMin: alert.bathrooms_min?.toString() ?? "",
      propertyTypes: alert.property_types ?? [],
      cities: (alert.cities ?? []).join(", "),
      zipCodes: (alert.zip_codes ?? []).join(", "),
      minSqft: "", maxSqft: "", yearBuiltMin: "", mustHaveFeatures: [],
      keywords: "", maxDaysOnMarket: "",
      newListingsOnly: true, includeComingSoon: true, includePriceReductions: true,
      priceReductionMinPercent: "2",
      frequency: alert.frequency,
      deliveryChannels: alert.delivery_channels ?? ["email", "in_app"],
      maxResultsPerAlert: "10",
    })
    setPreviewCount(null)
    setSheetOpen(true)
  }

  const handlePreview = async () => {
    if (!brokerageId) return
    setPreviewing(true)
    const criteria = buildCriteria()
    const res = await previewAlertCriteria(criteria, brokerageId)
    setPreviewCount(res.matchCount ?? 0)
    setPreviewing(false)
  }

  const handlePrefill = async () => {
    const res = await prefillFromProfile(buyerId)
    if (res.success && res.profile) {
      const p = res.profile as any
      setForm(prev => ({
        ...prev,
        minPrice:     p.min_price?.toString() ?? prev.minPrice,
        maxPrice:     p.max_price?.toString() ?? prev.maxPrice,
        bedroomsMin:  p.bedrooms?.toString()  ?? prev.bedroomsMin,
        bathroomsMin: p.bathrooms?.toString() ?? prev.bathroomsMin,
        cities:       (p.preferred_locations ?? []).join(", ") || prev.cities,
        zipCodes:     (p.zip_codes ?? []).join(", ")           || prev.zipCodes,
        keywords:     p.keywords ?? prev.keywords,
      }))
    }
  }

  const buildCriteria = () => ({
    minPrice:               form.minPrice       ? Number(form.minPrice)       : undefined,
    maxPrice:               form.maxPrice       ? Number(form.maxPrice)       : undefined,
    bedroomsMin:            form.bedroomsMin    ? Number(form.bedroomsMin)    : undefined,
    bathroomsMin:           form.bathroomsMin   ? Number(form.bathroomsMin)   : undefined,
    propertyTypes:          form.propertyTypes,
    cities:                 form.cities.split(",").map(s => s.trim()).filter(Boolean),
    zipCodes:               form.zipCodes.split(",").map(s => s.trim()).filter(Boolean),
    minSqft:                form.minSqft        ? Number(form.minSqft)        : undefined,
    maxSqft:                form.maxSqft        ? Number(form.maxSqft)        : undefined,
    yearBuiltMin:           form.yearBuiltMin   ? Number(form.yearBuiltMin)   : undefined,
    keywords:               form.keywords       || undefined,
    maxDaysOnMarket:        form.maxDaysOnMarket ? Number(form.maxDaysOnMarket) : undefined,
    newListingsOnly:        form.newListingsOnly,
    includeComingSoon:      form.includeComingSoon,
    includePriceReductions: form.includePriceReductions,
    priceReductionMinPercent: Number(form.priceReductionMinPercent),
  })

  const handleSave = async () => {
    setSaving(true)
    const criteria = buildCriteria()
    if (editAlert) {
      await updatePropertyAlert(editAlert.id, {
        alert_name: form.alertName || "Property Alert",
        ...criteria,
        frequency:             form.frequency,
        delivery_channels:     form.deliveryChannels,
        max_results_per_alert: Number(form.maxResultsPerAlert),
      })
    } else {
      await createPropertyAlert({
        contactId:  buyerId,
        brokerageId,
        alertName:  form.alertName || "Property Alert",
        ...criteria,
        frequency:             form.frequency,
        deliveryChannels:      form.deliveryChannels,
        maxResultsPerAlert:    Number(form.maxResultsPerAlert),
      })
    }
    setSaving(false)
    setSheetOpen(false)
    await loadAlerts()
  }

  const handleRunNow = async (alertId: string) => {
    setRunningNow(alertId)
    await runAlertNow(alertId)
    setRunningNow(null)
    await loadAlerts()
    if (expandedAlertId === alertId) await loadResults(alertId, resultFilter)
  }

  const handlePause = async (alertId: string) => {
    await pausePropertyAlert(alertId, "agent")
    await loadAlerts()
  }

  const handleResume = async (alertId: string) => {
    await resumePropertyAlert(alertId)
    await loadAlerts()
  }

  const handleDelete = async (alertId: string) => {
    if (!confirm("Delete this alert? This cannot be undone.")) return
    await deletePropertyAlert(alertId)
    if (expandedAlertId === alertId) setExpandedAlertId(null)
    await loadAlerts()
  }

  const toggleChannel = (ch: string) => {
    setForm(prev => ({
      ...prev,
      deliveryChannels: prev.deliveryChannels.includes(ch)
        ? prev.deliveryChannels.filter(c => c !== ch)
        : [...prev.deliveryChannels, ch],
    }))
  }

  const togglePropType = (pt: string) => {
    setForm(prev => ({
      ...prev,
      propertyTypes: prev.propertyTypes.includes(pt)
        ? prev.propertyTypes.filter(t => t !== pt)
        : [...prev.propertyTypes, pt],
    }))
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto">

      {/* IDX Status Banner */}
      <div className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-sm font-medium
        ${idxStatus === "configured"
          ? "border-green-200 bg-green-50 text-green-800"
          : idxStatus === "not_configured"
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : "border-border bg-muted/30 text-muted-foreground"}`}>
        {idxStatus === "configured" && (
          <>
            <span className="h-2 w-2 rounded-full bg-green-500" />
            Connected to IDX Broker
          </>
        )}
        {idxStatus === "not_configured" && (
          <>
            <span className="h-2 w-2 rounded-full bg-amber-400" />
            IDX Not Configured —{" "}
            {isAdmin
              ? <a href="/dashboard/settings/integrations/idx-broker" className="underline font-semibold ml-1">Configure Now &rarr;</a>
              : "Ask your admin to configure IDX Broker"
            }
          </>
        )}
        {idxStatus === "checking" && "Checking IDX connection..."}
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Property Alerts</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {alerts.length} active alert{alerts.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Button onClick={openCreate}>+ Create Alert</Button>
      </div>

      {/* Alert list */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2].map(i => (
            <div key={i} className="h-24 rounded-lg bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : alerts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 gap-3">
            <p className="text-sm font-medium text-muted-foreground">No property alerts yet</p>
            <Button size="sm" onClick={openCreate}>Create First Alert</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {alerts.map(alert => (
            <Card key={alert.id} className={!alert.is_active ? "opacity-60" : ""}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <CardTitle className="text-base font-semibold">{alert.alert_name}</CardTitle>
                      <Badge variant={alert.is_active ? "default" : "secondary"} className="text-xs">
                        {alert.is_active ? FREQUENCY_LABELS[alert.frequency] ?? alert.frequency : "Paused"}
                      </Badge>
                      {alert.unviewed_count > 0 && (
                        <Badge className="text-xs bg-primary text-primary-foreground">{alert.unviewed_count} new</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {[
                        alert.min_price && alert.max_price && `$${(alert.min_price/1000).toFixed(0)}k–$${(alert.max_price/1000).toFixed(0)}k`,
                        alert.bedrooms_min && `${alert.bedrooms_min}+ bd`,
                        ...(alert.cities ?? []).slice(0, 2),
                      ].filter(Boolean).join(" · ")}
                    </p>
                    {alert.last_run_at && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Last run {new Date(alert.last_run_at).toLocaleDateString()} · {alert.last_match_count ?? 0} matched · {alert.total_alerts_sent ?? 0} sent total
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <Button size="sm" variant="outline" onClick={() => toggleExpand(alert.id)}>
                      {expandedAlertId === alert.id ? "Hide Results" : "View Results"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => openEdit(alert)}>Edit</Button>
                    <Button
                      size="sm" variant="outline"
                      disabled={runningNow === alert.id}
                      onClick={() => handleRunNow(alert.id)}
                    >
                      {runningNow === alert.id ? "Running…" : "Run Now"}
                    </Button>
                    {alert.is_active
                      ? <Button size="sm" variant="ghost" onClick={() => handlePause(alert.id)}>Pause</Button>
                      : <Button size="sm" variant="ghost" onClick={() => handleResume(alert.id)}>Resume</Button>
                    }
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => handleDelete(alert.id)}>Delete</Button>
                  </div>
                </div>
              </CardHeader>

              {/* Results panel */}
              {expandedAlertId === alert.id && (
                <CardContent className="pt-0">
                  <Separator className="mb-4" />

                  {/* Filter tabs */}
                  <div className="flex gap-2 mb-4">
                    {(["all", "new_listings", "price_reductions", "not_viewed"] as Filter[]).map(f => (
                      <Button
                        key={f}
                        size="sm"
                        variant={resultFilter === f ? "default" : "outline"}
                        className="text-xs"
                        onClick={async () => {
                          setResultFilter(f)
                          await loadResults(alert.id, f)
                        }}
                      >
                        {{
                          all: "All",
                          new_listings: "New Listings",
                          price_reductions: "Price Reductions",
                          not_viewed: `Not Viewed${unviewedCount > 0 ? ` (${unviewedCount})` : ""}`,
                        }[f]}
                      </Button>
                    ))}
                  </div>

                  {resultsLoading ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {[1, 2].map(i => <div key={i} className="h-40 rounded bg-muted/40 animate-pulse" />)}
                    </div>
                  ) : results.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">No results for this filter</p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {results.map(r => (
                        <div key={r.id} className="border rounded-lg overflow-hidden">
                          {r.primary_photo_url && (
                            <img src={r.primary_photo_url} alt="Property" className="w-full h-36 object-cover" />
                          )}
                          <div className="p-3 space-y-1">
                            <div className="flex items-start justify-between gap-2">
                              <p className="text-sm font-medium leading-snug">{r.property_address}{r.city ? `, ${r.city}` : ""}</p>
                              {r.is_price_reduction
                                ? <Badge variant="destructive" className="text-xs flex-shrink-0">Price Reduced</Badge>
                                : <Badge className="text-xs flex-shrink-0 bg-green-600">New</Badge>
                              }
                            </div>
                            <p className="text-sm font-semibold text-primary">
                              {r.list_price ? new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(r.list_price) : "Price TBD"}
                              {r.bedrooms ? ` · ${r.bedrooms} bd` : ""}
                              {r.bathrooms ? ` · ${r.bathrooms} ba` : ""}
                            </p>
                            {/* Match score bar */}
                            <div className="flex items-center gap-2">
                              <div className="flex-1 bg-muted rounded-full h-1.5">
                                <div
                                  className="h-1.5 rounded-full bg-primary"
                                  style={{ width: `${Math.min(100, r.match_score)}%` }}
                                />
                              </div>
                              <span className="text-xs text-muted-foreground w-8">{r.match_score}%</span>
                            </div>
                            {/* Match reason chips */}
                            {(r.match_reasons ?? []).length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {r.match_reasons!.slice(0, 3).map((reason, i) => (
                                  <span key={i} className="text-xs bg-muted px-2 py-0.5 rounded-full">{reason}</span>
                                ))}
                              </div>
                            )}
                            {r.buyer_reaction && (
                              <Badge variant="outline" className="text-xs">{r.buyer_reaction}</Badge>
                            )}
                            <div className="flex gap-1.5 pt-1 flex-wrap">
                              {r.listing_url && (
                                <a href={r.listing_url} target="_blank" rel="noopener noreferrer">
                                  <Button size="sm" variant="outline" className="text-xs h-7">View on IDX &nearr;</Button>
                                </a>
                              )}
                              <Button size="sm" variant="outline" className="text-xs h-7">Save for Buyer</Button>
                              <Button size="sm" variant="outline" className="text-xs h-7">Add to Tour</Button>
                              <Button size="sm" variant="outline" className="text-xs h-7">Send Now</Button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Slide-Over */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full max-w-2xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{editAlert ? "Edit Alert" : "Create Property Alert"}</SheetTitle>
            <SheetDescription>
              {editAlert ? "Update the search criteria or delivery settings." : "Set up a new property alert for this buyer."}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6 grid grid-cols-2 gap-6">
            {/* LEFT — Criteria */}
            <div className="col-span-2 md:col-span-1 space-y-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Search Criteria</h3>

              <div className="space-y-1">
                <Label>Alert Name</Label>
                <Input value={form.alertName} onChange={e => setForm(p => ({...p, alertName: e.target.value}))} placeholder="e.g. 3BR under $500k in Austin" />
              </div>

              <div className="flex gap-2">
                <div className="flex-1 space-y-1">
                  <Label>Min Price</Label>
                  <Input type="number" value={form.minPrice} onChange={e => setForm(p => ({...p, minPrice: e.target.value}))} placeholder="300000" />
                </div>
                <div className="flex-1 space-y-1">
                  <Label>Max Price</Label>
                  <Input type="number" value={form.maxPrice} onChange={e => setForm(p => ({...p, maxPrice: e.target.value}))} placeholder="600000" />
                </div>
              </div>

              <div className="flex gap-2">
                <div className="flex-1 space-y-1">
                  <Label>Min Beds</Label>
                  <Input type="number" value={form.bedroomsMin} onChange={e => setForm(p => ({...p, bedroomsMin: e.target.value}))} placeholder="3" />
                </div>
                <div className="flex-1 space-y-1">
                  <Label>Min Baths</Label>
                  <Input type="number" value={form.bathroomsMin} onChange={e => setForm(p => ({...p, bathroomsMin: e.target.value}))} placeholder="2" />
                </div>
              </div>

              <div className="space-y-1">
                <Label>Cities (comma-separated)</Label>
                <Input value={form.cities} onChange={e => setForm(p => ({...p, cities: e.target.value}))} placeholder="Austin, Round Rock" />
              </div>

              <div className="space-y-1">
                <Label>ZIP Codes (comma-separated)</Label>
                <Input value={form.zipCodes} onChange={e => setForm(p => ({...p, zipCodes: e.target.value}))} placeholder="78701, 78702" />
              </div>

              <div className="space-y-2">
                <Label>Property Types</Label>
                <div className="flex flex-wrap gap-2">
                  {PROPERTY_TYPE_OPTIONS.map(pt => (
                    <button
                      key={pt}
                      type="button"
                      onClick={() => togglePropType(pt)}
                      className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                        form.propertyTypes.includes(pt)
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background border-border text-foreground hover:bg-muted"
                      }`}
                    >{pt}</button>
                  ))}
                </div>
              </div>

              <div className="space-y-1">
                <Label>Keywords</Label>
                <Input value={form.keywords} onChange={e => setForm(p => ({...p, keywords: e.target.value}))} placeholder="pool, garage, updated kitchen" />
              </div>

              <div className="space-y-1">
                <Label>Max Days on Market</Label>
                <Input type="number" value={form.maxDaysOnMarket} onChange={e => setForm(p => ({...p, maxDaysOnMarket: e.target.value}))} placeholder="30" />
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox id="priceReductions" checked={form.includePriceReductions} onCheckedChange={v => setForm(p => ({...p, includePriceReductions: !!v}))} />
                  <Label htmlFor="priceReductions">Include Price Reductions</Label>
                </div>
                {form.includePriceReductions && (
                  <div className="space-y-1 ml-6">
                    <Label className="text-xs">Min Reduction %</Label>
                    <Input type="number" value={form.priceReductionMinPercent} onChange={e => setForm(p => ({...p, priceReductionMinPercent: e.target.value}))} className="w-24" />
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Checkbox id="comingSoon" checked={form.includeComingSoon} onCheckedChange={v => setForm(p => ({...p, includeComingSoon: !!v}))} />
                  <Label htmlFor="comingSoon">Include Coming Soon</Label>
                </div>
              </div>

              <div className="flex gap-2">
                <Button size="sm" variant="outline" type="button" onClick={handlePrefill}>Pre-fill from Profile</Button>
                <Button size="sm" variant="outline" type="button" onClick={handlePreview} disabled={previewing || !brokerageId}>
                  {previewing ? "Searching…" : "Preview"}
                </Button>
              </div>
              {previewCount !== null && (
                <p className="text-sm font-medium">
                  {previewCount === 0 ? "No matching properties found" : `${previewCount} propert${previewCount === 1 ? "y" : "ies"} match these criteria`}
                </p>
              )}
            </div>

            {/* RIGHT — Delivery */}
            <div className="col-span-2 md:col-span-1 space-y-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Delivery Settings</h3>

              <div className="space-y-1">
                <Label>Frequency</Label>
                <Select value={form.frequency} onValueChange={v => setForm(p => ({...p, frequency: v}))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="instant">Every 15 min</SelectItem>
                    <SelectItem value="twice_daily">Twice Daily</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Delivery Channels</Label>
                {(["email", "sms", "in_app"] as const).map(ch => (
                  <div key={ch} className="flex items-center gap-2">
                    <Checkbox
                      id={`ch-${ch}`}
                      checked={form.deliveryChannels.includes(ch)}
                      onCheckedChange={() => toggleChannel(ch)}
                    />
                    <Label htmlFor={`ch-${ch}`} className="capitalize">{ch.replace("_", "-")}</Label>
                  </div>
                ))}
              </div>

              <div className="space-y-1">
                <Label>Max Results per Alert</Label>
                <Input type="number" value={form.maxResultsPerAlert} onChange={e => setForm(p => ({...p, maxResultsPerAlert: e.target.value}))} className="w-24" />
              </div>

              <Separator />

              <div className="flex flex-col gap-2">
                <Button onClick={handleSave} disabled={saving}>
                  {saving ? "Saving…" : editAlert ? "Update Alert" : "Create Alert"}
                </Button>
                <Button variant="outline" onClick={() => setSheetOpen(false)}>Cancel</Button>
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
