import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Home,
  DollarSign,
  FileText,
  Calendar,
  CheckCircle2,
  Clock,
  TrendingUp,
  MapPin,
  Heart,
  Star,
  AlertCircle,
  Shield,
  Users,
  Building,
  Scale,
  Briefcase,
  Plane,
  Baby,
  Video,
  Calculator,
  Key,
  HandHeart,
  Package,
  Gavel,
  Target,
  LineChart,
  UserCheck,
  MessageSquare,
} from "lucide-react"
import Link from "next/link"
import { PERSONA_LABELS } from "@/constants/crm-standards"
import { OfferStatusWidget } from "@/components/portal/OfferStatusWidget"
import { getAllEmpathyResponses } from "@/lib/them-first/empathy-library"

export default async function PersonaDashboardPage({
  params,
}: {
  params: Promise<{ contactId: string; persona: string }>
}) {
  const { contactId, persona } = await params
  const supabase = await createClient()

  // Fetch contact with related data
  const { data: contact } = await supabase
    .from("contacts")
    .select(`
      *,
      listings(*),
      transactions(*)
    `)
    .eq("id", contactId)
    .single()

  if (!contact) {
    redirect("/")
  }

  const isBuyer = contact.contact_type === "buyer"
  const isSeller = contact.contact_type === "seller"

  const personaConfig = getPersonaConfig(persona, isBuyer, isSeller, contactId)

  const empathyResponses = getAllEmpathyResponses(persona.replace(/_/g, "-"))

  const activeTransaction = contact.transactions?.[0] // Most recent transaction

  return (
    <div className="space-y-6">
      {/* Header with persona badge */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">
            Welcome Back, {contact.first_name || contact.name?.split(" ")[0]}
          </h1>
          <p className="text-muted-foreground mt-1">{personaConfig.welcomeMessage}</p>
        </div>
        <Badge variant="secondary" className="text-sm">
          {PERSONA_LABELS[persona as keyof typeof PERSONA_LABELS] || persona}
        </Badge>
      </div>

      {personaConfig.compassionateSupport && (
        <Alert className="border-blue-200 bg-blue-50">
          <HandHeart className="h-5 w-5 text-blue-600" />
          <AlertTitle className="text-blue-800">{personaConfig.compassionateSupport.title}</AlertTitle>
          <AlertDescription className="text-blue-700">{personaConfig.compassionateSupport.message}</AlertDescription>
        </Alert>
      )}

      {/* Main Layout: 2/3 Content + 1/3 Sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT/CENTER: Main Content (2/3 width) */}
        <div className="lg:col-span-2 space-y-6">
          <OfferStatusWidget contactId={contactId} isBuyer={isBuyer} />

          {/* Journey Progress */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                Your {personaConfig.journeyTitle || (isBuyer ? "Buying" : "Selling")} Journey
              </CardTitle>
              <CardDescription>{personaConfig.journeyDescription}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between text-sm">
                  <span>Progress to {personaConfig.goalLabel}</span>
                  <span className="font-semibold">{personaConfig.progressPercent}%</span>
                </div>
                <Progress value={personaConfig.progressPercent} className="h-2" />
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
                  {personaConfig.milestones.map((milestone: any, idx: number) => (
                    <div key={idx} className="flex items-center gap-2">
                      {milestone.completed ? (
                        <CheckCircle2 className="h-5 w-5 text-green-600" />
                      ) : (
                        <Clock className="h-5 w-5 text-muted-foreground" />
                      )}
                      <span className={milestone.completed ? "text-sm" : "text-sm text-muted-foreground"}>
                        {milestone.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Quick Actions - Persona Specific */}
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {personaConfig.quickActions.map((action: any, idx: number) => (
              <Card key={idx} className="hover:shadow-md transition-shadow">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    {action.icon}
                    {action.title}
                  </CardTitle>
                  <CardDescription>{action.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Link href={action.link}>
                    <Button className="w-full">{action.buttonText}</Button>
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Persona-Specific Content Cards */}
          <div className="grid md:grid-cols-2 gap-6">
            {personaConfig.contentCards.map((card: any, idx: number) => (
              <Card key={idx}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {card.icon}
                    {card.title}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {card.items.map((item: any, itemIdx: number) => (
                      <div key={itemIdx} className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                        {item.icon}
                        <div className="flex-1">
                          <p className="font-medium text-sm">{item.title}</p>
                          <p className="text-xs text-muted-foreground mt-1">{item.description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {empathyResponses && empathyResponses.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <HandHeart className="h-5 w-5" />
                  We Understand Your Concerns
                </CardTitle>
                <CardDescription>Common questions and worries - and how we can help</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {empathyResponses.slice(0, 2).map((response: any, idx: number) => (
                    <div key={idx} className="p-4 rounded-lg border bg-background">
                      <p className="font-medium text-sm text-foreground mb-2">"{response.pain}"</p>
                      <p className="text-sm text-muted-foreground">{response.empathy}</p>
                      <p className="text-sm text-blue-600 mt-2">{response.solution}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Resources Section */}
          <Card>
            <CardHeader>
              <CardTitle>Resources for {PERSONA_LABELS[persona as keyof typeof PERSONA_LABELS] || "You"}</CardTitle>
              <CardDescription>Curated guides and tools for your situation</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-3 gap-4">
                {personaConfig.resources.map((resource: any, idx: number) => (
                  <Link key={idx} href={resource.link}>
                    <div className="p-4 rounded-lg border hover:bg-muted/50 transition-colors">
                      <h4 className="font-semibold text-sm mb-2">{resource.title}</h4>
                      <p className="text-xs text-muted-foreground">{resource.description}</p>
                    </div>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* RIGHT SIDEBAR (1/3 width) - Transaction Widgets */}
        <div className="lg:col-span-1 space-y-6">
          {/* Active Transaction Status */}
          {activeTransaction ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Active Transaction</CardTitle>
                  <CardDescription>
                    {activeTransaction.listings?.address || activeTransaction.property_address || "Your Property"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-muted-foreground">Status</span>
                      <Badge variant={activeTransaction.status === "closed" ? "default" : "secondary"}>
                        {activeTransaction.status}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-muted-foreground">Stage</span>
                      <span className="text-sm font-medium">{activeTransaction.current_stage || "In Progress"}</span>
                    </div>
                    {activeTransaction.closing_date && (
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Closing Date</span>
                        <span className="text-sm font-medium">
                          {new Date(activeTransaction.closing_date).toLocaleDateString()}
                        </span>
                      </div>
                    )}
                  </div>
                  <Button className="w-full" asChild>
                    <Link href={`/portal/${contactId}/transaction/${activeTransaction.id}`}>View Details</Link>
                  </Button>
                </CardContent>
              </Card>

              {/* Transaction Timeline Widget */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Next Milestones
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {personaConfig.milestones
                      .filter((m: any) => !m.completed)
                      .slice(0, 3)
                      .map((milestone: any, idx: number) => (
                        <div key={idx} className="flex items-center gap-3 p-2 rounded-lg bg-muted/50">
                          <Clock className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm">{milestone.label}</span>
                        </div>
                      ))}
                  </div>
                </CardContent>
              </Card>

              {/* Quick Actions for Transaction */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Quick Actions</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Button variant="outline" className="w-full justify-start bg-transparent" size="sm" asChild>
                    <Link href={`/portal/${contactId}/documents`}>
                      <FileText className="h-4 w-4 mr-2" />
                      View Documents
                    </Link>
                  </Button>
                  <Button variant="outline" className="w-full justify-start bg-transparent" size="sm" asChild>
                    <Link href={`/portal/${contactId}/schedule`}>
                      <Calendar className="h-4 w-4 mr-2" />
                      Schedule Meeting
                    </Link>
                  </Button>
                  <Button variant="outline" className="w-full justify-start bg-transparent" size="sm">
                    <Calculator className="h-4 w-4 mr-2" />
                    Use Calculator
                  </Button>
                </CardContent>
              </Card>
            </>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">No Active Transaction</CardTitle>
                <CardDescription>Start your journey today</CardDescription>
              </CardHeader>
              <CardContent>
                <Button className="w-full" asChild>
                  <Link href={`/portal/${contactId}/properties`}>
                    {isBuyer ? "Browse Properties" : "List Your Property"}
                  </Link>
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Contact Your Agent */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Need Help?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground mb-3">Your agent is here to help</p>
              <Button variant="outline" className="w-full justify-start bg-transparent" size="sm" asChild>
                <Link href={`/portal/${contactId}/video-call`}>
                  <Video className="h-4 w-4 mr-2" />
                  Video Call
                </Link>
              </Button>
              <Button variant="outline" className="w-full justify-start bg-transparent" size="sm">
                <MessageSquare className="h-4 w-4 mr-2" />
                Send Message
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function getPersonaConfig(persona: string, isBuyer: boolean, isSeller: boolean, contactId: string) {
  const configs: Record<string, any> = {
    // ==================== BUYER PERSONAS ====================
    first_time_buyer: {
      welcomeMessage: "Let's make your first home purchase smooth and stress-free",
      journeyDescription: "You're on the path to becoming a homeowner!",
      goalLabel: "Closing Day",
      progressPercent: 45,
      milestones: [
        { label: "Pre-Approved", completed: true },
        { label: "House Hunting", completed: true },
        { label: "Offer Submitted", completed: false },
        { label: "Closing", completed: false },
      ],
      quickActions: [
        {
          icon: <Home className="h-5 w-5" />,
          title: "Browse Properties",
          description: "View homes that match your criteria",
          link: `/portal/${contactId}/properties`,
          buttonText: "See Properties",
        },
        {
          icon: <FileText className="h-5 w-5" />,
          title: "Pre-Approval Letter",
          description: "Upload or view your financing documents",
          link: `/portal/${contactId}/documents`,
          buttonText: "View Documents",
        },
        {
          icon: <Calendar className="h-5 w-5" />,
          title: "Schedule Showing",
          description: "Book a time to see homes you love",
          link: `/portal/${contactId}/schedule`,
          buttonText: "Schedule Now",
        },
      ],
      contentCards: [
        {
          icon: <Star className="h-5 w-5" />,
          title: "Your Saved Favorites",
          items: [
            { icon: <Heart className="h-4 w-4 text-red-500" />, title: "3 Properties Saved", description: "Ready to make an offer?" },
            { icon: <MapPin className="h-4 w-4" />, title: "2 Showings Scheduled", description: "This week" },
          ],
        },
        {
          icon: <AlertCircle className="h-5 w-5" />,
          title: "Next Steps",
          items: [
            { icon: <CheckCircle2 className="h-4 w-4" />, title: "Review Neighborhood Guide", description: "Learn about local schools & amenities" },
            { icon: <Clock className="h-4 w-4" />, title: "Prepare Questions", description: "What to ask at showings" },
          ],
        },
      ],
      resources: [
        { title: "First-Time Buyer Guide", description: "Complete walkthrough of the process", link: "#" },
        { title: "Mortgage Calculator", description: "Estimate your monthly payments", link: "#" },
        { title: "Closing Cost Estimator", description: "Plan for additional expenses", link: "#" },
      ],
    },

    military_buyer: {
      welcomeMessage: "Thank you for your service. Let's find your next home near base.",
      journeyDescription: "Navigating your PCS move with VA benefits",
      goalLabel: "Keys in Hand",
      progressPercent: 60,
      milestones: [
        { label: "VA Pre-Approval", completed: true },
        { label: "Base Area Research", completed: true },
        { label: "Making Offer", completed: true },
        { label: "Closing", completed: false },
      ],
      quickActions: [
        {
          icon: <Home className="h-5 w-5" />,
          title: "Homes Near Base",
          description: "Properties within commuting distance",
          link: `/portal/${contactId}/properties`,
          buttonText: "View Homes",
        },
        {
          icon: <FileText className="h-5 w-5" />,
          title: "VA Loan Status",
          description: "Check your Certificate of Eligibility",
          link: `/portal/${contactId}/documents`,
          buttonText: "View COE",
        },
        {
          icon: <DollarSign className="h-5 w-5" />,
          title: "BAH Calculator",
          description: "Calculate housing allowance benefits",
          link: `/portal/${contactId}/calculator`,
          buttonText: "Calculate",
        },
      ],
      contentCards: [
        {
          icon: <MapPin className="h-5 w-5" />,
          title: "PCS Timeline",
          items: [
            { icon: <Calendar className="h-4 w-4" />, title: "Report Date: Jan 15", description: "45 days to find housing" },
            { icon: <CheckCircle2 className="h-4 w-4" />, title: "Remote Closing Available", description: "No need to travel back" },
          ],
        },
        {
          icon: <Star className="h-5 w-5" />,
          title: "VA Benefits",
          items: [
            { icon: <DollarSign className="h-4 w-4" />, title: "$0 Down Payment", description: "Using full VA entitlement" },
            { icon: <FileText className="h-4 w-4" />, title: "No PMI Required", description: "Saving $200+/month" },
          ],
        },
      ],
      resources: [
        { title: "VA Loan Guide", description: "Maximize your military benefits", link: "#" },
        { title: "Base Commute Map", description: "Traffic patterns & drive times", link: "#" },
        { title: "Military Housing FAQ", description: "Common questions answered", link: "#" },
      ],
    },

    luxury_buyer: {
      welcomeMessage: "Exceptional properties for discerning buyers",
      journeyDescription: "Finding your distinguished residence",
      goalLabel: "Your Perfect Home",
      progressPercent: 35,
      milestones: [
        { label: "Requirements Defined", completed: true },
        { label: "Private Viewings", completed: false },
        { label: "Negotiations", completed: false },
        { label: "Closing", completed: false },
      ],
      quickActions: [
        {
          icon: <Home className="h-5 w-5" />,
          title: "Exclusive Listings",
          description: "Private and off-market properties",
          link: `/portal/${contactId}/properties`,
          buttonText: "View Collection",
        },
        {
          icon: <Calendar className="h-5 w-5" />,
          title: "Private Viewings",
          description: "Discreet, scheduled appointments",
          link: `/portal/${contactId}/schedule`,
          buttonText: "Request Viewing",
        },
        {
          icon: <Shield className="h-5 w-5" />,
          title: "Confidential Documents",
          description: "Secure document exchange",
          link: `/portal/${contactId}/documents`,
          buttonText: "Access Vault",
        },
      ],
      contentCards: [
        {
          icon: <Building className="h-5 w-5" />,
          title: "Curated Properties",
          items: [
            { icon: <Star className="h-4 w-4 text-amber-500" />, title: "5 Exclusive Listings", description: "Matched to your criteria" },
            { icon: <Key className="h-4 w-4" />, title: "2 Off-Market Options", description: "Not publicly available" },
          ],
        },
        {
          icon: <Shield className="h-5 w-5" />,
          title: "Privacy Assured",
          items: [
            { icon: <CheckCircle2 className="h-4 w-4" />, title: "Confidential Search", description: "Your privacy is protected" },
            { icon: <UserCheck className="h-4 w-4" />, title: "Pre-Qualified Sellers", description: "Verified property owners" },
          ],
        },
      ],
      resources: [
        { title: "Luxury Market Report", description: "Current trends and insights", link: "#" },
        { title: "Investment Analysis", description: "Property value projections", link: "#" },
        { title: "Concierge Services", description: "White-glove support", link: "#" },
      ],
    },

    investor: {
      welcomeMessage: "Let's build your real estate portfolio",
      journeyDescription: "Acquiring properties with strong returns",
      goalLabel: "Portfolio Growth",
      progressPercent: 50,
      milestones: [
        { label: "Strategy Defined", completed: true },
        { label: "Deal Analysis", completed: true },
        { label: "Under Contract", completed: false },
        { label: "Closed & Rented", completed: false },
      ],
      quickActions: [
        {
          icon: <Target className="h-5 w-5" />,
          title: "Investment Properties",
          description: "Properties with cash flow potential",
          link: `/portal/${contactId}/properties`,
          buttonText: "Analyze Deals",
        },
        {
          icon: <LineChart className="h-5 w-5" />,
          title: "ROI Calculator",
          description: "Calculate cap rates and returns",
          link: `/portal/${contactId}/calculator`,
          buttonText: "Run Numbers",
        },
        {
          icon: <Building className="h-5 w-5" />,
          title: "Portfolio Overview",
          description: "Track your investments",
          link: `/portal/${contactId}/portfolio`,
          buttonText: "View Portfolio",
        },
      ],
      contentCards: [
        {
          icon: <TrendingUp className="h-5 w-5" />,
          title: "Market Opportunities",
          items: [
            { icon: <DollarSign className="h-4 w-4 text-green-600" />, title: "3 High-Cap Properties", description: "7%+ cap rate potential" },
            { icon: <Home className="h-4 w-4" />, title: "2 Value-Add Deals", description: "Below market with upside" },
          ],
        },
        {
          icon: <Calculator className="h-5 w-5" />,
          title: "Investment Metrics",
          items: [
            { icon: <LineChart className="h-4 w-4" />, title: "Avg. Cap Rate: 6.5%", description: "Current market average" },
            { icon: <TrendingUp className="h-4 w-4" />, title: "Appreciation: 5.2%", description: "Year-over-year growth" },
          ],
        },
      ],
      resources: [
        { title: "Investor Market Report", description: "Cap rates by neighborhood", link: "#" },
        { title: "1031 Exchange Guide", description: "Tax-deferred strategies", link: "#" },
        { title: "Property Management", description: "Rental management options", link: "#" },
      ],
    },

    relocating: {
      welcomeMessage: "Welcome to your new city - let's find your home",
      journeyDescription: "Making your relocation smooth and stress-free",
      goalLabel: "Settled In",
      progressPercent: 40,
      milestones: [
        { label: "Area Research", completed: true },
        { label: "Virtual Tours", completed: true },
        { label: "Visit & Decide", completed: false },
        { label: "Move In", completed: false },
      ],
      quickActions: [
        {
          icon: <MapPin className="h-5 w-5" />,
          title: "Neighborhood Guide",
          description: "Explore your new area",
          link: `/portal/${contactId}/neighborhoods`,
          buttonText: "Explore",
        },
        {
          icon: <Video className="h-5 w-5" />,
          title: "Virtual Tours",
          description: "View homes from anywhere",
          link: `/portal/${contactId}/properties`,
          buttonText: "Take Tours",
        },
        {
          icon: <Plane className="h-5 w-5" />,
          title: "Schedule Visit",
          description: "Plan your house hunting trip",
          link: `/portal/${contactId}/schedule`,
          buttonText: "Plan Trip",
        },
      ],
      contentCards: [
        {
          icon: <MapPin className="h-5 w-5" />,
          title: "Your New Area",
          items: [
            { icon: <Building className="h-4 w-4" />, title: "5 Neighborhoods Matched", description: "Based on your preferences" },
            { icon: <Clock className="h-4 w-4" />, title: "Commute Analysis", description: "Routes to your workplace" },
          ],
        },
        {
          icon: <Package className="h-5 w-5" />,
          title: "Relocation Support",
          items: [
            { icon: <CheckCircle2 className="h-4 w-4" />, title: "Mover Referrals", description: "Trusted moving companies" },
            { icon: <Users className="h-4 w-4" />, title: "Local Connections", description: "Schools, doctors, services" },
          ],
        },
      ],
      resources: [
        { title: "Newcomer's Guide", description: "Everything about your new city", link: "#" },
        { title: "School Ratings", description: "Local school information", link: "#" },
        { title: "Cost of Living", description: "Compare expenses", link: "#" },
      ],
    },

    upsizers: {
      welcomeMessage: "Time for more space - let's find your bigger home",
      journeyDescription: "Coordinating your move to accommodate your growing needs",
      goalLabel: "Moved In",
      progressPercent: 30,
      milestones: [
        { label: "Needs Assessment", completed: true },
        { label: "Sell/Buy Strategy", completed: false },
        { label: "Under Contract", completed: false },
        { label: "Moved", completed: false },
      ],
      quickActions: [
        {
          icon: <Home className="h-5 w-5" />,
          title: "Larger Homes",
          description: "Properties with more space",
          link: `/portal/${contactId}/properties`,
          buttonText: "Browse",
        },
        {
          icon: <DollarSign className="h-5 w-5" />,
          title: "Home Value",
          description: "What's your current home worth?",
          link: `/portal/${contactId}/valuation`,
          buttonText: "Get Estimate",
        },
        {
          icon: <Calendar className="h-5 w-5" />,
          title: "Timeline Planning",
          description: "Coordinate sell and buy",
          link: `/portal/${contactId}/timeline`,
          buttonText: "Plan",
        },
      ],
      contentCards: [
        {
          icon: <Home className="h-5 w-5" />,
          title: "Space Requirements",
          items: [
            { icon: <Baby className="h-4 w-4" />, title: "Growing Family", description: "More bedrooms needed" },
            { icon: <Briefcase className="h-4 w-4" />, title: "Home Office", description: "Dedicated work space" },
          ],
        },
        {
          icon: <Scale className="h-5 w-5" />,
          title: "Buy/Sell Options",
          items: [
            { icon: <TrendingUp className="h-4 w-4" />, title: "Bridge Loan Available", description: "Buy before you sell" },
            { icon: <Clock className="h-4 w-4" />, title: "Rent-Back Option", description: "Stay after closing" },
          ],
        },
      ],
      resources: [
        { title: "Upsizing Guide", description: "Coordinating dual transactions", link: "#" },
        { title: "Bridge Financing", description: "Options for timing flexibility", link: "#" },
        { title: "Moving Checklist", description: "Stay organized", link: "#" },
      ],
    },

    // ==================== SELLER PERSONAS ====================
    first_time_seller: {
      welcomeMessage: "Let's get your home sold for top dollar",
      journeyDescription: "Your first home sale, expertly guided",
      goalLabel: "Sold!",
      progressPercent: 25,
      milestones: [
        { label: "Consultation", completed: true },
        { label: "Prep & List", completed: false },
        { label: "Offers & Negotiate", completed: false },
        { label: "Close", completed: false },
      ],
      quickActions: [
        {
          icon: <DollarSign className="h-5 w-5" />,
          title: "Home Valuation",
          description: "See what your home is worth",
          link: `/portal/${contactId}/valuation`,
          buttonText: "Get Value",
        },
        {
          icon: <FileText className="h-5 w-5" />,
          title: "Listing Checklist",
          description: "Prepare your home for sale",
          link: `/portal/${contactId}/checklist`,
          buttonText: "View Checklist",
        },
        {
          icon: <Calculator className="h-5 w-5" />,
          title: "Net Sheet",
          description: "Calculate your proceeds",
          link: `/portal/${contactId}/net-sheet`,
          buttonText: "Calculate",
        },
      ],
      contentCards: [
        {
          icon: <Home className="h-5 w-5" />,
          title: "Preparation",
          items: [
            { icon: <CheckCircle2 className="h-4 w-4" />, title: "Pre-List Inspection", description: "Know your home's condition" },
            { icon: <Star className="h-4 w-4" />, title: "Staging Tips", description: "Maximize appeal" },
          ],
        },
        {
          icon: <TrendingUp className="h-5 w-5" />,
          title: "Market Insights",
          items: [
            { icon: <DollarSign className="h-4 w-4" />, title: "Comparable Sales", description: "Recent neighborhood sales" },
            { icon: <Clock className="h-4 w-4" />, title: "Days on Market", description: "Average 21 days" },
          ],
        },
      ],
      resources: [
        { title: "First-Time Seller Guide", description: "Step-by-step process", link: "#" },
        { title: "Staging Guide", description: "Prepare your home", link: "#" },
        { title: "Closing Cost Guide", description: "Understand seller fees", link: "#" },
      ],
    },

    motivated_seller: {
      welcomeMessage: "We'll get your home sold quickly and efficiently",
      journeyDescription: "Fast-track sale with maximum results",
      goalLabel: "Quick Close",
      progressPercent: 40,
      compassionateSupport: {
        title: "We're Here to Help",
        message:
          "We understand you need to sell quickly. Whatever your situation, we'll work efficiently while still getting you the best possible outcome.",
      },
      milestones: [
        { label: "Strategy Set", completed: true },
        { label: "Listed", completed: true },
        { label: "Offers", completed: false },
        { label: "Closed", completed: false },
      ],
      quickActions: [
        {
          icon: <Clock className="h-5 w-5" />,
          title: "Quick Sale Options",
          description: "Fastest path to closing",
          link: `/portal/${contactId}/quick-sale`,
          buttonText: "View Options",
        },
        {
          icon: <DollarSign className="h-5 w-5" />,
          title: "Instant Offers",
          description: "Cash buyer options",
          link: `/portal/${contactId}/instant-offers`,
          buttonText: "Get Offers",
        },
        {
          icon: <FileText className="h-5 w-5" />,
          title: "Documents",
          description: "Sign and submit remotely",
          link: `/portal/${contactId}/documents`,
          buttonText: "View Docs",
        },
      ],
      contentCards: [
        {
          icon: <TrendingUp className="h-5 w-5" />,
          title: "Sale Progress",
          items: [
            { icon: <CheckCircle2 className="h-4 w-4 text-green-600" />, title: "Aggressive Pricing", description: "Positioned to sell fast" },
            { icon: <Users className="h-4 w-4" />, title: "Maximum Exposure", description: "All marketing channels active" },
          ],
        },
        {
          icon: <Clock className="h-5 w-5" />,
          title: "Timeline",
          items: [
            { icon: <Calendar className="h-4 w-4" />, title: "Target: 30 Days", description: "To accepted offer" },
            { icon: <Key className="h-4 w-4" />, title: "Fast Close", description: "21-day escrow available" },
          ],
        },
      ],
      resources: [
        { title: "Quick Sale Guide", description: "Fastest closing strategies", link: "#" },
        { title: "Cash Buyer Options", description: "Instant offer programs", link: "#" },
        { title: "Moving Resources", description: "Short-notice moving help", link: "#" },
      ],
    },

    luxury_seller: {
      welcomeMessage: "Premium marketing for your distinguished property",
      journeyDescription: "Positioning your estate for maximum value",
      goalLabel: "Premium Sale",
      progressPercent: 35,
      milestones: [
        { label: "Strategy", completed: true },
        { label: "Professional Media", completed: false },
        { label: "Private Marketing", completed: false },
        { label: "Closed", completed: false },
      ],
      quickActions: [
        {
          icon: <Video className="h-5 w-5" />,
          title: "Property Media",
          description: "Professional photography and video",
          link: `/portal/${contactId}/media`,
          buttonText: "View Media",
        },
        {
          icon: <Shield className="h-5 w-5" />,
          title: "Private Showings",
          description: "Qualified buyer appointments",
          link: `/portal/${contactId}/showings`,
          buttonText: "Manage",
        },
        {
          icon: <LineChart className="h-5 w-5" />,
          title: "Market Position",
          description: "Competitive analysis",
          link: `/portal/${contactId}/analysis`,
          buttonText: "View Report",
        },
      ],
      contentCards: [
        {
          icon: <Star className="h-5 w-5" />,
          title: "Marketing Suite",
          items: [
            { icon: <Video className="h-4 w-4" />, title: "Cinematic Video", description: "Professional production" },
            { icon: <Building className="h-4 w-4" />, title: "Global Exposure", description: "International buyer network" },
          ],
        },
        {
          icon: <Shield className="h-5 w-5" />,
          title: "Discretion",
          items: [
            { icon: <UserCheck className="h-4 w-4" />, title: "Pre-Qualified Only", description: "All buyers verified" },
            { icon: <Key className="h-4 w-4" />, title: "Private Showings", description: "By appointment only" },
          ],
        },
      ],
      resources: [
        { title: "Luxury Marketing Plan", description: "Premium property strategy", link: "#" },
        { title: "Global Reach", description: "International buyer access", link: "#" },
        { title: "Concierge Services", description: "White-glove support", link: "#" },
      ],
    },

    // ==================== SENSITIVE SITUATION PERSONAS ====================
    divorce: {
      welcomeMessage: "We'll handle this transition with care and professionalism",
      journeyDescription: "Navigating your home sale during a difficult time",
      journeyTitle: "Transition",
      goalLabel: "Fresh Start",
      progressPercent: 30,
      compassionateSupport: {
        title: "We Understand This Is Difficult",
        message:
          "Selling your home during a divorce adds stress to an already challenging time. We'll maintain complete neutrality, communicate clearly with all parties, and handle everything with sensitivity and discretion.",
      },
      milestones: [
        { label: "Agreement", completed: true },
        { label: "Listing", completed: false },
        { label: "Sale", completed: false },
        { label: "Distribution", completed: false },
      ],
      quickActions: [
        {
          icon: <Scale className="h-5 w-5" />,
          title: "Equity Calculator",
          description: "Understand the division",
          link: `/portal/${contactId}/equity`,
          buttonText: "Calculate",
        },
        {
          icon: <FileText className="h-5 w-5" />,
          title: "Documents",
          description: "Required paperwork",
          link: `/portal/${contactId}/documents`,
          buttonText: "View Docs",
        },
        {
          icon: <Calendar className="h-5 w-5" />,
          title: "Timeline",
          description: "Court dates and deadlines",
          link: `/portal/${contactId}/timeline`,
          buttonText: "View Timeline",
        },
      ],
      contentCards: [
        {
          icon: <Scale className="h-5 w-5" />,
          title: "Neutral Process",
          items: [
            { icon: <CheckCircle2 className="h-4 w-4" />, title: "Equal Communication", description: "Both parties informed equally" },
            { icon: <FileText className="h-4 w-4" />, title: "Attorney Coordination", description: "Working with legal teams" },
          ],
        },
        {
          icon: <DollarSign className="h-5 w-5" />,
          title: "Financial Clarity",
          items: [
            { icon: <Calculator className="h-4 w-4" />, title: "Net Proceeds", description: "Clear breakdown for both" },
            { icon: <Clock className="h-4 w-4" />, title: "Timeline Aligned", description: "With court requirements" },
          ],
        },
      ],
      resources: [
        { title: "Divorce Home Sale Guide", description: "What to expect", link: "#" },
        { title: "Equity Split Calculator", description: "Fair division tool", link: "#" },
        { title: "Legal Coordination", description: "Working with attorneys", link: "#" },
      ],
    },

    probate: {
      welcomeMessage: "We'll handle your family's property with care",
      journeyDescription: "Managing the estate sale during a difficult time",
      journeyTitle: "Estate",
      goalLabel: "Estate Settled",
      progressPercent: 20,
      compassionateSupport: {
        title: "Our Deepest Condolences",
        message:
          "We understand you're dealing with the loss of a loved one while managing estate responsibilities. We'll take as much off your plate as possible and guide you through each step with patience and respect.",
      },
      milestones: [
        { label: "Probate Filed", completed: true },
        { label: "Property Prep", completed: false },
        { label: "Listed", completed: false },
        { label: "Closed", completed: false },
      ],
      quickActions: [
        {
          icon: <Gavel className="h-5 w-5" />,
          title: "Probate Guide",
          description: "Legal requirements explained",
          link: `/portal/${contactId}/probate-guide`,
          buttonText: "Learn More",
        },
        {
          icon: <Package className="h-5 w-5" />,
          title: "Estate Services",
          description: "Cleanout and preparation help",
          link: `/portal/${contactId}/estate-services`,
          buttonText: "Get Help",
        },
        {
          icon: <FileText className="h-5 w-5" />,
          title: "Documents",
          description: "Required court paperwork",
          link: `/portal/${contactId}/documents`,
          buttonText: "View Docs",
        },
      ],
      contentCards: [
        {
          icon: <Gavel className="h-5 w-5" />,
          title: "Legal Process",
          items: [
            { icon: <FileText className="h-4 w-4" />, title: "Letters Testamentary", description: "Court authorization" },
            { icon: <Calendar className="h-4 w-4" />, title: "Timeline", description: "Working with court schedule" },
          ],
        },
        {
          icon: <HandHeart className="h-5 w-5" />,
          title: "Support Services",
          items: [
            { icon: <Package className="h-4 w-4" />, title: "Estate Cleanout", description: "Professional services available" },
            { icon: <Home className="h-4 w-4" />, title: "Property Preparation", description: "Repairs and staging" },
          ],
        },
      ],
      resources: [
        { title: "Probate Sale Guide", description: "Complete walkthrough", link: "#" },
        { title: "Estate Services", description: "Cleanout and auction options", link: "#" },
        { title: "Legal Resources", description: "Attorney coordination", link: "#" },
      ],
    },

    senior: {
      welcomeMessage: "Let's find your perfect next chapter",
      journeyDescription: "Transitioning to a home that fits your lifestyle",
      journeyTitle: "Transition",
      goalLabel: "New Home",
      progressPercent: 25,
      compassionateSupport: {
        title: "We're Here Every Step of the Way",
        message:
          "Moving after many years in your home is a big transition. We'll take our time, answer every question, and make sure you feel comfortable with each decision.",
      },
      milestones: [
        { label: "Consultation", completed: true },
        { label: "Options Reviewed", completed: false },
        { label: "Decision Made", completed: false },
        { label: "Moved", completed: false },
      ],
      quickActions: [
        {
          icon: <Home className="h-5 w-5" />,
          title: "Housing Options",
          description: "55+, assisted living, downsizing",
          link: `/portal/${contactId}/options`,
          buttonText: "Explore",
        },
        {
          icon: <DollarSign className="h-5 w-5" />,
          title: "Home Value",
          description: "What's your home worth?",
          link: `/portal/${contactId}/valuation`,
          buttonText: "Get Estimate",
        },
        {
          icon: <Video className="h-5 w-5" />,
          title: "Family Video",
          description: "Share memories of your home",
          link: `/portal/${contactId}/memory-video`,
          buttonText: "Create Video",
        },
      ],
      contentCards: [
        {
          icon: <Home className="h-5 w-5" />,
          title: "Next Chapter Options",
          items: [
            { icon: <Building className="h-4 w-4" />, title: "55+ Communities", description: "Active adult living" },
            { icon: <Heart className="h-4 w-4" />, title: "Assisted Living", description: "Care when needed" },
          ],
        },
        {
          icon: <Package className="h-5 w-5" />,
          title: "Transition Support",
          items: [
            { icon: <Users className="h-4 w-4" />, title: "Downsizing Help", description: "Professional organizers" },
            { icon: <Video className="h-4 w-4" />, title: "Memory Preservation", description: "Document your home's history" },
          ],
        },
      ],
      resources: [
        { title: "Senior Housing Guide", description: "All your options explained", link: "#" },
        { title: "Downsizing Tips", description: "Make it manageable", link: "#" },
        { title: "Family Discussion Guide", description: "Involve your loved ones", link: "#" },
      ],
    },

    remote_seller: {
      welcomeMessage: "We'll handle everything while you're away",
      journeyDescription: "Selling your property from a distance",
      goalLabel: "Sold & Closed",
      progressPercent: 35,
      milestones: [
        { label: "Remote Setup", completed: true },
        { label: "Property Prep", completed: false },
        { label: "Listed", completed: false },
        { label: "Closed", completed: false },
      ],
      quickActions: [
        {
          icon: <Video className="h-5 w-5" />,
          title: "Video Updates",
          description: "See your property progress",
          link: `/portal/${contactId}/updates`,
          buttonText: "View Updates",
        },
        {
          icon: <Users className="h-5 w-5" />,
          title: "Vendor Coordination",
          description: "Contractors and services",
          link: `/portal/${contactId}/vendors`,
          buttonText: "Manage",
        },
        {
          icon: <FileText className="h-5 w-5" />,
          title: "E-Sign Documents",
          description: "Sign everything remotely",
          link: `/portal/${contactId}/documents`,
          buttonText: "Sign Docs",
        },
      ],
      contentCards: [
        {
          icon: <Video className="h-5 w-5" />,
          title: "Remote Management",
          items: [
            { icon: <CheckCircle2 className="h-4 w-4" />, title: "Weekly Video Updates", description: "See everything" },
            { icon: <Users className="h-4 w-4" />, title: "Vendor Management", description: "All coordinated for you" },
          ],
        },
        {
          icon: <FileText className="h-5 w-5" />,
          title: "Digital Process",
          items: [
            { icon: <FileText className="h-4 w-4" />, title: "E-Signatures", description: "No travel needed" },
            { icon: <DollarSign className="h-4 w-4" />, title: "Wire Closing", description: "Funds transferred securely" },
          ],
        },
      ],
      resources: [
        { title: "Remote Selling Guide", description: "How we handle everything", link: "#" },
        { title: "Power of Attorney Info", description: "If needed for closing", link: "#" },
        { title: "Vendor Network", description: "Trusted local pros", link: "#" },
      ],
    },

    fsbo: {
      welcomeMessage: "Let's get your home the exposure it deserves",
      journeyDescription: "Professional support for your sale",
      goalLabel: "Sold",
      progressPercent: 30,
      milestones: [
        { label: "Consultation", completed: true },
        { label: "Listed with Agent", completed: false },
        { label: "Under Contract", completed: false },
        { label: "Closed", completed: false },
      ],
      quickActions: [
        {
          icon: <DollarSign className="h-5 w-5" />,
          title: "Free CMA",
          description: "Professional market analysis",
          link: `/portal/${contactId}/cma`,
          buttonText: "Get CMA",
        },
        {
          icon: <TrendingUp className="h-5 w-5" />,
          title: "Marketing Plan",
          description: "How we'll expose your home",
          link: `/portal/${contactId}/marketing`,
          buttonText: "See Plan",
        },
        {
          icon: <Calculator className="h-5 w-5" />,
          title: "Net Comparison",
          description: "FSBO vs. agent-assisted",
          link: `/portal/${contactId}/compare`,
          buttonText: "Compare",
        },
      ],
      contentCards: [
        {
          icon: <TrendingUp className="h-5 w-5" />,
          title: "Why List With Us",
          items: [
            { icon: <Users className="h-4 w-4" />, title: "MLS Exposure", description: "Reach all buyers" },
            { icon: <DollarSign className="h-4 w-4" />, title: "Higher Net Price", description: "Stats show 6%+ more" },
          ],
        },
        {
          icon: <Star className="h-5 w-5" />,
          title: "Professional Support",
          items: [
            { icon: <FileText className="h-4 w-4" />, title: "Contract Expertise", description: "Avoid costly mistakes" },
            { icon: <Scale className="h-4 w-4" />, title: "Negotiation", description: "Get better terms" },
          ],
        },
      ],
      resources: [
        { title: "FSBO to Agent Guide", description: "Why sellers switch", link: "#" },
        { title: "Marketing Examples", description: "How we showcase homes", link: "#" },
        { title: "Success Stories", description: "Former FSBO clients", link: "#" },
      ],
    },

    expired: {
      welcomeMessage: "Let's get your home sold this time",
      journeyDescription: "A fresh approach for better results",
      goalLabel: "Sold!",
      progressPercent: 20,
      milestones: [
        { label: "Analysis Complete", completed: true },
        { label: "New Strategy", completed: false },
        { label: "Re-Listed", completed: false },
        { label: "Sold", completed: false },
      ],
      quickActions: [
        {
          icon: <Target className="h-5 w-5" />,
          title: "Why It Didn't Sell",
          description: "Honest analysis",
          link: `/portal/${contactId}/analysis`,
          buttonText: "See Report",
        },
        {
          icon: <TrendingUp className="h-5 w-5" />,
          title: "New Marketing Plan",
          description: "Different approach",
          link: `/portal/${contactId}/marketing`,
          buttonText: "View Plan",
        },
        {
          icon: <DollarSign className="h-5 w-5" />,
          title: "Updated Pricing",
          description: "Current market analysis",
          link: `/portal/${contactId}/pricing`,
          buttonText: "Review",
        },
      ],
      contentCards: [
        {
          icon: <Target className="h-5 w-5" />,
          title: "What We'll Do Different",
          items: [
            { icon: <TrendingUp className="h-4 w-4" />, title: "Enhanced Marketing", description: "More exposure channels" },
            { icon: <DollarSign className="h-4 w-4" />, title: "Strategic Pricing", description: "Data-driven approach" },
          ],
        },
        {
          icon: <CheckCircle2 className="h-5 w-5" />,
          title: "Fresh Start",
          items: [
            { icon: <Star className="h-4 w-4" />, title: "New Photos", description: "Professional staging" },
            { icon: <Users className="h-4 w-4" />, title: "Agent Network", description: "Direct outreach" },
          ],
        },
      ],
      resources: [
        { title: "Expired Listing Analysis", description: "Common reasons homes don't sell", link: "#" },
        { title: "Our Marketing Difference", description: "How we do it better", link: "#" },
        { title: "Success Rate", description: "Our track record", link: "#" },
      ],
    },

    empty_nester: {
      welcomeMessage: "Time for a home that fits your new chapter",
      journeyDescription: "Downsizing to the perfect space",
      goalLabel: "Right-Sized Home",
      progressPercent: 30,
      milestones: [
        { label: "Needs Assessment", completed: true },
        { label: "Current Home Listed", completed: false },
        { label: "New Home Found", completed: false },
        { label: "Moved", completed: false },
      ],
      quickActions: [
        {
          icon: <Home className="h-5 w-5" />,
          title: "Smaller Homes",
          description: "Less maintenance, more freedom",
          link: `/portal/${contactId}/properties`,
          buttonText: "Browse",
        },
        {
          icon: <DollarSign className="h-5 w-5" />,
          title: "Equity Analysis",
          description: "What you'll have to work with",
          link: `/portal/${contactId}/equity`,
          buttonText: "Calculate",
        },
        {
          icon: <Package className="h-5 w-5" />,
          title: "Downsizing Plan",
          description: "Step-by-step guide",
          link: `/portal/${contactId}/downsizing`,
          buttonText: "Get Plan",
        },
      ],
      contentCards: [
        {
          icon: <Home className="h-5 w-5" />,
          title: "Right-Size Options",
          items: [
            { icon: <Building className="h-4 w-4" />, title: "Low-Maintenance Homes", description: "More time for you" },
            { icon: <MapPin className="h-4 w-4" />, title: "Great Locations", description: "Near family, amenities" },
          ],
        },
        {
          icon: <DollarSign className="h-5 w-5" />,
          title: "Financial Benefits",
          items: [
            { icon: <TrendingUp className="h-4 w-4" />, title: "Unlock Equity", description: "Cash for retirement" },
            { icon: <Calculator className="h-4 w-4" />, title: "Lower Costs", description: "Reduced expenses" },
          ],
        },
      ],
      resources: [
        { title: "Empty Nester Guide", description: "Planning your transition", link: "#" },
        { title: "Downsizing Checklist", description: "Room by room guide", link: "#" },
        { title: "New Chapter Planning", description: "Life after kids", link: "#" },
      ],
    },
  }

  // Default configuration for unknown personas
  const defaultConfig = {
    welcomeMessage: isBuyer ? "Let's find your perfect home" : "Let's get your home sold",
    journeyDescription: isBuyer ? "Your home buying journey" : "Your home selling journey",
    goalLabel: isBuyer ? "Closing Day" : "Sold",
    progressPercent: 30,
    milestones: [
      { label: "Started", completed: true },
      { label: "In Progress", completed: false },
      { label: "Almost There", completed: false },
      { label: "Complete", completed: false },
    ],
    quickActions: [
      {
        icon: <Home className="h-5 w-5" />,
        title: "Properties",
        description: isBuyer ? "View available homes" : "Your listing",
        link: `/portal/${contactId}/properties`,
        buttonText: "View",
      },
      {
        icon: <FileText className="h-5 w-5" />,
        title: "Documents",
        description: "Important paperwork",
        link: `/portal/${contactId}/documents`,
        buttonText: "View Docs",
      },
      {
        icon: <Calendar className="h-5 w-5" />,
        title: "Schedule",
        description: "Book appointments",
        link: `/portal/${contactId}/schedule`,
        buttonText: "Schedule",
      },
    ],
    contentCards: [],
    resources: [
      { title: "Buyer/Seller Guide", description: "Helpful resources", link: "#" },
      { title: "FAQ", description: "Common questions", link: "#" },
      { title: "Contact Agent", description: "Get in touch", link: "#" },
    ],
  }

  return configs[persona] || defaultConfig
}
