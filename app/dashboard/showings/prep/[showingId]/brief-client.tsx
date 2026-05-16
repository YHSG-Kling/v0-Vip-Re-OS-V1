"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import {
  Sparkles, ArrowLeft, RefreshCw, Loader2, Calendar, MapPin, User, DollarSign,
  Bed, Bath, Square, Home, CheckCircle2, XCircle, MinusCircle, HelpCircle,
  MessageSquare, AlertTriangle, TrendingUp, Printer,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { regenerateShowingBriefing } from "../actions"
import type { ShowingBriefing } from "@/lib/showings/showing-brief"

interface Props {
  showingId:          string
  briefing:           ShowingBriefing | null
  showingScheduledAt: string | null
}

const dollars = (n: number | null | undefined) =>
  n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`
const fmt = (iso: string | null) => {
  if (!iso) return "—"
  const d = new Date(iso)
  return d.toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })
}

const MATCH_META: Record<string, { Icon: typeof CheckCircle2; color: string }> = {
  yes:     { Icon: CheckCircle2, color: "text-emerald-600" },
  no:      { Icon: XCircle,      color: "text-red-600" },
  partial: { Icon: MinusCircle,  color: "text-amber-600" },
  unknown: { Icon: HelpCircle,   color: "text-slate-400" },
}

export function ShowingBriefClient({ showingId, briefing, showingScheduledAt }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [regenerating, setRegenerating] = useState(false)

  async function handleRegenerate() {
    setRegenerating(true)
    try {
      const r = await regenerateShowingBriefing(showingId)
      if (r.success) {
        toast.success("Brief regenerated")
        router.refresh()
      } else {
        toast.error(r.error ?? "Regenerate failed")
      }
    } finally {
      setRegenerating(false)
    }
  }

  // No brief yet — show generate CTA
  if (!briefing) {
    return (
      <div className="container max-w-3xl mx-auto py-8 px-4">
        <Button asChild variant="ghost" size="sm" className="mb-4">
          <Link href="/dashboard/showings/prep"><ArrowLeft className="h-4 w-4 mr-1" /> Back to showings</Link>
        </Button>
        <Card className="border-dashed">
          <CardContent className="py-12 text-center space-y-3">
            <Sparkles className="h-10 w-10 text-indigo-600 mx-auto" />
            <p className="text-base font-medium">No briefing generated yet.</p>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              {showingScheduledAt && <>Showing scheduled for <strong>{fmt(showingScheduledAt)}</strong>. </>}
              Briefs auto-generate every hour for showings in the next 24 hours, or you can generate one now.
            </p>
            <Button onClick={handleRegenerate} disabled={regenerating}>
              {regenerating ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />}
              Generate brief
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="container max-w-4xl mx-auto py-6 px-4 print:max-w-full print:p-0">
      <div className="flex items-center justify-between mb-4 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard/showings/prep"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Link>
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer className="h-3 w-3 mr-1" /> Print
          </Button>
          <Button variant="outline" size="sm" onClick={handleRegenerate} disabled={regenerating}>
            {regenerating ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
            Regenerate
          </Button>
        </div>
      </div>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="mb-6">
        <p className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1 mb-1">
          <Sparkles className="h-3 w-3" /> Showing brief
        </p>
        <h1 className="text-2xl font-bold tracking-tight">{briefing.listing.address ?? "Property"}</h1>
        <p className="text-sm text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
          {showingScheduledAt && (
            <span className="flex items-center gap-1"><Calendar className="h-3 w-3" /> {fmt(showingScheduledAt)}</span>
          )}
          {briefing.buyer.fullName && (
            <span className="flex items-center gap-1"><User className="h-3 w-3" /> {briefing.buyer.fullName}</span>
          )}
        </p>
      </div>

      {/* ── AI summary ─────────────────────────────────────────────────── */}
      {briefing.aiSummary && (
        <Card className="mb-4 border-indigo-200 bg-indigo-50/40">
          <CardContent className="py-4">
            <p className="text-sm leading-relaxed text-indigo-950">
              <Sparkles className="h-3.5 w-3.5 inline mr-1 text-indigo-600" />
              {briefing.aiSummary}
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">

        {/* ── Buyer at a glance ───────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <User className="h-4 w-4 text-indigo-600" /> Buyer at a glance
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Name"        value={briefing.buyer.fullName} />
            <Row label="Type"        value={briefing.buyer.contactType ?? "buyer"} />
            <Row label="Timeline"    value={briefing.buyer.timeline ?? "—"} />
            <Row label="Budget"      value={
              briefing.buyer.budgetMin || briefing.buyer.budgetMax
                ? `${dollars(briefing.buyer.budgetMin)} – ${dollars(briefing.buyer.budgetMax)}`
                : "—"
            } />
            <Row label="Pre-approved" value={
              briefing.buyer.preApprovedAmount
                ? `${dollars(briefing.buyer.preApprovedAmount)}${briefing.buyer.preApprovedLender ? ` · ${briefing.buyer.preApprovedLender}` : ""}`
                : briefing.buyer.isCashBuyer ? "Cash buyer" : "Not yet"
            } />
            {briefing.buyer.notes && (
              <div className="pt-2 border-t mt-2">
                <p className="text-xs text-muted-foreground italic">{briefing.buyer.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Listing snapshot ────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Home className="h-4 w-4 text-indigo-600" /> Property
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label={<><MapPin className="h-3 w-3 inline mr-1" /> Address</>} value={
              [briefing.listing.address, briefing.listing.city, briefing.listing.state, briefing.listing.zip].filter(Boolean).join(", ") || "—"
            } />
            <Row label={<><DollarSign className="h-3 w-3 inline mr-1" /> List price</>} value={dollars(briefing.listing.listPrice)} />
            <Row label={<><Bed className="h-3 w-3 inline mr-1" /> Beds</>}         value={briefing.listing.bedrooms?.toString() ?? "—"} />
            <Row label={<><Bath className="h-3 w-3 inline mr-1" /> Baths</>}       value={briefing.listing.bathrooms?.toString() ?? "—"} />
            <Row label={<><Square className="h-3 w-3 inline mr-1" /> Sqft</>}      value={briefing.listing.sqft?.toLocaleString() ?? "—"} />
            <Row label="MLS#" value={briefing.listing.mlsNumber ?? "—"} />
            <Row label="Status" value={briefing.listing.status ?? "—"} />
          </CardContent>
        </Card>
      </div>

      {/* ── Matchup grid ─────────────────────────────────────────────── */}
      {briefing.matchup.length > 0 && (
        <Card className="mt-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-indigo-600" /> Buyer vs listing matchup
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {briefing.matchup.map((m, i) => {
                const meta = MATCH_META[m.match] ?? MATCH_META.unknown
                const Icon = meta.Icon
                return (
                  <div key={i} className="py-2 flex items-start gap-3">
                    <Icon className={cn("h-4 w-4 shrink-0 mt-0.5", meta.color)} />
                    <div className="grid grid-cols-3 gap-2 flex-1 text-sm">
                      <p className="font-medium">{m.criterion}</p>
                      <p className="text-muted-foreground">{m.buyerWants}</p>
                      <p>{m.listingHas}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── AI talking points ────────────────────────────────────────── */}
      {briefing.aiTalkingPoints.length > 0 && (
        <Card className="mt-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-indigo-600" /> Talking points
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {briefing.aiTalkingPoints.map((tp, i) => (
                <li key={i} className="text-sm flex items-start gap-2">
                  <span className="text-indigo-600 mt-1">→</span>
                  <span>{tp}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* ── Objections + risks side by side ──────────────────────────── */}
      {(briefing.aiObjections.length > 0 || briefing.aiRiskFlags.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2 mt-4">
          {briefing.aiObjections.length > 0 && (
            <Card className="border-amber-200 bg-amber-50/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" /> Likely objections
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5">
                  {briefing.aiObjections.map((o, i) => (
                    <li key={i} className="text-xs flex items-start gap-1.5">
                      <span className="text-amber-600 mt-0.5">•</span> {o}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          {briefing.aiRiskFlags.length > 0 && (
            <Card className="border-red-200 bg-red-50/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-600" /> Watch for
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5">
                  {briefing.aiRiskFlags.map((r, i) => (
                    <li key={i} className="text-xs flex items-start gap-1.5">
                      <span className="text-red-600 mt-0.5">•</span> {r}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Recent comps ─────────────────────────────────────────────── */}
      {briefing.recentComps.length > 0 && (
        <Card className="mt-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-indigo-600" /> Recent comparable activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {briefing.recentComps.map((c, i) => (
                <div key={i} className="py-2 flex items-center justify-between gap-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{c.address}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {c.bedrooms != null && `${c.bedrooms} bd`}
                      {c.bathrooms != null && ` · ${c.bathrooms} ba`}
                      {c.sqft != null && ` · ${c.sqft.toLocaleString()} sqft`}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-medium">{dollars(c.listPrice)}</p>
                    {c.status && <Badge variant="outline" className="text-[9px]">{c.status}</Badge>}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <p className="mt-6 text-[10px] text-muted-foreground text-center print:hidden">
        Generated by AI from your buyer&apos;s inferred preferences + behavior signals + this property&apos;s facts.
        {briefing.modelUsed && ` · ${briefing.modelUsed}`}
      </p>
    </div>
  )
}

function Row({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}
