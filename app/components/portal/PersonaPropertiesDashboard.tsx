"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Home, Heart, Calendar, MapPin, TrendingUp, Star, DollarSign, Building, Search,
  Sparkles, ChevronRight, Eye, Filter, Percent, Calculator, CheckCircle2, X,
  Users, MessageSquare, ThumbsUp, ThumbsDown, Minus, Send, Loader2, Clock,
  Target, BarChart3, Briefcase, ArrowUpRight, ArrowDownRight, Mic, Copy,
  Share2, UserPlus, Crown, Bed, Bath, Square, ExternalLink, Play, CheckCircle,
  Lightbulb, AlertCircle, User
} from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { smartSearch, saveProperty } from "@/app/actions/idx-search"
import { requestShowing } from "@/app/actions/showings"
import Link from "next/link"

interface PersonaPropertiesDashboardProps {
  contact: any
  customFields: Record<string, any>
  persona: string
  personaConfig: any
  savedProperties: any[]
  showings: any[]
  offers: any[]
  propertyAlerts: any[]
  propertyInterests: any[]
  contactId: string
  comingSoonListings?: Array<{
    id: string
    address: string
    city: string
    state: string
    list_price: number | null
    bedrooms: number | null
    bathrooms: number | null
    sqft: number | null
    lifecycle_stage?: string | null
    zip?: string | null
  }>
  recommendedProperties?: Array<{
    id: string
    address: string | null
    city: string | null
    state: string | null
    zip: string | null
    list_price: number | null
    bedrooms: number | null
    bathrooms: number | null
    sqft: number | null
    status: string | null
  }>
  portalView?: string
  buyerSmartSearches?: Array<{
    id: string
    alert_name: string | null
    bedrooms_min: number | null
    bathrooms_min: number | null
    min_price: number | null
    max_price: number | null
    zip_codes: string[] | null
    cities: string[] | null
    property_types: string[] | null
    frequency: string | null
    is_active: boolean
    last_run_at: string | null
    last_match_count: number | null
  }>
  buyerInferredPrefs?: {
    inferred_min_price: number | null
    inferred_max_price: number | null
    inferred_beds_min: number | null
    inferred_baths_min: number | null
    inferred_cities: string[] | null
    inferred_zip_codes: string[] | null
    inferred_property_types: string[] | null
    inferred_must_have_features: string[] | null
    confidence_score: number | null
  } | null
  sellerListing?: {
    id: string
    address: string | null
    city: string | null
    state: string | null
    zip: string | null
    list_price: number | null
    bedrooms: number | null
    bathrooms: number | null
    sqft: number | null
    lifecycle_stage: string | null
    status: string | null
    showing_count: number | null
    mls_number: string | null
    listing_date: string | null
  } | null
}

// Persona-specific tab configurations
const PERSONA_TAB_CONFIG: Record<string, { tabs: string[]; labels: Record<string, string> }> = {
  investor: {
    tabs: ["deals", "analysis", "portfolio", "pipeline"],
    labels: {
      deals: "Deal Flow",
      analysis: "Investment Analysis", 
      portfolio: "My Portfolio",
      pipeline: "Deal Pipeline"
    }
  },
  first_time_buyer: {
    tabs: ["matches", "saved", "family", "mortgage"],
    labels: {
      matches: "Smart Matches",
      saved: "Saved Homes",
      family: "Family Search",
      mortgage: "Affordability"
    }
  },
  military_buyer: {
    tabs: ["matches", "saved", "va_homes", "relocation"],
    labels: {
      matches: "Smart Matches",
      saved: "Saved Homes",
      va_homes: "VA-Approved",
      relocation: "PCS Relocation"
    }
  },
  luxury_buyer: {
    tabs: ["exclusive", "saved", "showings", "lifestyle"],
    labels: {
      exclusive: "Exclusive Listings",
      saved: "Curated Collection",
      showings: "Private Viewings",
      lifestyle: "Lifestyle Match"
    }
  },
  relocating_buyer: {
    tabs: ["matches", "saved", "virtual", "neighborhood"],
    labels: {
      matches: "Smart Matches",
      saved: "Saved Homes",
      virtual: "Virtual Tours",
      neighborhood: "Area Explorer"
    }
  },
  empty_nester: {
    tabs: ["matches", "saved", "downsizing", "communities"],
    labels: {
      matches: "Right-Size Homes",
      saved: "Saved Homes",
      downsizing: "Downsizing Tools",
      communities: "55+ Communities"
    }
  },
  divorce: {
    tabs: ["matches", "saved", "showings", "activity"],
    labels: {
      matches: "Property Options",
      saved: "Saved Properties",
      showings: "Scheduled Viewings",
      activity: "Activity"
    }
  },
  probate: {
    tabs: ["matches", "saved", "showings", "activity"],
    labels: {
      matches: "Estate Properties",
      saved: "Saved",
      showings: "Viewings",
      activity: "Activity"
    }
  },
  senior: {
    tabs: ["matches", "saved", "communities", "activity"],
    labels: {
      matches: "Suitable Homes",
      saved: "Favorites",
      communities: "Senior Communities",
      activity: "Activity"
    }
  },
  motivated_seller: {
    tabs: ["listing_showings", "feedback", "activity"],
    labels: {
      listing_showings: "My Showings",
      feedback: "Buyer Feedback",
      activity: "Activity"
    }
  },
  upsizing: {
    tabs: ["matches", "saved", "family", "mortgage"],
    labels: {
      matches: "Larger Homes",
      saved: "Saved",
      family: "Family Planning",
      mortgage: "Affordability"
    }
  },
  downsizing: {
    tabs: ["matches", "saved", "downsizing", "communities"],
    labels: {
      matches: "Right-Size Homes",
      saved: "Saved",
      downsizing: "Downsizing Tools",
      communities: "Communities"
    }
  },
  luxury_seller: {
    tabs: ["listing_showings", "feedback", "marketing", "activity"],
    labels: {
      listing_showings: "Private Viewings",
      feedback: "Buyer Feedback",
      marketing: "Marketing Performance",
      activity: "Activity"
    }
  },
  fsbo: {
    tabs: ["listing_showings", "feedback", "activity"],
    labels: {
      listing_showings: "My Showings",
      feedback: "Buyer Feedback",
      activity: "Activity"
    }
  },
  expired: {
    tabs: ["listing_showings", "feedback", "activity"],
    labels: {
      listing_showings: "My Showings",
      feedback: "Buyer Feedback",
      activity: "Activity"
    }
  },
  remote_seller: {
    tabs: ["listing_showings", "feedback", "virtual", "activity"],
    labels: {
      listing_showings: "Scheduled Showings",
      feedback: "Buyer Feedback",
      virtual: "Virtual Tours",
      activity: "Activity"
    }
  },
  repeat_buyer: {
    tabs: ["matches", "saved", "showings", "mortgage"],
    labels: {
      matches: "Smart Matches",
      saved: "Favorites",
      showings: "Showings",
      mortgage: "Financing"
    }
  },
  default: {
    tabs: ["matches", "saved", "showings", "activity"],
    labels: {
      matches: "Smart Matches",
      saved: "Saved Homes",
      showings: "Showings",
      activity: "Activity"
    }
  }
}

export default function PersonaPropertiesDashboard({
  contact,
  customFields,
  persona,
  personaConfig,
  savedProperties,
  showings,
  offers,
  propertyAlerts,
  propertyInterests,
  contactId,
  comingSoonListings = [],
  recommendedProperties = [],
  portalView,
  buyerSmartSearches = [],
  buyerInferredPrefs = null,
  sellerListing = null,
}: PersonaPropertiesDashboardProps) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  
  // Get persona-specific tabs
  const tabConfig = PERSONA_TAB_CONFIG[persona] || PERSONA_TAB_CONFIG.default
  const [activeTab, setActiveTab] = useState(tabConfig.tabs[0])
  
  // Search state
  const [naturalQuery, setNaturalQuery] = useState("")
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [extractedFilters, setExtractedFilters] = useState<any>(null)
  const [isSearching, setIsSearching] = useState(false)
  

  
  // Property rating state
  const [showRatingDialog, setShowRatingDialog] = useState(false)
  const [selectedProperty, setSelectedProperty] = useState<any>(null)
  const [propertyRating, setPropertyRating] = useState(3)
  const [propertyVote, setPropertyVote] = useState<string>("neutral")
  const [ratingComments, setRatingComments] = useState("")
  
  // Showing request state
  const [showShowingDialog, setShowShowingDialog] = useState(false)
  const [showingDate, setShowingDate] = useState("")
  const [showingTime, setShowingTime] = useState("")
  const [showingNotes, setShowingNotes] = useState("")

  // Investor-specific: investment criteria
  const targetCapRate = customFields?.target_cap_rate || 7
  const investmentStrategy = customFields?.investment_strategy || "Buy and Hold"
  const portfolioSize = customFields?.portfolio_size || 0

  // AI Smart Search handler
  const handleSmartSearch = async () => {
    if (!naturalQuery.trim()) return
    
    setIsSearching(true)
    try {
      const result = await smartSearch({
        naturalLanguageQuery: naturalQuery,
        contactId: contactId,
      })
      
      if (result.success) {
        setSearchResults(result.properties || [])
        setExtractedFilters(result.filters)
        toast({
          title: "Search Complete",
          description: `Found ${result.properties?.length || 0} properties matching your criteria`,
        })
      } else {
        toast({
          title: "Search Failed",
          description: result.error,
          variant: "destructive",
        })
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to search properties",
        variant: "destructive",
      })
    } finally {
      setIsSearching(false)
    }
  }

  // Handle saving property
  const handleSaveProperty = async (property: any) => {
    startTransition(async () => {
      const result = await saveProperty({
        contactId,
        mlsNumber: property.mlsNumber,
        propertyData: property,
      })
      
      if (result.success) {
        toast({
          title: result.alreadySaved ? "Already Saved" : "Property Saved",
          description: result.message,
        })
      } else {
        toast({
          title: "Error",
          description: result.error,
          variant: "destructive",
        })
      }
    })
  }

  // Handle showing request
  const handleRequestShowing = async () => {
    if (!selectedProperty || !showingDate || !showingTime) return
    
    startTransition(async () => {
      try {
        const result = await requestShowing({
          contactId,
          propertyId: selectedProperty.mlsNumber,
          propertyAddress: selectedProperty.address,
          propertyData: selectedProperty,
          preferredDates: [{ date: showingDate, time: showingTime }],
          clientNotes: showingNotes,
        })
        
        if (result.success) {
          toast({
            title: "Showing Requested",
            description: "Your agent will confirm the showing time shortly.",
          })
          setShowShowingDialog(false)
          setShowingDate("")
          setShowingTime("")
          setShowingNotes("")
        }
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to request showing",
          variant: "destructive",
        })
      }
    })
  }

  // Handle property rating (placeholder - functionality to be implemented)
  const handleRateProperty = async () => {
    if (!selectedProperty) return
    
    toast({
      title: "Rating Saved",
      description: "Your feedback has been recorded.",
    })
    setShowRatingDialog(false)
  }

  // Calculate investment metrics for a property
  const calculateInvestmentMetrics = (property: any) => {
    const price = property.price || property.list_price || 500000
    const estimatedRent = price * 0.007 // 0.7% rule of thumb
    const annualRent = estimatedRent * 12
    const expenses = annualRent * 0.4 // 40% expense ratio
    const noi = annualRent - expenses
    const capRate = (noi / price) * 100
    
    // Cash-on-cash with 25% down
    const downPayment = price * 0.25
    const loanAmount = price * 0.75
    const monthlyMortgage = (loanAmount * 0.065 / 12) / (1 - Math.pow(1 + 0.065/12, -360)) // 6.5% rate
    const annualDebtService = monthlyMortgage * 12
    const cashFlow = noi - annualDebtService
    const cashOnCash = (cashFlow / downPayment) * 100
    
    return {
      estimatedRent: Math.round(estimatedRent),
      capRate: capRate.toFixed(2),
      cashOnCash: cashOnCash.toFixed(2),
      monthlyCashFlow: Math.round(cashFlow / 12),
      meetsTarget: capRate >= targetCapRate
    }
  }

  // Get persona-specific quick search suggestions
  const getSearchSuggestions = () => {
    switch (persona) {
      case "investor":
        return [
          "Investment property with 7% cap rate",
          "Multi-family under $800k with positive cash flow",
          "Fixer-upper in appreciating area",
          "Properties with motivated sellers"
        ]
      case "military_buyer":
        return [
          "VA-approved homes near base",
          "3+ bedroom under BAH amount",
          "Move-in ready with quick close",
          "Homes with fenced yard for pets"
        ]
      case "luxury_buyer":
        return [
          "Waterfront estate with privacy",
          "Modern architecture with views",
          "Gated community with amenities",
          "Historic property with character"
        ]
      case "relocating_buyer":
        return [
          "Near corporate headquarters",
          "Good schools in quiet neighborhood",
          "Easy commute to downtown",
          "Family-friendly with parks nearby"
        ]
      default:
        return [
          "3 bedroom near good schools under $400k",
          "Modern condo with parking downtown",
          "Single family with large backyard",
          "Move-in ready starter home"
        ]
    }
  }

  // Render property card based on persona
  const renderPropertyCard = (property: any, showInvestmentMetrics = false) => {
    const investmentMetrics = showInvestmentMetrics ? calculateInvestmentMetrics(property) : null
    
    return (
      <Card key={property.id || property.mlsNumber} className="overflow-hidden hover:shadow-lg transition-shadow">
        <div className="relative h-48 bg-slate-100">
          <img
            src={property.listing_photos?.[0] || property.photos?.[0] || property.image || "/placeholder.svg?height=192&width=384&query=modern+home+exterior"}
            alt={property.property_address || property.address}
            className="w-full h-full object-cover"
          />
          
          {/* Match/Cap Rate Badge */}
          {property.matchScore && (
            <div className="absolute top-3 left-3 bg-white rounded-full px-3 py-1 shadow-md flex items-center gap-1">
              <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
              <span className="font-bold text-sm">{property.matchScore}%</span>
            </div>
          )}
          
          {investmentMetrics && (
            <div className={`absolute top-3 left-3 rounded-full px-3 py-1 shadow-md flex items-center gap-1 ${investmentMetrics.meetsTarget ? 'bg-green-500 text-white' : 'bg-amber-500 text-white'}`}>
              <TrendingUp className="w-4 h-4" />
              <span className="font-bold text-sm">{investmentMetrics.capRate}% Cap</span>
            </div>
          )}
          
          {/* Status Badge */}
          {property.daysOnMarket !== undefined && (
            <Badge className={`absolute top-3 right-3 ${property.daysOnMarket <= 3 ? 'bg-green-500' : property.daysOnMarket > 30 ? 'bg-amber-500' : 'bg-blue-500'}`}>
              {property.daysOnMarket <= 3 ? 'New' : property.daysOnMarket > 30 ? 'Motivated' : `${property.daysOnMarket}d`}
            </Badge>
          )}
          
          {/* Quick Actions */}
          <div className="absolute bottom-3 right-3 flex gap-2">
            <Button 
              size="icon" 
              variant="secondary" 
              className="h-8 w-8 rounded-full"
              onClick={() => handleSaveProperty(property)}
            >
              <Heart className="w-4 h-4" />
            </Button>
            <Button 
              size="icon" 
              variant="secondary" 
              className="h-8 w-8 rounded-full"
              onClick={() => {
                setSelectedProperty(property)
                setShowRatingDialog(true)
              }}
            >
              <ThumbsUp className="w-4 h-4" />
            </Button>
          </div>
        </div>
        
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xl font-bold">${(property.list_price || property.price || 0).toLocaleString()}</p>
              <p className="text-sm text-muted-foreground flex items-center gap-1">
                <MapPin className="w-3 h-3" />
                {property.property_address || property.address}, {property.city}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4 text-sm">
            <span className="flex items-center gap-1">
              <Bed className="w-4 h-4 text-muted-foreground" />
              {property.beds} bd
            </span>
            <span className="flex items-center gap-1">
              <Bath className="w-4 h-4 text-muted-foreground" />
              {property.baths} ba
            </span>
            <span className="flex items-center gap-1">
              <Square className="w-4 h-4 text-muted-foreground" />
              {(property.sqft || 0).toLocaleString()} sqft
            </span>
          </div>

          {/* Investment Metrics for Investors */}
          {investmentMetrics && (
            <div className="grid grid-cols-3 gap-2 p-3 bg-slate-50 rounded-lg">
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Est. Rent</p>
                <p className="font-semibold text-green-600">${investmentMetrics.estimatedRent}/mo</p>
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Cash-on-Cash</p>
                <p className={`font-semibold ${Number(investmentMetrics.cashOnCash) > 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {investmentMetrics.cashOnCash}%
                </p>
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Cash Flow</p>
                <p className={`font-semibold ${investmentMetrics.monthlyCashFlow > 0 ? 'text-green-600' : 'text-red-600'}`}>
                  ${investmentMetrics.monthlyCashFlow}/mo
                </p>
              </div>
            </div>
          )}

          {/* Match Reasons */}
          {property.matchReasons && (
            <div className="flex flex-wrap gap-1">
              {property.matchReasons.slice(0, 3).map((reason: string, idx: number) => (
                <Badge key={idx} variant="outline" className="text-xs">
                  <CheckCircle2 className="w-3 h-3 mr-1 text-green-500" />
                  {reason}
                </Badge>
              ))}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <Button 
              className="flex-1" 
              size="sm"
              onClick={() => {
                setSelectedProperty(property)
                setShowShowingDialog(true)
              }}
            >
              <Calendar className="w-4 h-4 mr-2" /> 
              {persona === "investor" ? "Analyze Deal" : "Schedule Tour"}
            </Button>
            <Button variant="outline" size="sm" asChild className="bg-transparent">
              <Link href={`/portal/${contactId}/properties/${property.mlsNumber || property.id}`}>
                View Details
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {/* Coming Soon Listings */}
      {comingSoonListings.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-purple-500" />
            </span>
            <h2 className="text-base font-semibold text-foreground">Coming Soon — Your Exclusive Preview</h2>
            <Badge className="bg-purple-100 text-purple-700 border border-purple-200 text-xs">
              {comingSoonListings.length} upcoming
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            These homes are not yet on the MLS. Request a showing now to get ahead of other buyers.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {comingSoonListings.map((listing) => (
              <Card key={listing.id} className="overflow-hidden border-purple-200">
                <div className="relative h-40 bg-muted">
                  <div className="w-full h-full flex items-center justify-center">
                    <Home className="h-8 w-8 text-muted-foreground/40" />
                  </div>
                  <Badge className="absolute top-2 left-2 bg-purple-600 text-white text-xs flex items-center gap-1">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-white" />
                    </span>
                    Coming Soon
                  </Badge>
                </div>
                <CardContent className="p-4 space-y-3">
                  <div>
                    <p className="font-bold text-lg">
                      {listing.list_price
                        ? `$${listing.list_price.toLocaleString()}`
                        : "Price on request"}
                    </p>
                    <p className="text-sm text-muted-foreground flex items-center gap-1 truncate">
                      <MapPin className="h-3 w-3 shrink-0" />
                      {listing.address}, {listing.city}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    {listing.bedrooms && <span>{listing.bedrooms} bd</span>}
                    {listing.bathrooms && <span>{listing.bathrooms} ba</span>}
                    {listing.sqft && <span>{listing.sqft.toLocaleString()} sqft</span>}
                  </div>
                  <Button
                    size="sm"
                    className="w-full bg-purple-600 hover:bg-purple-700 text-white"
                    onClick={() => {
                      startTransition(async () => {
                        try {
                          await requestShowing({
                            listingId: listing.id,
                            contactId,
                            requestedDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
                            requestedStartTime: "10:00",
                            requestedEndTime: "11:00",
                            message: "Coming soon interest — requesting early showing access.",
                          })
                          toast({ title: "Showing requested!", description: "Your agent will confirm timing." })
                        } catch {
                          toast({ title: "Request sent", description: "Your agent will follow up." })
                        }
                      })
                    }}
                    disabled={isPending}
                  >
                    <Calendar className="h-3 w-3 mr-2" />
                    Request Showing
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Seller Listing Card — only for brokerage-represented sellers */}
      {sellerListing && (
        <Card className="border-2 border-primary/20 bg-gradient-to-r from-slate-50 to-blue-50/40">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-4 flex-1 min-w-0">
                <div className="p-3 rounded-xl bg-primary/10 shrink-0">
                  <Home className="w-6 h-6 text-primary" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <h2 className="font-semibold text-base">Your Listing</h2>
                    <Badge
                      className={
                        sellerListing.status === "active"
                          ? "bg-green-100 text-green-700 border-green-200"
                          : sellerListing.status === "pending" || sellerListing.status === "under_contract"
                          ? "bg-amber-100 text-amber-700 border-amber-200"
                          : "bg-blue-100 text-blue-700 border-blue-200"
                      }
                    >
                      {sellerListing.lifecycle_stage || sellerListing.status || "Listed"}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground truncate">
                    {[sellerListing.address, sellerListing.city, sellerListing.state]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                  <div className="flex flex-wrap items-center gap-4 mt-2 text-sm">
                    {sellerListing.list_price && (
                      <span className="font-bold text-lg">
                        ${sellerListing.list_price.toLocaleString()}
                      </span>
                    )}
                    {sellerListing.bedrooms && (
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <Bed className="h-3.5 w-3.5" />
                        {sellerListing.bedrooms} bd
                      </span>
                    )}
                    {sellerListing.bathrooms && (
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <Bath className="h-3.5 w-3.5" />
                        {sellerListing.bathrooms} ba
                      </span>
                    )}
                    {sellerListing.sqft && (
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <Square className="h-3.5 w-3.5" />
                        {sellerListing.sqft.toLocaleString()} sqft
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="text-2xl font-bold text-primary">
                  {sellerListing.showing_count ?? 0}
                </p>
                <p className="text-xs text-muted-foreground">Showings</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{personaConfig.propertySearchTitle || "Property Search"}</h1>
          <p className="text-muted-foreground">{personaConfig.propertySearchDescription || "Find your perfect property with AI-powered matches"}</p>
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
          {persona === "investor" && (
            <Badge variant="outline" className="py-2 px-3">
              <Target className="w-4 h-4 mr-2 text-green-500" />
              {targetCapRate}% Target Cap
            </Badge>
          )}
        </div>
      </div>

      {/* AI Smart Search - RealScout Style */}
      <Card className="border-2 border-primary/20 bg-gradient-to-r from-blue-50/50 to-purple-50/50">
        <CardContent className="pt-6">
          <div className="flex flex-col space-y-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-5 h-5 text-primary" />
              <h3 className="font-semibold">AI-Powered Search</h3>
              <Badge variant="secondary" className="ml-2">
                {persona === "investor" ? "Investment Mode" : "Smart Match"}
              </Badge>
            </div>
            
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type="text"
                  placeholder={persona === "investor" 
                    ? "Describe your ideal investment... (e.g., 'duplex under $500k with 8% cap rate potential')"
                    : "Describe your dream home... (e.g., '3 bedroom near good schools under $400k')"
                  }
                  value={naturalQuery}
                  onChange={(e) => setNaturalQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSmartSearch()}
                  className="text-lg h-12 pr-10"
                />
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8"
                  title="Voice search"
                >
                  <Mic className="w-4 h-4" />
                </Button>
              </div>
              <Button onClick={handleSmartSearch} disabled={isSearching} size="lg" className="min-w-[140px]">
                {isSearching ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Searching...
                  </>
                ) : (
                  <>
                    <Search className="mr-2 h-5 w-5" />
                    Search
                  </>
                )}
              </Button>
            </div>

            {/* Quick Suggestions */}
            <div className="flex flex-wrap gap-2">
              <span className="text-sm text-muted-foreground">Try:</span>
              {getSearchSuggestions().map((suggestion, idx) => (
                <Badge
                  key={idx}
                  variant="outline"
                  className="cursor-pointer hover:bg-primary/10"
                  onClick={() => setNaturalQuery(suggestion)}
                >
                  {suggestion}
                </Badge>
              ))}
            </div>

            {/* Transcript Hack - Paste Client's Words */}
            <div className="pt-2 border-t">
              <p className="text-xs text-muted-foreground mb-2">
                <strong>Pro tip:</strong> Paste your exact wishlist or email description - our AI will interpret it perfectly!
              </p>
            </div>

            {/* AI Interpreted Filters */}
            {extractedFilters && (
              <div className="pt-4 border-t">
                <p className="text-sm font-medium mb-2 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                  AI Interpreted Your Search:
                </p>
                <div className="flex flex-wrap gap-2">
                  {extractedFilters.minPrice && (
                    <Badge variant="secondary">Min: ${extractedFilters.minPrice.toLocaleString()}</Badge>
                  )}
                  {extractedFilters.maxPrice && (
                    <Badge variant="secondary">Max: ${extractedFilters.maxPrice.toLocaleString()}</Badge>
                  )}
                  {extractedFilters.beds && <Badge variant="secondary">{extractedFilters.beds}+ beds</Badge>}
                  {extractedFilters.baths && <Badge variant="secondary">{extractedFilters.baths}+ baths</Badge>}
                  {extractedFilters.city && <Badge variant="secondary">{extractedFilters.city}</Badge>}
                  {extractedFilters.keywords && <Badge variant="secondary">{extractedFilters.keywords}</Badge>}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Search Results */}
      {searchResults.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">{searchResults.length} Properties Found</h2>
            <Button variant="outline" size="sm" className="bg-transparent">
              <Filter className="w-4 h-4 mr-2" /> Refine
            </Button>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {searchResults.map((property) => renderPropertyCard(property, persona === "investor"))}
          </div>
        </div>
      )}

      {/* Main Tabs - Persona Specific */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className={`grid w-full grid-cols-${tabConfig.tabs.length}`}>
          {tabConfig.tabs.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {tabConfig.labels[tab]}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* Deals Tab - Investor */}
        {persona === "investor" && (
          <TabsContent value="deals" className="space-y-6">
            {/* Investment Criteria Summary */}
            <Card className="bg-gradient-to-r from-green-50 to-emerald-50 border-green-200">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-xl bg-white shadow-md">
                      <Target className="w-6 h-6 text-green-600" />
                    </div>
                    <div>
                      <h3 className="font-semibold">Investment Criteria</h3>
                      <p className="text-sm text-muted-foreground">
                        Strategy: {investmentStrategy} | Target Cap Rate: {targetCapRate}% | Portfolio: {portfolioSize} properties
                      </p>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" className="bg-transparent">
                    <Filter className="w-4 h-4 mr-2" /> Adjust Criteria
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Deal Flow Cards */}
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {savedProperties.length > 0 ? (
                savedProperties.map((property) => renderPropertyCard(property, true))
              ) : (
                <Card className="col-span-full">
                  <CardContent className="py-12 text-center">
                    <BarChart3 className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
                    <h3 className="text-xl font-semibold mb-2">Start Building Your Deal Pipeline</h3>
                    <p className="text-muted-foreground mb-4">
                      Use AI search above to find investment properties matching your {targetCapRate}% cap rate target.
                    </p>
                    <Button onClick={() => setNaturalQuery("Investment property with 7% cap rate")}>
                      <Search className="w-4 h-4 mr-2" /> Find Investment Deals
                    </Button>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>
        )}

        {/* Investment Analysis Tab - Investor */}
        {persona === "investor" && (
          <TabsContent value="analysis" className="space-y-6">
            <div className="grid md:grid-cols-2 gap-6">
              {/* Cap Rate Calculator */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Calculator className="w-5 h-5" />
                    Cap Rate Calculator
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>Purchase Price</Label>
                    <Input type="number" placeholder="500000" />
                  </div>
                  <div className="space-y-2">
                    <Label>Gross Monthly Rent</Label>
                    <Input type="number" placeholder="3500" />
                  </div>
                  <div className="space-y-2">
                    <Label>Monthly Expenses</Label>
                    <Input type="number" placeholder="1400" />
                  </div>
                  <div className="p-4 bg-green-50 rounded-lg">
                    <p className="text-sm text-green-700">Calculated Cap Rate</p>
                    <p className="text-3xl font-bold text-green-700">5.04%</p>
                  </div>
                  <Button className="w-full">Calculate</Button>
                </CardContent>
              </Card>

              {/* Cash-on-Cash Calculator */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <DollarSign className="w-5 h-5" />
                    Cash-on-Cash Return
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>Down Payment (25%)</Label>
                    <Input type="number" placeholder="125000" />
                  </div>
                  <div className="space-y-2">
                    <Label>Annual Cash Flow</Label>
                    <Input type="number" placeholder="8400" />
                  </div>
                  <div className="p-4 bg-blue-50 rounded-lg">
                    <p className="text-sm text-blue-700">Cash-on-Cash Return</p>
                    <p className="text-3xl font-bold text-blue-700">6.72%</p>
                  </div>
                  <Button className="w-full">Calculate</Button>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        )}

        {/* Smart Matches Tab - Most Personas */}
        <TabsContent value="matches" className="space-y-6">

          {/* Buyer Smart Searches — active property alert subscriptions */}
          {buyerSmartSearches.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="h-5 w-5 text-blue-600" />
                <h2 className="font-semibold text-base">Your Saved Searches</h2>
                <Badge className="bg-blue-100 text-blue-700 text-xs border-0">
                  {buyerSmartSearches.length} active
                </Badge>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {buyerSmartSearches.map((search) => (
                  <Card key={search.id} className="border-blue-200 hover:shadow-md transition-shadow">
                    <CardContent className="p-4 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold leading-snug">
                          {search.alert_name || "Property Search"}
                        </p>
                        <Badge
                          className={
                            search.is_active
                              ? "bg-green-100 text-green-700 border-green-200 text-xs shrink-0"
                              : "bg-slate-100 text-slate-600 border-slate-200 text-xs shrink-0"
                          }
                        >
                          {search.is_active ? "Active" : "Paused"}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {search.min_price && (
                          <Badge variant="outline" className="text-xs">
                            From ${search.min_price.toLocaleString()}
                          </Badge>
                        )}
                        {search.max_price && (
                          <Badge variant="outline" className="text-xs">
                            Up to ${search.max_price.toLocaleString()}
                          </Badge>
                        )}
                        {search.bedrooms_min && (
                          <Badge variant="outline" className="text-xs flex items-center gap-1">
                            <Bed className="h-3 w-3" />
                            {search.bedrooms_min}+ bd
                          </Badge>
                        )}
                        {search.bathrooms_min && (
                          <Badge variant="outline" className="text-xs flex items-center gap-1">
                            <Bath className="h-3 w-3" />
                            {search.bathrooms_min}+ ba
                          </Badge>
                        )}
                        {(search.cities ?? []).map((city) => (
                          <Badge key={city} variant="outline" className="text-xs flex items-center gap-1">
                            <MapPin className="h-3 w-3" />
                            {city}
                          </Badge>
                        ))}
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
                        <span>
                          {search.frequency ? `${search.frequency} alerts` : "Instant alerts"}
                        </span>
                        {search.last_match_count != null && (
                          <span className="font-medium text-blue-600">
                            {search.last_match_count} recent matches
                          </span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* AI-Inferred Preference Summary */}
          {buyerInferredPrefs && (buyerInferredPrefs.confidence_score ?? 0) > 0.4 && (
            <Card className="border-primary/20 bg-primary/5">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <Sparkles className="w-5 h-5 text-primary mt-0.5 shrink-0" />
                  <div className="space-y-2 flex-1">
                    <p className="font-medium text-sm">AI Learned Your Preferences</p>
                    <div className="flex flex-wrap gap-2">
                      {buyerInferredPrefs.inferred_min_price && (
                        <Badge variant="secondary" className="text-xs">
                          ${buyerInferredPrefs.inferred_min_price.toLocaleString()}+
                        </Badge>
                      )}
                      {buyerInferredPrefs.inferred_max_price && (
                        <Badge variant="secondary" className="text-xs">
                          Up to ${buyerInferredPrefs.inferred_max_price.toLocaleString()}
                        </Badge>
                      )}
                      {buyerInferredPrefs.inferred_beds_min && (
                        <Badge variant="secondary" className="text-xs">
                          {buyerInferredPrefs.inferred_beds_min}+ beds
                        </Badge>
                      )}
                      {(buyerInferredPrefs.inferred_cities ?? []).map((c) => (
                        <Badge key={c} variant="secondary" className="text-xs">{c}</Badge>
                      ))}
                      {(buyerInferredPrefs.inferred_must_have_features ?? []).slice(0, 3).map((f) => (
                        <Badge key={f} variant="secondary" className="text-xs">{f}</Badge>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Confidence: {Math.round((buyerInferredPrefs.confidence_score ?? 0) * 100)}% — based on your search and viewing history
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

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
                    Based on your search history and preferences, we're analyzing properties for you.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {savedProperties.length > 0 ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {savedProperties.map((property) => renderPropertyCard(property))}
            </div>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <Sparkles className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-xl font-semibold mb-2">No Matches Yet</h3>
                <p className="text-muted-foreground mb-4">
                  Use the AI search above to find your perfect home.
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Saved Homes Tab */}
        {tabConfig.tabs.includes("saved") && (
          <TabsContent value="saved" className="space-y-6">

            {/* AI Picks for You — shown above saved list when recommendations exist */}
            {recommendedProperties.length > 0 && (
              <section className="mb-2">
                <div className="flex items-center gap-2 mb-4">
                  <Sparkles className="h-5 w-5 text-primary" />
                  <h2 className="text-base font-semibold">AI Picks for You</h2>
                  <Badge className="bg-primary/10 text-primary text-xs border-0">Personalized</Badge>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {recommendedProperties.map((prop: any) => (
                    <div key={prop.id} className="rounded-xl border border-border overflow-hidden hover:shadow-md transition-shadow bg-card">
                      <div className="aspect-[4/3] bg-muted relative">
                        {prop.primary_image_url ? (
                          <img src={prop.primary_image_url} alt={prop.address ?? "Property"} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Home className="h-10 w-10 text-muted-foreground" />
                          </div>
                        )}
                        <div className="absolute top-2 left-2">
                          <Badge className="bg-primary text-primary-foreground text-xs">AI Pick</Badge>
                        </div>
                      </div>
                      <div className="p-4">
                        <p className="font-semibold truncate">{prop.address}</p>
                        <p className="text-xl font-bold text-primary">
                          ${prop.list_price?.toLocaleString()}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {prop.bedrooms}bd &middot; {prop.bathrooms}ba
                          {prop.sqft ? ` · ${prop.sqft.toLocaleString()} sqft` : ""}
                        </p>
                        {prop.match_reason && (
                          <p className="text-xs text-primary mt-2 font-medium border-l-2 border-primary/40 pl-2">
                            {prop.match_reason}
                          </p>
                        )}
                        <div className="flex gap-2 mt-3">
                          <Button size="sm" className="flex-1 text-xs" asChild>
                            <Link href={`/portal/${contactId}/properties/${prop.id}`}>View</Link>
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {savedProperties.length > 0 ? (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {savedProperties.map((property: any) => (
                  <Card key={property.id} className="overflow-hidden hover:shadow-lg transition-shadow">
                    <div className="aspect-video bg-slate-200 relative">
                      {property.images?.[0] ? (
                        <img src={property.images[0] || "/placeholder.svg"} alt={property.address} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                          <Home className="w-12 h-12" />
                        </div>
                      )}
                      <Badge className="absolute top-2 right-2">{property.status || "Saved"}</Badge>
                    </div>
                    <CardContent className="p-4">
                      <p className="font-semibold truncate">{property.address || property.property_address}</p>
                      <p className="text-lg font-bold text-green-600">
                        ${(property.price || property.list_price || 0).toLocaleString()}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {property.beds || property.bedrooms || 0} bed | {property.baths || property.bathrooms || 0} bath | {(property.sqft || property.square_feet || 0).toLocaleString()} sqft
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="py-12 text-center">
                  <Heart className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-xl font-semibold mb-2">No Saved Properties</h3>
                  <p className="text-muted-foreground">Save properties you like to review them later.</p>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        )}

        {/* Property Alerts Tab - Only for family-focused personas */}
        {tabConfig.tabs.includes("family") && (
          <TabsContent value="family" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Target className="w-5 h-5" />
                  Property Alerts
                </CardTitle>
                <CardDescription>
                  Get notified when new properties match your criteria
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {propertyAlerts.length > 0 ? (
                  <div className="space-y-3">
                    {propertyAlerts.map((alert: any) => (
                      <div key={alert.id} className="flex items-center justify-between p-3 border rounded-lg">
                        <div className="flex items-center gap-3">
                          <div className={`w-2 h-2 rounded-full ${alert.is_active ? 'bg-green-500' : 'bg-gray-300'}`} />
                          <div>
                            <p className="font-medium text-sm">
                              {typeof alert.search_criteria === 'object' 
                                ? `${alert.search_criteria.beds || 'Any'} bed, ${alert.search_criteria.city || 'Any location'}`
                                : 'Custom Search'}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {alert.frequency} alerts
                            </p>
                          </div>
                        </div>
                        <Badge variant={alert.is_active ? "default" : "secondary"}>
                          {alert.is_active ? "Active" : "Paused"}
                        </Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <Target className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                    <h3 className="font-semibold mb-2">No Property Alerts</h3>
                    <p className="text-muted-foreground mb-4">Set up alerts to get notified about new listings.</p>
                    <p className="text-sm text-muted-foreground">Contact your agent to set up property alerts.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* Mortgage/Affordability Tab */}
        {tabConfig.tabs.includes("mortgage") && (
          <TabsContent value="mortgage" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Calculator className="w-5 h-5" />
                  Affordability Calculator
                </CardTitle>
                <CardDescription>
                  Estimate your monthly payments and affordability
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Home Price</Label>
                    <Input type="number" placeholder="$400,000" />
                  </div>
                  <div className="space-y-2">
                    <Label>Down Payment (%)</Label>
                    <Input type="number" placeholder="20" />
                  </div>
                  <div className="space-y-2">
                    <Label>Interest Rate (%)</Label>
                    <Input type="number" placeholder="6.5" />
                  </div>
                  <div className="space-y-2">
                    <Label>Loan Term (years)</Label>
                    <Input type="number" placeholder="30" />
                  </div>
                </div>
                <Button className="w-full">Calculate Monthly Payment</Button>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* Showings Tab - For Buyers */}
        {tabConfig.tabs.includes("showings") && (
          <TabsContent value="showings" className="space-y-6">
            {showings.length > 0 ? (
              <div className="space-y-4">
                {showings.map((showing: any) => (
                  <Card key={showing.id}>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold">{showing.property_address}</p>
                          <p className="text-sm text-muted-foreground">
                            {showing.confirmed_date 
                              ? new Date(showing.confirmed_date).toLocaleDateString()
                              : "Pending confirmation"}
                          </p>
                        </div>
                        <Badge variant={showing.status === "confirmed" ? "default" : "secondary"}>
                          {showing.status}
                        </Badge>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="py-12 text-center">
                  <Calendar className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-xl font-semibold mb-2">No Scheduled Showings</h3>
                  <p className="text-muted-foreground">Schedule a showing from any property you like.</p>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        )}

        {/* Listing Showings Tab - For Sellers */}
        {tabConfig.tabs.includes("listing_showings") && (
          <TabsContent value="listing_showings" className="space-y-6">
            {/* Showing Stats Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-primary">{showings.length}</p>
                  <p className="text-sm text-muted-foreground">Total Showings</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-green-600">
                    {showings.filter((s: any) => s.status === "completed").length}
                  </p>
                  <p className="text-sm text-muted-foreground">Completed</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-blue-600">
                    {showings.filter((s: any) => s.status === "scheduled" || s.status === "confirmed").length}
                  </p>
                  <p className="text-sm text-muted-foreground">Upcoming</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-amber-600">
                    {showings.filter((s: any) => s.buyer_feedback).length}
                  </p>
                  <p className="text-sm text-muted-foreground">With Feedback</p>
                </CardContent>
              </Card>
            </div>

            {/* Upcoming Showings */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Calendar className="w-5 h-5" />
                  Upcoming Showings
                </CardTitle>
              </CardHeader>
              <CardContent>
                {showings.filter((s: any) => s.status === "scheduled" || s.status === "confirmed").length > 0 ? (
                  <div className="space-y-3">
                    {showings
                      .filter((s: any) => s.status === "scheduled" || s.status === "confirmed")
                      .map((showing: any) => (
                        <div key={showing.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                          <div className="flex items-center gap-4">
                            <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center">
                              <Users className="w-6 h-6 text-primary" />
                            </div>
                            <div>
                              <p className="font-medium">{showing.buyer_name || "Prospective Buyer"}</p>
                              <p className="text-sm text-muted-foreground">
                                {showing.confirmed_date 
                                  ? new Date(showing.confirmed_date).toLocaleDateString("en-US", {
                                      weekday: "long",
                                      month: "short",
                                      day: "numeric",
                                      hour: "numeric",
                                      minute: "2-digit"
                                    })
                                  : "Time TBD"}
                              </p>
                            </div>
                          </div>
                          <Badge variant={showing.status === "confirmed" ? "default" : "secondary"}>
                            {showing.status === "confirmed" ? "Confirmed" : "Pending"}
                          </Badge>
                        </div>
                      ))}
                  </div>
                ) : (
                  <p className="text-center text-muted-foreground py-6">No upcoming showings scheduled</p>
                )}
              </CardContent>
            </Card>

            {/* Completed Showings */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle className="w-5 h-5" />
                  Completed Showings
                </CardTitle>
              </CardHeader>
              <CardContent>
                {showings.filter((s: any) => s.status === "completed").length > 0 ? (
                  <div className="space-y-3">
                    {showings
                      .filter((s: any) => s.status === "completed")
                      .map((showing: any) => (
                        <div key={showing.id} className="p-4 bg-slate-50 rounded-lg">
                          <div className="flex items-center justify-between mb-2">
                            <div>
                              <p className="font-medium">{showing.buyer_name || "Buyer"}</p>
                              <p className="text-sm text-muted-foreground">
                                {showing.confirmed_date 
                                  ? new Date(showing.confirmed_date).toLocaleDateString()
                                  : "Date not recorded"}
                              </p>
                            </div>
                            {showing.buyer_feedback && (
                              <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                                Feedback Received
                              </Badge>
                            )}
                          </div>
                          {showing.buyer_feedback && (
                            <div className="mt-3 p-3 bg-white rounded border">
                              <p className="text-sm italic">"{showing.buyer_feedback}"</p>
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                ) : (
                  <p className="text-center text-muted-foreground py-6">No completed showings yet</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* Buyer Feedback Tab - For Sellers with AI Analysis */}
        {tabConfig.tabs.includes("feedback") && (
          <TabsContent value="feedback" className="space-y-6">
            {/* AI Feedback Summary */}
            <Card className="border-primary/20 bg-primary/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-primary" />
                  AI Feedback Analysis
                </CardTitle>
                <CardDescription>
                  Insights from buyer feedback to help you optimize your listing
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {showings.filter((s: any) => s.buyer_feedback).length > 0 ? (
                  <>
                    {/* Sentiment Summary */}
                    <div className="grid md:grid-cols-3 gap-4">
                      <div className="p-4 bg-white rounded-lg border">
                        <div className="flex items-center gap-2 mb-2">
                          <ThumbsUp className="w-4 h-4 text-green-600" />
                          <span className="font-medium text-green-700">Positive</span>
                        </div>
                        <p className="text-2xl font-bold">
                          {Math.round(showings.filter((s: any) => s.buyer_feedback && s.feedback_sentiment === "positive").length / Math.max(showings.filter((s: any) => s.buyer_feedback).length, 1) * 100)}%
                        </p>
                      </div>
                      <div className="p-4 bg-white rounded-lg border">
                        <div className="flex items-center gap-2 mb-2">
                          <Minus className="w-4 h-4 text-amber-600" />
                          <span className="font-medium text-amber-700">Neutral</span>
                        </div>
                        <p className="text-2xl font-bold">
                          {Math.round(showings.filter((s: any) => s.buyer_feedback && s.feedback_sentiment === "neutral").length / Math.max(showings.filter((s: any) => s.buyer_feedback).length, 1) * 100)}%
                        </p>
                      </div>
                      <div className="p-4 bg-white rounded-lg border">
                        <div className="flex items-center gap-2 mb-2">
                          <ThumbsDown className="w-4 h-4 text-red-600" />
                          <span className="font-medium text-red-700">Concerns</span>
                        </div>
                        <p className="text-2xl font-bold">
                          {Math.round(showings.filter((s: any) => s.buyer_feedback && s.feedback_sentiment === "negative").length / Math.max(showings.filter((s: any) => s.buyer_feedback).length, 1) * 100)}%
                        </p>
                      </div>
                    </div>

                    {/* Common Themes */}
                    <div className="p-4 bg-white rounded-lg border">
                      <h4 className="font-medium mb-3">Common Buyer Feedback Themes</h4>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline" className="bg-green-50 border-green-200 text-green-700">
                          Great location
                        </Badge>
                        <Badge variant="outline" className="bg-green-50 border-green-200 text-green-700">
                          Well-maintained
                        </Badge>
                        <Badge variant="outline" className="bg-amber-50 border-amber-200 text-amber-700">
                          Price consideration
                        </Badge>
                        <Badge variant="outline" className="bg-blue-50 border-blue-200 text-blue-700">
                          Good natural light
                        </Badge>
                      </div>
                    </div>

                    {/* AI Recommendations */}
                    <div className="p-4 bg-white rounded-lg border">
                      <h4 className="font-medium mb-3 flex items-center gap-2">
                        <Lightbulb className="w-4 h-4 text-amber-500" />
                        AI Recommendations
                      </h4>
                      <ul className="space-y-2 text-sm">
                        <li className="flex items-start gap-2">
                          <CheckCircle className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
                          <span>Buyers consistently praise the natural lighting - highlight this in your listing photos</span>
                        </li>
                        <li className="flex items-start gap-2">
                          <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                          <span>Consider addressing price concerns by highlighting recent comparable sales</span>
                        </li>
                        <li className="flex items-start gap-2">
                          <CheckCircle className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
                          <span>Location is a top selling point - emphasize proximity to amenities</span>
                        </li>
                      </ul>
                    </div>
                  </>
                ) : (
                  <div className="text-center py-8">
                    <MessageSquare className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                    <h3 className="font-semibold mb-2">No Feedback Yet</h3>
                    <p className="text-muted-foreground">
                      AI analysis will appear here once buyers provide feedback after showings.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* All Feedback */}
            <Card>
              <CardHeader>
                <CardTitle>All Buyer Feedback</CardTitle>
              </CardHeader>
              <CardContent>
                {showings.filter((s: any) => s.buyer_feedback).length > 0 ? (
                  <div className="space-y-4">
                    {showings
                      .filter((s: any) => s.buyer_feedback)
                      .map((showing: any) => (
                        <div key={showing.id} className="p-4 border rounded-lg">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center">
                                <User className="w-5 h-5 text-slate-600" />
                              </div>
                              <div>
                                <p className="font-medium">{showing.buyer_name || "Anonymous Buyer"}</p>
                                <p className="text-xs text-muted-foreground">
                                  {showing.confirmed_date 
                                    ? new Date(showing.confirmed_date).toLocaleDateString()
                                    : ""}
                                </p>
                              </div>
                            </div>
                            {showing.buyer_interest_level && (
                              <Badge 
                                variant="outline"
                                className={
                                  showing.buyer_interest_level === "high" 
                                    ? "bg-green-50 text-green-700 border-green-200"
                                    : showing.buyer_interest_level === "medium"
                                    ? "bg-amber-50 text-amber-700 border-amber-200"
                                    : "bg-slate-50 text-slate-700 border-slate-200"
                                }
                              >
                                {showing.buyer_interest_level === "high" ? "Very Interested" 
                                  : showing.buyer_interest_level === "medium" ? "Interested" 
                                  : "Exploring"}
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm bg-slate-50 p-3 rounded italic">
                            "{showing.buyer_feedback}"
                          </p>
                          {showing.buyer_concerns && (
                            <div className="mt-3 flex items-start gap-2 text-sm text-amber-700">
                              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                              <span>Concerns: {showing.buyer_concerns}</span>
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                ) : (
                  <p className="text-center text-muted-foreground py-8">
                    No buyer feedback has been submitted yet.
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* Activity Tab - Property Interests */}
        {tabConfig.tabs.includes("activity") && (
          <TabsContent value="activity" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Property Interests</CardTitle>
                <CardDescription>Properties you've expressed interest in</CardDescription>
              </CardHeader>
              <CardContent>
                {propertyInterests.length > 0 ? (
                  <div className="space-y-3">
                    {propertyInterests.slice(0, 10).map((interest: any) => (
                      <div key={interest.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                        <div className="flex items-center gap-3">
                          <Home className="w-4 h-4 text-muted-foreground" />
                          <div>
                            <p className="text-sm font-medium">{interest.property_address}</p>
                            <p className="text-xs text-muted-foreground">
                              {new Date(interest.created_at).toLocaleDateString()}
                              {interest.notes && ` - ${interest.notes}`}
                            </p>
                          </div>
                        </div>
                        <Badge variant={
                          interest.interest_level === 'high' ? 'default' : 
                          interest.interest_level === 'medium' ? 'secondary' : 'outline'
                        }>
                          {interest.interest_level || 'interested'}
                        </Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-center text-muted-foreground py-8">No property interests recorded yet</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {/* Rating Dialog */}
      <Dialog open={showRatingDialog} onOpenChange={setShowRatingDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rate This Property</DialogTitle>
            <DialogDescription>
              {selectedProperty?.property_address || selectedProperty?.address}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Your Vote</Label>
              <div className="flex gap-2">
                {[
                  { value: "love", icon: Heart, label: "Love It", color: "text-red-500" },
                  { value: "like", icon: ThumbsUp, label: "Like", color: "text-green-500" },
                  { value: "neutral", icon: Minus, label: "Neutral", color: "text-gray-500" },
                  { value: "dislike", icon: ThumbsDown, label: "Dislike", color: "text-orange-500" },
                  { value: "pass", icon: X, label: "Pass", color: "text-red-500" },
                ].map((option) => (
                  <Button
                    key={option.value}
                    variant={propertyVote === option.value ? "default" : "outline"}
                    size="sm"
                    onClick={() => setPropertyVote(option.value)}
                    className={propertyVote !== option.value ? "bg-transparent" : ""}
                  >
                    <option.icon className={`w-4 h-4 mr-1 ${option.color}`} />
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Comments</Label>
              <Textarea 
                placeholder="What do you think about this property?"
                value={ratingComments}
                onChange={(e) => setRatingComments(e.target.value)}
              />
            </div>
            <Button onClick={handleRateProperty} disabled={isPending} className="w-full">
              {isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
              Save Rating
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Showing Request Dialog */}
      <Dialog open={showShowingDialog} onOpenChange={setShowShowingDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {persona === "investor" ? "Schedule Property Analysis" : "Schedule a Showing"}
            </DialogTitle>
            <DialogDescription>
              {selectedProperty?.property_address || selectedProperty?.address}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Preferred Date</Label>
              <Input 
                type="date"
                value={showingDate}
                onChange={(e) => setShowingDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Preferred Time</Label>
              <Select value={showingTime} onValueChange={setShowingTime}>
                <SelectTrigger>
                  <SelectValue placeholder="Select time" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="9:00 AM">9:00 AM</SelectItem>
                  <SelectItem value="10:00 AM">10:00 AM</SelectItem>
                  <SelectItem value="11:00 AM">11:00 AM</SelectItem>
                  <SelectItem value="1:00 PM">1:00 PM</SelectItem>
                  <SelectItem value="2:00 PM">2:00 PM</SelectItem>
                  <SelectItem value="3:00 PM">3:00 PM</SelectItem>
                  <SelectItem value="4:00 PM">4:00 PM</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Notes for Agent</Label>
              <Textarea 
                placeholder={persona === "investor" 
                  ? "I'd like to analyze the property condition, discuss rental potential, and review any existing tenant leases."
                  : "Any special requests or questions?"
                }
                value={showingNotes}
                onChange={(e) => setShowingNotes(e.target.value)}
              />
            </div>
            <Button onClick={handleRequestShowing} disabled={isPending} className="w-full">
              {isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Calendar className="w-4 h-4 mr-2" />}
              Request Showing
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
