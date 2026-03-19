"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"
import { AlertCircle, X } from "lucide-react"
import { Button } from "@/components/ui/button"

interface PendingApproval {
  id: string
  item_type: string
  status: string
}

export function ApprovalsBanner() {
  const [pendingCount, setPendingCount] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadPendingApprovals = async () => {
      try {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()
        
        if (!user) {
          setLoading(false)
          return
        }

        // Get agent ID
        const { data: agent } = await supabase
          .from("agents")
          .select("id")
          .eq("user_id", user.id)
          .maybeSingle()

        if (!agent) {
          setLoading(false)
          return
        }

        // Count pending approvals for this agent
        const { count, error } = await supabase
          .from("approval_items")
          .select("*", { count: "exact", head: true })
          .eq("agent_id", agent.id)
          .eq("status", "pending")

        if (!error && count) {
          setPendingCount(count)
        }
      } catch (error) {
        console.error("[ApprovalsBanner] Error loading pending approvals:", error)
      } finally {
        setLoading(false)
      }
    }

    loadPendingApprovals()
  }, [])

  if (loading || dismissed || pendingCount === 0) {
    return null
  }

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <AlertCircle className="h-5 w-5 text-amber-600" />
        <div>
          <p className="text-sm font-medium text-amber-800">
            You have {pendingCount} item{pendingCount > 1 ? "s" : ""} pending approval
          </p>
          <p className="text-xs text-amber-600">
            Listings, marketing materials, or compliance documents awaiting broker review
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Link href="/approvals">
          <Button size="sm" variant="outline" className="border-amber-300 text-amber-800 hover:bg-amber-100">
            View Approvals
          </Button>
        </Link>
        <Button
          size="sm"
          variant="ghost"
          className="text-amber-600 hover:text-amber-800 hover:bg-amber-100"
          onClick={() => setDismissed(true)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
