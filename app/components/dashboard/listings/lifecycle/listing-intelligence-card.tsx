"use client"

/**
 * LISTING INTELLIGENCE — the intake engine the listing side could not reach.
 *
 * app/actions/ai-listing-intake.ts holds the AI half of taking a listing: property
 * enrichment from an address, a list-price recommendation, a Fair Housing / MLS
 * review of the public copy, and the Dotloop document status. All four were
 * complete, authenticated, exported — and called from NOWHERE. The only caller
 * any of them had was runCompleteListingIntake, which itself had no caller, so
 * the whole cluster was unreachable from any screen in the product.
 *
 * What that cost, concretely:
 *
 *   · FAIR HOUSING. Nothing anywhere in the product read the listing's marketing
 *     copy for discriminatory language. The launch checklist's only compliance
 *     input is auditListingDocuments — a DOCUMENT check. A listing could go to the
 *     MLS with a Fair Housing violation in its public remarks and no surface would
 *     have said a word. The review now RECORDS against the listing and its findings
 *     become launch blockers until the copy is fixed and re-reviewed.
 *
 *   · PRICE. aiSuggestListPrice accepts market conditions and seller motivation
 *     and returns a range, a days-on-market estimate and its adjustments. No caller
 *     ever supplied any of it. The listing launch gate refuses a launch with no
 *     list price, and the agent had no help arriving at one.
 *
 *   · DOTLOOP. listings.dotloop_loop_id is written by two paths and READ by none
 *     for document status. The loop existed; what was signed in it was invisible.
 *
 * This card does not compute anything itself. Every number and every verdict on
 * screen came back from the action named beside it; where a value is an estimate
 * rather than a fact, it says so.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Loader2,
  ShieldCheck,
  ShieldAlert,
  TriangleAlert,
  CircleCheck,
  Sparkles,
  DollarSign,
  FileSignature,
  Home,
} from "lucide-react"
import {
  aiCheckListingCompliance,
  aiSuggestListPrice,
  aiEnrichPropertyData,
  aiCheckDocumentStatus,
} from "@/app/actions/ai-listing-intake"

export interface ListingIntelligenceProperty {
  address: string
  city: string | null
  state: string | null
  zip: string | null
  propertyType: string | null
  bedrooms: number | null
  bathrooms: number | null
  sqft: number | null
  yearBuilt: number | null
  lotSize: number | null
  hasPool: boolean | null
  listPrice: number | null
}

export interface ListingCopyReviewSummary {
  reviewed: boolean
  stale: boolean
  reviewedAt: string | null
  blockers: string[]
  /** Set when the gate itself could not run — never rendered as "clean". */
  error?: string
}

interface Props {
  listingId: string
  publicRemarks: string | null
  property: ListingIntelligenceProperty
  dotloopLoopId: string | null
  /** The persisted verdict from the last review, read server-side on this page. */
  lastReview: ListingCopyReviewSummary
}

type ComplianceResult = {
  isCompliant: boolean
  overallScore: number
  issues: Array<{
    severity: "critical" | "warning" | "suggestion"
    category: string
    issue: string
    suggestion: string
    location?: string
  }>
  fairHousingCheck: { passed: boolean; flaggedPhrases: string[] }
  mlsCompliance: { passed: boolean; issues: string[] }
  suggestedRevisions?: string
}

type PricingResult = {
  suggestedListPrice: number
  priceRangeLow: number
  priceRangeHigh: number
  pricePerSqFt: number
  daysOnMarketEstimate: number
  competitivePosition: "aggressive" | "market" | "premium"
  reasoning: string
  adjustments: Array<{ factor: string; impact: number; explanation: string }>
  marketAnalysis: string
}

type DocumentsResult = {
  documents: Array<{ id: string; name: string; folder: string; status: string; signedDate?: string }>
  summary: { total: number; signed: number; pending: number; notStarted: number }
  aiRecommendation: string
}

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

const SEVERITY_STYLE: Record<string, string> = {
  critical: "border-red-300 bg-red-50 text-red-800",
  warning: "border-amber-300 bg-amber-50 text-amber-800",
  suggestion: "border-slate-300 bg-slate-50 text-slate-700",
}

export function ListingIntelligenceCard({
  listingId,
  publicRemarks,
  property,
  dotloopLoopId,
  lastReview,
}: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [running, setRunning] = useState<"copy" | "price" | "docs" | null>(null)

  const [copyResult, setCopyResult] = useState<ComplianceResult | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [copyRecorded, setCopyRecorded] = useState<boolean | null>(null)

  const [pricing, setPricing] = useState<PricingResult | null>(null)
  const [pricingError, setPricingError] = useState<string | null>(null)
  const [pricingEstimated, setPricingEstimated] = useState(false)
  const [marketConditions, setMarketConditions] = useState<"hot" | "balanced" | "cooling">("balanced")
  const [motivation, setMotivation] = useState<"quick_sale" | "maximize_price" | "balanced">("balanced")

  const [docs, setDocs] = useState<DocumentsResult | null>(null)
  const [docsError, setDocsError] = useState<string | null>(null)

  const remarks = (publicRemarks ?? "").trim()
  const propertyState = (property.state ?? "").trim()

  // The listing's own facts. When the row carries none of them the pricing model
  // has nothing to price, which is why enrichment runs first rather than the
  // model being asked to invent the property.
  const hasPropertyFacts = !!(property.bedrooms || property.bathrooms || property.sqft)

  function reviewCopy() {
    setCopyError(null)
    setCopyRecorded(null)
    setRunning("copy")
    startTransition(async () => {
      try {
        const res = (await aiCheckListingCompliance({
          listingId,
          description: remarks,
          state: propertyState,
        })) as {
          success: boolean
          error?: string
          compliance?: ComplianceResult
          recorded?: boolean
        }
        if (!res.success || !res.compliance) {
          setCopyError(res.error ?? "The compliance review did not return a result.")
          return
        }
        setCopyResult(res.compliance)
        setCopyRecorded(res.recorded === true)
        // The verdict is now part of the listing's record and feeds the launch
        // gate — re-read the page so the checklist reflects it.
        router.refresh()
      } finally {
        setRunning(null)
      }
    })
  }

  function suggestPrice() {
    setPricingError(null)
    setPricingEstimated(false)
    setRunning("price")
    startTransition(async () => {
      try {
        // The listing's OWN facts. Nulls are dropped rather than sent, so an
        // absent value is an absence the model can fill instead of a "null" it
        // has to interpret.
        const known: Record<string, unknown> = {}
        const put = (k: string, v: unknown) => {
          if (v !== null && v !== undefined && v !== "") known[k] = v
        }
        put("address", property.address)
        put("city", property.city)
        put("state", property.state)
        put("zip", property.zip)
        put("propertyType", property.propertyType)
        put("beds", property.bedrooms)
        put("baths", property.bathrooms)
        put("sqft", property.sqft)
        put("yearBuilt", property.yearBuilt)
        put("lotSize", property.lotSize)
        put("pool", property.hasPool)
        put("currentListPrice", property.listPrice)

        let propertyData: Record<string, unknown> = known

        // No beds/baths/sqft on the row — fill them from the address first and
        // SAY they are an estimate. Pricing a property whose size is unknown
        // produces a number that looks authoritative and is not. The listing's
        // own facts still win over the estimate wherever it has them.
        if (!hasPropertyFacts) {
          const enriched = (await aiEnrichPropertyData(
            [property.address, property.city, property.state, property.zip].filter(Boolean).join(", "),
          )) as { success: boolean; error?: string; data?: Record<string, unknown> }
          if (!enriched.success || !enriched.data) {
            setPricingError(
              enriched.error ??
                "This listing has no beds/baths/sq ft recorded and they could not be estimated — add them before pricing.",
            )
            return
          }
          propertyData = { ...enriched.data, ...known }
          setPricingEstimated(true)
        }

        const res = (await aiSuggestListPrice({ propertyData, marketConditions, motivation })) as {
          success: boolean
          error?: string
          pricing?: PricingResult
        }
        if (!res.success || !res.pricing) {
          setPricingError(res.error ?? "The pricing model did not return a recommendation.")
          return
        }
        setPricing(res.pricing)
      } finally {
        setRunning(null)
      }
    })
  }

  function checkDocuments() {
    if (!dotloopLoopId) return
    setDocsError(null)
    setRunning("docs")
    startTransition(async () => {
      try {
        const res = (await aiCheckDocumentStatus({ loopId: dotloopLoopId })) as {
          success: boolean
          error?: string
        } & Partial<DocumentsResult>
        if (!res.success || !res.summary) {
          setDocsError(res.error ?? "Could not read the loop's documents.")
          return
        }
        setDocs({
          documents: res.documents ?? [],
          summary: res.summary,
          aiRecommendation: res.aiRecommendation ?? "",
        })
      } finally {
        setRunning(null)
      }
    })
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-violet-600" />
          Listing intelligence
        </CardTitle>
        <CardDescription>
          The intake engine applied to this listing — a Fair Housing and MLS review of the public
          copy, a list-price recommendation, and what has actually been signed.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* ── FAIR HOUSING / MLS REVIEW OF THE PUBLIC COPY ──────────────────── */}
        <section className="space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-medium flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4" />
                Public copy — Fair Housing &amp; MLS review
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Runs against this listing&apos;s public remarks. Critical findings hold the launch
                until the copy is fixed and reviewed again.
              </p>
            </div>
            <Button
              size="sm"
              onClick={reviewCopy}
              disabled={pending || !remarks || !propertyState}
            >
              {running === "copy" && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
              Review the copy
            </Button>
          </div>

          {!remarks && (
            <p className="text-xs text-muted-foreground border rounded px-3 py-2 bg-muted/30">
              This listing has no public remarks yet — there is nothing to review. Add the marketing
              description first.
            </p>
          )}
          {remarks && !propertyState && (
            <p className="text-xs text-muted-foreground border rounded px-3 py-2 bg-muted/30">
              The review is state-specific and this listing has no state on it.
            </p>
          )}

          {/* What the LAST review concluded, read from the listing's record. */}
          {!copyResult && lastReview.error && (
            <p className="text-xs text-red-700 border border-red-200 bg-red-50 rounded px-3 py-2">
              The recorded review could not be read ({lastReview.error}) — treat this listing as
              unreviewed rather than clean.
            </p>
          )}
          {!copyResult && !lastReview.error && lastReview.reviewed && (
            <div className="text-xs border rounded px-3 py-2 bg-muted/30 space-y-1">
              <p className="text-muted-foreground">
                Last reviewed{" "}
                {lastReview.reviewedAt ? new Date(lastReview.reviewedAt).toLocaleString() : "previously"}
                {lastReview.stale && " — the copy has changed since, so that verdict no longer applies."}
              </p>
              {!lastReview.stale && lastReview.blockers.length > 0 && (
                <ul className="list-disc pl-4 text-red-700">
                  {lastReview.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
              {!lastReview.stale && lastReview.blockers.length === 0 && (
                <p className="text-emerald-700 flex items-center gap-1.5">
                  <CircleCheck className="h-3.5 w-3.5" />
                  No blocking issues in the copy as it stands.
                </p>
              )}
            </div>
          )}

          {copyError && (
            <p className="text-xs text-red-600 flex items-start gap-1.5">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-px" />
              <span>{copyError}</span>
            </p>
          )}

          {copyResult && (
            <div className="border rounded-lg p-3 space-y-3 bg-muted/20">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge
                  variant="outline"
                  className={
                    copyResult.isCompliant
                      ? "border-emerald-300 text-emerald-700"
                      : "border-red-300 text-red-700"
                  }
                >
                  {copyResult.isCompliant ? "Compliant" : "Not compliant"}
                </Badge>
                <Badge variant="secondary">Score {copyResult.overallScore}/100</Badge>
                <Badge
                  variant="outline"
                  className={
                    copyResult.fairHousingCheck.passed
                      ? "border-emerald-300 text-emerald-700"
                      : "border-red-300 text-red-700"
                  }
                >
                  Fair Housing {copyResult.fairHousingCheck.passed ? "passed" : "failed"}
                </Badge>
                <Badge
                  variant="outline"
                  className={
                    copyResult.mlsCompliance.passed
                      ? "border-emerald-300 text-emerald-700"
                      : "border-amber-300 text-amber-700"
                  }
                >
                  MLS {copyResult.mlsCompliance.passed ? "passed" : "issues"}
                </Badge>
                {copyRecorded === false && (
                  <Badge variant="outline" className="border-amber-300 text-amber-700">
                    Not saved to the listing record
                  </Badge>
                )}
              </div>

              {copyResult.fairHousingCheck.flaggedPhrases.length > 0 && (
                <div className="text-xs">
                  <p className="font-medium flex items-center gap-1.5 text-red-700">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    Flagged phrases
                  </p>
                  <ul className="list-disc pl-5 mt-1 text-red-700">
                    {copyResult.fairHousingCheck.flaggedPhrases.map((p) => (
                      <li key={p}>&ldquo;{p}&rdquo;</li>
                    ))}
                  </ul>
                </div>
              )}

              {copyResult.issues.length > 0 && (
                <ul className="space-y-2">
                  {copyResult.issues.map((issue, i) => (
                    <li
                      key={`${issue.category}-${i}`}
                      className={`text-xs border rounded px-2.5 py-2 ${SEVERITY_STYLE[issue.severity] ?? SEVERITY_STYLE.suggestion}`}
                    >
                      <p className="font-medium">
                        {issue.severity.toUpperCase()} · {issue.category}
                      </p>
                      <p className="mt-0.5">{issue.issue}</p>
                      {issue.suggestion && <p className="mt-1 italic">Fix: {issue.suggestion}</p>}
                    </li>
                  ))}
                </ul>
              )}

              {copyResult.mlsCompliance.issues.length > 0 && (
                <div className="text-xs">
                  <p className="font-medium">MLS issues</p>
                  <ul className="list-disc pl-5 mt-1">
                    {copyResult.mlsCompliance.issues.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </div>
              )}

              {copyResult.suggestedRevisions && (
                <div className="text-xs">
                  <p className="font-medium">Suggested rewrite</p>
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                    {copyResult.suggestedRevisions}
                  </p>
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── LIST PRICE RECOMMENDATION ─────────────────────────────────────── */}
        <section className="space-y-3 border-t pt-5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-medium flex items-center gap-1.5">
                <DollarSign className="h-4 w-4" />
                List price recommendation
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {property.listPrice
                  ? `Currently listed at ${money(Number(property.listPrice))}.`
                  : "No list price on this listing yet — the launch gate holds until one is set."}
              </p>
            </div>
            <div className="flex items-end gap-2 flex-wrap">
              <label className="text-[11px]">
                <span className="block text-muted-foreground mb-1">Market</span>
                <select
                  className="border rounded px-2 py-1 text-xs bg-background"
                  value={marketConditions}
                  onChange={(e) => setMarketConditions(e.target.value as typeof marketConditions)}
                  disabled={pending}
                >
                  <option value="hot">Hot</option>
                  <option value="balanced">Balanced</option>
                  <option value="cooling">Cooling</option>
                </select>
              </label>
              <label className="text-[11px]">
                <span className="block text-muted-foreground mb-1">Seller wants</span>
                <select
                  className="border rounded px-2 py-1 text-xs bg-background"
                  value={motivation}
                  onChange={(e) => setMotivation(e.target.value as typeof motivation)}
                  disabled={pending}
                >
                  <option value="quick_sale">A quick sale</option>
                  <option value="balanced">A balanced outcome</option>
                  <option value="maximize_price">The highest price</option>
                </select>
              </label>
              <Button size="sm" variant="secondary" onClick={suggestPrice} disabled={pending}>
                {running === "price" && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
                Recommend a price
              </Button>
            </div>
          </div>

          {pricingError && (
            <p className="text-xs text-red-600 flex items-start gap-1.5">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-px" />
              <span>{pricingError}</span>
            </p>
          )}

          {pricing && (
            <div className="border rounded-lg p-3 space-y-3 bg-muted/20">
              {pricingEstimated && (
                <p className="text-[11px] text-amber-700 flex items-start gap-1.5">
                  <Home className="h-3.5 w-3.5 shrink-0 mt-px" />
                  <span>
                    This listing had no beds/baths/sq ft recorded, so those were ESTIMATED from the
                    address. Record the real figures and run this again before quoting it to a seller.
                  </span>
                </p>
              )}
              <div className="flex items-baseline gap-3 flex-wrap">
                <span className="text-2xl font-semibold">{money(pricing.suggestedListPrice)}</span>
                <span className="text-xs text-muted-foreground">
                  range {money(pricing.priceRangeLow)}–{money(pricing.priceRangeHigh)}
                </span>
                <Badge variant="secondary">{pricing.competitivePosition}</Badge>
                <Badge variant="outline">~{pricing.daysOnMarketEstimate} days on market</Badge>
                {pricing.pricePerSqFt > 0 && (
                  <Badge variant="outline">{money(pricing.pricePerSqFt)}/sq ft</Badge>
                )}
              </div>
              <p className="text-xs whitespace-pre-wrap">{pricing.reasoning}</p>
              {pricing.adjustments.length > 0 && (
                <ul className="text-xs space-y-1">
                  {pricing.adjustments.map((a, i) => (
                    <li key={`${a.factor}-${i}`} className="flex gap-2">
                      <span className={a.impact >= 0 ? "text-emerald-700" : "text-red-700"}>
                        {a.impact >= 0 ? "+" : ""}
                        {money(a.impact)}
                      </span>
                      <span className="font-medium">{a.factor}</span>
                      <span className="text-muted-foreground">{a.explanation}</span>
                    </li>
                  ))}
                </ul>
              )}
              {pricing.marketAnalysis && (
                <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                  {pricing.marketAnalysis}
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">
                A recommendation, not a price change — set the price on the listing to apply it.
              </p>
            </div>
          )}
        </section>

        {/* ── DOTLOOP DOCUMENT STATUS ───────────────────────────────────────── */}
        {dotloopLoopId && (
          <section className="space-y-3 border-t pt-5">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <FileSignature className="h-4 w-4" />
                  Documents in the transaction loop
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  What has actually been signed in the loop this listing is attached to.
                </p>
              </div>
              <Button size="sm" variant="secondary" onClick={checkDocuments} disabled={pending}>
                {running === "docs" && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
                Check document status
              </Button>
            </div>

            {docsError && (
              <p className="text-xs text-red-600 flex items-start gap-1.5">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-px" />
                <span>{docsError}</span>
              </p>
            )}

            {docs && (
              <div className="border rounded-lg p-3 space-y-2 bg-muted/20">
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <Badge variant="secondary">{docs.summary.signed} signed</Badge>
                  <Badge variant="outline">{docs.summary.pending} awaiting signature</Badge>
                  <Badge variant="outline">{docs.summary.notStarted} not started</Badge>
                  <span className="text-muted-foreground">of {docs.summary.total}</span>
                </div>
                {docs.documents.length > 0 && (
                  <ul className="text-xs space-y-1">
                    {docs.documents.map((d) => (
                      <li key={d.id ?? d.name} className="flex items-center justify-between gap-3">
                        <span>
                          {d.name}
                          <span className="text-muted-foreground"> · {d.folder}</span>
                        </span>
                        <span
                          className={
                            d.status === "signed"
                              ? "text-emerald-700"
                              : d.status === "pending_signature"
                                ? "text-amber-700"
                                : "text-muted-foreground"
                          }
                        >
                          {d.status.replace(/_/g, " ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {docs.aiRecommendation && (
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                    {docs.aiRecommendation}
                  </p>
                )}
              </div>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  )
}
