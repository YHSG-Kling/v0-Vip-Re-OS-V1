"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Calendar, Sparkles, Loader2 } from "lucide-react"
import { generateSmartResponse } from "@/app/actions/ai-communication-hub"
import { getBrandVoiceProfile } from "@/app/actions/ai-content-generation.tsx"
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

const PLATFORMS = ["facebook", "instagram", "linkedin", "twitter"]

export function SocialCalendarAiPlanner({
  agentId,
  brokerageId,
  userId,
  posts,
  onRefresh,
}: SocialCalendarAiPlannerProps) {
  const [generating, setGenerating] = useState(false)
  const [suggestedPlan, setSuggestedPlan] = useState<any>(null)
  const [selectedWeek, setSelectedWeek] = useState("current")

  const handleBuildWeekPlan = async () => {
    setGenerating(true)
    try {
      const profile = await getBrandVoiceProfile(agentId)
      
      const plan = await generateSmartResponse({
        userMessage: `Create a weekly social media calendar for a real estate agent.
Generate 7 days with 2-3 posts each.
Include content types: market updates, listings, testimonials, educational content, community spotlights.
Brand voice: ${profile?.tone || "professional"}.
Format as: Day | Post Type | Content Hook | Platform | Suggested Time`,
        brandVoice: profile,
        systemPrompt: "You are a social media strategist. Create a diverse, engaging weekly content calendar.",
      })

      setSuggestedPlan(plan)
      toast.success("Weekly plan generated!")
    } catch (error) {
      console.error("Error generating plan:", error)
      toast.error("Failed to generate plan")
    } finally {
      setGenerating(false)
    }
  }

  // Get this week's posts
  const thisWeekPosts = posts.filter((p) => {
    if (!p.scheduled_for) return false
    const postDate = new Date(p.scheduled_for)
    const today = new Date()
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
    return postDate >= weekAgo && postDate <= today
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="h-4 w-4" />
          Social Calendar
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Week Selector */}
        <div className="flex gap-2">
          <button
            onClick={() => setSelectedWeek("current")}
            className={`px-3 py-1 rounded text-sm ${
              selectedWeek === "current"
                ? "bg-primary text-white"
                : "bg-muted text-foreground"
            }`}
          >
            This Week
          </button>
          <button
            onClick={() => setSelectedWeek("next")}
            className={`px-3 py-1 rounded text-sm ${
              selectedWeek === "next"
                ? "bg-primary text-white"
                : "bg-muted text-foreground"
            }`}
          >
            Next Week
          </button>
        </div>

        {/* Calendar Grid */}
        <div className="grid grid-cols-7 gap-2 text-xs">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
            <div key={day} className="text-center font-semibold p-2">
              {day}
            </div>
          ))}
          {Array.from({ length: 7 }).map((_, i) => (
            <div
              key={i}
              className="border rounded p-2 min-h-20 bg-gray-50 space-y-1"
            >
              {thisWeekPosts
                .filter((p) => {
                  const postDate = new Date(p.scheduled_for || "")
                  return postDate.getDay() === (i + 1) % 7
                })
                .map((post) => (
                  <Badge
                    key={post.id}
                    variant="secondary"
                    className="text-xs block truncate"
                  >
                    {post.platform}
                  </Badge>
                ))}
            </div>
          ))}
        </div>

        {/* Stats */}
        <div className="bg-blue-50 p-3 rounded space-y-1">
          <p className="text-sm font-semibold">This Week's Performance</p>
          <p className="text-xs text-muted-foreground">
            {thisWeekPosts.length} posts scheduled
          </p>
        </div>

        {/* AI Plan Builder */}
        <Button
          onClick={handleBuildWeekPlan}
          disabled={generating}
          className="w-full"
        >
          {generating ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Generating Plan...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4 mr-2" />
              Build This Week's Social Plan with AI
            </>
          )}
        </Button>

        {/* Suggested Plan */}
        {suggestedPlan && (
          <div className="border-t pt-4 space-y-2">
            <p className="text-sm font-semibold">Suggested Plan</p>
            <p className="text-xs whitespace-pre-wrap text-muted-foreground">
              {suggestedPlan.substring(0, 500)}...
            </p>
            <Button variant="outline" size="sm" className="w-full">
              View Full Plan
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
