"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Clock, User, Briefcase, Home, CheckCircle2, ExternalLink } from "lucide-react"
import { format } from "date-fns"
import Link from "next/link"

interface Transaction {
  id: string
  address: string
  status: string
  closeDate?: string | null
}

interface IsaHandoffContext {
  qualificationScore?: number
  qualificationResult?: string
  qualificationSignals?: Record<string, any>
  assignedAt?: string
}

interface TimelineContextPanelProps {
  contactId: string
  originalLeadSource?: string | null
  isaHandoffContext?: IsaHandoffContext | null
  transactionHistory?: Transaction[] | null
  createdAt?: string | null
}

export function TimelineContextPanel({
  contactId,
  originalLeadSource,
  isaHandoffContext,
  transactionHistory,
  createdAt,
}: TimelineContextPanelProps) {
  const topSignals = isaHandoffContext?.qualificationSignals
    ? Object.entries(isaHandoffContext.qualificationSignals).slice(0, 2)
    : []

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Clock className="h-4 w-4 text-gray-600" />
          Context & History
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Timeline */}
        <div className="relative pl-6 border-l-2 border-gray-200 space-y-4">
          {/* Contact created */}
          {createdAt && (
            <div className="relative">
              <div className="absolute -left-[25px] w-4 h-4 bg-white border-2 border-blue-500 rounded-full" />
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 text-blue-500" />
                <span className="text-sm font-medium">Contact Created</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {format(new Date(createdAt), "MMM d, yyyy")}
              </p>
            </div>
          )}

          {/* Lead source */}
          {originalLeadSource && (
            <div className="relative">
              <div className="absolute -left-[25px] w-4 h-4 bg-white border-2 border-indigo-500 rounded-full" />
              <div className="flex items-center gap-2">
                <Briefcase className="h-4 w-4 text-indigo-500" />
                <span className="text-sm font-medium">Lead Source</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{originalLeadSource}</p>
            </div>
          )}

          {/* ISA Handoff */}
          {isaHandoffContext && (
            <div className="relative">
              <div className="absolute -left-[25px] w-4 h-4 bg-white border-2 border-purple-500 rounded-full" />
              <div className="p-2 bg-purple-50 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <CheckCircle2 className="h-4 w-4 text-purple-500" />
                  <span className="text-sm font-medium">ISA Handoff</span>
                </div>
                <div className="flex gap-2 mb-1">
                  {isaHandoffContext.qualificationScore !== undefined && (
                    <Badge variant="outline" className="text-xs">
                      Score: {isaHandoffContext.qualificationScore}
                    </Badge>
                  )}
                  {isaHandoffContext.qualificationResult && (
                    <Badge variant="outline" className="text-xs">
                      {isaHandoffContext.qualificationResult}
                    </Badge>
                  )}
                </div>
                {topSignals.length > 0 && (
                  <div className="text-xs text-muted-foreground">
                    {topSignals.map(([key, value]) => (
                      <p key={key}>
                        {key}: {String(value)}
                      </p>
                    ))}
                  </div>
                )}
                {isaHandoffContext.assignedAt && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Assigned: {format(new Date(isaHandoffContext.assignedAt), "MMM d, yyyy")}
                  </p>
                )}
                <Link
                  href="/dashboard/isa"
                  className="inline-flex items-center gap-1 text-xs text-purple-600 hover:text-purple-800 mt-1"
                >
                  View ISA History
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            </div>
          )}

          {/* Transaction history */}
          {transactionHistory?.map((tx) => (
            <div key={tx.id} className="relative">
              <div className="absolute -left-[25px] w-4 h-4 bg-white border-2 border-emerald-500 rounded-full" />
              <div className="flex items-center gap-2">
                <Home className="h-4 w-4 text-emerald-500" />
                <span className="text-sm font-medium truncate">{tx.address}</span>
              </div>
              <div className="flex gap-2 mt-1">
                <Badge variant="outline" className="text-xs">
                  {tx.status}
                </Badge>
                {tx.closeDate && (
                  <span className="text-xs text-muted-foreground">
                    Closed: {format(new Date(tx.closeDate), "MMM d, yyyy")}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Empty state */}
        {!createdAt && !originalLeadSource && !isaHandoffContext && (!transactionHistory || transactionHistory.length === 0) && (
          <p className="text-sm text-muted-foreground text-center py-4">
            Timeline builds as relationship develops
          </p>
        )}
      </CardContent>
    </Card>
  )
}
