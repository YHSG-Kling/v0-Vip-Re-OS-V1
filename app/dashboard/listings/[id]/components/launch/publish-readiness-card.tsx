"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle2, XCircle, FileCheck, AlertTriangle } from "lucide-react"

interface PublishReadinessCardProps {
  listingId: string
  requiredFields: { field: string; complete: boolean }[]
  complianceBlockers: string[]
  packetReady: boolean
}

export function PublishReadinessCard({
  listingId,
  requiredFields,
  complianceBlockers,
  packetReady,
}: PublishReadinessCardProps) {
  const completedFields = requiredFields.filter(f => f.complete).length
  const allFieldsComplete = completedFields === requiredFields.length
  const noBlockers = complianceBlockers.length === 0
  const isReady = allFieldsComplete && noBlockers

  return (
    <Card className={isReady ? "border-green-200 bg-green-50/30" : "border-amber-200 bg-amber-50/30"}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <FileCheck className="h-4 w-4 text-indigo-600" />
            Publish Readiness
          </span>
          <Badge variant={isReady ? "default" : "secondary"} className="text-xs">
            {isReady ? "Ready" : `${requiredFields.length - completedFields} Missing`}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          {requiredFields.slice(0, 5).map((field, idx) => (
            <div key={idx} className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5">
                {field.complete ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-amber-500" />
                )}
                {field.field}
              </span>
            </div>
          ))}
          {requiredFields.length > 5 && (
            <p className="text-xs text-muted-foreground">
              +{requiredFields.length - 5} more fields
            </p>
          )}
        </div>

        {complianceBlockers.length > 0 && (
          <div className="p-2 bg-red-50 border border-red-200 rounded text-xs">
            <p className="font-medium text-red-700 flex items-center gap-1 mb-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              Compliance Blockers
            </p>
            {complianceBlockers.map((blocker, idx) => (
              <p key={idx} className="text-red-600 ml-5">- {blocker}</p>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between text-xs pt-2 border-t">
          <span>Listing Packet</span>
          <Badge variant={packetReady ? "default" : "outline"} className="text-xs">
            {packetReady ? "Ready" : "Not Generated"}
          </Badge>
        </div>

        <Link href={`/dashboard/listings/${listingId}/lifecycle`}>
          <Button size="sm" variant="outline" className="w-full text-xs">
            Fix Blockers
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
