"use client"

import { useState } from "react"
import { useParams } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, FileText, Scale, Home, DollarSign } from "lucide-react"

export default function EstateSaleJourneyPage() {
  const params = useParams()
  const [currentStage, setCurrentStage] = useState("probate")

  const stages = [
    { id: "probate", label: "Probate Process", icon: Scale, color: "bg-slate-600" },
    { id: "assessment", label: "Property Assessment", icon: Home, color: "bg-slate-600" },
    { id: "preparation", label: "Estate Prep", icon: FileText, color: "bg-slate-600" },
    { id: "sale", label: "Sale Process", icon: DollarSign, color: "bg-slate-600" },
    { id: "closing", label: "Closing & Distribution", icon: CheckCircle2, color: "bg-green-600" },
  ]

  const aiRecommendations = [
    { title: "Connect with Probate Attorney", priority: "high", reason: "Legal guidance needed for estate sale" },
    {
      title: "Schedule Estate Cleanout Service",
      priority: "medium",
      reason: "Property needs preparation before listing",
    },
  ]

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-zinc-100 p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-slate-900">Estate Sale Journey</h1>
          <p className="mt-2 text-slate-600">Compassionate guidance through probate sales</p>
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
