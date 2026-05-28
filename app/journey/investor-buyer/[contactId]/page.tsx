"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { CheckCircle, Clock, AlertCircle, TrendingUp } from "lucide-react"
import { useState } from "react"

const INVESTOR_BUYER_STAGES = [
  {
    id: 1,
    name: "Investment Strategy",
    tasks: [
      "Define investment goals (cash flow vs. appreciation)",
      "Determine target ROI and cap rate",
      "Identify target markets and property types",
      "Review financing options (conventional, hard money, cash)",
    ],
    resources: [
      { title: "Investment Property Analysis Tool", type: "tool" },
      { title: "Cap Rate Calculator", type: "calculator" },
      { title: "Market Trends Report", type: "pdf" },
    ],
  },
  {
    id: 2,
    name: "Market Analysis",
    tasks: [
      "Research rental demand and vacancy rates",
      "Analyze comparable rental prices",
      "Review property tax and insurance costs",
      "Evaluate neighborhood appreciation trends",
    ],
    resources: [
      { title: "Rental Market Analysis", type: "report" },
      { title: "Neighborhood Investment Score", type: "tool" },
    ],
  },
  {
    id: 3,
    name: "Property Evaluation",
    tasks: [
      "Calculate potential rental income",
      "Estimate renovation/repair costs",
      "Run cash flow projections",
      "Determine maximum purchase price",
    ],
    resources: [
      { title: "Investment Property Calculator", type: "tool" },
      { title: "1% Rule & 50% Rule Guide", type: "guide" },
    ],
  },
  {
    id: 4,
    name: "Due Diligence",
    tasks: [
      "Order property inspection",
      "Review rent roll (if multi-unit)",
      "Verify zoning and rental restrictions",
      "Analyze property condition report",
    ],
    resources: [{ title: "Investment Property Inspection Checklist", type: "pdf" }],
  },
  {
    id: 5,
    name: "Acquisition",
    tasks: [
      "Submit offer based on ROI targets",
      "Negotiate purchase price and terms",
      "Finalize financing",
      "Close on property",
    ],
    resources: [{ title: "Negotiation Strategies for Investors", type: "guide" }],
  },
  {
    id: 6,
    name: "Property Management Setup",
    tasks: [
      "Select property management company or self-manage",
      "List property for rent",
      "Screen and select tenants",
      "Execute lease agreements",
    ],
    resources: [
      { title: "Property Manager Selection Guide", type: "guide" },
      { title: "Tenant Screening Best Practices", type: "pdf" },
    ],
  },
]

export default function InvestorBuyerJourneyPage({ params }: { params: Promise<{ contactId: string }> }) {
  const [currentStage, setCurrentStage] = useState(3)
  const progress = (currentStage / INVESTOR_BUYER_STAGES.length) * 100

  return (
    <div className="container mx-auto py-8 max-w-6xl">
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <TrendingUp className="h-5 w-5 text-orange-600" />
          <Badge className="bg-orange-600">Investor Buyer</Badge>
          <span className="text-muted-foreground">Journey</span>
        </div>
        <h1 className="text-3xl font-bold">Your Investment Journey</h1>
        <p className="text-muted-foreground">Data-driven property acquisition</p>
      </div>

      <Card className="mb-8 border-orange-200">
        <CardHeader>
          <CardTitle>Investment Progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">
                Stage {currentStage} of {INVESTOR_BUYER_STAGES.length}
              </span>
              <span className="text-sm text-muted-foreground">{progress.toFixed(0)}% Complete</span>
            </div>
            <Progress value={progress} className="h-3" />
          </div>
          <div className="grid grid-cols-3 gap-4 pt-4 border-t">
            <div>
              <div className="text-2xl font-bold text-orange-600">8.2%</div>
              <div className="text-xs text-muted-foreground">Target Cap Rate</div>
            </div>
            <div>
              <div className="text-2xl font-bold">$2,400</div>
              <div className="text-xs text-muted-foreground">Monthly Cash Flow Goal</div>
            </div>
            <div>
              <div className="text-2xl font-bold">30 days</div>
              <div className="text-xs text-muted-foreground">Target Close</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Investor Tools & Resources</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-3 gap-4">
            <ResourceCard title="ROI Calculator" description="Analyze deal profitability" />
            <ResourceCard title="Market Data Reports" description="Rental trends & appreciation" />
            <ResourceCard title="1031 Exchange Guidance" description="Tax-deferred strategies" />
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {INVESTOR_BUYER_STAGES.map((stage, index) => (
          <StageCard
            key={stage.id}
            stage={stage}
            status={index < currentStage - 1 ? "completed" : index === currentStage - 1 ? "current" : "upcoming"}
          />
        ))}
      </div>

      <Card className="mt-8 border-orange-200">
        <CardHeader>
          <CardTitle>Investment Opportunities</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <RecommendationCard
            title="High Cash Flow Duplex"
            description="8.5% cap rate, 12% ROI. Both units rented with strong tenant history."
            action="Analyze Deal"
          />
          <RecommendationCard
            title="Value-Add Single Family"
            description="ARV $425K after $35K rehab. Purchase at $310K for instant equity."
            action="Review Numbers"
          />
        </CardContent>
      </Card>
    </div>
  )
}

// Reuse components with orange theme
function StageCard({ stage, status }: { stage: any; status: string }) {
  const statusConfig = {
    completed: { icon: CheckCircle, color: "bg-orange-500" },
    current: { icon: Clock, color: "bg-orange-600" },
    upcoming: { icon: AlertCircle, color: "bg-gray-300" },
  }
  const config = statusConfig[status as keyof typeof statusConfig]
  const Icon = config.icon

  return (
    <Card className={status === "current" ? "border-orange-500 border-2" : ""}>
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
