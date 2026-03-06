"use client"

import { useState, useTransition } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { sendCounterOffer } from "@/app/actions/seller-offers"
import { toast } from "@/hooks/use-toast"
import { Loader2 } from "lucide-react"

interface Offer {
  id: string
  offer_number: string | null
  offer_price: number
  contingencies: string[] | null
  current_round: number | null
}

interface Props {
  offer: Offer
  listingId: string
  brokerageId: string
  agentUserId: string
  onClose: () => void
  onSuccess: (counter: unknown) => void
}

export function CounterOfferSlideOver({ offer, listingId, brokerageId, agentUserId, onClose, onSuccess }: Props) {
  const [counterPrice, setCounterPrice] = useState(offer.offer_price.toString())
  const [deadline, setDeadline] = useState(() => {
    const d = new Date(Date.now() + 48 * 60 * 60 * 1000)
    return d.toISOString().slice(0, 16)
  })
  const [notes, setNotes] = useState("")
  const [isPending, startTransition] = useTransition()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const price = parseFloat(counterPrice.replace(/[^0-9.]/g, ""))
    if (isNaN(price) || price <= 0) {
      toast({ title: "Invalid counter price", variant: "destructive" })
      return
    }

    startTransition(async () => {
      const result = await sendCounterOffer({
        parentOfferId: offer.id,
        listingId,
        brokerageId,
        agentUserId,
        counterPrice: price,
        responseDeadline: new Date(deadline).toISOString(),
        notes: notes || undefined,
      })

      if (result.success) {
        toast({ title: "Counter offer sent" })
        onSuccess({ id: result.counterId, offer_price: price, offer_type: "counter" })
      } else {
        toast({ title: "Failed to send counter", description: result.error, variant: "destructive" })
      }
    })
  }

  return (
    <Sheet open onOpenChange={onClose}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Send Counter Offer</SheetTitle>
          <SheetDescription>
            Responding to {offer.offer_number ?? `Offer #${offer.id.slice(0, 8)}`} &middot; Round{" "}
            {(offer.current_round ?? 1) + 1}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5 mt-6">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="counter-price">Counter Price ($)</Label>
            <Input
              id="counter-price"
              value={counterPrice}
              onChange={(e) => setCounterPrice(e.target.value)}
              placeholder="e.g. 525000"
              required
            />
            <p className="text-xs text-muted-foreground">
              Original offer: ${offer.offer_price.toLocaleString()}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="counter-deadline">Response Deadline</Label>
            <Input
              id="counter-deadline"
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="counter-notes">Notes (optional)</Label>
            <Textarea
              id="counter-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Include any contingency changes or special terms..."
              rows={4}
            />
          </div>

          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={isPending} className="flex-1">
              {isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Send Counter
            </Button>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
