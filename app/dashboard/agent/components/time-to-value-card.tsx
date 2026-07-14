"use client"

/**
 * TIME-TO-VALUE CARD (shine #8) — the agent's own "hours your AI team saved
 * you" tile. Adoption story, benchmarked, methodology one tap away. Renders
 * always (a zero shows the fastest win), best-effort.
 */

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Clock, ChevronDown } from "lucide-react"
import { getMyTimeToValue } from "@/app/actions/time-to-value"
import type { TimeToValueRead } from "@/lib/intelligence/time-to-value-radar"

const TONE: Record<string, string> = {
  ahead: "border-emerald-300 bg-emerald-50/60 dark:bg-emerald-950/20",
  on_track: "border-blue-200 bg-blue-50/60 dark:bg-blue-950/20",
  behind: "border-amber-200 bg-amber-50/60 dark:bg-amber-950/20",
}

export function TimeToValueCard() {
  const [data, setData] = useState<{ read: TimeToValueRead; line: string } | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    getMyTimeToValue().then((r) => { if (r.success) setData({ read: r.read, line: r.line }) }).catch(() => {})
  }, [])

  if (!data) return null
  return (
    <Card className={TONE[data.read.standing] ?? ""}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Clock className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm">{data.line}</p>
            <button
              onClick={() => setOpen((v) => !v)}
              className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              How this is measured <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
            {open && <p className="mt-2 text-xs text-muted-foreground">{data.read.methodology}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
