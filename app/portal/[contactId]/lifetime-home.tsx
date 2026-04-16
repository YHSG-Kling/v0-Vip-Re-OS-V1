import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CongratsCard } from "@/app/components/portal/lifetime/CongratsCard"
import { MyHomeCard } from "@/app/components/portal/lifetime/MyHomeCard"
import { EquityEstimateCard } from "@/app/components/portal/lifetime/EquityEstimateCard"
import { ReferralAskCard } from "@/app/components/portal/lifetime/ReferralAskCard"
import { getLifetimeContext } from "@/app/actions/portal-lifetime"
import {
  Bell,
  BookOpen,
  Wrench,
  ArrowRight,
  Clock,
  FileText,
  Star,
} from "lucide-react"

interface LifetimeHomeProps {
  contactId: string
}

export default async function LifetimeHome({ contactId }: LifetimeHomeProps) {
  const context = await getLifetimeContext(contactId)

  if (!context) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-muted-foreground">Unable to load your portal. Please try again.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const { contact, transaction, homeValueEstimate, touchpoints, preferredVendors } = context
  const firstName = contact.first_name || contact.name?.split(" ")[0] || "Homeowner"
  const agentName = (contact as any).agents?.name

  // Get last market update touchpoint
  const lastMarketUpdate = touchpoints.find(
    (t: any) => t.touchpoint_type === "market_update" || t.touchpoint_type === "anniversary"
  )
  const hasUnreadUpdate = lastMarketUpdate && !lastMarketUpdate.opened_at

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Welcome Home, {firstName}</h1>
          <p className="text-muted-foreground mt-1">
            {"Your home is your greatest investment. Here's everything in one place."}
          </p>
        </div>
        {agentName && (
          <div className="text-right shrink-0">
            <p className="text-sm text-muted-foreground">Your Agent</p>
            <p className="font-medium">{agentName}</p>
          </div>
        )}
      </div>

      {/* 1. Congrats Card (dismissible) */}
      {transaction && (
        <CongratsCard
          contactId={contactId}
          firstName={firstName}
          propertyAddress={transaction.property_address}
          closeDate={transaction.close_date}
          salePrice={transaction.sale_price}
        />
      )}

      {/* Main Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* 2. My Home Card */}
        {transaction && (
          <MyHomeCard
            contactId={contactId}
            propertyAddress={transaction.property_address}
            closeDate={transaction.close_date}
            closePrice={transaction.sale_price}
            currentEstimate={homeValueEstimate?.estimated_value_mid}
            agentName={agentName}
          />
        )}

        {/* 3. Equity Estimate Card */}
        <EquityEstimateCard
          estimatedValueMid={homeValueEstimate?.estimated_value_mid}
          estimatedValueLow={homeValueEstimate?.estimated_value_low}
          estimatedValueHigh={homeValueEstimate?.estimated_value_high}
          purchasePrice={transaction?.sale_price || 0}
          marketTrend={homeValueEstimate?.market_trend}
          generatedAt={homeValueEstimate?.generated_at}
        />

        {/* 4. Market Updates Preview */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bell className="h-5 w-5 text-blue-600" />
                <CardTitle className="text-lg">Market Updates</CardTitle>
              </div>
              {hasUnreadUpdate && (
                <Badge variant="destructive" className="text-xs">New</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {lastMarketUpdate ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">
                    Last update: {new Date(lastMarketUpdate.sent_at).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-sm capitalize">{lastMarketUpdate.touchpoint_type.replace("_", " ")}</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No market updates yet</p>
            )}
            <Button variant="outline" className="w-full" asChild>
              <Link href={`/portal/${contactId}/market-updates`}>
                View Market Updates
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        {/* 5. Referral Ask Card */}
        <ReferralAskCard contactId={contactId} />

        {/* 6. Preferred Vendors (compact) */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Wrench className="h-5 w-5 text-orange-600" />
              <CardTitle className="text-lg">Trusted Vendors</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {preferredVendors.length > 0 ? (
              <div className="space-y-2">
                {preferredVendors.slice(0, 3).map((v: any) => (
                  <div
                    key={v.id}
                    className="flex items-center justify-between p-3 rounded-lg border"
                  >
                    <div>
                      <p className="font-medium text-sm">
                        {v.vendors?.business_name || v.business_name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {v.category || v.service_type}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {v.rating && (
                        <div className="flex items-center gap-1">
                          <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
                          <span className="text-xs">{v.rating}</span>
                        </div>
                      )}
                      {v.is_featured && !v.rating && (
                        <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Trusted service providers recommended by your agent for home maintenance and improvements.
                </p>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/portal/${contactId}/resources`}>
                    Browse Service Providers
                  </Link>
                </Button>
              </div>
            )}
            <Button variant="outline" className="w-full" asChild>
              <Link href={`/portal/${contactId}/resources`}>
                View All Resources
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        {/* 7. Education Spotlight */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-green-600" />
              <CardTitle className="text-lg">Homeowner Tips</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Learn how to maintain and protect your investment with our homeowner guides.
            </p>
            <Button variant="outline" className="w-full" asChild>
              <Link href={`/portal/${contactId}/learn`}>
                View Learning Center
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Re-engagement: thinking of moving */}
      <Card className="border-blue-200 bg-blue-50">
        <CardContent className="p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <div className="flex-1">
            <p className="font-semibold text-blue-900">Thinking of moving?</p>
            <p className="text-sm text-blue-700 mt-1">
              {agentName
                ? `${agentName} is here whenever you're ready — whether that's next month or a few years from now.`
                : "Your agent is here whenever you're ready to make your next move."}
            </p>
          </div>
          <Button className="bg-blue-700 hover:bg-blue-800 text-white shrink-0" asChild>
            <Link href={`/portal/${contactId}/messages`}>
              {"Let's talk"}
            </Link>
          </Button>
        </CardContent>
      </Card>

      {/* Quick Links */}
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-wrap gap-4 justify-center">
            <Button variant="ghost" asChild>
              <Link href={`/portal/${contactId}/history`}>
                <FileText className="mr-2 h-4 w-4" />
                Transaction History
              </Link>
            </Button>
            <Button variant="ghost" asChild>
              <Link href={`/portal/${contactId}/documents`}>
                <FileText className="mr-2 h-4 w-4" />
                My Documents
              </Link>
            </Button>
            <Button variant="ghost" asChild>
              <Link href={`/portal/${contactId}/messages`}>
                <Bell className="mr-2 h-4 w-4" />
                Messages
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
