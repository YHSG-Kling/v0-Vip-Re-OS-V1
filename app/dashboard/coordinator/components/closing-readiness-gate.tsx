"use client"

import { useState, useTransition } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { canProceedToClosingPrep } from "@/app/actions/transaction-compliance"
import { NextStepRouter } from "@/app/components/action-framework"
import {
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  ShieldCheck,
} from "lucide-react"

interface ClosingReadinessGateProps {
  transactionId: string
  transactionStage: string
  brokerageId?: string
}

interface ReadinessResult {
  canProceed: boolean
  blockers: string[]
  missingItems: string[]
}

export function ClosingReadinessGate({
  transactionId,
  transactionStage,
  brokerageId = "",
}: ClosingReadinessGateProps) {
  const [result, setResult] = useState<ReadinessResult | null>(null)
  const [blockersOpen, setBlockersOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  function handleCheck() {
    startTransition(async () => {
      const res = await canProceedToClosingPrep(transactionId, brokerageId)
      const normalized: ReadinessResult = {
        canProceed: res.allowed,
        blockers: res.blockers,
        missingItems: [],
      }
      setResult(normalized)
      if (!normalized.canProceed) setBlockersOpen(true)
    })
  }

  if (!result) {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={handleCheck}
        disabled={isPending}
        className="text-xs h-7"
      >
        {isPending ? (
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
        ) : (
          <ShieldCheck className="h-3 w-3 mr-1" />
        )}
        Check Closing Readiness
      </Button>
    )
  }

  if (result.canProceed) {
    return (
      <Badge className="bg-emerald-500 text-white gap-1 text-xs">
        <CheckCircle2 className="h-3 w-3" />
        Ready to Close
      </Badge>
    )
  }

  const totalIssues = result.blockers.length + result.missingItems.length

  return (
    <Collapsible open={blockersOpen} onOpenChange={setBlockersOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex items-center gap-1">
          <Badge variant="destructive" className="gap-1 text-xs cursor-pointer">
            <XCircle className="h-3 w-3" />
            Blocked — {totalIssues} item{totalIssues !== 1 ? "s" : ""}
            {blockersOpen ? (
              <ChevronDown className="h-3 w-3 ml-1" />
            ) : (
              <ChevronRight className="h-3 w-3 ml-1" />
            )}
          </Badge>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-1">
        {result.blockers.map((blocker, i) => (
          <div key={i} className="flex items-start justify-between gap-2 bg-red-50 border border-red-100 rounded p-2 text-xs">
            <span className="text-red-700 leading-snug">{blocker}</span>
            <NextStepRouter
              context={{ type: "transaction", id: transactionId, stage: transactionStage }}
              size="sm"
            />
          </div>
        ))}
        {result.missingItems.map((item, i) => (
          <div key={i} className="flex items-start justify-between gap-2 bg-amber-50 border border-amber-100 rounded p-2 text-xs">
            <span className="text-amber-700 leading-snug">{item}</span>
            <NextStepRouter
              context={{ type: "compliance", id: transactionId, stage: transactionStage }}
              size="sm"
            />
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}
