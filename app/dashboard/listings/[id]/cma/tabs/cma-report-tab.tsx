"use client"

import { useState, useTransition } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronDown, ChevronRight, Zap, Sparkles } from "lucide-react"
import { triggerAICompScoring } from "@/app/actions/seller-cma"
import { resolveCompRiskFlag } from "@/app/actions/compliance-monitoring"
import { generateAICMA } from "@/app/actions/ai-cma"
import type { CMAPageData } from "@/app/actions/seller-cma"
import { useRouter } from "next/navigation"

interface Props {
  listing: {
    id: string
    list_price: number | null
    agent_id?: string | null
    address?: string | null
    city?: string | null
    state?: string | null
    property_type?: string | null
    bedrooms?: number | null
    bathrooms?: number | null
    square_footage?: number | null
  }
  data: CMAPageData
}

function qualityBadge(score: number) {
  if (score >= 80) return <Badge className="bg-green-100 text-green-800 border-green-300">Quality {score}</Badge>
  if (score >= 60) return <Badge className="bg-amber-100 text-amber-800 border-amber-300">Quality {score}</Badge>
  return <Badge className="bg-red-100 text-red-800 border-red-300">Quality {score}</Badge>
}

function scoreBadge(score: number | null) {
  if (score === null) return <Badge variant="outline" className="text-muted-foreground">Unscored</Badge>
  if (score >= 80) return <Badge className="bg-green-100 text-green-800 border-green-300">{score}</Badge>
  if (score >= 60) return <Badge className="bg-amber-100 text-amber-800 border-amber-300">{score}</Badge>
  return <Badge className="bg-red-100 text-red-800 border-red-300">{score}</Badge>
}

function severityBadge(severity: string) {
  const map: Record<string, string> = {
    low: "bg-blue-100 text-blue-800 border-blue-300",
    medium: "bg-amber-100 text-amber-800 border-amber-300",
    high: "bg-red-100 text-red-800 border-red-300",
    critical: "bg-red-200 text-red-900 border-red-400",
  }
  return (
    <Badge className={map[severity] ?? "bg-muted text-muted-foreground"}>
      {severity}
    </Badge>
  )
}

export function CMAReportTab({ listing, data }: Props) {
  const { cma, comparables, compScores, riskFlags, propertyUpgrades, agreement } = data
  const [isPending, startTransition] = useTransition()
  const [scoringMsg, setScoringMsg] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  // Flags cleared during THIS render, so the card empties immediately instead of
  // waiting for a refresh. The server is still the authority — a refusal leaves
  // the id out of this set and puts the reason in flagMsg.
  const [resolvedFlagIds, setResolvedFlagIds] = useState<Set<string>>(new Set())
  const [resolvingFlagId, setResolvingFlagId] = useState<string | null>(null)
  const [flagMsg, setFlagMsg] = useState<string | null>(null)
  const router = useRouter()

  const openRiskFlags = riskFlags.filter((f) => !resolvedFlagIds.has(f.id))

  async function handleResolveFlag(flagId: string) {
    setResolvingFlagId(flagId)
    setFlagMsg(null)
    const res = await resolveCompRiskFlag({ flagId })
    setResolvingFlagId(null)
    if (res.success) {
      setResolvedFlagIds((prev) => new Set(prev).add(flagId))
      setFlagMsg("Flag cleared — recorded against you, with the time.")
      router.refresh()
    } else {
      // Never swallowed. A refused clear that looks like a success is how a
      // risk flag disappears from the screen while still standing in the record.
      setFlagMsg(res.error ?? "Could not clear that flag.")
    }
  }

  function handleScoreComps() {
    if (!cma) return
    startTransition(async () => {
      setScoringMsg(null)
      const result = await triggerAICompScoring(cma.id, listing.id)
      setScoringMsg(
        result.success
          ? `Scored ${result.scored} comparable${result.scored !== 1 ? "s" : ""}.`
          : result.error ?? "Scoring failed."
      )
    })
  }

  async function handleGenerateCMA() {
    if (!listing.agent_id) {
      setGenerateError("Agent ID not found on listing.")
      return
    }
    setGenerating(true)
    setGenerateError(null)
    try {
      const result = await generateAICMA({
        agentId: listing.agent_id,
        listingId: listing.id,
        propertyAddress: listing.address ?? "",
        propertyCity: listing.city ?? "",
        propertyState: listing.state ?? "FL",
        propertyZip: "",
        propertyType: (listing.property_type as any) ?? "single_family",
        bedrooms: listing.bedrooms ?? 0,
        bathrooms: listing.bathrooms ?? 0,
        squareFeet: listing.square_footage ?? 0,
        listingType: "seller",
      })
      if (!result.success) {
        setGenerateError((result as any).error ?? "CMA generation failed.")
      } else {
        // Refresh the page so the new CMA is loaded from the server
        router.refresh()
      }
    } catch (e: any) {
      setGenerateError(e.message ?? "CMA generation failed.")
    } finally {
      setGenerating(false)
    }
  }

  if (!cma) {
    return (
      <div className="p-6">
        <Card className="border-dashed">
          <CardContent className="py-16 flex flex-col items-center gap-4 text-center">
            <p className="text-muted-foreground text-sm">No CMA report found for this listing.</p>
            <Button
              onClick={handleGenerateCMA}
              disabled={generating}
              className="gap-2"
            >
              <Sparkles className="h-4 w-4" />
              {generating ? "Generating CMA..." : "Generate AI CMA"}
            </Button>
            {generateError && (
              <p className="text-destructive text-xs">{generateError}</p>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 pb-20">
      {/* Top bar */}
      <div className="flex items-center gap-3 flex-wrap">
        {qualityBadge(cma.quality_score)}
        {cma.autoGenerated && (
          <Badge variant="outline" className="text-muted-foreground">Auto-generated</Badge>
        )}
        <span className="text-sm text-muted-foreground ml-auto">
          {cma.recommended_price
            ? `Recommended: $${Number(cma.recommended_price).toLocaleString()}`
            : ""}
          {cma.price_range_low && cma.price_range_high
            ? ` ($${Number(cma.price_range_low).toLocaleString()}–$${Number(cma.price_range_high).toLocaleString()})`
            : ""}
        </span>
      </div>

      {/* Property upgrades (seller-reported from CMA intake) */}
      {propertyUpgrades.length > 0 && (
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm font-medium text-foreground">
              Seller-Reported Upgrades
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Factored into comp adjustments
            </p>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="grid sm:grid-cols-2 gap-2">
              {propertyUpgrades.map((u) => (
                <div key={u.id} className="flex justify-between text-sm border border-border rounded px-3 py-2">
                  <span className="text-foreground">{u.upgrade_description}</span>
                  <span className="text-muted-foreground text-xs">
                    {u.estimated_cost ? `$${Number(u.estimated_cost).toLocaleString()}` : ""}
                    {u.roi_estimate ? ` · ${u.roi_estimate}% ROI` : ""}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Commission pre-fill from agreement */}
      {agreement && (
        <Card className="border-blue-200 bg-blue-50/40">
          <CardContent className="px-4 py-3 flex flex-wrap gap-4 text-sm">
            <span className="text-foreground">
              <span className="text-muted-foreground">Listing commission: </span>
              {agreement.listing_commission_rate
                ? `${agreement.listing_commission_rate}%`
                : "—"}
            </span>
            <span className="text-foreground">
              <span className="text-muted-foreground">Buyer commission: </span>
              {agreement.buyer_commission_rate
                ? `${agreement.buyer_commission_rate}%`
                : "—"}
            </span>
            {agreement.has_commission_adjustment && (
              <span className="text-amber-700 text-xs font-medium">
                Adjustment: {agreement.adjustment_type} {agreement.adjustment_value} ({agreement.adjustment_notes})
              </span>
            )}
          </CardContent>
        </Card>
      )}

      {/* Risk flags.
          The list is loaded `.eq("is_resolved", false)` and, until wave 14, nothing
          could ever set that column true — so a comp risk the agent had already
          dealt with stayed on the report permanently. "Mark handled" is the writer
          that was missing; it records WHO cleared it and WHEN (m511), because a
          compliance artefact cleared by nobody is not cleared. */}
      {openRiskFlags.length > 0 && (
        <Card className="border-red-200 bg-red-50/30">
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm font-medium text-red-800">Comp Risk Flags</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-2">
            {openRiskFlags.map((flag) => (
              <div key={flag.id} className="flex gap-2 items-start text-sm">
                {severityBadge(flag.severity)}
                <div className="flex-1">
                  <p className="text-foreground">{flag.description}</p>
                  {flag.recommended_action && (
                    <p className="text-xs text-muted-foreground mt-0.5">{flag.recommended_action}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={resolvingFlagId === flag.id}
                  onClick={() => handleResolveFlag(flag.id)}
                >
                  {resolvingFlagId === flag.id ? "Clearing…" : "Mark handled"}
                </Button>
              </div>
            ))}
            {flagMsg && <p className="text-xs text-muted-foreground">{flagMsg}</p>}
          </CardContent>
        </Card>
      )}
      {/* A refusal must not be silent: if every flag was cleared this run, say so
          rather than simply removing the card and leaving the agent guessing. */}
      {openRiskFlags.length === 0 && resolvedFlagIds.size > 0 && flagMsg && (
        <p className="text-xs text-muted-foreground">{flagMsg}</p>
      )}

      {/* AI Scoring button */}
      {!cma.hasAIScores && (
        <div className="flex items-center gap-3">
          <Button
            onClick={handleScoreComps}
            disabled={isPending}
            size="sm"
            className="gap-2"
          >
            <Zap className="h-4 w-4" />
            {isPending ? "Scoring comps..." : "Run AI Comp Scoring"}
          </Button>
          {scoringMsg && (
            <span className="text-sm text-muted-foreground">{scoringMsg}</span>
          )}
        </div>
      )}
      {cma.hasAIScores && scoringMsg && (
        <p className="text-sm text-muted-foreground">{scoringMsg}</p>
      )}

      {/* Comparables table */}
      {comparables.length === 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Comp data insufficient for this search. Manual MLS review recommended.
        </div>
      )}
      <Card>
        <CardHeader className="py-3 px-4">
          <CardTitle className="text-sm font-medium text-foreground">
            Comparables ({comparables.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Address</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">Sold Price</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">$/sqft</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">DOM</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">Distance</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">Sale Date</th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground">AI Score</th>
                </tr>
              </thead>
              <tbody>
                {comparables.map((comp) => {
                  const aiScore = compScores[comp.id]
                  return (
                    <CompRow
                      key={comp.id}
                      comp={comp}
                      aiScore={aiScore ?? null}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function CompRow({
  comp,
  aiScore,
}: {
  comp: {
    id: string
    address: string
    sale_price: number | null
    price_per_sqft: number | null
    days_on_market: number | null
    distance_miles: number | null
    sale_date: string | null
    ai_score: number | null
    ai_rationale: string | null
    risk_flags: string[] | null
    coaching_insight: string | null
  }
  aiScore: {
    score: number
    confidence_level: string | null
    score_rationale: string | null
    coaching_insight: string | null
  } | null
}) {
  const [open, setOpen] = useState(false)
  const score = aiScore?.score ?? comp.ai_score
  const rationale = aiScore?.score_rationale ?? comp.ai_rationale
  const coaching = aiScore?.coaching_insight ?? comp.coaching_insight
  const flags = comp.risk_flags ?? []

  return (
    <>
      <tr
        className="border-b border-border hover:bg-muted/30 cursor-pointer"
        onClick={() => setOpen((o) => !o)}
      >
        <td className="px-4 py-3 text-foreground">
          <div className="flex items-center gap-1.5">
            {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
            {comp.address}
          </div>
          {flags.length > 0 && (
            <div className="flex gap-1 flex-wrap mt-1">
              {flags.slice(0, 3).map((f, i) => (
                <span key={i} className="text-xs bg-red-100 text-red-700 rounded px-1.5 py-0.5">{f}</span>
              ))}
            </div>
          )}
        </td>
        <td className="px-4 py-3 text-right text-foreground">
          {comp.sale_price ? `$${Number(comp.sale_price).toLocaleString()}` : "—"}
        </td>
        <td className="px-4 py-3 text-right text-muted-foreground">
          {comp.price_per_sqft ? `$${Number(comp.price_per_sqft).toFixed(0)}` : "—"}
        </td>
        <td className="px-4 py-3 text-right text-muted-foreground">
          {comp.days_on_market ?? "—"}
        </td>
        <td className="px-4 py-3 text-right text-muted-foreground">
          {comp.distance_miles ? `${Number(comp.distance_miles).toFixed(1)}mi` : "—"}
        </td>
        <td className="px-4 py-3 text-right text-muted-foreground">
          {comp.sale_date ? new Date(comp.sale_date).toLocaleDateString() : "—"}
        </td>
        <td className="px-4 py-3 text-center">
          {scoreBadge(score)}
        </td>
      </tr>
      {open && (rationale || coaching) && (
        <tr className="bg-muted/20 border-b border-border">
          <td colSpan={7} className="px-6 py-3 space-y-1.5">
            {rationale && (
              <p className="text-xs text-foreground">
                <span className="font-medium text-muted-foreground">Score rationale: </span>
                {rationale}
              </p>
            )}
            {coaching && (
              <p className="text-xs text-blue-700 bg-blue-50 rounded px-2 py-1 border border-blue-200">
                <span className="font-medium">Coaching: </span>
                {coaching}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
