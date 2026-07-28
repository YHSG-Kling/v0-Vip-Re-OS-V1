"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { saveNetSheet } from "@/app/actions/seller-cma"
import {
  shareNetSheetToPortal,
  generateNetSheetExplanation,
  saveNetSheetEmailDraft,
} from "@/app/actions/cma-presentation/net-sheet-calculator"
import type { NetSheetPageData } from "@/app/actions/seller-cma"

interface Listing {
  id: string
  address: string | null
  list_price: number | null
  seller_contact_id?: string | null
}

interface Props {
  listing: Listing
  data: NetSheetPageData
  agentFirstName?: string
}

const fmt = (n: number) => `$${Math.round(n).toLocaleString()}`

export function NetSheetTab({ listing, data, agentFirstName = "Your agent" }: Props) {
  const { latestNetSheet, agreement, recommendedPrice } = data

  const prefillPrice =
    recommendedPrice ??
    latestNetSheet?.sale_price ??
    listing.list_price ??
    0

  const [salePrice, setSalePrice] = useState(String(prefillPrice))
  // A flat-fee listing is billed the agreed AMOUNT, not a percentage of price.
  const isFlatFee = !!agreement?.commission_is_flat_fee && agreement?.commission_flat_amount != null
  const flatAmount = Number(agreement?.commission_flat_amount ?? 0)

  // When the agreement records only a TOTAL rate, put it on the listing line and
  // leave the buyer line at 0 so the two still sum to the agreed total — rather
  // than falling to 3/3 and quoting the seller 6%.
  const totalOnly =
    agreement?.total_commission_rate != null &&
    agreement?.listing_commission_rate == null &&
    agreement?.buyer_commission_rate == null

  const [listingRate, setListingRate] = useState(
    String(
      agreement?.listing_commission_rate ??
        (totalOnly ? agreement!.total_commission_rate : null) ??
        latestNetSheet?.listing_commission_rate ??
        3
    )
  )
  const [buyerRate, setBuyerRate] = useState(
    String(
      agreement?.buyer_commission_rate ??
        (totalOnly ? 0 : null) ??
        latestNetSheet?.buyer_commission_rate ??
        3
    )
  )
  const [closingCosts, setClosingCosts] = useState(
    String(latestNetSheet?.closing_costs ?? "")
  )
  const [mortgagePayoff, setMortgagePayoff] = useState(
    String(latestNetSheet?.mortgage_payoff_amount ?? latestNetSheet?.mortgage_balance ?? 0)
  )
  const [propertyTaxes, setPropertyTaxes] = useState(
    String(latestNetSheet?.property_taxes ?? 0)
  )
  const [hoaFees, setHoaFees] = useState(String(latestNetSheet?.hoa_fees ?? 0))
  const [repairCredits, setRepairCredits] = useState(
    String(latestNetSheet?.repair_credits ?? 0)
  )
  const [sellerConcessions, setSellerConcessions] = useState(
    String(latestNetSheet?.seller_concessions ?? 0)
  )

  const [activeScenario, setActiveScenario] = useState<"recommended" | "quick" | "premium">("recommended")
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  // Portal share state
  const [sharingToPortal, setSharingToPortal] = useState(false)

  // AI explanation state
  const [generatingExplanation, setGeneratingExplanation] = useState(false)
  const [aiExplanationText, setAiExplanationText] = useState<string | null>(null)
  const [explanationModalOpen, setExplanationModalOpen] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)

  function scenarioMultiplier() {
    if (activeScenario === "quick") return 0.95
    if (activeScenario === "premium") return 1.05
    return 1
  }

  const price = Number(salePrice) * scenarioMultiplier() || 0
  // Flat fee is charged as-is; percentage rates only apply when it isn't one.
  const listComm = isFlatFee ? flatAmount : price * (Number(listingRate) / 100)
  const buyerComm = isFlatFee ? 0 : price * (Number(buyerRate) / 100)
  const closing = Number(closingCosts) || price * 0.02
  const payoff = Number(mortgagePayoff) || 0
  const taxes = Number(propertyTaxes) || 0
  const hoa = Number(hoaFees) || 0
  const repairs = Number(repairCredits) || 0
  const concessions = Number(sellerConcessions) || 0
  const totalCosts = listComm + buyerComm + closing + payoff + taxes + hoa + repairs + concessions
  const netProceeds = price - totalCosts

  const isExpired =
    latestNetSheet?.expires_at
      ? new Date(latestNetSheet.expires_at) < new Date()
      : false

  // Current net sheet snapshot for portal/AI actions
  const currentNetSheet = {
    estimatedSalePrice: price,
    mortgagePayoff: payoff,
    agentCommission: listComm + buyerComm,
    closingCosts: closing,
    estimatedNet: netProceeds,
  }

  function handleSave() {
    startTransition(async () => {
      setSavedMsg(null)
      const result = await saveNetSheet({
        listingId: listing.id,
        contactId: listing.seller_contact_id ?? "",
        salePrice: Number(salePrice),
        listingCommissionRate: Number(listingRate),
        buyerCommissionRate: Number(buyerRate),
        closingCosts: Number(closingCosts) || undefined,
        mortgageBalance: Number(mortgagePayoff) || undefined,
        mortgagePayoffAmount: Number(mortgagePayoff) || undefined,
        propertyTaxes: Number(propertyTaxes) || undefined,
        hoaFees: Number(hoaFees) || undefined,
        repairCredits: Number(repairCredits) || undefined,
        sellerConcessions: Number(sellerConcessions) || undefined,
      })
      setSavedMsg(result.success ? "Net sheet saved." : result.error ?? "Save failed.")
    })
  }

  async function handleShareToPortal() {
    if (!listing.seller_contact_id) {
      toast.error("No seller contact linked to this listing")
      return
    }
    setSharingToPortal(true)
    try {
      const result = await shareNetSheetToPortal({
        listingId: listing.id,
        contactId: listing.seller_contact_id,
        netSheetData: currentNetSheet,
      })
      if (result.success) {
        toast.success("Net sheet shared to seller portal")
      } else {
        toast.error(`Could not share: ${result.error}`)
      }
    } finally {
      setSharingToPortal(false)
    }
  }

  async function handleGenerateExplanation() {
    setGeneratingExplanation(true)
    try {
      const explanation = await generateNetSheetExplanation({
        netSheetData: currentNetSheet,
        agentName: agentFirstName,
      })
      setAiExplanationText(explanation)
      setExplanationModalOpen(true)
    } catch {
      toast.error("Failed to generate explanation")
    } finally {
      setGeneratingExplanation(false)
    }
  }

  async function handleCopyExplanation() {
    if (!aiExplanationText) return
    await navigator.clipboard.writeText(aiExplanationText)
    toast.success("Copied to clipboard")
  }

  async function handleSendExplanationToPortal() {
    if (!aiExplanationText || !listing.seller_contact_id) {
      toast.error("No seller contact linked to this listing")
      return
    }
    setSharingToPortal(true)
    try {
      const result = await shareNetSheetToPortal({
        listingId: listing.id,
        contactId: listing.seller_contact_id,
        netSheetData: {
          ...currentNetSheet,
          notes: aiExplanationText,
        },
      })
      if (result.success) {
        toast.success("Explanation shared to seller portal")
        setExplanationModalOpen(false)
      } else {
        toast.error(`Could not share: ${result.error}`)
      }
    } finally {
      setSharingToPortal(false)
    }
  }

  async function handleIncludeInEmailDraft() {
    if (!aiExplanationText) return
    if (!listing.seller_contact_id) {
      // No contact — just copy to clipboard as fallback
      await navigator.clipboard.writeText(aiExplanationText)
      toast.success("Copied — paste into a new email")
      return
    }
    setSavingDraft(true)
    try {
      const result = await saveNetSheetEmailDraft({
        contactId: listing.seller_contact_id,
        listingId: listing.id,
        draftBody: aiExplanationText,
      })
      if (result.success) {
        toast.success("Draft saved to your inbox")
        setExplanationModalOpen(false)
      } else {
        toast.error(`Could not save draft: ${result.error}`)
      }
    } finally {
      setSavingDraft(false)
    }
  }

  return (
    <div className="p-6 space-y-6 pb-20">
      {/* Scenario selector */}
      <div className="flex gap-2">
        {(["recommended", "quick", "premium"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setActiveScenario(s)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium border transition-colors ${
              activeScenario === s
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:border-primary"
            }`}
          >
            {s === "recommended" ? "Recommended" : s === "quick" ? "Quick Sale (-5%)" : "Premium (+5%)"}
          </button>
        ))}
      </div>

      {/* Commission pre-fill notice — fires for a flat fee and a total-only rate too,
          not just an explicit listing-side rate. */}
      {agreement && (isFlatFee || agreement.listing_commission_rate != null || agreement.total_commission_rate != null) && (
        <div className="flex items-center gap-2 text-xs text-blue-700 bg-blue-50 rounded px-3 py-2 border border-blue-200">
          {isFlatFee
            ? `Flat fee of ${fmt(flatAmount)} per Listing Agreement`
            : "Rates pre-filled from Listing Agreement"}
          {agreement.has_commission_adjustment && (
            <Badge className="bg-amber-100 text-amber-800 border-amber-300 ml-1">
              Adjustment applies
            </Badge>
          )}
        </div>
      )}

      {isExpired && (
        <div className="text-xs text-red-700 bg-red-50 rounded px-3 py-2 border border-red-200">
          This net sheet expired on {new Date(latestNetSheet!.expires_at!).toLocaleDateString()}.
          Update values and save to renew.
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Input form */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm font-medium">Inputs</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">Sale Price</Label>
                <Input
                  type="number"
                  value={salePrice}
                  onChange={(e) => setSalePrice(e.target.value)}
                  className="mt-1 h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Mortgage Payoff</Label>
                <Input
                  type="number"
                  value={mortgagePayoff}
                  onChange={(e) => setMortgagePayoff(e.target.value)}
                  className="mt-1 h-8 text-sm"
                />
              </div>
              {/* Percentage inputs are meaningless under a flat fee — editing them
                  would not move the number. Show the agreed amount instead. */}
              {isFlatFee ? (
                <div className="sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">Commission (flat fee per agreement)</Label>
                  <div className="mt-1 h-8 text-sm flex items-center font-medium">{fmt(flatAmount)}</div>
                </div>
              ) : (
                <>
                  <div>
                    <Label className="text-xs text-muted-foreground">Listing Commission %</Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={listingRate}
                      onChange={(e) => setListingRate(e.target.value)}
                      className="mt-1 h-8 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Buyer Commission %</Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={buyerRate}
                      onChange={(e) => setBuyerRate(e.target.value)}
                      className="mt-1 h-8 text-sm"
                    />
                  </div>
                </>
              )}
              <div>
                <Label className="text-xs text-muted-foreground">Closing Costs</Label>
                <Input
                  type="number"
                  placeholder="Default: 2%"
                  value={closingCosts}
                  onChange={(e) => setClosingCosts(e.target.value)}
                  className="mt-1 h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Property Taxes</Label>
                <Input
                  type="number"
                  value={propertyTaxes}
                  onChange={(e) => setPropertyTaxes(e.target.value)}
                  className="mt-1 h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">HOA Fees</Label>
                <Input
                  type="number"
                  value={hoaFees}
                  onChange={(e) => setHoaFees(e.target.value)}
                  className="mt-1 h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Repair Credits</Label>
                <Input
                  type="number"
                  value={repairCredits}
                  onChange={(e) => setRepairCredits(e.target.value)}
                  className="mt-1 h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Seller Concessions</Label>
                <Input
                  type="number"
                  value={sellerConcessions}
                  onChange={(e) => setSellerConcessions(e.target.value)}
                  className="mt-1 h-8 text-sm"
                />
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button size="sm" onClick={handleSave} disabled={isPending}>
                {isPending ? "Saving..." : "Save Net Sheet"}
              </Button>

              <Button
                size="sm"
                variant="outline"
                onClick={handleShareToPortal}
                disabled={sharingToPortal || !listing.seller_contact_id}
                title={!listing.seller_contact_id ? "No seller contact linked to this listing" : undefined}
              >
                {sharingToPortal ? "Sharing..." : "Share to Portal"}
              </Button>

              <Button
                size="sm"
                variant="outline"
                onClick={handleGenerateExplanation}
                disabled={generatingExplanation}
              >
                {generatingExplanation ? "Generating..." : "AI Explanation"}
              </Button>

              {savedMsg && (
                <span className="text-xs text-muted-foreground">{savedMsg}</span>
              )}
            </div>

            {!listing.seller_contact_id && (
              <p className="text-xs text-amber-600">
                Link a seller contact to this listing to enable portal sharing.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Results breakdown */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm font-medium">
              Breakdown
              {activeScenario !== "recommended" && (
                <span className="ml-2 text-xs text-muted-foreground font-normal">
                  {activeScenario === "quick" ? "Quick Sale (-5%)" : "Premium (+5%)"}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-2 text-sm">
            <Row label="Sale Price" value={fmt(price)} highlight />
            <Separator />
            {isFlatFee ? (
              <Row label="Commission (flat fee per agreement)" value={`-${fmt(listComm)}`} negative />
            ) : (
              <>
                <Row label={`Listing Commission (${listingRate}%)`} value={`-${fmt(listComm)}`} negative />
                <Row label={`Buyer Commission (${buyerRate}%)`} value={`-${fmt(buyerComm)}`} negative />
              </>
            )}
            <Row label="Closing Costs" value={`-${fmt(closing)}`} negative />
            {payoff > 0 && <Row label="Mortgage Payoff" value={`-${fmt(payoff)}`} negative />}
            {taxes > 0 && <Row label="Property Taxes" value={`-${fmt(taxes)}`} negative />}
            {hoa > 0 && <Row label="HOA Fees" value={`-${fmt(hoa)}`} negative />}
            {repairs > 0 && <Row label="Repair Credits" value={`-${fmt(repairs)}`} negative />}
            {concessions > 0 && <Row label="Seller Concessions" value={`-${fmt(concessions)}`} negative />}
            <Separator />
            <div className="flex justify-between font-semibold text-base pt-1">
              <span>Net Proceeds</span>
              <span className={netProceeds >= 0 ? "text-green-700" : "text-red-700"}>
                {fmt(netProceeds)}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* AI Explanation Modal */}
      <Dialog open={explanationModalOpen} onOpenChange={setExplanationModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base">AI-Generated Net Sheet Explanation</DialogTitle>
          </DialogHeader>

          {aiExplanationText && (
            <div className="rounded-md border bg-muted/30 p-4 text-sm leading-relaxed text-foreground">
              {aiExplanationText}
            </div>
          )}

          <DialogFooter className="flex flex-wrap gap-2 sm:justify-start">
            <Button size="sm" variant="outline" onClick={handleCopyExplanation}>
              Copy to Clipboard
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleSendExplanationToPortal}
              disabled={sharingToPortal || !listing.seller_contact_id}
              title={!listing.seller_contact_id ? "No seller contact linked" : undefined}
            >
              {sharingToPortal ? "Sending..." : "Send to Portal"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleIncludeInEmailDraft}
              disabled={savingDraft}
            >
              {savingDraft ? "Saving..." : "Include in Email Draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Row({
  label,
  value,
  highlight,
  negative,
}: {
  label: string
  value: string
  highlight?: boolean
  negative?: boolean
}) {
  return (
    <div className="flex justify-between">
      <span className={highlight ? "font-medium text-foreground" : "text-muted-foreground"}>
        {label}
      </span>
      <span className={negative ? "text-red-600" : highlight ? "font-medium text-foreground" : "text-foreground"}>
        {value}
      </span>
    </div>
  )
}
