"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import {
  Trophy,
  AlertTriangle,
  Target,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Lightbulb,
  ChevronRight,
  Users,
  Home,
  Clock,
  Loader2,
} from "lucide-react"
import { toast } from "sonner"
import {
  CoachingCommandStrip,
  ConversionCoachingPanel,
  ResponseQualityPanel,
  CallReviewPanel,
  HandoffCoachingPanel,
  AppointmentCoachingPanel,
  WeeklyImprovementPanel,
} from "./components/os"
import { generateWeeklyCoachingReport } from "@/lib/intelligence/coaching-engine"
import { createClient } from "@/lib/supabase/client"

interface WeeklyReport {
  id: string
  overall_score: number
  headline: string
  wins: string[]
  gaps: string[]
  top_recommendation: string
  recommended_actions: string[]
  deal_focus: string
  created_at: string
}

interface BuyerCoachingItem {
  contact: {
    id: string
    first_name: string
    last_name: string
    buyer_stage: string
    contact_persona: string | null
  }
  coaching: {
    coaching_headline: string
    suggested_talking_points: string[]
    common_objections: { objection: string; response: string }[]
    next_action_prompt: string
    success_signals: string[]
    risk_signals: string[]
  }
}

interface SellerCoachingItem {
  listing: {
    id: string
    property_address: string
    lifecycle_stage: string
    seller_persona: string | null
  }
  coaching: {
    coaching_headline: string
    suggested_talking_points: string[]
    common_objections: { objection: string; response: string }[]
    next_action_prompt: string
    success_signals: string[]
    risk_signals: string[]
  }
}

interface Intervention {
  id: string
  severity: "critical" | "high" | "medium" | "low"
  issue_detected: string
  ai_recommendation: string
  created_at: string
}

interface Suggestion {
  id: string
  title: string
  description: string
  priority: number
  status: string
}

interface CoachingDashboardClientProps {
  agentId: string
  brokerageId: string
  userId: string
  weeklyReport: WeeklyReport | null
  buyerCoaching: BuyerCoachingItem[]
  sellerCoaching: SellerCoachingItem[]
  interventions: Intervention[]
  suggestions: Suggestion[]
}

// Score dial SVG component
function ScoreDial({ score }: { score: number }) {
  const radius = 60
  const circumference = 2 * Math.PI * radius
  const progress = (score / 100) * circumference
  const color =
    score >= 80 ? "#22c55e" : score >= 60 ? "#f59e0b" : score >= 40 ? "#f97316" : "#ef4444"

  return (
    <div className="relative mx-auto h-36 w-36">
      <svg className="h-full w-full -rotate-90" viewBox="0 0 140 140">
        {/* Background circle */}
        <circle
          cx="70"
          cy="70"
          r={radius}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth="12"
        />
        {/* Progress circle */}
        <circle
          cx="70"
          cy="70"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - progress}
          className="transition-all duration-1000"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold text-foreground">{score}</span>
        <span className="text-xs text-muted-foreground">Score</span>
      </div>
    </div>
  )
}

// Stage coaching card component
function StageCoachingCard({
  name,
  stage,
  coaching,
  type,
}: {
  name: string
  stage: string
  coaching: BuyerCoachingItem["coaching"] | SellerCoachingItem["coaching"]
  type: "buyer" | "seller"
}) {
  const stageBadgeColor =
    type === "buyer" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"

  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-medium">{name}</CardTitle>
          <Badge className={stageBadgeColor}>{stage.replace(/_/g, " ")}</Badge>
        </div>
        <CardDescription>{coaching.coaching_headline}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Talking Points */}
        <div>
          <h4 className="mb-2 text-sm font-medium text-foreground">Talking Points</h4>
          <ul className="space-y-1">
            {coaching.suggested_talking_points.map((point, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                <ChevronRight className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
                {point}
              </li>
            ))}
          </ul>
        </div>

        {/* Objections Accordion */}
        {coaching.common_objections.length > 0 && (
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="objections" className="border-none">
              <AccordionTrigger className="py-2 text-sm font-medium">
                Common Objections ({coaching.common_objections.length})
              </AccordionTrigger>
              <AccordionContent>
                <div className="space-y-3">
                  {coaching.common_objections.map((obj, i) => (
                    <div key={i} className="rounded-lg bg-muted/50 p-3">
                      <p className="text-sm font-medium text-foreground">"{obj.objection}"</p>
                      <p className="mt-1 text-sm text-muted-foreground">{obj.response}</p>
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}

        {/* Success / Risk Signals */}
        <div className="flex gap-4">
          {coaching.success_signals.length > 0 && (
            <div className="flex-1">
              <h4 className="mb-1 text-xs font-medium text-green-600">Success Signals</h4>
              <ul className="space-y-1">
                {coaching.success_signals.slice(0, 2).map((signal, i) => (
                  <li key={i} className="text-xs text-green-600">
                    {signal}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {coaching.risk_signals.length > 0 && (
            <div className="flex-1">
              <h4 className="mb-1 text-xs font-medium text-red-600">Risk Signals</h4>
              <ul className="space-y-1">
                {coaching.risk_signals.slice(0, 2).map((signal, i) => (
                  <li key={i} className="text-xs text-red-600">
                    {signal}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Next Action CTA */}
        <Button variant="outline" size="sm" className="w-full">
          {coaching.next_action_prompt}
        </Button>
      </CardContent>
    </Card>
  )
}

// Severity badge colors
const severityColors: Record<string, string> = {
  critical: "bg-red-100 text-red-700 border-red-200",
  high: "bg-orange-100 text-orange-700 border-orange-200",
  medium: "bg-amber-100 text-amber-700 border-amber-200",
  low: "bg-blue-100 text-blue-700 border-blue-200",
}

export function CoachingDashboardClient({
  agentId,
  brokerageId,
  userId,
  weeklyReport,
  buyerCoaching,
  sellerCoaching,
  interventions,
  suggestions,
}: CoachingDashboardClientProps) {
  const router = useRouter()
  const [isGenerating, setIsGenerating] = useState(false)
  const [localInterventions, setLocalInterventions] = useState(interventions)
  const [localSuggestions, setLocalSuggestions] = useState(suggestions)
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [executingId, setExecutingId] = useState<string | null>(null)

  const handleGenerateReport = async () => {
    setIsGenerating(true)
    try {
      await generateWeeklyCoachingReport(agentId, brokerageId)
      toast.success("New coaching report generated")
      router.refresh()
    } catch (error) {
      toast.error("Failed to generate report")
    } finally {
      setIsGenerating(false)
    }
  }

  const handleResolveIntervention = async (id: string) => {
    setResolvingId(id)
    try {
      const supabase = createClient()
      await supabase
        .from("proactive_interventions")
        .update({
          resolved: true,
          resolved_at: new Date().toISOString(),
          resolved_by: userId,
        })
        .eq("id", id)

      setLocalInterventions((prev) => prev.filter((i) => i.id !== id))
      toast.success("Intervention resolved")
    } catch (error) {
      toast.error("Failed to resolve intervention")
    } finally {
      setResolvingId(null)
    }
  }

  const handleSuggestionAction = async (id: string, action: "executed" | "ignored") => {
    setExecutingId(id)
    try {
      const supabase = createClient()
      await supabase.from("smart_assistant_suggestions").update({ status: action }).eq("id", id)

      setLocalSuggestions((prev) => prev.filter((s) => s.id !== id))
      toast.success(action === "executed" ? "Action executed" : "Suggestion dismissed")
    } catch (error) {
      toast.error("Failed to update suggestion")
    } finally {
      setExecutingId(null)
    }
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Strategic Coaching</h1>
        <p className="text-muted-foreground">
          AI-powered insights and playbooks to improve your performance
        </p>
      </div>

      {/* OS Command Strip */}
      <div className="mb-6">
        <CoachingCommandStrip agentId={agentId} brokerageId={brokerageId} />
      </div>

      {/* OS Panels Grid */}
      <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <ConversionCoachingPanel agentId={agentId} brokerageId={brokerageId} />
        <ResponseQualityPanel agentId={agentId} brokerageId={brokerageId} />
        <CallReviewPanel agentId={agentId} brokerageId={brokerageId} />
      </div>

      {/* Second Row of OS Panels */}
      <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <HandoffCoachingPanel agentId={agentId} brokerageId={brokerageId} />
        <AppointmentCoachingPanel agentId={agentId} brokerageId={brokerageId} />
        <WeeklyImprovementPanel agentId={agentId} brokerageId={brokerageId} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
        {/* LEFT — Weekly Report Card (1/4 width) */}
        <div className="lg:col-span-1">
          <Card className="sticky top-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Trophy className="h-5 w-5 text-amber-500" />
                Weekly Report
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {weeklyReport ? (
                <>
                  <ScoreDial score={weeklyReport.overall_score} />
                  <p className="text-center text-sm font-medium text-foreground">
                    {weeklyReport.headline}
                  </p>

                  {/* Wins */}
                  <div>
                    <h4 className="mb-2 flex items-center gap-1 text-sm font-medium text-green-600">
                      <CheckCircle2 className="h-4 w-4" />
                      This Week's Wins
                    </h4>
                    <ul className="space-y-1">
                      {weeklyReport.wins.map((win, i) => (
                        <li key={i} className="text-sm text-muted-foreground">
                          • {win}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Gaps */}
                  <div>
                    <h4 className="mb-2 flex items-center gap-1 text-sm font-medium text-amber-600">
                      <AlertTriangle className="h-4 w-4" />
                      Areas to Improve
                    </h4>
                    <ul className="space-y-1">
                      {weeklyReport.gaps.map((gap, i) => (
                        <li key={i} className="text-sm text-muted-foreground">
                          • {gap}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Top Recommendation */}
                  <div className="rounded-lg bg-primary/10 p-3">
                    <h4 className="mb-1 flex items-center gap-1 text-sm font-medium text-primary">
                      <Target className="h-4 w-4" />
                      Top Recommendation
                    </h4>
                    <p className="text-sm text-foreground">{weeklyReport.top_recommendation}</p>
                  </div>

                  {/* Deal Focus */}
                  <div className="text-sm text-muted-foreground">
                    <span className="font-medium">Deal Focus:</span> {weeklyReport.deal_focus}
                  </div>

                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(weeklyReport.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </>
              ) : (
                <div className="py-8 text-center">
                  <p className="mb-4 text-sm text-muted-foreground">No report generated yet</p>
                </div>
              )}

              <Button
                onClick={handleGenerateReport}
                disabled={isGenerating}
                className="w-full"
                variant="outline"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Generate New Report
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* CENTER — Stage Playbooks (2/4 width) */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Stage Playbooks</CardTitle>
              <CardDescription>
                AI coaching tailored to each client's journey stage
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="buyers">
                <TabsList className="mb-4 w-full">
                  <TabsTrigger value="buyers" className="flex-1">
                    <Users className="mr-2 h-4 w-4" />
                    Buyers ({buyerCoaching.length})
                  </TabsTrigger>
                  <TabsTrigger value="sellers" className="flex-1">
                    <Home className="mr-2 h-4 w-4" />
                    Sellers ({sellerCoaching.length})
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="buyers" className="max-h-[600px] overflow-y-auto">
                  {buyerCoaching.length === 0 ? (
                    <div className="py-12 text-center">
                      <Users className="mx-auto mb-4 h-12 w-12 text-muted-foreground/50" />
                      <p className="text-muted-foreground">No active buyers in pipeline</p>
                    </div>
                  ) : (
                    buyerCoaching.map((item) => (
                      <StageCoachingCard
                        key={item.contact.id}
                        name={`${item.contact.first_name} ${item.contact.last_name}`}
                        stage={item.contact.buyer_stage}
                        coaching={item.coaching}
                        type="buyer"
                      />
                    ))
                  )}
                </TabsContent>

                <TabsContent value="sellers" className="max-h-[600px] overflow-y-auto">
                  {sellerCoaching.length === 0 ? (
                    <div className="py-12 text-center">
                      <Home className="mx-auto mb-4 h-12 w-12 text-muted-foreground/50" />
                      <p className="text-muted-foreground">No active sellers in pipeline</p>
                    </div>
                  ) : (
                    sellerCoaching.map((item) => (
                      <StageCoachingCard
                        key={item.listing.id}
                        name={item.listing.property_address}
                        stage={item.listing.lifecycle_stage || "pre_listing"}
                        coaching={item.coaching}
                        type="seller"
                      />
                    ))
                  )}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

        {/* RIGHT — Live Intelligence Feed (1/4 width) */}
        <div className="space-y-6 lg:col-span-1">
          {/* Proactive Interventions */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-5 w-5 text-orange-500" />
                Interventions ({localInterventions.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="max-h-[300px] space-y-3 overflow-y-auto">
              {localInterventions.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No active interventions
                </p>
              ) : (
                localInterventions.map((intervention) => (
                  <div
                    key={intervention.id}
                    className="rounded-lg border bg-card p-3"
                  >
                    <div className="mb-2 flex items-start justify-between">
                      <Badge
                        variant="outline"
                        className={severityColors[intervention.severity]}
                      >
                        {intervention.severity}
                      </Badge>
                    </div>
                    <p className="mb-1 text-sm font-medium text-foreground">
                      {intervention.issue_detected}
                    </p>
                    <p className="mb-3 text-xs text-muted-foreground">
                      {intervention.ai_recommendation}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      onClick={() => handleResolveIntervention(intervention.id)}
                      disabled={resolvingId === intervention.id}
                    >
                      {resolvingId === intervention.id ? (
                        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                      ) : (
                        <CheckCircle2 className="mr-2 h-3 w-3" />
                      )}
                      Mark Resolved
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Smart Suggestions */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Lightbulb className="h-5 w-5 text-yellow-500" />
                Suggestions ({localSuggestions.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="max-h-[300px] space-y-3 overflow-y-auto">
              {localSuggestions.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No pending suggestions
                </p>
              ) : (
                localSuggestions.map((suggestion) => (
                  <div
                    key={suggestion.id}
                    className="rounded-lg border bg-card p-3"
                  >
                    <div className="mb-2 flex items-start justify-between">
                      <p className="text-sm font-medium text-foreground">{suggestion.title}</p>
                      <Badge variant="secondary">P{suggestion.priority}</Badge>
                    </div>
                    <p className="mb-3 text-xs text-muted-foreground">{suggestion.description}</p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="default"
                        className="flex-1"
                        onClick={() => handleSuggestionAction(suggestion.id, "executed")}
                        disabled={executingId === suggestion.id}
                      >
                        {executingId === suggestion.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          "Execute"
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleSuggestionAction(suggestion.id, "ignored")}
                        disabled={executingId === suggestion.id}
                      >
                        <XCircle className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
