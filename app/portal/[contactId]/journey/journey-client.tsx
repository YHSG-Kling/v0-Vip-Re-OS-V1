"use client"

import { useState, useRef } from "react"
import Link from "next/link"
import { motion, AnimatePresence } from "framer-motion"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/app/components/ui/collapsible"
import {
  CheckCircle2,
  Circle,
  Clock,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  MessageSquare,
  GraduationCap,
  Home,
  DollarSign,
  Calendar,
  FileText,
} from "lucide-react"
import type { PortalView } from "@/lib/kernel/portal"
import type { TransactionMilestone, TransactionData } from "./page"

interface JourneyClientProps {
  contactId: string
  contactName: string
  portalView: PortalView
  transaction: TransactionData | null
  milestones: TransactionMilestone[]
  labelMap: Record<string, string>
  responsiblePartyMap: Record<string, string>
  explanationMap: Record<string, string>
  lessonMap: Record<string, string>
}

export default function JourneyClient({
  contactId,
  contactName,
  portalView,
  transaction,
  milestones,
  labelMap,
  responsiblePartyMap,
  explanationMap,
  lessonMap,
}: JourneyClientProps) {
  const [expandedMilestones, setExpandedMilestones] = useState<Set<string>>(new Set())
  const printRef = useRef<HTMLDivElement>(null)

  const toggleExpanded = (milestoneId: string) => {
    setExpandedMilestones((prev) => {
      const next = new Set(prev)
      if (next.has(milestoneId)) {
        next.delete(milestoneId)
      } else {
        next.add(milestoneId)
      }
      return next
    })
  }

  // Find current milestone (first non-completed)
  const currentMilestoneIndex = milestones.findIndex(
    (m) => m.status !== "completed"
  )

  // Check if milestone is delayed
  const isDelayed = (milestone: TransactionMilestone) => {
    if (milestone.status === "completed") return false
    if (!milestone.milestone_date) return false
    const dueDate = new Date(milestone.milestone_date)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return dueDate < today
  }

  // Format date for display
  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return null
    const date = new Date(dateStr)
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  }

  // Format currency
  const formatCurrency = (amount: number | null) => {
    if (!amount) return null
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(amount)
  }

  // Get milestone status text
  const getStatusText = (milestone: TransactionMilestone, index: number) => {
    if (milestone.status === "completed" && milestone.completed_date) {
      return `Completed ${formatDate(milestone.completed_date)}`
    }
    if (index === currentMilestoneIndex) {
      return "In Progress"
    }
    if (milestone.milestone_date) {
      return `Expected ${formatDate(milestone.milestone_date)}`
    }
    return "Upcoming"
  }

  // Get milestone icon
  const getMilestoneIcon = (milestone: TransactionMilestone, index: number) => {
    if (milestone.status === "completed") {
      return (
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 text-green-600">
          <CheckCircle2 className="h-5 w-5" />
        </div>
      )
    }
    if (index === currentMilestoneIndex) {
      return (
        <div className="relative flex h-10 w-10 items-center justify-center">
          <div className="absolute inset-0 animate-ping rounded-full bg-primary/30" />
          <div className="relative flex h-10 w-10 items-center justify-center rounded-full border-2 border-primary bg-background">
            <Clock className="h-5 w-5 text-primary" />
          </div>
        </div>
      )
    }
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-muted-foreground/30 bg-background">
        <Circle className="h-5 w-5 text-muted-foreground/50" />
      </div>
    )
  }

  // Handle print/download
  const handleDownload = () => {
    window.print()
  }

  // Empty state
  if (!transaction) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-muted">
          <Home className="h-10 w-10 text-muted-foreground" />
        </div>
        <h2 className="mb-2 text-xl font-semibold">No Active Transaction</h2>
        <p className="mb-6 max-w-md text-muted-foreground">
          Your transaction timeline will appear here once your agent opens escrow.
          Check back soon!
        </p>
        <Link href={`/portal/${contactId}/messages`}>
          <Button variant="outline">
            <MessageSquare className="mr-2 h-4 w-4" />
            Message Your Agent
          </Button>
        </Link>
      </div>
    )
  }

  // Calculate progress
  const completedCount = milestones.filter((m) => m.status === "completed").length
  const progressPercent = milestones.length > 0 ? Math.round((completedCount / milestones.length) * 100) : 0

  return (
    <div className="space-y-6">
      {/* Transaction Header */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <CardTitle className="text-xl">
                {transaction.property_address || "Your Transaction"}
              </CardTitle>
              <CardDescription className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="capitalize">
                  {transaction.status?.replace(/_/g, " ") || "Active"}
                </Badge>
                {transaction.deal_type && (
                  <Badge variant="outline" className="capitalize">
                    {transaction.deal_type}
                  </Badge>
                )}
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              {transaction.close_date && (
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span>
                    <span className="text-muted-foreground">Close: </span>
                    <span className="font-medium">{formatDate(transaction.close_date)}</span>
                  </span>
                </div>
              )}
              {(transaction.purchase_price || transaction.offer_price) && (
                <div className="flex items-center gap-2">
                  <DollarSign className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">
                    {formatCurrency(transaction.purchase_price || transaction.offer_price)}
                  </span>
                  {transaction.list_price && transaction.list_price !== transaction.purchase_price && (
                    <span className="text-muted-foreground">
                      (List: {formatCurrency(transaction.list_price)})
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {/* Progress bar */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Progress</span>
              <span className="font-medium">{progressPercent}% Complete</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <motion.div
                className="h-full bg-primary"
                initial={{ width: 0 }}
                animate={{ width: `${progressPercent}%` }}
                transition={{ duration: 0.8, ease: "easeOut" }}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Milestone Timeline */}
      <Card ref={printRef}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Your Journey Timeline</CardTitle>
            <Button variant="outline" size="sm" onClick={handleDownload} className="print:hidden">
              <Download className="mr-2 h-4 w-4" />
              Download
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {milestones.length === 0 && (
            <div className="text-center py-8">
              <p className="text-muted-foreground text-sm">
                Your journey milestones will appear here as your agent updates your file.
              </p>
            </div>
          )}

          <div className="relative space-y-0">
            {/* Vertical line */}
            <div className="absolute left-5 top-5 bottom-5 w-0.5 bg-muted print:bg-gray-300" />

            <AnimatePresence>
              {milestones.map((milestone, index) => {
                const isExpanded = expandedMilestones.has(milestone.id)
                const delayed = isDelayed(milestone)
                const label = labelMap[milestone.milestone_name] || milestone.milestone_name?.replace(/_/g, " ") || "Milestone"
                const responsibleParty = responsiblePartyMap[milestone.milestone_name] || "Your Team"
                const explanation = explanationMap[milestone.milestone_name]
                const lessonKey = lessonMap[milestone.milestone_name]
                const isCurrent = index === currentMilestoneIndex

                return (
                  <motion.div
                    key={milestone.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.1, duration: 0.3 }}
                    className={`relative flex gap-4 pb-8 last:pb-0 ${
                      isCurrent ? "z-10" : ""
                    }`}
                  >
                    {/* Icon */}
                    <div className="relative z-10 flex-shrink-0">
                      {getMilestoneIcon(milestone, index)}
                    </div>

                    {/* Content */}
                    <div
                      className={`flex-1 rounded-lg border p-4 transition-colors ${
                        isCurrent
                          ? "border-primary bg-primary/5"
                          : milestone.status === "completed"
                          ? "border-green-200 bg-green-50/50"
                          : "border-muted"
                      }`}
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="space-y-1">
                          <h3 className="font-semibold">{label}</h3>
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            <span
                              className={`${
                                milestone.status === "completed"
                                  ? "text-green-600"
                                  : isCurrent
                                  ? "text-primary"
                                  : "text-muted-foreground"
                              }`}
                            >
                              {getStatusText(milestone, index)}
                            </span>
                            <span className="text-muted-foreground">|</span>
                            <span className="text-muted-foreground">
                              {responsibleParty}
                            </span>
                          </div>
                        </div>

                        {/* Delay warning */}
                        {delayed && (
                          <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">
                            <AlertTriangle className="mr-1 h-3 w-3" />
                            Delayed - contact your team
                          </Badge>
                        )}
                      </div>

                      {/* Expandable explanation */}
                      {explanation && (
                        <Collapsible open={isExpanded} onOpenChange={() => toggleExpanded(milestone.id)}>
                          <CollapsibleTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="mt-2 h-auto p-0 text-muted-foreground hover:text-foreground print:hidden"
                            >
                              {isExpanded ? (
                                <ChevronDown className="mr-1 h-4 w-4" />
                              ) : (
                                <ChevronRight className="mr-1 h-4 w-4" />
                              )}
                              What happens next?
                            </Button>
                          </CollapsibleTrigger>
                          <CollapsibleContent className="pt-2">
                            <p className="text-sm text-muted-foreground leading-relaxed">
                              {explanation}
                            </p>
                            {lessonKey && (
                              <Link
                                href={`/portal/${contactId}/learn?lesson=${lessonKey}`}
                                className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
                              >
                                <GraduationCap className="h-4 w-4" />
                                Learn more
                              </Link>
                            )}
                          </CollapsibleContent>
                        </Collapsible>
                      )}

                      {/* Print-only explanation */}
                      {explanation && (
                        <p className="mt-2 hidden text-sm text-gray-600 print:block">
                          {explanation}
                        </p>
                      )}
                    </div>
                  </motion.div>
                )
              })}
            </AnimatePresence>
          </div>
        </CardContent>
      </Card>

      {/* Help CTA */}
      <Card className="border-dashed print:hidden">
        <CardContent className="flex flex-col items-center justify-center gap-4 py-6 text-center sm:flex-row sm:text-left">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <MessageSquare className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold">Have a question about where things stand?</h3>
            <p className="text-sm text-muted-foreground">
              Your agent is here to help with any questions about your transaction.
            </p>
          </div>
          <Link href={`/portal/${contactId}/messages`}>
            <Button>
              <MessageSquare className="mr-2 h-4 w-4" />
              Send a Message
            </Button>
          </Link>
        </CardContent>
      </Card>

      {/* Print styles */}
      <style jsx global>{`
        @media print {
          body * {
            visibility: hidden;
          }
          .print-area,
          .print-area * {
            visibility: visible;
          }
          .print-area {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
          }
          .print\\:hidden {
            display: none !important;
          }
          .print\\:block {
            display: block !important;
          }
        }
      `}</style>
    </div>
  )
}
