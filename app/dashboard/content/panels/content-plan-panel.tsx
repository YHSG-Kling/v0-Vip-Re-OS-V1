"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, CalendarDays } from "lucide-react"
import { toast } from "sonner"
import { generateContentPlan } from "@/app/actions/ai-content-generation"

function currentMonthValue() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
}

export function ContentPlanPanel() {
  const [month, setMonth] = useState(currentMonthValue())
  const [plan, setPlan] = useState<any>(null)
  const [scheduled, setScheduled] = useState(0)
  const [isPending, startTransition] = useTransition()

  const handleGenerate = () => {
    startTransition(async () => {
      const [year, m] = month.split("-").map(Number)
      const res = await generateContentPlan({ month: new Date(year, (m || 1) - 1, 1), includeListings: true })
      if (!res.success) {
        setPlan(null)
        toast.error(res.error)
        return
      }
      setPlan(res.data)
      setScheduled(res.scheduled)
      toast.success(`${res.scheduled} entries added to your calendar`)
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <CalendarDays className="h-4 w-4" /> 30-day content plan
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Builds a month of content from your active listings, lead personas and what has performed, then writes
          every entry to your content calendar as a draft.
        </p>
        <div className="flex items-end gap-3">
          <div className="space-y-1.5">
            <Label>Month</Label>
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" />
          </div>
          <Button onClick={handleGenerate} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Build plan
          </Button>
        </div>

        {plan && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="default" className="text-[10px]">
                {scheduled} scheduled
              </Badge>
              {Array.isArray(plan.monthly_themes) &&
                plan.monthly_themes.map((t: string) => (
                  <Badge key={t} variant="outline" className="text-[10px]">
                    {t}
                  </Badge>
                ))}
            </div>

            {Array.isArray(plan.plan) && (
              <div className="divide-y max-h-96 overflow-y-auto">
                {plan.plan.map((item: any, i: number) => (
                  <div key={i} className="py-2 flex items-start justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{item.topic}</p>
                      <p className="text-muted-foreground">{item.reasoning}</p>
                    </div>
                    <div className="shrink-0 text-right text-muted-foreground">
                      <p>{item.date}</p>
                      <p>{item.content_type}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
