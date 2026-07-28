"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import {
  AlertTriangle, AlertCircle, CheckCircle2, Clock, TrendingDown, TrendingUp, Sparkles,
  Mail, ArrowRight, Loader2, ShieldCheck, X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { resolveIntervention, draftSellerActionEmail, type ListingHealthBoard, type ListingHealthRow, type RiskLevel } from "./actions"

interface Props { board: ListingHealthBoard }

const RISK_META: Record<RiskLevel, { label: string; tone: string; Icon: typeof AlertTriangle; description: string }> = {
  critical:  { label: "Critical",  tone: "bg-red-50 text-red-900 border-red-200",       Icon: AlertTriangle, description: "Take action this week or lose the seller" },
  at_risk:   { label: "At risk",   tone: "bg-amber-50 text-amber-900 border-amber-200", Icon: AlertCircle,   description: "Wobbling — recommend an action soon" },
  watch:     { label: "Watch",     tone: "bg-blue-50 text-blue-900 border-blue-200",    Icon: Clock,         description: "Track closely; no action yet" },
  healthy:   { label: "Healthy",   tone: "bg-emerald-50 text-emerald-900 border-emerald-200", Icon: CheckCircle2, description: "Performing on track" },
}

const dollars = (n: number | null) =>
  n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`
const relative = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

export function ListingHealthBoardClient({ board }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [draftOpen, setDraftOpen] = useState(false)
  const [draftLoading, setDraftLoading] = useState(false)
  const [draftSubject, setDraftSubject] = useState("")
  const [draftBody, setDraftBody] = useState("")
  const [draftListingAddress, setDraftListingAddress] = useState<string | null>(null)
  const [recipientEmail, setRecipientEmail] = useState("")

  // ── Open the draft dialog and ask the AI to write the seller email ──────
  async function openDraftForListing(row: ListingHealthRow) {
    setDraftOpen(true)
    setDraftLoading(true)
    setDraftListingAddress(row.address ?? null)
    setDraftSubject("")
    setDraftBody("")
    setRecipientEmail("")
    try {
      const r = await draftSellerActionEmail(row.listingId)
      if (r.success) {
        setDraftSubject(r.subject ?? "")
        setDraftBody(r.body ?? "")
      } else {
        toast.error(r.error ?? "AI draft failed")
        setDraftOpen(false)
      }
    } catch (err: any) {
      toast.error(err?.message ?? "AI draft failed")
      setDraftOpen(false)
    } finally {
      setDraftLoading(false)
    }
  }

  // ── Send via mailto so the email leaves from the agent's own client ─────
  function handleSend() {
    if (!recipientEmail.trim()) {
      toast.error("Add the seller's email address")
      return
    }
    const params = new URLSearchParams({
      subject: draftSubject,
      body:    draftBody,
    }).toString()
    window.location.href = `mailto:${encodeURIComponent(recipientEmail)}?${params}`
    toast.success("Opening your email client — review, then send.")
    setDraftOpen(false)
  }

  function handleResolve(interventionId: string) {
    setBusyId(interventionId)
    startTransition(async () => {
      const r = await resolveIntervention(interventionId, null)
      if (r.success) {
        toast.success("Marked resolved")
        router.refresh()
      } else {
        toast.error(r.error ?? "Failed to resolve")
      }
      setBusyId(null)
    })
  }

  return (
    <div className="container max-w-5xl mx-auto py-8 px-4">
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="h-5 w-5 text-indigo-600" />
          <h1 className="text-2xl font-semibold tracking-tight">Listing Health</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Every listing you have, sorted by how worried you should be. AI watches days-on-market, showing volume,
          buyer feedback, and price vs comps every 12 hours — when something wobbles, this page tells you
          exactly what to do and drafts the seller email for you.
        </p>
      </div>

      {/* ── Summary cards ────────────────────────────────────────────────── */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4 mb-6">
        {(["critical", "at_risk", "watch", "healthy"] as RiskLevel[]).map(level => {
          const meta = RISK_META[level]
          const count = board.summary[level]
          const Icon = meta.Icon
          return (
            <Card key={level} className={cn("border", meta.tone)}>
              <CardContent className="py-3 px-4">
                <div className="flex items-center gap-2 mb-1">
                  <Icon className="h-4 w-4" />
                  <span className="text-xs uppercase tracking-wide font-medium">{meta.label}</span>
                </div>
                <p className="text-2xl font-bold">{count}</p>
                <p className="text-[10px] mt-1 opacity-70">{meta.description}</p>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* ── Empty state ──────────────────────────────────────────────────── */}
      {board.rows.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center text-sm text-muted-foreground space-y-2">
            <ShieldCheck className="h-8 w-8 text-muted-foreground mx-auto" />
            <p>You don&apos;t have any active or coming-soon listings.</p>
            <p className="text-xs">When you do, AI watches them 24/7 and surfaces actions here.</p>
            <Button asChild size="sm" variant="outline" className="mt-2">
              <Link href="/dashboard/listings">Open Listings <ArrowRight className="h-3 w-3 ml-1" /></Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Listing rows ─────────────────────────────────────────────────── */}
      <div className="space-y-4">
        {board.rows.map(row => {
          const meta = RISK_META[row.riskLevel]
          const Icon = meta.Icon
          const hasActions = row.recommendedActions.length > 0 || row.interventions.length > 0
          return (
            <Card key={row.listingId} className={row.riskLevel === "critical" ? "border-red-300" : row.riskLevel === "at_risk" ? "border-amber-300" : undefined}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <CardTitle className="text-base flex items-center gap-2">
                      <span className="truncate">{row.address ?? "Untitled listing"}</span>
                      <Badge className={cn(meta.tone, "text-[10px]")}>
                        <Icon className="h-3 w-3 mr-1" /> {meta.label}
                      </Badge>
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-1">
                      {dollars(row.listPrice)}{row.bedrooms != null && ` · ${row.bedrooms} bd`}{row.bathrooms != null && ` · ${row.bathrooms} ba`}
                      {row.daysOnMarket != null && ` · ${row.daysOnMarket} day${row.daysOnMarket === 1 ? "" : "s"} on market`}
                    </p>
                  </div>
                  {row.overallScore != null && (
                    <div className="text-right">
                      <div className="flex items-center gap-1">
                        <span className="text-3xl font-bold">{Math.round(row.overallScore)}</span>
                        <span className="text-xs text-muted-foreground">/100</span>
                      </div>
                      {row.scoreDelta != null && row.scoreDelta !== 0 && (
                        <p className={`text-[11px] flex items-center gap-0.5 justify-end ${row.scoreDelta > 0 ? "text-emerald-700" : "text-red-700"}`}>
                          {row.scoreDelta > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                          {row.scoreDelta > 0 ? "+" : ""}{row.scoreDelta.toFixed(0)} since last check
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </CardHeader>

              <CardContent className="space-y-3">
                {row.aiNarrative && (
                  <p className="text-sm text-foreground/90 bg-muted/40 rounded p-3 leading-relaxed">
                    <Sparkles className="h-3.5 w-3.5 inline-block mr-1 text-indigo-600" />
                    {row.aiNarrative}
                  </p>
                )}

                {row.priceAdvice && (
                  <div
                    className={cn(
                      "rounded p-3 border",
                      row.priceAdvice.recommend
                        ? "bg-emerald-50/70 border-emerald-200"
                        : "bg-muted/40 border-muted",
                    )}
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Price advice
                    </p>
                    {row.priceAdvice.recommend && row.priceAdvice.recommendedPrice != null ? (
                      <>
                        <p className="text-sm font-medium mt-1">
                          Recommend ${row.priceAdvice.recommendedPrice.toLocaleString()}
                          {row.priceAdvice.dropAmount != null && (
                            <span className="text-muted-foreground font-normal">
                              {" "}— down ${row.priceAdvice.dropAmount.toLocaleString()}
                              {row.priceAdvice.dropPct != null && ` (${row.priceAdvice.dropPct}%)`}
                            </span>
                          )}
                        </p>
                        <Badge className="bg-slate-100 text-slate-700 text-[10px] mt-1">
                          {row.priceAdvice.confidence} confidence
                        </Badge>
                        <ul className="mt-2 space-y-0.5">
                          {row.priceAdvice.justification.map((j, i) => (
                            <li key={i} className="text-xs text-muted-foreground">• {j}</li>
                          ))}
                        </ul>
                        <p className="text-[11px] text-muted-foreground mt-2">
                          A price change needs the seller&apos;s agreement — this is a recommendation, not a change.
                        </p>
                      </>
                    ) : (
                      // The advisor declining is INFORMATION: it means price is not the problem.
                      <p className="text-sm mt-1 text-muted-foreground">{row.priceAdvice.reason}</p>
                    )}
                  </div>
                )}

                {row.flags.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">Flags</p>
                    <ul className="space-y-1">
                      {row.flags.slice(0, 5).map((f, i) => (
                        <li key={i} className="text-xs text-foreground/80 flex items-start gap-1.5">
                          <span className="text-amber-600 mt-0.5">•</span> {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {row.recommendedActions.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">AI-recommended actions</p>
                    {row.recommendedActions.slice(0, 3).map((a, i) => (
                      <div key={i} className="bg-indigo-50/60 border border-indigo-200 rounded p-3">
                        <p className="text-sm font-medium text-indigo-950">{a.action}</p>
                        <p className="text-xs text-indigo-900/70 mt-0.5">{a.reasoning}</p>
                        {a.impactEstimate && (
                          <p className="text-[10px] text-indigo-700 mt-1">Estimated impact: {a.impactEstimate}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {row.interventions.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">
                      Open interventions ({row.interventions.length})
                    </p>
                    {row.interventions.map(iv => (
                      <div key={iv.id} className="border rounded p-3 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 mb-1">
                              <Badge variant={iv.severity === "critical" ? "destructive" : "secondary"} className="text-[10px]">
                                {iv.severity}
                              </Badge>
                              {iv.category && <span className="text-[10px] text-muted-foreground uppercase">{iv.category}</span>}
                              <span className="text-[10px] text-muted-foreground">· {relative(iv.createdAt)}</span>
                            </div>
                            {iv.issueDetected && <p className="text-sm font-medium">{iv.issueDetected}</p>}
                            {iv.aiRecommendation && <p className="text-xs text-muted-foreground mt-1">{iv.aiRecommendation}</p>}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          {iv.sellerImpacted && (
                            <Button size="sm" variant="default" onClick={() => openDraftForListing(row)}>
                              <Mail className="h-3 w-3 mr-1" /> Draft seller email
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleResolve(iv.id)}
                            disabled={busyId === iv.id || pending}
                          >
                            <CheckCircle2 className="h-3 w-3 mr-1" /> Mark resolved
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* No issues yet → still let the agent proactively draft */}
                {!hasActions && row.riskLevel === "healthy" && (
                  <p className="text-xs text-emerald-700">Performing on track — no action needed.</p>
                )}

                <div className="flex gap-2 pt-1">
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/dashboard/listings/${row.listingId}`}>
                      Open listing <ArrowRight className="h-3 w-3 ml-1" />
                    </Link>
                  </Button>
                  {(row.riskLevel === "at_risk" || row.riskLevel === "critical") && (
                    <Button size="sm" variant="default" onClick={() => openDraftForListing(row)}>
                      <Sparkles className="h-3 w-3 mr-1" /> Draft seller email
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* ── Draft email dialog ──────────────────────────────────────────── */}
      <Dialog open={draftOpen} onOpenChange={(o) => { if (!o) setDraftOpen(false) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Seller email — {draftListingAddress ?? "listing"}</DialogTitle>
            <DialogDescription>
              AI drafted this from your listing&apos;s actual flags and comp data. Review, edit, then send from your own inbox.
            </DialogDescription>
          </DialogHeader>

          {draftLoading ? (
            <div className="py-12 flex items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Drafting…
            </div>
          ) : (
            <div className="space-y-3 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="recipient">Seller email</Label>
                <Input
                  id="recipient"
                  type="email"
                  placeholder="seller@example.com"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="subject">Subject</Label>
                <Input id="subject" value={draftSubject} onChange={(e) => setDraftSubject(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="body">Body</Label>
                <Textarea id="body" rows={10} value={draftBody} onChange={(e) => setDraftBody(e.target.value)} />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDraftOpen(false)} disabled={draftLoading}>
              <X className="h-3 w-3 mr-1" /> Cancel
            </Button>
            <Button onClick={handleSend} disabled={draftLoading || !draftBody.trim()}>
              <Mail className="h-3 w-3 mr-1" /> Open in email
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
