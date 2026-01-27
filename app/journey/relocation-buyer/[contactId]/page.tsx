"use client"

import { useState } from "react"
import { useParams } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, Circle, MapPin, FileText, Video, Plane } from "lucide-react"

export default function RelocationBuyerJourneyPage() {
  const params = useParams()
  const [currentStage, setCurrentStage] = useState("discovery")

  const stages = [
    { id: "discovery", label: "Area Discovery", icon: MapPin, color: "bg-purple-600" },
    { id: "virtual", label: "Virtual Tours", icon: Video, color: "bg-purple-600" },
    { id: "visit", label: "In-Person Visit", icon: Plane, color: "bg-purple-600" },
    { id: "offer", label: "Offer & Negotiate", icon: FileText, color: "bg-purple-600" },
    { id: "closing", label: "Remote Closing", icon: CheckCircle2, color: "bg-green-600" },
  ]

  const tasks = {
    discovery: [
      { id: 1, title: "Review neighborhood guides", completed: true },
      { id: 2, title: "Compare school districts", completed: false },
      { id: 3, title: "Watch area overview videos", completed: false },
    ],
  }

  const aiRecommendations = [
    { title: "Schedule Virtual Tour Package", priority: "high", reason: "Buyer is out-of-state, needs remote viewing" },
    { title: "Provide Neighborhood Data Reports", priority: "medium", reason: "Buyer unfamiliar with area" },
  ]

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-indigo-100 p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-purple-900">Relocation Buyer Journey</h1>
          <p className="mt-2 text-slate-600">Long-distance home search made easy</p>
        </div>

        <div className="mb-8 flex items-center gap-2 overflow-x-auto pb-4">
          {stages.map((stage, idx) => (
            <div key={stage.id} className="flex items-center">
              <div className="flex flex-col items-center">
                <div
                  className={`flex h-12 w-12 items-center justify-center rounded-full ${currentStage === stage.id ? stage.color : "bg-slate-300"} text-white`}
                >
                  <stage.icon className="h-6 w-6" />
                </div>
                <span className="mt-2 text-xs font-medium text-slate-700">{stage.label}</span>
              </div>
              {idx < stages.length - 1 && <div className="mx-2 h-0.5 w-12 bg-slate-300" />}
            </div>
          ))}
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card className="p-6">
              <h3 className="mb-4 text-lg font-semibold">Area Discovery Tasks</h3>
              {tasks[currentStage as keyof typeof tasks]?.map((task) => (
                <div key={task.id} className="mb-3 flex items-center gap-3">
                  {task.completed ? (
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                  ) : (
                    <Circle className="h-5 w-5 text-slate-400" />
                  )}
                  <span className={task.completed ? "text-slate-500 line-through" : "text-slate-900"}>
                    {task.title}
                  </span>
                </div>
              ))}
            </Card>
          </div>

          <div>
            <Card className="p-6">
              <h3 className="mb-4 text-lg font-semibold">AI Recommendations</h3>
              <div className="space-y-3">
                {aiRecommendations.map((rec, idx) => (
                  <div key={idx} className="rounded-lg border border-slate-200 p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-sm font-medium">{rec.title}</span>
                      <Badge variant={rec.priority === "high" ? "destructive" : "secondary"}>{rec.priority}</Badge>
                    </div>
                    <p className="text-xs text-slate-600">{rec.reason}</p>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
