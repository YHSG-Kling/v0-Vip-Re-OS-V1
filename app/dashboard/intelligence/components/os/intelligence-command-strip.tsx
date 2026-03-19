"use client"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"
import {
  Brain,
  BarChart3,
  Users,
  Trophy,
  Sparkles,
  AlertTriangle,
  TrendingUp,
  Filter,
  RefreshCw,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

interface IntelligenceCommandStripProps {
  trustCapitalScore: number
  activePatternCount: number
  onRefresh?: () => void
  onFilterChange?: (filter: string) => void
  currentFilter?: string
}

export function IntelligenceCommandStrip({
  trustCapitalScore,
  activePatternCount,
  onRefresh,
  onFilterChange,
  currentFilter = "all",
}: IntelligenceCommandStripProps) {
  const filterOptions = [
    { value: "all", label: "All Insights" },
    { value: "high_priority", label: "High Priority" },
    { value: "buyer", label: "Buyer Patterns" },
    { value: "seller", label: "Seller Patterns" },
    { value: "team", label: "Team Metrics" },
  ]

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Brain className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Intelligence Center</h2>
            <p className="text-sm text-muted-foreground">
              Trust Capital: <span className="font-medium text-foreground">{trustCapitalScore}/100</span>
              {" | "}
              <span className="text-amber-600">{activePatternCount} active patterns</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <Filter className="h-4 w-4" />
                {filterOptions.find(f => f.value === currentFilter)?.label || "Filter"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {filterOptions.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onClick={() => onFilterChange?.(option.value)}
                  className={currentFilter === option.value ? "bg-accent" : ""}
                >
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {onRefresh && (
            <Button variant="outline" size="sm" onClick={onRefresh}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Link href="/dashboard/analytics">
          <Button variant="outline" size="sm" className="gap-2">
            <BarChart3 className="h-4 w-4" />
            Analytics
          </Button>
        </Link>
        <Link href="/dashboard/patterns">
          <Button variant="outline" size="sm" className="gap-2">
            <TrendingUp className="h-4 w-4" />
            Patterns
          </Button>
        </Link>
        <Link href="/dashboard/leaderboard">
          <Button variant="outline" size="sm" className="gap-2">
            <Trophy className="h-4 w-4" />
            Leaderboard
          </Button>
        </Link>
        <Link href="/dashboard/ai-quality">
          <Button variant="outline" size="sm" className="gap-2">
            <Sparkles className="h-4 w-4" />
            AI Quality
          </Button>
        </Link>
        <Link href="/dashboard/team">
          <Button variant="outline" size="sm" className="gap-2">
            <Users className="h-4 w-4" />
            Team Heatmap
          </Button>
        </Link>

        {activePatternCount > 5 && (
          <Badge variant="destructive" className="ml-auto gap-1">
            <AlertTriangle className="h-3 w-3" />
            {activePatternCount} patterns need review
          </Badge>
        )}
      </div>
    </div>
  )
}
