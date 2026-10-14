"use client"

// components/portal/LessonCard.tsx
// Displays a lesson in the education feed with title, summary, read time, and status.

import { Card, CardContent } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { 
  Video, 
  FileText, 
  CheckSquare, 
  BookOpen, 
  HelpCircle,
  Check,
  Clock,
  Target
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { LessonFeedItem } from "@/app/actions/portal-education"

interface LessonCardProps {
  lesson: LessonFeedItem
  onClick?: () => void
}

const FORMAT_ICONS: Record<string, typeof Video> = {
  video: Video,
  article: FileText,
  checklist: CheckSquare,
  guide: BookOpen,
  quiz: HelpCircle,
}

const FORMAT_COLORS: Record<string, string> = {
  video: "bg-red-100 text-red-800",
  article: "bg-blue-100 text-blue-800",
  checklist: "bg-green-100 text-green-800",
  guide: "bg-purple-100 text-purple-800",
  quiz: "bg-amber-100 text-amber-800",
}

// TOMBSTONE (orphan doctrine §1.3, wave 53): this component's `isSpotlight`
// prop is DELETED. It was declared-never-passed (hidden-wire-census category
// c) — the only "spotlight" rendering the app actually does is
// SpotlightLessonCard below (app/portal/[contactId]/learn/learn-client.tsx's
// `currentFeed.spotlight` renders THAT component, not this one with
// isSpotlight=true), which already has its own "Up Next" badge + larger
// layout. `isSpotlight`'s ring/badge/text-size branches here were a second,
// dead implementation of the same idea with no caller ever reaching them —
// the functionality already lives at SpotlightLessonCard below.
export function LessonCard({ lesson, onClick }: LessonCardProps) {
  const Icon = FORMAT_ICONS[lesson.format] || FileText
  const formatColor = FORMAT_COLORS[lesson.format] || "bg-muted text-muted-foreground"

  return (
    <Card
      className={cn(
        "cursor-pointer transition-all hover:shadow-md",
        lesson.isCompleted && "opacity-70",
        "min-h-[120px]"
      )}
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`${lesson.isCompleted ? "Completed: " : ""}${lesson.title}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onClick?.()
        }
      }}
    >
      <CardContent className="p-4 flex flex-col gap-3 h-full">
        {/* Header Row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="secondary" className={cn("text-xs", formatColor)}>
              <Icon className="w-3 h-3 mr-1" />
              {lesson.format}
            </Badge>
            {lesson.isMilestoneRelevant && !lesson.isCompleted && (
              <Badge variant="outline" className="text-xs border-primary text-primary">
                <Target className="w-3 h-3 mr-1" />
                Milestone
              </Badge>
            )}
          </div>
          {lesson.isCompleted && (
            <div className="flex items-center text-green-600" aria-label="Completed">
              <Check className="w-5 h-5" />
            </div>
          )}
        </div>

        {/* Title */}
        <h3 className={cn(
          "font-semibold text-foreground line-clamp-2 text-base",
          lesson.isCompleted && "text-muted-foreground"
        )}>
          {lesson.title}
        </h3>

        {/* Description */}
        <p className={cn(
          "text-sm line-clamp-2 flex-1",
          lesson.isCompleted ? "text-muted-foreground" : "text-muted-foreground"
        )}>
          {lesson.description}
        </p>

        {/* Footer */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground mt-auto">
          <div className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            <span>{lesson.estimatedMinutes} min</span>
          </div>
          {lesson.tags.length > 0 && (
            <span className="capitalize">{lesson.tags[0]}</span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// Spotlight variant with larger layout
export function SpotlightLessonCard({ lesson, onClick }: LessonCardProps) {
  const Icon = FORMAT_ICONS[lesson.format] || FileText
  const formatColor = FORMAT_COLORS[lesson.format] || "bg-muted text-muted-foreground"

  return (
    <Card
      className="cursor-pointer transition-all hover:shadow-lg ring-2 ring-primary bg-primary/5"
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`Start learning: ${lesson.title}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onClick?.()
        }
      }}
    >
      <CardContent className="p-6 flex flex-col md:flex-row gap-4">
        {/* Icon */}
        <div className="flex-shrink-0 w-16 h-16 rounded-lg bg-primary/10 flex items-center justify-center">
          <Icon className="w-8 h-8 text-primary" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <Badge className="text-xs bg-primary text-primary-foreground">
              Up Next
            </Badge>
            <Badge variant="secondary" className={cn("text-xs", formatColor)}>
              {lesson.format}
            </Badge>
            {lesson.isMilestoneRelevant && (
              <Badge variant="outline" className="text-xs border-primary text-primary">
                <Target className="w-3 h-3 mr-1" />
                Milestone Relevant
              </Badge>
            )}
          </div>

          <h2 className="text-xl font-bold text-foreground mb-2">
            {lesson.title}
          </h2>

          <p className="text-muted-foreground mb-3">
            {lesson.description}
          </p>

          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-1">
              <Clock className="w-4 h-4" />
              <span>{lesson.estimatedMinutes} min read</span>
            </div>
            <span className="capitalize">{lesson.category}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
