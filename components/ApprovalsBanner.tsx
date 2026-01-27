"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { ArrowRight, Loader2 } from "lucide-react"

export function ApprovalsBanner() {
  const [count, setCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchPendingCount = async () => {
    try {
      const response = await fetch("/api/approvals/pending")
      if (response.ok) {
        const data = await response.json()
        setCount(data.total || 0)
      }
    } catch (error) {
      console.error("[v0] Failed to fetch approval count:", error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPendingCount()

    // Auto-refresh every 5 minutes
    const interval = setInterval(fetchPendingCount, 5 * 60 * 1000)

    return () => clearInterval(interval)
  }, [])

  if (loading) {
    return (
      <div className="bg-muted border border-border rounded-lg p-4 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Checking approvals...</span>
      </div>
    )
  }

  if (count === null) return null

  if (count === 0) {
    return (
      <div className="bg-gradient-to-r from-emerald-50 to-teal-50 border-2 border-emerald-200 rounded-lg p-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-emerald-500 rounded-full flex items-center justify-center text-2xl">
            🎉
          </div>
          <div>
            <h3 className="font-semibold text-emerald-900 text-lg">All caught up!</h3>
            <p className="text-sm text-emerald-700">No items waiting for your approval</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-gradient-to-r from-amber-50 to-orange-50 border-2 border-amber-300 rounded-lg p-6 flex items-center justify-between shadow-md hover:shadow-lg transition-shadow">
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 bg-amber-500 rounded-full flex items-center justify-center text-3xl animate-pulse">
          🎯
        </div>
        <div>
          <h3 className="font-bold text-amber-900 text-xl">
            {count} {count === 1 ? "item" : "items"} waiting for your approval
          </h3>
          <p className="text-sm text-amber-700 mt-1">Review and take action on pending items</p>
        </div>
      </div>
      <Link href="/approvals">
        <Button size="lg" className="bg-amber-600 hover:bg-amber-700 text-white font-semibold shadow-md">
          Review them
          <ArrowRight className="ml-2 h-5 w-5" />
        </Button>
      </Link>
    </div>
  )
}
