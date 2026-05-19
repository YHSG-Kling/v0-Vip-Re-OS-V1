"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { CheckCircle, Clock, AlertCircle, Home } from "lucide-react"
import { useState } from "react"

const DOWNSIZING_SELLER_STAGES = [
  {
    id: 1,
    name: "Downsizing Planning",
    tasks: [
      "Assess current home equity",
      "Define new home requirements (size, location)",
      "Create decluttering timeline",
      "Review financial goals for proceeds",
    ],
    resources: [
      { title: "Downsizing Decision Guide", type: "pdf" },
      { title: "Equity Calculator", type: "tool" },
      { title: "Decluttering Checklist", type: "pdf" },
    ],
  },
  {
    id: 2,
    name: "Decluttering & Estate Sale",
    tasks: [
      "Sort belongings (keep, donate, sell)",
      "Schedule estate sale or donation pickups",
      "Digitize important documents",
      "Downsize to essentials",
    ],
    resources: [
      { title: "Estate Sale Organizers Directory", type: "directory" },
      { title: "Donation Center Locator", type: "tool" },
    ],
  },
  {
    id: 3,
    name: "Home Preparation",
    tasks: [
      "Complete necessary repairs",
      "Stage home to highlight space",
      "Professional photography",
      "Create marketing materials",
    ],
    resources: [{ title: "Home Staging Tips for Empty Nesters", type: "guide" }],
  },
  {
    id: 4,
    name: "List & Market",
    tasks: [
      "Set competitive list price",
      "Launch marketing campaign",
      "Host open houses",
      "Review and respond to offers",
    ],
    resources: [{ title: "Pricing Strategy Report", type: "pdf" }],
  },
  {
    id: 5,
    name: "Offer Acceptance & Contingencies",
    tasks: [
      "Accept best offer",
      "Navigate buyer inspections",
      "Address repair requests",
      "Finalize sale contingencies",
    ],
    resources: [{ title: "Negotiation Guide for Sellers", type: "guide" }],
  },
  {
    id: 6,
    name: "Transition Planning",
    tasks: [
      "Secure new smaller home (buy or rent)",
      "Coordinate move-out timeline",
      "Transfer utilities and services",
      "Plan for closing day",
    ],
    resources: [
      { title: "Moving Timeline Checklist", type: "pdf" },
      { title: "Senior-Friendly Housing Options", type: "guide" },
    ],
  },
  {
    id: 7,
    name: "Closing & New Beginning",
    tasks: ["Final walkthrough preparation", "Sign closing documents", "Receive sale proceeds", "Move into new home"],
    resources: [{ title: "Closing Day Checklist", type: "pdf" }],
  },
]

export default function DownsizingSellerJourneyPage({ params }: { params: Promise<{ contactId: string }> }) {
  const [currentStage, setCurrentStage] = useState(2)
  const progress = (currentStage / DOWNSIZING_SELLER_STAGES.length) * 100

  return (
    <div className="container mx-auto py-8 max-w-6xl">
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <Home className="h-5 w-5 text-teal-600" />
          <Badge className="bg-teal-600">Downsizing Seller</Badge>
          <span className="text-muted-foreground">Journey</span>
        </div>
        <h1 className="text-3xl font-bold">Your Downsizing Journey</h1>
        <p className="text-muted-foreground">Transitioning to your next chapter with ease</p>
      </div>

      <Card className="mb-8 border-teal-200">
        <CardHeader>
          <CardTitle>Your Journey Progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">
                Stage {currentStage} of {DOWNSIZING_SELLER_STAGES.length}
              </span>
              <span className="text-sm text-muted-foreground">{progress.toFixed(0)}% Complete</span>
            </div>
            <Progress value={progress} className="h-3" />
          </div>
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Downsizing Support Resources</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-3 gap-4">
            <ResourceCard title="Estate Sale Services" description="Professional organizers & auctioneers" />
            <ResourceCard title="Decluttering Guide" description="Room-by-room strategies" />
            <ResourceCard title="Senior Housing Options" description="Active adult & accessible communities" />
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {DOWNSIZING_SELLER_STAGES.map((stage, index) => (
          <StageCard
            key={stage.id}
            stage={stage}
            status={index < currentStage - 1 ? "completed" : index === currentStage - 1 ? "current" : "upcoming"}
          />
        ))}
      </div>

      <Card className="mt-8 border-teal-200">
        <CardHeader>
          <CardTitle>Personalized Recommendations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <RecommendationCard
            title="Estate Sale Coordinator Available"
            description="Professional service can help you downsize efficiently and potentially earn $5K-$15K from items."
            action="Learn More"
          />
          <RecommendationCard
            title="Active Adult Communities Near You"
            description="Found 8 age-55+ communities within 10 miles with maintenance-free living."
            action="View Options"
          />
        </CardContent>
      </Card>
    </div>
  )
}

// Reuse components with teal theme
function StageCard({ stage, status }: { stage: any; status: string }) {
  const statusConfig = {
    completed: { icon: CheckCircle, color: "bg-teal-500" },
    current: { icon: Clock, color: "bg-teal-600" },
    upcoming: { icon: AlertCircle, color: "bg-gray-300" },
  }
  const config = statusConfig[status as keyof typeof statusConfig]
  const Icon = config.icon

  return (
    <Card className={status === "current" ? "border-teal-500 border-2" : ""}>
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
