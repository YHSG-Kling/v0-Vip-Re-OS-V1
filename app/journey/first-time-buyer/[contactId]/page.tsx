"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { CheckCircle, Clock, AlertCircle, Home } from "lucide-react"
import { useState } from "react"

const FIRST_TIME_BUYER_STAGES = [
  {
    id: 1,
    name: "Homebuying Education",
    tasks: [
      "Complete first-time homebuyer course",
      "Understand the buying process",
      "Learn about down payment assistance programs",
      "Review closing cost expectations",
    ],
    resources: [
      { title: "First-Time Buyer Complete Guide", type: "pdf" },
      { title: "Homebuying 101 Video Series", type: "video" },
      { title: "Down Payment Assistance Finder", type: "tool" },
    ],
  },
  {
    id: 2,
    name: "Financial Preparation",
    tasks: [
      "Review credit score",
      "Calculate comfortable monthly payment",
      "Save for down payment and closing costs",
      "Gather financial documents",
    ],
    resources: [
      { title: "Credit Score Guide", type: "guide" },
      { title: "Affordability Calculator", type: "tool" },
      { title: "Document Checklist", type: "pdf" },
    ],
  },
  {
    id: 3,
    name: "Mortgage Pre-Approval",
    tasks: [
      "Research loan types (FHA, conventional, etc.)",
      "Compare lender rates",
      "Submit mortgage application",
      "Receive pre-approval letter",
    ],
    resources: [
      { title: "FHA vs. Conventional Loans", type: "guide" },
      { title: "Lender Comparison Tool", type: "tool" },
    ],
  },
  {
    id: 4,
    name: "Home Search",
    tasks: ["Define must-haves vs. nice-to-haves", "Tour properties", "Research neighborhoods", "Attend open houses"],
    resources: [
      { title: "Home Search Checklist", type: "pdf" },
      { title: "Neighborhood Research Guide", type: "guide" },
    ],
  },
  {
    id: 5,
    name: "Making an Offer",
    tasks: ["Review comparable sales", "Determine offer price", "Include contingencies", "Submit offer"],
    resources: [
      { title: "How to Make a Competitive Offer", type: "video" },
      { title: "Contingencies Explained", type: "guide" },
    ],
  },
  {
    id: 6,
    name: "Under Contract",
    tasks: ["Schedule home inspection", "Review inspection report", "Finalize mortgage approval", "Complete appraisal"],
    resources: [
      { title: "What to Expect at Inspection", type: "video" },
      { title: "Inspection Red Flags Guide", type: "pdf" },
    ],
  },
  {
    id: 7,
    name: "Closing",
    tasks: [
      "Review closing disclosure",
      "Schedule final walkthrough",
      "Bring certified funds",
      "Sign closing documents",
    ],
    resources: [
      { title: "Closing Day Checklist", type: "pdf" },
      { title: "Understanding Your Closing Disclosure", type: "guide" },
    ],
  },
]

export default function FirstTimeBuyerJourneyPage({ params }: { params: Promise<{ contactId: string }> }) {
  const [currentStage, setCurrentStage] = useState(1)
  const progress = (currentStage / FIRST_TIME_BUYER_STAGES.length) * 100

  return (
    <div className="container mx-auto py-8 max-w-6xl">
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <Home className="h-5 w-5 text-green-600" />
          <Badge className="bg-green-600">First-Time Buyer</Badge>
          <span className="text-muted-foreground">Journey</span>
        </div>
        <h1 className="text-3xl font-bold">Your First Home Journey</h1>
        <p className="text-muted-foreground">Step-by-step guidance to homeownership</p>
      </div>

      <Card className="mb-8 border-green-200">
        <CardHeader>
          <CardTitle>Your Journey Progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">
                Stage {currentStage} of {FIRST_TIME_BUYER_STAGES.length}
              </span>
              <span className="text-sm text-muted-foreground">{progress.toFixed(0)}% Complete</span>
            </div>
            <Progress value={progress} className="h-3" />
          </div>
          <div className="flex items-center justify-between text-sm">
            <span>Current: {FIRST_TIME_BUYER_STAGES[currentStage - 1].name}</span>
            <span className="text-muted-foreground">Est. 60-90 days to close</span>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>First-Time Buyer Resources</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-3 gap-4">
            <ResourceCard title="FHA Loan Guide" description="Low down payment options explained" />
            <ResourceCard title="Down Payment Assistance" description="Find programs in your area" />
            <ResourceCard title="First-Time Buyer Tax Credits" description="Maximize your benefits" />
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {FIRST_TIME_BUYER_STAGES.map((stage, index) => (
          <StageCard
            key={stage.id}
            stage={stage}
            status={index < currentStage - 1 ? "completed" : index === currentStage - 1 ? "current" : "upcoming"}
          />
        ))}
      </div>

      <Card className="mt-8 border-green-200">
        <CardHeader>
          <CardTitle>AI Recommendations for You</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <RecommendationCard
            title="Complete Homebuyer Education Course"
            description="Many lenders offer rate discounts for completing this course. Takes 6-8 hours online."
            action="Start Course"
          />
          <RecommendationCard
            title="Down Payment Assistance Available"
            description="You qualify for up to $10,000 in down payment assistance in your area."
            action="Learn More"
          />
        </CardContent>
      </Card>
    </div>
  )
}

function StageCard({ stage, status }: { stage: any; status: string }) {
  const statusConfig = {
    completed: { icon: CheckCircle, color: "bg-green-500" },
    current: { icon: Clock, color: "bg-blue-500" },
    upcoming: { icon: AlertCircle, color: "bg-gray-300" },
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
                  <input type="checkbox" checked={status === "completed"} className="w-4 h-4" readOnly />
                  <span className={`text-sm ${status === "completed" ? "line-through text-muted-foreground" : ""}`}>
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

function ResourceCard({ title, description }: { title: string; description: string }) {
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
