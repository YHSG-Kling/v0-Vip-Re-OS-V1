"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import {
  Lightbulb,
  TrendingDown,
  AlertTriangle,
  UserMinus,
  Target,
  Clock,
  ThumbsUp,
  ThumbsDown,
  X,
  Check,
  ChevronRight,
  Brain,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from "recharts"
import {
  getActivePatterns,
  updatePatternStatus,
  recordOutcome,
  getPatternDetails,
  type PatternDetectionWithDetails,
  type PatternAccuracyStats,
} from "@/app/actions/pattern-actions"

interface PatternsDashboardClientProps {
  initialPatterns: PatternDetectionWithDetails[]
  initialAccuracyStats: PatternAccuracyStats
  brokerageId: string
}

const PATTERN_ICONS: Record<string, typeof Lightbulb> = {
  offer_imminent: Lightbulb,
  price_reduction_likely: TrendingDown,
  disengagement_risk: UserMinus,
  contentious_negotiation: AlertTriangle,
  high_motivation: Target,
  deal_collapse_risk: AlertTriangle,
  competitor_threat: AlertTriangle,
  financing_risk: AlertTriangle,
}

const PATTERN_COLORS: Record<string, string> = {
  offer_imminent: "bg-emerald-100 text-emerald-800 border-emerald-200",
  price_reduction_likely: "bg-amber-100 text-amber-800 border-amber-200",
  disengagement_risk: "bg-slate-100 text-slate-800 border-slate-200",
  contentious_negotiation: "bg-orange-100 text-orange-800 border-orange-200",
  high_motivation: "bg-emerald-100 text-emerald-800 border-emerald-200",
  deal_collapse_risk: "bg-red-100 text-red-800 border-red-200",
  competitor_threat: "bg-purple-100 text-purple-800 border-purple-200",
  financing_risk: "bg-red-100 text-red-800 border-red-200",
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  return `${diffDays}d ago`
}

export function PatternsDashboardClient({
  initialPatterns,
  initialAccuracyStats,
}: PatternsDashboardClientProps) {
  const [patterns, setPatterns] = useState(initialPatterns)
  const [accuracyStats, setAccuracyStats] = useState(initialAccuracyStats)
  const [activeTab, setActiveTab] = useState("all")
  const [selectedPattern, setSelectedPattern] =
    useState<PatternDetectionWithDetails | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  const refreshPatterns = async (filter: string) => {
    startTransition(async () => {
      const filterType = filter as
        | "all"
        | "buyer"
        | "seller"
        | "negotiation"
        | "high_priority"
      const newPatterns = await getActivePatterns(filterType)
      setPatterns(newPatterns)
    })
  }

  const handleTabChange = (value: string) => {
    setActiveTab(value)
    refreshPatterns(value)
  }

  const handleAcknowledge = async (detectionId: string) => {
    startTransition(async () => {
      await updatePatternStatus(detectionId, "acknowledged")
      setPatterns((prev) => prev.filter((p) => p.id !== detectionId))
    })
  }

  const handleDismiss = async (detectionId: string) => {
    startTransition(async () => {
      await updatePatternStatus(detectionId, "dismissed")
      setPatterns((prev) => prev.filter((p) => p.id !== detectionId))
    })
  }

  const handleTakeAction = async (pattern: PatternDetectionWithDetails) => {
    const details = await getPatternDetails(pattern.id)
    if (details) {
      setSelectedPattern(details)
      setSheetOpen(true)
    }
  }

  const handleRecordOutcome = async (
    predictionId: string,
    outcome: "correct" | "incorrect"
  ) => {
    startTransition(async () => {
      await recordOutcome(predictionId, outcome)
      // Update local state
      setPatterns((prev) =>
        prev.map((p) =>
          p.prediction_id === predictionId ? { ...p, outcome } : p
        )
      )
      if (selectedPattern?.prediction_id === predictionId) {
        setSelectedPattern((prev) => (prev ? { ...prev, outcome } : null))
      }
      // Refresh accuracy stats
      const newStats = await import("@/app/actions/pattern-actions").then(
        (m) => m.getPatternAccuracyStats()
      )
      setAccuracyStats(newStats)
    })
  }

  const accuracyChartData = [
    { name: "Correct", value: accuracyStats.correct, color: "#10b981" },
    { name: "Incorrect", value: accuracyStats.incorrect, color: "#ef4444" },
    { name: "Pending", value: accuracyStats.pending, color: "#94a3b8" },
  ].filter((d) => d.value > 0)

  const getPatternIcon = (patternType: string) => {
    const Icon = PATTERN_ICONS[patternType] || Brain
    return Icon
  }

  const getPatternColor = (patternType: string) => {
    return PATTERN_COLORS[patternType] || "bg-slate-100 text-slate-800 border-slate-200"
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card">
        <div className="container mx-auto px-4 py-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Brain className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">
                Behavioral Intelligence
              </h1>
              <p className="text-sm text-muted-foreground">
                AI-detected patterns across your pipeline
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-6">
        <div className="grid gap-6 lg:grid-cols-4">
          {/* Main content - patterns list */}
          <div className="lg:col-span-3">
            <Tabs value={activeTab} onValueChange={handleTabChange}>
              <TabsList className="mb-4">
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="buyer">Buyer Patterns</TabsTrigger>
                <TabsTrigger value="seller">Seller Patterns</TabsTrigger>
                <TabsTrigger value="negotiation">Negotiation</TabsTrigger>
                <TabsTrigger value="high_priority">High Priority</TabsTrigger>
              </TabsList>

              <TabsContent value={activeTab} className="space-y-4">
                {patterns.length === 0 ? (
                  <Card>
                    <CardContent className="py-12 text-center">
                      <Brain className="mx-auto h-12 w-12 text-muted-foreground/50" />
                      <p className="mt-4 text-muted-foreground">
                        No active patterns detected
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Patterns are scanned every 4 hours
                      </p>
                    </CardContent>
                  </Card>
                ) : (
                  patterns.map((pattern) => {
                    const Icon = getPatternIcon(pattern.pattern_type)
                    const colorClass = getPatternColor(pattern.pattern_type)

                    return (
                      <Card key={pattern.id} className="overflow-hidden">
                        <CardContent className="p-4">
                          <div className="flex items-start gap-4">
                            {/* Icon */}
                            <div
                              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${colorClass}`}
                            >
                              <Icon className="h-5 w-5" />
                            </div>

                            {/* Content */}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <h3 className="font-semibold text-foreground">
                                  {pattern.pattern_name}
                                </h3>
                                <Badge variant="secondary" className="text-xs">
                                  {Math.round(pattern.confidence * 100)}%
                                  confidence
                                </Badge>
                              </div>

                              <Link
                                href={
                                  pattern.entity_type === "contact"
                                    ? `/dashboard/contacts/${pattern.entity_id}`
                                    : `/dashboard/listings/${pattern.entity_id}`
                                }
                                className="text-sm text-primary hover:underline"
                              >
                                {pattern.entity_name}
                              </Link>

                              {pattern.predicted_event && (
                                <p className="mt-1 text-sm text-muted-foreground">
                                  {pattern.prediction_label} within{" "}
                                  {pattern.predicted_within_days} days
                                </p>
                              )}

                              <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                                <Clock className="h-3 w-3" />
                                <span>
                                  Detected {formatRelativeTime(pattern.created_at)}
                                </span>
                              </div>
                            </div>

                            {/* Actions */}
                            <div className="flex shrink-0 items-center gap-2">
                              <Button
                                size="sm"
                                onClick={() => handleTakeAction(pattern)}
                              >
                                Take Action
                                <ChevronRight className="ml-1 h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleAcknowledge(pattern.id)}
                                disabled={isPending}
                              >
                                <Check className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleDismiss(pattern.id)}
                                disabled={isPending}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    )
                  })
                )}
              </TabsContent>
            </Tabs>
          </div>

          {/* Sidebar - accuracy stats */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Prediction Accuracy</CardTitle>
              </CardHeader>
              <CardContent>
                {accuracyChartData.length > 0 ? (
                  <>
                    <div className="h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={accuracyChartData}
                            cx="50%"
                            cy="50%"
                            innerRadius={50}
                            outerRadius={70}
                            paddingAngle={2}
                            dataKey="value"
                          >
                            {accuracyChartData.map((entry, index) => (
                              <Cell key={index} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="mt-4 space-y-2 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2">
                          <span className="h-3 w-3 rounded-full bg-emerald-500" />
                          Correct
                        </span>
                        <span className="font-medium">
                          {accuracyStats.correct}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2">
                          <span className="h-3 w-3 rounded-full bg-red-500" />
                          Incorrect
                        </span>
                        <span className="font-medium">
                          {accuracyStats.incorrect}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2">
                          <span className="h-3 w-3 rounded-full bg-slate-400" />
                          Pending
                        </span>
                        <span className="font-medium">
                          {accuracyStats.pending}
                        </span>
                      </div>
                      <div className="border-t pt-2">
                        <div className="flex items-center justify-between font-medium">
                          <span>Accuracy Rate</span>
                          <span className="text-primary">
                            {accuracyStats.accuracy_rate.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No prediction outcomes recorded yet
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Active Counts</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span>Total Active</span>
                  <Badge variant="secondary">{patterns.length}</Badge>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span>High Confidence</span>
                  <Badge variant="secondary">
                    {patterns.filter((p) => p.confidence >= 0.75).length}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* Action Sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="w-[500px] sm:max-w-[500px]">
          {selectedPattern && (
            <>
              <SheetHeader>
                <SheetTitle>{selectedPattern.pattern_name}</SheetTitle>
                <SheetDescription>{selectedPattern.entity_name}</SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-6">
                {/* AI Reasoning */}
                {selectedPattern.ai_reasoning && (
                  <div>
                    <h4 className="mb-2 text-sm font-medium">AI Analysis</h4>
                    <p className="text-sm text-muted-foreground">
                      {selectedPattern.ai_reasoning}
                    </p>
                  </div>
                )}

                {/* Trigger Signals */}
                <div>
                  <h4 className="mb-2 text-sm font-medium">Trigger Signals</h4>
                  <div className="space-y-1">
                    {Object.entries(selectedPattern.trigger_signals || {}).map(
                      ([key, value]) => (
                        <div
                          key={key}
                          className="flex items-center justify-between text-sm"
                        >
                          <span className="text-muted-foreground">
                            {key.replace(/_/g, " ")}
                          </span>
                          <span className="font-mono">{String(value)}</span>
                        </div>
                      )
                    )}
                  </div>
                </div>

                {/* Recommended Action */}
                <div>
                  <h4 className="mb-2 text-sm font-medium">Recommended Action</h4>
                  <p className="text-sm text-muted-foreground">
                    {selectedPattern.recommended_action}
                  </p>
                </div>

                {/* Quick Actions */}
                <div className="flex gap-2">
                  <Button asChild className="flex-1">
                    <Link
                      href={
                        selectedPattern.entity_type === "contact"
                          ? `/dashboard/contacts/${selectedPattern.entity_id}`
                          : `/dashboard/listings/${selectedPattern.entity_id}`
                      }
                    >
                      View {selectedPattern.entity_type === "contact" ? "Contact" : "Listing"}
                    </Link>
                  </Button>
                  <Button variant="outline" className="flex-1">
                    Schedule Task
                  </Button>
                </div>

                {/* Outcome Recording */}
                {selectedPattern.prediction_id && (
                  <div className="border-t pt-4">
                    <h4 className="mb-3 text-sm font-medium">
                      Did this prediction come true?
                    </h4>
                    {selectedPattern.outcome ? (
                      <Badge
                        variant={
                          selectedPattern.outcome === "correct"
                            ? "default"
                            : "destructive"
                        }
                      >
                        Recorded as{" "}
                        {selectedPattern.outcome === "correct"
                          ? "Correct"
                          : "Incorrect"}
                      </Badge>
                    ) : (
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          className="flex-1"
                          onClick={() =>
                            handleRecordOutcome(
                              selectedPattern.prediction_id!,
                              "correct"
                            )
                          }
                          disabled={isPending}
                        >
                          <ThumbsUp className="mr-2 h-4 w-4" />
                          Yes, Correct
                        </Button>
                        <Button
                          variant="outline"
                          className="flex-1"
                          onClick={() =>
                            handleRecordOutcome(
                              selectedPattern.prediction_id!,
                              "incorrect"
                            )
                          }
                          disabled={isPending}
                        >
                          <ThumbsDown className="mr-2 h-4 w-4" />
                          No, Incorrect
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
