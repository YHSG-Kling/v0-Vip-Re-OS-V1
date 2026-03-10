import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Home, TrendingUp, TrendingDown, Minus, ArrowRight } from "lucide-react"

interface MyHomeCardProps {
  contactId: string
  propertyAddress: string
  closeDate: string
  closePrice: number
  currentEstimate?: number | null
  agentName?: string
}

export function MyHomeCard({
  contactId,
  propertyAddress,
  closeDate,
  closePrice,
  currentEstimate,
  agentName,
}: MyHomeCardProps) {
  const formattedCloseDate = new Date(closeDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })

  const formattedClosePrice = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(closePrice)

  const hasEstimate = currentEstimate && currentEstimate > 0
  const valueChange = hasEstimate ? currentEstimate - closePrice : 0
  const percentChange = hasEstimate ? ((valueChange / closePrice) * 100) : 0

  const formattedCurrentValue = hasEstimate
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(currentEstimate)
    : null

  const formattedValueChange = hasEstimate
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
        signDisplay: "always",
      }).format(valueChange)
    : null

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Home className="h-5 w-5 text-blue-600" />
          <CardTitle className="text-lg">My Home</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="font-medium text-foreground">{propertyAddress}</p>
          <p className="text-sm text-muted-foreground">Closed {formattedCloseDate}</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Purchase Price</p>
            <p className="text-lg font-semibold">{formattedClosePrice}</p>
          </div>
          {hasEstimate && (
            <div>
              <p className="text-sm text-muted-foreground">Current Estimate</p>
              <p className="text-lg font-semibold">{formattedCurrentValue}</p>
            </div>
          )}
        </div>

        {hasEstimate && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50">
            {valueChange > 0 ? (
              <TrendingUp className="h-5 w-5 text-green-600" />
            ) : valueChange < 0 ? (
              <TrendingDown className="h-5 w-5 text-red-600" />
            ) : (
              <Minus className="h-5 w-5 text-muted-foreground" />
            )}
            <div>
              <p className="text-sm font-medium">
                {formattedValueChange} ({percentChange > 0 ? "+" : ""}{percentChange.toFixed(1)}%)
              </p>
              <p className="text-xs text-muted-foreground">Change since purchase</p>
            </div>
          </div>
        )}

        {!hasEstimate && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
            <p className="text-sm text-amber-800">
              {agentName ? `Ask ${agentName} for a home value update` : "Ask your agent for a home value update"}
            </p>
          </div>
        )}

        <Button variant="outline" className="w-full" asChild>
          <Link href={`/portal/${contactId}/market-updates`}>
            Get Updated Estimate
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
