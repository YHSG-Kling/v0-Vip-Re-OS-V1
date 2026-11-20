"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { useState, useTransition } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { HeatmapFilters, ActivityType } from "@/app/actions/team-heatmap"

interface HeatmapFilterBarProps {
  filters: HeatmapFilters
  agentOptions: { id: string; name: string }[]
  teamOptions: { id: string; name: string }[]
  isPrivileged: boolean
  userRole: string
}

const ACTIVITY_TYPES: { value: ActivityType; label: string; color: string }[] = [
  { value: "all", label: "All", color: "bg-gray-100 text-gray-700" },
  { value: "listing", label: "Listings", color: "bg-blue-100 text-blue-700" },
  { value: "buyer", label: "Buyers", color: "bg-green-100 text-green-700" },
  { value: "closed", label: "Closed", color: "bg-amber-100 text-amber-700" },
  { value: "lead", label: "Leads", color: "bg-orange-100 text-orange-700" },
]

const DATE_RANGES = [
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
  { value: "90d", label: "Last 90 Days" },
]

export function HeatmapFilterBar({
  filters,
  agentOptions,
  teamOptions,
  isPrivileged,
  userRole,
}: HeatmapFilterBarProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()

  const [selectedActivities, setSelectedActivities] = useState<ActivityType[]>(
    filters.activityTypes
  )

  function updateFilters(updates: Partial<HeatmapFilters>) {
    const params = new URLSearchParams(searchParams.toString())

    if (updates.agentId !== undefined) {
      if (updates.agentId) {
        params.set("agent", updates.agentId)
      } else {
        params.delete("agent")
      }
    }

    if (updates.teamId !== undefined) {
      if (updates.teamId) {
        params.set("team", updates.teamId)
      } else {
        params.delete("team")
      }
    }

    if (updates.activityTypes) {
      if (updates.activityTypes.includes("all")) {
        params.delete("activity")
      } else {
        params.set("activity", updates.activityTypes.join(","))
      }
    }

    if (updates.dateRange) {
      params.set("range", updates.dateRange)
    }

    if (updates.revenueWeighted !== undefined) {
      if (updates.revenueWeighted) {
        params.set("weighted", "true")
      } else {
        params.delete("weighted")
      }
    }

    startTransition(() => {
      router.push(`/dashboard/team-heatmap?${params.toString()}`)
    })
  }

  function toggleActivity(activity: ActivityType) {
    let newActivities: ActivityType[]

    if (activity === "all") {
      newActivities = ["all"]
    } else {
      // Remove "all" if selecting specific types
      const withoutAll = selectedActivities.filter((a) => a !== "all")

      if (withoutAll.includes(activity)) {
        newActivities = withoutAll.filter((a) => a !== activity)
        if (newActivities.length === 0) {
          newActivities = ["all"]
        }
      } else {
        newActivities = [...withoutAll, activity]
      }
    }

    setSelectedActivities(newActivities)
    updateFilters({ activityTypes: newActivities })
  }

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-card p-4">
      {/* Agent Filter */}
      {isPrivileged && agentOptions.length > 0 && (
        <div className="flex items-center gap-2">
          <Label className="text-sm text-muted-foreground">Agent:</Label>
          <Select
            value={filters.agentId || "all"}
            onValueChange={(v) => updateFilters({ agentId: v === "all" ? undefined : v })}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="All Agents" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Agents</SelectItem>
              {agentOptions.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Team Filter (broker only) */}
      {userRole === "broker" && teamOptions.length > 0 && (
        <div className="flex items-center gap-2">
          <Label className="text-sm text-muted-foreground">Team:</Label>
          <Select
            value={filters.teamId || "all"}
            onValueChange={(v) => updateFilters({ teamId: v === "all" ? undefined : v })}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="All Teams" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Teams</SelectItem>
              {teamOptions.map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Activity Type Chips */}
      <div className="flex items-center gap-2">
        <Label className="text-sm text-muted-foreground">Activity:</Label>
        <div className="flex flex-wrap gap-1">
          {ACTIVITY_TYPES.map((type) => (
            <Badge
              key={type.value}
              variant="outline"
              className={cn(
                "cursor-pointer transition-all",
                selectedActivities.includes(type.value)
                  ? type.color
                  : "bg-transparent text-muted-foreground hover:bg-muted"
              )}
              onClick={() => toggleActivity(type.value)}
            >
              {type.label}
            </Badge>
          ))}
        </div>
      </div>

      {/* Date Range */}
      <div className="flex items-center gap-2">
        <Label className="text-sm text-muted-foreground">Range:</Label>
        <Select
          value={filters.dateRange}
          onValueChange={(v) => updateFilters({ dateRange: v as any })}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATE_RANGES.map((range) => (
              <SelectItem key={range.value} value={range.value}>
                {range.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Revenue Weighted Toggle */}
      <div className="flex items-center gap-2 ml-auto">
        <Switch
          id="revenue-weighted"
          checked={filters.revenueWeighted}
          onCheckedChange={(checked) => updateFilters({ revenueWeighted: checked })}
        />
        <Label htmlFor="revenue-weighted" className="text-sm cursor-pointer">
          Revenue Weighted
        </Label>
      </div>

      {/* Loading indicator */}
      {isPending && (
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      )}
    </div>
  )
}
