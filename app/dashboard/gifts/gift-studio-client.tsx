"use client"

/**
 * THE GIFT STUDIO — selection AND ordering inside one command-center
 * window. Left: recent closings still ungifted (the queue). Right: the
 * AI's deal-grounded selections for the chosen client — each card carries
 * WHY it fits, the engraving line ALREADY WRITTEN from their closed
 * deal's address, the budget band, and one-click ordering (the order +
 * purchase task are created in-window; the buy click on the pre-scoped
 * search is the only external hop).
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Gift, Loader2, Check } from "lucide-react"
import {
  getGiftStudioAction,
  orderGiftSelectionAction,
  type GiftableClosing,
} from "@/app/actions/gift-studio"
import type { GiftSelection } from "@/lib/gifting/gift-studio"

export function GiftStudioClient({
  initialClosings,
  initialSelections,
  initialSelectedId,
}: {
  initialClosings: GiftableClosing[]
  initialSelections: GiftSelection[]
  initialSelectedId: string | null
}) {
  const [closings, setClosings] = useState(initialClosings)
  const [selections, setSelections] = useState(initialSelections)
  const [selectedId, setSelectedId] = useState(initialSelectedId)
  const [busy, setBusy] = useState<string | null>(null)
  const [ordered, setOrdered] = useState<Set<string>>(new Set())
  const [, startTransition] = useTransition()

  const pick = (contactId: string) => {
    setSelectedId(contactId)
    setBusy("load")
    startTransition(async () => {
      try {
        const r = await getGiftStudioAction({ contactId })
        if (r.ok) setSelections(r.selections)
      } finally {
        setBusy(null)
      }
    })
  }

  const order = (s: GiftSelection) => {
    if (!selectedId) return
    setBusy(s.key)
    startTransition(async () => {
      try {
        const r = await orderGiftSelectionAction({ contactId: selectedId, selection: s })
        if (r.ok) {
          setOrdered((prev) => new Set(prev).add(s.key))
          setClosings((prev) => prev.filter((c) => c.contactId !== selectedId || prev.length <= 1))
        }
      } finally {
        setBusy(null)
      }
    })
  }

  const selected = closings.find((c) => c.contactId === selectedId)

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Gift className="h-4 w-4 text-rose-600" /> Waiting on a gift
          </CardTitle>
        </CardHeader>
        <CardContent>
          {closings.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Every recent closing has been gifted. 🎉</p>
          ) : (
            <ul className="space-y-1">
              {closings.map((c) => (
                <li key={c.contactId}>
                  <button
                    onClick={() => pick(c.contactId)}
                    className={`w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/50 ${c.contactId === selectedId ? "border-rose-300 bg-rose-50/50" : ""}`}
                  >
                    <span className="font-medium">{c.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {c.address ?? "—"}{c.closeDate ? ` · closed ${new Date(c.closeDate).toLocaleDateString()}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="lg:col-span-2 space-y-3">
        {selected && (
          <p className="text-sm text-muted-foreground">
            The team's picks for <span className="font-medium text-foreground">{selected.name}</span> — personalized from their deal, ready to order.
          </p>
        )}
        {busy === "load" ? (
          <div className="py-10 text-center text-muted-foreground"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
        ) : selections.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Pick a closing on the left and the studio composes the gift.</p>
        ) : (
          selections.map((s) => (
            <Card key={s.key}>
              <CardContent className="pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{s.title}</span>
                  <Badge className="bg-rose-100 text-rose-800 text-[10px]">${s.priceBand[0]}–${s.priceBand[1]}</Badge>
                  {s.personalization && <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">personalized from the deal</Badge>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{s.whyThisFits}</p>
                {s.personalization && (
                  <p className="mt-1 rounded bg-muted/40 px-2 py-1 font-mono text-xs">{s.personalization}</p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button size="sm" className="h-7 text-xs" disabled={busy !== null || ordered.has(s.key)} onClick={() => order(s)}>
                    {busy === s.key ? <Loader2 className="h-3 w-3 animate-spin" /> : ordered.has(s.key) ? <Check className="h-3 w-3" /> : null}
                    {ordered.has(s.key) ? "Order created" : "Create the order"}
                  </Button>
                  <a href={s.etsyUrl} target="_blank" rel="noreferrer" className="text-xs text-indigo-700 hover:underline">Buy on Etsy →</a>
                  <a href={s.amazonUrl} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:underline">Amazon</a>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  )
}
