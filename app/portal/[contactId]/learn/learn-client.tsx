"use client"

import { useState, useCallback, useMemo } from "react"
import useSWR from "swr"
import { Progress } from "@/app/components/ui/progress"
import { Tabs, TabsList, TabsTrigger } from "@/app/components/ui/tabs"
import { Card, CardContent } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { BookOpen, CheckCircle2, Clock } from "lucide-react"
import { LessonCard, SpotlightLessonCard } from "@/app/components/portal/LessonCard"
import { LessonDetailDrawer } from "@/app/components/portal/LessonDetailDrawer"
import type { LessonFeedResult, LessonFeedItem } from "@/app/actions/portal-education"
import { markResourceCompleted } from "@/app/actions/ai-client-portal"
import { createClient } from "@/lib/supabase/client"

interface LearnClientProps {
  contactId: string
  initialFeed: LessonFeedResult
  /** agent_id of the supervising agent — used for 100% completion notification */
  agentId?: string | null
  /** contact first name for notification body */
  contactFirstName?: string | null
}

type FilterTab = "all" | "unread" | "completed"

// Fetcher for SWR
const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error("Failed to fetch")
  return res.json()
}

export default function LearnClient({ contactId, initialFeed, agentId, contactFirstName }: LearnClientProps) {
  const [filter, setFilter] = useState<FilterTab>("all")
  const [selectedLesson, setSelectedLesson] = useState<LessonFeedItem | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Use SWR for data with initial data from server
  const { data: feed, mutate } = useSWR<LessonFeedResult>(
    `/api/portal/education/${contactId}`,
    fetcher,
    {
      fallbackData: initialFeed,
      revalidateOnFocus: false,
      refreshInterval: 60000, // Refresh every minute
    }
  )

  const currentFeed = feed || initialFeed

  // Filter lessons based on current tab
  const filteredLessons = useMemo(() => {
    if (filter === "unread") {
      return currentFeed.lessons.filter(lesson => !lesson.isCompleted)
    }
    if (filter === "completed") {
      return currentFeed.lessons.filter(lesson => lesson.isCompleted)
    }
    return currentFeed.lessons
  }, [currentFeed.lessons, filter])

  // Group lessons by category
  const groupedLessons = useMemo(() => {
    const groups: Record<string, LessonFeedItem[]> = {}
    for (const lesson of filteredLessons) {
      if (!groups[lesson.category]) {
        groups[lesson.category] = []
      }
      groups[lesson.category].push(lesson)
    }
    return groups
  }, [filteredLessons])

  // Handle lesson click
  const handleLessonClick = useCallback((lesson: LessonFeedItem) => {
    setSelectedLesson(lesson)
    setDrawerOpen(true)
  }, [])

  // Handle lesson read — optimistic update + cross-system persistence + 100% agent notification
  const handleLessonRead = useCallback(async (lessonKey: string) => {
    // Persist to contact_education_progress via ai-client-portal action
    await markResourceCompleted({ contactId, resourceId: lessonKey }).catch(() => {})

    // Optimistically update the local SWR state
    await mutate(
      (current) => {
        if (!current) return current
        const newCompletedCount = current.completedCount + 1
        const updatedLessons = current.lessons.map(lesson =>
          lesson.key === lessonKey ? { ...lesson, isCompleted: true } : lesson
        )

        // Fire agent notification if all lessons are now complete
        if (newCompletedCount >= current.totalCount && agentId) {
          const supabase = createClient()
          supabase.from("notifications").insert({
            user_id: agentId,
            type: "portal_education_completed",
            title: `${contactFirstName ?? "Your client"} completed all portal lessons`,
            entity_type: "contact",
            entity_id: contactId,
          }).then(() => {}).catch(() => {})
        }

        return {
          ...current,
          completedCount: newCompletedCount,
          spotlight: current.spotlight?.key === lessonKey
            ? current.lessons.find(l => !l.isCompleted && l.key !== lessonKey) ?? null
            : current.spotlight,
          lessons: updatedLessons,
        }
      },
      false
    )
  }, [mutate, contactId, agentId, contactFirstName])

  const progressPercent = currentFeed.totalCount > 0
    ? Math.round((currentFeed.completedCount / currentFeed.totalCount) * 100)
    : 0

  const unreadCount = currentFeed.totalCount - currentFeed.completedCount

  return (
    <div className="space-y-6">
      {/* Progress Section */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-primary" />
            <span className="font-medium">
              {currentFeed.completedCount} of {currentFeed.totalCount} lessons completed
            </span>
          </div>
          <span className="text-sm text-muted-foreground">
            {progressPercent}%
          </span>
        </div>
        <Progress value={progressPercent} className="h-2" />
      </div>

      {/* Spotlight Lesson */}
      {currentFeed.spotlight && filter !== "completed" && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" />
            Continue Learning
          </h2>
          <SpotlightLessonCard
            lesson={currentFeed.spotlight}
            onClick={() => handleLessonClick(currentFeed.spotlight!)}
          />
        </div>
      )}

      {/* Filter Tabs */}
      <Tabs value={filter} onValueChange={(v) => setFilter(v as FilterTab)}>
        <TabsList>
          <TabsTrigger value="all" className="min-h-[44px]">
            All
            <Badge variant="secondary" className="ml-2">
              {currentFeed.totalCount}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="unread" className="min-h-[44px]">
            Unread
            {unreadCount > 0 && (
              <Badge className="ml-2 bg-primary">
                {unreadCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="completed" className="min-h-[44px]">
            Completed
            <Badge variant="secondary" className="ml-2">
              {currentFeed.completedCount}
            </Badge>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Empty States */}
      {filteredLessons.length === 0 && filter === "completed" && (
        <Card>
          <CardContent className="py-12 text-center">
            <CheckCircle2 className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No completed lessons yet</h3>
            <p className="text-muted-foreground">
              Start learning to track your progress here.
            </p>
          </CardContent>
        </Card>
      )}

      {filteredLessons.length === 0 && filter === "unread" && (
        <Card>
          <CardContent className="py-12 text-center">
            <CheckCircle2 className="w-12 h-12 mx-auto text-green-500 mb-4" />
            <h3 className="text-lg font-medium mb-2">All caught up!</h3>
            <p className="text-muted-foreground">
              Check back as your journey progresses for new lessons.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Lesson Grid by Category */}
      {Object.entries(groupedLessons).map(([category, lessons]) => (
        <div key={category} className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">{category}</h2>
            <Badge variant="outline">
              {lessons.filter(l => l.isCompleted).length}/{lessons.length}
            </Badge>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {lessons.map(lesson => (
              <LessonCard
                key={lesson.key}
                lesson={lesson}
                onClick={() => handleLessonClick(lesson)}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Lesson Detail Drawer */}
      <LessonDetailDrawer
        lesson={selectedLesson}
        contactId={contactId}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onLessonRead={handleLessonRead}
      />
    </div>
  )
}
