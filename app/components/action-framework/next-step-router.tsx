"use client"

import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface NextStepContext {
  type: "transaction" | "contact" | "listing" | "lead" | "campaign" | "workflow" | "compliance"
  id?: string
  stage?: string
  role?: string
}

interface NextStepRouterProps {
  context: NextStepContext
  size?: "sm" | "md"
}

interface NextStepResult {
  label: string
  href: string
  explanation: string
}

function resolveNextStep(context: NextStepContext): NextStepResult {
  const { type, id, stage, role } = context

  switch (type) {
    case "transaction":
      if (stage === "under_contract") {
        return {
          label: "Review Documents",
          href: id ? `/dashboard/transactions/${id}` : "/dashboard/transactions",
          explanation: "Documents need review before next milestone",
        }
      }
      if (stage === "closing_prep") {
        return {
          label: "Check Closing Readiness",
          href: "/dashboard/coordinator",
          explanation: "Verify all closing requirements are met",
        }
      }
      return {
        label: "View Transaction",
        href: id ? `/dashboard/transactions/${id}` : "/dashboard/transactions",
        explanation: "Continue managing this transaction",
      }

    case "contact":
      if (role === "buyer") {
        if (stage === "BUYER_TOURING") {
          return {
            label: "Plan Tours",
            href: id ? `/contacts/${id}/tours` : "/dashboard/buyers",
            explanation: "Schedule property tours for this buyer",
          }
        }
        if (stage === "BUYER_OFFER_ELIGIBLE") {
          return {
            label: "Start Offer",
            href: id ? `/contacts/${id}/offers/new` : "/dashboard/buyers",
            explanation: "Buyer is ready to make an offer",
          }
        }
      }
      return {
        label: "View Contact",
        href: id ? `/crm?contact=${id}` : "/crm",
        explanation: "Continue working with this contact",
      }

    case "listing":
      if (stage === "active") {
        return {
          label: "Seller Command Center",
          href: id ? `/dashboard/listings/${id}` : "/dashboard/listings",
          explanation: "Manage this active listing",
        }
      }
      return {
        label: "View Listing",
        href: id ? `/dashboard/listings/${id}` : "/dashboard/listings",
        explanation: "Review listing details and status",
      }

    case "lead":
      if (stage === "qualified") {
        return {
          label: "Convert to Contact",
          href: "/crm",
          explanation: "This lead is qualified and ready to convert",
        }
      }
      return {
        label: "View Lead",
        href: "/leads",
        explanation: "Continue nurturing this lead",
      }

    case "campaign":
      if (stage === "draft") {
        return {
          label: "Launch Campaign",
          href: "/dashboard/campaigns",
          explanation: "Finalize and launch this campaign",
        }
      }
      return {
        label: "View Campaign",
        href: "/dashboard/campaigns",
        explanation: "Monitor campaign performance",
      }

    case "workflow":
      if (stage === "failed") {
        return {
          label: "Fix Automation",
          href: "/workflows",
          explanation: "Workflow encountered an error",
        }
      }
      return {
        label: "View Workflow",
        href: "/workflows",
        explanation: "Review workflow status",
      }

    case "compliance":
      return {
        label: "Open Compliance",
        href: "/dashboard/compliance",
        explanation: "Review compliance requirements",
      }

    default:
      return {
        label: "Dashboard",
        href: "/dashboard",
        explanation: "Return to main dashboard",
      }
  }
}

export function NextStepRouter({ context, size = "sm" }: NextStepRouterProps) {
  const nextStep = resolveNextStep(context)
  const buttonSize = size === "sm" ? "sm" : "default"

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">Next Step</span>
      <Link href={nextStep.href}>
        <Button
          variant="outline"
          size={buttonSize}
          className={cn(
            "justify-between",
            size === "sm" ? "h-8" : "h-10"
          )}
        >
          {nextStep.label}
          <ArrowRight className="h-4 w-4 ml-2" />
        </Button>
      </Link>
      <span className="text-xs text-muted-foreground">{nextStep.explanation}</span>
    </div>
  )
}
