"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { ChevronRight, CheckCircle2 } from "lucide-react"
import Link from "next/link"
import { getPersonaConfig, formatWidgetValue } from "@/lib/portal"
import { cn } from "@/lib/utils"

interface Contact {
  id: string
  first_name: string
  last_name?: string
  contact_type?: string
  contact_persona?: string
  custom_fields?: Record<string, any>
  budget_min?: number
  budget_max?: number
  timeline?: string
}

interface PersonaWidgetGridProps {
  contact: Contact
  transactions?: any[]
  milestones?: any[]
  showings?: any[]
  savedProperties?: any[]
  offers?: any[]
}

// Helper to compute derived values from contact data
function computeDerivedValues(contact: Contact): Record<string, any> {
  const customFields = contact.custom_fields || {}
  const derived: Record<string, any> = { ...customFields }

  // Budget display
  if (contact.budget_min && contact.budget_max) {
    derived.budget_display = `${formatWidgetValue(contact.budget_min, "currency")} - ${formatWidgetValue(contact.budget_max, "currency")}`
  } else if (contact.budget_max) {
    derived.budget_display = `Up to ${formatWidgetValue(contact.budget_max, "currency")}`
  }

  // Military branch + rank
  if (customFields.military_branch && customFields.rank) {
    derived.military_branch_rank = `${customFields.military_branch} - ${customFields.rank}`
  } else if (customFields.military_branch) {
    derived.military_branch_rank = customFields.military_branch
  }

  // Timeline display
  if (contact.timeline) {
    const timelineLabels: Record<string, string> = {
      immediate: "Immediate",
      "30_days": "30 Days",
      "60_days": "60 Days",
      "90_days": "90 Days",
      "6_months": "6 Months",
      "12_months": "12 Months",
      "12_plus_months": "12+ Months",
    }
    derived.timeline_display = timelineLabels[contact.timeline] || contact.timeline
  }

  return derived
}

export default function PersonaWidgetGrid({
  contact,
  transactions = [],
  milestones = [],
  showings = [],
  savedProperties = [],
  offers = [],
}: PersonaWidgetGridProps) {
  const persona = contact.contact_persona || "first_time_buyer"
  const config = getPersonaConfig(persona)
  const derivedValues = computeDerivedValues(contact)

  // Calculate transaction-based stats
  const activeTransaction = transactions.find((t) => t.status === "under_contract" || t.status === "pending")
  const completedMilestones = milestones.filter((m) => m.status === "completed").length
  const totalMilestones = milestones.length || 1
  const journeyProgress = Math.round((completedMilestones / totalMilestones) * 100)

  return (
    <div className="space-y-6">
      {/* Persona-Specific Data Widgets */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {config.widgets.map((widget) => {
          const value = derivedValues[widget.dataKey]
          const hasValue = value !== undefined && value !== null && value !== ""
          const displayValue = hasValue ? formatWidgetValue(value, widget.format) : null
          const WidgetIcon = widget.icon

          return (
            <Card
              key={widget.id}
              className={cn("hover:shadow-md transition-all", !hasValue && "border-dashed", config.borderColor)}
            >
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className={cn("p-2 rounded-lg", config.bgColor, config.color)}>
                    <WidgetIcon className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-muted-foreground truncate">{widget.title}</p>
                    {hasValue ? (
                      <p className="text-lg font-semibold truncate" title={displayValue || ""}>
                        {displayValue}
                      </p>
                    ) : (
                      <div className="mt-1">
                        <p className="text-sm text-muted-foreground italic">{widget.emptyMessage || "Not set"}</p>
                        {widget.action && (
                          <Button variant="link" size="sm" className="h-auto p-0 text-xs" asChild>
                            <Link href={widget.action.href.replace("{contactId}", contact.id)}>
                              {widget.action.label} <ChevronRight className="w-3 h-3 ml-1" />
                            </Link>
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Transaction Status Widget - Only if active transaction exists */}
      {activeTransaction && (
        <Card className={cn("border-2", config.borderColor)}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-green-500" />
                  Active Transaction
                </CardTitle>
                <CardDescription>{activeTransaction.property_address}</CardDescription>
              </div>
              <Badge variant="default">{activeTransaction.status?.replace("_", " ").toUpperCase()}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              {activeTransaction.purchase_price && (
                <div>
                  <p className="text-muted-foreground">Purchase Price</p>
                  <p className="font-semibold">{formatWidgetValue(activeTransaction.purchase_price, "currency")}</p>
                </div>
              )}
              {activeTransaction.contract_date && (
                <div>
                  <p className="text-muted-foreground">Contract Date</p>
                  <p className="font-semibold">{new Date(activeTransaction.contract_date).toLocaleDateString()}</p>
                </div>
              )}
              {activeTransaction.estimated_close_date && (
                <div>
                  <p className="text-muted-foreground">Est. Close Date</p>
                  <p className="font-semibold">
                    {new Date(activeTransaction.estimated_close_date).toLocaleDateString()}
                  </p>
                </div>
              )}
              <div>
                <p className="text-muted-foreground">Milestones</p>
                <p className="font-semibold">
                  {completedMilestones} / {totalMilestones} Complete
                </p>
              </div>
            </div>
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-muted-foreground">Progress to Closing</span>
                <span className="font-medium">{journeyProgress}%</span>
              </div>
              <Progress value={journeyProgress} className="h-2" />
            </div>
            <Button variant="outline" className="w-full bg-transparent" asChild>
              <Link href={`/portal/${contact.id}/transaction/${activeTransaction.id}`}>
                View Transaction Details <ChevronRight className="w-4 h-4 ml-2" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Quick Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {config.isBuyer && (
          <>
            <QuickStatCard
              label="Saved Properties"
              value={savedProperties.length}
              href={`/portal/${contact.id}/properties`}
              color="blue"
            />
            <QuickStatCard
              label="Upcoming Showings"
              value={showings.filter((s) => s.status !== "completed").length}
              href={`/portal/${contact.id}/showings`}
              color="purple"
            />
            <QuickStatCard
              label="Active Offers"
              value={offers.filter((o) => o.status === "pending" || o.status === "submitted").length}
              href={`/portal/${contact.id}/my-offer`}
              color="green"
            />
          </>
        )}
        {config.isSeller && (
          <>
            <QuickStatCard
              label="Showing Requests"
              value={showings.length}
              href={`/portal/${contact.id}/showings`}
              color="blue"
            />
            <QuickStatCard
              label="Offers Received"
              value={offers.length}
              href={`/portal/${contact.id}/offers`}
              color="green"
            />
          </>
        )}
        <QuickStatCard
          label="Journey Progress"
          value={`${journeyProgress}%`}
          href={`/portal/${contact.id}/journey`}
          color="orange"
        />
      </div>
    </div>
  )
}

// Quick stat card component
function QuickStatCard({
  label,
  value,
  href,
  color,
}: {
  label: string
  value: number | string
  href: string
  color: "blue" | "purple" | "green" | "orange"
}) {
  const colorClasses = {
    blue: "bg-blue-100 text-blue-600",
    purple: "bg-purple-100 text-purple-600",
    green: "bg-green-100 text-green-600",
    orange: "bg-orange-100 text-orange-600",
  }

  return (
    <Card className="hover:shadow-md transition-shadow cursor-pointer">
      <Link href={href}>
        <CardContent className="p-4">
          <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center mb-2", colorClasses[color])}>
            <span className="text-lg font-bold">{value}</span>
          </div>
          <p className="text-sm text-muted-foreground">{label}</p>
        </CardContent>
      </Link>
    </Card>
  )
}

// Loading skeleton
export function PersonaWidgetGridSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i}>
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <Skeleton className="w-9 h-9 rounded-lg" />
                <div className="flex-1">
                  <Skeleton className="h-3 w-16 mb-2" />
                  <Skeleton className="h-6 w-24" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i}>
            <CardContent className="p-4">
              <Skeleton className="w-10 h-10 rounded-lg mb-2" />
              <Skeleton className="h-4 w-20" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
