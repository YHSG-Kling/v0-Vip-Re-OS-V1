"use client"

/**
 * DEAL CONTINUITY RECEIPT (client portal) — the trust receipt: the OS proves
 * the deal is coherent, in the client's language. Rendered on the portal
 * transaction page; the receipt is computed by running the REAL per-deal
 * checks at read time, so "verified just now" is literally true. Shows
 * nothing when the check can't run — never a hollow badge.
 */

import { useEffect, useState } from "react"
import { ShieldCheck, Wrench, Eye } from "lucide-react"
import { getContinuityReceipt } from "@/app/actions/continuity-receipt"
import type { ContinuityReceipt } from "@/lib/kernel/continuity-receipt"
import { cn } from "@/lib/utils"

export function ContinuityReceiptCard({ contactId, transactionId }: { contactId: string; transactionId: string }) {
  const [receipt, setReceipt] = useState<ContinuityReceipt | null>(null)
  useEffect(() => {
    getContinuityReceipt({ contactId, transactionId })
      .then((r) => { if (r.success) setReceipt(r.receipt) })
      .catch(() => {})
  }, [contactId, transactionId])

  if (!receipt) return null
  const Icon = receipt.status === "attention" ? Eye : receipt.status === "repaired" ? Wrench : ShieldCheck
  return (
    <div className={cn(
      "flex items-start gap-3 rounded-lg border p-3",
      receipt.status === "attention" ? "border-amber-200 bg-amber-50/50" : "border-emerald-200 bg-emerald-50/50",
    )}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", receipt.status === "attention" ? "text-amber-600" : "text-emerald-600")} />
      <div className="min-w-0">
        <p className="text-sm font-medium">{receipt.line}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{receipt.subline}</p>
      </div>
    </div>
  )
}
