"use client"

import { useState, useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Calendar, ChevronLeft, ChevronRight, Sparkles, Loader2, Clock } from "lucide-react"
import { generateWeeklyContentPlan } from "@/app/actions/social/generate-social-post"
import { toast } from "sonner"

interface SocialCalendarAiPlannerProps {
  agentId: string
  brokerageId: string
  userId: string
  posts: Array<{
    id: string
    content: string
    platform: string
    status: string
    scheduled_for?: string
    post_type: string
  }>
  onRefresh: () => void
}

type WeekPlanItem = {
  day: string
  contentType: string
  platform: string
  hook: string
  suggestedTime: string
}

// Returns Monday of the week containing `date`
function getMondayOf(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay() // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1 - day) // shift to Monday
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

const PLATFORM_COLOR: Record<string, string> = {
  facebook:  "bg-blue-100 text-blue-700",
  instagram: "bg-pink-100 text-pink-700",
  linkedin:  "bg-blue-200 text-blue-800",
  twitter:   "bg-gray-100 text-gray-700",
  tiktok:    "bg-black/10 text-black",
  youtube:   "bg-red-100 text-red-700",
}

export function SocialCalendarAiPlanner({
  agentId,
  brokerageId,
  posts,
  onRefresh,
}: SocialCalendarAiPlannerProps) {
  const [weekOffset, setWeekOffset] = useState(0)   // 0 = current, 1 = next, etc.
  const [generating, setGenerating] = useState(false)
  const [suggestedPlan, setSuggestedPlan] = useState<WeekPlanItem[]>([])

  // Monday of the displayed week
  const monday = useMemo(() => {
    const base = getMondayOf(new Date())
    return addDays(base, weekOffset * 7)
  }, [weekOffset])

  // Build a map: day-index (0=Mon…6=Sun) → posts for that day
  const postsByDayIndex = useMemo(() => {
    const map: Record<number, typeof posts> = {}
    const weekStart = monday.getTime()
    const weekEnd   = addDays(monday, 7).getTime()

    posts.forEach(p => {
      if (!p.scheduled_for) return
      const t = new Date(p.scheduled_for).getTime()
      if (t < weekStart || t >= weekEnd) return
      const date = new Date(p.scheduled_for)
      // getDay() returns 0=Sun…6=Sat; shift to 0=Mon…6=Sun
      const dayIdx = (date.getDay() + 6) % 7
      if (!map[dayIdx]) map[dayIdx] = []
      map[dayIdx].push(p)
    })

    return map
  }, [posts, monday])

  // AI plan builder
  const handleBuildWeekPlan = async () => {
    setGenerating(true)
    try {
      const result = await generateWeeklyContentPlan({ brokerageId, agentId })
      if (result.success && result.data) {
        setSuggestedPlan(result.data)
        toast.success("Weekly plan generated")
      } else {
        toast.error(result.error ?? "Failed to generate plan")
      }
    } catch {
      toast.error("Failed to generate plan")
    } finally {
      setGenerating(false)
    }
  }

  const weekLabel = (() => {
    const end = addDays(monday, 6)
    const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }
    return `${monday.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`
  })()

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Calendar className="h-4 w-4" />
            Social Calendar
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setWeekOffset(w => w - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium tabular-nums w-40 text-center">{weekLabel}</span>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setWeekOffset(w => w + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-1 text-xs">
          {DAYS.map((day, i) => {
            const date = addDays(monday, i)
            const dayPosts = postsByDayIndex[i] ?? []
            const isToday = date.toDateString() === new Date().toDateString()

            return (
              <div key={day} className="flex flex-col">
                {/* Header */}
                <div className={`text-center py-1.5 font-semibold rounded-t ${isToday ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>
                  <div>{day}</div>
                  <div className={`text-xs ${isToday ? "text-primary-foreground/80" : "text-muted-foreground"}`}>
                    {date.getDate()}
                  </div>
                </div>
                {/* Day cell */}
                <div className="border border-t-0 rounded-b min-h-20 p-1 space-y-1 bg-background">
                  {dayPosts.map(post => (
                    <div
                      key={post.id}
                      className={`rounded px-1 py-0.5 truncate text-[10px] ${PLATFORM_COLOR[post.platform] ?? "bg-gray-100 text-gray-700"}`}
                      title={post.content}
                    >
                      {post.platform.slice(0, 2).toUpperCase()} · {post.post_type?.replace(/_/g, " ") || "post"}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        {/* Stats */}
        <div className="flex items-center justify-between text-sm text-muted-foreground bg-muted/40 rounded-lg px-3 py-2">
          <span>
            {Object.values(postsByDayIndex).flat().length} post(s) this week
          </span>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onRefresh}>
            Refresh
          </Button>
        </div>

        {/* AI Plan Builder */}
        <Button onClick={handleBuildWeekPlan} disabled={generating} className="w-full">
          {generating ? (
            <><Loader2 className="h-4 w-4 animate-spin mr-2" />Generating Plan...</>
          ) : (
            <><Sparkles className="h-4 w-4 mr-2" />Build This Week&apos;s Social Plan with AI</>
          )}
        </Button>

        {/* Suggested Plan */}
        {suggestedPlan.length > 0 && (
          <div className="border-t pt-4 space-y-2">
            <p className="text-sm font-semibold">Suggested 7-Day Plan</p>
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {suggestedPlan.map((item, i) => (
                <div key={i} className="flex items-start gap-3 p-2 rounded-lg border bg-muted/30">
                  <div className={`text-xs font-bold rounded px-1.5 py-0.5 flex-shrink-0 ${PLATFORM_COLOR[item.platform] ?? "bg-gray-100 text-gray-700"}`}>
                    {item.platform.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 mb-0.5">
                      <span className="text-xs font-medium">{item.day}</span>
                      <span className="text-xs text-muted-foreground">· {item.contentType}</span>
                      <span className="flex items-center gap-0.5 text-xs text-muted-foreground ml-auto">
                        <Clock className="h-3 w-3" />{item.suggestedTime}
                      </span>
                    </div>
                    <p className="text-xs text-foreground line-clamp-2">{item.hook}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
