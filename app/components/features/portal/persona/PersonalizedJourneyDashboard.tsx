"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { CheckCircle2, Clock, ChevronRight, FileText, Video, Calculator, BookOpen, Play, Download, ExternalLink, Lightbulb, Target, Type as type, type LucideIcon } from "lucide-react"
import Link from "next/link"
import { getPersonaConfig, getPersonaJourneyStages, calculateJourneyProgress } from "@/lib/portal"
import { cn } from "@/lib/utils"

interface Contact {
  id: string
  first_name: string
  last_name?: string
  contact_type?: string
  contact_persona?: string
  custom_fields?: Record<string, any>
}

interface Milestone {
  id: string
  milestone_name?: string
  name?: string
  status: string
  target_date?: string
  due_date?: string
  completed_date?: string
  notes?: string
  description?: string
  stage_id?: string
}

interface TaskCompletion {
  id: string
  contact_id: string
  task_id: string
  stage_id?: string
  completed_at: string
}

interface StageProgress {
  id?: string
  contact_id: string
  current_stage_id?: string
  current_stage_index?: number
  stages_completed?: number
}

interface PersonalizedJourneyDashboardProps {
  contact: Contact
  milestones: Milestone[]
  taskCompletions?: TaskCompletion[]
  stageProgress?: StageProgress | null
}

export default function PersonalizedJourneyDashboard({ 
  contact, 
  milestones, 
  taskCompletions = [],
  stageProgress 
}: PersonalizedJourneyDashboardProps) {
  const persona = contact.contact_persona || "first_time_buyer"
  const config = getPersonaConfig(persona)
  const stages = getPersonaJourneyStages(persona)
  const PersonaIcon = config.icon

  // Use shared journey progress calculation (same as dashboard)
  const journeyProgress = calculateJourneyProgress(
    stages,
    taskCompletions,
    stageProgress,
    milestones
  )

  const { 
    stages: stagesWithCompletions, 
    currentStageIndex, 
    progressPercent: overallProgress,
    totalTasks,
    completedTasks 
  } = journeyProgress

  const [activeTab, setActiveTab] = useState("stages")
  const [expandedStage, setExpandedStage] = useState<string>(stages[currentStageIndex]?.id || stages[0]?.id || "")

  const getStageStatus = (index: number): "completed" | "current" | "upcoming" => {
    if (index < currentStageIndex) return "completed"
    if (index === currentStageIndex) return "current"
    return "upcoming"
  }

  const getResourceIcon = (type: string): LucideIcon => {
    switch (type) {
      case "pdf":
        return FileText
      case "video":
        return Video
      case "calculator":
      case "tool":
        return Calculator
      case "guide":
        return BookOpen
      case "checklist":
        return CheckCircle2
      default:
        return FileText
    }
  }

  // For display purposes, use stagesWithCompletions from shared calculation
  const displayStages = stagesWithCompletions

  const getStageMilestones = (index: number): Milestone[] => {
    return milestones.filter((milestone) => milestone.stage_id === stages[index].id)
  }

  const completedCount = milestones.filter((milestone) => milestone.status === "completed").length
  const totalMilestones = milestones.length

  return (
    <div className="space-y-6">
      {/* Header with Progress */}
      <Card className={cn(config.bgColor, "border-none shadow-lg")}>
        <CardContent className="p-6">
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-4">
            <div className="flex items-center gap-4">
              <div className={cn("p-4 rounded-2xl bg-white shadow-md", config.color)}>
                <PersonaIcon className="w-8 h-8" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-slate-900">{config.title}</h1>
                <p className="text-slate-600">Welcome, {contact.first_name}! Here's your personalized journey guide.</p>
              </div>
            </div>
            <Button variant="outline" asChild>
              <Link href={`/portal/${contact.id}`}>Back to Dashboard</Link>
            </Button>
          </div>

          {/* Progress Bar */}
          <div className="bg-white/80 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-slate-700">
                Stage {currentStageIndex + 1} of {stages.length}: {stages[currentStageIndex]?.name || "Getting Started"}
              </span>
              <span className="text-sm font-bold text-slate-900">{Math.round(overallProgress)}% Complete</span>
            </div>
            <Progress value={overallProgress} className="h-3" />
            <div className="flex justify-between mt-3">
              {stages.map((stage, idx) => {
                const status = getStageStatus(idx)
                return (
                  <div key={stage.id} className="flex flex-col items-center" style={{ flex: 1 }}>
                    <div
                      className={cn(
                        "w-4 h-4 rounded-full transition-all",
                        status === "completed" && "bg-green-500",
                        status === "current" && "bg-blue-500 ring-4 ring-blue-200",
                        status === "upcoming" && "bg-slate-300",
                      )}
                      title={stage.name}
                    />
                    <span className="text-[10px] text-slate-500 mt-1 text-center hidden md:block max-w-[80px] truncate">
                      {stage.name}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Support message for sensitive personas */}
          {config.supportMessage && (
            <div className="mt-4 p-4 bg-white/80 rounded-xl border border-white">
              <p className="text-sm text-slate-700 italic">{config.supportMessage}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Main Content */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="stages">Journey Stages</TabsTrigger>
          <TabsTrigger value="resources">Resources</TabsTrigger>
          <TabsTrigger value="milestones">My Milestones</TabsTrigger>
        </TabsList>

        {/* Stages Tab */}
        <TabsContent value="stages" className="mt-4">
          <Accordion type="single" collapsible value={expandedStage} onValueChange={setExpandedStage}>
            {displayStages.map((stage: any, index: number) => {
              const status = getStageStatus(index)
              const completedTasksInStage = stage.tasks?.filter((t: any) => t.completed).length || 0
              const totalTasksInStage = stage.tasks?.length || 0
              const stageMilestones = getStageMilestones(index)
              const stageCompletedTasks = stageMilestones.filter((m) => m.status === "completed").length

              return (
                <AccordionItem key={stage.id} value={stage.id} className="mb-3">
                  <Card
                    className={cn(
                      "transition-all",
                      status === "current" && `border-2 ${config.borderColor} shadow-md`,
                      status === "completed" && "bg-green-50/50",
                    )}
                  >
                    <AccordionTrigger className="px-6 py-4 hover:no-underline">
                      <div className="flex items-center gap-4 w-full">
                        <div
                          className={cn(
                            "w-12 h-12 rounded-full flex items-center justify-center shrink-0",
                            status === "completed" && "bg-green-500",
                            status === "current" && config.bgColor,
                            status === "upcoming" && "bg-slate-200",
                          )}
                        >
                          {status === "completed" ? (
                            <CheckCircle2 className="w-6 h-6 text-white" />
                          ) : status === "current" ? (
                            <Clock className={cn("w-6 h-6", config.color)} />
                          ) : (
                            <span className="text-lg font-bold text-slate-500">{index + 1}</span>
                          )}
                        </div>
                        <div className="flex-1 text-left">
                          <div className="flex items-center gap-2">
                            <h3 className="text-lg font-semibold">{stage.name}</h3>
                            <Badge
                              variant={
                                status === "current" ? "default" : status === "completed" ? "secondary" : "outline"
                              }
                            >
                              {status === "completed" ? "Completed" : status === "current" ? "In Progress" : "Upcoming"}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {stage.description}
                            {stage.estimatedDays && (
                              <span className="ml-2 text-xs">• Est. {stage.estimatedDays} days</span>
                            )}
                          </p>
                        </div>
                        {stageMilestones.length > 0 && (
                          <div className="text-right mr-4 shrink-0">
                            <p className="text-sm font-medium">
                              {stageCompletedTasks}/{stageMilestones.length}
                            </p>
                            <p className="text-xs text-muted-foreground">Tasks</p>
                          </div>
                        )}
                      </div>
                    </AccordionTrigger>

                    <AccordionContent>
                      <CardContent className="pt-0 space-y-6">
                        {/* Tasks */}
                        <div>
                          <h4 className="font-medium mb-3 text-sm text-slate-600 flex items-center gap-2">
                            <Target className="w-4 h-4" />
                            Tasks to Complete
                          </h4>
                          <div className="space-y-2">
                            {stage.tasks.map((task: any, taskIdx: any) => {
                              const milestone = stageMilestones[taskIdx]
                              const isCompleted = milestone?.status === "completed" || status === "completed"

                              return (
                                <div key={task.id} className="flex items-start gap-3 p-3 rounded-lg hover:bg-slate-50">
                                  <div
                                    className={cn(
                                      "w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 shrink-0",
                                      isCompleted
                                        ? "bg-green-500 border-green-500"
                                        : task.required
                                          ? "border-orange-400"
                                          : "border-slate-300",
                                    )}
                                  >
                                    {isCompleted && <CheckCircle2 className="w-3 h-3 text-white" />}
                                  </div>
                                  <div className="flex-1">
                                    <span className={cn("text-sm", isCompleted && "line-through text-slate-400")}>
                                      {task.title}
                                      {task.required && !isCompleted && (
                                        <Badge variant="outline" className="ml-2 text-[10px] py-0">
                                          Required
                                        </Badge>
                                      )}
                                    </span>
                                    {task.description && (
                                      <p className="text-xs text-muted-foreground mt-1">{task.description}</p>
                                    )}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </div>

                        {/* Resources */}
                        {stage.resources.length > 0 && (
                          <div>
                            <h4 className="font-medium mb-3 text-sm text-slate-600 flex items-center gap-2">
                              <BookOpen className="w-4 h-4" />
                              Helpful Resources
                            </h4>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                              {stage.resources.map((resource: any, resourceIdx: any) => {
                                const ResourceIcon = getResourceIcon(resource.type)
                                return (
                                  <Button
                                    key={resourceIdx}
                                    variant="outline"
                                    className="justify-start h-auto py-3 px-4 bg-transparent"
                                  >
                                    <ResourceIcon className="w-4 h-4 mr-3 text-slate-500 shrink-0" />
                                    <div className="text-left flex-1 min-w-0">
                                      <p className="text-sm font-medium truncate">{resource.title}</p>
                                      <p className="text-xs text-slate-500 capitalize">{resource.type}</p>
                                    </div>
                                    {resource.type === "video" ? (
                                      <Play className="w-4 h-4 text-slate-400 shrink-0" />
                                    ) : resource.type === "tool" || resource.type === "calculator" ? (
                                      <ExternalLink className="w-4 h-4 text-slate-400 shrink-0" />
                                    ) : (
                                      <Download className="w-4 h-4 text-slate-400 shrink-0" />
                                    )}
                                  </Button>
                                )
                              })}
                            </div>
                          </div>
                        )}

                        {/* Tips */}
                        {stage.tips && stage.tips.length > 0 && (
                          <div className={cn("p-4 rounded-lg", config.bgColor)}>
                            <h4 className="font-medium mb-2 text-sm flex items-center gap-2">
                              <Lightbulb className={cn("w-4 h-4", config.color)} />
                              Pro Tips
                            </h4>
                            <ul className="space-y-1">
                              {stage.tips.map((tip: any, tipIdx: any) => (
                                <li key={tipIdx} className="text-sm text-slate-700 flex items-start gap-2">
                                  <span
                                    className={cn(
                                      "mt-1.5 w-1.5 h-1.5 rounded-full shrink-0",
                                      config.color.replace("text-", "bg-"),
                                    )}
                                  />
                                  {tip}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </CardContent>
                    </AccordionContent>
                  </Card>
                </AccordionItem>
              )
            })}
          </Accordion>
        </TabsContent>

        {/* Resources Tab */}
        <TabsContent value="resources" className="mt-4">
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {stages
              .flatMap((stage) =>
                stage.resources.map((resource) => ({
                  ...resource,
                  stageName: stage.name,
                })),
              )
              .map((resource, idx) => {
                const ResourceIcon = getResourceIcon(resource.type)
                return (
                  <Card key={idx} className="hover:shadow-md transition-shadow">
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <div className={cn("p-2 rounded-lg", config.bgColor)}>
                          <ResourceIcon className={cn("w-5 h-5", config.color)} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{resource.title}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            <Badge variant="outline" className="text-[10px]">
                              {resource.type}
                            </Badge>
                            <span className="ml-2">{resource.stageName}</span>
                          </p>
                        </div>
                      </div>
                      <Button variant="outline" size="sm" className="w-full mt-3 bg-transparent">
                        {resource.type === "video"
                          ? "Watch"
                          : resource.type === "tool" || resource.type === "calculator"
                            ? "Open"
                            : "Download"}
                        <ChevronRight className="w-4 h-4 ml-1" />
                      </Button>
                    </CardContent>
                  </Card>
                )
              })}
          </div>
        </TabsContent>

        {/* Milestones Tab */}
        <TabsContent value="milestones" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Your Milestones</CardTitle>
              <CardDescription>
                Track your progress through each milestone. {completedCount} of {totalMilestones} completed.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {milestones.length > 0 ? (
                <div className="space-y-3">
                  {milestones.map((milestone, idx) => (
                    <div
                      key={milestone.id || idx}
                      className={cn(
                        "flex items-center gap-4 p-4 rounded-lg border",
                        milestone.status === "completed" && "bg-green-50 border-green-200",
                        milestone.status === "in_progress" && `${config.bgColor} ${config.borderColor}`,
                      )}
                    >
                      <div
                        className={cn(
                          "w-10 h-10 rounded-full flex items-center justify-center shrink-0",
                          milestone.status === "completed" && "bg-green-500",
                          milestone.status === "in_progress" && "bg-blue-500",
                          milestone.status === "pending" && "bg-slate-200",
                        )}
                      >
                        {milestone.status === "completed" ? (
                          <CheckCircle2 className="w-5 h-5 text-white" />
                        ) : milestone.status === "in_progress" ? (
                          <Clock className="w-5 h-5 text-white" />
                        ) : (
                          <span className="text-sm font-medium text-slate-500">{idx + 1}</span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium">{milestone.milestone_name || milestone.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {milestone.target_date
                            ? milestone.status === "completed"
                              ? `Completed: ${new Date(milestone.target_date).toLocaleDateString()}`
                              : `Due: ${new Date(milestone.target_date).toLocaleDateString()}`
                            : "Date TBD"}
                        </p>
                        {(milestone.notes || milestone.description) && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {milestone.notes || milestone.description}
                          </p>
                        )}
                      </div>
                      <Badge
                        variant={
                          milestone.status === "completed"
                            ? "default"
                            : milestone.status === "in_progress"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {milestone.status === "completed"
                          ? "Complete"
                          : milestone.status === "in_progress"
                            ? "In Progress"
                            : "Pending"}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 text-muted-foreground">
                  <Clock className="w-12 h-12 mx-auto mb-4 text-slate-300" />
                  <p className="text-lg font-medium">No milestones yet</p>
                  <p className="text-sm">Your journey milestones will appear here as you progress.</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
