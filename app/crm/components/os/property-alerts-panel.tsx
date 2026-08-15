"use client"

import { useState, useEffect, useTransition } from "react"
import { Bell, BellOff, Plus, Trash2, Loader2, ChevronDown, ChevronUp, Play, Pause, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  getBuyerAlertSummary,
  createPropertyAlert,
  pausePropertyAlert,
  resumePropertyAlert,
  deletePropertyAlert,
  runAlertNow,
} from "@/app/actions/property-alerts/alert-actions"
import { toast } from "sonner"

interface Alert {
  id: string
  alert_name: string | null
  frequency: string | null
  is_active: boolean | null
  cities: string[] | null
  min_price: number | null
  max_price: number | null
  bedrooms_min: number | null
  delivery_channels: string[] | null
  created_at: string
  unviewed_count: number
}

interface Props {
  contactId: string
  brokerageId: string
  agentId: string
}

export function PropertyAlertsPanel({ contactId, brokerageId, agentId }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [isPending, startTransition] = useTransition()

  // New alert form state
  const [alertName, setAlertName] = useState("")
  const [minPrice, setMinPrice] = useState("")
  const [maxPrice, setMaxPrice] = useState("")
  const [bedsMin, setBedsMin] = useState("")
  const [cities, setCities] = useState("")
  const [frequency, setFrequency] = useState("daily")

  useEffect(() => {
    if (expanded && !loaded) {
      loadAlerts()
    }
  }, [expanded])

  async function loadAlerts() {
    setLoading(true)
    const res = await getBuyerAlertSummary(contactId)
    if (res.success) {
      setAlerts((res.alerts as Alert[]) ?? [])
      setLoaded(true)
    }
    setLoading(false)
  }

  async function handleCreate() {
    if (!alertName.trim()) {
      toast.error("Alert name is required")
      return
    }
    startTransition(async () => {
      const res = await createPropertyAlert({
        contactId,
        brokerageId,
        alertName: alertName.trim(),
        minPrice: minPrice ? Number(minPrice) : undefined,
        maxPrice: maxPrice ? Number(maxPrice) : undefined,
        bedroomsMin: bedsMin ? Number(bedsMin) : undefined,
        cities: cities ? cities.split(",").map((c) => c.trim()).filter(Boolean) : undefined,
        frequency,
      })
      if (res.success) {
        toast.success("Alert created")
        setAlertName("")
        setMinPrice("")
        setMaxPrice("")
        setBedsMin("")
        setCities("")
        setFrequency("daily")
        setShowNew(false)
        setLoaded(false)
        loadAlerts()
      } else {
        toast.error(res.error ?? "Failed to create alert")
      }
    })
  }

  async function handlePause(alertId: string) {
    const res = await pausePropertyAlert(alertId, agentId)
    if (res.success) {
      setAlerts((prev) => prev.map((a) => a.id === alertId ? { ...a, is_active: false } : a))
    } else {
      toast.error("Failed to pause alert")
    }
  }

  async function handleResume(alertId: string) {
    const res = await resumePropertyAlert(alertId)
    if (res.success) {
      setAlerts((prev) => prev.map((a) => a.id === alertId ? { ...a, is_active: true } : a))
    } else {
      toast.error("Failed to resume alert")
    }
  }

  async function handleDelete(alertId: string) {
    const res = await deletePropertyAlert(alertId)
    if (res.success) {
      setAlerts((prev) => prev.filter((a) => a.id !== alertId))
      toast.success("Alert deleted")
    } else {
      toast.error("Failed to delete alert")
    }
  }

  async function handleRunNow(alertId: string) {
    const res = await runAlertNow(alertId)
    if (res.success) {
      toast.success(`Ran alert — ${res.matchCount ?? 0} matches found`)
    } else {
      toast.error(res.error ?? "Failed to run alert")
    }
  }

  const totalUnviewed = alerts.reduce((sum, a) => sum + (a.unviewed_count ?? 0), 0)

  return (
    <div className="border rounded-lg mt-3">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-blue-600" />
          Property Alerts
          {loaded && alerts.length > 0 && (
            <Badge variant="secondary" className="text-xs">{alerts.length}</Badge>
          )}
          {totalUnviewed > 0 && (
            <Badge className="text-xs bg-blue-600 text-white">{totalUnviewed} new</Badge>
          )}
        </span>
        {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t pt-3">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading alerts...
            </div>
          )}

          {!loading && alerts.length === 0 && !showNew && (
            <p className="text-sm text-muted-foreground py-2">
              No property alerts set up. Create one to automatically notify this buyer when matching properties hit the market.
            </p>
          )}

          {/* Alert list */}
          {alerts.map((alert) => (
            <div key={alert.id} className="border rounded-md p-3 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{alert.alert_name ?? "Property Alert"}</p>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {alert.cities && alert.cities.length > 0 && (
                      <Badge variant="outline" className="text-xs">{alert.cities.join(", ")}</Badge>
                    )}
                    {(alert.min_price || alert.max_price) && (
                      <Badge variant="outline" className="text-xs">
                        {alert.min_price ? `$${(alert.min_price / 1000).toFixed(0)}K` : ""}
                        {alert.min_price && alert.max_price ? "–" : ""}
                        {alert.max_price ? `$${(alert.max_price / 1000).toFixed(0)}K` : ""}
                      </Badge>
                    )}
                    {alert.bedrooms_min && (
                      <Badge variant="outline" className="text-xs">{alert.bedrooms_min}+ bed</Badge>
                    )}
                    <Badge variant="outline" className="text-xs capitalize">{alert.frequency ?? "daily"}</Badge>
                    <Badge
                      className={`text-xs ${alert.is_active ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}
                    >
                      {alert.is_active ? "Active" : "Paused"}
                    </Badge>
                    {alert.unviewed_count > 0 && (
                      <Badge className="text-xs bg-blue-600 text-white">{alert.unviewed_count} new</Badge>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title="Run now"
                    onClick={() => handleRunNow(alert.id)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                  {alert.is_active ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Pause alert"
                      onClick={() => handlePause(alert.id)}
                    >
                      <Pause className="h-3.5 w-3.5" />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Resume alert"
                      onClick={() => handleResume(alert.id)}
                    >
                      <Play className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    title="Delete alert"
                    onClick={() => handleDelete(alert.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}

          {/* New alert form */}
          {showNew && (
            <div className="border rounded-md p-3 space-y-3 bg-muted/30">
              <p className="text-xs font-semibold">New Property Alert</p>

              <div className="space-y-1.5">
                <Label className="text-xs">Alert Name *</Label>
                <Input
                  value={alertName}
                  onChange={(e) => setAlertName(e.target.value)}
                  placeholder="e.g. 3-bed under $500K in Tampa"
                  className="h-8 text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Min Price ($)</Label>
                  <Input
                    type="number"
                    value={minPrice}
                    onChange={(e) => setMinPrice(e.target.value)}
                    placeholder="200000"
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Max Price ($)</Label>
                  <Input
                    type="number"
                    value={maxPrice}
                    onChange={(e) => setMaxPrice(e.target.value)}
                    placeholder="600000"
                    className="h-8 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Min Bedrooms</Label>
                  <Input
                    type="number"
                    value={bedsMin}
                    onChange={(e) => setBedsMin(e.target.value)}
                    placeholder="3"
                    className="h-8 text-sm"
                    min={1}
                    max={10}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Frequency</Label>
                  <Select value={frequency} onValueChange={setFrequency}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="instant">Instant</SelectItem>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="bi_weekly">Bi-weekly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Cities (comma-separated)</Label>
                <Input
                  value={cities}
                  onChange={(e) => setCities(e.target.value)}
                  placeholder="Tampa, St. Petersburg, Clearwater"
                  className="h-8 text-sm"
                />
              </div>

              <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => setShowNew(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleCreate} disabled={isPending || !alertName.trim()}>
                  {isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Bell className="h-3.5 w-3.5 mr-1" />}
                  Create Alert
                </Button>
              </div>
            </div>
          )}

          {!showNew && (
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1.5"
              onClick={() => setShowNew(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              New Alert
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
