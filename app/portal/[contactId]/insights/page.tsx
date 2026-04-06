import { notFound } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  TrendingUp, TrendingDown, DollarSign, Home,
  Clock, Target, BarChart3, PieChart,
} from "lucide-react"
import { createClient } from "@/lib/supabase/server"

export default async function InsightsPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  // ── Async params — Next.js 15+ requirement ───────────────────────────────
  const { contactId } = await params

  const supabase = await createClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .single()

  if (!contact) notFound()

  const isBuyer =
    contact.contact_type === "buyer" ||
    contact.contact_persona?.includes("buyer")
  const isInvestor = contact.contact_persona === "investor"

  const marketData = {
    medianPrice: 425000,
    priceChange: 3.2,
    daysOnMarket: 28,
    domChange: -5,
    inventory: 1245,
    inventoryChange: 8.5,
    listToSaleRatio: 98.5,
  }

  const investmentMetrics = {
    portfolioValue: 2450000,
    totalUnits: 12,
    avgCapRate: 6.8,
    avgCashOnCash: 12.4,
    monthlyIncome: 18500,
    occupancyRate: 94,
    appreciation: 8.2,
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Market Insights</h1>
        <p className="text-muted-foreground">
          {isInvestor
            ? "Investment analytics and portfolio performance"
            : "Real-time market data and trends for your area"}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Median Price</CardTitle>
            <DollarSign className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              ${marketData.medianPrice.toLocaleString()}
            </div>
            <div
              className={`flex items-center text-xs ${
                marketData.priceChange >= 0 ? "text-green-600" : "text-red-600"
              }`}
            >
              {marketData.priceChange >= 0 ? (
                <TrendingUp className="w-3 h-3 mr-1" />
              ) : (
                <TrendingDown className="w-3 h-3 mr-1" />
              )}
              {marketData.priceChange >= 0 ? "+" : ""}
              {marketData.priceChange}% vs last month
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Days on Market</CardTitle>
            <Clock className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{marketData.daysOnMarket}</div>
            <div
              className={`flex items-center text-xs ${
                marketData.domChange <= 0 ? "text-green-600" : "text-red-600"
              }`}
            >
              {marketData.domChange <= 0 ? (
                <TrendingDown className="w-3 h-3 mr-1" />
              ) : (
                <TrendingUp className="w-3 h-3 mr-1" />
              )}
              {marketData.domChange} days vs last month
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Active Listings</CardTitle>
            <Home className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {marketData.inventory.toLocaleString()}
            </div>
            <div
              className={`flex items-center text-xs ${
                marketData.inventoryChange >= 0 ? "text-green-600" : "text-red-600"
              }`}
            >
              {marketData.inventoryChange >= 0 ? (
                <TrendingUp className="w-3 h-3 mr-1" />
              ) : (
                <TrendingDown className="w-3 h-3 mr-1" />
              )}
              {marketData.inventoryChange >= 0 ? "+" : ""}
              {marketData.inventoryChange}% inventory
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">List-to-Sale Ratio</CardTitle>
            <Target className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {marketData.listToSaleRatio}%
            </div>
            <div className="text-xs text-muted-foreground">
              Sellers getting {marketData.listToSaleRatio}% of asking
            </div>
          </CardContent>
        </Card>
      </div>

      {isInvestor && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PieChart className="w-5 h-5" />
              Portfolio Performance
            </CardTitle>
            <CardDescription>Your investment property analytics</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              <div>
                <p className="text-sm text-muted-foreground">Total Portfolio Value</p>
                <p className="text-2xl font-bold">
                  ${(investmentMetrics.portfolioValue / 1000000).toFixed(2)}M
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Units</p>
                <p className="text-2xl font-bold">{investmentMetrics.totalUnits}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Avg Cap Rate</p>
                <p className="text-2xl font-bold">{investmentMetrics.avgCapRate}%</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Cash-on-Cash</p>
                <p className="text-2xl font-bold text-green-600">
                  {investmentMetrics.avgCashOnCash}%
                </p>
              </div>
            </div>
            <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 bg-muted/50 rounded-lg">
                <p className="text-sm text-muted-foreground">Monthly Rental Income</p>
                <p className="text-xl font-bold">
                  ${investmentMetrics.monthlyIncome.toLocaleString()}
                </p>
              </div>
              <div className="p-4 bg-muted/50 rounded-lg">
                <p className="text-sm text-muted-foreground">Occupancy Rate</p>
                <div className="flex items-center gap-2">
                  <p className="text-xl font-bold">{investmentMetrics.occupancyRate}%</p>
                  <Progress value={investmentMetrics.occupancyRate} className="flex-1" />
                </div>
              </div>
              <div className="p-4 bg-muted/50 rounded-lg">
                <p className="text-sm text-muted-foreground">YoY Appreciation</p>
                <p className="text-xl font-bold text-green-600">
                  +{investmentMetrics.appreciation}%
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5" />
            Market Trends
          </CardTitle>
          <CardDescription>Key indicators for your target area</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {[
              { label: "Buyer Demand", value: 78, level: "High" },
              { label: "Seller Activity", value: 55, level: "Moderate" },
              { label: "Price Stability", value: 85, level: "Strong" },
              { label: "Interest Rate Impact", value: 45, level: "Moderate" },
            ].map((item) => (
              <div key={item.label}>
                <div className="flex justify-between mb-1">
                  <span className="text-sm">{item.label}</span>
                  <span className="text-sm font-medium">{item.level}</span>
                </div>
                <Progress value={item.value} className="h-2" />
              </div>
            ))}
          </div>
          <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-950 rounded-lg">
            <h4 className="font-medium text-blue-900 dark:text-blue-100">
              Market Summary
            </h4>
            <p className="text-sm text-blue-800 dark:text-blue-200 mt-1">
              {isBuyer
                ? "The current market favors prepared buyers. Inventory is increasing and well-priced homes are moving quickly — get pre-approved now to stay competitive."
                : "Sellers are seeing strong results with homes selling at 98.5% of list price. Proper pricing and presentation remain key to a quick sale."}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Personalized Recommendations</CardTitle>
          <CardDescription>Based on your profile and market conditions</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {isBuyer ? (
              <>
                <div className="flex items-start gap-3 p-3 bg-green-50 dark:bg-green-950 rounded-lg">
                  <Badge className="bg-green-600">Tip</Badge>
                  <p className="text-sm">
                    Get pre-approved now to strengthen your offers.
                  </p>
                </div>
                <div className="flex items-start gap-3 p-3 bg-blue-50 dark:bg-blue-950 rounded-lg">
                  <Badge className="bg-blue-600">Insight</Badge>
                  <p className="text-sm">
                    Homes in your range are selling within 3 weeks — be ready to act quickly.
                  </p>
                </div>
                <div className="flex items-start gap-3 p-3 bg-amber-50 dark:bg-amber-950 rounded-lg">
                  <Badge className="bg-amber-600">Alert</Badge>
                  <p className="text-sm">
                    New listings in your criteria post most frequently Thursday and Friday.
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start gap-3 p-3 bg-green-50 dark:bg-green-950 rounded-lg">
                  <Badge className="bg-green-600">Tip</Badge>
                  <p className="text-sm">
                    Spring market is approaching — list soon to capture peak buyer activity.
                  </p>
                </div>
                <div className="flex items-start gap-3 p-3 bg-blue-50 dark:bg-blue-950 rounded-lg">
                  <Badge className="bg-blue-600">Insight</Badge>
                  <p className="text-sm">
                    Homes with professional photos receive 61% more views.
                  </p>
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
