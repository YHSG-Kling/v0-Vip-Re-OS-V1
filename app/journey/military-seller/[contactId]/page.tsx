"use client"

import { useState } from "react"
import { useParams } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CheckCircle2, Circle, Clock, FileText, Video, Mail } from "lucide-react"

export default function MilitarySellerJourneyPage() {
  const params = useParams()
  const contactId = params.contactId as string
  const [contact, setContact] = useState<any>(null)
  const [currentStage, setCurrentStage] = useState("intake")

  const stages = [
    { id: "intake", label: "PCS Orders Received", icon: FileText, color: "bg-blue-600" },
    { id: "timeline", label: "Timeline Planning", icon: Clock, color: "bg-blue-600" },
    { id: "va-prep", label: "VA Loan Prep", icon: FileText, color: "bg-blue-600" },
    { id: "pricing", label: "Pricing Strategy", icon: FileText, color: "bg-blue-600" },
    { id: "staging", label: "Quick Staging", icon: Video, color: "bg-blue-600" },
    { id: "marketing", label: "Active Marketing", icon: Mail, color: "bg-blue-600" },
    { id: "offers", label: "Offer Management", icon: FileText, color: "bg-blue-600" },
    { id: "closing", label: "Remote Closing", icon: CheckCircle2, color: "bg-green-600" },
  ]

  const tasks = {
    intake: [
      { id: 1, title: "Upload PCS orders", completed: true },
      { id: 2, title: "Confirm move date", completed: true },
      { id: 3, title: "Review housing allowance options", completed: false },
    ],
    timeline: [
      { id: 1, title: "Calculate quick-sale timeline", completed: false },
      { id: 2, title: "Coordinate with military relocation office", completed: false },
    ],
    "va-prep": [
      { id: 1, title: "Contact VA loan servicer", completed: false },
      { id: 2, title: "Review assumable loan options", completed: false },
    ],
  }

  const aiRecommendations = [
    { title: "Highlight VA Assumable Loan", priority: "high", reason: "Lower buyer costs can speed sale" },
    { title: "Offer Remote Signing Options", priority: "high", reason: "Seller may be relocated before closing" },
    {
      title: "Price Competitively for Quick Sale",
      priority: "medium",
      reason: "PCS timeline requires fast transaction",
    },
  ]

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-blue-900">Military Seller Journey</h1>
          <p className="mt-2 text-slate-600">PCS-specific home sale assistance</p>
        </div>

        {/* Stage Progress */}
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
          {/* Main Content */}
          <div className="lg:col-span-2">
            <Tabs defaultValue="tasks" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="tasks">Tasks</TabsTrigger>
                <TabsTrigger value="resources">Resources</TabsTrigger>
                <TabsTrigger value="timeline">Timeline</TabsTrigger>
              </TabsList>

              <TabsContent value="tasks">
                <Card className="p-6">
                  <h3 className="mb-4 text-lg font-semibold">Current Stage Tasks</h3>
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
              </TabsContent>

              <TabsContent value="resources">
                <Card className="p-6">
                  <h3 className="mb-4 text-lg font-semibold">Military Seller Resources</h3>
                  <div className="space-y-3">
                    <Button variant="outline" className="w-full justify-start bg-transparent">
                      <FileText className="mr-2 h-4 w-4" /> PCS Checklist
                    </Button>
                    <Button variant="outline" className="w-full justify-start bg-transparent">
                      <Video className="mr-2 h-4 w-4" /> VA Assumable Loan Guide
                    </Button>
                    <Button variant="outline" className="w-full justify-start bg-transparent">
                      <Mail className="mr-2 h-4 w-4" /> Remote Closing Process
                    </Button>
                  </div>
                </Card>
              </TabsContent>

              <TabsContent value="timeline">
                <Card className="p-6">
                  <h3 className="mb-4 text-lg font-semibold">PCS Sale Timeline</h3>
                  <div className="space-y-4">
                    <div className="flex items-start gap-3">
                      <Clock className="mt-1 h-5 w-5 text-blue-600" />
                      <div>
                        <p className="font-medium">Week 1-2: Prep & Price</p>
                        <p className="text-sm text-slate-600">Quick staging, photos, list with VA loan highlight</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <Clock className="mt-1 h-5 w-5 text-blue-600" />
                      <div>
                        <p className="font-medium">Week 3-4: Active Marketing</p>
                        <p className="text-sm text-slate-600">Open houses, showings, offer review</p>
                      </div>
                    </div>
                  </div>
                </Card>
              </TabsContent>
            </Tabs>
          </div>

          {/* AI Sidebar */}
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
