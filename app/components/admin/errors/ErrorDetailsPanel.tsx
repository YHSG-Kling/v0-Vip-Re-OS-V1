"use client"

import { useState, useEffect } from "react"
import { getErrorGroupDetails } from "@/app/actions/error-handler"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { AlertTriangle, Copy, Trash2, CheckCircle } from "lucide-react"

interface ErrorDetailsPanelProps {
  groupId: string
  onDismiss: (groupId: string) => void
  onResolve: (groupId: string) => void
}

export function ErrorDetailsPanel({
  groupId,
  onDismiss,
  onResolve,
}: ErrorDetailsPanelProps) {
  const [details, setDetails] = useState<any>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const loadDetails = async () => {
      try {
        const data = await getErrorGroupDetails(groupId)
        setDetails(data)
      } catch (error) {
        console.error("Error loading details:", error)
      } finally {
        setIsLoading(false)
      }
    }

    loadDetails()
  }, [groupId])

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-full mb-2" />
          <Skeleton className="h-4 w-3/4" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </CardContent>
      </Card>
    )
  }

  if (!details) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-sm text-muted-foreground">Failed to load error details</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{details.error_type}</CardTitle>
        <CardDescription>
          {details.error_count} errors in this group
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Recent Errors */}
        <div>
          <h4 className="font-medium text-sm mb-2">Recent Errors</h4>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {details.automation_errors?.slice(0, 3).map((error: any) => (
              <div key={error.id} className="p-2 bg-muted rounded text-xs">
                <p className="font-mono text-red-600 truncate">
                  {error.error_message}
                </p>
                <p className="text-muted-foreground">
                  {new Date(error.created_at).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-4">
          <Button
            size="sm"
            onClick={() => onResolve(groupId)}
            className="w-full"
          >
            <CheckCircle className="h-4 w-4 mr-2" />
            Resolve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onDismiss(groupId)}
            className="w-full"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Dismiss
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
