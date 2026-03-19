"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FileWarning, ExternalLink, AlertTriangle } from "lucide-react"
import Link from "next/link"

interface FlaggedFile {
  id: string
  transaction_id: string
  check_type: string
  check_label: string
  status: string
  is_blocking: boolean
  failure_reason?: string | null
  transaction?: {
    property_address: string
    stage: string
  }
}

interface FlaggedFilesPanelProps {
  flaggedFiles: FlaggedFile[]
}

export function FlaggedFilesPanel({ flaggedFiles }: FlaggedFilesPanelProps) {
  const criticalFiles = flaggedFiles.filter(f => f.is_blocking && (f.status === "fail" || f.status === "needs_review"))
  const warningFiles = flaggedFiles.filter(f => !f.is_blocking || f.status === "pending")

  const displayFiles = [...criticalFiles, ...warningFiles].slice(0, 5)

  const getSeverityBadge = (file: FlaggedFile) => {
    if (file.is_blocking && file.status === "fail") {
      return <Badge variant="destructive">Critical</Badge>
    }
    if (file.is_blocking && file.status === "needs_review") {
      return <Badge className="bg-orange-500 text-white">Needs Review</Badge>
    }
    if (file.status === "pending") {
      return <Badge variant="secondary">Pending</Badge>
    }
    return <Badge variant="outline">Warning</Badge>
  }

  if (flaggedFiles.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileWarning className="h-5 w-5 text-muted-foreground" />
            Flagged Files
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="rounded-full bg-green-500/10 p-3 mb-3">
              <FileWarning className="h-6 w-6 text-green-600" />
            </div>
            <p className="text-sm text-muted-foreground">No flagged files requiring review</p>
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
            <FileWarning className="h-5 w-5 text-muted-foreground" />
            Flagged Files
          </CardTitle>
          {criticalFiles.length > 0 && (
            <Badge variant="destructive">{criticalFiles.length} Critical</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {displayFiles.map((file) => (
          <div
            key={file.id}
            className="flex items-start justify-between gap-3 rounded-lg border p-3"
          >
            <div className="flex items-start gap-3 min-w-0">
              <div className={`rounded-full p-2 ${file.is_blocking && file.status === "fail" ? "bg-destructive/10" : "bg-orange-500/10"}`}>
                <AlertTriangle className={`h-4 w-4 ${file.is_blocking && file.status === "fail" ? "text-destructive" : "text-orange-500"}`} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm truncate">{file.check_label}</span>
                  {getSeverityBadge(file)}
                </div>
                {file.transaction?.property_address && (
                  <p className="text-xs text-muted-foreground truncate mt-1">
                    {file.transaction.property_address}
                  </p>
                )}
                {file.failure_reason && (
                  <p className="text-xs text-destructive mt-1 line-clamp-2">
                    {file.failure_reason}
                  </p>
                )}
              </div>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/dashboard/transactions/${file.transaction_id}`}>
                <ExternalLink className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        ))}

        {flaggedFiles.length > 5 && (
          <Button variant="outline" className="w-full" asChild>
            <Link href="#transactions">
              View All {flaggedFiles.length} Flagged Files
            </Link>
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
