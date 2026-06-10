"use client"

import { useState, useTransition } from "react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Check, X, ShieldCheck } from "lucide-react"
import { approveAgentAction, rejectAgentAction } from "@/app/actions/command-center"

interface Item {
  id: string
  managerLabel: string
  audience: string
  channel: string
  subject: string | null
  preview: string
  ageHours: number
  slaLevel: "ok" | "due" | "breached"
}

function slaBadge(level: Item["slaLevel"], ageHours: number) {
  const tone = level === "breached" ? "bg-red-100 text-red-800" : level === "due" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"
  const label = level === "breached" ? "overdue" : level === "due" ? "due" : "fresh"
  return <Badge className={`text-[11px] ${tone}`}>{label} · {Math.round(ageHours)}h</Badge>
}

export function MobileApprovalsClient({ initialItems, counts }: { initialItems: Item[]; counts: { total: number; breached: number; due: number } }) {
  const [items, setItems] = useState<Item[]>(initialItems)
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function act(id: string, kind: "approve" | "reject") {
    setBusyId(id); setError(null)
    startTransition(async () => {
      try {
        const res = kind === "approve"
          ? await approveAgentAction({ queue: "client_message", actionId: id })
          : await rejectAgentAction({ queue: "client_message", actionId: id })
        if ((res as { ok?: boolean; success?: boolean; error?: string })?.error) {
          setError((res as { error: string }).error)
        } else {
          setItems((prev) => prev.filter((i) => i.id !== id))  // drop the actioned card
        }
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusyId(null)
      }
    })
  }

  return (
    <div className="px-4 pt-4 pb-24 space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-green-600" /> Approvals</h1>
        <div className="text-xs text-muted-foreground">
          {counts.breached > 0 && <span className="text-red-700 font-medium">{counts.breached} overdue · </span>}
          {items.length} pending
        </div>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</div>}

      {items.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">All caught up — nothing awaiting your approval.</Card>
      ) : (
        items.map((item) => (
          <Card key={item.id} className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Badge className="bg-slate-900 text-white text-[11px]">{item.managerLabel}</Badge>
              {slaBadge(item.slaLevel, item.ageHours)}
            </div>
            {item.subject && <p className="text-sm font-medium">{item.subject}</p>}
            <p className="text-sm text-muted-foreground leading-snug">{item.preview}</p>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="capitalize">{item.audience}</span> · <span>{item.channel}</span>
            </div>
            <div className="flex gap-2 pt-1">
              <Button size="sm" className="flex-1 bg-green-600 hover:bg-green-700" disabled={pending && busyId === item.id} onClick={() => act(item.id, "approve")}>
                <Check className="h-4 w-4 mr-1" /> Approve &amp; send
              </Button>
              <Button size="sm" variant="outline" className="flex-1" disabled={pending && busyId === item.id} onClick={() => act(item.id, "reject")}>
                <X className="h-4 w-4 mr-1" /> Reject
              </Button>
            </div>
          </Card>
        ))
      )}
    </div>
  )
}
