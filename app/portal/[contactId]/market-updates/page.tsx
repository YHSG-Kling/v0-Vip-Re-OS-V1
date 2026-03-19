import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { determinePortalView } from "@/lib/kernel/portal"
import { getMarketUpdates, requestValueUpdate, getLifetimeContext } from "@/app/actions/portal-lifetime"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  ArrowLeft,
  TrendingUp,
  TrendingDown,
  Minus,
  Calendar,
  Home,
  Bell,
  Mail,
  MailOpen,
  RefreshCw,
} from "lucide-react"
import { HomeValueChart } from "./home-value-chart"

export default async function MarketUpdatesPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // Verify lifetime portal access
  const portalView = await determinePortalView(supabase, contactId)
  if (portalView !== "lifetime") {
    redirect(`/portal/${contactId}`)
  }

  const [marketData, context] = await Promise.all([
    getMarketUpdates(contactId),
    getLifetimeContext(contactId),
  ])

  const { estimates, touchpoints } = marketData
  const latestEstimate = estimates[estimates.length - 1]
  const purchasePrice = context?.transaction?.sale_price || 0

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value)

  const formatDate = (date: string) =>
    new Date(date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })

  const getTrendIcon = (trend: string | null) => {
    switch (trend?.toLowerCase()) {
      case "appreciating":
        return <TrendingUp className="h-5 w-5 text-green-600" />
      case "depreciating":
        return <TrendingDown className="h-5 w-5 text-red-600" />
      default:
        return <Minus className="h-5 w-5 text-gray-600" />
    }
  }

  const getTrendColor = (trend: string | null) => {
    switch (trend?.toLowerCase()) {
      case "appreciating":
        return "bg-green-100 text-green-800"
      case "depreciating":
        return "bg-red-100 text-red-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  // Parse comps if available
  let comps: any[] = []
  if (latestEstimate?.comps_json) {
    try {
      comps = JSON.parse(latestEstimate.comps_json)
    } catch {
      comps = []
    }
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <Button variant="ghost" size="sm" className="mb-2" asChild>
          <Link href={`/portal/${contactId}`}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Portal
          </Link>
        </Button>
        <h1 className="text-3xl font-bold tracking-tight">Market Updates</h1>
        <p className="text-muted-foreground">Track your home's value and market trends</p>
      </div>

      {/* Current Estimate Card */}
      {latestEstimate ? (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Home className="h-5 w-5 text-blue-600" />
                <CardTitle>Current Home Value Estimate</CardTitle>
              </div>
              {latestEstimate.market_trend && (
                <Badge variant="secondary" className={getTrendColor(latestEstimate.market_trend)}>
                  {getTrendIcon(latestEstimate.market_trend)}
                  <span className="ml-1 capitalize">{latestEstimate.market_trend}</span>
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="text-center p-4 rounded-lg bg-muted/50">
                <p className="text-sm text-muted-foreground">Low Estimate</p>
                <p className="text-2xl font-semibold">
                  {formatCurrency(latestEstimate.estimated_value_low || latestEstimate.estimated_value_mid * 0.95)}
                </p>
              </div>
              <div className="text-center p-4 rounded-lg bg-blue-50 border-2 border-blue-200">
                <p className="text-sm text-blue-600 font-medium">Estimated Value</p>
                <p className="text-3xl font-bold text-blue-700">
                  {formatCurrency(latestEstimate.estimated_value_mid)}
                </p>
              </div>
              <div className="text-center p-4 rounded-lg bg-muted/50">
                <p className="text-sm text-muted-foreground">High Estimate</p>
                <p className="text-2xl font-semibold">
                  {formatCurrency(latestEstimate.estimated_value_high || latestEstimate.estimated_value_mid * 1.05)}
                </p>
              </div>
            </div>

            {latestEstimate.ai_summary && (
              <div className="p-4 rounded-lg bg-muted/50">
                <p className="text-sm font-medium mb-2">Market Analysis</p>
                <p className="text-sm text-muted-foreground">{latestEstimate.ai_summary}</p>
              </div>
            )}

            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                <Calendar className="inline h-4 w-4 mr-1" />
                Last updated {formatDate(latestEstimate.generated_at)}
              </span>
              <form action={async () => {
                "use server"
                await requestValueUpdate(contactId)
              }}>
                <Button type="submit" variant="outline" size="sm">
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Request Updated Value
                </Button>
              </form>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-8 text-center">
            <Home className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground mb-4">
              No home value estimates available yet.
            </p>
            <form action={async () => {
              "use server"
              await requestValueUpdate(contactId)
            }}>
              <Button type="submit" variant="outline">
                <RefreshCw className="mr-2 h-4 w-4" />
                Request Home Value Update
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Value Timeline Chart */}
      {estimates.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Home Value Over Time</CardTitle>
            <CardDescription>Track how your home's value has changed</CardDescription>
          </CardHeader>
          <CardContent>
            <HomeValueChart
              estimates={estimates}
              purchasePrice={purchasePrice}
              purchaseDate={context?.transaction?.close_date}
            />
          </CardContent>
        </Card>
      )}

      {/* Comparable Sales */}
      {comps.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Comparable Recent Sales</CardTitle>
            <CardDescription>Similar homes that recently sold in your area</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {comps.slice(0, 5).map((comp: any, index: number) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-3 rounded-lg border"
                >
                  <div>
                    <p className="font-medium">{comp.address}</p>
                    <p className="text-sm text-muted-foreground">
                      {comp.beds} bed, {comp.baths} bath
                      {comp.sqft && ` · ${comp.sqft.toLocaleString()} sqft`}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold">{formatCurrency(comp.sale_price)}</p>
                    {comp.sale_date && (
                      <p className="text-xs text-muted-foreground">
                        Sold {formatDate(comp.sale_date)}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Market Update History */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-purple-600" />
            <CardTitle>Update History</CardTitle>
          </div>
          <CardDescription>Past market updates and communications</CardDescription>
        </CardHeader>
        <CardContent>
          {touchpoints.length > 0 ? (
            <div className="space-y-3">
              {touchpoints.map((tp: any) => (
                <div
                  key={tp.id}
                  className="flex items-center justify-between p-3 rounded-lg border"
                >
                  <div className="flex items-center gap-3">
                    {tp.opened_at ? (
                      <MailOpen className="h-5 w-5 text-green-600" />
                    ) : (
                      <Mail className="h-5 w-5 text-muted-foreground" />
                    )}
                    <div>
                      <p className="font-medium capitalize">
                        {tp.touchpoint_type?.replace(/_/g, " ")}
                      </p>
                      {tp.notes && (
                        <p className="text-sm text-muted-foreground">{tp.notes}</p>
                      )}
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    <p className="text-muted-foreground">
                      Sent {formatDate(tp.sent_at)}
                    </p>
                    {tp.opened_at && (
                      <p className="text-xs text-green-600">
                        Opened {formatDate(tp.opened_at)}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-4">
              No update history yet
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
