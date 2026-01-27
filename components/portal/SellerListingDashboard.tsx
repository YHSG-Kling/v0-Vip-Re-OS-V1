"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Progress } from "@/components/ui/progress"
import {
  Eye,
  Heart,
  Calendar,
  TrendingUp,
  Share2,
  Facebook,
  Twitter,
  Linkedin,
  Instagram,
  Copy,
  Check,
  Mail,
  MessageSquare,
  Star,
  ThumbsUp,
  DollarSign,
  Home,
  Camera,
  Play,
  FileText,
  MapPin,
  BarChart3,
  Bell,
  ChevronRight,
  ExternalLink,
  Sparkles,
} from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import Link from "next/link"

interface SellerListingDashboardProps {
  contact: any
  listing: any
  showings: any[]
  offers: any[]
  contactId: string
}

export default function SellerListingDashboard({
  contact,
  listing,
  showings,
  offers,
  contactId,
}: SellerListingDashboardProps) {
  const [activeTab, setActiveTab] = useState("overview")
  const [copiedLink, setCopiedLink] = useState(false)

  // Mock data for demo - in production this would come from the database
  const listingStats = {
    views: listing?.view_count || 1247,
    saves: listing?.save_count || 89,
    shares: listing?.share_count || 34,
    showings: showings.length || 12,
    inquiries: 23,
    daysOnMarket: listing?.list_date
      ? Math.floor((Date.now() - new Date(listing.list_date).getTime()) / (1000 * 60 * 60 * 24))
      : 14,
  }

  const marketData = {
    avgDaysOnMarket: 28,
    medianPrice: 485000,
    pricePerSqFt: 225,
    competingListings: 8,
    recentSales: 12,
    priceChange: 2.3,
  }

  const socialPlatforms = [
    { name: "Facebook", icon: Facebook, color: "bg-blue-600", shares: 18 },
    { name: "Instagram", icon: Instagram, color: "bg-gradient-to-r from-purple-500 to-pink-500", shares: 12 },
    { name: "Twitter", icon: Twitter, color: "bg-sky-500", shares: 8 },
    { name: "LinkedIn", icon: Linkedin, color: "bg-blue-700", shares: 4 },
  ]

  const listingUrl = `https://vipagents.com/listings/${listing?.id || "demo"}`

  const handleCopyLink = () => {
    navigator.clipboard.writeText(listingUrl)
    setCopiedLink(true)
    setTimeout(() => setCopiedLink(false), 2000)
  }

  // Mock showing feedback data
  const showingFeedback = [
    {
      id: 1,
      date: "2024-01-14",
      buyerAgent: "John Smith",
      rating: 4,
      priceOpinion: "fair",
      interest: "high",
      comments: "Buyers loved the kitchen and backyard. Concerned about the age of the HVAC system.",
      likelihood: 75,
    },
    {
      id: 2,
      date: "2024-01-12",
      buyerAgent: "Sarah Johnson",
      rating: 5,
      priceOpinion: "good_value",
      interest: "very_high",
      comments: "Perfect fit for my clients! They're discussing making an offer tonight.",
      likelihood: 90,
    },
    {
      id: 3,
      date: "2024-01-10",
      buyerAgent: "Mike Davis",
      rating: 3,
      priceOpinion: "slightly_high",
      interest: "medium",
      comments: "Nice home but buyers prefer a larger lot. May come back for a second look.",
      likelihood: 40,
    },
  ]

  if (!listing) {
    return (
      <div className="space-y-6">
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <Home className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-xl font-semibold mb-2">No Listing Yet</h3>
            <p className="text-muted-foreground mb-4">
              Once your property is listed, you'll see all your marketing metrics, showing feedback, and offers here.
            </p>
            <Button>
              <MessageSquare className="w-4 h-4 mr-2" /> Contact Your Agent
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Property Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{listing.address || "123 Main Street"}</h1>
          <p className="text-muted-foreground flex items-center gap-1">
            <MapPin className="w-4 h-4" />
            {listing.city || "Austin"}, {listing.state || "TX"} {listing.zip || "78701"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant={listing.status === "active" ? "default" : "secondary"} className="text-sm py-1 px-3">
            {listing.status || "Active"}
          </Badge>
          <div className="text-right">
            <p className="text-2xl font-bold text-green-600">${(listing.price || 499000).toLocaleString()}</p>
            <p className="text-sm text-muted-foreground">{listingStats.daysOnMarket} days on market</p>
          </div>
        </div>
      </div>

      {/* Quick Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-100 text-blue-600">
              <Eye className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{listingStats.views.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Total Views</p>
            </div>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-red-100 text-red-600">
              <Heart className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{listingStats.saves}</p>
              <p className="text-xs text-muted-foreground">Saved</p>
            </div>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-100 text-purple-600">
              <Calendar className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{listingStats.showings}</p>
              <p className="text-xs text-muted-foreground">Showings</p>
            </div>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-100 text-green-600">
              <Share2 className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{listingStats.shares}</p>
              <p className="text-xs text-muted-foreground">Shares</p>
            </div>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-orange-100 text-orange-600">
              <DollarSign className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{offers.length}</p>
              <p className="text-xs text-muted-foreground">Offers</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="marketing">Marketing</TabsTrigger>
          <TabsTrigger value="feedback">Feedback</TabsTrigger>
          <TabsTrigger value="offers">Offers ({offers.length})</TabsTrigger>
          <TabsTrigger value="market">Market</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-6">
          <div className="grid md:grid-cols-2 gap-6">
            {/* Activity Timeline */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bell className="w-5 h-5" />
                  Recent Activity
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start gap-3 p-3 bg-green-50 rounded-lg border border-green-200">
                  <div className="w-2 h-2 rounded-full bg-green-500 mt-2" />
                  <div>
                    <p className="font-medium text-sm">New showing request</p>
                    <p className="text-xs text-muted-foreground">Tomorrow at 2:00 PM - Buyer from Redfin</p>
                  </div>
                  <Badge variant="outline" className="ml-auto">
                    New
                  </Badge>
                </div>
                <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
                  <div className="w-2 h-2 rounded-full bg-blue-500 mt-2" />
                  <div>
                    <p className="font-medium text-sm">Showing completed</p>
                    <p className="text-xs text-muted-foreground">Yesterday - Feedback received (5 stars)</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
                  <div className="w-2 h-2 rounded-full bg-purple-500 mt-2" />
                  <div>
                    <p className="font-medium text-sm">147 new views this week</p>
                    <p className="text-xs text-muted-foreground">Up 23% from last week</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
                  <div className="w-2 h-2 rounded-full bg-orange-500 mt-2" />
                  <div>
                    <p className="font-medium text-sm">Price compared to market</p>
                    <p className="text-xs text-muted-foreground">Your listing is priced competitively</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Share Your Listing */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Share2 className="w-5 h-5" />
                  Share Your Listing
                </CardTitle>
                <CardDescription>Help spread the word to find the right buyer faster</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-2 p-3 bg-slate-50 rounded-lg">
                  <input type="text" value={listingUrl} readOnly className="flex-1 bg-transparent text-sm truncate" />
                  <Button size="sm" variant="outline" onClick={handleCopyLink}>
                    {copiedLink ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>

                <div className="grid grid-cols-4 gap-2">
                  {socialPlatforms.map((platform) => (
                    <Button
                      key={platform.name}
                      variant="outline"
                      className="flex flex-col h-auto py-3 gap-1 bg-transparent"
                    >
                      <platform.icon className="w-5 h-5" />
                      <span className="text-[10px]">{platform.name}</span>
                    </Button>
                  ))}
                </div>

                <Button variant="outline" className="w-full bg-transparent">
                  <Mail className="w-4 h-4 mr-2" /> Email to Friends & Family
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Upcoming Showings */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Calendar className="w-5 h-5" />
                  Upcoming Showings
                </CardTitle>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/portal/${contactId}/showings`}>
                    View All <ChevronRight className="w-4 h-4 ml-1" />
                  </Link>
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {showings.length > 0 ? (
                <div className="space-y-3">
                  {showings.slice(0, 3).map((showing, idx) => (
                    <div key={showing.id || idx} className="flex items-center justify-between p-3 border rounded-lg">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center">
                          <Calendar className="w-6 h-6 text-purple-600" />
                        </div>
                        <div>
                          <p className="font-medium">{new Date(showing.requested_date).toLocaleDateString()}</p>
                          <p className="text-sm text-muted-foreground">{showing.requested_time || "2:00 PM"}</p>
                        </div>
                      </div>
                      <Badge variant={showing.status === "confirmed" ? "default" : "secondary"}>
                        {showing.status || "Pending"}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 text-muted-foreground">
                  <Calendar className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p>No upcoming showings scheduled</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Marketing Tab */}
        <TabsContent value="marketing" className="space-y-6">
          <div className="grid md:grid-cols-2 gap-6">
            {/* Marketing Channels */}
            <Card>
              <CardHeader>
                <CardTitle>Where Your Listing Appears</CardTitle>
                <CardDescription>Your property is syndicated to these platforms</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {[
                  { name: "MLS (Austin Board of Realtors)", status: "Live", views: 842 },
                  { name: "Zillow", status: "Live", views: 523 },
                  { name: "Realtor.com", status: "Live", views: 312 },
                  { name: "Redfin", status: "Live", views: 289 },
                  { name: "Trulia", status: "Live", views: 198 },
                  { name: "Company Website", status: "Live", views: 156 },
                ].map((channel) => (
                  <div key={channel.name} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-green-500" />
                      <span className="font-medium text-sm">{channel.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">{channel.views} views</span>
                      <ExternalLink className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Marketing Materials */}
            <Card>
              <CardHeader>
                <CardTitle>Marketing Materials</CardTitle>
                <CardDescription>Download and share professional materials</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button variant="outline" className="w-full justify-start bg-transparent">
                  <Camera className="w-4 h-4 mr-3" />
                  Professional Photos (24)
                  <Badge variant="secondary" className="ml-auto">
                    Download
                  </Badge>
                </Button>
                <Button variant="outline" className="w-full justify-start bg-transparent">
                  <Play className="w-4 h-4 mr-3" />
                  Video Tour
                  <Badge variant="secondary" className="ml-auto">
                    View
                  </Badge>
                </Button>
                <Button variant="outline" className="w-full justify-start bg-transparent">
                  <FileText className="w-4 h-4 mr-3" />
                  Property Brochure
                  <Badge variant="secondary" className="ml-auto">
                    PDF
                  </Badge>
                </Button>
                <Button variant="outline" className="w-full justify-start bg-transparent">
                  <Home className="w-4 h-4 mr-3" />
                  3D Virtual Tour
                  <Badge variant="secondary" className="ml-auto">
                    View
                  </Badge>
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Social Media Performance */}
          <Card>
            <CardHeader>
              <CardTitle>Social Media Performance</CardTitle>
              <CardDescription>Track engagement across social platforms</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {socialPlatforms.map((platform) => (
                  <div key={platform.name} className="p-4 border rounded-lg text-center">
                    <div
                      className={`w-12 h-12 rounded-full ${platform.color} flex items-center justify-center mx-auto mb-3`}
                    >
                      <platform.icon className="w-6 h-6 text-white" />
                    </div>
                    <p className="font-bold text-xl">{platform.shares}</p>
                    <p className="text-xs text-muted-foreground">Shares</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Feedback Tab */}
        <TabsContent value="feedback" className="space-y-6">
          {/* Feedback Summary */}
          <div className="grid md:grid-cols-3 gap-4">
            <Card>
              <CardContent className="p-4 text-center">
                <div className="flex items-center justify-center gap-1 mb-2">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <Star
                      key={star}
                      className={`w-5 h-5 ${star <= 4 ? "text-yellow-500 fill-yellow-500" : "text-slate-300"}`}
                    />
                  ))}
                </div>
                <p className="text-2xl font-bold">4.0</p>
                <p className="text-sm text-muted-foreground">Average Rating</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <ThumbsUp className="w-8 h-8 text-green-500 mx-auto mb-2" />
                <p className="text-2xl font-bold">67%</p>
                <p className="text-sm text-muted-foreground">Positive Interest</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <TrendingUp className="w-8 h-8 text-blue-500 mx-auto mb-2" />
                <p className="text-2xl font-bold">68%</p>
                <p className="text-sm text-muted-foreground">Avg. Offer Likelihood</p>
              </CardContent>
            </Card>
          </div>

          {/* Detailed Feedback */}
          <Card>
            <CardHeader>
              <CardTitle>Showing Feedback</CardTitle>
              <CardDescription>What buyers are saying about your property</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {showingFeedback.map((feedback) => (
                <div key={feedback.id} className="p-4 border rounded-lg space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <Avatar>
                        <AvatarFallback>
                          {feedback.buyerAgent
                            .split(" ")
                            .map((n) => n[0])
                            .join("")}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-medium">{feedback.buyerAgent}</p>
                        <p className="text-sm text-muted-foreground">{new Date(feedback.date).toLocaleDateString()}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <Star
                          key={star}
                          className={`w-4 h-4 ${star <= feedback.rating ? "text-yellow-500 fill-yellow-500" : "text-slate-300"}`}
                        />
                      ))}
                    </div>
                  </div>

                  <p className="text-sm">{feedback.comments}</p>

                  <div className="flex items-center gap-4 pt-2">
                    <Badge
                      variant={
                        feedback.priceOpinion === "good_value"
                          ? "default"
                          : feedback.priceOpinion === "fair"
                            ? "secondary"
                            : "outline"
                      }
                    >
                      Price:{" "}
                      {feedback.priceOpinion === "good_value"
                        ? "Good Value"
                        : feedback.priceOpinion === "fair"
                          ? "Fair"
                          : "Slightly High"}
                    </Badge>
                    <Badge
                      variant={
                        feedback.interest === "very_high"
                          ? "default"
                          : feedback.interest === "high"
                            ? "secondary"
                            : "outline"
                      }
                    >
                      Interest:{" "}
                      {feedback.interest === "very_high"
                        ? "Very High"
                        : feedback.interest === "high"
                          ? "High"
                          : "Medium"}
                    </Badge>
                    <div className="ml-auto flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Offer likelihood:</span>
                      <Progress value={feedback.likelihood} className="w-24" />
                      <span className="text-sm font-medium">{feedback.likelihood}%</span>
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Offers Tab */}
        <TabsContent value="offers" className="space-y-6">
          {offers.length > 0 ? (
            <div className="space-y-4">
              {offers.map((offer, idx) => (
                <Card key={offer.id || idx}>
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-2xl font-bold text-green-600">
                          ${(offer.offer_price || 495000).toLocaleString()}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {offer.financing_type || "Conventional"} •{" "}
                          {offer.close_date ? new Date(offer.close_date).toLocaleDateString() : "30-day close"}
                        </p>
                      </div>
                      <Badge>{offer.status || "Pending"}</Badge>
                    </div>
                    <div className="flex gap-2 mt-4">
                      <Button className="flex-1">View Details</Button>
                      <Button variant="outline" className="flex-1 bg-transparent">
                        Counter
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <DollarSign className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-xl font-semibold mb-2">No Offers Yet</h3>
                <p className="text-muted-foreground mb-4">
                  When buyers submit offers, they'll appear here for your review.
                </p>
              </CardContent>
            </Card>
          )}

          <Button variant="outline" className="w-full bg-transparent" asChild>
            <Link href={`/portal/${contactId}/offers`}>
              View Full Offers Page <ChevronRight className="w-4 h-4 ml-2" />
            </Link>
          </Button>
        </TabsContent>

        {/* Market Tab */}
        <TabsContent value="market" className="space-y-6">
          <div className="grid md:grid-cols-2 gap-6">
            {/* Market Overview */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="w-5 h-5" />
                  Market Overview
                </CardTitle>
                <CardDescription>How your area is performing</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                  <span className="text-sm">Median Home Price</span>
                  <div className="flex items-center gap-2">
                    <span className="font-bold">${marketData.medianPrice.toLocaleString()}</span>
                    <Badge variant="outline" className="text-green-600">
                      <TrendingUp className="w-3 h-3 mr-1" />
                      {marketData.priceChange}%
                    </Badge>
                  </div>
                </div>
                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                  <span className="text-sm">Avg Days on Market</span>
                  <span className="font-bold">{marketData.avgDaysOnMarket} days</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                  <span className="text-sm">Price per Sq Ft</span>
                  <span className="font-bold">${marketData.pricePerSqFt}</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                  <span className="text-sm">Active Listings Nearby</span>
                  <span className="font-bold">{marketData.competingListings}</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                  <span className="text-sm">Recent Sales (30 days)</span>
                  <span className="font-bold">{marketData.recentSales}</span>
                </div>
              </CardContent>
            </Card>

            {/* Your Position */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="w-5 h-5" />
                  Your Competitive Position
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                  <div className="flex items-center gap-2 mb-2">
                    <ThumbsUp className="w-5 h-5 text-green-600" />
                    <span className="font-semibold text-green-700">Well Positioned</span>
                  </div>
                  <p className="text-sm text-green-800">
                    Your listing is priced competitively at ${(listing.price || 499000).toLocaleString()}, which is{" "}
                    {Math.round(((listing.price || 499000) / marketData.medianPrice - 1) * 100)}% above the median for
                    your area.
                  </p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span>Views vs Similar Listings</span>
                    <span className="font-medium text-green-600">+23% above average</span>
                  </div>
                  <Progress value={73} className="h-2" />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span>Time on Market</span>
                    <span className="font-medium text-green-600">Faster than average</span>
                  </div>
                  <Progress value={85} className="h-2" />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span>Showing Activity</span>
                    <span className="font-medium text-green-600">High interest</span>
                  </div>
                  <Progress value={80} className="h-2" />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Comparable Sales */}
          <Card>
            <CardHeader>
              <CardTitle>Recent Comparable Sales</CardTitle>
              <CardDescription>Similar homes that have sold recently in your area</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {[
                  {
                    address: "456 Oak Lane",
                    price: 485000,
                    sqft: 2100,
                    beds: 4,
                    baths: 2.5,
                    soldDate: "2024-01-05",
                    daysOnMarket: 18,
                  },
                  {
                    address: "789 Maple Dr",
                    price: 512000,
                    sqft: 2300,
                    beds: 4,
                    baths: 3,
                    soldDate: "2024-01-02",
                    daysOnMarket: 22,
                  },
                  {
                    address: "321 Pine St",
                    price: 478000,
                    sqft: 2050,
                    beds: 3,
                    baths: 2,
                    soldDate: "2023-12-28",
                    daysOnMarket: 31,
                  },
                ].map((comp, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 border rounded-lg">
                    <div>
                      <p className="font-medium">{comp.address}</p>
                      <p className="text-sm text-muted-foreground">
                        {comp.beds} bed • {comp.baths} bath • {comp.sqft.toLocaleString()} sqft
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold">${comp.price.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground">
                        Sold {new Date(comp.soldDate).toLocaleDateString()} • {comp.daysOnMarket} days
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
