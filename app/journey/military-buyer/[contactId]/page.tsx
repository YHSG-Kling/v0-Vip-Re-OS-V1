"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { CheckCircle, Clock, AlertCircle, Shield } from "lucide-react"
import { useState } from "react"

const MILITARY_BUYER_STAGES = [
  {
    id: 1,
    name: "PCS Orders Received",
    tasks: [
      "Submit PCS orders to agent",
      "Determine housing allowance (BAH)",
      "Research VA loan benefits",
      "Identify base proximity preferences",
    ],
    resources: [
      { title: "VA Loan Guide for Active Duty", type: "pdf" },
      { title: "BAH Calculator Tool", type: "tool" },
      { title: "Military Homebuying 101 Video", type: "video" },
    ],
  },
  {
    id: 2,
    name: "VA Loan Pre-Approval",
    tasks: [
      "Obtain Certificate of Eligibility (COE)",
      "Connect with VA-approved lender",
      "Submit financial documents",
      "Receive pre-approval letter",
    ],
    resources: [
      { title: "How to Get Your COE", type: "guide" },
      { title: "VA Loan Pre-Approval Checklist", type: "pdf" },
    ],
  },
  {
    id: 3,
    name: "Virtual Property Search",
    tasks: [
      "Define must-haves near base",
      "Schedule virtual tours",
      "Research base commute times",
      "Review school districts",
    ],
    resources: [
      { title: "Base Proximity Map", type: "map" },
      { title: "Virtual Tour Best Practices", type: "video" },
    ],
  },
  {
    id: 4,
    name: "Property Selection",
    tasks: [
      "Narrow to top 3 properties",
      "Schedule in-person visits (if possible)",
      "Compare properties",
      "Prepare offer strategy",
    ],
    resources: [{ title: "Property Comparison Worksheet", type: "tool" }],
  },
  {
    id: 5,
    name: "Offer & Negotiation",
    tasks: [
      "Submit offer with VA financing",
      "Request VA-specific contingencies",
      "Negotiate repairs (VA appraisal)",
      "Accept final terms",
    ],
    resources: [{ title: "VA Loan Offer Tips", type: "guide" }],
  },
  {
    id: 6,
    name: "Under Contract",
    tasks: [
      "Order VA appraisal",
      "Complete home inspection",
      "Finalize VA loan approval",
      "Coordinate PCS timeline with closing",
    ],
    resources: [{ title: "VA Appraisal Process", type: "video" }],
  },
  {
    id: 7,
    name: "Closing & Move",
    tasks: [
      "Final walkthrough",
      "Sign closing documents",
      "Coordinate moving dates with PCS",
      "Set up utilities with military discounts",
    ],
    resources: [
      { title: "Military Moving Checklist", type: "pdf" },
      { title: "Utility Providers with Military Discounts", type: "list" },
    ],
  },
]

export default function MilitaryBuyerJourneyPage({ params }: { params: { contactId: string } }) {
  const [currentStage, setCurrentStage] = useState(2)
  const progress = (currentStage / MILITARY_BUYER_STAGES.length) * 100

  return (
    <div className="container mx-auto py-8 max-w-6xl">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <Shield className="h-5 w-5 text-blue-600" />
          <Badge className="bg-blue-600">Military Buyer</Badge>
          <span className="text-muted-foreground">Journey</span>
        </div>
        <h1 className="text-3xl font-bold">Your Homebuying Journey</h1>
        <p className="text-muted-foreground">Active Duty PCS - Tailored for Military Families</p>
      </div>

      {/* Progress Overview */}
      <Card className="mb-8 border-blue-200">
        <CardHeader>
          <CardTitle>Your Journey Progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">
                Stage {currentStage} of {MILITARY_BUYER_STAGES.length}
              </span>
              <span className="text-sm text-muted-foreground">{progress.toFixed(0)}% Complete</span>
            </div>
            <Progress value={progress} className="h-3" />
          </div>
          <div className="flex items-center justify-between text-sm">
            <span>Current: {MILITARY_BUYER_STAGES[currentStage - 1].name}</span>
            <span className="text-muted-foreground">Est. 45 days to close</span>
          </div>
        </CardContent>
      </Card>

      {/* Military-Specific Resources */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Military Homebuying Resources</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-3 gap-4">
            <ResourceCard
              title="VA Loan Benefits Calculator"
              description="See your 0% down payment advantage"
              icon="calculator"
            />
            <ResourceCard
              title="Base Housing Office Contacts"
              description="Installation housing assistance"
              icon="phone"
            />
            <ResourceCard title="Military Relocation Guide" description="Everything you need for PCS" icon="book" />
          </div>
        </CardContent>
      </Card>

      {/* Journey Stages */}
      <div className="space-y-4">
        {MILITARY_BUYER_STAGES.map((stage, index) => (
          <StageCard
            key={stage.id}
            stage={stage}
            status={index < currentStage - 1 ? "completed" : index === currentStage - 1 ? "current" : "upcoming"}
          />
        ))}
      </div>

      {/* AI Recommendations */}
      <Card className="mt-8 border-green-200">
        <CardHeader>
          <CardTitle>AI Recommendations for You</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <RecommendationCard
            title="VA Loan Pre-Approval Ready"
            description="Based on your BAH and timeline, you're ready for pre-approval. Let's connect you with a VA specialist."
            action="Get Pre-Approved"
          />
          <RecommendationCard
            title="Properties Near Base"
            description="Found 12 homes within 15 minutes of base that fit your criteria and budget."
            action="View Properties"
          />
        </CardContent>
      </Card>
    </div>
  )
}

function StageCard({ stage, status }: { stage: any; status: string }) {
  const statusConfig = {
    completed: { icon: CheckCircle, color: "bg-green-500", textColor: "text-green-600" },
    current: { icon: Clock, color: "bg-blue-500", textColor: "text-blue-600" },
    upcoming: { icon: AlertCircle, color: "bg-gray-300", textColor: "text-gray-500" },
  }

  const config = statusConfig[status as keyof typeof statusConfig]
  const Icon = config.icon

  return (
    <Card className={status === "current" ? "border-blue-500 border-2" : ""}>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full ${config.color} flex items-center justify-center`}>
            <Icon className="h-6 w-6 text-white" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-lg">{stage.name}</CardTitle>
            <Badge variant={status === "current" ? "default" : "outline"} className="mt-1">
              {status === "completed" ? "Completed" : status === "current" ? "In Progress" : "Upcoming"}
            </Badge>
          </div>
        </div>
      </CardHeader>
      {(status === "current" || status === "completed") && (
        <CardContent className="space-y-4">
          <div>
            <h4 className="font-medium mb-2">Tasks:</h4>
            <div className="space-y-2">
              {stage.tasks.map((task: string, i: number) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="checkbox" checked={status === "completed" || i < 2} className="w-4 h-4" readOnly />
                  <span
                    className={`text-sm ${status === "completed" || i < 2 ? "line-through text-muted-foreground" : ""}`}
                  >
                    {task}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h4 className="font-medium mb-2">Resources:</h4>
            <div className="space-y-2">
              {stage.resources.map((resource: any, i: number) => (
                <div key={i} className="flex items-center justify-between p-2 border rounded">
                  <span className="text-sm">{resource.title}</span>
                  <Badge variant="outline" className="text-xs">
                    {resource.type}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  )
}

function ResourceCard({ title, description, icon }: { title: string; description: string; icon: string }) {
  return (
    <Card className="hover:shadow-md transition-shadow cursor-pointer">
      <CardContent className="pt-6">
        <h4 className="font-semibold mb-1">{title}</h4>
        <p className="text-sm text-muted-foreground">{description}</p>
        <Button variant="link" className="px-0 mt-2">
          Access Resource →
        </Button>
      </CardContent>
    </Card>
  )
}

function RecommendationCard({ title, description, action }: { title: string; description: string; action: string }) {
  return (
    <div className="flex items-start justify-between p-4 border rounded-lg">
      <div className="flex-1">
        <h4 className="font-medium mb-1">{title}</h4>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Button size="sm">{action}</Button>
    </div>
  )
}
