"use client"

/**
 * VENDOR COORDINATION — the plan nobody could ask for.
 *
 * `app/actions/ai-vendor-management.ts:coordinateVendors` takes a listing and a
 * list of services and returns a schedule that respects the real ordering
 * constraints of prepping a house for market (you do not photograph before the
 * staging, you do not stage over the repairs), a critical path, the conflicts it
 * found, per-vendor outreach messages and a seller update. It was complete and,
 * after a hardening pass, tenant-gated — and it had no caller anywhere, so the
 * agent's only tool for sequencing four vendors on one listing was their memory.
 *
 * Its three siblings in that file all have surfaces: getVendorRecommendations and
 * analyzeVendorPerformance on the vendors page, requestVendorReview on the
 * transaction booking section, transitionBookingStatus on the bookings panel.
 * This is the fourth.
 *
 * WHAT THIS PANEL DOES NOT DO: it does not book anything and it does not send
 * anything. The action returns a PLAN. Booking stays with VendorBookingButton,
 * which writes a real vendor_bookings row; the vendor messages here are drafts
 * for the agent to send. Presenting a model's schedule as a set of confirmed
 * appointments would be the worst possible reading of this output.
 *
 * BUDGET IS NOT SHOWN. The action's schema includes a `budgetSummary`, but this
 * panel is reachable from an agent-facing listing screen and the estimate is a
 * model's guess at vendor pricing, not a quote. A fabricated dollar figure beside
 * a real vendor's name is worse than no figure.
 */

import { useState, useTransition } from "react"
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
import { CalendarClock, Loader2, Plus, X, TriangleAlert, Copy, Check } from "lucide-react"
import { coordinateVendors } from "@/app/actions/ai-vendor-management"

interface VendorOption {
  id: string
  name: string | null
  category: string | null
}

interface ServiceRow {
  key: string
  serviceType: string
  vendorId: string
  preferredDate: string
  notes: string
}

interface Coordination {
  schedulePlan: Array<{
    serviceType: string
    vendorName: string
    suggestedDate: string
    suggestedTime: string
    duration: string
    prerequisites: string[]
    conflictsWith: string[]
  }>
  timeline: { startDate: string; completionDate: string; totalDays: number; criticalPath: string[] }
  coordinationNotes: Array<{ service: string; note: string; priority: "high" | "medium" | "low" }>
  potentialConflicts: Array<{ services: string[]; issue: string; resolution: string }>
  communicationPlan: {
    vendorMessages: Array<{ vendorName: string; subject: string; message: string }>
    sellerUpdate: string
  }
}

const newRow = (): ServiceRow => ({
  key: Math.random().toString(36).slice(2),
  serviceType: "",
  vendorId: "",
  preferredDate: "",
  notes: "",
})

export function VendorCoordinationPanel({
  listingId,
  agentId,
  vendors,
}: {
  listingId: string
  /** agents.id — the action validates its shape and pins the tenant from the session. */
  agentId: string
  vendors: VendorOption[]
}) {
  const [rows, setRows] = useState<ServiceRow[]>([newRow()])
  const [plan, setPlan] = useState<Coordination | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const usable = rows.filter((r) => r.serviceType.trim().length > 0)

  const update = (key: string, patch: Partial<ServiceRow>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  const run = () => {
    setError(null)
    startTransition(async () => {
      const result = await coordinateVendors({
        agentId,
        listingId,
        services: usable.map((r) => ({
          serviceType: r.serviceType.trim(),
          vendorId: r.vendorId || undefined,
          preferredDate: r.preferredDate || undefined,
          notes: r.notes.trim() || undefined,
        })),
      })
      if (!result.success) {
        // The action distinguishes a blocked listing read from a listing outside
        // the caller's brokerage from an untenanted row it refuses to trust.
        // None of those is "no plan available".
        setError((result as { error?: string }).error ?? "Could not build a coordination plan.")
        setPlan(null)
        return
      }
      setPlan((result as any).coordination as Coordination)
    })
  }

  const copy = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="h-4 w-4" />
          Coordinate vendors
        </CardTitle>
        <CardDescription>
          Sequence the services this listing needs, and see what blocks what.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.key} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1fr_1fr_auto_auto]">
              <div>
                <Label className="text-[11px]">Service</Label>
                <Input
                  value={row.serviceType}
                  onChange={(e) => update(row.key, { serviceType: e.target.value })}
                  placeholder="Photography, staging, inspection…"
                  className="mt-1 h-8 text-xs"
                />
              </div>
              <div>
                <Label className="text-[11px]">Vendor (optional)</Label>
                <Select
                  value={row.vendorId || "unassigned"}
                  onValueChange={(v) => update(row.key, { vendorId: v === "unassigned" ? "" : v })}
                >
                  <SelectTrigger className="mt-1 h-8 text-xs">
                    <SelectValue placeholder="Not chosen yet" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Not chosen yet</SelectItem>
                    {vendors.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name ?? "Unnamed vendor"}
                        {v.category ? ` · ${v.category}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-[11px]">Preferred</Label>
                <Input
                  type="date"
                  value={row.preferredDate}
                  onChange={(e) => update(row.key, { preferredDate: e.target.value })}
                  className="mt-1 h-8 text-xs"
                />
              </div>
              <div className="flex items-end">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0"
                  onClick={() => setRows((c) => (c.length === 1 ? [newRow()] : c.filter((r) => r.key !== row.key)))}
                  aria-label="Remove service"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setRows((c) => [...c, newRow()])}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add service
          </Button>
          <Button size="sm" onClick={run} disabled={isPending || usable.length === 0}>
            {isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Build schedule
          </Button>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {plan && (
          <div className="space-y-4 text-xs">
            {plan.timeline && (
              <div className="rounded-md border bg-muted/40 p-3">
                <p className="text-sm font-medium">
                  {plan.timeline.startDate} → {plan.timeline.completionDate} ({plan.timeline.totalDays} days)
                </p>
                {plan.timeline.criticalPath?.length > 0 && (
                  <p className="mt-1 text-muted-foreground">
                    Critical path: {plan.timeline.criticalPath.join(" → ")}
                  </p>
                )}
              </div>
            )}

            {plan.schedulePlan?.length > 0 && (
              <div className="space-y-1.5">
                {plan.schedulePlan.map((step, i) => (
                  <div key={i} className="rounded-md border p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium capitalize">{step.serviceType}</span>
                      <span className="text-muted-foreground">{step.vendorName}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {step.suggestedDate} {step.suggestedTime}
                      </Badge>
                      {step.duration && <span className="text-muted-foreground">{step.duration}</span>}
                    </div>
                    {step.prerequisites?.length > 0 && (
                      <p className="mt-1 text-muted-foreground">
                        After: {step.prerequisites.join(", ")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {plan.potentialConflicts?.length > 0 && (
              <div className="space-y-1.5">
                {plan.potentialConflicts.map((c, i) => (
                  <div key={i} className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
                    <p className="flex items-center gap-1.5 font-medium">
                      <TriangleAlert className="h-3.5 w-3.5" />
                      {c.services?.join(" + ")}
                    </p>
                    <p className="text-muted-foreground">{c.issue}</p>
                    <p className="mt-0.5">Resolution: {c.resolution}</p>
                  </div>
                ))}
              </div>
            )}

            {plan.communicationPlan?.vendorMessages?.length > 0 && (
              <div>
                <p className="text-sm font-medium">Messages to send</p>
                <p className="text-muted-foreground">
                  Drafts. Nothing here has been sent, and no booking has been made — use
                  "Assign Vendor" above to create a real booking.
                </p>
                <div className="mt-1.5 space-y-1.5">
                  {plan.communicationPlan.vendorMessages.map((m, i) => (
                    <div key={i} className="rounded-md border p-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-medium">{m.vendorName}</p>
                          <p className="text-muted-foreground">{m.subject}</p>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 shrink-0 px-2 text-[11px]"
                          onClick={() => copy(`vendor-${i}`, `${m.subject}\n\n${m.message}`)}
                        >
                          {copied === `vendor-${i}` ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                        </Button>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{m.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {plan.communicationPlan?.sellerUpdate && (
              <div className="rounded-md border p-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">Seller update</p>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 px-2 text-[11px]"
                    onClick={() => copy("seller", plan.communicationPlan.sellerUpdate)}
                  >
                    {copied === "seller" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  </Button>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                  {plan.communicationPlan.sellerUpdate}
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
