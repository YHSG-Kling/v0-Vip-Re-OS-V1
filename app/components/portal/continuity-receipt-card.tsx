"use client"

/**
 * DEAL CONTINUITY RECEIPT (client portal) — the trust receipt: the OS proves
 * the deal is coherent, in the client's language. Rendered on the portal
 * transaction page; the receipt is computed by running the REAL per-deal
 * checks at read time, so "verified just now" is literally true. Shows
 * nothing when the check can't run — never a hollow badge.
 */

import { useEffect, useState } from "react"
import { ShieldCheck, Wrench, Eye, CheckCircle2, CircleAlert, ChevronDown, ChevronUp } from "lucide-react"
import { getContinuityReceipt } from "@/app/actions/continuity-receipt"
import type { ContinuityReceipt } from "@/lib/kernel/continuity-receipt"
import { cn } from "@/lib/utils"

export function ContinuityReceiptCard({ contactId, transactionId }: { contactId: string; transactionId: string }) {
  const [receipt, setReceipt] = useState<ContinuityReceipt | null>(null)
  const [showTwin, setShowTwin] = useState(false)
  useEffect(() => {
    getContinuityReceipt({ contactId, transactionId })
      .then((r) => { if (r.success) setReceipt(r.receipt) })
      .catch(() => {})
  }, [contactId, transactionId])

  if (!receipt) return null
  const Icon = receipt.status === "attention" ? Eye : receipt.status === "repaired" ? Wrench : ShieldCheck
  return (
    <div className={cn(
      "rounded-lg border p-3",
      receipt.status === "attention" ? "border-amber-200 bg-amber-50/50" : "border-emerald-200 bg-emerald-50/50",
    )}>
      <div className="flex items-start gap-3">
        <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", receipt.status === "attention" ? "text-amber-600" : "text-emerald-600")} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{receipt.line}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{receipt.subline}</p>
        </div>
      </div>
      {receipt.twin.length > 0 && (
        <div className="mt-2 pl-7">
          <button
            type="button"
            onClick={() => setShowTwin((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {showTwin ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            See what was checked
          </button>
          {showTwin && (
            <ul className="mt-1.5 space-y-1">
              {receipt.twin.map((step) => (
                <li key={step.key} className="flex items-start gap-2 text-xs">
                  {step.ok
                    ? <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                    : <CircleAlert className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />}
                  <span>
                    <span className="font-medium">{step.label}</span>
                    <span className="text-muted-foreground"> — {step.ok ? step.expected : "being brought back in line"}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
