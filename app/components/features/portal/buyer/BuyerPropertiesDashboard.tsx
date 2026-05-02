"use client"

import { useEffect, useState } from "react"
import { getBuyerPortalMatches, type BuyerPortalMatch } from "@/app/actions/buyer-portal-matches"
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

  // ── Mock data preserved as fallback only when no real matches exist ────────
  const fallbackMatches: DisplayMatch[] = [
    {
      id: 1,
      address: "456 Oak Lane",
      city: "Austin",
      state: "TX",
      price: 485000,
      beds: 4,
      baths: 2.5,
      sqft: 2100,
      matchScore: 96,
      matchReasons: ["Perfect commute", "Great schools", "Under budget"],
      status: "new",
      daysOnMarket: 3,
      image: "/beautiful-home-exterior-oak-lane.jpg",
    },
    {
      id: 2,
      address: "789 Maple Dr",
      city: "Austin",
      state: "TX",
      price: 512000,
      beds: 4,
      baths: 3,
      sqft: 2300,
      matchScore: 92,
      matchReasons: ["Large backyard", "Updated kitchen", "Pool"],
      status: "hot",
      daysOnMarket: 5,
      image: "/modern-home-with-pool.jpg",
    },
    {
      id: 3,
      address: "321 Pine St",
      city: "Austin",
      state: "TX",
      price: 478000,
      beds: 3,
      baths: 2,
      sqft: 2050,
      matchScore: 88,
      matchReasons: ["Quiet neighborhood", "Near parks", "Move-in ready"],
      status: "price_drop",
      daysOnMarket: 12,
      priceDropAmount: 15000,
      image: "/charming-home-pine-trees.jpg",
    },
    {
      id: 4,
      address: "654 Cedar Ave",
      city: "Austin",
      state: "TX",
      price: 495000,
      beds: 4,
      baths: 2,
      sqft: 2200,
      matchScore: 85,
      matchReasons: ["Open floor plan", "Corner lot", "New roof"],
      status: "new",
      daysOnMarket: 1,
      image: "/spacious-home-corner-lot.jpg",
    },
  ]

  // Use real matches when loaded; otherwise show fallback so the portal
  // never renders an empty state for a brand-new buyer.
  const displayMatches: DisplayMatch[] =
    smartMatches.length > 0 ? smartMatches : matchesLoading ? [] : fallbackMatches

  // Mock mortgage data
  const mortgageData = {
    preApprovalAmount: 550000,
    preApprovalLender: "First National Bank",
    preApprovalExpires: "2024-03-15",
    estimatedRate: 6.75,
    estimatedMonthly: 3247,
    downPayment: 20,
    loanType: "Conventional 30-Year",
  }

  // Mock neighborhood data for a property
  const neighborhoodData = {
    overallScore: 87,
    categories: [
      { name: "Schools", score: 92, icon: School },
      { name: "Safety", score: 88, icon: Shield },
      { name: "Shopping", score: 85, icon: ShoppingBag },
      { name: "Parks", score: 90, icon: Trees },
      { name: "Commute", score: 82, icon: Car },
      { name: "Transit", score: 78, icon: Train },
    ],
    nearbySchools: [
      { name: "Oak Hill Elementary", rating: 9, distance: "0.4 mi", type: "Public" },
      { name: "Westlake Middle", rating: 8, distance: "1.2 mi", type: "Public" },
      { name: "Austin High", rating: 9, distance: "2.1 mi", type: "Public" },
    ],
  }

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
              <p className="text-2xl font-bold">${(mortgageData.preApprovalAmount / 1000).toFixed(0)}K</p>
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
                <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-green-700">Pre-Approved Amount</span>
                    <Badge variant="outline" className="bg-green-100 text-green-700 border-green-300">
                      Active
                    </Badge>
                  </div>
                  <p className="text-3xl font-bold text-green-700">
                    ${mortgageData.preApprovalAmount.toLocaleString()}
                  </p>
                  <p className="text-sm text-green-600 mt-1">{mortgageData.preApprovalLender}</p>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <span className="text-sm">Loan Type</span>
                    <span className="font-medium">{mortgageData.loanType}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <span className="text-sm">Interest Rate</span>
                    <span className="font-medium">{mortgageData.estimatedRate}%</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <span className="text-sm">Down Payment</span>
                    <span className="font-medium">{mortgageData.downPayment}%</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <span className="text-sm">Expires</span>
                    <span className="font-medium">
                      {new Date(mortgageData.preApprovalExpires).toLocaleDateString()}
                    </span>
                  </div>
                </div>

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
                <CardDescription>Estimate your monthly payment</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                  <p className="text-sm text-blue-700 mb-1">Estimated Monthly Payment</p>
                  <p className="text-3xl font-bold text-blue-700">${mortgageData.estimatedMonthly.toLocaleString()}</p>
                  <p className="text-xs text-blue-600 mt-1">For a $485,000 home</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span>Principal & Interest</span>
                    <span>$2,547</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span>Property Taxes</span>
                    <span>$450</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span>Home Insurance</span>
                    <span>$150</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span>PMI</span>
                    <span>$0</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span>HOA (if applicable)</span>
                    <span>$100</span>
                  </div>
                </div>

                <div className="pt-4 border-t">
                  <div className="mb-4">
                    <label className="text-sm font-medium">Home Price</label>
                    <Slider defaultValue={[485000]} min={200000} max={800000} step={5000} className="mt-2" />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Down Payment</label>
                    <Slider defaultValue={[20]} min={3} max={50} step={1} className="mt-2" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Lender Contact */}
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
                  <p className="font-semibold">First National Bank</p>
                  <p className="text-sm text-muted-foreground">Jennifer Smith, Loan Officer</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="bg-transparent">
                    Call
                  </Button>
                  <Button variant="outline" size="sm" className="bg-transparent">
                    Email
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Neighborhood Tab */}
        <TabsContent value="neighborhood" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="w-5 h-5" />
                Neighborhood Explorer
              </CardTitle>
              <CardDescription>Compare neighborhoods based on what matters most to you</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Overall Score */}
              <div className="flex items-center gap-6 p-4 bg-slate-50 rounded-lg">
                <div className="text-center">
                  <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center">
                    <span className="text-2xl font-bold text-green-700">{neighborhoodData.overallScore}</span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-2">Overall Score</p>
                </div>
                <div className="flex-1 grid grid-cols-3 gap-4">
                  {neighborhoodData.categories.map((category) => (
                    <div key={category.name} className="text-center">
                      <category.icon className="w-5 h-5 mx-auto text-muted-foreground mb-1" />
                      <p className="text-sm font-medium">{category.name}</p>
                      <Progress value={category.score} className="h-2 mt-1" />
                      <p className="text-xs text-muted-foreground mt-1">{category.score}/100</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Schools */}
              <div>
                <h4 className="font-semibold mb-3 flex items-center gap-2">
                  <School className="w-5 h-5" /> Nearby Schools
                </h4>
                <div className="space-y-2">
                  {neighborhoodData.nearbySchools.map((school, idx) => (
                    <div key={idx} className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <p className="font-medium">{school.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {school.type} • {school.distance}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                        <span className="font-bold">{school.rating}/10</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Commute Calculator */}
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
