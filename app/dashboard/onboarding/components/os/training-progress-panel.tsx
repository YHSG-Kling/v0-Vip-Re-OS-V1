"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import Link from "next/link"
import { 
  GraduationCap, 
  Video,
  CheckCircle2,
  Play,
  Clock,
  Star
} from "lucide-react"

interface CourseProgress {
  id: string
  courseName: string
  category: string
  status: 'not_started' | 'in_progress' | 'passed' | 'failed'
  progressPct: number
  score: number | null
  isRequired: boolean
  estimatedMinutes: number
}

interface TrainingProgressPanelProps {
  courses: CourseProgress[]
  totalCompleted: number
  totalRequired: number
  overallProgress: number
}

const statusColors = {
  not_started: "bg-gray-100 text-gray-700",
  in_progress: "bg-blue-100 text-blue-700",
  passed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
}

const statusLabels = {
  not_started: "Not Started",
  in_progress: "In Progress",
  passed: "Passed",
  failed: "Retake Required",
}

export function TrainingProgressPanel({ 
  courses, 
  totalCompleted, 
  totalRequired, 
  overallProgress 
}: TrainingProgressPanelProps) {
  const inProgressCourses = courses.filter(c => c.status === 'in_progress')
  const notStartedRequired = courses.filter(c => c.status === 'not_started' && c.isRequired)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <GraduationCap className="h-4 w-4" />
          Training Progress
          <Badge variant="outline" className="ml-auto">
            {totalCompleted}/{totalRequired} Required
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Overall Progress */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Overall Progress</span>
            <span className="font-medium">{overallProgress}%</span>
          </div>
          <Progress value={overallProgress} className="h-2" />
        </div>

        {/* In Progress Courses */}
        {inProgressCourses.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase">Continue Learning</h4>
            {inProgressCourses.slice(0, 2).map((course) => (
              <div 
                key={course.id}
                className="flex items-center gap-3 p-2 rounded-lg border bg-card"
              >
                <div className="h-8 w-8 rounded-full bg-blue-100 flex items-center justify-center">
                  <Play className="h-4 w-4 text-blue-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{course.courseName}</p>
                  <div className="flex items-center gap-2">
                    <Progress value={course.progressPct} className="h-1 flex-1" />
                    <span className="text-xs text-muted-foreground">{course.progressPct}%</span>
                  </div>
                </div>
                <Link href={`/dashboard/onboarding/training`}>
                  <Button size="sm" variant="outline">Resume</Button>
                </Link>
              </div>
            ))}
          </div>
        )}

        {/* Not Started Required */}
        {notStartedRequired.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase">Up Next</h4>
            {notStartedRequired.slice(0, 2).map((course) => (
              <div 
                key={course.id}
                className="flex items-center gap-3 p-2 rounded-lg border bg-muted/30"
              >
                <div className="h-8 w-8 rounded-full bg-gray-100 flex items-center justify-center">
                  <Video className="h-4 w-4 text-gray-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">{course.courseName}</p>
                    {course.isRequired && (
                      <Badge variant="outline" className="text-xs">Required</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {course.estimatedMinutes} min
                  </div>
                </div>
                <Link href={`/dashboard/onboarding/training`}>
                  <Button size="sm">Start</Button>
                </Link>
              </div>
            ))}
          </div>
        )}

        {/* All Courses Link */}
        <Link href="/dashboard/onboarding/training">
          <Button variant="outline" size="sm" className="w-full">
            View All Courses
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
