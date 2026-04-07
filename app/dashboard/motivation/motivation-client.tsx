"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Trophy,
  Star,
  Zap,
  TrendingUp,
  TrendingDown,
  Award,
  Target,
  Users,
  Home,
  MessageSquare,
  Share2,
  BookOpen,
  FileText,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Loader2,
  CheckCircle,
  Lock,
} from "lucide-react"
import {
  getAgentBadges,
  getAgentPointsAndTier,
  checkAndAwardBadges,
  getLeaderboard,
  getLeaderboardWidget,
} from "@/app/actions/gamification"
import { toast } from "sonner"
import Link from "next/link"

interface MotivationClientProps {
  agentId: string
  brokerageId: string
  userId: string
}

const POINT_VALUES = {
  close_deal: 500,
  generate_referral: 200,
  complete_tour: 50,
  send_follow_up: 10,
  log_activity: 5,
}

const TIER_BENEFITS: Record<string, string[]> = {
  bronze: ["Access to basic reports", "Standard support", "Core features"],
  silver: ["Priority lead routing", "Advanced analytics", "Extended support hours"],
  gold: ["VIP lead routing", "Custom branding", "Dedicated success manager"],
  platinum: ["All features unlocked", "White-glove support", "Executive coaching access"],
}

const TIER_COLORS: Record<string, string> = {
  bronze: "bg-amber-600",
  silver: "bg-slate-400",
  gold: "bg-yellow-500",
  platinum: "bg-gradient-to-r from-purple-500 to-pink-500",
}

const TIER_THRESHOLDS = {
  bronze: 0,
  silver: 1000,
  gold: 5000,
  platinum: 15000,
}

function getTierFromPoints(points: number): string {
  if (points >= TIER_THRESHOLDS.platinum) return "platinum"
  if (points >= TIER_THRESHOLDS.gold) return "gold"
  if (points >= TIER_THRESHOLDS.silver) return "silver"
  return "bronze"
}

function getNextTierThreshold(currentTier: string): number {
  switch (currentTier) {
    case "bronze":
      return TIER_THRESHOLDS.silver
    case "silver":
      return TIER_THRESHOLDS.gold
    case "gold":
      return TIER_THRESHOLDS.platinum
    default:
      return TIER_THRESHOLDS.platinum
  }
}

const MOTIVATIONAL_MESSAGES: Record<string, string> = {
  bronze: "Building momentum — every action counts",
  silver: "You're in the top tier — keep pushing",
  gold: "Elite performer — you're setting the standard",
  platinum: "Legendary performance — you're the benchmark",
}

export function MotivationClient({ agentId, brokerageId, userId }: MotivationClientProps) {
  const [loading, setLoading] = useState(true)
  const [pointsData, setPointsData] = useState<{
    points: number
    tier: string
    pointsHistory?: any[]
  } | null>(null)
  const [badges, setBadges] = useState<any[]>([])
  const [leaderboard, setLeaderboard] = useState<any[]>([])
  const [widgetData, setWidgetData] = useState<any>(null)

  // Filter states
  const [selectedScope, setSelectedScope] = useState<"agent" | "team" | "brokerage">("brokerage")
  const [selectedMetric, setSelectedMetric] = useState<"points" | "revenue" | "transactions" | "referrals">("points")
  const [selectedPeriod, setSelectedPeriod] = useState<string>("This Month")
  const [badgeFilter, setBadgeFilter] = useState<"all" | "earned" | "in-progress">("all")
  const [showPointsInfo, setShowPointsInfo] = useState(false)
  const [leaderboardLoading, setLeaderboardLoading] = useState(false)

  useEffect(() => {
    loadData()
  }, [agentId])

  useEffect(() => {
    loadLeaderboard()
  }, [selectedScope, selectedMetric, selectedPeriod])

  async function loadData() {
    setLoading(true)
    try {
      const [pointsResult, badgesResult, leaderboardResult, widgetResult] = await Promise.all([
        getAgentPointsAndTier({ agentId }),
        getAgentBadges(agentId),
        getLeaderboard({
          scope: selectedScope,
          metricType: selectedMetric,
          periodLabel: selectedPeriod,
          limit: 10,
        }),
        getLeaderboardWidget({ agentId, brokerageId }),
      ])

      setPointsData(pointsResult)
      setBadges(badgesResult || [])
      setLeaderboard(leaderboardResult || [])
      setWidgetData(widgetResult)

      // Check for new badges
      if (pointsResult?.points) {
        const newBadges = await checkAndAwardBadges(agentId, pointsResult.points)
        if (newBadges && newBadges.length > 0) {
          newBadges.forEach((badge: any) => {
            toast.success(`New Badge Earned: ${badge.name}!`, {
              description: badge.description,
            })
          })
          // Reload badges
          const updatedBadges = await getAgentBadges(agentId)
          setBadges(updatedBadges || [])
        }
      }
    } catch (error) {
      console.error("Error loading motivation data:", error)
    } finally {
      setLoading(false)
    }
  }

  async function loadLeaderboard() {
    setLeaderboardLoading(true)
    try {
      const result = await getLeaderboard({
        scope: selectedScope,
        metricType: selectedMetric,
        periodLabel: selectedPeriod,
        limit: 10,
      })
      setLeaderboard(result || [])
    } catch (error) {
      console.error("Error loading leaderboard:", error)
    } finally {
      setLeaderboardLoading(false)
    }
  }

  const currentTier = pointsData?.tier || "bronze"
  const currentPoints = pointsData?.points || 0
  const nextTierThreshold = getNextTierThreshold(currentTier)
  const progressToNextTier =
    currentTier === "platinum" ? 100 : Math.min(100, (currentPoints / nextTierThreshold) * 100)

  // Filter badges
  const earnedBadges = badges.filter((b) => b.earned_at)
  const unearnedBadges = badges.filter((b) => !b.earned_at)
  const filteredBadges =
    badgeFilter === "all" ? badges : badgeFilter === "earned" ? earnedBadges : unearnedBadges

  // Find next badge to earn
  const nextBadge = unearnedBadges.sort((a, b) => (a.required_points || 0) - (b.required_points || 0))[0]
  const nextBadgeProgress = nextBadge
    ? Math.min(100, (currentPoints / (nextBadge.required_points || 1)) * 100)
    : 100

  if (loading) {
    return (
      <div className="container mx-auto p-6 flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Section A: Motivation Command Strip */}
      <div className="rounded-xl bg-gradient-to-r from-amber-600 to-orange-700 p-6 text-white">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div
              className={`w-16 h-16 rounded-full flex items-center justify-center ${TIER_COLORS[currentTier]} shadow-lg`}
            >
              <Trophy className="h-8 w-8 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-2xl font-bold capitalize">{currentTier}</span>
                <Badge variant="secondary" className="bg-white/20 text-white border-0">
                  Tier
                </Badge>
              </div>
              <p className="text-amber-100 mt-1">{MOTIVATIONAL_MESSAGES[currentTier]}</p>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2">
            <div className="text-3xl font-bold">{currentPoints.toLocaleString()} pts</div>
            {nextBadge && (
              <div className="w-64">
                <div className="flex justify-between text-sm text-amber-100 mb-1">
                  <span>Next Badge: {nextBadge.name}</span>
                  <span>{nextBadge.required_points?.toLocaleString()} pts</span>
                </div>
                <Progress value={nextBadgeProgress} className="h-2 bg-white/20" />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Section B: Tier Progress */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LEFT: Tier Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Award className="h-5 w-5" />
              Your Tier Status
            </CardTitle>
            <CardDescription>Progress toward your next achievement level</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Current Tier */}
            <div className="flex items-center gap-4">
              <div
                className={`w-12 h-12 rounded-full flex items-center justify-center ${TIER_COLORS[currentTier]}`}
              >
                <Star className="h-6 w-6 text-white" />
              </div>
              <div className="flex-1">
                <p className="font-semibold capitalize text-lg">{currentTier} Tier</p>
                <p className="text-sm text-muted-foreground">
                  {currentTier === "platinum"
                    ? "Maximum tier achieved!"
                    : `${(nextTierThreshold - currentPoints).toLocaleString()} pts to next tier`}
                </p>
              </div>
            </div>

            {/* Progress Bar */}
            {currentTier !== "platinum" && (
              <div>
                <div className="flex justify-between text-sm mb-2">
                  <span className="capitalize">{currentTier}</span>
                  <span className="capitalize">
                    {currentTier === "gold"
                      ? "Platinum"
                      : currentTier === "silver"
                        ? "Gold"
                        : "Silver"}
                  </span>
                </div>
                <Progress value={progressToNextTier} className="h-3" />
                <p className="text-sm text-muted-foreground mt-1 text-center">
                  {currentPoints.toLocaleString()} / {nextTierThreshold.toLocaleString()} pts
                </p>
              </div>
            )}

            {/* Tier Benefits */}
            <div className="space-y-2">
              <p className="font-medium">Your Benefits:</p>
              <ul className="space-y-1">
                {TIER_BENEFITS[currentTier]?.map((benefit, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm">
                    <CheckCircle className="h-4 w-4 text-green-500" />
                    {benefit}
                  </li>
                ))}
              </ul>
            </div>

            {/* How to Earn Points */}
            <div>
              <Button
                variant="ghost"
                className="w-full justify-between"
                onClick={() => setShowPointsInfo(!showPointsInfo)}
              >
                <span>How to Earn Points</span>
                {showPointsInfo ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </Button>
              {showPointsInfo && (
                <div className="mt-2 space-y-2 p-3 bg-muted rounded-lg">
                  {Object.entries(POINT_VALUES).map(([action, points]) => (
                    <div key={action} className="flex justify-between text-sm">
                      <span className="capitalize">{action.replace(/_/g, " ")}</span>
                      <Badge variant="secondary">{points} pts</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* RIGHT: Recent Activity */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Recent Activity
            </CardTitle>
            <CardDescription>Your latest achievements and point earnings</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Recent Badges */}
            <div>
              <p className="font-medium mb-2">Recent Badges</p>
              {earnedBadges.length > 0 ? (
                <div className="flex gap-2 flex-wrap">
                  {earnedBadges.slice(0, 3).map((badge) => (
                    <div
                      key={badge.id}
                      className="flex items-center gap-2 p-2 bg-amber-50 dark:bg-amber-950 rounded-lg border border-amber-200 dark:border-amber-800"
                    >
                      <Trophy className="h-4 w-4 text-amber-600" />
                      <span className="text-sm font-medium">{badge.name}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No badges earned yet. Keep going!</p>
              )}
            </div>

            {/* Points History */}
            <div>
              <p className="font-medium mb-2">Points History</p>
              {pointsData?.pointsHistory && pointsData.pointsHistory.length > 0 ? (
                <div className="space-y-2">
                  {pointsData.pointsHistory.slice(0, 5).map((entry: any, i: number) => (
                    <div
                      key={i}
                      className="flex justify-between items-center p-2 bg-muted/50 rounded"
                    >
                      <div className="flex items-center gap-2">
                        <Zap className="h-4 w-4 text-primary" />
                        <span className="text-sm capitalize">
                          {entry.action?.replace(/_/g, " ") || "Activity"}
                        </span>
                      </div>
                      <Badge variant="outline">+{entry.points || 0} pts</Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Complete actions to start earning points!
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Section C: Badges Showcase */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Trophy className="h-5 w-5" />
                Badges Showcase
              </CardTitle>
              <CardDescription>
                {earnedBadges.length} earned / {badges.length} total
              </CardDescription>
            </div>
            <Tabs
              value={badgeFilter}
              onValueChange={(v) => setBadgeFilter(v as typeof badgeFilter)}
            >
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="earned">Earned</TabsTrigger>
                <TabsTrigger value="in-progress">In Progress</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent>
          {filteredBadges.length > 0 ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {filteredBadges.map((badge) => {
                const isEarned = !!badge.earned_at
                const progress = isEarned
                  ? 100
                  : Math.min(100, (currentPoints / (badge.required_points || 1)) * 100)

                return (
                  <div
                    key={badge.id}
                    className={`p-4 rounded-lg border ${
                      isEarned
                        ? "bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800"
                        : "bg-muted/30 border-muted grayscale"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      {isEarned ? (
                        <Trophy className="h-6 w-6 text-amber-600" />
                      ) : (
                        <Lock className="h-6 w-6 text-muted-foreground" />
                      )}
                      <span className="font-medium">{badge.name}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mb-2">
                      {badge.description || "Complete actions to earn this badge"}
                    </p>
                    {isEarned ? (
                      <p className="text-xs text-amber-600">
                        Earned {new Date(badge.earned_at).toLocaleDateString()}
                      </p>
                    ) : (
                      <div>
                        <Progress value={progress} className="h-1.5 mb-1" />
                        <p className="text-xs text-muted-foreground">
                          {badge.required_points?.toLocaleString()} pts required
                        </p>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-center text-muted-foreground py-8">
              No badges to display with current filter.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Section D: Leaderboard */}
      <Card>
        <CardHeader>
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                Leaderboard
              </CardTitle>
              <CardDescription>See how you stack up against your peers</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Select value={selectedScope} onValueChange={(v) => setSelectedScope(v as any)}>
                <SelectTrigger className="w-[130px]">
                  <SelectValue placeholder="Scope" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="agent">My Stats</SelectItem>
                  <SelectItem value="team">Team</SelectItem>
                  <SelectItem value="brokerage">Brokerage</SelectItem>
                </SelectContent>
              </Select>
              <Select value={selectedMetric} onValueChange={(v) => setSelectedMetric(v as any)}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Metric" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="points">Points</SelectItem>
                  <SelectItem value="revenue">Revenue</SelectItem>
                  <SelectItem value="transactions">Transactions</SelectItem>
                  <SelectItem value="referrals">Referrals</SelectItem>
                </SelectContent>
              </Select>
              <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Period" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="This Month">This Month</SelectItem>
                  <SelectItem value="This Quarter">This Quarter</SelectItem>
                  <SelectItem value="This Year">This Year</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {leaderboardLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : leaderboard.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[80px]">Rank</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead className="text-right w-[100px]">Change</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leaderboard.map((entry, index) => {
                  const isCurrentAgent = entry.agent_id === agentId
                  return (
                    <TableRow
                      key={entry.agent_id || index}
                      className={isCurrentAgent ? "bg-primary/10" : ""}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {index === 0 && <Trophy className="h-4 w-4 text-yellow-500" />}
                          {index === 1 && <Trophy className="h-4 w-4 text-slate-400" />}
                          {index === 2 && <Trophy className="h-4 w-4 text-amber-700" />}
                          <span className="font-medium">#{index + 1}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className={isCurrentAgent ? "font-bold" : ""}>
                            {entry.agent_name || "Agent"}
                          </span>
                          {isCurrentAgent && (
                            <Badge variant="secondary" className="text-xs">
                              You
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {typeof entry.score === "number"
                          ? selectedMetric === "revenue"
                            ? `$${entry.score.toLocaleString()}`
                            : entry.score.toLocaleString()
                          : "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {entry.change !== undefined && entry.change !== 0 ? (
                          <div
                            className={`flex items-center justify-end gap-1 ${
                              entry.change > 0 ? "text-green-600" : "text-red-600"
                            }`}
                          >
                            {entry.change > 0 ? (
                              <TrendingUp className="h-4 w-4" />
                            ) : (
                              <TrendingDown className="h-4 w-4" />
                            )}
                            <span>{Math.abs(entry.change)}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          ) : (
            <p className="text-center text-muted-foreground py-8">
              No leaderboard data available for the selected filters.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Section E: Behavior Reinforcement */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" />
            Actions That Move You Forward
          </CardTitle>
          <CardDescription>Complete these actions to earn points and grow your business</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <Link href="/dashboard/buyers">
              <div className="p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors cursor-pointer text-center">
                <Home className="h-8 w-8 mx-auto mb-2 text-primary" />
                <p className="font-medium text-sm">Complete a Showing</p>
                <Badge variant="outline" className="mt-2">
                  +50 pts
                </Badge>
              </div>
            </Link>
            <Link href="/dashboard/communications/inbox">
              <div className="p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors cursor-pointer text-center">
                <MessageSquare className="h-8 w-8 mx-auto mb-2 text-primary" />
                <p className="font-medium text-sm">Send a Follow-up</p>
                <Badge variant="outline" className="mt-2">
                  +10 pts
                </Badge>
              </div>
            </Link>
            <Link href="/referrals">
              <div className="p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors cursor-pointer text-center">
                <Share2 className="h-8 w-8 mx-auto mb-2 text-primary" />
                <p className="font-medium text-sm">Ask for a Referral</p>
                <Badge variant="outline" className="mt-2">
                  +200 pts
                </Badge>
              </div>
            </Link>
            <Link href="/academy">
              <div className="p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors cursor-pointer text-center">
                <BookOpen className="h-8 w-8 mx-auto mb-2 text-primary" />
                <p className="font-medium text-sm">Complete a Training</p>
                <Badge variant="outline" className="mt-2">
                  +25 pts
                </Badge>
              </div>
            </Link>
            <Link href="/dashboard/transactions">
              <div className="p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors cursor-pointer text-center">
                <FileText className="h-8 w-8 mx-auto mb-2 text-primary" />
                <p className="font-medium text-sm">Close a Deal</p>
                <Badge variant="outline" className="mt-2">
                  +500 pts
                </Badge>
              </div>
            </Link>
            <Link href="/dashboard/social">
              <div className="p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors cursor-pointer text-center">
                <Sparkles className="h-8 w-8 mx-auto mb-2 text-primary" />
                <p className="font-medium text-sm">Post Social Content</p>
                <Badge variant="outline" className="mt-2">
                  +15 pts
                </Badge>
              </div>
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Section F: Challenge Panel */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" />
            Weekly Challenges
          </CardTitle>
          <CardDescription>Complete these challenges to boost your performance</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-3 gap-4">
            <div className="p-4 rounded-lg border bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950 dark:to-indigo-950">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium">Send 5 Follow-ups</span>
                <Badge className="bg-blue-600">50 pts</Badge>
              </div>
              <Progress value={40} className="h-2 mb-2" />
              <p className="text-sm text-muted-foreground mb-3">2 of 5 completed</p>
              <Link href="/dashboard/communications/inbox">
                <Button size="sm" className="w-full">
                  Start Challenge
                </Button>
              </Link>
            </div>

            <div className="p-4 rounded-lg border bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-950 dark:to-emerald-950">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium">Complete 2 Tours</span>
                <Badge className="bg-green-600">100 pts</Badge>
              </div>
              <Progress value={50} className="h-2 mb-2" />
              <p className="text-sm text-muted-foreground mb-3">1 of 2 completed</p>
              <Link href="/dashboard/buyers">
                <Button size="sm" className="w-full">
                  Start Challenge
                </Button>
              </Link>
            </div>

            <div className="p-4 rounded-lg border bg-gradient-to-br from-purple-50 to-pink-50 dark:from-purple-950 dark:to-pink-950">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium">Post 3 Social Items</span>
                <Badge className="bg-purple-600">45 pts</Badge>
              </div>
              <Progress value={33} className="h-2 mb-2" />
              <p className="text-sm text-muted-foreground mb-3">1 of 3 completed</p>
              <Link href="/dashboard/social">
                <Button size="sm" className="w-full">
                  Start Challenge
                </Button>
              </Link>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
