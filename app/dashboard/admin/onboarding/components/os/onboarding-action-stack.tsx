"use client"

// Quick Actions. Every button here used to be decoration — three <Button>s with
// no onClick at all, including the "N Stalled Agents · Need intervention" one,
// which additionally could never render because the stall count was read from a
// status value the CHECK constraint forbids.
//
// Each button now goes somewhere real: the two batch entries hand their agent
// selection to the Actions tab, and curriculum authoring scrolls to the editor
// that already lives on this page. "Create Training Campaign" is gone rather
// than wired — no campaign backend exists behind it, and the curriculum editor
// is the real authoring surface.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { AlertTriangle, Send, Zap } from "lucide-react"

interface OnboardingActionStackProps {
  stallCount: number
  /** Agent ids currently stalled — handed to the batch panel as a preselection. */
  stalledAgentIds: string[]
  /** Switch to the Actions tab, optionally preselecting agents there. */
  onOpenBatchActions: (preselectAgentIds?: string[]) => void
}

export function OnboardingActionStack({
  stallCount,
  stalledAgentIds,
  onOpenBatchActions,
}: OnboardingActionStackProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quick Actions</CardTitle>
        <CardDescription>Common onboarding operations</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {stallCount > 0 && (
          <Button
            variant="outline"
            className="w-full justify-start gap-2 h-auto py-3"
            onClick={() => onOpenBatchActions(stalledAgentIds)}
          >
            <AlertTriangle className="h-4 w-4 text-red-600" />
            <div className="text-left">
              <div className="font-medium">
                {stallCount} Stalled Agent{stallCount === 1 ? "" : "s"}
              </div>
              <div className="text-xs text-muted-foreground">
                No progress in over a week — nudge them
              </div>
            </div>
          </Button>
        )}
        <Button className="w-full justify-start gap-2" onClick={() => onOpenBatchActions()}>
          <Send className="h-4 w-4" />
          Send Batch Reminders
        </Button>
        <Button
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={() =>
            document
              .getElementById("onboarding-curriculum")
              ?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
        >
          <Zap className="h-4 w-4" />
          Edit Onboarding Curriculum
        </Button>
      </CardContent>
    </Card>
  )
}
