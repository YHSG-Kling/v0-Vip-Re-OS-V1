// ============================================================================
// COMPREHENSIVE PERSONA CONFIGURATION SYSTEM
// ============================================================================
// This file contains ALL persona-specific configurations for the client portal
// including journey stages, widgets, resources, messaging, and UI styling

import { Home, Shield, Sparkles, TrendingUp, Plane, Heart, Users, Building, ArrowUpRight, ArrowDownRight, Clock, FileText, Video, Calculator, DollarSign, MapPin, School, Briefcase, Key, Scale, Gavel, Camera, Package, Truck, Phone, Star, Award, Target, PiggyBank, CreditCard, Percent, BarChart3, LineChart, Type as type, LucideIcon } from "lucide-react"

// ============================================================================
// TYPES
// ============================================================================

export interface PersonaWidget {
  id: string
  title: string
  description: string
  icon: LucideIcon
  dataKey: string // Key in contact.metadata to display
  format?: "currency" | "percent" | "number" | "text" | "date" | "boolean"
  emptyMessage?: string
  action?: { label: string; href: string }
}

export interface JourneyStage {
  id: string
  name: string
  description: string
  tasks: { id: string; title: string; description?: string; required?: boolean }[]
  resources: { title: string; type: "pdf" | "video" | "tool" | "guide" | "checklist" | "calculator"; url?: string }[]
  tips?: string[]
  estimatedDays?: number
}

export interface PersonaResource {
  title: string
  description: string
  type: "pdf" | "video" | "tool" | "guide" | "checklist" | "calculator"
  url?: string
  icon: LucideIcon
  stage?: string // Which stage this is most relevant to
}

export interface PersonaTabConfig {
  overview: { label: string; icon: LucideIcon }
  journey: { label: string; icon: LucideIcon }
  activity: { label: string; icon: LucideIcon }
  messages: { label: string; icon: LucideIcon }
}

export interface PersonaConfig {
  id: string
  label: string
  icon: LucideIcon
  color: string
  bgColor: string
  borderColor: string
  title: string
  greeting: string
  supportMessage?: string
  sensitiveContext?: boolean // For divorce, probate, etc.
  isBuyer: boolean
  isSeller: boolean
  features: string[]
  widgets: PersonaWidget[]
  journeyStages: JourneyStage[]
  resources: PersonaResource[]
  aiContext: string // Context for AI assistant
  quickActions: { label: string; href: string; icon: LucideIcon }[]
  tabs?: PersonaTabConfig // Persona-specific tab labels and icons
}

// ============================================================================
// PERSONA CONFIGURATIONS
// ============================================================================

export const PERSONA_CONFIGS: Record<string, PersonaConfig> = {
  // -------------------------------------------------------------------------
  // BUYER PERSONAS
  // -------------------------------------------------------------------------
  first_time_buyer: {
    id: "first_time_buyer",
    label: "First-Time Buyer",
    icon: Home,
    color: "text-blue-600",
    bgColor: "bg-blue-50",
    borderColor: "border-blue-200",
    title: "First-Time Buyer Journey",
    greeting: "Welcome to homeownership!",
    supportMessage: "Buying your first home is exciting! We're here to guide you through every step.",
    isBuyer: true,
    isSeller: false,
    features: ["Journey Guide", "Mortgage Calculator", "Homebuying Checklist", "Down Payment Tracker"],
    widgets: [
      {
        id: "pre_approval",
        title: "Pre-Approval Amount",
        description: "Your maximum purchase price",
        icon: DollarSign,
        dataKey: "pre_approval_amount",
        format: "currency",
        emptyMessage: "Get pre-approved to see your buying power",
        action: { label: "Get Pre-Approved", href: "/portal/{contactId}/journey" },
      },
      {
        id: "down_payment",
        title: "Down Payment Saved",
        description: "Your savings progress",
        icon: PiggyBank,
        dataKey: "down_payment_saved",
        format: "currency",
        emptyMessage: "Track your down payment savings",
      },
      {
        id: "budget_range",
        title: "Target Budget",
        description: "Your home search range",
        icon: Target,
        dataKey: "budget_display",
        format: "text",
        emptyMessage: "Set your budget range",
      },
      {
        id: "preferred_areas",
        title: "Preferred Areas",
        description: "Neighborhoods you're interested in",
        icon: MapPin,
        dataKey: "preferred_areas",
        format: "text",
        emptyMessage: "Tell us your preferred neighborhoods",
      },
    ],
    journeyStages: [
      {
        id: "education",
        name: "Homebuying Education",
        description: "Learn the basics of buying your first home",
        estimatedDays: 7,
        tasks: [
          { id: "course", title: "Complete first-time homebuyer course", required: true },
          { id: "process", title: "Understand the buying process timeline" },
          { id: "dpa", title: "Research down payment assistance programs" },
          { id: "costs", title: "Learn about closing costs and what to expect" },
        ],
        resources: [
          { title: "First-Time Buyer Complete Guide", type: "pdf" },
          { title: "Homebuying 101 Video Series", type: "video" },
          { title: "Down Payment Assistance Finder", type: "tool" },
        ],
        tips: [
          "Many states offer down payment assistance for first-time buyers",
          "Your credit score significantly impacts your interest rate",
        ],
      },
      {
        id: "financial_prep",
        name: "Financial Preparation",
        description: "Get your finances in order for the purchase",
        estimatedDays: 14,
        tasks: [
          { id: "credit", title: "Check and improve your credit score", required: true },
          { id: "budget", title: "Calculate comfortable monthly payment" },
          { id: "savings", title: "Save for down payment and closing costs" },
          { id: "docs", title: "Gather financial documents (pay stubs, tax returns, bank statements)" },
        ],
        resources: [
          { title: "Credit Score Improvement Guide", type: "guide" },
          { title: "Affordability Calculator", type: "calculator" },
          { title: "Document Checklist", type: "checklist" },
        ],
      },
      {
        id: "pre_approval",
        name: "Mortgage Pre-Approval",
        description: "Get officially approved to buy",
        estimatedDays: 7,
        tasks: [
          { id: "research", title: "Research loan types (FHA, Conventional, VA)", required: true },
          { id: "compare", title: "Compare lender rates and fees" },
          { id: "apply", title: "Submit mortgage application" },
          { id: "letter", title: "Receive pre-approval letter", required: true },
        ],
        resources: [
          { title: "FHA vs. Conventional Comparison", type: "guide" },
          { title: "Lender Comparison Tool", type: "tool" },
        ],
      },
      {
        id: "home_search",
        name: "Home Search",
        description: "Find your perfect first home",
        estimatedDays: 30,
        tasks: [
          { id: "criteria", title: "Define must-haves vs. nice-to-haves" },
          { id: "tour", title: "Tour properties with your agent" },
          { id: "research", title: "Research neighborhoods and schools" },
          { id: "open_houses", title: "Attend open houses" },
        ],
        resources: [
          { title: "Home Search Checklist", type: "checklist" },
          { title: "Neighborhood Research Guide", type: "guide" },
          { title: "First Home Must-Haves Worksheet", type: "pdf" },
        ],
      },
      {
        id: "offer",
        name: "Making an Offer",
        description: "Submit your offer on the perfect home",
        estimatedDays: 3,
        tasks: [
          { id: "comps", title: "Review comparable sales with your agent" },
          { id: "price", title: "Determine offer price strategy" },
          { id: "contingencies", title: "Include appropriate contingencies" },
          { id: "submit", title: "Submit your offer", required: true },
        ],
        resources: [
          { title: "How to Make a Competitive Offer", type: "video" },
          { title: "Contingencies Explained", type: "guide" },
        ],
        tips: [
          "Earnest money shows the seller you're serious - typically 1-3% of purchase price",
          "Common contingencies: inspection, financing, appraisal",
        ],
      },
      {
        id: "under_contract",
        name: "Under Contract",
        description: "Complete due diligence and inspections",
        estimatedDays: 21,
        tasks: [
          { id: "inspection", title: "Schedule and attend home inspection", required: true },
          { id: "review", title: "Review inspection report and negotiate repairs" },
          { id: "appraisal", title: "Complete appraisal", required: true },
          { id: "final_approval", title: "Finalize mortgage approval", required: true },
        ],
        resources: [
          { title: "What to Expect at Your Inspection", type: "video" },
          { title: "Inspection Red Flags Guide", type: "pdf" },
          { title: "Repair Negotiation Tips", type: "guide" },
        ],
      },
      {
        id: "closing",
        name: "Closing Day",
        description: "Finalize your purchase and get your keys!",
        estimatedDays: 3,
        tasks: [
          { id: "disclosure", title: "Review closing disclosure (3 days before)", required: true },
          { id: "walkthrough", title: "Complete final walkthrough" },
          { id: "funds", title: "Wire closing funds" },
          { id: "sign", title: "Sign closing documents", required: true },
          { id: "keys", title: "Receive your keys!", required: true },
        ],
        resources: [
          { title: "Closing Day Checklist", type: "checklist" },
          { title: "Understanding Your Closing Disclosure", type: "guide" },
          { title: "New Homeowner Checklist", type: "pdf" },
        ],
        tips: [
          "Bring a valid photo ID to closing",
          "Don't make any large purchases before closing - it can affect your loan",
        ],
      },
    ],
    resources: [
      {
        title: "First-Time Buyer Complete Guide",
        description: "Everything you need to know",
        type: "pdf",
        icon: FileText,
      },
      {
        title: "Affordability Calculator",
        description: "See what you can afford",
        type: "calculator",
        icon: Calculator,
      },
      { title: "Homebuying 101 Video Series", description: "Watch and learn", type: "video", icon: Video },
    ],
    aiContext:
      "First-time homebuyer who may not be familiar with real estate terminology. Explain concepts clearly and avoid jargon. Focus on education and reassurance.",
    quickActions: [
      { label: "View Properties", href: "/portal/{contactId}/properties", icon: Home },
      { label: "My Journey", href: "/portal/{contactId}/journey", icon: Target },
      { label: "Schedule Showing", href: "/portal/{contactId}/showings", icon: Clock },
      { label: "Calculator", href: "/portal/{contactId}/properties", icon: Calculator },
    ],
  },

  military_buyer: {
    id: "military_buyer",
    label: "Military Buyer",
    icon: Shield,
    color: "text-green-600",
    bgColor: "bg-green-50",
    borderColor: "border-green-200",
    title: "Military Buyer Portal",
    greeting: "Thank you for your service!",
    supportMessage:
      "We're honored to help you find your next home. Your VA benefits make homeownership more accessible.",
    isBuyer: true,
    isSeller: false,
    features: ["VA Loan Calculator", "BAH Comparison", "Base Proximity Search", "PCS Timeline"],
    widgets: [
      {
        id: "va_entitlement",
        title: "VA Entitlement",
        description: "Your VA loan status",
        icon: Shield,
        dataKey: "va_entitlement",
        format: "text",
        emptyMessage: "Check your VA entitlement status",
      },
      {
        id: "bah_amount",
        title: "Monthly BAH",
        description: "Basic Allowance for Housing",
        icon: DollarSign,
        dataKey: "bah_amount",
        format: "currency",
        emptyMessage: "Enter your BAH amount",
      },
      {
        id: "military_branch",
        title: "Branch & Rank",
        description: "Your military service",
        icon: Award,
        dataKey: "military_branch_rank",
        format: "text",
      },
      {
        id: "pcs_date",
        title: "PCS Date",
        description: "Permanent Change of Station",
        icon: Plane,
        dataKey: "pcs_date",
        format: "date",
        emptyMessage: "Add your PCS date",
      },
    ],
    journeyStages: [
      {
        id: "va_education",
        name: "VA Loan Education",
        description: "Understand your VA loan benefits",
        estimatedDays: 5,
        tasks: [
          { id: "benefits", title: "Review VA loan benefits (0% down, no PMI)", required: true },
          { id: "coe", title: "Obtain Certificate of Eligibility (COE)", required: true },
          { id: "funding_fee", title: "Understand VA funding fee and exemptions" },
          { id: "limits", title: "Review VA loan limits for your area" },
        ],
        resources: [
          { title: "VA Loan Complete Guide", type: "pdf" },
          { title: "COE Request Tutorial", type: "video" },
          { title: "VA Funding Fee Calculator", type: "calculator" },
        ],
        tips: [
          "Disabled veterans may be exempt from the VA funding fee",
          "VA loans have no private mortgage insurance (PMI)",
        ],
      },
      {
        id: "pcs_planning",
        name: "PCS Planning",
        description: "Coordinate your move with your home purchase",
        estimatedDays: 14,
        tasks: [
          { id: "orders", title: "Confirm PCS orders and report date", required: true },
          { id: "research", title: "Research duty station area and housing" },
          { id: "bah", title: "Calculate BAH for new location" },
          { id: "installation", title: "Connect with receiving installation housing office" },
        ],
        resources: [
          { title: "PCS Move Checklist", type: "checklist" },
          { title: "BAH Calculator", type: "calculator" },
          { title: "Base Housing Guide", type: "guide" },
        ],
      },
      {
        id: "va_pre_approval",
        name: "VA Pre-Approval",
        description: "Get pre-approved with a VA-experienced lender",
        estimatedDays: 7,
        tasks: [
          { id: "lender", title: "Select VA-approved lender", required: true },
          { id: "docs", title: "Submit LES, orders, and military documents" },
          { id: "approval", title: "Receive VA pre-approval letter", required: true },
          { id: "entitlement", title: "Verify entitlement usage" },
        ],
        resources: [
          { title: "VA Lender Comparison", type: "tool" },
          { title: "Military Documents Checklist", type: "checklist" },
        ],
      },
      {
        id: "home_search",
        name: "Home Search",
        description: "Find a home near your duty station",
        estimatedDays: 21,
        tasks: [
          { id: "proximity", title: "Search within commute distance of base" },
          { id: "dodea", title: "Evaluate school districts (DODEA if applicable)" },
          { id: "virtual", title: "Tour properties virtually if still at current station" },
          { id: "compare", title: "Compare on-base vs. off-base options" },
        ],
        resources: [
          { title: "Military-Friendly Neighborhoods Guide", type: "guide" },
          { title: "Virtual Tour Tips", type: "video" },
        ],
      },
      {
        id: "offer",
        name: "Making an Offer",
        description: "Submit a VA-compliant offer",
        estimatedDays: 3,
        tasks: [
          { id: "addendum", title: "Include VA addendum in offer" },
          { id: "escape", title: "Include VA escape clause" },
          { id: "concessions", title: "Negotiate seller concessions (up to 4%)" },
          { id: "submit", title: "Submit offer", required: true },
        ],
        resources: [
          { title: "VA Offer Strategy Guide", type: "pdf" },
          { title: "VA Escape Clause Explained", type: "guide" },
        ],
      },
      {
        id: "va_appraisal",
        name: "VA Appraisal & Inspection",
        description: "Complete VA-required appraisal and inspection",
        estimatedDays: 14,
        tasks: [
          { id: "appraisal", title: "Schedule VA appraisal", required: true },
          { id: "inspection", title: "Complete home inspection" },
          { id: "mpr", title: "Ensure property meets Minimum Property Requirements (MPR)" },
          { id: "repairs", title: "Address any required repairs" },
        ],
        resources: [
          { title: "VA Appraisal Process", type: "video" },
          { title: "MPR Requirements Guide", type: "pdf" },
        ],
      },
      {
        id: "closing",
        name: "Closing",
        description: "Close on your new home",
        estimatedDays: 7,
        tasks: [
          { id: "disclosure", title: "Review closing disclosure" },
          { id: "finance", title: "Coordinate with finance office if needed" },
          { id: "sign", title: "Sign closing documents", required: true },
          { id: "keys", title: "Welcome to your new home!", required: true },
        ],
        resources: [
          { title: "VA Closing Checklist", type: "checklist" },
          { title: "Post-Closing Guide", type: "guide" },
        ],
      },
    ],
    resources: [
      { title: "VA Loan Benefits Guide", description: "Complete overview", type: "pdf", icon: FileText },
      { title: "BAH Calculator", description: "Plan your budget", type: "calculator", icon: Calculator },
      { title: "PCS Timeline Planner", description: "Coordinate your move", type: "tool", icon: Clock },
    ],
    aiContext:
      "Military service member using VA loan benefits. Familiar with military terms like BAH, PCS, LES. Provide specific VA loan guidance and understand time constraints of military moves.",
    quickActions: [
      { label: "VA Calculator", href: "/portal/{contactId}/properties", icon: Calculator },
      { label: "Search Near Base", href: "/portal/{contactId}/properties", icon: MapPin },
      { label: "PCS Timeline", href: "/portal/{contactId}/journey", icon: Clock },
      { label: "VA Resources", href: "/portal/{contactId}/journey", icon: Shield },
    ],
  },

  luxury_buyer: {
    id: "luxury_buyer",
    label: "Luxury Buyer",
    icon: Sparkles,
    color: "text-purple-600",
    bgColor: "bg-purple-50",
    borderColor: "border-purple-200",
    title: "Luxury Property Concierge",
    greeting: "Discover extraordinary properties",
    isBuyer: true,
    isSeller: false,
    features: ["Private Listings", "Concierge Services", "Investment Analysis", "Privacy Protection"],
    widgets: [
      {
        id: "budget_range",
        title: "Investment Range",
        description: "Your property budget",
        icon: DollarSign,
        dataKey: "budget_display",
        format: "text",
      },
      {
        id: "payment_method",
        title: "Payment Method",
        description: "How you plan to purchase",
        icon: CreditCard,
        dataKey: "payment_method",
        format: "text",
      },
      {
        id: "privacy",
        title: "Privacy Level",
        description: "Your confidentiality preferences",
        icon: Shield,
        dataKey: "privacy_requirements",
        format: "text",
      },
      {
        id: "concierge",
        title: "Concierge Status",
        description: "White-glove services",
        icon: Star,
        dataKey: "concierge_services",
        format: "boolean",
      },
    ],
    journeyStages: [
      {
        id: "consultation",
        name: "Private Consultation",
        description: "Understand your lifestyle and property requirements",
        estimatedDays: 3,
        tasks: [
          { id: "meeting", title: "Schedule private consultation", required: true },
          { id: "requirements", title: "Define property requirements and lifestyle needs" },
          { id: "privacy", title: "Establish privacy and confidentiality protocols" },
          { id: "team", title: "Introduce your dedicated concierge team" },
        ],
        resources: [
          { title: "Luxury Property Guide", type: "pdf" },
          { title: "Concierge Services Overview", type: "guide" },
        ],
      },
      {
        id: "financial_planning",
        name: "Financial Planning",
        description: "Structure the optimal purchase",
        estimatedDays: 7,
        tasks: [
          { id: "structure", title: "Determine purchase structure (cash, financing, trust)" },
          { id: "wealth", title: "Coordinate with wealth advisor" },
          { id: "entity", title: "Establish purchasing entity if desired" },
          { id: "proof", title: "Prepare proof of funds" },
        ],
        resources: [
          { title: "Purchase Structure Options", type: "guide" },
          { title: "Trust & Entity Overview", type: "pdf" },
        ],
      },
      {
        id: "curated_search",
        name: "Curated Property Search",
        description: "Access exclusive and off-market properties",
        estimatedDays: 30,
        tasks: [
          { id: "off_market", title: "Review off-market opportunities" },
          { id: "private", title: "Attend private showings" },
          { id: "comparison", title: "Compare properties against criteria" },
          { id: "due_diligence", title: "Conduct preliminary due diligence" },
        ],
        resources: [
          { title: "Property Comparison Tool", type: "tool" },
          { title: "Due Diligence Checklist", type: "checklist" },
        ],
      },
      {
        id: "negotiation",
        name: "Discreet Negotiation",
        description: "Negotiate with discretion and strategy",
        estimatedDays: 7,
        tasks: [
          { id: "strategy", title: "Develop negotiation strategy" },
          { id: "offer", title: "Present offer through appropriate channels" },
          { id: "terms", title: "Negotiate terms and timeline" },
          { id: "agreement", title: "Execute purchase agreement" },
        ],
        resources: [{ title: "Luxury Negotiation Strategies", type: "guide" }],
      },
      {
        id: "due_diligence",
        name: "Comprehensive Due Diligence",
        description: "Thorough property and title examination",
        estimatedDays: 21,
        tasks: [
          { id: "inspection", title: "Premium property inspection" },
          { id: "specialists", title: "Engage specialized consultants as needed" },
          { id: "title", title: "Complete title and lien search" },
          { id: "insurance", title: "Arrange appropriate insurance coverage" },
        ],
        resources: [{ title: "Luxury Inspection Guide", type: "pdf" }],
      },
      {
        id: "closing",
        name: "Private Closing",
        description: "Complete your purchase with full confidentiality",
        estimatedDays: 7,
        tasks: [
          { id: "review", title: "Review all closing documents" },
          { id: "walkthrough", title: "Final property walkthrough" },
          { id: "close", title: "Execute closing", required: true },
          { id: "transition", title: "Coordinate property transition" },
        ],
        resources: [{ title: "Closing Preparation Guide", type: "checklist" }],
      },
    ],
    resources: [
      { title: "Luxury Market Report", description: "Market insights", type: "pdf", icon: BarChart3 },
      { title: "Privacy Protection Guide", description: "Confidentiality options", type: "guide", icon: Shield },
    ],
    aiContext:
      "Luxury property buyer expecting white-glove service. Values privacy, discretion, and expertise. Communicate with sophistication and attention to detail.",
    quickActions: [
      { label: "Private Listings", href: "/portal/{contactId}/properties", icon: Sparkles },
      { label: "Concierge Request", href: "/portal/{contactId}/documents", icon: Star },
      { label: "Schedule Private Tour", href: "/portal/{contactId}/showings", icon: Key },
    ],
  },

  investor: {
    id: "investor",
    label: "Investor",
    icon: TrendingUp,
    color: "text-indigo-600",
    bgColor: "bg-indigo-50",
    borderColor: "border-indigo-200",
    title: "Investment Dashboard",
    greeting: "Grow your portfolio",
    isBuyer: true,
    isSeller: false,
    features: ["ROI Calculator", "Deal Analysis", "Portfolio Tracker", "Market Intelligence"],
    widgets: [
      {
        id: "portfolio_size",
        title: "Portfolio Size",
        description: "Properties owned",
        icon: Building,
        dataKey: "portfolio_size",
        format: "number",
      },
      {
        id: "target_cap",
        title: "Target Cap Rate",
        description: "Your investment criteria",
        icon: Percent,
        dataKey: "target_cap_rate",
        format: "percent",
      },
      {
        id: "strategy",
        title: "Strategy",
        description: "Investment approach",
        icon: Target,
        dataKey: "investment_strategy",
        format: "text",
      },
      {
        id: "budget",
        title: "Deal Size Range",
        description: "Investment budget",
        icon: DollarSign,
        dataKey: "budget_display",
        format: "text",
      },
    ],
    journeyStages: [
      {
        id: "strategy",
        name: "Investment Strategy",
        description: "Define your investment criteria",
        estimatedDays: 3,
        tasks: [
          { id: "goals", title: "Define investment goals (cash flow, appreciation, both)" },
          { id: "criteria", title: "Set property criteria (type, size, location)" },
          { id: "returns", title: "Establish target returns (cap rate, CoC)" },
          { id: "financing", title: "Determine financing strategy" },
        ],
        resources: [
          { title: "Investment Strategy Guide", type: "pdf" },
          { title: "Cap Rate Calculator", type: "calculator" },
          { title: "Cash-on-Cash Calculator", type: "calculator" },
        ],
      },
      {
        id: "deal_sourcing",
        name: "Deal Sourcing",
        description: "Find properties that meet your criteria",
        estimatedDays: 30,
        tasks: [
          { id: "pipeline", title: "Build deal pipeline" },
          { id: "analyze", title: "Analyze potential properties" },
          { id: "compare", title: "Compare investment opportunities" },
          { id: "shortlist", title: "Create shortlist of targets" },
        ],
        resources: [
          { title: "Deal Analysis Spreadsheet", type: "tool" },
          { title: "Market Analysis Report", type: "pdf" },
        ],
      },
      {
        id: "due_diligence",
        name: "Due Diligence",
        description: "Verify the numbers and property condition",
        estimatedDays: 14,
        tasks: [
          { id: "financials", title: "Verify income and expenses" },
          { id: "inspection", title: "Complete property inspection" },
          { id: "rent_analysis", title: "Analyze rent comparables" },
          { id: "capex", title: "Estimate capital expenditures" },
        ],
        resources: [
          { title: "Due Diligence Checklist", type: "checklist" },
          { title: "CapEx Calculator", type: "calculator" },
        ],
      },
      {
        id: "acquisition",
        name: "Acquisition",
        description: "Close on your investment property",
        estimatedDays: 21,
        tasks: [
          { id: "negotiate", title: "Negotiate purchase terms" },
          { id: "financing", title: "Finalize investment financing" },
          { id: "close", title: "Close on property", required: true },
          { id: "transition", title: "Transition property management" },
        ],
        resources: [{ title: "Investment Closing Checklist", type: "checklist" }],
      },
    ],
    resources: [
      { title: "ROI Calculator", description: "Analyze returns", type: "calculator", icon: Calculator },
      { title: "Market Intelligence Report", description: "Local market data", type: "pdf", icon: BarChart3 },
      { title: "Portfolio Tracker", description: "Manage investments", type: "tool", icon: LineChart },
    ],
    aiContext:
      "Real estate investor focused on returns and numbers. Communicate with data-driven insights. Familiar with investment terminology like cap rates, CoC, NOI.",
    quickActions: [
      { label: "Analyze Deal", href: "/portal/{contactId}/properties", icon: Calculator },
      { label: "View Pipeline", href: "/portal/{contactId}/properties", icon: TrendingUp },
      { label: "Market Data", href: "/portal/{contactId}/insights", icon: BarChart3 },
    ],
  },

  // -------------------------------------------------------------------------
  // SELLER PERSONAS
  // -------------------------------------------------------------------------
  first_time_seller: {
    id: "first_time_seller",
    label: "First-Time Seller",
    icon: Home,
    color: "text-emerald-600",
    bgColor: "bg-emerald-50",
    borderColor: "border-emerald-200",
    title: "First-Time Seller Guide",
    greeting: "Selling made simple",
    supportMessage: "Selling your first home can feel overwhelming. We'll guide you through every step.",
    isBuyer: false,
    isSeller: true,
    features: ["Selling Timeline", "Home Prep Guide", "Pricing Strategy", "Offer Comparison"],
    widgets: [
      {
        id: "estimated_value",
        title: "Estimated Value",
        description: "Your home's market value",
        icon: DollarSign,
        dataKey: "estimated_value",
        format: "currency",
      },
      {
        id: "years_owned",
        title: "Years Owned",
        description: "Time in your home",
        icon: Clock,
        dataKey: "years_owned",
        format: "number",
      },
      {
        id: "property_address",
        title: "Property",
        description: "Address being sold",
        icon: MapPin,
        dataKey: "property_address",
        format: "text",
      },
    ],
    journeyStages: [
      {
        id: "preparation",
        name: "Preparation",
        description: "Get your home ready to sell",
        estimatedDays: 14,
        tasks: [
          { id: "consultation", title: "Initial consultation with your agent", required: true },
          { id: "valuation", title: "Receive comparative market analysis (CMA)" },
          { id: "repairs", title: "Complete recommended repairs and updates" },
          { id: "declutter", title: "Declutter and depersonalize" },
          { id: "staging", title: "Consider professional staging" },
        ],
        resources: [
          { title: "Home Prep Checklist", type: "checklist" },
          { title: "Decluttering Guide", type: "pdf" },
          { title: "Staging Tips Video", type: "video" },
        ],
      },
      {
        id: "listing",
        name: "Going Live",
        description: "List your home on the market",
        estimatedDays: 3,
        tasks: [
          { id: "photos", title: "Professional photography session", required: true },
          { id: "pricing", title: "Finalize listing price strategy" },
          { id: "listing", title: "Launch listing on MLS", required: true },
          { id: "marketing", title: "Begin marketing campaign" },
        ],
        resources: [
          { title: "Pricing Strategy Guide", type: "guide" },
          { title: "Photo Day Preparation", type: "checklist" },
        ],
      },
      {
        id: "showings",
        name: "Showings",
        description: "Show your home to potential buyers",
        estimatedDays: 21,
        tasks: [
          { id: "schedule", title: "Manage showing schedule" },
          { id: "feedback", title: "Review showing feedback" },
          { id: "open_house", title: "Host open houses" },
          { id: "adjust", title: "Adjust strategy based on feedback" },
        ],
        resources: [
          { title: "Showing Preparation Tips", type: "pdf" },
          { title: "Understanding Feedback", type: "guide" },
        ],
      },
      {
        id: "offers",
        name: "Reviewing Offers",
        description: "Evaluate and respond to offers",
        estimatedDays: 7,
        tasks: [
          { id: "review", title: "Review offer terms with your agent" },
          { id: "compare", title: "Compare multiple offers" },
          { id: "counter", title: "Counter or accept offer", required: true },
          { id: "contract", title: "Execute purchase contract" },
        ],
        resources: [
          { title: "Offer Comparison Guide", type: "guide" },
          { title: "Understanding Contract Terms", type: "pdf" },
        ],
      },
      {
        id: "under_contract",
        name: "Under Contract",
        description: "Navigate the closing process",
        estimatedDays: 30,
        tasks: [
          { id: "inspection", title: "Buyer's inspection period" },
          { id: "repairs", title: "Negotiate and complete any repairs" },
          { id: "appraisal", title: "Buyer's appraisal" },
          { id: "title", title: "Title and lender clearance" },
        ],
        resources: [
          { title: "Under Contract Timeline", type: "guide" },
          { title: "Repair Negotiation Tips", type: "pdf" },
        ],
      },
      {
        id: "closing",
        name: "Closing",
        description: "Complete the sale",
        estimatedDays: 3,
        tasks: [
          { id: "walkthrough", title: "Allow buyer final walkthrough" },
          { id: "moving", title: "Complete your move-out" },
          { id: "close", title: "Sign closing documents", required: true },
          { id: "keys", title: "Hand over keys" },
        ],
        resources: [
          { title: "Closing Day Checklist", type: "checklist" },
          { title: "Moving Timeline", type: "pdf" },
        ],
      },
    ],
    resources: [
      { title: "Seller's Complete Guide", description: "Step-by-step overview", type: "pdf", icon: FileText },
      { title: "Home Prep Video", description: "Get your home ready", type: "video", icon: Video },
    ],
    aiContext:
      "First-time home seller unfamiliar with the selling process. Explain concepts clearly and provide reassurance. Focus on what to expect at each step.",
    quickActions: [
      { label: "My Listing", href: "/portal/{contactId}/listing", icon: Home },
      { label: "View Offers", href: "/portal/{contactId}/offers", icon: FileText },
      { label: "Showing Schedule", href: "/portal/{contactId}/showings", icon: Clock },
    ],
  },

  motivated_seller: {
    id: "motivated_seller",
    label: "Motivated Seller",
    icon: Clock,
    color: "text-orange-600",
    bgColor: "bg-orange-50",
    borderColor: "border-orange-200",
    title: "Fast-Track Sale Portal",
    greeting: "Moving quickly for you",
    supportMessage: "We understand time is critical. Our team is dedicated to selling your home fast.",
    isBuyer: false,
    isSeller: true,
    features: ["Quick Sale Options", "Daily Updates", "Instant Offers", "Expedited Timeline"],
    widgets: [
      {
        id: "urgency",
        title: "Timeline",
        description: "Your sale urgency",
        icon: Clock,
        dataKey: "urgency_level",
        format: "text",
      },
      {
        id: "flexibility",
        title: "Price Flexibility",
        description: "Negotiation room",
        icon: Percent,
        dataKey: "price_flexibility",
        format: "text",
      },
      {
        id: "property",
        title: "Property",
        description: "Address",
        icon: MapPin,
        dataKey: "property_address",
        format: "text",
      },
    ],
    journeyStages: [
      {
        id: "rapid_assessment",
        name: "Rapid Assessment",
        description: "Quick evaluation of your property",
        estimatedDays: 1,
        tasks: [
          { id: "consultation", title: "Urgent consultation", required: true },
          { id: "valuation", title: "Rapid property valuation" },
          { id: "options", title: "Review quick-sale options" },
          { id: "strategy", title: "Choose optimal strategy" },
        ],
        resources: [{ title: "Quick Sale Options Explained", type: "pdf" }],
      },
      {
        id: "fast_prep",
        name: "Fast Preparation",
        description: "Minimal prep, maximum impact",
        estimatedDays: 3,
        tasks: [
          { id: "essentials", title: "Complete essential repairs only" },
          { id: "photos", title: "Same-day photography" },
          { id: "pricing", title: "Aggressive pricing strategy" },
        ],
        resources: [{ title: "Quick Prep Checklist", type: "checklist" }],
      },
      {
        id: "aggressive_marketing",
        name: "Aggressive Marketing",
        description: "Maximum exposure, fast results",
        estimatedDays: 7,
        tasks: [
          { id: "list", title: "List immediately", required: true },
          { id: "blitz", title: "Marketing blitz" },
          { id: "broker_tour", title: "Rush broker tour" },
          { id: "open_house", title: "Immediate open house" },
        ],
        resources: [{ title: "Quick Sale Marketing Guide", type: "guide" }],
      },
      {
        id: "offer_review",
        name: "Offer Review",
        description: "Review and accept offers quickly",
        estimatedDays: 3,
        tasks: [
          { id: "review", title: "Daily offer review", required: true },
          { id: "respond", title: "24-hour response guarantee" },
          { id: "accept", title: "Accept best offer", required: true },
        ],
        resources: [],
      },
      {
        id: "fast_close",
        name: "Expedited Closing",
        description: "Close as quickly as possible",
        estimatedDays: 14,
        tasks: [
          { id: "title", title: "Rush title work" },
          { id: "inspection", title: "Shortened inspection period" },
          { id: "close", title: "Expedited closing", required: true },
        ],
        resources: [{ title: "Fast Closing Timeline", type: "pdf" }],
      },
    ],
    resources: [{ title: "Quick Sale Options", description: "All your options", type: "pdf", icon: Clock }],
    aiContext:
      "Motivated seller who needs to sell quickly. Prioritize speed in all recommendations. Be direct and efficient in communication.",
    quickActions: [
      { label: "View Offers", href: "/portal/{contactId}/offers", icon: FileText },
      { label: "Listing Status", href: "/portal/{contactId}/listing", icon: TrendingUp },
      { label: "Price Update", href: "/portal/{contactId}/listing", icon: DollarSign },
    ],
  },

  // -------------------------------------------------------------------------
  // LIFE SITUATION PERSONAS
  // -------------------------------------------------------------------------
  divorce: {
    id: "divorce",
    label: "Divorce",
    icon: Users,
    color: "text-slate-600",
    bgColor: "bg-slate-50",
    borderColor: "border-slate-200",
    title: "Confidential Sale Support",
    greeting: "Private, professional support",
    supportMessage:
      "Your privacy is our priority. We'll help navigate this transition with discretion and fairness to all parties.",
    sensitiveContext: true,
    isBuyer: false,
    isSeller: true,
    features: ["Neutral Communication", "Equity Calculator", "Confidential Process", "Mediator Network"],
    widgets: [
      {
        id: "situation",
        title: "Situation",
        description: "Divorce status",
        icon: Scale,
        dataKey: "situation",
        format: "text",
      },
      {
        id: "agreement",
        title: "Sale Agreement",
        description: "Both parties agree",
        icon: Users,
        dataKey: "both_parties_agree_to_sell",
        format: "boolean",
      },
      {
        id: "property",
        title: "Property",
        description: "Marital home address",
        icon: Home,
        dataKey: "property_address",
        format: "text",
      },
    ],
    journeyStages: [
      {
        id: "initial_consult",
        name: "Confidential Consultation",
        description: "Understand your situation privately",
        estimatedDays: 3,
        tasks: [
          { id: "meet", title: "Private consultation", required: true },
          { id: "parties", title: "Confirm all parties' agreement to sell" },
          { id: "communication", title: "Establish communication protocols" },
          { id: "legal", title: "Confirm any legal requirements" },
        ],
        resources: [
          { title: "Divorce Sale Guide", type: "pdf" },
          { title: "Equity Split Calculator", type: "calculator" },
        ],
        tips: ["We can communicate separately with each party if needed", "All communications are kept confidential"],
      },
      {
        id: "preparation",
        name: "Property Preparation",
        description: "Prepare the home for sale neutrally",
        estimatedDays: 14,
        tasks: [
          { id: "valuation", title: "Independent market valuation" },
          { id: "repairs", title: "Agree on necessary repairs" },
          { id: "staging", title: "Neutral staging approach" },
          { id: "photos", title: "Professional photography" },
        ],
        resources: [{ title: "Neutral Preparation Guide", type: "pdf" }],
      },
      {
        id: "listing",
        name: "Listing",
        description: "List the property",
        estimatedDays: 3,
        tasks: [
          { id: "pricing", title: "Agree on list price" },
          { id: "list", title: "List on MLS", required: true },
          { id: "showing", title: "Establish showing protocols" },
        ],
        resources: [],
      },
      {
        id: "showings_offers",
        name: "Showings & Offers",
        description: "Manage showings and review offers",
        estimatedDays: 21,
        tasks: [
          { id: "showings", title: "Coordinate showings" },
          { id: "feedback", title: "Share feedback with both parties" },
          { id: "offers", title: "Present all offers neutrally" },
          { id: "acceptance", title: "Both parties accept offer", required: true },
        ],
        resources: [{ title: "Offer Review Protocol", type: "guide" }],
      },
      {
        id: "closing",
        name: "Closing & Division",
        description: "Close and divide proceeds",
        estimatedDays: 30,
        tasks: [
          { id: "escrow", title: "Manage escrow process" },
          { id: "title", title: "Clear title issues" },
          { id: "close", title: "Complete closing", required: true },
          { id: "distribute", title: "Distribute proceeds per agreement" },
        ],
        resources: [{ title: "Closing & Proceeds Guide", type: "pdf" }],
      },
    ],
    resources: [
      { title: "Divorce Sale Guide", description: "Process overview", type: "pdf", icon: FileText },
      { title: "Equity Calculator", description: "Calculate split", type: "calculator", icon: Calculator },
    ],
    aiContext:
      "Client going through divorce. Be sensitive, neutral, and maintain confidentiality. Do not take sides. Focus on practical process information.",
    quickActions: [
      { label: "My Listing", href: "/portal/{contactId}/listing", icon: Home },
      { label: "Documents", href: "/portal/{contactId}/documents", icon: FileText },
      { label: "Message Agent", href: "/portal/{contactId}/documents", icon: Phone },
    ],
  },

  probate: {
    id: "probate",
    label: "Probate",
    icon: Heart,
    color: "text-amber-600",
    bgColor: "bg-amber-50",
    borderColor: "border-amber-200",
    title: "Estate Sale Guidance",
    greeting: "We're here to support you",
    supportMessage:
      "We understand this is a difficult time. Our team will handle the details with care and respect for your family's wishes.",
    sensitiveContext: true,
    isBuyer: false,
    isSeller: true,
    features: ["Probate Timeline", "Estate Resources", "Court Requirements", "Compassionate Support"],
    widgets: [
      {
        id: "relationship",
        title: "Relationship",
        description: "To the deceased",
        icon: Heart,
        dataKey: "relationship_to_deceased",
        format: "text",
      },
      {
        id: "probate_status",
        title: "Probate Status",
        description: "Court process",
        icon: Gavel,
        dataKey: "probate_status",
        format: "text",
      },
      {
        id: "property",
        title: "Estate Property",
        description: "Property address",
        icon: Home,
        dataKey: "property_address",
        format: "text",
      },
    ],
    journeyStages: [
      {
        id: "initial",
        name: "Initial Consultation",
        description: "Understand the estate situation",
        estimatedDays: 7,
        tasks: [
          { id: "meeting", title: "Compassionate consultation", required: true },
          { id: "probate", title: "Review probate status and requirements" },
          { id: "authority", title: "Confirm authority to sell" },
          { id: "timeline", title: "Establish realistic timeline" },
        ],
        resources: [
          { title: "Probate Sale Overview", type: "pdf" },
          { title: "Required Documents Checklist", type: "checklist" },
        ],
      },
      {
        id: "property_assessment",
        name: "Property Assessment",
        description: "Evaluate the estate property",
        estimatedDays: 14,
        tasks: [
          { id: "condition", title: "Assess property condition" },
          { id: "valuation", title: "Independent appraisal if required" },
          { id: "belongings", title: "Coordinate personal property removal" },
          { id: "cleaning", title: "Professional cleaning and prep" },
        ],
        resources: [
          { title: "Estate Cleanout Guide", type: "pdf" },
          { title: "Estate Sale Company Referrals", type: "guide" },
        ],
      },
      {
        id: "listing",
        name: "Listing the Estate",
        description: "List the property appropriately",
        estimatedDays: 7,
        tasks: [
          { id: "pricing", title: "Determine appropriate price" },
          { id: "disclosure", title: "Prepare required disclosures" },
          { id: "list", title: "List property", required: true },
        ],
        resources: [{ title: "Probate Disclosure Requirements", type: "guide" }],
      },
      {
        id: "offers_court",
        name: "Offers & Court Approval",
        description: "Review offers and obtain court approval if needed",
        estimatedDays: 30,
        tasks: [
          { id: "offers", title: "Review offers with heirs" },
          { id: "court", title: "Submit to court if required" },
          { id: "overbid", title: "Handle overbid process if applicable" },
          { id: "approval", title: "Obtain court confirmation", required: true },
        ],
        resources: [{ title: "Court Confirmation Guide", type: "pdf" }],
      },
      {
        id: "closing",
        name: "Closing",
        description: "Complete the estate sale",
        estimatedDays: 30,
        tasks: [
          { id: "title", title: "Clear title issues" },
          { id: "close", title: "Complete closing", required: true },
          { id: "distribute", title: "Distribute proceeds per estate" },
        ],
        resources: [{ title: "Estate Closing Guide", type: "pdf" }],
      },
    ],
    resources: [
      { title: "Probate Process Guide", description: "Step by step", type: "pdf", icon: FileText },
      { title: "Estate Sale Resources", description: "Professional help", type: "guide", icon: Package },
    ],
    aiContext:
      "Client handling estate/probate sale after losing a loved one. Be compassionate, patient, and supportive. Understand the emotional weight of the situation.",
    quickActions: [
      { label: "My Listing", href: "/portal/{contactId}/listing", icon: Home },
      { label: "Documents", href: "/portal/{contactId}/documents", icon: FileText },
      { label: "Resources", href: "/portal/{contactId}/journey", icon: Heart },
    ],
  },

  senior: {
    id: "senior",
    label: "Senior",
    icon: Heart,
    color: "text-rose-600",
    bgColor: "bg-rose-50",
    borderColor: "border-rose-200",
    title: "Thoughtful Transition",
    greeting: "Your comfort is our priority",
    supportMessage:
      "We're here to make this transition as smooth as possible. Take your time - we'll handle everything.",
    sensitiveContext: true,
    isBuyer: false,
    isSeller: true,
    features: ["Memory Video", "Senior Move Managers", "Downsizing Support", "Estate Coordination"],
    widgets: [
      {
        id: "years",
        title: "Years in Home",
        description: "Memories made here",
        icon: Heart,
        dataKey: "years_in_home",
        format: "number",
      },
      {
        id: "memory_video",
        title: "Memory Video",
        description: "Capture your home's story",
        icon: Camera,
        dataKey: "memory_video_requested",
        format: "boolean",
        action: { label: "Learn More", href: "/portal/{contactId}/journey" },
      },
      {
        id: "property",
        title: "Your Home",
        description: "Property address",
        icon: Home,
        dataKey: "property_address",
        format: "text",
      },
    ],
    journeyStages: [
      {
        id: "consultation",
        name: "Comfortable Consultation",
        description: "We'll come to you and answer all your questions",
        estimatedDays: 7,
        tasks: [
          { id: "meeting", title: "In-home consultation at your pace", required: true },
          { id: "family", title: "Include family members if desired" },
          { id: "options", title: "Review all your options" },
          { id: "timeline", title: "Create a comfortable timeline" },
        ],
        resources: [
          { title: "Downsizing Made Simple", type: "pdf" },
          { title: "Questions to Ask", type: "checklist" },
        ],
        tips: ["There's no rush - we work at your pace", "Family can be involved at any level you choose"],
      },
      {
        id: "downsizing",
        name: "Thoughtful Downsizing",
        description: "Sort through belongings with support",
        estimatedDays: 30,
        tasks: [
          { id: "senior_mover", title: "Connect with senior move manager", required: true },
          { id: "sort", title: "Sort belongings room by room" },
          { id: "memories", title: "Preserve important memories and photos" },
          { id: "estate_sale", title: "Coordinate estate sale if needed" },
        ],
        resources: [
          { title: "Room-by-Room Downsizing Guide", type: "pdf" },
          { title: "Memory Preservation Ideas", type: "guide" },
          { title: "Senior Move Manager Directory", type: "tool" },
        ],
      },
      {
        id: "memory_video",
        name: "Memory Video",
        description: "Capture your home's story forever",
        estimatedDays: 7,
        tasks: [
          { id: "schedule", title: "Schedule memory video filming" },
          { id: "stories", title: "Share stories and memories of your home" },
          { id: "receive", title: "Receive your keepsake video" },
        ],
        resources: [{ title: "Memory Video Examples", type: "video" }],
        tips: ["This video is yours to keep forever", "Share it with family and future generations"],
      },
      {
        id: "preparation",
        name: "Gentle Preparation",
        description: "Prepare your home at a comfortable pace",
        estimatedDays: 21,
        tasks: [
          { id: "repairs", title: "Handle any necessary repairs" },
          { id: "photos", title: "Professional photography" },
          { id: "pricing", title: "Review pricing together" },
        ],
        resources: [{ title: "Simple Prep Checklist", type: "checklist" }],
      },
      {
        id: "listing_sale",
        name: "Listing & Sale",
        description: "We handle everything",
        estimatedDays: 30,
        tasks: [
          { id: "list", title: "List your home", required: true },
          { id: "showings", title: "Manage all showings" },
          { id: "offers", title: "Review offers together" },
          { id: "accept", title: "Accept an offer", required: true },
        ],
        resources: [{ title: "What to Expect During Showings", type: "pdf" }],
      },
      {
        id: "transition",
        name: "Smooth Transition",
        description: "Move to your new chapter",
        estimatedDays: 30,
        tasks: [
          { id: "coordination", title: "Move coordination" },
          { id: "utilities", title: "Transfer utilities" },
          { id: "close", title: "Complete sale", required: true },
          { id: "settle", title: "Settle into new home" },
        ],
        resources: [
          { title: "Moving Day Guide", type: "checklist" },
          { title: "New Home Checklist", type: "pdf" },
        ],
      },
    ],
    resources: [
      { title: "Memory Video", description: "Preserve your home's story", type: "video", icon: Camera },
      { title: "Downsizing Guide", description: "Take it step by step", type: "pdf", icon: Package },
      { title: "Senior Move Managers", description: "Professional help", type: "guide", icon: Truck },
    ],
    aiContext:
      "Senior client downsizing after many years in their home. Be patient, use clear simple language, be respectful of emotional attachment to the home. Offer reassurance and support.",
    quickActions: [
      { label: "My Journey", href: "/portal/{contactId}/journey", icon: Heart },
      { label: "Memory Video", href: "/portal/{contactId}/journey", icon: Camera },
      { label: "Call My Agent", href: "/portal/{contactId}/help", icon: Phone },
    ],
  },

  relocating: {
    id: "relocating",
    label: "Relocating",
    icon: Plane,
    color: "text-teal-600",
    bgColor: "bg-teal-50",
    borderColor: "border-teal-200",
    title: "Relocation Portal",
    greeting: "Making your move seamless",
    isBuyer: true,
    isSeller: false,
    features: ["Area Comparison", "Moving Checklist", "School Districts", "Cost of Living"],
    widgets: [
      {
        id: "relocating_from",
        title: "Moving From",
        description: "Your current location",
        icon: MapPin,
        dataKey: "relocating_from",
        format: "text",
      },
      {
        id: "reason",
        title: "Relocation Reason",
        description: "Why you're moving",
        icon: Briefcase,
        dataKey: "relocation_reason",
        format: "text",
      },
      {
        id: "package",
        title: "Relo Package",
        description: "Employer assistance",
        icon: Package,
        dataKey: "relocation_package",
        format: "boolean",
      },
    ],
    journeyStages: [
      {
        id: "planning",
        name: "Relocation Planning",
        description: "Coordinate your move",
        estimatedDays: 7,
        tasks: [
          { id: "timeline", title: "Establish move timeline", required: true },
          { id: "benefits", title: "Review relocation benefits" },
          { id: "research", title: "Research destination area" },
          { id: "connect", title: "Connect with destination agent" },
        ],
        resources: [
          { title: "Relocation Planning Guide", type: "pdf" },
          { title: "Area Comparison Tool", type: "tool" },
        ],
      },
      {
        id: "area_research",
        name: "Area Research",
        description: "Learn about your new community",
        estimatedDays: 14,
        tasks: [
          { id: "neighborhoods", title: "Research neighborhoods" },
          { id: "schools", title: "Evaluate school districts" },
          { id: "commute", title: "Calculate commute options" },
          { id: "cost", title: "Compare cost of living" },
        ],
        resources: [
          { title: "Neighborhood Guide", type: "guide" },
          { title: "School Ratings Tool", type: "tool" },
          { title: "Cost of Living Calculator", type: "calculator" },
        ],
      },
      {
        id: "home_search",
        name: "Remote Home Search",
        description: "Find your new home from a distance",
        estimatedDays: 21,
        tasks: [
          { id: "virtual", title: "Virtual home tours" },
          { id: "visit", title: "Schedule house hunting trip" },
          { id: "shortlist", title: "Narrow down options" },
          { id: "offer", title: "Submit offer", required: true },
        ],
        resources: [
          { title: "Remote Buying Guide", type: "pdf" },
          { title: "Virtual Tour Tips", type: "video" },
        ],
      },
      {
        id: "closing_moving",
        name: "Closing & Moving",
        description: "Finalize purchase and coordinate move",
        estimatedDays: 30,
        tasks: [
          { id: "close", title: "Close on new home", required: true },
          { id: "movers", title: "Coordinate movers" },
          { id: "utilities", title: "Set up utilities" },
          { id: "move", title: "Complete your move" },
        ],
        resources: [
          { title: "Moving Checklist", type: "checklist" },
          { title: "New City Essentials", type: "guide" },
        ],
      },
    ],
    resources: [
      { title: "Area Comparison Tool", description: "Compare locations", type: "tool", icon: MapPin },
      { title: "Moving Checklist", description: "Stay organized", type: "checklist", icon: Truck },
    ],
    aiContext:
      "Client relocating to a new area, possibly for work. Help with area information, logistics, and remote buying process. Understand time constraints.",
    quickActions: [
      { label: "Search Properties", href: "/portal/{contactId}/properties", icon: Home },
      { label: "Area Info", href: "/portal/{contactId}/properties", icon: MapPin },
      { label: "Schools", href: "/portal/{contactId}/properties", icon: School },
    ],
  },

  // -------------------------------------------------------------------------
  // ADDITIONAL PERSONAS (with default configurations)
  // -------------------------------------------------------------------------
  luxury_seller: {
    id: "luxury_seller",
    label: "Luxury Seller",
    icon: Sparkles,
    color: "text-violet-600",
    bgColor: "bg-violet-50",
    borderColor: "border-violet-200",
    title: "Premium Marketing Portal",
    greeting: "Showcase your exceptional property",
    isBuyer: false,
    isSeller: true,
    features: ["Global Marketing", "Private Showings", "Luxury Network", "Concierge Services"],
    widgets: [
      {
        id: "list_price",
        title: "List Price",
        description: "Property listing price",
        icon: DollarSign,
        dataKey: "list_price",
        format: "currency",
      },
      {
        id: "privacy",
        title: "Privacy Level",
        description: "Marketing discretion",
        icon: Shield,
        dataKey: "privacy_level",
        format: "text",
      },
    ],
    journeyStages: [
      {
        id: "preparation",
        name: "Property Preparation",
        description: "Prepare your luxury property for market",
        tasks: [
          { id: "staging", title: "Professional staging consultation", required: true },
          { id: "photography", title: "Luxury photography and video shoot", required: true },
          { id: "repairs", title: "Complete any needed repairs/upgrades" },
          { id: "disclosure", title: "Prepare property disclosures" },
        ],
        resources: [{ title: "Luxury Staging Guide", type: "pdf" }],
        tips: ["First impressions matter immensely in luxury real estate"],
      },
      {
        id: "marketing",
        name: "Exclusive Marketing",
        description: "Launch premium marketing campaign",
        tasks: [
          { id: "materials", title: "Review marketing materials", required: true },
          { id: "network", title: "Private network outreach" },
          { id: "international", title: "International buyer marketing" },
          { id: "events", title: "Plan exclusive showing events" },
        ],
        resources: [{ title: "Marketing Plan", type: "pdf" }],
      },
      {
        id: "showings",
        name: "Private Showings",
        description: "Manage qualified buyer showings",
        tasks: [
          { id: "qualify", title: "Review buyer qualifications" },
          { id: "schedule", title: "Coordinate private showings" },
          { id: "feedback", title: "Review showing feedback" },
        ],
        resources: [{ title: "Showing Reports", type: "pdf" }],
      },
      {
        id: "negotiation",
        name: "Offer Negotiation",
        description: "Navigate premium offer negotiations",
        tasks: [
          { id: "review", title: "Review and compare offers", required: true },
          { id: "negotiate", title: "Negotiate terms and conditions" },
          { id: "accept", title: "Accept best offer", required: true },
        ],
        resources: [{ title: "Offer Comparison", type: "tool" }],
      },
      {
        id: "closing",
        name: "Discreet Closing",
        description: "Complete transaction with privacy",
        tasks: [
          { id: "escrow", title: "Open escrow with trusted title company", required: true },
          { id: "inspections", title: "Coordinate inspections" },
          { id: "documents", title: "Sign closing documents", required: true },
          { id: "transfer", title: "Complete transfer", required: true },
        ],
        resources: [{ title: "Closing Checklist", type: "checklist" }],
      },
    ],
    resources: [
      { title: "Luxury Marketing Guide", description: "Premium marketing strategies", type: "pdf", icon: Camera },
      { title: "International Buyer Reach", description: "Global exposure options", type: "guide", icon: Plane },
    ],
    aiContext: "Luxury property seller expecting premium service and global reach. Communicate with sophistication.",
    quickActions: [
      { label: "My Listing", href: "/portal/{contactId}/listing", icon: Sparkles },
      { label: "Marketing", href: "/portal/{contactId}/listing", icon: Camera },
    ],
  },

  fsbo: {
    id: "fsbo",
    label: "FSBO",
    icon: Building,
    color: "text-lime-600",
    bgColor: "bg-lime-50",
    borderColor: "border-lime-200",
    title: "Professional Support Portal",
    greeting: "Maximize your home's value",
    isBuyer: false,
    isSeller: true,
    features: ["Net Proceeds Comparison", "MLS Exposure", "Professional Marketing", "Contract Support"],
    widgets: [
      {
        id: "days_fsbo",
        title: "Days on Market",
        description: "As FSBO",
        icon: Clock,
        dataKey: "days_on_market_fsbo",
        format: "number",
      },
      {
        id: "asking",
        title: "Asking Price",
        description: "Your listed price",
        icon: DollarSign,
        dataKey: "asking_price",
        format: "currency",
      },
    ],
    journeyStages: [
      {
        id: "evaluation",
        name: "Market Evaluation",
        description: "Understand your home's true market value",
        tasks: [
          { id: "cma", title: "Review comparative market analysis", required: true },
          { id: "net", title: "Compare net proceeds: FSBO vs. agent representation", required: true },
          { id: "pricing", title: "Analyze your current pricing strategy" },
          { id: "feedback", title: "Discuss buyer feedback you've received" },
        ],
        resources: [{ title: "Net Proceeds Calculator", type: "tool" }],
        tips: ["Most FSBOs net less even without commission due to lower sale prices"],
      },
      {
        id: "decision",
        name: "Partnership Decision",
        description: "Decide on the best path forward",
        tasks: [
          { id: "review", title: "Review our marketing plan", required: true },
          { id: "exposure", title: "Understand MLS exposure benefits" },
          { id: "sign", title: "Sign listing agreement", required: true },
        ],
        resources: [{ title: "Marketing Plan Preview", type: "pdf" }],
      },
      {
        id: "preparation",
        name: "Property Preparation",
        description: "Prepare your home for maximum appeal",
        tasks: [
          { id: "staging", title: "Professional staging consultation" },
          { id: "photos", title: "Professional photography", required: true },
          { id: "repairs", title: "Complete any needed repairs" },
        ],
        resources: [{ title: "Staging Tips", type: "guide" }],
      },
      {
        id: "active",
        name: "Active Marketing",
        description: "Full exposure marketing campaign",
        tasks: [
          { id: "mls", title: "MLS listing active", required: true },
          { id: "syndication", title: "Confirm syndication to all major sites" },
          { id: "showings", title: "Coordinate professional showings" },
        ],
        resources: [{ title: "Marketing Dashboard", type: "tool" }],
      },
      {
        id: "closing",
        name: "Successful Closing",
        description: "Navigate to a successful sale",
        tasks: [
          { id: "offers", title: "Review and negotiate offers", required: true },
          { id: "contract", title: "Professional contract management" },
          { id: "close", title: "Close the sale", required: true },
        ],
        resources: [{ title: "Closing Checklist", type: "checklist" }],
      },
    ],
    resources: [
      { title: "Net Proceeds Calculator", description: "Compare FSBO vs agent sale", type: "calculator", icon: Calculator },
      { title: "Market Analysis Report", description: "Your home's true value", type: "pdf", icon: BarChart3 },
    ],
    aiContext:
      "For Sale By Owner seller who may be skeptical of agents. Focus on value proposition and net proceeds comparison.",
    quickActions: [
      { label: "Net Proceeds Calculator", href: "/portal/{contactId}/listing", icon: Calculator },
      { label: "Market Analysis", href: "/portal/{contactId}/listing", icon: BarChart3 },
    ],
  },

  expired: {
    id: "expired",
    label: "Expired Listing",
    icon: ArrowUpRight,
    color: "text-slate-600",
    bgColor: "bg-slate-50",
    borderColor: "border-slate-200",
    title: "Fresh Start Portal",
    greeting: "A new approach awaits",
    isBuyer: false,
    isSeller: true,
    features: ["Market Analysis", "New Strategy", "Enhanced Marketing", "Pricing Optimization"],
    widgets: [
      {
        id: "previous_price",
        title: "Previous List Price",
        description: "Prior listing",
        icon: DollarSign,
        dataKey: "previous_list_price",
        format: "currency",
      },
      {
        id: "days",
        title: "Days on Market",
        description: "Previous listing",
        icon: Clock,
        dataKey: "days_on_market",
        format: "number",
      },
    ],
    journeyStages: [
      {
        id: "analysis",
        name: "Fresh Analysis",
        description: "Understand what went wrong and how to fix it",
        tasks: [
          { id: "review", title: "Review previous listing history", required: true },
          { id: "feedback", title: "Analyze buyer feedback from previous showings" },
          { id: "market", title: "Updated market analysis", required: true },
          { id: "competition", title: "Review current competition" },
        ],
        resources: [{ title: "Market Update Report", type: "pdf" }],
        tips: ["A fresh approach often makes all the difference"],
      },
      {
        id: "strategy",
        name: "New Strategy",
        description: "Develop a winning approach",
        tasks: [
          { id: "pricing", title: "Determine optimal pricing strategy", required: true },
          { id: "improvements", title: "Identify high-impact improvements" },
          { id: "staging", title: "Consider staging updates" },
          { id: "plan", title: "Agree on new marketing plan", required: true },
        ],
        resources: [{ title: "Pricing Strategy Guide", type: "guide" }],
      },
      {
        id: "refresh",
        name: "Property Refresh",
        description: "Make strategic updates",
        tasks: [
          { id: "photos", title: "New professional photography", required: true },
          { id: "updates", title: "Complete recommended updates" },
          { id: "staging", title: "Stage for maximum appeal" },
        ],
        resources: [{ title: "High-Impact Updates", type: "checklist" }],
      },
      {
        id: "relaunch",
        name: "Strategic Relaunch",
        description: "Launch with new momentum",
        tasks: [
          { id: "timing", title: "Choose optimal launch timing" },
          { id: "mls", title: "Relist on MLS with new approach", required: true },
          { id: "marketing", title: "Execute enhanced marketing campaign" },
        ],
        resources: [{ title: "Marketing Campaign", type: "tool" }],
      },
      {
        id: "success",
        name: "Successful Sale",
        description: "Navigate to closing",
        tasks: [
          { id: "offers", title: "Review and negotiate offers", required: true },
          { id: "contract", title: "Execute contract" },
          { id: "close", title: "Close successfully", required: true },
        ],
        resources: [{ title: "Closing Guide", type: "guide" }],
      },
    ],
    resources: [
      { title: "What Went Wrong Analysis", description: "Understanding the past listing", type: "pdf", icon: Target },
      { title: "Fresh Start Marketing", description: "New approach to selling", type: "guide", icon: Camera },
    ],
    aiContext:
      "Seller whose previous listing expired. Be sympathetic but solution-focused. Emphasize what will be different this time.",
    quickActions: [
      { label: "New Strategy", href: "/portal/{contactId}/listing", icon: Target },
      { label: "Market Update", href: "/portal/{contactId}/listing", icon: BarChart3 },
    ],
  },

  upsizers: {
    id: "upsizers",
    label: "Upsizer",
    icon: ArrowUpRight,
    color: "text-emerald-600",
    bgColor: "bg-emerald-50",
    borderColor: "border-emerald-200",
    title: "Growing Family Portal",
    greeting: "More space for your growing family",
    isBuyer: true,
    isSeller: true,
    features: ["School Districts", "Coordinated Buy/Sell", "Space Comparison", "Family Amenities"],
    widgets: [
      {
        id: "current_value",
        title: "Current Home Value",
        description: "Estimated equity",
        icon: Home,
        dataKey: "current_home_value",
        format: "currency",
      },
      {
        id: "reason",
        title: "Reason for Upsizing",
        description: "Growing needs",
        icon: Users,
        dataKey: "reason_for_upsizing",
        format: "text",
      },
      {
        id: "bedrooms",
        title: "Target Bedrooms",
        description: "Minimum needed",
        icon: Key,
        dataKey: "must_have_bedrooms",
        format: "number",
      },
    ],
    journeyStages: [
      {
        id: "planning",
        name: "Family Planning",
        description: "Plan your move to a larger home",
        tasks: [
          { id: "needs", title: "Define space needs (bedrooms, bathrooms, yard)", required: true },
          { id: "schools", title: "Research school districts", required: true },
          { id: "budget", title: "Determine budget using current home equity" },
          { id: "timeline", title: "Set ideal timeline for move" },
        ],
        resources: [{ title: "Space Needs Calculator", type: "tool" }],
        tips: ["Think about your needs 5 years from now, not just today"],
      },
      {
        id: "search",
        name: "Home Search",
        description: "Find your larger family home",
        tasks: [
          { id: "criteria", title: "Set search criteria", required: true },
          { id: "tour", title: "Tour potential homes" },
          { id: "schools", title: "Visit school districts of interest" },
          { id: "commute", title: "Evaluate commute times" },
        ],
        resources: [{ title: "School Ratings Guide", type: "guide" }],
      },
      {
        id: "current_home",
        name: "Prepare Current Home",
        description: "Get your current home ready to sell",
        tasks: [
          { id: "valuation", title: "Get home valuation", required: true },
          { id: "repairs", title: "Complete necessary repairs" },
          { id: "staging", title: "Stage for sale" },
          { id: "photos", title: "Professional photography", required: true },
        ],
        resources: [{ title: "Selling Checklist", type: "checklist" }],
      },
      {
        id: "coordination",
        name: "Coordinated Buy/Sell",
        description: "Manage both transactions",
        tasks: [
          { id: "offer", title: "Make offer on new home", required: true },
          { id: "contingency", title: "Negotiate sale contingency if needed" },
          { id: "timing", title: "Coordinate closing dates" },
          { id: "bridge", title: "Arrange bridge financing if needed" },
        ],
        resources: [{ title: "Bridge Loan Guide", type: "pdf" }],
      },
      {
        id: "move",
        name: "Family Move",
        description: "Complete your move",
        tasks: [
          { id: "close_sell", title: "Close on current home", required: true },
          { id: "close_buy", title: "Close on new home", required: true },
          { id: "moving", title: "Coordinate moving logistics" },
          { id: "settle", title: "Settle into your new home" },
        ],
        resources: [{ title: "Moving Day Checklist", type: "checklist" }],
      },
    ],
    resources: [
      { title: "School District Ratings", description: "Compare local schools", type: "tool", icon: School },
      { title: "Space Needs Calculator", description: "Right-size your next home", type: "calculator", icon: Home },
      { title: "Buy/Sell Coordination Guide", description: "Managing both transactions", type: "guide", icon: Target },
    ],
    aiContext:
      "Family upsizing to a larger home, likely with children. Focus on schools, space, and coordinating the buy/sell process.",
    quickActions: [
      { label: "Search Larger Homes", href: "/portal/{contactId}/properties", icon: Home },
      { label: "School Ratings", href: "/portal/{contactId}/properties", icon: School },
    ],
  },

  empty_nester: {
    id: "empty_nester",
    label: "Empty Nester",
    icon: ArrowDownRight,
    color: "text-purple-600",
    bgColor: "bg-purple-50",
    borderColor: "border-purple-200",
    title: "Right-Sizing Portal",
    greeting: "Simplify your lifestyle",
    supportMessage: "This is an exciting new chapter. We'll help you find the perfect space for this stage of life.",
    isBuyer: true,
    isSeller: true,
    features: ["Downsizing Support", "Right-Sized Homes", "Storage Solutions", "Lifestyle Options"],
    widgets: [
      {
        id: "current_sqft",
        title: "Current Size",
        description: "Square feet",
        icon: Home,
        dataKey: "current_sqft",
        format: "number",
      },
      {
        id: "desired_sqft",
        title: "Desired Size",
        description: "Target square feet",
        icon: Target,
        dataKey: "desired_sqft",
        format: "number",
      },
      {
        id: "reason",
        title: "Reason",
        description: "Why downsizing",
        icon: Heart,
        dataKey: "reason",
        format: "text",
      },
    ],
    journeyStages: [
      {
        id: "lifestyle",
        name: "Lifestyle Planning",
        description: "Envision your next chapter",
        tasks: [
          { id: "goals", title: "Define lifestyle goals for this chapter", required: true },
          { id: "size", title: "Determine ideal home size" },
          { id: "location", title: "Consider location priorities (near family, amenities)" },
          { id: "budget", title: "Review financial goals and budget" },
        ],
        resources: [{ title: "Lifestyle Planning Guide", type: "guide" }],
        tips: ["This is an exciting new chapter - focus on what you want, not just what you're leaving"],
      },
      {
        id: "search",
        name: "Right-Sized Home Search",
        description: "Find your perfect next home",
        tasks: [
          { id: "criteria", title: "Set search criteria", required: true },
          { id: "types", title: "Explore property types (condo, single-level, 55+)" },
          { id: "tour", title: "Tour potential homes" },
          { id: "amenities", title: "Evaluate amenities and maintenance" },
        ],
        resources: [{ title: "55+ Community Guide", type: "guide" }],
      },
      {
        id: "declutter",
        name: "Thoughtful Decluttering",
        description: "Prepare to right-size your belongings",
        tasks: [
          { id: "inventory", title: "Inventory belongings" },
          { id: "keep", title: "Decide what to keep" },
          { id: "family", title: "Distribute items to family" },
          { id: "donate", title: "Arrange donations or estate sale" },
        ],
        resources: [{ title: "Decluttering Guide", type: "checklist" }],
        tips: ["Take your time with sentimental items - this process is emotional"],
      },
      {
        id: "sell",
        name: "Sell Current Home",
        description: "Market your current home",
        tasks: [
          { id: "prep", title: "Prepare home for sale", required: true },
          { id: "list", title: "List on market", required: true },
          { id: "showings", title: "Manage showings" },
          { id: "negotiate", title: "Review and negotiate offers" },
        ],
        resources: [{ title: "Selling Checklist", type: "checklist" }],
      },
      {
        id: "transition",
        name: "Smooth Transition",
        description: "Complete your move",
        tasks: [
          { id: "close_both", title: "Coordinate both closings", required: true },
          { id: "movers", title: "Hire senior-friendly movers" },
          { id: "utilities", title: "Transfer utilities and services" },
          { id: "settle", title: "Settle into your new lifestyle", required: true },
        ],
        resources: [{ title: "Moving Checklist", type: "checklist" }],
      },
    ],
    resources: [
      { title: "Right-Sizing Guide", description: "Tips for downsizing successfully", type: "guide", icon: Home },
      { title: "55+ Communities", description: "Active adult community options", type: "guide", icon: Heart },
      { title: "Decluttering Checklist", description: "Thoughtful approach to belongings", type: "checklist", icon: Package },
    ],
    aiContext:
      "Empty nester downsizing now that children have moved out. Be positive about this life transition. Focus on lifestyle benefits of right-sizing.",
    quickActions: [
      { label: "Right-Sized Homes", href: "/portal/{contactId}/properties", icon: Home },
      { label: "Selling My Home", href: "/portal/{contactId}/listing", icon: DollarSign },
    ],
  },

  remote_seller: {
    id: "remote_seller",
    label: "Remote Seller",
    icon: Plane,
    color: "text-cyan-600",
    bgColor: "bg-cyan-50",
    borderColor: "border-cyan-200",
    title: "Remote Sale Portal",
    greeting: "Sell from anywhere",
    isBuyer: false,
    isSeller: true,
    features: ["Virtual Updates", "Digital Signing", "Property Monitoring", "Video Tours"],
    widgets: [
      {
        id: "location",
        title: "Your Location",
        description: "Where you are now",
        icon: MapPin,
        dataKey: "current_location",
        format: "text",
      },
      {
        id: "timezone",
        title: "Timezone",
        description: "For scheduling",
        icon: Clock,
        dataKey: "timezone",
        format: "text",
      },
    ],
    journeyStages: [
      {
        id: "setup",
        name: "Remote Setup",
        description: "Establish remote management systems",
        tasks: [
          { id: "communication", title: "Set up communication preferences and schedule", required: true },
          { id: "access", title: "Arrange property access (lockbox, key holder)" },
          { id: "contacts", title: "Provide local emergency contacts" },
          { id: "timezone", title: "Confirm timezone for scheduling" },
        ],
        resources: [{ title: "Remote Sale Guide", type: "guide" }],
        tips: ["Clear communication is key to a successful remote sale"],
      },
      {
        id: "preparation",
        name: "Property Preparation",
        description: "Prepare home for sale remotely",
        tasks: [
          { id: "inspection", title: "Pre-listing inspection" },
          { id: "repairs", title: "Coordinate repairs via trusted contractors" },
          { id: "staging", title: "Arrange staging", required: true },
          { id: "photos", title: "Professional photography", required: true },
        ],
        resources: [{ title: "Vendor Network", type: "guide" }],
      },
      {
        id: "active",
        name: "Active Marketing",
        description: "Monitor your listing remotely",
        tasks: [
          { id: "list", title: "Property listed", required: true },
          { id: "updates", title: "Receive regular video updates" },
          { id: "showings", title: "Review showing feedback" },
          { id: "virtual", title: "Offer virtual showing option for you" },
        ],
        resources: [{ title: "Showing Reports", type: "pdf" }],
      },
      {
        id: "offers",
        name: "Offer Management",
        description: "Review and negotiate offers",
        tasks: [
          { id: "review", title: "Review offers via video call", required: true },
          { id: "negotiate", title: "Negotiate terms" },
          { id: "accept", title: "Accept best offer", required: true },
        ],
        resources: [{ title: "Offer Comparison Tool", type: "tool" }],
      },
      {
        id: "closing",
        name: "Remote Closing",
        description: "Complete sale from anywhere",
        tasks: [
          { id: "inspections", title: "Coordinate buyer inspections" },
          { id: "documents", title: "Sign documents via digital notary", required: true },
          { id: "utilities", title: "Transfer utilities" },
          { id: "close", title: "Complete closing remotely", required: true },
        ],
        resources: [{ title: "Digital Closing Guide", type: "guide" }],
        tips: ["Digital notary services make remote closings simple and secure"],
      },
    ],
    resources: [
      { title: "Remote Sale Guide", description: "Managing your sale from afar", type: "guide", icon: Plane },
      { title: "Digital Signing Guide", description: "How remote closings work", type: "pdf", icon: FileText },
      { title: "Video Update System", description: "Stay connected to your property", type: "tool", icon: Video },
    ],
    aiContext:
      "Seller managing sale remotely from another location. Focus on communication tools and keeping them informed despite the distance.",
    quickActions: [
      { label: "My Listing", href: "/portal/{contactId}/listing", icon: Home },
      { label: "Video Updates", href: "/portal/{contactId}/documents", icon: Video },
    ],
  },
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

export function getPersonaConfig(persona: string): PersonaConfig {
  return PERSONA_CONFIGS[persona] || PERSONA_CONFIGS.first_time_buyer
}

export function getPersonaWidgets(persona: string, customFields?: Record<string, any>): PersonaWidget[] {
  const config = getPersonaConfig(persona)
  return config.widgets.map((widget) => ({
    ...widget,
    value: customFields?.[widget.dataKey],
  }))
}

export function getPersonaJourneyStages(persona: string): JourneyStage[] {
  const config = getPersonaConfig(persona)
  if (config.journeyStages.length > 0) {
    return config.journeyStages
  }
  // Return default stages if none defined
  return PERSONA_CONFIGS.first_time_buyer.journeyStages
}

export function formatWidgetValue(value: any, format?: string): string {
  if (value === undefined || value === null) return ""

  switch (format) {
    case "currency":
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(value)
    case "percent":
      return `${value}%`
    case "number":
      return new Intl.NumberFormat("en-US").format(value)
    case "date":
      return new Date(value).toLocaleDateString()
    case "boolean":
      return value ? "Yes" : "No"
    default:
      if (Array.isArray(value)) {
        return value.join(", ")
      }
      return String(value)
  }
}
