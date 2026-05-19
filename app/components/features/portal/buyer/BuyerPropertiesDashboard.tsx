"use client"

import { useEffect, useState } from "react"
import { getBuyerPortalMatches, type BuyerPortalMatch } from "@/app/actions/buyer-portal-matches"
import { searchPropertiesWithNaturalLanguage } from "@/app/actions/buyer-property-search"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Progress } from "@/components/ui/progress"
import { Slider } from "@/components/ui/slider"
import {
  Home,
  Heart,
  Calendar,
  MapPin,
  TrendingUp,
  Star,
  ThumbsUp,
  DollarSign,
  Building,
  School,
  ShoppingBag,
  Trees,
  Car,
  Train,
  Shield,
  Sparkles,
  ChevronRight,
  Eye,
  Clock,
  Filter,
  Bell,
  Percent,
  Calculator,
  CheckCircle2,
  X,
  Search,
  Loader2,
} from "lucide-react"
import Link from "next/link"

interface BuyerPropertiesDashboardProps {
  contact: any
  savedProperties: any[]
  showings: any[]
  offers: any[]
  contactId: string
}

interface DisplayMatch {
  id: string | number
  address: string
  city: string
  state: string
  price: number
  beds: number
  baths: number
  sqft: number
  matchScore: number
  matchReasons: string[]
  status: string
  daysOnMarket: number
  image?: string
  priceDropAmount?: number
}

function matchToDisplay(m: BuyerPortalMatch): DisplayMatch {
  return {
    id: m.id,
    address: m.address ?? "Address pending",
    city: m.city ?? "",
    state: m.state ?? "",
    price: m.list_price ?? 0,
    beds: m.bedrooms ?? 0,
    baths: m.bathrooms ?? 0,
    sqft: m.sqft ?? 0,
    matchScore: m.match_score,
    matchReasons: m.match_reasons.slice(0, 3),
    status: m.status ?? "active",
    daysOnMarket: m.days_on_market ?? 0,
    image: m.primary_photo_url ?? undefined,
  }
}

export default function BuyerPropertiesDashboard({
  contact,
  savedProperties,
  showings,
  offers,
  contactId,
}: BuyerPropertiesDashboardProps) {
  const [activeTab, setActiveTab] = useState("matches")
  const [priceRange, setPriceRange] = useState([300000, 600000])

  // Natural language search
  const [nlQuery, setNlQuery] = useState("")
  const [nlResults, setNlResults] = useState<DisplayMatch[] | null>(null)
  const [nlLoading, setNlLoading] = useState(false)

  const handleNlSearch = async () => {
    if (!nlQuery.trim()) { setNlResults(null); return }
    setNlLoading(true)
    try {
      const result = await searchPropertiesWithNaturalLanguage({ contactId, naturalLanguageQuery: nlQuery })
      if (result.success && "results" in result && result.results) {
        setNlResults((result.results as any[]).map((r: any) => ({
          id: r.listing_id,
          address: r.address ?? r.city ?? r.listing_id,
          city: r.city ?? "",
          state: r.state ?? "",
          price: r.price ?? r.list_price ?? 0,
          beds: r.bedrooms ?? 0,
          baths: r.bathrooms ?? 0,
          sqft: r.sqft ?? 0,
          matchScore: r.internal_match_score ?? r.match_score ?? 0,
          matchReasons: r.match_reasons ?? [],
          status: r.status ?? "active",
          daysOnMarket: r.days_on_market ?? 0,
          image: r.primary_photo_url ?? undefined,
        })))
      }
    } finally {
      setNlLoading(false)
    }
  }

  // Real matches loaded from cached property_matches (written by generatePropertyMatches).
  const [smartMatches, setSmartMatches] = useState<DisplayMatch[]>([])
  const [matchesLoading, setMatchesLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const result = await getBuyerPortalMatches(contactId, 12)
        if (cancelled) return
        if (result.success && result.matches.length > 0) {
          setSmartMatches(result.matches.map(matchToDisplay))
        } else {
          setSmartMatches([])
        }
      } finally {
        if (!cancelled) setMatchesLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [contactId])

  const displayMatches: DisplayMatch[] =
    nlResults !== null
      ? nlResults
      : smartMatches.length > 0
        ? smartMatches
        : []

  // Pre-approval data from contact financial verification record
  const preApprovalAmount: number | null = contact?.pre_approval_amount ?? null
  const preApprovalLender: string | null = contact?.pre_approval_lender ?? null
  const preApprovalExpires: string | null = contact?.pre_approval_expiration ?? null
  const financingType: string | null = contact?.financing_type ?? null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Property Search</h1>
          <p className="text-muted-foreground">Find your perfect home with AI-powered matches</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="py-2 px-3">
            <Heart className="w-4 h-4 mr-2 text-red-500" />
            {savedProperties.length} Saved
          </Badge>
          <Badge variant="outline" className="py-2 px-3">
            <Calendar className="w-4 h-4 mr-2 text-purple-500" />
            {showings.length} Showings
          </Badge>
          <Button>
            <Filter className="w-4 h-4 mr-2" /> Filters
          </Button>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-100 text-green-600">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{displayMatches.length}</p>
              <p className="text-xs text-muted-foreground">New Matches</p>
            </div>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-100 text-blue-600">
              <DollarSign className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {preApprovalAmount ? `$${(preApprovalAmount / 1000).toFixed(0)}K` : "—"}
              </p>
              <p className="text-xs text-muted-foreground">Pre-Approved</p>
            </div>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-100 text-purple-600">
              <Eye className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{showings.filter((s) => s.status === "completed").length}</p>
              <p className="text-xs text-muted-foreground">Homes Toured</p>
            </div>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-orange-100 text-orange-600">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{offers.length}</p>
              <p className="text-xs text-muted-foreground">Offers Made</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
          <TabsList className="flex min-w-max sm:grid sm:w-full sm:grid-cols-5">
            <TabsTrigger value="matches" className="min-h-[44px] sm:min-h-0 min-w-[110px] sm:min-w-0">Smart Matches</TabsTrigger>
            <TabsTrigger value="saved" className="min-h-[44px] sm:min-h-0 min-w-[100px] sm:min-w-0">Saved ({savedProperties.length})</TabsTrigger>
            <TabsTrigger value="mortgage" className="min-h-[44px] sm:min-h-0 min-w-[95px] sm:min-w-0">Mortgage</TabsTrigger>
            <TabsTrigger value="neighborhood" className="min-h-[44px] sm:min-h-0 min-w-[120px] sm:min-w-0">Neighborhoods</TabsTrigger>
            <TabsTrigger value="activity" className="min-h-[44px] sm:min-h-0 min-w-[85px] sm:min-w-0">Activity</TabsTrigger>
          </TabsList>
        </div>

        {/* Smart Matches Tab */}
        <TabsContent value="matches" className="space-y-6">
          {/* AI Recommendation Banner */}
          <Card className="bg-gradient-to-r from-blue-50 to-purple-50 border-blue-200">
            <CardContent className="p-4">
              <div className="flex items-start gap-4">
                <div className="p-3 rounded-xl bg-white shadow-md">
                  <Sparkles className="w-6 h-6 text-blue-600" />
                </div>
                <div>
                  <h3 className="font-semibold">AI Property Matches</h3>
                  <p className="text-sm text-muted-foreground">
                    Based on your search history, saved properties, and preferences, we found {displayMatches.length} new
                    properties that match your criteria.
                  </p>
                </div>
                <Button size="sm" variant="outline" className="ml-auto bg-transparent">
                  <Bell className="w-4 h-4 mr-2" /> Get Alerts
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Natural Language Search */}
          <Card>
            <CardContent className="p-4 space-y-3">
              <p className="text-sm font-medium">Search in your own words</p>
              <div className="flex gap-2">
                <input
                  value={nlQuery}
                  onChange={(e) => setNlQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleNlSearch()}
                  placeholder='e.g. "3-bed with pool near good schools under $600k"'
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <Button size="sm" onClick={handleNlSearch} disabled={nlLoading || !nlQuery.trim()}>
                  {nlLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                </Button>
                {nlResults !== null && (
                  <Button size="sm" variant="ghost" onClick={() => { setNlResults(null); setNlQuery("") }}>
                    Clear
                  </Button>
                )}
              </div>
              {nlResults !== null && (
                <p className="text-xs text-muted-foreground">
                  Showing {nlResults.length} AI-matched results for your search
                </p>
              )}
            </CardContent>
          </Card>

          {/* Price Range Filter */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-medium">Price Range</span>
                <span className="text-sm text-muted-foreground">
                  ${priceRange[0].toLocaleString()} - ${priceRange[1].toLocaleString()}
                </span>
              </div>
              <Slider
                value={priceRange}
                onValueChange={setPriceRange}
                min={200000}
                max={800000}
                step={10000}
                className="mb-2"
              />
            </CardContent>
          </Card>

          {/* Property Cards */}
          <div className="grid md:grid-cols-2 gap-6">
            {displayMatches.map((property) => (
              <Card key={property.id} className="overflow-hidden hover:shadow-lg transition-shadow">
                <div className="relative h-48 bg-slate-100">
                  <img
                    src={property.image || "/placeholder.svg"}
                    alt={property.address}
                    className="w-full h-full object-cover"
                  />
                  {/* Match Score Badge */}
                  <div className="absolute top-3 left-3 bg-white rounded-full px-3 py-1 shadow-md flex items-center gap-1">
                    <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                    <span className="font-bold text-sm">{property.matchScore}%</span>
                    <span className="text-xs text-muted-foreground">Match</span>
                  </div>
                  {/* Status Badge */}
                  {property.status === "new" && <Badge className="absolute top-3 right-3 bg-green-500">New</Badge>}
                  {property.status === "hot" && <Badge className="absolute top-3 right-3 bg-orange-500">Hot</Badge>}
                  {property.status === "price_drop" && (
                    <Badge className="absolute top-3 right-3 bg-red-500">
                      ${(property.priceDropAmount! / 1000).toFixed(0)}K Drop
                    </Badge>
                  )}
                  {/* Quick Actions */}
                  <div className="absolute bottom-3 right-3 flex gap-2">
                    <Button size="icon" variant="secondary" className="h-8 w-8 rounded-full">
                      <Heart className="w-4 h-4" />
                    </Button>
                    <Button size="icon" variant="secondary" className="h-8 w-8 rounded-full">
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-xl font-bold">${property.price.toLocaleString()}</p>
                      <p className="text-sm text-muted-foreground flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        {property.address}, {property.city}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">{property.daysOnMarket}d on market</span>
                  </div>

                  <div className="flex items-center gap-4 text-sm">
                    <span className="flex items-center gap-1">
                      <Home className="w-4 h-4 text-muted-foreground" />
                      {property.beds} bd
                    </span>
                    <span>{property.baths} ba</span>
                    <span>{property.sqft.toLocaleString()} sqft</span>
                  </div>

                  {/* Match Reasons */}
                  <div className="flex flex-wrap gap-1">
                    {property.matchReasons.map((reason, idx) => (
                      <Badge key={idx} variant="outline" className="text-xs">
                        <CheckCircle2 className="w-3 h-3 mr-1 text-green-500" />
                        {reason}
                      </Badge>
                    ))}
                  </div>

                  <div className="flex gap-2 pt-2">
                    <Button className="flex-1" size="sm">
                      <Calendar className="w-4 h-4 mr-2" /> Schedule Tour
                    </Button>
                    <Button variant="outline" size="sm" className="flex-1 bg-transparent">
                      View Details
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* Saved Tab */}
        <TabsContent value="saved" className="space-y-6">
          {savedProperties.length > 0 ? (
            <div className="space-y-4">
              {/* Comparison Tool */}
              <Card>
                <CardContent className="p-4 flex items-center justify-between">
                  <div>
                    <p className="font-medium">Compare Properties</p>
                    <p className="text-sm text-muted-foreground">Select 2-4 properties to compare side by side</p>
                  </div>
                  <Button variant="outline" className="bg-transparent">
                    <ThumbsUp className="w-4 h-4 mr-2" /> Compare Selected
                  </Button>
                </CardContent>
              </Card>

              {/* Saved Property Grid */}
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {savedProperties.map((saved) => (
                  <Card key={saved.id} className="overflow-hidden">
                    <div className="relative h-40 bg-slate-100">
                      <img
                        src={saved.listing?.photos?.[0] || "/placeholder.svg?height=160&width=240&query=home exterior"}
                        alt={saved.listing?.address}
                        className="w-full h-full object-cover"
                      />
                      <Button size="icon" variant="secondary" className="absolute top-2 right-2 h-8 w-8 rounded-full">
                        <Heart className="w-4 h-4 fill-red-500 text-red-500" />
                      </Button>
                    </div>
                    <CardContent className="p-4">
                      <p className="font-bold">${(saved.listing?.price || 485000).toLocaleString()}</p>
                      <p className="text-sm text-muted-foreground">{saved.listing?.address || "123 Main St"}</p>
                      <div className="flex gap-3 text-sm text-muted-foreground mt-2">
                        <span>{saved.listing?.beds || 3} bd</span>
                        <span>{saved.listing?.baths || 2} ba</span>
                        <span>{(saved.listing?.sqft || 1800).toLocaleString()} sqft</span>
                      </div>
                      <div className="flex gap-2 mt-3">
                        <Badge variant={saved.status === "toured" ? "default" : "outline"}>
                          {saved.status || "Saved"}
                        </Badge>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <Heart className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-xl font-semibold mb-2">No Saved Properties Yet</h3>
                <p className="text-muted-foreground mb-4">
                  Start saving properties you love to keep track of them here.
                </p>
                <Button onClick={() => setActiveTab("matches")}>
                  <Sparkles className="w-4 h-4 mr-2" /> View Smart Matches
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Mortgage Tab */}
        <TabsContent value="mortgage" className="space-y-6">
          <div className="grid md:grid-cols-2 gap-6">
            {/* Pre-Approval Status */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-green-500" />
                  Pre-Approval Status
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {preApprovalAmount ? (
                  <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-green-700">Pre-Approved Amount</span>
                      <Badge variant="outline" className="bg-green-100 text-green-700 border-green-300">
                        Active
                      </Badge>
                    </div>
                    <p className="text-3xl font-bold text-green-700">
                      ${preApprovalAmount.toLocaleString()}
                    </p>
                    {preApprovalLender && <p className="text-sm text-green-600 mt-1">{preApprovalLender}</p>}
                    {financingType && (
                      <p className="text-xs text-green-600 mt-0.5 capitalize">{financingType.replace(/_/g, " ")}</p>
                    )}
                  </div>
                ) : (
                  <div className="p-4 bg-amber-50 rounded-lg border border-amber-200 text-center">
                    <p className="text-sm text-amber-700 font-medium">Pre-Approval Not Yet Verified</p>
                    <p className="text-xs text-amber-600 mt-1">Contact your agent to complete financial verification.</p>
                  </div>
                )}

                {preApprovalExpires && (
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <span className="text-sm">Expires</span>
                    <span className="font-medium">
                      {new Date(preApprovalExpires).toLocaleDateString()}
                    </span>
                  </div>
                )}

                <Button variant="outline" className="w-full bg-transparent">
                  <Percent className="w-4 h-4 mr-2" /> Request Rate Update
                </Button>
              </CardContent>
            </Card>

            {/* Payment Calculator */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Calculator className="w-5 h-5" />
                  Payment Calculator
                </CardTitle>
                <CardDescription>Estimate your monthly payment based on your pre-approval</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <PaymentCalculator preApprovalAmount={preApprovalAmount} />
              </CardContent>
            </Card>
          </div>

          {/* Lender Contact */}
          {preApprovalLender && (
            <Card>
              <CardHeader>
                <CardTitle>Your Lender</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-lg">
                  <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
                    <Building className="w-6 h-6 text-blue-600" />
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold">{preApprovalLender}</p>
                    <p className="text-sm text-muted-foreground">Contact your agent for lender details</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Neighborhood Tab */}
        <TabsContent value="neighborhood" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="w-5 h-5" />
                Neighborhood Explorer
              </CardTitle>
              <CardDescription>Neighborhood insights for properties you're interested in</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="p-6 border border-dashed rounded-lg text-center space-y-2">
                <MapPin className="h-8 w-8 mx-auto text-muted-foreground" />
                <p className="text-sm font-medium text-muted-foreground">
                  Select a property from your matches to view neighborhood scores, nearby schools, and commute times.
                </p>
              </div>
              <div>
                <h4 className="font-semibold mb-3 flex items-center gap-2">
                  <Car className="w-5 h-5" /> Commute Calculator
                </h4>
                <Card className="border-dashed">
                  <CardContent className="p-4 text-center">
                    <p className="text-muted-foreground text-sm">Add your work address to see commute times</p>
                    <Button variant="outline" className="mt-2 bg-transparent">
                      <MapPin className="w-4 h-4 mr-2" /> Add Work Address
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Activity Tab */}
        <TabsContent value="activity" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Your Search Activity</CardTitle>
              <CardDescription>Recent interactions with properties</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {[
                {
                  type: "showing",
                  property: "456 Oak Lane",
                  date: "2024-01-14",
                  status: "Completed",
                  icon: Calendar,
                },
                { type: "save", property: "789 Maple Dr", date: "2024-01-13", status: "Saved", icon: Heart },
                { type: "view", property: "321 Pine St", date: "2024-01-12", status: "Viewed", icon: Eye },
                {
                  type: "showing",
                  property: "654 Cedar Ave",
                  date: "2024-01-16",
                  status: "Scheduled",
                  icon: Clock,
                },
              ].map((activity, idx) => (
                <div key={idx} className="flex items-center gap-4 p-3 border rounded-lg">
                  <div
                    className={`p-2 rounded-full ${
                      activity.type === "showing"
                        ? "bg-purple-100 text-purple-600"
                        : activity.type === "save"
                          ? "bg-red-100 text-red-600"
                          : "bg-blue-100 text-blue-600"
                    }`}
                  >
                    <activity.icon className="w-4 h-4" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-sm">{activity.property}</p>
                    <p className="text-xs text-muted-foreground">{new Date(activity.date).toLocaleDateString()}</p>
                  </div>
                  <Badge variant="outline">{activity.status}</Badge>
                </div>
              ))}

              <Button variant="outline" className="w-full bg-transparent" asChild>
                <Link href={`/portal/${contactId}/showings`}>
                  View All Showings <ChevronRight className="w-4 h-4 ml-2" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ─── Payment Calculator ───────────────────────────────────────────────────────

function PaymentCalculator({ preApprovalAmount }: { preApprovalAmount: number | null }) {
  const [homePrice, setHomePrice] = useState(preApprovalAmount ?? 400000)
  const [downPct, setDownPct] = useState(20)
  const [rate, setRate] = useState(7.0)

  const loanAmount = homePrice * (1 - downPct / 100)
  const monthlyRate = rate / 100 / 12
  const numPayments = 360
  const pi =
    monthlyRate > 0
      ? (loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, numPayments))) /
        (Math.pow(1 + monthlyRate, numPayments) - 1)
      : loanAmount / numPayments
  const taxes = Math.round(homePrice * 0.012 / 12)
  const insurance = Math.round(homePrice * 0.005 / 12)
  const pmi = downPct < 20 ? Math.round(loanAmount * 0.005 / 12) : 0
  const total = Math.round(pi + taxes + insurance + pmi)

  return (
    <div className="space-y-4">
      <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
        <p className="text-sm text-blue-700 mb-1">Estimated Monthly Payment</p>
        <p className="text-3xl font-bold text-blue-700">${total.toLocaleString()}</p>
        <p className="text-xs text-blue-600 mt-1">For a ${homePrice.toLocaleString()} home</p>
      </div>

      <div className="space-y-2 text-sm">
        <div className="flex justify-between"><span>Principal & Interest</span><span>${Math.round(pi).toLocaleString()}</span></div>
        <div className="flex justify-between"><span>Property Taxes (est.)</span><span>${taxes.toLocaleString()}/mo</span></div>
        <div className="flex justify-between"><span>Home Insurance (est.)</span><span>${insurance.toLocaleString()}/mo</span></div>
        {pmi > 0 && <div className="flex justify-between"><span>PMI</span><span>${pmi.toLocaleString()}/mo</span></div>}
      </div>

      <div className="pt-3 border-t space-y-3">
        <div>
          <div className="flex justify-between text-sm mb-1"><span>Home Price</span><span>${homePrice.toLocaleString()}</span></div>
          <Slider value={[homePrice]} onValueChange={([v]) => setHomePrice(v)} min={100000} max={2000000} step={5000} />
        </div>
        <div>
          <div className="flex justify-between text-sm mb-1"><span>Down Payment</span><span>{downPct}%</span></div>
          <Slider value={[downPct]} onValueChange={([v]) => setDownPct(v)} min={3} max={50} step={1} />
        </div>
        <div>
          <div className="flex justify-between text-sm mb-1"><span>Interest Rate</span><span>{rate.toFixed(2)}%</span></div>
          <Slider value={[rate]} onValueChange={([v]) => setRate(v)} min={3} max={15} step={0.05} />
        </div>
      </div>
    </div>
  )
}
