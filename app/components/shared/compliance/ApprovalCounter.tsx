"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { Spinner } from "@/app/components/ui/spinner"
import { CheckCircle2, AlertCircle } from "lucide-react"

interface ApprovalCounterProps {
  className?: string
}

export default function ApprovalCounter({ className }: ApprovalCounterProps) {
  const [count, setCount] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchPendingCount = async () => {
    try {
      setError(null)
      const response = await fetch("/api/approvals/pending")
      
      if (!response.ok) {
        throw new Error("Failed to fetch pending approvals")
      }
      
      const data = await response.json()
      
      // Handle different possible response structures
      const pendingCount = Array.isArray(data) 
        ? data.length 
        : typeof data.count === "number" 
          ? data.count 
          : data.pending?.length || 0
      
      setCount(pendingCount)
    } catch (err) {
      console.error("[v0] Error fetching pending approvals:", err)
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    // Initial fetch
    fetchPendingCount()

    // Auto-refresh every 5 minutes (300000ms)
    const interval = setInterval(() => {
      fetchPendingCount()
    }, 300000)

    // Cleanup interval on unmount
    return () => clearInterval(interval)
  }, [])

  if (error) {
    return (
      <Card className={className}>
        <CardContent className="flex items-center gap-3 p-6">
          <AlertCircle className="h-5 w-5 text-destructive" />
          <p className="text-sm text-muted-foreground">
            Unable to load approval count
          </p>
        </CardContent>
      </Card>
    )
  }

  if (isLoading || count === null) {
    return (
      <Card className={className}>
        <CardContent className="flex items-center gap-3 p-6">
          <Spinner className="h-5 w-5" />
          <p className="text-sm text-muted-foreground">
            Loading approvals...
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card 
      className={`${className} ${
        count > 0 
          ? "border-orange-200 bg-gradient-to-br from-orange-50 to-amber-50 dark:border-orange-900 dark:from-orange-950/20 dark:to-amber-950/20" 
          : "border-emerald-200 bg-gradient-to-br from-emerald-50 to-green-50 dark:border-emerald-900 dark:from-emerald-950/20 dark:to-green-950/20"
      }`}
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          {count > 0 ? (
            <>
              <span className="text-2xl">🎯</span>
              <span>Pending Approvals</span>
            </>
          ) : (
            <>
              <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              <span>All Caught Up!</span>
            </>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {count > 0 ? (
          <>
            <div className="flex items-center gap-3">
              <Badge 
                variant="default" 
                className="h-8 px-4 text-base font-bold bg-orange-600 hover:bg-orange-700 dark:bg-orange-500 dark:hover:bg-orange-600"
              >
                {count}
              </Badge>
              <p className="text-sm font-medium text-foreground">
                {count === 1 ? "item" : "items"} waiting for your approval
              </p>
            </div>
            <Link href="/approvals" className="block">
              <Button 
                className="w-full bg-orange-600 hover:bg-orange-700 text-white dark:bg-orange-500 dark:hover:bg-orange-600"
                size="sm"
              >
                Review them →
              </Button>
            </Link>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              <span className="text-2xl leading-none">🎉</span>{" "}
              No items waiting for approval
            </p>
            <Link href="/approvals" className="block">
              <Button 
                variant="outline" 
                className="w-full border-emerald-300 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-950/50 bg-transparent"
                size="sm"
              >
                View approval history
              </Button>
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  )
}
