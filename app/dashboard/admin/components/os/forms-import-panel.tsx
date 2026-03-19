"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { 
  FileUp, 
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Loader2,
  FileText,
  Upload
} from "lucide-react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"

interface FormsImportPanelProps {
  brokerageId: string
}

interface ImportStatus {
  recentImports: Array<{
    id: string
    file_name: string
    status: string
    total_rows: number
    created_count: number
    failed_count: number
    created_at: string
  }>
  totalForms: number
  activeForms: number
}

export function FormsImportPanel({ brokerageId }: FormsImportPanelProps) {
  const [data, setData] = useState<ImportStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadImports() {
      if (!brokerageId) {
        setLoading(false)
        return
      }

      const supabase = createClient()

      const [
        { data: imports },
        { count: totalForms },
        { count: activeForms },
      ] = await Promise.all([
        supabase
          .from("lead_imports")
          .select("id, file_name, status, total_rows, created_count, failed_count, created_at")
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
          .limit(3),
        supabase
          .from("lead_capture_forms")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId),
        supabase
          .from("lead_capture_forms")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .eq("is_active", true),
      ])

      setData({
        recentImports: imports || [],
        totalForms: totalForms || 0,
        activeForms: activeForms || 0,
      })
      setLoading(false)
    }

    loadImports()
  }, [brokerageId])

  if (loading) {
    return (
      <Card className="border-border">
        <CardContent className="flex items-center justify-center p-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  const hasErrors = data.recentImports.some((i) => i.failed_count > 0 || i.status === "failed")

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <FileUp className="h-4 w-4 text-teal-600" />
            Forms / Import
          </CardTitle>
          <Badge variant="outline" className="text-xs">
            {data.activeForms} Active Forms
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {/* Forms Status */}
        <div className="flex items-center justify-between p-2 bg-muted/50 rounded-lg">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Lead Capture Forms</span>
          </div>
          <Badge variant="outline" className="text-xs">
            {data.totalForms} Total
          </Badge>
        </div>

        {/* Recent Imports */}
        {data.recentImports.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Recent Imports</p>
            {data.recentImports.map((imp) => {
              const isSuccess = imp.status === "completed" && imp.failed_count === 0
              const hasIssues = imp.failed_count > 0

              return (
                <div
                  key={imp.id}
                  className={`p-2 rounded-lg border ${isSuccess ? "bg-emerald-50/50 border-emerald-200" : hasIssues ? "bg-amber-50/50 border-amber-200" : "bg-muted/30 border-border"}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {isSuccess ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                      ) : hasIssues ? (
                        <AlertCircle className="h-3.5 w-3.5 text-amber-600" />
                      ) : (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
                      )}
                      <span className="text-xs truncate max-w-[120px]">{imp.file_name}</span>
                    </div>
                    <div className="flex items-center gap-1 text-xs">
                      <span className="text-emerald-600">{imp.created_count}</span>
                      {imp.failed_count > 0 && (
                        <>
                          <span className="text-muted-foreground">/</span>
                          <span className="text-red-600">{imp.failed_count}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="text-center py-4 text-muted-foreground">
            <Upload className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No recent imports</p>
          </div>
        )}

        {hasErrors && (
          <div className="p-2 bg-amber-50 border border-amber-200 rounded-lg">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-amber-600" />
              <span className="text-xs text-amber-700">Some imports have errors</span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Link href="/dashboard/admin/forms">
            <Button variant="outline" size="sm" className="w-full">
              Forms
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </Link>
          <Link href="/dashboard/admin/import">
            <Button variant="outline" size="sm" className="w-full">
              Import
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
