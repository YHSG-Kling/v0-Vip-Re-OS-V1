"use client"

// components/portal/LessonDetailDrawer.tsx
// Full lesson detail drawer with content and "Mark as Read" action.

import { useState, useEffect } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/app/components/ui/sheet"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { Separator } from "@/app/components/ui/separator"
import { 
  Video, 
  FileText, 
  CheckSquare, 
  BookOpen, 
  HelpCircle,
  Check,
  Clock,
  X,
  Target,
  Loader2
} from "lucide-react"
import { cn } from "@/lib/utils"
import { markLessonRead, getLessonByKey } from "@/app/actions/portal-education"
import type { LessonFeedItem } from "@/app/actions/portal-education"

interface LessonDetailDrawerProps {
  lesson: LessonFeedItem | null
  contactId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onLessonRead?: (lessonKey: string) => void
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

// Placeholder lesson content - in production this would come from a CMS or database
const LESSON_CONTENT: Record<string, string> = {
  buyer_pre_intro: `
## Welcome to Your Home Buying Journey

Buying a home is one of the most significant financial decisions you'll make. This guide will help you understand the process from start to finish.

### What to Expect

1. **Pre-Approval** - Get your finances in order and secure pre-approval from a lender
2. **Home Search** - Work with your agent to find properties that match your criteria
3. **Making an Offer** - When you find the right home, we'll help you craft a competitive offer
4. **Due Diligence** - Inspections, appraisals, and reviewing disclosures
5. **Closing** - Final walkthrough, signing documents, and getting your keys

### Your Agent's Role

Your real estate agent is your advocate throughout this process. They will:
- Help you understand the local market
- Schedule and attend showings
- Negotiate on your behalf
- Guide you through paperwork
- Connect you with trusted professionals

### Timeline

The typical home buying process takes 30-60 days from accepted offer to closing. However, finding the right home can take weeks or months depending on market conditions.
  `,
  buyer_pre_credit: `
## Understanding Your Credit & Finances

Your credit score is one of the most important factors lenders consider when evaluating your mortgage application.

### Credit Score Ranges

- **Excellent (750+)** - Best rates and terms available
- **Good (700-749)** - Competitive rates, most loan options available
- **Fair (650-699)** - Higher rates, some loan restrictions
- **Poor (Below 650)** - Limited options, may need FHA or alternative programs

### How to Improve Your Credit

1. Pay all bills on time
2. Keep credit card balances below 30% of limits
3. Don't open new credit accounts before applying
4. Check your credit report for errors
5. Pay down existing debt

### What Lenders Look At

- **Credit Score** - Your numerical creditworthiness
- **Debt-to-Income Ratio** - Monthly debts vs. income
- **Employment History** - Stable income verification
- **Down Payment** - How much you can put down
- **Assets** - Savings and reserves
  `,
}

export function LessonDetailDrawer({
  lesson,
  contactId,
  open,
  onOpenChange,
  onLessonRead,
}: LessonDetailDrawerProps) {
  const [isMarking, setIsMarking] = useState(false)
  const [marked, setMarked] = useState(false)
  const [content, setContent] = useState<string>(lesson ? (LESSON_CONTENT[lesson.key] || "") : "")
  const [loadingContent, setLoadingContent] = useState(lesson ? !LESSON_CONTENT[lesson.key] : false)

  useEffect(() => {
    if (!lesson) return
    // If hardcoded content exists, use it immediately — no fetch needed
    if (LESSON_CONTENT[lesson.key]) {
      setContent(LESSON_CONTENT[lesson.key])
      setLoadingContent(false)
      return
    }
    setLoadingContent(true)
    getLessonByKey(lesson.key, contactId)
      .then(r => {
        if (r?.description) {
          setContent(r.description)
        } else {
          setContent("Lesson content will be available soon.")
        }
      })
      .catch(() => setContent("Lesson content will be available soon."))
      .finally(() => setLoadingContent(false))
  }, [lesson?.key, contactId])

  if (!lesson) return null

  const Icon = FORMAT_ICONS[lesson.format] || FileText
  const formatColor = FORMAT_COLORS[lesson.format] || "bg-muted text-muted-foreground"

  const handleMarkAsRead = async () => {
    setIsMarking(true)
    try {
      const result = await markLessonRead({ contactId, lessonKey: lesson.key })
      if (result.success) {
        setMarked(true)
        onLessonRead?.(lesson.key)
        // Close drawer after short delay
        setTimeout(() => {
          onOpenChange(false)
        }, 1000)
      }
    } catch (error) {
      console.error("Failed to mark lesson as read:", error)
    } finally {
      setIsMarking(false)
    }
  }

  const isCompleted = lesson.isCompleted || marked

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent 
        side="right" 
        className="w-full sm:max-w-lg md:max-w-xl overflow-y-auto"
      >
        <SheetHeader className="space-y-4 pb-4">
          {/* Badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="secondary" className={cn("text-xs", formatColor)}>
              <Icon className="w-3 h-3 mr-1" />
              {lesson.format}
            </Badge>
            {lesson.isMilestoneRelevant && (
              <Badge variant="outline" className="text-xs border-primary text-primary">
                <Target className="w-3 h-3 mr-1" />
                Milestone
              </Badge>
            )}
            <div className="flex items-center gap-1 text-xs text-muted-foreground ml-auto">
              <Clock className="w-3 h-3" />
              <span>{lesson.estimatedMinutes} min</span>
            </div>
          </div>

          <SheetTitle className="text-xl font-bold text-left">
            {lesson.title}
          </SheetTitle>

          <SheetDescription className="text-left">
            {lesson.description}
          </SheetDescription>
        </SheetHeader>

        <Separator className="my-4" />

        {/* Lesson Content */}
        <div className="prose prose-sm max-w-none dark:prose-invert">
          {loadingContent && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading lesson content...
            </div>
          )}
          {!loadingContent && content.split("\n").map((line, index) => {
            if (line.startsWith("## ")) {
              return (
                <h2 key={index} className="text-lg font-bold mt-6 mb-3">
                  {line.replace("## ", "")}
                </h2>
              )
            }
            if (line.startsWith("### ")) {
              return (
                <h3 key={index} className="text-base font-semibold mt-4 mb-2">
                  {line.replace("### ", "")}
                </h3>
              )
            }
            if (line.startsWith("- **")) {
              const match = line.match(/- \*\*(.+?)\*\* - (.+)/)
              if (match) {
                return (
                  <div key={index} className="flex gap-2 mb-2">
                    <span className="font-semibold">{match[1]}:</span>
                    <span className="text-muted-foreground">{match[2]}</span>
                  </div>
                )
              }
            }
            if (line.startsWith("- ")) {
              return (
                <li key={index} className="ml-4 mb-1">
                  {line.replace("- ", "")}
                </li>
              )
            }
            if (line.match(/^\d+\./)) {
              return (
                <div key={index} className="mb-2">
                  {line}
                </div>
              )
            }
            if (line.startsWith("*") && line.endsWith("*")) {
              return (
                <p key={index} className="text-muted-foreground italic my-4">
                  {line.replace(/\*/g, "")}
                </p>
              )
            }
            if (line === "---") {
              return <Separator key={index} className="my-4" />
            }
            if (line.trim()) {
              return (
                <p key={index} className="mb-3">
                  {line}
                </p>
              )
            }
            return null
          })}
        </div>

        <Separator className="my-6" />

        {/* Footer Actions */}
        <SheetFooter className="flex-col sm:flex-row gap-3">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="w-full sm:w-auto min-h-[44px]"
          >
            <X className="w-4 h-4 mr-2" />
            Back to All Lessons
          </Button>

          {!isCompleted ? (
            <Button
              onClick={handleMarkAsRead}
              disabled={isMarking}
              className="w-full sm:w-auto min-h-[44px]"
            >
              {isMarking ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Marking...
                </>
              ) : (
                <>
                  <Check className="w-4 h-4 mr-2" />
                  Mark as Read
                </>
              )}
            </Button>
          ) : (
            <Button disabled className="w-full sm:w-auto min-h-[44px] bg-green-600">
              <Check className="w-4 h-4 mr-2" />
              Completed
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
