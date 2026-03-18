"use client"

import { Card, CardContent } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { ArrowRight, Calendar, CheckCircle2, Clock } from "lucide-react"

interface NextStepCardProps {
  listingStatus: string | null
  hasOffers: boolean
  isUnderContract: boolean
  nextMilestone?: {
    name: string
    date: string | null
    status: string
  } | null
  closeDate: string | null
}

export function NextStepCard({
  listingStatus,
  hasOffers,
  isUnderContract,
  nextMilestone,
  closeDate,
}: NextStepCardProps) {
  // Derive next step based on state
  let nextStep = {
    title: "Continue Showing",
    description: "Your home is being shown to buyers. The right offer could come at any time.",
    timing: "Ongoing",
    whatToExpect: "Your agent will notify you immediately when an offer is received.",
  }

  if (listingStatus === "coming_soon") {
    nextStep = {
      title: "Go Live on Market",
      description: "Your listing will be published and marketing will begin.",
      timing: "Soon",
      whatToExpect: "You'll see increased activity as buyers discover your home.",
    }
  } else if (hasOffers && !isUnderContract) {
    nextStep = {
      title: "Review Offers",
      description: "You have offers to consider. Work with your agent to evaluate each one.",
      timing: "Action needed",
      whatToExpect: "Your agent will walk you through each offer's terms and help you decide.",
    }
  } else if (isUnderContract && nextMilestone) {
    const milestoneNames: Record<string, { title: string; description: string; whatToExpect: string }> = {
      inspection: {
        title: "Home Inspection",
        description: "The buyer will have the home professionally inspected.",
        whatToExpect: "The inspector may find items to negotiate. Your agent will guide you through any requests.",
      },
      appraisal: {
        title: "Appraisal",
        description: "The lender will have the home appraised to confirm value.",
        whatToExpect: "If the appraisal comes in at or above the offer price, you're on track. If not, your agent will help negotiate.",
      },
      final_walkthrough: {
        title: "Final Walkthrough",
        description: "The buyer will do a final check of the property before closing.",
        whatToExpect: "Ensure the home is in the agreed-upon condition. This is usually straightforward.",
      },
      closing: {
        title: "Closing Day",
        description: "Sign the final paperwork and hand over the keys.",
        whatToExpect: "Bring valid ID. The closing typically takes 1-2 hours. Congratulations will be in order!",
      },
    }

    const milestoneKey = nextMilestone.name.toLowerCase().replace(/_/g, "").replace(/ /g, "")
    const milestoneInfo = Object.entries(milestoneNames).find(([key]) => milestoneKey.includes(key))?.[1]

    if (milestoneInfo) {
      nextStep = {
        title: milestoneInfo.title,
        description: milestoneInfo.description,
        timing: nextMilestone.date
          ? new Date(nextMilestone.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
          : "Scheduled",
        whatToExpect: milestoneInfo.whatToExpect,
      }
    }
  } else if (isUnderContract && closeDate) {
    nextStep = {
      title: "Closing Day",
      description: "You're on track to close. Final preparations are underway.",
      timing: new Date(closeDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      whatToExpect: "Your agent and title company will coordinate the final details.",
    }
  } else if (listingStatus === "sold" || listingStatus === "closed") {
    nextStep = {
      title: "Sale Complete",
      description: "Your home has been sold. Congratulations!",
      timing: "Done",
      whatToExpect: "Your agent remains available for any questions about your next chapter.",
    }
  }

  const isDone = listingStatus === "sold" || listingStatus === "closed"

  return (
    <Card className="border-l-4 border-l-blue-500">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-1">Next Step</p>
            <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
              {nextStep.title}
              {isDone && <CheckCircle2 className="h-5 w-5 text-green-600" />}
            </h3>
          </div>
          <Badge variant="outline" className="text-xs flex items-center gap-1">
            {isDone ? <CheckCircle2 className="h-3 w-3" /> : <Calendar className="h-3 w-3" />}
            {nextStep.timing}
          </Badge>
        </div>

        <p className="text-sm text-muted-foreground">{nextStep.description}</p>

        <div className="pt-2 border-t">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">What to Expect</p>
          <p className="text-sm text-muted-foreground">{nextStep.whatToExpect}</p>
        </div>
      </CardContent>
    </Card>
  )
}
