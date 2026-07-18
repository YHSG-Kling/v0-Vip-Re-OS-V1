"use client"

// "Demo showcase" card — the persistent, resettable demo brokerage sales tours
// instead of a real tenant. Status + Create/Reset + links to the public demo
// site and an audited impersonation session for a live tour.

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ExternalLink, LogIn, MonitorPlay, RefreshCw, Sparkles } from "lucide-react"
import { createOrResetDemoTenantAction } from "@/app/actions/superadmin/demo-tenant"
import { enterTenantAction } from "@/app/actions/superadmin/impersonation"
import type { DemoTenantSnapshot } from "@/lib/platform/demo-tenant"

const COUNT_LABELS: Array<[string, string]> = [
  ["contacts", "Contacts"],
  ["leads", "Leads"],
  ["listings", "Listings"],
  ["transactions", "Deals"],
  ["conversations", "Conversations"],
  ["messages", "Messages"],
  ["activities", "Activities"],
]

export function DemoShowcaseCard({ status }: { status: DemoTenantSnapshot | null }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [touring, startTour] = useTransition()
  const [err, setErr] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)

  const exists = !!status?.exists && !!status.brokerage
  const brokerage = status?.brokerage
  const counts = status?.counts

  const createOrReset = () =>
    startTransition(async () => {
      setErr(null)
      setOkMsg(null)
      const r = await createOrResetDemoTenantAction()
      if (!r.ok) {
        setErr(r.error ?? "Failed")
        return
      }
      setOkMsg(r.created ? "Demo tenant provisioned and seeded." : "Demo data reset to the canonical showcase state.")
      router.refresh()
    })

  const enterForTour = () => {
    if (!brokerage) return
    startTour(async () => {
      setErr(null)
      const r = await enterTenantAction({ brokerageId: brokerage.id, mode: "full", reason: "demo showcase live tour" })
      if (!r.ok) {
        setErr(r.error ?? "Could not enter demo tenant")
        return
      }
      router.push("/dashboard")
    })
  }

  return (
    <Card className="border-dashed border-violet-300 bg-violet-50/40 dark:bg-violet-950/10">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <MonitorPlay className="h-4 w-4 text-violet-600" />
          Demo showcase
          <Badge className="bg-violet-100 text-violet-800 text-[10px]">demo</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {exists && brokerage ? (
          <>
            <div className="text-sm">
              <Link href={`/dashboard/superadmin/brokerages/${brokerage.id}`} className="font-medium hover:underline">
                {brokerage.name ?? "Demo brokerage"}
              </Link>
              <span className="text-muted-foreground"> · /site/{brokerage.slug ?? "?"} · {brokerage.status ?? "active"} · never bills</span>
            </div>
            {counts && (
              <div className="flex flex-wrap gap-1.5">
                {COUNT_LABELS.map(([key, label]) => (
                  <Badge key={key} variant="outline" className="text-[10px] font-normal">
                    {counts[key as keyof typeof counts] ?? 0} {label}
                  </Badge>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {status?.lastReset
                ? `Last ${status.lastReset.action === "demo_tenant.created" ? "provisioned" : "reset"} ${new Date(status.lastReset.created_at).toLocaleString()}${status.lastReset.actor_email ? ` by ${status.lastReset.actor_email}` : ""}.`
                : "No reset recorded yet."}{" "}
              All data is fictional and scoped to this flagged demo tenant — reset wipes and re-seeds it.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No demo tenant yet. Provisioning creates a flagged, non-billing showcase brokerage through the same path a
            real signup uses — website, CRM, deals, and conversations pre-filled with believable fictional data.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={createOrReset} disabled={pending} className="gap-1.5">
            {exists ? <RefreshCw className={`h-4 w-4 ${pending ? "animate-spin" : ""}`} /> : <Sparkles className="h-4 w-4" />}
            {pending ? (exists ? "Resetting…" : "Provisioning…") : exists ? "Reset demo data" : "Create demo tenant"}
          </Button>
          {exists && brokerage?.slug && (
            <Button asChild size="sm" variant="outline" className="gap-1.5">
              <Link href={`/site/${brokerage.slug}`} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" /> Open demo website
              </Link>
            </Button>
          )}
          {exists && (
            <Button size="sm" variant="outline" onClick={enterForTour} disabled={touring} className="gap-1.5">
              <LogIn className="h-4 w-4" /> {touring ? "Entering…" : "Enter for live tour"}
            </Button>
          )}
        </div>

        {err && <p className="text-xs text-red-600">{err}</p>}
        {okMsg && <p className="text-xs text-emerald-700">{okMsg}</p>}
      </CardContent>
    </Card>
  )
}
