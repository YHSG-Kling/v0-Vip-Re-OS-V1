import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingDown, AlertCircle } from "lucide-react"

interface RefinanceIndicatorCardProps {
  purchasePrice: number
  closeDate: string | null
  estimatedCurrentRate?: number | null  // current 30yr fixed benchmark
  estimatedOriginalRate?: number | null // estimated rate at time of purchase
}

export function RefinanceIndicatorCard({
  purchasePrice,
  closeDate,
  estimatedCurrentRate,
  estimatedOriginalRate,
}: RefinanceIndicatorCardProps) {
  // Default fallback rates (approximate) if not provided
  // In a real scenario these come from a rates API or the contact's pre-approval letter
  const current = estimatedCurrentRate ?? 6.9
  const original = estimatedOriginalRate ?? 7.5

  const delta = original - current
  const opportunityExists = delta >= 0.5  // meaningful refi if rate drops ≥ 0.5%

  const yearsSincePurchase = closeDate
    ? (Date.now() - new Date(closeDate).getTime()) / (1000 * 60 * 60 * 24 * 365)
    : null

  // Rough monthly payment calculation (principal + interest, 30yr fixed, 20% down)
  const loanAmount = purchasePrice * 0.8
  const calcMonthlyPayment = (rate: number) => {
    const r = rate / 100 / 12
    const n = 360
    return (loanAmount * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)
  }

  const oldPayment = calcMonthlyPayment(original)
  const newPayment = calcMonthlyPayment(current)
  const monthlySavings = Math.max(0, oldPayment - newPayment)

  return (
    <Card className={opportunityExists ? "border-emerald-200 bg-emerald-50/30" : undefined}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingDown className="h-5 w-5 text-emerald-600" />
            <CardTitle className="text-lg">Refinance Opportunity</CardTitle>
          </div>
          {opportunityExists ? (
            <Badge className="bg-emerald-100 text-emerald-800 border-0">Opportunity</Badge>
          ) : (
            <Badge variant="secondary">Monitoring</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {opportunityExists ? (
          <div className="space-y-2">
            <p className="text-sm">
              Current rates ({current}%) are <span className="font-semibold text-emerald-700">{delta.toFixed(1)}% lower</span> than your estimated original rate ({original}%).
            </p>
            {monthlySavings > 50 && (
              <p className="text-sm font-medium">
                Potential savings: ~${Math.round(monthlySavings).toLocaleString()}/mo
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Talk to your agent or a lender to see if refinancing makes sense for your situation.
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <p className="text-sm text-muted-foreground">
              Current rates ({current}%) are near your original rate. We'll alert you when a meaningful refinance opportunity appears.
            </p>
          </div>
        )}
        {yearsSincePurchase !== null && (
          <p className="text-xs text-muted-foreground">
            You've owned your home for {yearsSincePurchase < 1 ? "less than a year" : `${Math.floor(yearsSincePurchase)} year${Math.floor(yearsSincePurchase) !== 1 ? "s" : ""}`}.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
