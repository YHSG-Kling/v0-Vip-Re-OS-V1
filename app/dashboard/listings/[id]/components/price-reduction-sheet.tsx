"use client"

import { useState, useTransition } from "react"
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
import { TrendingDown, Loader2, Sparkles, Mail } from "lucide-react"
import { toast } from "sonner"
import { handlePriceReduction } from "@/app/actions/listing-lifecycle"
import { createDirectMailCampaign } from "@/app/actions/ai-direct-mail"

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
  const [open, setOpen] = useState(false)
  const [newPrice, setNewPrice] = useState("")
  const [note, setNote] = useState("")
  const [isPending, startTransition] = useTransition()
  const [launchMailCampaign, setLaunchMailCampaign] = useState(true)

  if (status !== "active") return null

  function handleSubmit() {
    const price = parseFloat(newPrice.replace(/[^0-9.]/g, ""))
    if (!price || price >= currentPrice) {
      toast.error("New price must be lower than current price")
      return
    }

    startTransition(async () => {
      const res = await handlePriceReduction({
        listingId,
        newPrice: price,
        previousPrice: currentPrice,
        reducedBy: currentPrice - price,
        reducedByPercent: ((currentPrice - price) / currentPrice) * 100,
        agentId,
        brokerageId,
        note,
      })

      if ((res as any)?.success === false) {
        toast.error((res as any).error ?? "Price reduction failed")
        return
      }

      toast.success(`Price reduced to $${price.toLocaleString()}`)

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

      setOpen(false)
      setNewPrice("")
      setNote("")
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
