"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Home,
  FileText,
  MessageSquare,
  Calendar,
  CheckCircle2,
  Clock,
  AlertCircle,
  ChevronRight,
  Phone,
  Mail,
  MapPin,
  TrendingUp,
  Heart,
  Share2,
  Eye,
  DollarSign,
  Users,
  Sparkles,
  Shield,
  Plane,
  ArrowUpRight,
  ArrowDownRight,
  Building,
  Star,
  Play,
  Camera,
} from "lucide-react"
import Link from "next/link"
import { ClientDocumentsWidget } from "./ClientDocumentsWidget"
import { ClientMessagingWidget } from "./ClientMessagingWidget"

interface Contact {
  id: string
  first_name: string
  last_name: string
  email: string
  phone: string
  contact_type: string
  contact_persona: string
  custom_fields?: Record<string, any>
  listings?: any[]
  transactions?: any[]
}

interface UnifiedPortalDashboardProps {
  contact: Contact
  milestones: any[]
  showings: any[]
  documents: any[]
  messages: any[]
}

// Persona configuration with colors, icons, and messaging
const personaConfig: Record<
  string,
  {
    icon: any
    color: string
    bgColor: string
    title: string
    greeting: string
    supportMessage?: string
    features: string[]
  }
> = {
  first_time_buyer: {
    icon: Home,
    color: "text-blue-600",
    bgColor: "bg-blue-50",
    title: "First-Time Buyer Journey",
    greeting: "Welcome to homeownership!",
    features: ["Journey Guide", "Mortgage Tracker", "Homebuying Checklist", "First-Time Buyer Resources"],
  },
  military_buyer: {
    icon: Shield,
    color: "text-green-600",
    bgColor: "bg-green-50",
    title: "Military Buyer Portal",
    greeting: "Thank you for your service!",
    supportMessage:
      "We're honored to help you find your next home. Your VA benefits can make homeownership more accessible.",
    features: ["VA Loan Benefits", "PCS Support", "Base Proximity Search", "Military Discounts"],
  },
  luxury_buyer: {
    icon: Sparkles,
    color: "text-purple-600",
    bgColor: "bg-purple-50",
    title: "Luxury Property Portal",
    greeting: "Discover extraordinary properties",
    features: ["Concierge Services", "Off-Market Properties", "Private Showings", "White-Glove Experience"],
  },
  investor: {
    icon: TrendingUp,
    color: "text-indigo-600",
    bgColor: "bg-indigo-50",
    title: "Investment Dashboard",
    greeting: "Grow your portfolio",
    features: ["ROI Analysis", "Deal Pipeline", "Portfolio Tracker", "Market Intelligence"],
  },
  motivated_seller: {
    icon: Clock,
    color: "text-orange-600",
    bgColor: "bg-orange-50",
    title: "Fast-Track Sale Portal",
    greeting: "We're moving quickly for you",
    supportMessage: "We understand time is of the essence. Our team is dedicated to getting your home sold fast.",
    features: ["Quick Sale Options", "Instant Offers", "Expedited Timeline", "Daily Updates"],
  },
  relocating: {
    icon: Plane,
    color: "text-teal-600",
    bgColor: "bg-teal-50",
    title: "Relocation Portal",
    greeting: "Making your move seamless",
    features: ["Area Comparison", "Moving Checklist", "School Districts", "Cost of Living"],
  },
  probate: {
    icon: Heart,
    color: "text-amber-600",
    bgColor: "bg-amber-50",
    title: "Estate Guidance Portal",
    greeting: "We're here to support you",
    supportMessage:
      "We understand this is a difficult time. Our team will handle the details with care and respect for your family's wishes.",
    features: ["Probate Timeline", "Estate Resources", "Professional Network", "Compassionate Support"],
  },
  divorce: {
    icon: Users,
    color: "text-red-600",
    bgColor: "bg-red-50",
    title: "Confidential Sale Portal",
    greeting: "Private, professional support",
    supportMessage:
      "Your privacy is our priority. We'll help navigate this transition with discretion and fairness to all parties.",
    features: ["Neutral Communication", "Equity Split Tools", "Confidential Process", "Mediator Network"],
  },
  senior: {
    icon: Heart,
    color: "text-rose-600",
    bgColor: "bg-rose-50",
    title: "Thoughtful Transition Portal",
    greeting: "Your comfort is our priority",
    supportMessage:
      "We're here to make this transition as smooth as possible. Take your time - we'll handle everything.",
    features: ["Memory Video", "Senior Move Managers", "Downsizing Support", "Estate Sale Coordination"],
  },
  fsbo: {
    icon: Building,
    color: "text-lime-600",
    bgColor: "bg-lime-50",
    title: "Professional Support Portal",
    greeting: "Maximize your home's value",
    features: ["Net Proceeds Comparison", "MLS Exposure", "Professional Marketing", "Contract Support"],
  },
  expired: {
    icon: ArrowUpRight,
    color: "text-slate-600",
    bgColor: "bg-slate-50",
    title: "Fresh Start Portal",
    greeting: "A new approach awaits",
    features: ["Market Analysis", "New Strategy", "Enhanced Marketing", "Pricing Optimization"],
  },
  luxury_seller: {
    icon: Sparkles,
    color: "text-violet-600",
    bgColor: "bg-violet-50",
    title: "Premium Marketing Portal",
    greeting: "Showcase your exceptional property",
    features: ["Global Exposure", "Luxury Marketing", "Exclusive Network", "Concierge Services"],
  },
  upsizing: {
    icon: ArrowUpRight,
    color: "text-emerald-600",
    bgColor: "bg-emerald-50",
    title: "Growing Family Portal",
    greeting: "More space for your growing family",
    features: ["School Districts", "Coordinated Buy/Sell", "Space Comparison", "Family Amenities"],
  },
  downsizing: {
    icon: ArrowDownRight,
    color: "text-purple-600",
    bgColor: "bg-purple-50",
    title: "Right-Sizing Portal",
    greeting: "Simplify your lifestyle",
    supportMessage: "This is an exciting new chapter. We'll help you find the perfect space for this stage of life.",
    features: ["Decluttering Support", "Estate Sales", "Right-Sized Homes", "Storage Solutions"],
  },
  remote_seller: {
    icon: Plane,
    color: "text-cyan-600",
    bgColor: "bg-cyan-50",
    title: "Remote Sale Portal",
    greeting: "Sell from anywhere",
    features: ["Virtual Showings", "Digital Signing", "Property Monitoring", "Video Updates"],
  },
}

const featureLinks: Record<string, string> = {
  "Journey Guide": "journey",
  "Mortgage Tracker": "properties",
  "Homebuying Checklist": "journey",
  "First-Time Buyer Resources": "journey",
  "VA Loan Benefits": "journey",
  "PCS Support": "journey",
  "Base Proximity Search": "properties",
  "Military Discounts": "journey",
  "Concierge Services": "journey",
  "Off-Market Properties": "properties",
  "Private Showings": "showings",
  "White-Glove Experience": "journey",
  "ROI Analysis": "properties",
  "Deal Pipeline": "properties",
  "Portfolio Tracker": "properties",
  "Market Intelligence": "properties",
  "Quick Sale Options": "listing",
  "Instant Offers": "offers",
  "Expedited Timeline": "journey",
  "Daily Updates": "documents",
  "Area Comparison": "properties",
  "Moving Checklist": "journey",
  "School Districts": "properties",
  "Cost of Living": "properties",
  "Probate Timeline": "journey",
  "Estate Resources": "documents",
  "Professional Network": "journey",
  "Compassionate Support": "journey",
  "Neutral Communication": "documents",
  "Equity Split Tools": "documents",
  "Confidential Process": "documents",
  "Mediator Network": "journey",
  "Memory Video": "journey",
  "Senior Move Managers": "journey",
  "Downsizing Support": "journey",
  "Estate Sale Coordination": "journey",
  "Net Proceeds Comparison": "listing",
  "MLS Exposure": "listing",
  "Professional Marketing": "listing",
  "Contract Support": "documents",
  "Market Analysis": "listing",
  "New Strategy": "listing",
  "Enhanced Marketing": "listing",
  "Pricing Optimization": "listing",
  "Global Exposure": "listing",
  "Luxury Marketing": "listing",
  "Exclusive Network": "listing",
  "Coordinated Buy/Sell": "journey",
  "Space Comparison": "properties",
  "Family Amenities": "properties",
  "Decluttering Support": "journey",
  "Estate Sales": "journey",
  "Right-Sized Homes": "properties",
  "Storage Solutions": "journey",
  "Virtual Showings": "showings",
  "Digital Signing": "documents",
  "Property Monitoring": "listing",
  "Video Updates": "listing",
}

export default function UnifiedPortalDashboard({
  contact,
  milestones,
  showings,
  documents,
  messages,
}: UnifiedPortalDashboardProps) {
  const [activeTab, setActiveTab] = useState("overview")

  const persona = contact.contact_persona || "first_time_buyer"
  const config = personaConfig[persona] || personaConfig.first_time_buyer
  const PersonaIcon = config.icon

  const isBuyer =
    contact.contact_type === "buyer" ||
    ["first_time_buyer", "military_buyer", "luxury_buyer", "investor", "relocating", "upsizing"].includes(persona)
  const isSeller = contact.listings && contact.listings.length > 0

  // Calculate journey progress
  const completedMilestones = milestones.filter((m) => m.status === "completed").length
  const totalMilestones = milestones.length || 1
  const journeyProgress = Math.round((completedMilestones / totalMilestones) * 100)

  // Get next action items
  const pendingMilestones = milestones.filter((m) => m.status === "pending" || m.status === "in_progress").slice(0, 3)
  const unreadMessages = messages.filter((m) => !m.is_read).length

  return (
    <div className="space-y-6">
      {/* Welcome Hero with Persona Branding */}
      <Card className={`${config.bgColor} border-none shadow-lg`}>
        <CardContent className="p-6">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-4">
              <div className={`p-4 rounded-2xl bg-white shadow-md ${config.color}`}>
                <PersonaIcon className="w-8 h-8" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-slate-900">Welcome back, {contact.first_name}!</h1>
                <p className="text-slate-600 mt-1">{config.greeting}</p>
                <Badge variant="secondary" className="mt-2">
                  {config.title}
                </Badge>
              </div>
            </div>
            <div className="text-right">
              <p className="text-sm text-slate-500">Journey Progress</p>
              <p className="text-3xl font-bold text-slate-900">{journeyProgress}%</p>
              <Progress value={journeyProgress} className="w-32 mt-2" />
            </div>
          </div>

          {/* Compassionate Support Message for Sensitive Personas */}
          {config.supportMessage && (
            <div className="mt-4 p-4 bg-white/80 rounded-xl border border-white">
              <p className="text-sm text-slate-700 italic">{config.supportMessage}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quick Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-100 text-blue-600">
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {completedMilestones}/{totalMilestones}
              </p>
              <p className="text-xs text-muted-foreground">Steps Complete</p>
            </div>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-100 text-purple-600">
              <Calendar className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{showings.length}</p>
              <p className="text-xs text-muted-foreground">Upcoming Showings</p>
            </div>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-100 text-green-600">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{documents.length}</p>
              <p className="text-xs text-muted-foreground">Documents</p>
            </div>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-orange-100 text-orange-600">
              <MessageSquare className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{unreadMessages}</p>
              <p className="text-xs text-muted-foreground">New Messages</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
          <TabsList className="flex min-w-max sm:grid sm:w-full sm:grid-cols-5">
            <TabsTrigger value="overview" className="min-h-[44px] sm:min-h-0 min-w-[90px] sm:min-w-0">Overview</TabsTrigger>
            <TabsTrigger value="journey" className="min-h-[44px] sm:min-h-0 min-w-[100px] sm:min-w-0">My Journey</TabsTrigger>
            <TabsTrigger value="documents" className="min-h-[44px] sm:min-h-0 min-w-[100px] sm:min-w-0">Documents</TabsTrigger>
            <TabsTrigger value="messages" className="min-h-[44px] sm:min-h-0 min-w-[100px] sm:min-w-0">Messages</TabsTrigger>
            <TabsTrigger value="team" className="min-h-[44px] sm:min-h-0 min-w-[90px] sm:min-w-0">My Team</TabsTrigger>
          </TabsList>
        </div>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-6">
          <div className="grid md:grid-cols-2 gap-6">
            {/* What's Next Card */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <AlertCircle className="w-5 h-5 text-orange-500" />
                  What's Next
                </CardTitle>
                <CardDescription>Your upcoming action items</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {pendingMilestones.length > 0 ? (
                  pendingMilestones.map((milestone, idx) => (
                    <div
                      key={milestone.id || idx}
                      className="flex items-center justify-between p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-2 h-2 rounded-full ${milestone.status === "in_progress" ? "bg-blue-500" : "bg-orange-500"}`}
                        />
                        <div>
                          <p className="font-medium text-sm">{milestone.name || milestone.milestone_name}</p>
                          <p className="text-xs text-muted-foreground">
                            {milestone.target_date || milestone.due_date
                              ? `Due: ${new Date(milestone.target_date || milestone.due_date).toLocaleDateString()}`
                              : "Date TBD"}
                          </p>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                  ))
                ) : (
                  <div className="text-center py-6 text-muted-foreground">
                    <CheckCircle2 className="w-12 h-12 mx-auto mb-2 text-green-500" />
                    <p>All caught up! No pending tasks.</p>
                  </div>
                )}
                <Button variant="outline" className="w-full mt-2 bg-transparent" asChild>
                  <Link href={`/portal/${contact.id}/journey`}>
                    View Full Journey <ChevronRight className="w-4 h-4 ml-2" />
                  </Link>
                </Button>
              </CardContent>
            </Card>

            {/* Persona-Specific Features Card */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className={`w-5 h-5 ${config.color}`} />
                  Your Personalized Tools
                </CardTitle>
                <CardDescription>Features tailored for your journey</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3">
                  {config.features.map((feature, idx) => {
                    const linkPath = featureLinks[feature] || "journey"
                    return (
                      <Button
                        key={idx}
                        variant="outline"
                        className="h-auto py-4 flex flex-col items-center gap-2 hover:bg-slate-50 bg-transparent"
                        asChild
                      >
                        <Link href={`/portal/${contact.id}/${linkPath}`}>
                          <Star className={`w-5 h-5 ${config.color}`} />
                          <span className="text-xs text-center">{feature}</span>
                        </Link>
                      </Button>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Upcoming Showings */}
          {showings.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <Calendar className="w-5 h-5 text-blue-500" />
                  Upcoming Showings
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {showings.slice(0, 3).map((showing: any) => (
                    <div
                      key={showing.id}
                      className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 bg-slate-100 rounded-lg flex items-center justify-center">
                          <Home className="w-6 h-6 text-slate-600" />
                        </div>
                        <div>
                          <p className="font-medium">{showing.property_address || "Property Showing"}</p>
                          <p className="text-sm text-muted-foreground">
                            {showing.confirmed_date
                              ? new Date(showing.confirmed_date).toLocaleDateString("en-US", {
                                  weekday: "short",
                                  month: "short",
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                })
                              : showing.preferred_dates?.[0]
                                ? `Requested: ${new Date(showing.preferred_dates[0]).toLocaleDateString()}`
                                : "Awaiting confirmation"}
                          </p>
                        </div>
                      </div>
                      <Badge variant={showing.status === "confirmed" ? "default" : "secondary"}>
                        {showing.status || "Pending"}
                      </Badge>
                    </div>
                  ))}
                </div>
                <Button variant="outline" className="w-full mt-4 bg-transparent" asChild>
                  <Link href={`/portal/${contact.id}/showings`}>
                    View All Showings <ChevronRight className="w-4 h-4 ml-2" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Seller-Specific: Listing Performance */}
          {isSeller && contact.listings && contact.listings[0] && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-green-500" />
                  Your Listing Performance
                </CardTitle>
                <CardDescription>{contact.listings[0].address || "Your Property"}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-4 gap-4 mb-4">
                  <div className="text-center p-3 bg-slate-50 rounded-lg">
                    <Eye className="w-5 h-5 mx-auto text-blue-500 mb-1" />
                    <p className="text-xl font-bold">1,247</p>
                    <p className="text-xs text-muted-foreground">Views</p>
                  </div>
                  <div className="text-center p-3 bg-slate-50 rounded-lg">
                    <Heart className="w-5 h-5 mx-auto text-red-500 mb-1" />
                    <p className="text-xl font-bold">89</p>
                    <p className="text-xs text-muted-foreground">Saves</p>
                  </div>
                  <div className="text-center p-3 bg-slate-50 rounded-lg">
                    <Calendar className="w-5 h-5 mx-auto text-purple-500 mb-1" />
                    <p className="text-xl font-bold">12</p>
                    <p className="text-xs text-muted-foreground">Showings</p>
                  </div>
                  <div className="text-center p-3 bg-slate-50 rounded-lg">
                    <DollarSign className="w-5 h-5 mx-auto text-green-500 mb-1" />
                    <p className="text-xl font-bold">2</p>
                    <p className="text-xs text-muted-foreground">Offers</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button className="flex-1" asChild>
                    <Link href={`/portal/${contact.id}/listing`}>
                      View Listing <ChevronRight className="w-4 h-4 ml-2" />
                    </Link>
                  </Button>
                  <Button variant="outline">
                    <Share2 className="w-4 h-4 mr-2" /> Share
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Senior Persona: Memory Video Feature */}
          {persona === "senior" && (
            <Card className="bg-gradient-to-br from-rose-50 to-orange-50 border-rose-200">
              <CardContent className="p-6">
                <div className="flex items-start gap-4">
                  <div className="p-3 rounded-xl bg-white shadow-md">
                    <Camera className="w-8 h-8 text-rose-500" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-bold text-slate-900">Preserve Your Home's Memories</h3>
                    <p className="text-sm text-slate-600 mt-1">
                      We offer a complimentary video recording service to capture the special memories you've made in
                      this home. Share stories about family gatherings, milestones, and the love that filled these
                      walls.
                    </p>
                    <Button className="mt-4 bg-rose-500 hover:bg-rose-600">
                      <Play className="w-4 h-4 mr-2" /> Schedule Memory Video
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Journey Tab */}
        <TabsContent value="journey" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Your {isBuyer ? "Homebuying" : "Home Selling"} Journey</CardTitle>
              <CardDescription>Track your progress through each step of the process</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {milestones.length > 0 ? (
                  milestones.map((milestone, idx) => (
                    <div
                      key={milestone.id || idx}
                      className={`flex items-start gap-4 p-4 rounded-lg border ${
                        milestone.status === "completed"
                          ? "bg-green-50 border-green-200"
                          : milestone.status === "in_progress"
                            ? "bg-blue-50 border-blue-200"
                            : "bg-slate-50 border-slate-200"
                      }`}
                    >
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                          milestone.status === "completed"
                            ? "bg-green-500 text-white"
                            : milestone.status === "in_progress"
                              ? "bg-blue-500 text-white"
                              : "bg-slate-300 text-slate-600"
                        }`}
                      >
                        {milestone.status === "completed" ? (
                          <CheckCircle2 className="w-5 h-5" />
                        ) : (
                          <span className="text-sm font-bold">{idx + 1}</span>
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <h4 className="font-semibold">{milestone.name || milestone.milestone_name}</h4>
                          <Badge
                            variant={
                              milestone.status === "completed"
                                ? "default"
                                : milestone.status === "in_progress"
                                  ? "secondary"
                                  : "outline"
                            }
                          >
                            {milestone.status === "completed"
                              ? "Complete"
                              : milestone.status === "in_progress"
                                ? "In Progress"
                                : "Upcoming"}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">
                          {milestone.description || "Complete this step to move forward in your journey."}
                        </p>
                        {(milestone.target_date || milestone.due_date) && (
                          <p className="text-xs text-muted-foreground mt-2">
                            <Clock className="w-3 h-3 inline mr-1" />
                            Due: {new Date(milestone.target_date || milestone.due_date).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-12">
                    <Sparkles className="w-12 h-12 mx-auto text-slate-300 mb-4" />
                    <p className="text-muted-foreground">Your journey milestones will appear here</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Documents Tab */}
        <TabsContent value="documents">
          <ClientDocumentsWidget contactId={contact.id} />
        </TabsContent>

        {/* Messages Tab */}
        <TabsContent value="messages">
          <ClientMessagingWidget contactId={contact.id} />
        </TabsContent>

        {/* Team Tab */}
        <TabsContent value="team" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Your Real Estate Team</CardTitle>
              <CardDescription>We're here to support you every step of the way</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Primary Agent */}
              <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-lg">
                <Avatar className="w-16 h-16">
                  <AvatarImage src="/professional-real-estate-agent.png" />
                  <AvatarFallback>SA</AvatarFallback>
                </Avatar>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h4 className="font-semibold">Sarah Anderson</h4>
                    <Badge>Your Agent</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">Licensed REALTOR® | 10+ Years Experience</p>
                  <div className="flex gap-3 mt-2">
                    <Button size="sm" variant="outline">
                      <Phone className="w-4 h-4 mr-1" /> Call
                    </Button>
                    <Button size="sm" variant="outline">
                      <Mail className="w-4 h-4 mr-1" /> Email
                    </Button>
                    <Button size="sm" variant="outline">
                      <MessageSquare className="w-4 h-4 mr-1" /> Message
                    </Button>
                  </div>
                </div>
              </div>

              {/* Transaction Coordinator */}
              <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-lg">
                <Avatar className="w-12 h-12">
                  <AvatarImage src="/professional-woman-diverse.png" />
                  <AvatarFallback>JM</AvatarFallback>
                </Avatar>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h4 className="font-medium">Jessica Martinez</h4>
                    <Badge variant="outline">Transaction Coordinator</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">Handles paperwork & deadlines</p>
                </div>
                <Button size="sm" variant="ghost">
                  <Mail className="w-4 h-4" />
                </Button>
              </div>

              {/* Office Support */}
              <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-lg">
                <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
                  <Building className="w-6 h-6 text-blue-600" />
                </div>
                <div className="flex-1">
                  <h4 className="font-medium">VIP Agents Realty</h4>
                  <p className="text-sm text-muted-foreground flex items-center gap-1">
                    <MapPin className="w-3 h-3" /> 123 Main Street, Austin, TX 78701
                  </p>
                </div>
                <Button size="sm" variant="ghost">
                  <Phone className="w-4 h-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Floating Action Button for Quick Message */}
      <div className="fixed bottom-6 right-6">
        <Button size="lg" className="rounded-full shadow-lg h-14 w-14 p-0" onClick={() => setActiveTab("messages")}>
          <MessageSquare className="w-6 h-6" />
          {unreadMessages > 0 && (
            <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
              {unreadMessages}
            </span>
          )}
        </Button>
      </div>
    </div>
  )
}
