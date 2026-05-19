"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Zap,
  Loader2,
  Copy,
  Check,
  Star,
  StarOff,
  ChevronDown,
  BookOpen,
  Home,
  Calculator,
  MapPin,
  FileText,
  PenLine,
  Mail,
  Share2,
  MessageSquare,
  Reply,
  Activity,
  Users,
  TrendingUp,
  ClipboardList,
  Calendar,
  Settings,
} from "lucide-react"
import Link from "next/link"
import {
  executeAITool,
  getUserFavorites,
  getAIToolUsageStats,
  toggleToolFavorite,
} from "@/app/actions/ai-tools-hub"
import { getBrandVoiceProfile } from "@/app/actions/ai-content-generation"
import { checkThemFirstCompliance } from "@/app/actions/ai-chat"
import {
  compareNeighborhoods,
  analyzeInvestmentProperty,
  calculateRentVsBuy,
} from "@/app/actions/calculators"

// Tool definitions with categories
const TOOLS = [
  // CLIENT EDUCATION TOOLS (purple)
  {
    id: "explain_this",
    name: "Explain This",
    description: "Explain any real estate concept in plain language for your client",
    category: "education",
    categoryColor: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
    icon: BookOpen,
    inputs: [{ name: "concept", type: "textarea", label: "Concept to explain", placeholder: "e.g., What is a 1031 exchange?" }],
  },
  {
    id: "property_comparison",
    name: "Property Comparison",
    description: "Compare two or more properties for a buyer side-by-side",
    category: "education",
    categoryColor: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
    icon: Home,
    inputs: [
      { name: "property1", type: "text", label: "Property 1 Address", placeholder: "123 Main St" },
      { name: "property2", type: "text", label: "Property 2 Address", placeholder: "456 Oak Ave" },
      { name: "buyerCriteria", type: "text", label: "Buyer criteria", placeholder: "3 bed, good schools, under $500k" },
    ],
  },
  {
    id: "affordability_calculator",
    name: "Affordability Calculator",
    description: "Calculate what your buyer can afford based on real numbers",
    category: "education",
    categoryColor: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
    icon: Calculator,
    inputs: [
      { name: "income", type: "text", label: "Annual income", placeholder: "$120,000" },
      { name: "debt", type: "text", label: "Monthly debt", placeholder: "$500" },
      { name: "downPayment", type: "text", label: "Down payment", placeholder: "$50,000" },
      { name: "rate", type: "text", label: "Interest rate", placeholder: "6.5%" },
    ],
  },
  {
    id: "neighborhood_research",
    name: "Neighborhood Research",
    description: "Get instant neighborhood analysis for any area",
    category: "education",
    categoryColor: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
    icon: MapPin,
    inputs: [
      { name: "neighborhood", type: "text", label: "Neighborhood name", placeholder: "Capitol Hill" },
      { name: "city", type: "text", label: "City", placeholder: "Denver" },
      { name: "state", type: "text", label: "State", placeholder: "CO" },
    ],
  },
  {
    id: "document_explainer",
    name: "Document Explainer",
    description: "Explain any real estate document in plain language",
    category: "education",
    categoryColor: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
    icon: FileText,
    inputs: [
      { name: "documentType", type: "text", label: "Document type", placeholder: "Purchase Agreement" },
      { name: "question", type: "textarea", label: "Specific section or question", placeholder: "What does the inspection contingency clause mean?" },
    ],
  },
  // CONTENT CREATION TOOLS (blue)
  {
    id: "property_description",
    name: "Property Description",
    description: "Generate compelling listing descriptions from features",
    category: "content",
    categoryColor: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    icon: PenLine,
    inputs: [
      { name: "address", type: "text", label: "Property address", placeholder: "123 Luxury Lane" },
      { name: "features", type: "textarea", label: "Key features", placeholder: "4 bed, 3 bath, updated kitchen, pool" },
      { name: "tone", type: "select", label: "Tone", options: ["luxury", "family", "modern", "traditional", "investment"] },
    ],
  },
  {
    id: "email_composer",
    name: "Email Composer",
    description: "Draft any real estate email in seconds",
    category: "content",
    categoryColor: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    icon: Mail,
    inputs: [
      { name: "emailType", type: "select", label: "Email type", options: ["follow-up", "introduction", "offer", "negotiation", "closing", "thank-you"] },
      { name: "recipient", type: "text", label: "Recipient name", placeholder: "John Smith" },
      { name: "context", type: "textarea", label: "Context", placeholder: "Just toured 3 properties, interested in the corner lot" },
    ],
    requiresCompliance: true,
  },
  {
    id: "social_post",
    name: "Social Post",
    description: "Create platform-ready social posts from any real estate topic",
    category: "content",
    categoryColor: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    icon: Share2,
    inputs: [
      { name: "contentType", type: "select", label: "Content type", options: ["just-listed", "just-sold", "market-update", "tip", "testimonial", "behind-the-scenes"] },
      { name: "context", type: "textarea", label: "Context", placeholder: "Beautiful 4 bed home in Oak Park" },
      { name: "platform", type: "select", label: "Platform", options: ["instagram", "facebook", "linkedin", "twitter"] },
    ],
    usesBrandVoice: true,
  },
  {
    id: "objection_handler",
    name: "Objection Handler",
    description: "Get the best response to any client objection, immediately",
    category: "content",
    categoryColor: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    icon: MessageSquare,
    inputs: [
      { name: "objection", type: "textarea", label: "Objection text", placeholder: "The commission is too high..." },
      { name: "context", type: "text", label: "Context", placeholder: "First-time buyer, $400k price point" },
    ],
  },
  {
    id: "smart_reply",
    name: "Smart Reply",
    description: "AI drafts your next message based on conversation context",
    category: "content",
    categoryColor: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    icon: Reply,
    inputs: [
      { name: "lastMessage", type: "textarea", label: "Last received message", placeholder: "Paste the message you received..." },
      { name: "relationshipType", type: "select", label: "Relationship type", options: ["buyer-lead", "seller-lead", "active-buyer", "active-seller", "lifetime-customer", "sphere"] },
    ],
  },
  // BUSINESS INTELLIGENCE TOOLS (green)
  {
    id: "deal_health_monitor",
    name: "Deal Health Monitor",
    description: "Instant AI assessment of any transaction's health",
    category: "intelligence",
    categoryColor: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    icon: Activity,
    inputs: [
      { name: "transactionId", type: "text", label: "Transaction ID or address", placeholder: "TXN-12345 or 123 Main St" },
      { name: "status", type: "select", label: "Current status", options: ["under-contract", "pending", "contingency", "closing-soon", "at-risk"] },
    ],
  },
  {
    id: "team_performance_analyzer",
    name: "Team Performance Analyzer",
    description: "Analyze team performance patterns and surface coaching needs",
    category: "intelligence",
    categoryColor: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    icon: Users,
    inputs: [
      { name: "timePeriod", type: "select", label: "Time period", options: ["this-week", "this-month", "this-quarter", "this-year"] },
      { name: "focusArea", type: "select", label: "Focus area", options: ["conversion", "response-time", "client-satisfaction", "deal-velocity", "all"] },
    ],
  },
  {
    id: "market_trend_predictor",
    name: "Market Trend Predictor",
    description: "Predict local market trends for any city/area",
    category: "intelligence",
    categoryColor: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    icon: TrendingUp,
    inputs: [
      { name: "city", type: "text", label: "City", placeholder: "Austin" },
      { name: "state", type: "text", label: "State", placeholder: "TX" },
      { name: "propertyType", type: "select", label: "Property type", options: ["single-family", "condo", "townhouse", "multi-family", "luxury"] },
    ],
  },
  {
    id: "document_checklist",
    name: "Document Checklist",
    description: "Generate a complete document checklist for any transaction type",
    category: "intelligence",
    categoryColor: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    icon: ClipboardList,
    inputs: [
      { name: "transactionType", type: "select", label: "Transaction type", options: ["purchase", "sale", "listing", "lease", "commercial"] },
      { name: "state", type: "text", label: "State", placeholder: "CA" },
      { name: "propertyType", type: "select", label: "Property type", options: ["single-family", "condo", "townhouse", "multi-family", "commercial"] },
    ],
  },
  {
    id: "deadline_calculator",
    name: "Deadline Calculator",
    description: "Calculate all key dates from contract date forward",
    category: "intelligence",
    categoryColor: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    icon: Calendar,
    inputs: [
      { name: "contractDate", type: "text", label: "Contract date", placeholder: "2024-03-15" },
      { name: "state", type: "text", label: "State", placeholder: "FL" },
      { name: "contingencyDays", type: "text", label: "Contingency days", placeholder: "10" },
    ],
  },
  // CALCULATOR TOOLS — direct real-action runners (directAction = true)
  {
    id: "compare_neighborhoods",
    name: "Neighborhood Comparison",
    description: "Compare multiple neighborhoods by market stats, price trends, and days on market",
    category: "intelligence",
    categoryColor: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    icon: MapPin,
    directAction: true,
    inputs: [
      { name: "neighborhood1", type: "text", label: "Neighborhood 1", placeholder: "Capitol Hill" },
      { name: "neighborhood2", type: "text", label: "Neighborhood 2", placeholder: "Cherry Creek" },
      { name: "neighborhood3", type: "text", label: "Neighborhood 3 (optional)", placeholder: "LoHi", required: false },
      { name: "city", type: "text", label: "City", placeholder: "Denver" },
      { name: "state", type: "text", label: "State", placeholder: "CO" },
    ],
  },
  {
    id: "investment_analyzer",
    name: "Investment Property Analyzer",
    description: "Analyze cap rate, cash-on-cash return, and NOI for any rental property",
    category: "intelligence",
    categoryColor: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    icon: TrendingUp,
    directAction: true,
    inputs: [
      { name: "purchasePrice", type: "text", label: "Purchase price ($)", placeholder: "450000" },
      { name: "downPaymentPercent", type: "text", label: "Down payment (%)", placeholder: "25" },
      { name: "interestRate", type: "text", label: "Interest rate (%)", placeholder: "7.0" },
      { name: "estimatedRent", type: "text", label: "Monthly rent ($)", placeholder: "2800" },
      { name: "propertyTaxes", type: "text", label: "Annual property taxes ($)", placeholder: "6000" },
      { name: "insurance", type: "text", label: "Annual insurance ($)", placeholder: "1800" },
    ],
  },
  {
    id: "rent_vs_buy",
    name: "Rent vs. Buy Calculator",
    description: "Show clients exactly when buying beats renting given their specific numbers",
    category: "education",
    categoryColor: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
    icon: Calculator,
    directAction: true,
    inputs: [
      { name: "rentAmount", type: "text", label: "Monthly rent ($)", placeholder: "2500" },
      { name: "homePrice", type: "text", label: "Home price ($)", placeholder: "500000" },
      { name: "downPayment", type: "text", label: "Down payment ($)", placeholder: "100000" },
      { name: "interestRate", type: "text", label: "Interest rate (%)", placeholder: "7.0" },
      { name: "yearsToStay", type: "text", label: "Years planning to stay", placeholder: "5" },
    ],
  },
]

interface AIToolsClientProps {
  agentId: string
  userId: string
  userRole: string
}

export function AIToolsClient({ agentId, userId, userRole }: AIToolsClientProps) {
  const userType = userRole

  const [favorites, setFavorites] = useState<string[]>([])
  const [usageStats, setUsageStats] = useState<any[]>([])
  const [brandVoice, setBrandVoice] = useState<any>(null)
  const [toolInputs, setToolInputs] = useState<Record<string, Record<string, string>>>({})
  const [toolResults, setToolResults] = useState<Record<string, string>>({})
  const [loadingTools, setLoadingTools] = useState<Record<string, boolean>>({})
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [expandedResults, setExpandedResults] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    setLoading(true)
    try {
      const [favResult, statsResult, voiceResult] = await Promise.all([
        getUserFavorites(userId),
        getAIToolUsageStats(userId, {
          start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
          end: new Date().toISOString(),
        }),
        getBrandVoiceProfile(agentId),
      ])

      if (favResult) setFavorites(favResult as any)
      if (statsResult) setUsageStats(statsResult as any)
      if (voiceResult) setBrandVoice(voiceResult)
    } catch (error) {
      console.error("Error loading AI tools data:", error)
    } finally {
      setLoading(false)
    }
  }

  function updateToolInput(toolId: string, inputName: string, value: string) {
    setToolInputs((prev) => ({
      ...prev,
      [toolId]: {
        ...(prev[toolId] || {}),
        [inputName]: value,
      },
    }))
  }

  async function runTool(tool: (typeof TOOLS)[0]) {
    const inputs = toolInputs[tool.id] || {}

    // Validate required inputs (skip inputs explicitly marked required: false)
    const missingInputs = tool.inputs.filter((input) => (input as any).required !== false && !inputs[input.name])
    if (missingInputs.length > 0) {
      return
    }

    setLoadingTools((prev) => ({ ...prev, [tool.id]: true }))

    try {
      // Direct calculator actions — call real functions, not the AI hub
      if ((tool as any).directAction) {
        let result: any = null
        if (tool.id === "compare_neighborhoods") {
          const neighborhoods = [inputs.neighborhood1, inputs.neighborhood2, inputs.neighborhood3].filter(Boolean) as string[]
          result = await compareNeighborhoods(neighborhoods, inputs.city, inputs.state)
        } else if (tool.id === "investment_analyzer") {
          result = await analyzeInvestmentProperty({
            purchasePrice: parseFloat(inputs.purchasePrice),
            downPaymentPercent: parseFloat(inputs.downPaymentPercent),
            interestRate: parseFloat(inputs.interestRate),
            estimatedRent: parseFloat(inputs.estimatedRent),
            propertyTaxes: parseFloat(inputs.propertyTaxes),
            insurance: parseFloat(inputs.insurance),
            hoaFees: 0,
            maintenanceReserve: 5,
            vacancyRate: 5,
          })
        } else if (tool.id === "rent_vs_buy") {
          result = await calculateRentVsBuy({
            rentAmount: parseFloat(inputs.rentAmount),
            homePrice: parseFloat(inputs.homePrice),
            downPayment: parseFloat(inputs.downPayment),
            interestRate: parseFloat(inputs.interestRate),
            yearsToStay: parseFloat(inputs.yearsToStay),
            brokerageId: "",
          })
        }
        if (result) {
          const formatted = typeof result === "string" ? result : JSON.stringify(result, null, 2)
          setToolResults((prev) => ({ ...prev, [tool.id]: formatted }))
          setExpandedResults((prev) => ({ ...prev, [tool.id]: true }))
        }
        return
      }

      // Add brand voice for content creation tools
      const params: Record<string, any> = { ...inputs }
      if ((tool as any).usesBrandVoice && brandVoice) {
        params.brandVoice = brandVoice
      }

      const result = await executeAITool(tool.id, userId, userType, params)

      if (result.success && result.result) {
        let finalResult = result.result

        // Check compliance for customer-facing content
        if (tool.requiresCompliance) {
          const complianceCheck = await checkThemFirstCompliance(finalResult)
          if (!complianceCheck.compliant) {
            finalResult = `${finalResult}\n\n---\n[Compliance Note: ${complianceCheck.suggestions?.join(", ")}]`
          }
        }

        setToolResults((prev) => ({ ...prev, [tool.id]: finalResult }))
        setExpandedResults((prev) => ({ ...prev, [tool.id]: true }))
      }
    } catch (error) {
      console.error(`Error running tool ${tool.id}:`, error)
      setToolResults((prev) => ({
        ...prev,
        [tool.id]: "Error running tool. Please try again.",
      }))
    } finally {
      setLoadingTools((prev) => ({ ...prev, [tool.id]: false }))
    }
  }

  async function handleToggleFavorite(toolId: string) {
    const result = await toggleToolFavorite(userId, toolId)
    if (result) {
      setFavorites((prev) =>
        prev.includes(toolId) ? prev.filter((id) => id !== toolId) : [...prev, toolId]
      )
    }
  }

  function copyToClipboard(text: string, toolId: string) {
    navigator.clipboard.writeText(text)
    setCopiedId(toolId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  // Get top 3 recently used tools
  const recentlyUsedTools = usageStats
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((stat) => TOOLS.find((t) => t.id === stat.toolName))
    .filter(Boolean) as (typeof TOOLS)[number][]

  // Group tools by category
  const educationTools = TOOLS.filter((t) => t.category === "education")
  const contentTools = TOOLS.filter((t) => t.category === "content")
  const intelligenceTools = TOOLS.filter((t) => t.category === "intelligence")

  if (loading) {
    return (
      <div className="container mx-auto p-6 flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="container mx-auto p-6 space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-amber-100 dark:bg-amber-900/30 rounded-lg">
          <Zap className="h-6 w-6 text-amber-600 dark:text-amber-400" />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">AI Toolkit</h1>
          <p className="text-muted-foreground">
            15 specialized AI tools for real estate professionals. All powered by your business context.
          </p>
        </div>
      </div>

      {/* Recently Used */}
      {recentlyUsedTools.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-3">Recently Used</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {recentlyUsedTools.map((tool) => {
              const IconComponent = tool.icon
              return (
                <Card
                  key={tool.id}
                  className="cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => {
                    document.getElementById(`tool-${tool.id}`)?.scrollIntoView({ behavior: "smooth" })
                  }}
                >
                  <CardContent className="p-4 flex items-center gap-3">
                    <div className="p-2 bg-muted rounded-lg">
                      <IconComponent className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{tool.name}</p>
                    </div>
                    <Button size="sm" variant="outline">
                      Launch
                    </Button>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </section>
      )}

      {/* Client Education Tools */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <Badge className="bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
            Client Education
          </Badge>
          <span className="text-sm text-muted-foreground">Help clients understand real estate</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {educationTools.map((tool) => (
            <ToolCard
              key={tool.id}
              tool={tool}
              inputs={toolInputs[tool.id] || {}}
              onInputChange={(name, value) => updateToolInput(tool.id, name, value)}
              onRun={() => runTool(tool)}
              loading={loadingTools[tool.id] || false}
              result={toolResults[tool.id]}
              expanded={expandedResults[tool.id] || false}
              onToggleExpand={() =>
                setExpandedResults((prev) => ({ ...prev, [tool.id]: !prev[tool.id] }))
              }
              isFavorite={favorites.includes(tool.id)}
              onToggleFavorite={() => handleToggleFavorite(tool.id)}
              onCopy={() => copyToClipboard(toolResults[tool.id], tool.id)}
              copied={copiedId === tool.id}
            />
          ))}
        </div>
      </section>

      {/* Content Creation Tools */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
            Content Creation
          </Badge>
          <span className="text-sm text-muted-foreground">Generate professional content</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {contentTools.map((tool) => (
            <ToolCard
              key={tool.id}
              tool={tool}
              inputs={toolInputs[tool.id] || {}}
              onInputChange={(name, value) => updateToolInput(tool.id, name, value)}
              onRun={() => runTool(tool)}
              loading={loadingTools[tool.id] || false}
              result={toolResults[tool.id]}
              expanded={expandedResults[tool.id] || false}
              onToggleExpand={() =>
                setExpandedResults((prev) => ({ ...prev, [tool.id]: !prev[tool.id] }))
              }
              isFavorite={favorites.includes(tool.id)}
              onToggleFavorite={() => handleToggleFavorite(tool.id)}
              onCopy={() => copyToClipboard(toolResults[tool.id], tool.id)}
              copied={copiedId === tool.id}
            />
          ))}
        </div>
      </section>

      {/* Business Intelligence Tools */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
            Business Intelligence
          </Badge>
          <span className="text-sm text-muted-foreground">Analyze and optimize your business</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {intelligenceTools.map((tool) => (
            <ToolCard
              key={tool.id}
              tool={tool}
              inputs={toolInputs[tool.id] || {}}
              onInputChange={(name, value) => updateToolInput(tool.id, name, value)}
              onRun={() => runTool(tool)}
              loading={loadingTools[tool.id] || false}
              result={toolResults[tool.id]}
              expanded={expandedResults[tool.id] || false}
              onToggleExpand={() =>
                setExpandedResults((prev) => ({ ...prev, [tool.id]: !prev[tool.id] }))
              }
              isFavorite={favorites.includes(tool.id)}
              onToggleFavorite={() => handleToggleFavorite(tool.id)}
              onCopy={() => copyToClipboard(toolResults[tool.id], tool.id)}
              copied={copiedId === tool.id}
            />
          ))}
        </div>
      </section>

      {/* Footer Note */}
      <div className="text-center text-sm text-muted-foreground border-t pt-6">
        <p>
          All tools use your brand voice profile. Results can be used across any OS surface.{" "}
          <Link href="/dashboard/settings" className="text-primary hover:underline inline-flex items-center gap-1">
            <Settings className="h-3 w-3" />
            Update brand voice
          </Link>
        </p>
      </div>
    </div>
  )
}

// Tool Card Component
function ToolCard({
  tool,
  inputs,
  onInputChange,
  onRun,
  loading,
  result,
  expanded,
  onToggleExpand,
  isFavorite,
  onToggleFavorite,
  onCopy,
  copied,
}: {
  tool: (typeof TOOLS)[0]
  inputs: Record<string, string>
  onInputChange: (name: string, value: string) => void
  onRun: () => void
  loading: boolean
  result?: string
  expanded: boolean
  onToggleExpand: () => void
  isFavorite: boolean
  onToggleFavorite: () => void
  onCopy: () => void
  copied: boolean
}) {
  const IconComponent = tool.icon
  const isComplete = tool.inputs.every((input) => inputs[input.name])

  return (
    <Card id={`tool-${tool.id}`} className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className={`p-1.5 rounded-md ${tool.categoryColor}`}>
              <IconComponent className="h-4 w-4" />
            </div>
            <CardTitle className="text-base">{tool.name}</CardTitle>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={(e) => {
              e.stopPropagation()
              onToggleFavorite()
            }}
          >
            {isFavorite ? (
              <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
            ) : (
              <StarOff className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        </div>
        <CardDescription className="text-xs">{tool.description}</CardDescription>
      </CardHeader>

      <CardContent className="flex-1 space-y-3">
        {/* Inputs */}
        {tool.inputs.map((input) => (
          <div key={input.name} className="space-y-1">
            <Label className="text-xs">{input.label}</Label>
            {input.type === "textarea" ? (
              <Textarea
                value={inputs[input.name] || ""}
                onChange={(e) => onInputChange(input.name, e.target.value)}
                placeholder={input.placeholder}
                className="text-sm min-h-[60px]"
              />
            ) : input.type === "select" ? (
              <Select
                value={inputs[input.name] || ""}
                onValueChange={(value) => onInputChange(input.name, value)}
              >
                <SelectTrigger className="text-sm h-8">
                  <SelectValue placeholder="Select..." />
                </SelectTrigger>
                <SelectContent>
                  {(input as any).options?.map((option: string) => (
                    <SelectItem key={option} value={option}>
                      {option.charAt(0).toUpperCase() + option.slice(1).replace(/-/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={inputs[input.name] || ""}
                onChange={(e) => onInputChange(input.name, e.target.value)}
                placeholder={input.placeholder}
                className="text-sm h-8"
              />
            )}
          </div>
        ))}

        {/* Run Button */}
        <Button
          onClick={onRun}
          disabled={!isComplete || loading}
          className="w-full"
          size="sm"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Running...
            </>
          ) : (
            "Run Tool"
          )}
        </Button>

        {/* Result */}
        {result && (
          <Collapsible open={expanded} onOpenChange={onToggleExpand}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-full justify-between">
                <span className="text-xs font-medium">Result</span>
                <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 p-3 bg-muted rounded-md">
                <p className="text-sm whitespace-pre-wrap">{result}</p>
                <div className="flex justify-end mt-2">
                  <Button variant="outline" size="sm" onClick={onCopy}>
                    {copied ? (
                      <>
                        <Check className="h-3 w-3 mr-1" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3 mr-1" />
                        Copy
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  )
}
