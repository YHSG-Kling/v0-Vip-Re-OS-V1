"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Check, Clock, AlertCircle, ExternalLink, Sparkles } from "lucide-react"
import { activateMarketingPackage, syncListingToPlatforms, generateListingOptimizations } from "@/app/actions/marketing-package-automation"

interface MarketingPackageDashboardProps {
  transactionId: string
  packageData?: any
  syndicationStatus?: any[]
  optimizations?: any[]
}

export function MarketingPackageDashboard({
  transactionId,
  packageData,
  syndicationStatus = [],
  optimizations = [],
}: MarketingPackageDashboardProps) {
  const [loading, setLoading] = useState(false)
  const [activePackage, setActivePackage] = useState<string | null>(packageData?.package_type || null)

  const packages = [
    {
      type: "basic",
      name: "Basic",
      price: "Free",
      services: ["MLS Syndication", "AI Description", "Social Media Posts"],
    },
    {
      type: "standard",
      name: "Standard",
      price: "$500",
      services: ["Everything in Basic", "Professional Photos", "Virtual Tour", "Email Campaign"],
    },
    {
      type: "premium",
      name: "Premium",
      price: "$1,500",
      services: ["Everything in Standard", "Drone Photos", "Video Walkthrough", "Facebook & Instagram Ads"],
    },
    {
      type: "luxury",
      name: "Luxury",
      price: "$3,500",
      services: ["Everything in Premium", "Twilight Photos", "Cinematic Video", "3D Matterport", "Google Ads", "Print Materials"],
    },
  ]

  const handleActivatePackage = async (packageType: string) => {
    setLoading(true)
    const result = await activateMarketingPackage({
      transactionId,
      packageType: packageType as any,
      autoBookServices: true,
    })
    if (result.success) {
      setActivePackage(packageType)
    }
    setLoading(false)
  }

  const handleSyncListings = async () => {
    setLoading(true)
    await syncListingToPlatforms(transactionId)
    setLoading(false)
  }

  const handleGenerateOptimizations = async () => {
    setLoading(true)
    await generateListingOptimizations(transactionId)
    setLoading(false)
  }

  const activeCount = syndicationStatus.filter((s) => s.syndication_status === "active").length
  const pendingCount = syndicationStatus.filter((s) => s.syndication_status === "pending").length

  return (
    <div className="space-y-6">
      {/* Marketing Package Selection */}
      <Card>
        <CardHeader>
          <CardTitle>Marketing Package</CardTitle>
          <CardDescription>Choose the right marketing package for this listing</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-4">
            {packages.map((pkg) => (
              <Card
                key={pkg.type}
                className={`cursor-pointer transition-all ${
                  activePackage === pkg.type ? "border-primary bg-primary/5" : ""
                }`}
              >
                <CardHeader>
                  <CardTitle className="text-lg">{pkg.name}</CardTitle>
                  <p className="text-2xl font-bold">{pkg.price}</p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <ul className="space-y-2 text-sm">
                    {pkg.services.map((service, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <Check className="h-4 w-4 mt-0.5 text-primary flex-shrink-0" />
                        <span>{service}</span>
                      </li>
                    ))}
                  </ul>
                  <Button
                    className="w-full"
                    disabled={loading || activePackage === pkg.type}
                    onClick={() => handleActivatePackage(pkg.type)}
                  >
                    {activePackage === pkg.type ? "Active" : "Activate"}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Syndication Status */}
      <Card>
        <CardHeader>
          <CardTitle>Syndication Status</CardTitle>
          <CardDescription>
            {activeCount} of {syndicationStatus.length} platforms active · {pendingCount} pending
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {syndicationStatus.map((platform) => (
              <div key={platform.id} className="flex items-center justify-between rounded-lg border p-3">
                <div className="flex items-center gap-3">
                  {platform.syndication_status === "active" ? (
                    <Check className="h-5 w-5 text-green-600" />
                  ) : platform.syndication_status === "pending" ? (
                    <Clock className="h-5 w-5 text-yellow-600" />
                  ) : (
                    <AlertCircle className="h-5 w-5 text-red-600" />
                  )}
                  <div>
                    <p className="font-medium text-sm">{platform.platform_name}</p>
                    <p className="text-xs text-muted-foreground capitalize">{platform.syndication_status}</p>
                  </div>
                </div>
                {platform.listing_url && (
                  <Button variant="ghost" size="sm" asChild>
                    <a href={platform.listing_url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                )}
              </div>
            ))}
          </div>
          {pendingCount > 0 && (
            <Button onClick={handleSyncListings} disabled={loading} className="w-full">
              Sync to All Platforms
            </Button>
          )}
        </CardContent>
      </Card>

      {/* AI Optimizations */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>AI Optimization Recommendations</CardTitle>
              <CardDescription>Data-driven suggestions to improve listing performance</CardDescription>
            </div>
            <Button onClick={handleGenerateOptimizations} disabled={loading} size="sm">
              <Sparkles className="h-4 w-4 mr-2" />
              Generate
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {optimizations.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">Click Generate to get AI-powered recommendations</p>
          ) : (
            <div className="space-y-3">
              {optimizations.map((opt) => (
                <div key={opt.id} className="rounded-lg border p-4 space-y-2">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant={opt.priority === "high" ? "destructive" : opt.priority === "medium" ? "default" : "secondary"}>
                        {opt.priority}
                      </Badge>
                      <p className="font-medium capitalize">{opt.optimization_category}</p>
                    </div>
                    <Badge variant="outline">{opt.status}</Badge>
                  </div>
                  <p className="text-sm">{opt.recommendation}</p>
                  <p className="text-xs text-muted-foreground">{opt.reasoning}</p>
                  {opt.estimated_impact && (
                    <p className="text-xs font-medium text-primary">💡 {opt.estimated_impact}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
