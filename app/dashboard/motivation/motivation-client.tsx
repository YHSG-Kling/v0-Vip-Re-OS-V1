"use client"

// app/dashboard/motivation/motivation-client.tsx
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE STANDINGS + GAMIFICATION SURFACE, and it is open to agents by design —
// there is no role gate on the page, and that is the point: an agent can see where
// they stand.
//
// Openness was never the problem. Everything on this page was inert, and every
// cause was a disagreement with the server:
//
//   · THE FILTERS SENT VALUES NOTHING HAD WRITTEN. Period was "This Month" /
//     "This Quarter" / "This Year" against a column storing "2026-08"; scope
//     offered "My Stats" (scope 'agent'), which is the row grain restated as a
//     filter. Both now come from lib/gamification/leaderboard-vocabulary.ts — the
//     module the POPULATOR writes from — so a filter that cannot be filled cannot
//     be offered. Revenue is gone: nothing wrote it, and a peer-visible board does
//     not carry money (#185, #57).
//   · THE RESULTS WERE READ AS THE WRONG SHAPE. getLeaderboard returns an object
//     and this component did `setLeaderboard(result || [])` then `leaderboard.length`,
//     which is undefined on an object — so the table said "No leaderboard data" even
//     with rows in hand. getAgentBadges was consumed the same way.
//   · THE TIER LADDER DISAGREED WITH THE SERVER'S. 0/1000/5000/15000 here against
//     500/2500/10000/25000 everywhere else, so the header printed one tier while the
//     server had computed another. One ladder now: lib/gamification/tiers.ts.
//   · THE REWARD CARDS OVERSTATED THE REWARD. "+500 pts" for a closed deal against
//     an awarder that grants 100. Both read POINT_VALUES now.
//   · THE CHALLENGE PANEL WAS FABRICATED — three hard-coded cards with invented
//     progress bars ("2 of 5 completed") for challenges nobody had created. It reads
//     the real challenge rail.

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
  Award,
  Target,
  Loader2,
  CheckCircle,
  Lock,
  ChevronDown,
  ChevronUp,
} from "lucide-react"
import {
  getAgentBadges,
  getAgentPointsAndTier,
  getAgentPointsHistory,
  getLeaderboard,
} from "@/app/actions/gamification"
import { getChallenges } from "@/app/actions/challenges"
import { POINT_VALUES, POINT_EARNING_ACTIONS } from "@/lib/gamification/award-points"
import {
  LEADERBOARD_SCOPES,
  LEADERBOARD_METRICS,
  SCOPE_LABEL,
  METRIC_LABEL,
  periodWindows,
  defaultPeriodLabel,
  isLeaderboardScope,
  isLeaderboardMetric,
  isCanonicalPeriodLabel,
  type LeaderboardScope,
  type LeaderboardMetric,
  type LeaderboardRow,
} from "@/lib/gamification/leaderboard-vocabulary"
import { TIER_LABEL, tierProgressPercent, nextTierForPoints, type PointsTier } from "@/lib/gamification/tiers"
import Link from "next/link"

interface MotivationClientProps {
  agentId: string
  brokerageId: string
  userId: string
  /** Seeded from the URL so a filtered board is shareable. Validated server-side first. */
  initialScope?: LeaderboardScope | null
  initialMetric?: LeaderboardMetric | null
  initialPeriod?: string | null
}

const TIER_BENEFITS: Record<PointsTier, string[]> = {
  unranked: ["Core features", "Standard support"],
  bronze: ["Access to basic reports", "Standard support", "Core features"],
  silver: ["Priority lead routing", "Advanced analytics", "Extended support hours"],
  gold: ["VIP lead routing", "Custom branding", "Dedicated success manager"],
  platinum: ["All features unlocked", "White-glove support", "Executive coaching access"],
  diamond: ["All features unlocked", "White-glove support", "Broker-conferred recognition"],
}

const TIER_COLORS: Record<PointsTier, string> = {
  unranked: "bg-slate-500",
  bronze: "bg-amber-600",
  silver: "bg-slate-400",
  gold: "bg-yellow-500",
  platinum: "bg-gradient-to-r from-purple-500 to-pink-500",
  diamond: "bg-gradient-to-r from-sky-400 to-indigo-500",
}

const MOTIVATIONAL_MESSAGES: Record<PointsTier, string> = {
  unranked: "Every action from here counts — your first badge is 500 points away",
  bronze: "Building momentum — every action counts",
  silver: "You're climbing — keep pushing",
  gold: "Elite performer — you're setting the standard",
  platinum: "Legendary performance — you're the benchmark",
  diamond: "Conferred by your broker — the top of the house",
}

/** The ledger stores reason keys (LISTING_CLOSED); a person reads "Listing closed". */
function humaniseReason(reason: string): string {
  return reason.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())
}

interface BadgeView {
  id: string
  name: string
  description: string | null
  tier: string | null
  requiredPoints: number
  earned: boolean
  earnedAt: string | null
}

export function MotivationClient({
  agentId,
  initialScope = null,
  initialMetric = null,
  initialPeriod = null,
}: MotivationClientProps) {
  const [loading, setLoading] = useState(true)
  const [pointsData, setPointsData] = useState<{ points: number; tierId: PointsTier } | null>(null)
  const [pointsHistory, setPointsHistory] = useState<Array<{ points: number; reason: string; createdAt: string }>>([])
  const [badges, setBadges] = useState<BadgeView[]>([])
  const [badgeError, setBadgeError] = useState<string | null>(null)
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([])
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null)
  const [leaderboardLoading, setLeaderboardLoading] = useState(false)
  const [challenges, setChallenges] = useState<Array<{
    id: string
    title: string
    metricLabel: string
    status: string
    prizePoints: number
    youEnrolled: boolean
    myRank: number | null
    myValue: number
    leaderValue: number
  }>>([])

  // The three period options are computed once per render pass from the SAME
  // function the populator writes from, so a stale label can never be selected.
  const [periods] = useState(() => periodWindows(new Date()))

  const [selectedScope, setSelectedScope] = useState<LeaderboardScope>(
    isLeaderboardScope(initialScope) ? initialScope : "brokerage",
  )
  const [selectedMetric, setSelectedMetric] = useState<LeaderboardMetric>(
    isLeaderboardMetric(initialMetric) ? initialMetric : "points",
  )
  const [selectedPeriod, setSelectedPeriod] = useState<string>(
    isCanonicalPeriodLabel(initialPeriod) ? (initialPeriod as string) : defaultPeriodLabel(),
  )
  const [badgeFilter, setBadgeFilter] = useState<"all" | "earned" | "in-progress">("all")
  const [showPointsInfo, setShowPointsInfo] = useState(false)

  const loadLeaderboard = useCallback(async () => {
    setLeaderboardLoading(true)
    try {
      const result = await getLeaderboard({
        scope: selectedScope,
        metricType: selectedMetric,
        periodLabel: selectedPeriod,
        limit: 25,
      })
      // A refusal is not an empty board — say which one it was.
      setLeaderboard(result.ok ? result.rankings : [])
      setLeaderboardError(result.ok ? null : (result.error ?? "The leaderboard could not be read."))
    } catch (error) {
      setLeaderboard([])
      setLeaderboardError(error instanceof Error ? error.message : "The leaderboard could not be read.")
    } finally {
      setLeaderboardLoading(false)
    }
  }, [selectedScope, selectedMetric, selectedPeriod])

  const loadPersonal = useCallback(async () => {
    setLoading(true)
    try {
      // STANDINGS WITHOUT A PERSONAL RECORD. A broker or team lead is here for the
      // board and may have no agents row at all; those reads are skipped rather
      // than issued with an empty id.
      if (!agentId) {
        setPointsData(null)
        setBadges([])
        setPointsHistory([])
        return
      }
      const [pointsResult, badgesResult, historyResult] = await Promise.all([
        getAgentPointsAndTier(agentId),
        getAgentBadges(agentId),
        getAgentPointsHistory(agentId),
      ])
      setPointsData({ points: pointsResult.points, tierId: pointsResult.currentTierId as PointsTier })
      setBadges(badgesResult.ok ? (badgesResult.badges as BadgeView[]) : [])
      setBadgeError(badgesResult.ok ? null : (badgesResult.error ?? null))
      setPointsHistory(historyResult.ok ? historyResult.entries : [])
    } catch (error) {
      console.error("Error loading motivation data:", error)
    } finally {
      setLoading(false)
    }
  }, [agentId])

  const loadChallenges = useCallback(async () => {
    try {
      const { challenges: rows } = await getChallenges()
      setChallenges(
        rows
          .filter((c) => c.status === "active")
          .slice(0, 3)
          .map((c) => {
            const mine = c.standings.find((s) => s.agentId === agentId) ?? null
            return {
              id: c.id,
              title: c.title,
              metricLabel: c.metricLabel,
              status: c.status,
              prizePoints: c.prizePoints,
              youEnrolled: c.youEnrolled,
              myRank: mine?.rank ?? null,
              myValue: mine?.value ?? 0,
              leaderValue: c.standings[0]?.value ?? 0,
            }
          }),
      )
    } catch (error) {
      console.error("Error loading challenges:", error)
    }
  }, [agentId])

  useEffect(() => {
    loadPersonal()
    loadChallenges()
  }, [loadPersonal, loadChallenges])

  useEffect(() => {
    loadLeaderboard()
  }, [loadLeaderboard])

  const currentPoints = pointsData?.points ?? 0
  const currentTier: PointsTier = pointsData?.tierId ?? "unranked"
  const nextTier = nextTierForPoints(currentPoints)
  const progressToNextTier = tierProgressPercent(currentPoints)

  const earnedBadges = badges.filter((b) => b.earned)
  const unearnedBadges = badges.filter((b) => !b.earned)
  const filteredBadges =
    badgeFilter === "all" ? badges : badgeFilter === "earned" ? earnedBadges : unearnedBadges
  const nextBadge = unearnedBadges[0] ?? null
  const nextBadgeProgress = nextBadge
    ? Math.min(100, Math.round((currentPoints / Math.max(nextBadge.requiredPoints, 1)) * 100))
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
            <div className={`w-16 h-16 rounded-full flex items-center justify-center ${TIER_COLORS[currentTier]} shadow-lg`}>
              <Trophy className="h-8 w-8 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-2xl font-bold">{TIER_LABEL[currentTier]}</span>
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
                  <span>Next badge: {nextBadge.name}</span>
                  <span>{nextBadge.requiredPoints.toLocaleString()} pts</span>
                </div>
                <Progress value={nextBadgeProgress} className="h-2 bg-white/20" />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Section B: Tier Progress + Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Award className="h-5 w-5" />
              Your Tier Status
            </CardTitle>
            <CardDescription>Progress toward your next achievement level</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center gap-4">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${TIER_COLORS[currentTier]}`}>
                <Star className="h-6 w-6 text-white" />
              </div>
              <div className="flex-1">
                <p className="font-semibold text-lg">{TIER_LABEL[currentTier]} tier</p>
                <p className="text-sm text-muted-foreground">
                  {nextTier
                    ? `${nextTier.pointsToGo.toLocaleString()} pts to ${nextTier.label}`
                    : "Top of the ladder — Diamond is conferred by your broker"}
                </p>
              </div>
            </div>

            {nextTier && (
              <div>
                <div className="flex justify-between text-sm mb-2">
                  <span>{TIER_LABEL[currentTier]}</span>
                  <span>{nextTier.label}</span>
                </div>
                <Progress value={progressToNextTier} className="h-3" />
                <p className="text-sm text-muted-foreground mt-1 text-center">
                  {currentPoints.toLocaleString()} / {nextTier.threshold.toLocaleString()} pts
                </p>
              </div>
            )}

            <div className="space-y-2">
              <p className="font-medium">Your benefits:</p>
              <ul className="space-y-1">
                {TIER_BENEFITS[currentTier]?.map((benefit, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm">
                    <CheckCircle className="h-4 w-4 text-green-500" />
                    {benefit}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <Button
                variant="ghost"
                className="w-full justify-between"
                onClick={() => setShowPointsInfo(!showPointsInfo)}
              >
                <span>How points are earned</span>
                {showPointsInfo ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
              {showPointsInfo && (
                <div className="mt-2 space-y-2 p-3 bg-muted rounded-lg">
                  {POINT_EARNING_ACTIONS.map((a) => (
                    <div key={a.reason} className="flex justify-between text-sm">
                      <span>{a.label}</span>
                      <Badge variant="secondary">{POINT_VALUES[a.reason]} pts</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Recent Activity
            </CardTitle>
            <CardDescription>Your latest badges and point earnings</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="font-medium mb-2">Recent badges</p>
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

            <div>
              <p className="font-medium mb-2">Points history</p>
              {pointsHistory.length > 0 ? (
                <div className="space-y-2">
                  {pointsHistory.map((entry, i) => (
                    <div key={i} className="flex justify-between items-center p-2 bg-muted/50 rounded">
                      <div className="flex items-center gap-2">
                        <Zap className="h-4 w-4 text-primary" />
                        <span className="text-sm">{humaniseReason(entry.reason)}</span>
                      </div>
                      <Badge variant="outline">+{entry.points} pts</Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Complete actions to start earning points.</p>
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
                Badges
              </CardTitle>
              <CardDescription>
                {earnedBadges.length} earned / {badges.length} available
              </CardDescription>
            </div>
            <Tabs value={badgeFilter} onValueChange={(v) => setBadgeFilter(v as typeof badgeFilter)}>
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="earned">Earned</TabsTrigger>
                <TabsTrigger value="in-progress">In progress</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent>
          {badgeError ? (
            <p className="text-sm text-red-700">{badgeError}</p>
          ) : filteredBadges.length > 0 ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {filteredBadges.map((badge) => {
                const progress = badge.earned
                  ? 100
                  : Math.min(100, Math.round((currentPoints / Math.max(badge.requiredPoints, 1)) * 100))

                return (
                  <div
                    key={badge.id}
                    className={`p-4 rounded-lg border ${
                      badge.earned
                        ? "bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800"
                        : "bg-muted/30 border-muted grayscale"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      {badge.earned ? (
                        <Trophy className="h-6 w-6 text-amber-600" />
                      ) : (
                        <Lock className="h-6 w-6 text-muted-foreground" />
                      )}
                      <span className="font-medium">{badge.name}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mb-2">
                      {badge.description || "Complete actions to earn this badge"}
                    </p>
                    {badge.earned ? (
                      <p className="text-xs text-amber-600">
                        Earned {badge.earnedAt ? new Date(badge.earnedAt).toLocaleDateString() : ""}
                      </p>
                    ) : (
                      <div>
                        <Progress value={progress} className="h-1.5 mb-1" />
                        <p className="text-xs text-muted-foreground">
                          {badge.requiredPoints.toLocaleString()} pts required
                        </p>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-center text-muted-foreground py-8">
              No badges to display with the current filter.
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
              <Select value={selectedScope} onValueChange={(v) => setSelectedScope(v as LeaderboardScope)}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Compare against" />
                </SelectTrigger>
                <SelectContent>
                  {LEADERBOARD_SCOPES.map((s) => (
                    <SelectItem key={s} value={s}>{SCOPE_LABEL[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={selectedMetric} onValueChange={(v) => setSelectedMetric(v as LeaderboardMetric)}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Metric" />
                </SelectTrigger>
                <SelectContent>
                  {LEADERBOARD_METRICS.map((m) => (
                    <SelectItem key={m} value={m}>{METRIC_LABEL[m]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Period" />
                </SelectTrigger>
                <SelectContent>
                  {periods.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
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
          ) : leaderboardError ? (
            <p className="text-center text-sm text-red-700 py-8">{leaderboardError}</p>
          ) : leaderboard.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[80px]">Rank</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">{METRIC_LABEL[selectedMetric]}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leaderboard.map((entry) => (
                  <TableRow key={entry.agentId} className={entry.isCurrentAgent ? "bg-primary/10" : ""}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {entry.rank === 1 && <Trophy className="h-4 w-4 text-yellow-500" />}
                        {entry.rank === 2 && <Trophy className="h-4 w-4 text-slate-400" />}
                        {entry.rank === 3 && <Trophy className="h-4 w-4 text-amber-700" />}
                        <span className="font-medium">#{entry.rank}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className={entry.isCurrentAgent ? "font-bold" : ""}>{entry.agentName}</span>
                        {entry.isCurrentAgent && (
                          <Badge variant="secondary" className="text-xs">You</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {entry.score.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-center text-muted-foreground py-8">
              Nobody has scored on this board yet for the selected period.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Section E: Behaviour reinforcement — every value from POINT_VALUES */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" />
            Actions That Move You Forward
          </CardTitle>
          <CardDescription>What earns points, and exactly how many</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {POINT_EARNING_ACTIONS.map((a) => (
              <div key={a.reason} className="p-4 rounded-lg border bg-card text-center">
                <p className="font-medium text-sm">{a.label}</p>
                <Badge variant="outline" className="mt-2">+{POINT_VALUES[a.reason]} pts</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Section F: Challenges — REAL rows, or nothing */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Active Challenges
              </CardTitle>
              <CardDescription>Time-boxed competitions your brokerage is running</CardDescription>
            </div>
            <Link href="/dashboard/challenges">
              <Button size="sm" variant="outline">All challenges</Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {challenges.length > 0 ? (
            <div className="grid md:grid-cols-3 gap-4">
              {challenges.map((c) => (
                <div key={c.id} className="p-4 rounded-lg border bg-card">
                  <div className="flex items-center justify-between mb-2 gap-2">
                    <span className="font-medium text-sm">{c.title}</span>
                    {c.prizePoints > 0 && <Badge>{c.prizePoints} pts</Badge>}
                  </div>
                  <Progress
                    value={c.leaderValue > 0 ? Math.min(100, Math.round((c.myValue / c.leaderValue) * 100)) : 0}
                    className="h-2 mb-2"
                  />
                  <p className="text-sm text-muted-foreground mb-3">
                    {c.youEnrolled
                      ? `${c.myValue.toLocaleString()} ${c.metricLabel}${c.myRank ? ` · rank #${c.myRank}` : ""}`
                      : "You are not enrolled yet"}
                  </p>
                  <Link href="/dashboard/challenges">
                    <Button size="sm" className="w-full">
                      {c.youEnrolled ? "View standings" : "Join"}
                    </Button>
                  </Link>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-center text-muted-foreground py-6">
              No challenge is running right now. Your broker can start one from the Challenges page.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
