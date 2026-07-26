"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Route, Loader2, Clock, ArrowRight, CheckCircle2 } from "lucide-react"
import { generateLearningPath } from "@/app/actions/ai-training-coaching"
import { incrementViewCount } from "@/app/actions/academy"

interface LearningPathPanelProps {
  agentId: string
  experienceLevel?: "new" | "intermediate" | "experienced"
  focusAreas?: string[]
}

const FOCUS_AREAS = [
  { id: "buyer_conversion", label: "Buyer Conversion" },
  { id: "seller_listing", label: "Seller Listing" },
  { id: "marketing", label: "Marketing" },
  { id: "communication", label: "Communication" },
  { id: "financial_literacy", label: "Financial Literacy" },
  { id: "compliance", label: "Compliance" },
  { id: "leadership", label: "Leadership" },
  { id: "technology", label: "Technology" },
]

export function LearningPathPanel({
  agentId,
  experienceLevel: initialLevel = "new",
  focusAreas: initialFocus = [],
}: LearningPathPanelProps) {
  const router = useRouter()
  const [learningPath, setLearningPath] = useState<any[]>([])
  const [generating, setGenerating] = useState(false)
  const [experienceLevel, setExperienceLevel] = useState<"new" | "intermediate" | "experienced">(initialLevel)
  const [selectedFocus, setSelectedFocus] = useState<string[]>(initialFocus)

  const handleToggleFocus = (id: string) => {
    setSelectedFocus((prev) => (prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]))
  }

  const handleGeneratePath = async () => {
    if (selectedFocus.length === 0) return
    setGenerating(true)
    try {
      const result = await generateLearningPath({
        agentId,
        focusAreas: selectedFocus,
        experienceLevel,
      })
      if (result?.steps) {
        setLearningPath(result.steps)
      }
    } catch (error) {
      console.error("Error generating learning path:", error)
    } finally {
      setGenerating(false)
    }
  }

  const handleStartStep = async (step: any) => {
    // Steps with a linked module open the in-app reader (which records the
    // view + serves the quiz); steps without one land on the Learning Center
    // search primed with the step title — never a button that goes nowhere.
    if (step.content_id) {
      await incrementViewCount(step.content_id)
      router.push(`/academy/module/${step.content_id}`)
    } else {
      router.push(`/academy?search=${encodeURIComponent(step.title ?? "")}`)
    }
  }

  const priorityColors: Record<string, string> = {
    high: "bg-red-100 text-red-800",
    medium: "bg-amber-100 text-amber-800",
    low: "bg-green-100 text-green-800",
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Route className="h-5 w-5 text-emerald-600" />
          My Learning Path
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Configuration */}
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-2 block">Experience Level</label>
            <Select
              value={experienceLevel}
              onValueChange={(v) => setExperienceLevel(v as "new" | "intermediate" | "experienced")}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">New Agent (0-1 years)</SelectItem>
                <SelectItem value="intermediate">Intermediate (1-3 years)</SelectItem>
                <SelectItem value="experienced">Experienced (3+ years)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block">Focus Areas</label>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {FOCUS_AREAS.map((area) => (
                <div key={area.id} className="flex items-center gap-2">
                  <Checkbox
                    id={area.id}
                    checked={selectedFocus.includes(area.id)}
                    onCheckedChange={() => handleToggleFocus(area.id)}
                  />
                  <label htmlFor={area.id} className="text-sm cursor-pointer">
                    {area.label}
                  </label>
                </div>
              ))}
            </div>
          </div>

          <Button onClick={handleGeneratePath} disabled={generating || selectedFocus.length === 0} className="w-full">
            {generating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Generating Path...
              </>
            ) : (
              "Generate Path"
            )}
          </Button>
        </div>

        {/* Learning Path Display */}
        {learningPath.length > 0 ? (
          <div className="space-y-4">
            <h4 className="font-medium">Your Personalized Path</h4>
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-muted" />

              <div className="space-y-4">
                {learningPath.map((step, index) => (
                  <div key={index} className="relative pl-10">
                    {/* Step number circle */}
                    <div className="absolute left-0 w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center text-sm font-medium">
                      {index + 1}
                    </div>

                    <div className="border rounded-lg p-4 bg-card">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <h5 className="font-medium">{step.title}</h5>
                          <p className="text-sm text-muted-foreground mt-1">{step.description}</p>
                          <div className="flex items-center gap-3 mt-2">
                            {step.estimated_time_minutes && (
                              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Clock className="h-3 w-3" />
                                {step.estimated_time_minutes} min
                              </span>
                            )}
                            {step.priority && (
                              <Badge variant="secondary" className={priorityColors[step.priority] || ""}>
                                {step.priority}
                              </Badge>
                            )}
                          </div>
                        </div>
                        <Button size="sm" variant="outline" onClick={() => handleStartStep(step)}>
                          Start <ArrowRight className="h-3 w-3 ml-1" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            <CheckCircle2 className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p>Generate your personalized learning path above</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
