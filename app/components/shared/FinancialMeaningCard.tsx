"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { DollarSign, CheckCircle2 } from "lucide-react"

interface FinancialMeaningCardProps {
  financeType?: string | null
  preApprovalAmount?: number | null
  downPaymentPercent?: number | null
  isCashBuyer?: boolean
  personaTone?: string // from personaGuidelines.greetingStyle
  teamHref?: string
}

function getReadinessNote(personaTone?: string, isCashBuyer?: boolean): string {
  if (isCashBuyer) {
    return "You're positioned for maximum flexibility and negotiating power."
  }

  if (personaTone?.toLowerCase().includes("first_time") || personaTone === "first_time_buyer") {
    return "This means you're ready to make an offer when you find the right home."
  }

  if (personaTone?.toLowerCase().includes("investor") || personaTone === "investor") {
    return "Your purchasing power is confirmed. You can move quickly on opportunities."
  }

  return "You're financially prepared for this step."
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

export function FinancialMeaningCard({
  financeType,
  preApprovalAmount,
  downPaymentPercent,
  isCashBuyer,
  personaTone,
  teamHref,
}: FinancialMeaningCardProps) {
  // Only render if preApprovalAmount exists OR isCashBuyer is true
  if (!preApprovalAmount && !isCashBuyer) {
    return null
  }

  const readinessNote = getReadinessNote(personaTone, isCashBuyer)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Your Financial Readiness</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isCashBuyer && (
          <div className="flex items-start gap-3 p-3 bg-primary/5 rounded-lg">
            <CheckCircle2 className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
            <p className="text-sm font-medium">
              You're a cash buyer — this is a significant advantage in any market.
            </p>
          </div>
        )}

        {preApprovalAmount && !isCashBuyer && (
          <div className="space-y-2">
            <p className="text-sm">
              You're approved up to{" "}
              <span className="font-semibold text-foreground">
                {formatCurrency(preApprovalAmount)}
              </span>
            </p>

            {financeType && (
              <p className="text-sm text-muted-foreground">
                Finance type: <span className="font-medium">{financeType} loan</span>
              </p>
            )}

            {downPaymentPercent !== null && downPaymentPercent !== undefined && (
              <p className="text-sm text-muted-foreground">
                Down payment: <span className="font-medium">{downPaymentPercent}%</span>
              </p>
            )}
          </div>
        )}

        <p className="text-sm text-muted-foreground leading-relaxed">
          {readinessNote}
        </p>

        {teamHref && (
          <div className="pt-2">
            <Link href={teamHref}>
              <Button variant="link" className="h-auto p-0 text-sm">
                Questions about financing?
              </Button>
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
