"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { TrendingDown, Loader2, Sparkles, Mail, Megaphone } from "lucide-react"
import { toast } from "sonner"
import { handlePriceReduction } from "@/app/actions/listing-lifecycle"
// THE PRICE WRITE ITSELF. See the note in handleSubmit: this sheet used to call
// handlePriceReduction alone, which only raises the marketing follow-up TASK —
// listings.list_price was never touched, so "Price reduced to $X" was a toast
// over an unchanged number.
import { updateListing } from "@/app/actions/listings"
import { createDirectMailCampaign } from "@/app/actions/ai-direct-mail"
import { launchPriceReductionCampaign } from "@/app/actions/price-reduction-campaign"

interface Props {
  listingId: string
  currentPrice: number
  listingAddress: string
  agentId: string
  brokerageId: string
  status: string | null
}

export function PriceReductionSheet({
  listingId,
  currentPrice,
  listingAddress,
  agentId,
  brokerageId,
  status,
}: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [newPrice, setNewPrice] = useState("")
  const [note, setNote] = useState("")
  const [isPending, startTransition] = useTransition()
  const [launchMailCampaign, setLaunchMailCampaign] = useState(true)
  // Public-facing ad + promo video is OPT-IN (default off): advertising a price drop
  // is sensitive and not every agent/seller wants it broadcast. When on, the creative
  // lands in the Command Center approval queue — nothing runs without a human release.
  const [launchAdCampaign, setLaunchAdCampaign] = useState(false)

  if (status !== "active") return null

  function handleSubmit() {
    const price = parseFloat(newPrice.replace(/[^0-9.]/g, ""))
    if (!price || price >= currentPrice) {
      toast.error("New price must be lower than current price")
      return
    }

    startTransition(async () => {
      // ── STEP 1: ACTUALLY REDUCE THE PRICE ──────────────────────────────────
      //
      // This step did not exist. The sheet called handlePriceReduction and
      // toasted "Price reduced to $X" on it — but that action is the
      // ORCHESTRATOR EVENT handler for `listing.price_reduction` and its whole
      // body raises one task ("Update all marketing with new price"). It never
      // wrote listings.list_price. So the seller's price did not move, the
      // marketing tier was never re-assigned against the new number, and the
      // seller portal's price history stayed empty — while the agent was told
      // the reduction had happened and a direct-mail campaign went out
      // advertising a price the listing did not have.
      //
      // updateListing is the writer for all three: the price, the
      // listing_price_changes ledger the seller portal renders, and the tier
      // re-assignment. The tenant, the ownership check and the act-as read-only
      // refusal are all resolved from the SESSION inside it — this component
      // supplies the listing id and the number, nothing else.
      const written = (await updateListing(listingId, { list_price: price })) as {
        success: boolean
        error?: string
      }
      if (!written?.success) {
        toast.error(written?.error ?? "The price was not changed.")
        return
      }

      toast.success(`Price reduced to $${price.toLocaleString()}`)

      // ── STEP 2: the marketing follow-up task ───────────────────────────────
      //
      // The payload key was `listingId`; the handler destructures `listing_id`,
      // so the lookup ran on `undefined` and every call came back "Listing has
      // no agent/brokerage — tasks not created". The task this sheet promises
      // has therefore never been created for anyone. Fixed to the shape the
      // handler and the orchestrator route both use.
      //
      // The price is already written by here, so a failure is reported as what
      // it is — a missing follow-up task, not a failed reduction.
      const res = await handlePriceReduction({
        listing_id: listingId,
        newPrice: price,
        previousPrice: currentPrice,
        reducedBy: currentPrice - price,
        reducedByPercent: ((currentPrice - price) / currentPrice) * 100,
        agentId,
        brokerageId,
        note,
      })
      if ((res as any)?.success === false) {
        toast.error(
          `Price reduced, but the marketing follow-up task was not created: ${
            (res as any).error ?? "unknown error"
          }`,
        )
      }

      if (launchMailCampaign) {
        try {
          await createDirectMailCampaign({
            agentId,
            brokerageId,
            campaignName: `Price Reduction — ${listingAddress}`,
            targetAudience: "local_buyers_investors",
            mailingType: "postcard",
            designTemplate: `Price Reduction: $${price.toLocaleString()} — ${listingAddress}. ${note}`,
            trackingEnabled: true,
            appOrigin: typeof window !== "undefined" ? window.location.origin : "",
          })
          toast.success("Price reduction direct mail campaign launched")
        } catch {
          toast.error("Mail campaign failed — price still reduced")
        }
      }

      if (launchAdCampaign) {
        try {
          const ad = await launchPriceReductionCampaign(listingId)
          if (ad.ok) toast.success("Price-improved ad + video sent to your approval queue")
          else toast.error(ad.error ?? "Ad campaign failed — price still reduced")
        } catch {
          toast.error("Ad campaign failed — price still reduced")
        }
      }

      setOpen(false)
      setNewPrice("")
      setNote("")
      // The list price on this page (and the launch/marketing panels computed
      // from it) is server-rendered — without this the agent closes the sheet
      // and still sees the old number, which is the same lie the missing write
      // was telling.
      router.refresh()
    })
  }

  const priceNum = parseFloat(newPrice.replace(/[^0-9.]/g, ""))
  const reduction = priceNum > 0 && priceNum < currentPrice ? currentPrice - priceNum : null
  const reductionPct =
    reduction != null ? ((reduction / currentPrice) * 100).toFixed(1) : null

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-full gap-1.5 text-amber-700 border-amber-300 hover:bg-amber-50"
        onClick={() => setOpen(true)}
      >
        <TrendingDown className="h-3.5 w-3.5" />
        Reduce Price
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <TrendingDown className="h-5 w-5 text-amber-600" />
              Price Reduction
            </SheetTitle>
            <SheetDescription>
              {listingAddress} · Current price: ${currentPrice.toLocaleString()}
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-5 py-4">
            <div className="space-y-1.5">
              <Label>New List Price</Label>
              <Input
                placeholder="e.g. 485000"
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                type="number"
              />
              {reduction != null && (
                <div className="flex gap-2 mt-1">
                  <Badge variant="outline" className="text-amber-700 border-amber-200">
                    −${reduction.toLocaleString()} ({reductionPct}%)
                  </Badge>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Note for seller</Label>
              <Textarea
                placeholder="e.g. Market feedback after 21 DOM suggests adjusting price to increase showing activity."
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
              />
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={launchMailCampaign}
                onChange={(e) => setLaunchMailCampaign(e.target.checked)}
              />
              <div>
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5 text-blue-500" />
                  Auto-launch price reduction direct mail campaign
                </p>
                <p className="text-xs text-muted-foreground">
                  Notifies local buyers &amp; investors with the new price
                </p>
              </div>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={launchAdCampaign}
                onChange={(e) => setLaunchAdCampaign(e.target.checked)}
              />
              <div>
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <Megaphone className="h-3.5 w-3.5 text-purple-500" />
                  Create a &quot;Price Improved&quot; ad + promo video
                </p>
                <p className="text-xs text-muted-foreground">
                  Off by default. Drafts a paid-ad creative + avatar video that land in
                  your Command Center approval queue — nothing goes public until you release it.
                </p>
              </div>
            </label>
          </div>

          <SheetFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isPending || !newPrice}>
              {isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <Sparkles className="h-4 w-4 mr-1.5" />
              )}
              Reduce Price
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}
