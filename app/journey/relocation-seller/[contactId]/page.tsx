"use client"

import { useState } from "react"
import { useParams } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, Home, FileText, Video } from "lucide-react"

export default function RelocationSellerJourneyPage() {
  const params = useParams()
  const [currentStage, setCurrentStage] = useState("assessment")

  const stages = [
    { id: "assessment", label: "Remote Assessment", icon: Video, color: "bg-orange-600" },
    { id: "prep", label: "Prep & Stage", icon: Home, color: "bg-orange-600" },
    { id: "marketing", label: "Marketing", icon: FileText, color: "bg-orange-600" },
    { id: "showings", label: "Remote Showings", icon: Video, color: "bg-orange-600" },
    { id: "closing", label: "Remote Closing", icon: CheckCircle2, color: "bg-green-600" },
  ]

  const aiRecommendations = [
    {
      title: "Arrange Virtual Walk-through",
      priority: "high",
      reason: "Seller already relocated, needs remote options",
    },
    {
      title: "Coordinate Local Service Vendors",
      priority: "medium",
      reason: "Seller cannot oversee repairs in person",
    },
  ]

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-100 p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-orange-900">Relocation Seller Journey</h1>
          <p className="mt-2 text-slate-600">Sell your home from anywhere</p>
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
  )
}
