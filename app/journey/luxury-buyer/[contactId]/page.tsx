"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { CheckCircle, Clock, AlertCircle, Crown } from "lucide-react"
import { useState } from "react"

const LUXURY_BUYER_STAGES = [
  {
    id: 1,
    name: "Luxury Portfolio Curation",
    tasks: [
      "Define luxury criteria and lifestyle needs",
      "Review exclusive off-market properties",
      "Schedule private showings",
      "Evaluate architectural styles and finishes",
    ],
    resources: [
      { title: "Luxury Market Report", type: "pdf" },
      { title: "Private Portfolio Access", type: "tool" },
      { title: "Luxury Home Features Guide", type: "guide" },
    ],
  },
  {
    id: 2,
    name: "Wealth Management Coordination",
    tasks: [
      "Consult with wealth advisor",
      "Review financing strategies (all-cash vs. jumbo)",
      "Explore 1031 exchange opportunities",
      "Verify liquid assets and proof of funds",
    ],
    resources: [
      { title: "Jumbo Loan Strategies", type: "guide" },
      { title: "Wealth Manager Introductions", type: "contact" },
    ],
  },
  {
    id: 3,
    name: "Property Due Diligence",
    tasks: [
      "Commission detailed property inspection",
      "Review HOA/community governance",
      "Evaluate property tax implications",
      "Analyze investment potential and appreciation",
    ],
    resources: [
      { title: "Luxury Property Inspection Checklist", type: "pdf" },
      { title: "HOA Analysis Report", type: "tool" },
    ],
  },
  {
    id: 4,
    name: "Discreet Negotiation",
    tasks: [
      "Submit confidential offer",
      "Negotiate terms with privacy maintained",
      "Structure contingencies strategically",
      "Finalize purchase agreement",
    ],
    resources: [{ title: "Luxury Negotiation Strategies", type: "guide" }],
  },
  {
    id: 5,
    name: "White-Glove Closing",
    tasks: [
      "Coordinate with luxury title company",
      "Arrange private closing location",
      "Finalize wire transfers",
      "Receive property keys and access codes",
    ],
    resources: [{ title: "Luxury Closing Concierge Services", type: "service" }],
  },
  {
    id: 6,
    name: "Move-In Coordination",
    tasks: [
      "Hire white-glove moving services",
      "Coordinate interior designer consultations",
      "Set up home automation systems",
      "Arrange property management (if applicable)",
    ],
    resources: [
      { title: "Luxury Service Provider Directory", type: "directory" },
      { title: "Smart Home Setup Guide", type: "guide" },
    ],
  },
]

export default function LuxuryBuyerJourneyPage({ params }: { params: Promise<{ contactId: string }> }) {
  const [currentStage, setCurrentStage] = useState(1)
  const progress = (currentStage / LUXURY_BUYER_STAGES.length) * 100

  return (
    <div className="container mx-auto py-8 max-w-6xl">
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <Crown className="h-5 w-5 text-purple-600" />
          <Badge className="bg-purple-600">Luxury Buyer</Badge>
          <span className="text-muted-foreground">Journey</span>
        </div>
        <h1 className="text-3xl font-bold">Your Luxury Acquisition Journey</h1>
        <p className="text-muted-foreground">White-glove service for discerning buyers</p>
      </div>

      <Card className="mb-8 border-purple-200 bg-gradient-to-br from-purple-50 to-white">
        <CardHeader>
          <CardTitle>Your Journey Progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">
                Stage {currentStage} of {LUXURY_BUYER_STAGES.length}
              </span>
              <span className="text-sm text-muted-foreground">{progress.toFixed(0)}% Complete</span>
            </div>
            <Progress value={progress} className="h-3" />
          </div>
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Exclusive Luxury Services</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-3 gap-4">
            <ResourceCard title="Off-Market Properties" description="Access exclusive pocket listings" />
            <ResourceCard title="Wealth Management Coordination" description="Strategic financial planning" />
            <ResourceCard title="Concierge Services" description="24/7 white-glove assistance" />
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {LUXURY_BUYER_STAGES.map((stage, index) => (
          <StageCard
            key={stage.id}
            stage={stage}
            status={index < currentStage - 1 ? "completed" : index === currentStage - 1 ? "current" : "upcoming"}
          />
        ))}
      </div>

      <Card className="mt-8 border-purple-200">
        <CardHeader>
          <CardTitle>Curated Recommendations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <RecommendationCard
            title="Exclusive Off-Market Listing"
            description="A $3.2M waterfront estate just became available. Private showing available this weekend."
            action="Schedule Viewing"
          />
          <RecommendationCard
            title="Jumbo Loan Advantage"
            description="Current rates favor strategic financing over all-cash. Consult your wealth advisor."
            action="Review Options"
          />
        </CardContent>
      </Card>
    </div>
  )
}

// Reuse StageCard, ResourceCard, and RecommendationCard components
function StageCard({ stage, status }: { stage: any; status: string }) {
  const statusConfig = {
    completed: { icon: CheckCircle, color: "bg-purple-500" },
    current: { icon: Clock, color: "bg-purple-600" },
    upcoming: { icon: AlertCircle, color: "bg-gray-300" },
  }
  const config = statusConfig[status as keyof typeof statusConfig]
  const Icon = config.icon

  return (
    <Card className={status === "current" ? "border-purple-500 border-2" : ""}>
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
