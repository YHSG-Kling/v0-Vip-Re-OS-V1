"use client"

// app/components/portal/NetSheetCalculator.tsx — the seller's net proceeds in the portal.
// WAVE 156 (lane 156H, round 4): the math is the ONE engine's seller net sheet (lib/calculators/engine.ts "seller_net_sheet",
// audience public). TOMBSTONE — this component's own arithmetic stood here with a 6% commission default (a slider pinned to 4–7%),
// a flat 2% closing-cost fallback, and prorations added straight into the net. SURVIVOR: runCalculator("seller_net_sheet") —
// the commission is the seller's listing-agreement figure (asked for), the closing costs are a quote or the state's REVIEWED
// regional band (cited: REGIONAL_CONVENTION_CITATION, marked an estimate), and a proration credit is the engine's own CREDIT
// line (creditsToSeller), never a negative cost. Blank → "Enter a value", never a default.

import { useState, useEffect, useMemo } from "react"
import { useParams } from "next/navigation"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Download, Loader2 } from "lucide-react"
import { deriveNetSheetClosingCostSection } from "@/lib/offers/seller-closing-costs"
import { REGIONAL_CONVENTION_CITATION } from "@/lib/offers/regional-closing-costs"
import { runCalculator, type CalculatorOutcome } from "@/lib/calculators/engine"
import { generateNetSheetPdf } from "@/app/actions/kernel-bridges"

interface NetSheetProps {
  offerPrice: number
  listPrice: number
  currentMortgageBalance: number
  propertyAddress: string
  /** The property's state ("TX" / "Texas"). When known, the closing-cost field can start from that state's REVIEWED regional
   *  convention band (lib/offers/seller-closing-costs, cited), marked as an estimate. Unknown → the seller enters a quote. */
  state?: string | null
}

/** Scenario offsets, in whole percent of the list price — labelled scenarios the seller chooses to view, not rates. */
const SCENARIO_OFFSET_PCT = 5
const SLIDER_RANGE_PCT = 15
const atPct = (base: number, pct: number) => (base * (100 + pct)) / 100

export function NetSheetCalculator({ offerPrice, listPrice, currentMortgageBalance, propertyAddress, state = null }: NetSheetProps) {
  const [price, setPrice] = useState(offerPrice)
  const [commissionPct, setCommissionPct] = useState("")

  const closingCostSection = useMemo(() => deriveNetSheetClosingCostSection(price, state), [price, state])
  const initialSection = deriveNetSheetClosingCostSection(offerPrice, state)
  const [closingCosts, setClosingCosts] = useState(initialSection ? String(Math.round(initialSection.midpoint)) : "")
  // Manual override preserved: once the seller edits the field, the regional band stops following the price slider.
  const [closingCostsOverridden, setClosingCostsOverridden] = useState(false)
  useEffect(() => {
    if (!closingCostsOverridden && closingCostSection) setClosingCosts(String(Math.round(closingCostSection.midpoint)))
  }, [closingCostSection, closingCostsOverridden])

  const [liens, setLiens] = useState("")
  const [hoaFees, setHoaFees] = useState("")
  const [prorationCredit, setProrationCredit] = useState("")
  const [prorationOwed, setProrationOwed] = useState("")

  /** The ONE engine, at any price. The regional seed is marked an estimate; nothing blank is defaulted. */
  const netAt = (scenarioPrice: number): CalculatorOutcome => runCalculator("seller_net_sheet", {
    salePrice: Math.round(scenarioPrice), mortgagePayoff: currentMortgageBalance, listingCommissionPct: commissionPct,
    titleEscrowFees: closingCosts, includeTransferTax: "no",
    otherLiens: liens, hoaAtClosing: hoaFees, creditsToSeller: prorationCredit, proratedPropertyTax: prorationOwed,
  }, { audience: "public", estimateKeys: closingCostSection && !closingCostsOverridden ? ["titleEscrowFees"] : [] })
  const outcome = useMemo(() => netAt(price), [price, commissionPct, closingCosts, liens, hoaFees, prorationCredit, prorationOwed, closingCostsOverridden])
  const line = (o: CalculatorOutcome, k: string) => (o.ok ? o.lines.find((l) => l.key === k)?.amount ?? 0 : 0)
  const netOf = (o: CalculatorOutcome) => (o.ok ? Number(o.outputs.estimatedNet) : null)
  const commission = line(outcome, "listingCommission")
  const netProceeds = netOf(outcome)

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
      amount,
    )
  }

  const calculateScenarioNet = (scenarioPrice: number) => netOf(netAt(scenarioPrice))
  const fmtNet = (n: number | null) => (n == null ? "—" : formatCurrency(n))

  // ── DOWNLOAD NET SHEET PDF ─────────────────────────────────────────────────
  // This button had NO handler. netSheetPdfSpec and produceClientDocument's
  // "net_sheet" branch were both complete and had never been invoked from
  // anywhere, so a seller could model their proceeds all afternoon and leave
  // with nothing on paper. generateNetSheetPdf (app/actions/kernel-bridges)
  // is the server seam: the spec + producer are server-only modules a client
  // component cannot import.
  //
  // The contact comes from the route (/portal/[contactId]/offers) — the parent
  // page does not pass it, and the action re-authorizes it server-side anyway.
  const routeParams = useParams<{ contactId: string | string[] }>()
  const contactId = Array.isArray(routeParams?.contactId) ? routeParams.contactId[0] : routeParams?.contactId
  const [pdfPending, setPdfPending] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)

  /** One PDF scenario built from EXACTLY the figures on screen — the document
   *  and the calculator can never disagree because nothing is recomputed here. */
  const scenarioForPdf = (label: string, scenarioPrice: number) => {
    const o = netAt(scenarioPrice)
    // The spec renders "other" as a deduction line and has no row for a credit; a net credit is applied to the closing-cost line
    // so the breakdown still reconciles to the engine's net shown above.
    const otherNet = line(o, "otherLiens") + line(o, "hoaAtClosing") + line(o, "proratedPropertyTax") - line(o, "creditsToSeller")
    return {
      label,
      salePrice: scenarioPrice,
      commission: line(o, "listingCommission"),
      closingCosts: otherNet < 0 ? line(o, "titleEscrowFees") + otherNet : line(o, "titleEscrowFees"),
      mortgagePayoff: currentMortgageBalance || null,
      other: otherNet > 0 ? otherNet : null,
      netProceeds: netOf(o) ?? 0,
    }
  }

  const handleDownloadPdf = async () => {
    if (!outcome.ok) { setPdfError("Enter the figures marked above first — the net sheet is built only from your numbers."); return }
    if (!contactId) {
      // Names what was tested. The old wording blamed "your portal account",
      // which is a different thing and sends the reader to check their login —
      // the contactId simply is not in the route params.
      setPdfError("No contact id in this page's address — reload from your portal home.")
      return
    }
    setPdfPending(true)
    setPdfError(null)
    setPdfUrl(null)
    try {
      const result = await generateNetSheetPdf({
        contactId,
        propertyAddress,
        scenarios: [
          scenarioForPdf("Selected price", price),
          scenarioForPdf(`${SCENARIO_OFFSET_PCT}% below ask`, atPct(listPrice, -SCENARIO_OFFSET_PCT)),
          scenarioForPdf("Full ask", listPrice),
          scenarioForPdf(`${SCENARIO_OFFSET_PCT}% over ask`, atPct(listPrice, SCENARIO_OFFSET_PCT)),
        ],
      })
      // The action returns { success, error } and never throws — a refusal has
      // to read as a refusal, not as a button that blinked.
      if (!result.success || !result.pdfUrl) {
        setPdfError(result.error ?? "The net sheet PDF could not be generated.")
        return
      }
      setPdfUrl(result.pdfUrl)
      window.open(result.pdfUrl, "_blank", "noopener,noreferrer")
    } catch {
      setPdfError("The net sheet PDF could not be generated. Please try again.")
    } finally {
      setPdfPending(false)
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Your Net Proceeds Calculator</CardTitle>
        <p className="text-sm text-muted-foreground">See exactly what you'll walk away with at closing</p>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Sale Price */}
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <Label>Sale Price</Label>
            <span className="text-2xl font-bold text-green-600">{formatCurrency(price)}</span>
          </div>
          <Slider
            value={[price]}
            onValueChange={(value) => setPrice(value[0])}
            min={atPct(listPrice, -SLIDER_RANGE_PCT)}
            max={atPct(listPrice, SLIDER_RANGE_PCT)}
            step={1000}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{formatCurrency(atPct(listPrice, -SLIDER_RANGE_PCT))}</span>
            <span>List: {formatCurrency(listPrice)}</span>
            <span>{formatCurrency(atPct(listPrice, SLIDER_RANGE_PCT))}</span>
          </div>
        </div>

        <Separator />

        {/* Deductions */}
        <div className="space-y-4">
          <h3 className="font-semibold">Deductions</h3>

          {/* Commission — the seller's own listing-agreement figure; no rate is assumed */}
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <Label htmlFor="commissionPct">Commission (% from your listing agreement)</Label>
              <Input id="commissionPct" inputMode="decimal" value={commissionPct} onChange={(e) => setCommissionPct(e.target.value)} className="w-32 text-right" placeholder="enter %" />
            </div>
            {outcome.ok && <span className="text-red-600 text-right block text-sm">-{formatCurrency(commission)}</span>}
          </div>

          {/* Closing Costs — regional band default when the state is known; the input is the manual override */}
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <Label htmlFor="closingCosts">Closing costs incl. any transfer tax (title / settlement quote)</Label>
              <Input
                id="closingCosts"
                inputMode="decimal"
                value={closingCosts}
                placeholder="enter $"
                onChange={(e) => {
                  setClosingCostsOverridden(true)
                  setClosingCosts(e.target.value)
                }}
                className="w-32 text-right"
              />
            </div>
            {outcome.ok && <span className="text-red-600 text-right block text-sm">-{formatCurrency(line(outcome, "titleEscrowFees"))}</span>}
            {closingCostSection && (
              <div className="rounded-md border bg-muted/40 p-3 space-y-1">
                <p className="text-xs font-semibold">
                  Seller closing costs · {closingCostSection.regionLabel}
                </p>
                {closingCostSection.lines.map((l) => (
                  <div key={l.label} className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                    <span>{l.label}</span>
                    <span className="tabular-nums whitespace-nowrap">
                      {formatCurrency(l.low)}{l.high !== l.low ? `–${formatCurrency(l.high)}` : ""}
                    </span>
                  </div>
                ))}
                <div className="flex items-baseline justify-between gap-3 border-t pt-1 text-xs font-semibold">
                  <span>Band total</span>
                  <span className="tabular-nums whitespace-nowrap">
                    {formatCurrency(closingCostSection.low)}–{formatCurrency(closingCostSection.high)}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-snug">
                  The field above starts at this band's midpoint
                  {closingCostsOverridden ? " (you've overridden it)" : ""} — a {closingCostSection.regionLabel},
                  not a quote — source: {REGIONAL_CONVENTION_CITATION}. Commission and mortgage payoff are their own lines.
                  The settlement statement is the authority.
                </p>
              </div>
            )}
          </div>

          {/* Mortgage Payoff */}
          <div className="flex justify-between items-center">
            <Label>Mortgage Payoff</Label>
            <span className="text-red-600">-{formatCurrency(currentMortgageBalance)}</span>
          </div>

          {/* Liens */}
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <Label htmlFor="liens">Liens / Judgments</Label>
              <Input
                id="liens"
                inputMode="decimal"
                value={liens}
                onChange={(e) => setLiens(e.target.value)}
                className="w-32 text-right"
                placeholder="0"
              />
            </div>
          </div>

          {/* HOA — `hoaFees` fed every net figure on this card (the live total,
              the three quick scenarios and the PDF's "other" line) and had NO
              input, so a seller's proceeds always assumed zero HOA. The lien
              field above was labelled "Liens / HOA Dues" as a stand-in; it is
              now liens only and HOA has its own line, same shape as its
              siblings. Portal surface: these are the seller's own figures. */}
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <Label htmlFor="hoaFees">HOA Dues / Transfer Fees (owed at closing)</Label>
              <Input
                id="hoaFees"
                inputMode="decimal"
                value={hoaFees}
                onChange={(e) => setHoaFees(e.target.value)}
                className="w-32 text-right"
                placeholder="0"
              />
            </div>
          </div>

          {/* Prorations */}
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <Label htmlFor="prorationCredit">Proration CREDIT to you (taxes / HOA the buyer reimburses)</Label>
              <Input id="prorationCredit" inputMode="decimal" value={prorationCredit} onChange={(e) => setProrationCredit(e.target.value)} className="w-32 text-right" placeholder="0" />
            </div>
            {line(outcome, "creditsToSeller") > 0 && <span className="text-green-700 text-right block text-sm">+{formatCurrency(line(outcome, "creditsToSeller"))}</span>}
            <div className="flex justify-between items-center">
              <Label htmlFor="prorationOwed">Prorated tax YOU owe at closing</Label>
              <Input id="prorationOwed" inputMode="decimal" value={prorationOwed} onChange={(e) => setProrationOwed(e.target.value)} className="w-32 text-right" placeholder="0" />
            </div>
          </div>
        </div>

        <Separator />

        {/* Net Proceeds */}
        <div className="bg-gradient-to-r from-green-50 to-emerald-50 p-6 rounded-lg border-2 border-green-200">
          <div className="flex justify-between items-center">
            <div>
              <p className="text-sm text-muted-foreground mb-1">Your Net Proceeds</p>
              <p className="text-4xl font-bold text-green-700">{netProceeds != null ? formatCurrency(netProceeds) : "—"}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">{outcome.ok ? outcome.period : "One time, at closing"}</p>
            </div>
          </div>
          {!outcome.ok && (
            <ul className="mt-2 list-disc pl-5 text-xs text-amber-900">
              {outcome.missing.map((m) => <li key={m.key}>{m.message}</li>)}
              {outcome.refused.map((r) => <li key={r.key}>{r.label}: {r.reason}</li>)}
            </ul>
          )}
          {outcome.ok && (
            <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
              {outcome.assumptions.filter((a) => a.basis !== "not_included").map((a) => <li key={a.key}>{a.label}: {a.display} ({a.basis === "you_entered_estimate" ? `estimate — ${REGIONAL_CONVENTION_CITATION}` : a.basis.replace(/_/g, " ")})</li>)}
            </ul>
          )}
        </div>

        {/* Scenario Comparison */}
        <div className="space-y-3">
          <h4 className="font-semibold text-sm">Quick Scenarios</h4>
          <div className="grid grid-cols-3 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPrice(atPct(listPrice, -SCENARIO_OFFSET_PCT))}
              className="flex flex-col h-auto py-2"
            >
              <span className="font-semibold">{SCENARIO_OFFSET_PCT}% Below Ask</span>
              <span className="text-xs text-muted-foreground mt-1">
                Net: {fmtNet(calculateScenarioNet(atPct(listPrice, -SCENARIO_OFFSET_PCT)))}
              </span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPrice(listPrice)}
              className="flex flex-col h-auto py-2"
            >
              <span className="font-semibold">Full Ask</span>
              <span className="text-xs text-muted-foreground mt-1">
                Net: {fmtNet(calculateScenarioNet(listPrice))}
              </span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPrice(atPct(listPrice, SCENARIO_OFFSET_PCT))}
              className="flex flex-col h-auto py-2"
            >
              <span className="font-semibold">{SCENARIO_OFFSET_PCT}% Over Ask</span>
              <span className="text-xs text-muted-foreground mt-1">
                Net: {fmtNet(calculateScenarioNet(atPct(listPrice, SCENARIO_OFFSET_PCT)))}
              </span>
            </Button>
          </div>
        </div>

        {/* Download PDF — renders the four priced scenarios above as a branded PDF */}
        <div className="space-y-2">
          <Button className="w-full" variant="default" onClick={handleDownloadPdf} disabled={pdfPending}>
            {pdfPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Preparing your net sheet…
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                Download Net Sheet PDF
              </>
            )}
          </Button>
          {pdfError && <p className="text-sm text-red-600 text-center">{pdfError}</p>}
          {pdfUrl && !pdfError && (
            <p className="text-sm text-green-700 text-center">
              Net sheet ready —{" "}
              <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="underline font-medium">
                open the PDF
              </a>{" "}
              if it did not open automatically. A copy is saved to your file.
            </p>
          )}
        </div>

        {/* Disclaimer */}
        <p className="text-xs text-muted-foreground text-center">
          {outcome.ok ? outcome.disclaimers.join(" ") : "*An estimate built only from the figures you enter. Final numbers are on the settlement statement."}
        </p>
      </CardContent>
    </Card>
  )
}
