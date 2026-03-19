"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FileX, ExternalLink, AlertCircle } from "lucide-react"
import Link from "next/link"

interface MissingDisclosure {
  id: string
  transaction_id: string
  check_type: string
  check_label: string
  is_blocking: boolean
  transaction?: {
    property_address: string
    stage: string
    property_state?: string
  }
}

interface MissingDisclosuresPanelProps {
  missingDisclosures: MissingDisclosure[]
}

export function MissingDisclosuresPanel({ missingDisclosures }: MissingDisclosuresPanelProps) {
  // Group by disclosure type
  const disclosuresByType = missingDisclosures.reduce((acc, d) => {
    if (!acc[d.check_type]) {
      acc[d.check_type] = []
    }
    acc[d.check_type].push(d)
    return acc
  }, {} as Record<string, MissingDisclosure[]>)

  const blockingCount = missingDisclosures.filter(d => d.is_blocking).length

  if (missingDisclosures.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileX className="h-5 w-5 text-muted-foreground" />
            Missing Disclosures
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="rounded-full bg-green-500/10 p-3 mb-3">
              <FileX className="h-6 w-6 text-green-600" />
            </div>
            <p className="text-sm text-muted-foreground">All required disclosures are complete</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileX className="h-5 w-5 text-muted-foreground" />
            Missing Disclosures
          </CardTitle>
          <div className="flex items-center gap-2">
            {blockingCount > 0 && (
              <Badge variant="destructive">{blockingCount} Blocking</Badge>
            )}
            <Badge variant="secondary">{missingDisclosures.length} Total</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {Object.entries(disclosuresByType).slice(0, 4).map(([type, disclosures]) => (
          <div key={type} className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertCircle className={`h-4 w-4 ${disclosures.some(d => d.is_blocking) ? "text-destructive" : "text-orange-500"}`} />
                <span className="text-sm font-medium">{disclosures[0].check_label}</span>
              </div>
              <Badge variant="outline">{disclosures.length}</Badge>
            </div>
            <div className="space-y-1 pl-6">
              {disclosures.slice(0, 2).map((d) => (
                <div key={d.id} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground truncate max-w-[200px]">
                    {d.transaction?.property_address || "Unknown Property"}
                    {d.transaction?.property_state && (
                      <Badge variant="outline" className="ml-2 text-[10px] px-1 py-0">
                        {d.transaction.property_state}
                      </Badge>
                    )}
                  </span>
                  <Button variant="ghost" size="sm" className="h-6 px-2" asChild>
                    <Link href={`/dashboard/transactions/${d.transaction_id}`}>
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  </Button>
                </div>
              ))}
              {disclosures.length > 2 && (
                <span className="text-xs text-muted-foreground">
                  +{disclosures.length - 2} more transactions
                </span>
              )}
            </div>
          </div>
        ))}

        {Object.keys(disclosuresByType).length > 4 && (
          <Button variant="outline" className="w-full" asChild>
            <Link href="#transactions">
              View All Missing Disclosures
            </Link>
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
