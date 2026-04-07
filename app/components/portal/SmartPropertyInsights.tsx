"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Car,
  GraduationCap,
  TrendingUp,
  MapPin,
  Clock,
  Star,
  DollarSign,
  Home,
  Shield,
  Utensils,
  Trees,
  CheckCircle2,
  AlertTriangle,
  Loader2,
} from "lucide-react"
import { generateSmartInsights, getSmartInsights } from "@/app/actions/smart-insights"

interface SmartPropertyInsightsProps {
  propertyId: string
  propertyData: Record<string, any>
  contactId: string
}

export function SmartPropertyInsights({ propertyId, propertyData, contactId }: SmartPropertyInsightsProps) {
  const [insights, setInsights] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadInsights()
  }, [propertyId, contactId])

  async function loadInsights() {
    setLoading(true)

    // Try to get existing insights
    let data = await getSmartInsights(propertyId, contactId)

    // If none exist, generate them
    if (!data) {
      data = await generateSmartInsights(propertyId, propertyData, contactId)
    }

    setInsights(data)
    setLoading(false)
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <span className="ml-2 text-muted-foreground">Generating insights...</span>
        </CardContent>
      </Card>
    )
  }

  if (!insights) {
    return null
  }

  const matchScore = insights.match_score || 0
  const matchColor = matchScore >= 80 ? "text-green-600" : matchScore >= 60 ? "text-amber-600" : "text-red-600"
  const matchBg = matchScore >= 80 ? "bg-green-100" : matchScore >= 60 ? "bg-amber-100" : "bg-red-100"

  return (
    <div className="space-y-6">
      {/* Match Score Header */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold">AI Match Score</h3>
              <p className="text-sm text-muted-foreground">Based on your preferences</p>
            </div>
            <div className={`flex items-center gap-3 px-4 py-2 rounded-lg ${matchBg}`}>
              <div className={`text-4xl font-bold ${matchColor}`}>{matchScore}</div>
              <div className="text-sm text-muted-foreground">/100</div>
            </div>
          </div>

          <div className="mt-4 grid md:grid-cols-2 gap-4">
            {insights.match_reasons?.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-green-700">Why it's a match:</p>
                {insights.match_reasons.map((reason: string, idx: number) => (
                  <div key={idx} className="flex items-center gap-2 text-sm">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <span>{reason}</span>
                  </div>
                ))}
              </div>
            )}

            {insights.match_concerns?.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-amber-700">Things to consider:</p>
                {insights.match_concerns.map((concern: string, idx: number) => (
                  <div key={idx} className="flex items-center gap-2 text-sm">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <span>{concern}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Insights Tabs */}
      <Tabs defaultValue="commute" className="space-y-4">
        <TabsList className="grid grid-cols-4 w-full">
          <TabsTrigger value="commute" className="flex items-center gap-1">
            <Car className="h-4 w-4" />
            <span className="hidden sm:inline">Commute</span>
          </TabsTrigger>
          <TabsTrigger value="schools" className="flex items-center gap-1">
            <GraduationCap className="h-4 w-4" />
            <span className="hidden sm:inline">Schools</span>
          </TabsTrigger>
          <TabsTrigger value="investment" className="flex items-center gap-1">
            <TrendingUp className="h-4 w-4" />
            <span className="hidden sm:inline">Investment</span>
          </TabsTrigger>
          <TabsTrigger value="neighborhood" className="flex items-center gap-1">
            <MapPin className="h-4 w-4" />
            <span className="hidden sm:inline">Area</span>
          </TabsTrigger>
        </TabsList>

        {/* Commute Tab */}
        <TabsContent value="commute">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Car className="h-5 w-5" />
                Commute Analysis
              </CardTitle>
            </CardHeader>
            <CardContent>
              {insights.commute_insights?.status === "no_destinations" ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">{insights.commute_insights.message}</p>
                  <div className="mt-4 grid grid-cols-3 gap-4">
                    <div className="p-4 rounded-lg bg-muted">
                      {insights.commute_insights.generalInfo?.walkScore
                        ? <p className="text-2xl font-bold">{insights.commute_insights.generalInfo.walkScore}</p>
                        : <p className="text-xs text-muted-foreground">Not available</p>}
                      <p className="text-xs text-muted-foreground">Walk Score</p>
                    </div>
                    <div className="p-4 rounded-lg bg-muted">
                      <p className="text-sm">{insights.commute_insights.generalInfo?.nearestHighway}</p>
                      <p className="text-xs text-muted-foreground">Nearest Highway</p>
                    </div>
                    <div className="p-4 rounded-lg bg-muted">
                      <p className="text-sm">{insights.commute_insights.generalInfo?.publicTransit}</p>
                      <p className="text-xs text-muted-foreground">Public Transit</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {insights.commute_insights?.destinations?.map((dest: any, idx: number) => (
                    <div key={idx} className="p-4 rounded-lg border">
                      <div className="flex items-center justify-between mb-2">
                        <p className="font-medium">{dest.destination}</p>
                        <Badge variant="secondary">{dest.type}</Badge>
                      </div>
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div>
                          <Clock className="h-4 w-4 text-muted-foreground mb-1" />
                          <p className="font-semibold">{dest.estimates.driving.peakHours} min</p>
                          <p className="text-xs text-muted-foreground">Peak hours</p>
                        </div>
                        <div>
                          <Car className="h-4 w-4 text-muted-foreground mb-1" />
                          <p className="font-semibold">{dest.estimates.driving.offPeak} min</p>
                          <p className="text-xs text-muted-foreground">Off-peak</p>
                        </div>
                        <div>
                          <MapPin className="h-4 w-4 text-muted-foreground mb-1" />
                          <p className="font-semibold">{dest.estimates.publicTransit} min</p>
                          <p className="text-xs text-muted-foreground">Transit</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Schools Tab */}
        <TabsContent value="schools">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <GraduationCap className="h-5 w-5" />
                Nearby Schools
              </CardTitle>
              <CardDescription>
                District: {insights.school_insights?.districtInfo?.name} (Rating:{" "}
                {insights.school_insights?.districtInfo?.overallRating}/10)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {insights.school_insights?.nearbySchools?.map((school: any, idx: number) => (
                  <div key={idx} className="flex items-center justify-between p-3 rounded-lg border">
                    <div>
                      <p className="font-medium">{school.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {school.grades} | {school.type} | {school.distance} mi
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Star className="h-4 w-4 text-amber-500" />
                      <span className="font-bold">{school.rating}/10</span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4 p-4 bg-muted rounded-lg">
                <p className="text-sm font-medium">Summary</p>
                <p className="text-sm text-muted-foreground">
                  Average school rating: {insights.school_insights?.summary?.avgRating}/10 |{" "}
                  {insights.school_insights?.summary?.withinWalkingDistance} within walking distance
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Investment Tab */}
        <TabsContent value="investment">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                Investment Analysis
              </CardTitle>
              <CardDescription>{insights.investment_insights?.recommendation}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <h4 className="font-medium">Rental Potential</h4>
                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Est. Monthly Rent</span>
                      <span className="font-semibold">
                        ${insights.investment_insights?.rentalAnalysis?.estimatedMonthlyRent?.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Price/sqft</span>
                      <span className="font-semibold">
                        ${insights.investment_insights?.rentalAnalysis?.pricePerSqft}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <h4 className="font-medium">Returns</h4>
                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Cap Rate</span>
                      <span className="font-semibold">{insights.investment_insights?.returns?.capRate}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Cash-on-Cash</span>
                      <span className="font-semibold">{insights.investment_insights?.returns?.cashOnCash}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Monthly Cash Flow</span>
                      <span
                        className={`font-semibold ${(insights.investment_insights?.returns?.monthlyNetCashFlow || 0) >= 0 ? "text-green-600" : "text-red-600"}`}
                      >
                        ${insights.investment_insights?.returns?.monthlyNetCashFlow?.toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-6 p-4 bg-muted rounded-lg">
                <h4 className="font-medium mb-2">5-Year Appreciation Projection</h4>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Projected Value</span>
                  <span className="text-xl font-bold text-green-600">
                    ${insights.investment_insights?.appreciation?.fiveYearProjectedValue?.toLocaleString()}
                  </span>
                </div>
                <Progress
                  value={insights.investment_insights?.appreciation?.estimatedAnnualRate * 10}
                  className="mt-2"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {insights.investment_insights?.appreciation?.estimatedAnnualRate}% annual appreciation estimate
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Neighborhood Tab */}
        <TabsContent value="neighborhood">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="h-5 w-5" />
                Neighborhood Overview
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Walkability Scores */}
              <div>
                <h4 className="font-medium mb-3">Walkability</h4>
                <div className="grid grid-cols-3 gap-4">
                  <div className="text-center p-4 rounded-lg bg-muted">
                    {insights.neighborhood_insights?.walkability?.walkScore
                      ? <p className="text-2xl font-bold">{insights.neighborhood_insights.walkability.walkScore}</p>
                      : <p className="text-xs text-muted-foreground">Not available</p>}
                    <p className="text-xs text-muted-foreground">Walk Score</p>
                  </div>
                  <div className="text-center p-4 rounded-lg bg-muted">
                    <p className="text-2xl font-bold">{insights.neighborhood_insights?.walkability?.bikeScore}</p>
                    <p className="text-xs text-muted-foreground">Bike Score</p>
                  </div>
                  <div className="text-center p-4 rounded-lg bg-muted">
                    <p className="text-2xl font-bold">{insights.neighborhood_insights?.walkability?.transitScore}</p>
                    <p className="text-xs text-muted-foreground">Transit Score</p>
                  </div>
                </div>
              </div>

              {/* Safety */}
              <div>
                <h4 className="font-medium mb-3 flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  Safety
                </h4>
                <div className="flex items-center gap-4">
                  <Badge
                    variant={insights.neighborhood_insights?.safety?.crimeIndex < 4 ? "default" : "secondary"}
                    className={
                      insights.neighborhood_insights?.safety?.crimeIndex < 4 ? "bg-green-100 text-green-800" : ""
                    }
                  >
                    {insights.neighborhood_insights?.safety?.crimeIndex < 4 ? "Low Crime" : "Moderate Crime"}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    Trend: {insights.neighborhood_insights?.safety?.trend}
                  </span>
                </div>
              </div>

              {/* Amenities */}
              <div>
                <h4 className="font-medium mb-3">Nearby Amenities</h4>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <div className="text-center p-3 rounded-lg border">
                    <Utensils className="h-5 w-5 mx-auto text-muted-foreground" />
                    <p className="font-semibold">{insights.neighborhood_insights?.amenities?.restaurants}</p>
                    <p className="text-xs text-muted-foreground">Restaurants</p>
                  </div>
                  <div className="text-center p-3 rounded-lg border">
                    <Home className="h-5 w-5 mx-auto text-muted-foreground" />
                    <p className="font-semibold">{insights.neighborhood_insights?.amenities?.groceryStores}</p>
                    <p className="text-xs text-muted-foreground">Grocery</p>
                  </div>
                  <div className="text-center p-3 rounded-lg border">
                    <Trees className="h-5 w-5 mx-auto text-muted-foreground" />
                    <p className="font-semibold">{insights.neighborhood_insights?.amenities?.parks}</p>
                    <p className="text-xs text-muted-foreground">Parks</p>
                  </div>
                  <div className="text-center p-3 rounded-lg border">
                    <DollarSign className="h-5 w-5 mx-auto text-muted-foreground" />
                    <p className="font-semibold">{insights.neighborhood_insights?.amenities?.gyms}</p>
                    <p className="text-xs text-muted-foreground">Gyms</p>
                  </div>
                  <div className="text-center p-3 rounded-lg border">
                    <Shield className="h-5 w-5 mx-auto text-muted-foreground" />
                    <p className="font-semibold">{insights.neighborhood_insights?.amenities?.hospitals}</p>
                    <p className="text-xs text-muted-foreground">Hospitals</p>
                  </div>
                </div>
              </div>

              {/* Market Trends */}
              <div className="p-4 bg-muted rounded-lg">
                <h4 className="font-medium mb-2">Market Trends</h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Median Price</p>
                    <p className="font-semibold">
                      ${insights.neighborhood_insights?.marketTrends?.medianHomePrice?.toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">YoY Change</p>
                    <p className="font-semibold text-green-600">
                      +{insights.neighborhood_insights?.marketTrends?.yoyPriceChange}%
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Avg. Days on Market</p>
                    <p className="font-semibold">{insights.neighborhood_insights?.marketTrends?.avgDaysOnMarket}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Inventory</p>
                    <Badge variant="secondary">{insights.neighborhood_insights?.marketTrends?.inventoryLevel}</Badge>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
