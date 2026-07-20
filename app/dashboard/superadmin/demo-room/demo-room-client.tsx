"use client"

// The Deal Room presenter console — seed/teardown the staged story, then walk
// the ordered runbook of deep links into the REAL product surfaces. The demo
// runs only on the sanctioned is_demo tenant; the seeder refuses anything else
// and never clobbers unmarked rows (the demo-day guard).

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ArrowRight, ExternalLink, LogIn, MonitorPlay, ShieldCheck, Sparkles, Trash2,
} from "lucide-react"
import {
  seedDealRoomDemoAction,
  teardownDealRoomDemoAction,
} from "@/app/actions/superadmin/deal-room-demo"
import { enterTenantAction } from "@/app/actions/superadmin/impersonation"
import type { DealRoomRunbookStep, DealRoomStatus } from "@/lib/platform/deal-room-demo"

const RAIL_BADGE: Record<DealRoomRunbookStep["rail"], { label: string; cls: string }> = {
  real: { label: "real rail", cls: "bg-emerald-100 text-emerald-800" },
  gateway: { label: "real rail · gateway-gated", cls: "bg-sky-100 text-sky-800" },
  staged: { label: "honest-staged · labeled", cls: "bg-amber-100 text-amber-800" },
}

export function DemoRoomClient({
  status, runbook,
}: {
  status: DealRoomStatus
  runbook: DealRoomRunbookStep[]
}) {
  const router = useRouter()
  const [seeding, startSeed] = useTransition()
  const [tearing, startTeardown] = useTransition()
  const [entering, startEnter] = useTransition()
  const [err, setErr] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)

  const seed = () =>
    startSeed(async () => {
      setErr(null); setOkMsg(null)
      const r = await seedDealRoomDemoAction()
      if (!r.ok) { setErr(r.error ?? "Seed failed"); return }
      const delib = r.deliberation
      setOkMsg(
        `Story staged: ${r.steps.filter((s) => s.ok).length}/${r.steps.length} beats` +
        (delib ? ` — deliberation ${delib.status}${delib.winner ? ` (winner: ${delib.winner}, ${delib.positions} positions${delib.rebuttalHeld ? ", rebuttal round held" : ""})` : ""}` : ""),
      )
      router.refresh()
    })

  const teardown = () =>
    startTeardown(async () => {
      setErr(null); setOkMsg(null)
      const r = await teardownDealRoomDemoAction()
      if (!r.ok) { setErr(r.error ?? "Teardown failed"); return }
      setOkMsg("Story removed — marked rows only, residue sweep clean.")
      router.refresh()
    })

  const enterTenant = () => {
    if (!status.demoTenant) return
    startEnter(async () => {
      setErr(null)
      const r = await enterTenantAction({
        brokerageId: status.demoTenant!.id,
        mode: "full",
        reason: "deal room demo walkthrough",
      })
      if (!r.ok) { setErr(r.error ?? "Could not enter the demo tenant"); return }
      router.push(r.redirectTo ?? "/dashboard")
    })
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <MonitorPlay className="h-5 w-5 text-violet-600" />
            The Deal Room
            <Badge className="bg-violet-100 text-violet-800 text-[10px]">flagship demo</Badge>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            One deal, end to end, run by the AI team — staged on the sanctioned demo tenant and presented
            entirely through the real product surfaces. Seed the story, enter the tenant, walk the beats.
          </p>
        </div>
      </div>

      {/* ── Stage controls ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            Stage the story
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm">
            {status.demoTenant ? (
              <>
                Demo tenant: <span className="font-medium">{status.demoTenant.name ?? "showcase"}</span>
                <span className="text-muted-foreground"> · /site/{status.demoTenant.slug ?? "?"} · is_demo flagged · never bills</span>
              </>
            ) : (
              <span className="text-muted-foreground">
                No demo tenant yet — seeding provisions it through the canonical signup path first.
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline" className="text-[10px] font-normal">{status.leadId ? "lead staged" : "no lead"}</Badge>
            <Badge variant="outline" className="text-[10px] font-normal">{status.contactId ? "client converted" : "no client"}</Badge>
            <Badge variant="outline" className="text-[10px] font-normal">
              {status.deliberation
                ? `deliberation ${status.deliberation.status}${status.deliberation.winner ? ` · winner ${status.deliberation.winner}` : ""}`
                : "no deliberation"}
            </Badge>
            <Badge variant="outline" className="text-[10px] font-normal">{status.eventSeeded ? "meeting staged" : "no meeting"}</Badge>
            <Badge variant="outline" className="text-[10px] font-normal">{status.recapSeeded ? "recap card staged" : "no recap"}</Badge>
            <Badge variant="outline" className="text-[10px] font-normal">
              {status.gatewayConfigured ? "AI gateway configured — the argument runs live" : "no gateway key — deliberation records honest 'unavailable'"}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={seed} disabled={seeding || tearing} className="gap-1.5">
              <Sparkles className="h-4 w-4" />
              {seeding ? "Staging the story…" : status.seeded ? "Re-stage the story" : "Seed the story"}
            </Button>
            <Button size="sm" variant="outline" onClick={teardown} disabled={seeding || tearing} className="gap-1.5">
              <Trash2 className="h-4 w-4" />
              {tearing ? "Removing…" : "Teardown (marked rows only)"}
            </Button>
            {status.demoTenant && (
              <Button size="sm" variant="outline" onClick={enterTenant} disabled={entering} className="gap-1.5">
                <LogIn className="h-4 w-4" /> {entering ? "Entering…" : "Enter the demo tenant"}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Demo-tenant only: every destructive path re-checks the is_demo flag and refuses anything else. The
            seeder also refuses if the demo tenant holds rows without demo markers (it never clobbers), and the
            teardown removes only marked rows — FK order, residue-swept.
          </p>
          {err && <p className="text-xs text-red-600">{err}</p>}
          {okMsg && <p className="text-xs text-emerald-700">{okMsg}</p>}
        </CardContent>
      </Card>

      {/* ── The runbook ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">The walkthrough — in order, on the real surfaces</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {runbook.map((step) => (
            <div key={step.n} className="flex items-start gap-3 rounded-md border p-3">
              <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                {step.n}
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{step.title}</span>
                  <Badge className={`${RAIL_BADGE[step.rail].cls} text-[10px]`}>{RAIL_BADGE[step.rail].label}</Badge>
                </div>
                <div className="text-xs text-muted-foreground">{step.surface}</div>
                <p className="text-xs">
                  <span className="font-medium">Presenter note:</span> {step.note}
                </p>
              </div>
              {step.href ? (
                <Button asChild size="sm" variant="ghost" className="gap-1 shrink-0">
                  <Link href={step.href} target="_blank" rel="noopener noreferrer">
                    open <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              ) : (
                <span className="text-[10px] text-muted-foreground shrink-0 mt-1 inline-flex items-center gap-1">
                  <ArrowRight className="h-3 w-3" /> {step.n === 0 ? "button above" : "seed the story first"}
                </span>
              )}
            </div>
          ))}
          <p className="text-xs text-muted-foreground pt-2">
            Deep links resolve inside the demo tenant — enter it first (step 0) so /leads, the contact record,
            manager-trust, the meeting room, and the client portal all show the staged story. When the pitch is
            done, run the teardown so the next demo starts from a clean stage.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
