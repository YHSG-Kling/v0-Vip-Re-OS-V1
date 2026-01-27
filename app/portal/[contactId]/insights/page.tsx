import { createClient } from "@/lib/supabase/server"
import { notFound } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { TrendingUp, TrendingDown, DollarSign, Home, Clock, Target, BarChart3, PieChart } from "lucide-react"

export default async function InsightsPage({ params }: { params: { contactId: string } }) {
  const { contactId } = await params
  const supabase = await createClient()

  const { data: contact } = await supabase.from("contacts").select("*").eq("id", contactId).single()

  if (!contact) {
    notFound()
  }

  const isBuyer = contact.contact_type === "buyer" || contact.contact_persona?.includes("buyer")
  const isInvestor = contact.contact_persona === "investor"

  // Demo market data
  const marketData = {
    medianPrice: 425000,
    priceChange: 3.2,
    daysOnMarket: 28,
    domChange: -5,
    inventory: 1245,
    inventoryChange: 8.5,
    listToSaleRatio: 98.5,
  }

  // Demo investment metrics (for investors)
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

      {/* Market Overview */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Median Price</CardTitle>
            <DollarSign className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${marketData.medianPrice.toLocaleString()}</div>
            <div
              className={`flex items-center text-xs ${marketData.priceChange >= 0 ? "text-green-600" : "text-red-600"}`}
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
              className={`flex items-center text-xs ${marketData.domChange <= 0 ? "text-green-600" : "text-red-600"}`}
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
            <div className="text-2xl font-bold">{marketData.inventory.toLocaleString()}</div>
            <div
              className={`flex items-center text-xs ${marketData.inventoryChange >= 0 ? "text-green-600" : "text-red-600"}`}
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
            <div className="text-2xl font-bold">{marketData.listToSaleRatio}%</div>
            <div className="text-xs text-muted-foreground">Sellers getting {marketData.listToSaleRatio}% of asking</div>
          </CardContent>
        </Card>
      </div>

      {/* Investor Portfolio (if investor) */}
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
                <p className="text-2xl font-bold">${(investmentMetrics.portfolioValue / 1000000).toFixed(2)}M</p>
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
                <p className="text-sm text-muted-foreground">Cash-on-Cash Return</p>
                <p className="text-2xl font-bold text-green-600">{investmentMetrics.avgCashOnCash}%</p>
              </div>
            </div>

            <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 bg-muted/50 rounded-lg">
                <p className="text-sm text-muted-foreground">Monthly Rental Income</p>
                <p className="text-xl font-bold">${investmentMetrics.monthlyIncome.toLocaleString()}</p>
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
                <p className="text-xl font-bold text-green-600">+{investmentMetrics.appreciation}%</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Market Trends */}
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
            <div>
              <div className="flex justify-between mb-1">
                <span className="text-sm">Buyer Demand</span>
                <span className="text-sm font-medium">High</span>
              </div>
              <Progress value={78} className="h-2" />
            </div>
            <div>
              <div className="flex justify-between mb-1">
                <span className="text-sm">Seller Activity</span>
                <span className="text-sm font-medium">Moderate</span>
              </div>
              <Progress value={55} className="h-2" />
            </div>
            <div>
              <div className="flex justify-between mb-1">
                <span className="text-sm">Price Stability</span>
                <span className="text-sm font-medium">Strong</span>
              </div>
              <Progress value={85} className="h-2" />
            </div>
            <div>
              <div className="flex justify-between mb-1">
                <span className="text-sm">Interest Rate Impact</span>
                <span className="text-sm font-medium">Moderate</span>
              </div>
              <Progress value={45} className="h-2" />
            </div>
          </div>

          <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-950 rounded-lg">
            <h4 className="font-medium text-blue-900 dark:text-blue-100">Market Summary</h4>
            <p className="text-sm text-blue-800 dark:text-blue-200 mt-1">
              {isBuyer
                ? "The current market favors prepared buyers. With inventory increasing and days on market slightly decreasing, now is a good time to make competitive offers on well-priced homes."
                : "Sellers are seeing strong results with homes selling at 98.5% of list price on average. Proper pricing and presentation remain key to a quick sale."}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Personalized Recommendations */}
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
                    Consider getting pre-approved now to strengthen your position when making offers.
                  </p>
                </div>
                <div className="flex items-start gap-3 p-3 bg-blue-50 dark:bg-blue-950 rounded-lg">
                  <Badge className="bg-blue-600">Insight</Badge>
                  <p className="text-sm">
                    Homes in your price range are selling within 3 weeks. Be ready to act quickly on properties you
                    love.
                  </p>
                </div>
                <div className="flex items-start gap-3 p-3 bg-amber-50 dark:bg-amber-950 rounded-lg">
                  <Badge className="bg-amber-600">Alert</Badge>
                  <p className="text-sm">
                    New listings matching your criteria are posted most frequently on Thursday and Friday.
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start gap-3 p-3 bg-green-50 dark:bg-green-950 rounded-lg">
                  <Badge className="bg-green-600">Tip</Badge>
                  <p className="text-sm">
                    Spring market is approaching - consider listing soon to capture peak buyer activity.
                  </p>
                </div>
                <div className="flex items-start gap-3 p-3 bg-blue-50 dark:bg-blue-950 rounded-lg">
                  <Badge className="bg-blue-600">Insight</Badge>
                  <p className="text-sm">
                    Homes with professional photos receive 61% more views. Schedule a photo session before listing.
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
