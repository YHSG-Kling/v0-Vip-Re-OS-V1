"use client"

import { useTransition, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Loader2, Sparkles, CheckCircle2 } from "lucide-react"
import { massGenerateCMAs } from "@/app/actions/ai-predictions"
import { toast } from "sonner"

interface MassCMAButtonProps {
  // agentId is no longer used — massGenerateCMAs resolves identity server-side
  agentId?: string
}

export function MassCMAButton({ agentId: _agentId }: MassCMAButtonProps) {
  const [isPending, startTransition] = useTransition()
  const [result, setResult] = useState<{ totalCMAsGenerated: number; significantOpportunities: number; message?: string } | null>(null)
  const [open, setOpen] = useState(false)

  function handleScan() {
    startTransition(async () => {
      try {
        const res = await massGenerateCMAs()
        setResult(res)
        setOpen(true)
        if (res.significantOpportunities > 0) {
          toast.success(`Found ${res.significantOpportunities} listing opportunit${res.significantOpportunities !== 1 ? "ies" : "y"}`)
        } else {
          toast.info("Scan complete — no new opportunities found")
        }
      } catch {
        toast.error("CMA scan failed")
      }
    })
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="gap-2 text-primary min-h-[44px] sm:min-h-0"
        onClick={handleScan}
        disabled={isPending}
      >
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        Scan Opportunities
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              CMA Opportunity Scan Complete
            </DialogTitle>
          </DialogHeader>
          {result && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div className="text-center p-3 rounded-lg bg-muted">
                  <p className="text-2xl font-bold">{result.totalCMAsGenerated}</p>
                  <p className="text-xs text-muted-foreground mt-1">CMAs Generated</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-green-50 border border-green-200">
                  <p className="text-2xl font-bold text-green-700">{result.significantOpportunities}</p>
                  <p className="text-xs text-green-600 mt-1">Opportunities</p>
                </div>
              </div>
              {result.message && (
                <p className="text-muted-foreground text-xs">{result.message}</p>
              )}
              <p className="text-xs text-muted-foreground">
                View generated CMAs in the CMA History or contact your lifetime customers with equity buildup.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
